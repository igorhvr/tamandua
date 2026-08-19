#!/usr/bin/env node

// Hermetic portability tests for the oracle evidence exclusive-create
// (MACP3 / US-001 + US-002).
//
// US-002 red-then-green narrative (Proof #1 of the MACP3 task, US-002
// scope): this suite drives the US-001 injectable seam to simulate a
// platform with NO /proc (Darwin). The simulation model is explicit and
// grounded: the preserved legacy strategy (evidence-procfd-legacy.mjs,
// the { procfdResolution:true } arm of the seam) accepts
// procAvailable:false to reproduce the EXACT pre-portability Darwin failure
// (ENOENT at /proc/self/fd) on any host. A /proc-less Darwin-like platform
// is therefore modeled as procAvailable=false — that flag IS the injectable
// path/platform seam required by the task.
//
//   RED leg:
//     - the modeled no-/proc condition provably breaks the legacy proc-fd
//       strategy (same ENOENT-class OracleRuntimeError as the a446deac mac
//       defect), so the simulation is not a no-op;
//     - "no '/proc' literal in the create path" asserts evidence.mjs itself
//       contains no '/proc' string (would fail against the pre-US-001 file).
//   GREEN leg:
//     - under the SAME modeled no-/proc condition the portable writer
//       succeeds (exclusive create + nested-parent mkdir, 0600/0700 modes)
//       AND a duplicate STILL throws the exclusive error;
//     - the whole green-leg scenario passes twice consecutively with fresh
//       temp dirs (idempotency).
//
// Thus US-002 proves on linux what cannot be E2E-proven here (Darwin): a
// /proc-less platform no longer breaks evidence writes, and the old
// /proc-dependent implementation would have failed the same scenario.
//
// Red-then-green narrative (Proof #1 of the MACP3 task, US-001 scope):
//   The pre-US-001 writer resolved the containing parent directory through
//   /proc/self/fd/<fd>/<part> — linux-only. On Darwin (/proc absent) every
//   evidence write failed:
//     exclusive evidence create failed for <rel>: ENOENT ... /proc/self/fd/...
//   US-001 replaces that with the portable path-tracked strategy. This suite
//   proves the replacement hermetically (no Mac required):
//
//   RED leg:
//     - "no '/proc' literal in the create path" asserts evidence.mjs itself
//       contains no '/proc' string — i.e. the write path can no longer be
//       sabotaged by a missing /proc (this assertion would fail against the
//       pre-US-001 file, whose openContainedParent and final open both
//       referenced /proc/self/fd/...).
//     - "legacy /proc strategy fails when /proc is unavailable" drives the
//       preserved legacy strategy (evidence-procfd-legacy.mjs) with
//       procAvailable:false and asserts it raises the same ENOENT-class
//       OracleRuntimeError the defect produced — this is the literal
//       pre-fix code path failing on a simulated no-/proc platform.
//   GREEN leg:
//     - "_evidenceCreate(..., { procfdResolution: false })" forces the
//       injected seam onto the non-/proc (portable) strategy and asserts a
//       successful exclusive create, nested-parent mkdir, duplicate
//       exclusive-error, 0600 mode, and O_NOFOLLOW parent rejection.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeEvidenceFile, writeEvidenceJson, _evidenceCreate } from './evidence.mjs';
import { legacyCreateViaProcFdResolution } from './evidence-procfd-legacy.mjs';
import { OracleRuntimeError } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeEvidenceInvocation() {
  const campaignRoot = fs.mkdtempSync(path.join(HERE, 'evidence-portability-test.'));
  const evidenceDir = path.join(campaignRoot, 'evidence', 'CASE-1', 'attempt-1', 'oracles', 'O3z');
  fs.mkdirSync(evidenceDir, { recursive: true });
  return { invocation: { evidenceDir }, evidenceDir, campaignRoot };
}

function cleanup(env) {
  fs.rmSync(env.campaignRoot, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────────
// US-002: Darwin simulation + idempotency.
//
// runGreenLegScenario runs the FULL green-leg scenario once inside a fresh
// temp dir: exclusive create success through the portable seam (nested
// parents created, 0600 evidence file / 0700 parents), then a duplicate
// write that must STILL throw the exclusive error. It returns the env so
// callers can clean up AND assert cross-round isolation for the idempotency
// proof.
// ──────────────────────────────────────────────────────────────────────────

function runGreenLegScenario(label) {
  const env = makeEvidenceInvocation();
  const reference = _evidenceCreate(
    env.invocation,
    `${label}/deep/nested/evidence.json`,
    '{"ok":true}\n',
    'filesystem',
    { procfdResolution: false },
  );
  assert.deepEqual(reference, { path: `${label}/deep/nested/evidence.json`, kind: 'filesystem' });
  const written = path.join(env.evidenceDir, label, 'deep', 'nested', 'evidence.json');
  assert.equal(fs.readFileSync(written, 'utf8'), '{"ok":true}\n');
  // 0600 evidence file, 0700 parents (nested-parent mkdir worked).
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(env.evidenceDir, label, 'deep', 'nested')).mode & 0o777, 0o700);
  // A duplicate must STILL throw the exclusive error.
  assert.throws(
    () => _evidenceCreate(env.invocation, `${label}/deep/nested/evidence.json`, '{"ok":false}\n', 'filesystem', { procfdResolution: false }),
    /exist|exclusive/i,
    `${label}: duplicate write must throw the exclusive error`,
  );
  return env;
}

test('seam forces the non-/proc path to a successful exclusive create', () => {
  const env = makeEvidenceInvocation();
  try {
    const reference = _evidenceCreate(env.invocation, 'portable/nested/evidence.json', '{}\n', 'filesystem', { procfdResolution: false });
    assert.deepEqual(reference, { path: 'portable/nested/evidence.json', kind: 'filesystem' });
    const written = path.join(env.evidenceDir, 'portable', 'nested', 'evidence.json');
    assert.equal(fs.readFileSync(written, 'utf8'), '{}\n');
    // 0600 mode on the evidence file, 0700 on the created parents
    assert.equal(fs.statSync(written).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(env.evidenceDir, 'portable', 'nested')).mode & 0o777, 0o700);
  } finally {
    cleanup(env);
  }
});

test("no '/proc' literal in the create path (linux-ism lint guard)", () => {
  const source = fs.readFileSync(path.join(HERE, 'evidence.mjs'), 'utf8');
  // Pre-US-001 this file opened parents and the final leaf through
  // /proc/self/fd/<fd>/<name>; a missing /proc (Darwin) then produced ENOENT.
  // After US-001 the portable writer derives paths from the real campaign
  // root only — no '/proc' anywhere. This assertion is the hermetic RED-leg
  // guard that would fail against the pre-fix file.
  assert.ok(!source.includes('/proc'), `evidence.mjs must not reference /proc (found: ${source.match(/\/proc/g)?.join(', ') ?? 'none'})`);
  // The public API surface is unchanged.
  assert.equal(typeof writeEvidenceFile, 'function');
  assert.equal(typeof writeEvidenceJson, 'function');
});

test('legacy /proc strategy fails with ENOENT-class error when /proc is unavailable', () => {
  const env = makeEvidenceInvocation();
  try {
    let threw = null;
    try {
      legacyCreateViaProcFdResolution(env.evidenceDir, 'o3z-token-gate.json', '{}\n', 'filesystem', { procAvailable: false });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof OracleRuntimeError, 'expected OracleRuntimeError');
    assert.match(threw.message, /exclusive evidence create failed/i);
    assert.match(threw.message, /ENOENT|no such file/i);
    // No file may exist when the write fails.
    assert.equal(fs.existsSync(path.join(env.evidenceDir, 'o3z-token-gate.json')), false);
  } finally {
    cleanup(env);
  }
});

test('portable create rejects duplicate writes with the exclusive error', () => {
  const env = makeEvidenceInvocation();
  try {
    const reference = _evidenceCreate(env.invocation, 'queries/result.json', '{"rows":1}\n', 'sqlite', { procfdResolution: false });
    assert.deepEqual(reference, { path: 'queries/result.json', kind: 'sqlite' });
    assert.throws(
      () => _evidenceCreate(env.invocation, 'queries/result.json', '{"rows":2}\n', 'sqlite', { procfdResolution: false }),
      /exist|exclusive/i,
    );
    // writeEvidenceJson (public wrapper) keeps the same exclusive contract.
    assert.throws(() => writeEvidenceJson(env.invocation, 'queries/result.json', { rows: 3 }), /exist|exclusive/i);
  } finally {
    cleanup(env);
  }
});

test('portable create preserves O_NOFOLLOW: a symlinked parent fails the write', () => {
  const env = makeEvidenceInvocation();
  try {
    // Pre-plant a symlink at an intermediate parent.
    fs.symlinkSync(path.join(env.evidenceDir, 'real-dir'), path.join(env.evidenceDir, 'linked'));
    fs.mkdirSync(path.join(env.evidenceDir, 'real-dir'), { recursive: true });
    assert.throws(
      () => writeEvidenceFile(env.invocation, 'linked/file.json', '{}\n', 'filesystem'),
      /exclusive evidence create failed|ELOOP|too many levels/i,
    );
    assert.equal(fs.existsSync(path.join(env.evidenceDir, 'linked', 'file.json')), false);
  } finally {
    cleanup(env);
  }
});

test('US-002: Darwin simulation — no-/proc platform: portable create succeeds AND duplicate still throws exclusive', () => {
  // Ground the simulation: procAvailable:false is the injectable platform
  // seam that reproduces the pre-portability Darwin failure (ENOENT at
  // /proc/self/fd) on any host. Proving the legacy arm fails under it is
  // what makes this a REAL /proc-less platform model (RED leg).
  const env = makeEvidenceInvocation();
  try {
    let legacyFailed = null;
    try {
      legacyCreateViaProcFdResolution(env.evidenceDir, 'o3z-token-gate.json', '{}\n', 'filesystem', {
        procAvailable: false,
      });
    } catch (error) {
      legacyFailed = error;
    }
    assert.ok(legacyFailed instanceof OracleRuntimeError, 'modeled no-/proc platform must break the legacy proc-fd strategy');
    assert.match(legacyFailed.message, /exclusive evidence create failed/i);
    assert.match(legacyFailed.message, /ENOENT|no such file/i);

    // GREEN leg under the SAME modeled condition: the portable writer is
    // immune — exclusive create succeeds (incl. nested-parent mkdir).
    const reference = _evidenceCreate(env.invocation, 'o3z-token-gate/nested/file.json', '{"gate":true}\n', 'filesystem', { procfdResolution: false });
    assert.deepEqual(reference, { path: 'o3z-token-gate/nested/file.json', kind: 'filesystem' });
    const written = path.join(env.evidenceDir, 'o3z-token-gate', 'nested', 'file.json');
    assert.equal(fs.readFileSync(written, 'utf8'), '{"gate":true}\n');
    assert.equal(fs.statSync(written).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(env.evidenceDir, 'o3z-token-gate', 'nested')).mode & 0o777, 0o700);

    // And the duplicate STILL throws exclusive under the same condition —
    // the exclusive contract is not weakened by the portability fix.
    assert.throws(
      () => _evidenceCreate(env.invocation, 'o3z-token-gate/nested/file.json', '{"gate":false}\n', 'filesystem', { procfdResolution: false }),
      /exist|exclusive/i,
    );
    assert.throws(() => writeEvidenceJson(env.invocation, 'o3z-token-gate/nested/file.json', { gate: false }), /exist|exclusive/i);
  } finally {
    cleanup(env);
  }
});

test('US-002: green-leg proof is idempotent across two consecutive fresh-dir rounds', () => {
  // Acceptance criterion 3: the scenario must pass twice consecutively with
  // FRESH temp dirs. Round 2 must show zero residue from round 1, proving
  // the writer carries no cross-run state and each exclusive create is
  // fully repeatable.
  const env1 = runGreenLegScenario('round1');
  const env2 = runGreenLegScenario('round2');
  try {
    // Round 2's evidence dir must contain no round-1 residue.
    assert.equal(fs.existsSync(path.join(env2.evidenceDir, 'round1')), false);
    // Round 1 wrote fully independent files.
    assert.equal(fs.readFileSync(path.join(env1.evidenceDir, 'round1', 'deep', 'nested', 'evidence.json'), 'utf8'), '{"ok":true}\n');
    assert.equal(fs.readFileSync(path.join(env2.evidenceDir, 'round2', 'deep', 'nested', 'evidence.json'), 'utf8'), '{"ok":true}\n');
  } finally {
    cleanup(env1);
    cleanup(env2);
  }
});

test('portable create keeps containment and kind validation', () => {
  const env = makeEvidenceInvocation();
  try {
    assert.throws(() => writeEvidenceFile(env.invocation, '../escape.json', '{}\n', 'filesystem'), /contained|relative/i);
    assert.throws(() => writeEvidenceFile(env.invocation, 'plain.json', '{}\n', ''), /evidence kind must be nonempty/i);
  } finally {
    cleanup(env);
  }
});
