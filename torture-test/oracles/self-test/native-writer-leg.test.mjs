#!/usr/bin/env node
// native-writer-leg.test.mjs — serial gate wrapper for the REAL native
// run/worktree writer live leg (STORM-HYGIENE-CAPTURE verification-item-3).
//
// Spawns native-writer-leg.mjs (a strictly private, retained HOME/STATE/DB/
// TMPDIR + owned origin + non-dispatching registration stub) and asserts the
// probe's green receipt: candidate/source API match before effects, real
// writer-created run_worktrees rows (cleanup_policy keep), real managed
// worktree on disk + git metadata + retained branch evidence, native terminal
// keep characterization (forceFailRun keeps the ready worktree), O6 wrapper
// PASS pre- and post-terminal (incl. O6_RETAINED_BY_POLICY), O5 wrapper FAIL
// while the owned stub listener is alive and PASS after its exact release, and
// positive exact owned-handle closure (listener + DB).
//
// Run serially (node --test on this file alone); the probe runs real product
// writers from /opt/tamandua/dist (a product build is an authorized TEST
// PREREQUISITE, never a reason to hand-INSERT native rows) and executes NO
// prune/worktree removal — all created repos/worktrees/DBs are RETAINED.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const PROBE = path.join(HERE, 'native-writer-leg.mjs');
const DIST_DIR = process.env.TAMANDUA_NATIVE_DIST ?? '/opt/tamandua/dist';

test('native-writer live leg: REAL native run/worktree writers in a private retained root reconcile clean through the actual O5/O6 wrappers', () => {
  // The leg needs the stable matched product dist; without it the proof is
  // honestly NOT_RUN, never a fake.
  if (!fs.existsSync(path.join(DIST_DIR, 'installer', 'run.js')) || !fs.existsSync(path.join(DIST_DIR, 'db.js'))) {
    assert.fail(`native-writer leg requires the stable product dist at ${DIST_DIR} (product build is an authorized test prerequisite); the leg is NOT_RUN without it`);
  }
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const legRootParent = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.nativewriter.'));
  const result = spawnSync(process.execPath, [PROBE], {
    cwd: HERE,
    env: {
      ...process.env,
      TAMANDUA_NATIVE_LEG_ROOT: legRootParent,
      TAMANDUA_NATIVE_DIST: DIST_DIR,
      TAMANDUA_NATIVE_SRC: process.env.TAMANDUA_NATIVE_SRC ?? path.resolve(DIST_DIR, '..', 'src'),
    },
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const stdout = result.stdout.trim();
  const stderrSha = createHash('sha256').update(result.stderr).digest('hex');
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    assert.fail(`native-writer-leg emitted invalid JSON stdout: ${stdout}\nstderr: ${result.stderr}`);
  }
  assert.equal(result.status, 0, `native-writer-leg probe exit ${result.status}; report.failure=${report.failure ?? 'none'}\nstderr sha256 ${stderrSha}\n${result.stderr}`);
  assert.equal(report.kind, 'real-native-run-worktree-writer-proof');
  assert.equal(report.failure, undefined);
  assert.equal(report.api_match_result.insert_columns_match, true);
  assert.equal(report.api_match_result.ddl_columns_match, true);
  // real writer-created rows: keep default, ready, detached origin ref retained.
  const wt = report.writer_created?.run_worktrees_rows?.[0];
  assert.ok(wt, 'native writer must create a run_worktrees row');
  assert.equal(wt.status, 'ready');
  assert.equal(wt.cleanup_policy, 'keep');
  assert.equal(wt.removed_at, null);
  assert.equal(report.writer_created.step_rows, 1);
  // real worktree on disk under the private root
  assert.ok(report.managed_subroot.startsWith(report.isolation.root), 'managed worktree must live under the private root');
  // native terminal keep: forceFailRun keeps the ready worktree
  assert.equal(report.terminal?.run_row?.status, 'failed');
  assert.equal(report.terminal?.run_worktrees_rows?.[0]?.status, 'ready');
  assert.equal(report.terminal?.run_worktrees_rows?.[0]?.cleanup_policy, 'keep');
  // O5/O6 wrapper outcomes through the actual executables
  const events = report.events ?? [];
  const byEvent = Object.fromEntries(events.map((entry) => [entry.event, entry]));
  assert.equal(byEvent.o6_pre_terminal?.result, 'PASS');
  assert.equal(byEvent.o6_post_terminal?.result, 'PASS');
  assert.ok(byEvent.o6_post_terminal.findings.includes('O6_RETAINED_BY_POLICY'), 'terminal keep must be characterized');
  assert.equal(byEvent.o5_stub_alive?.result, 'FAIL');
  assert.equal(byEvent.o5_stub_alive?.finding, 'O5_LEFTOVER_LISTENER');
  assert.equal(byEvent.o5_stub_released?.result, 'PASS');
  // positive exact owned-handle closure
  assert.equal(report.closure?.listener_close?.observed, true, 'stub listener close must be observed');
  assert.equal(report.closure?.db_close?.observed, true, 'DB handle close must be observed');
  process.stdout.write(`native-writer live leg PASS (root ${report.isolation.root})\n`);
});
