// o12-scratch.mjs — O12-owned scratch-directory policy (Storm O12-REPIN).
//
// The product TEST ISOLATION guard (src/lib/test-guard.ts
// assertStatePathIsolation) refuses any path that resolves under the REAL user
// home's ~/.tamandua while TAMANDUA_TEST_GUARD=1. It derives the real home from
// os.userInfo().homedir, so a private HOME/TAMANDUA_STATE_DIR does NOT help: a
// tamandua-run worktree lives at ~/.tamandua/worktrees/<repo>/..., and a probe
// scratch workspace created under the repo is therefore (string-prefix) real
// state to the guard, so every product getDb() inside a probe child is refused.
//
// The O12 fixture machinery is NOT affected (the oracle and the generator open
// SQLite snapshots read-only with node:sqlite, never getDb()/migrate()), but the
// native behavioral probes DO import the product and open a private state DB.
// Their scratch root, therefore, must be genuinely outside the guard's
// real-state prefix. This module centralizes that decision for the gate, the
// fixture matrix builder and the standalone runner. It never edits src/ and
// never disposes a retained workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The real-state prefix the product guard treats as production (mirror). */
export const REAL_STATE_DIR = path.join(os.userInfo().homedir, '.tamandua');

/** True when `candidate` resolves to or under the guard's real-state prefix. */
export function isUnderRealState(candidate) {
  const normalized = path.resolve(candidate);
  return normalized === REAL_STATE_DIR || normalized.startsWith(REAL_STATE_DIR + path.sep);
}

/**
 * The OS temp base, except when TMPDIR itself resolves under real state — in
 * which case fall back to a clearly safe absolute temp dir. Never returns a
 * path under the guard's real-state prefix on this host.
 */
function osTempBase() {
  const candidate = os.tmpdir();
  if (!isUnderRealState(candidate)) return candidate;
  if (fs.existsSync('/tmp')) return '/tmp';
  throw new Error(`no temp base outside the real-state prefix ${REAL_STATE_DIR}`);
}

/**
 * A scratch base for probe state guaranteed outside the guard's real-state
 * prefix. When `preferredBase` is already safe it is returned unchanged (so
 * retained evidence stays under torture-test/var); otherwise a fresh owned dir
 * under the OS temp dir is created and retained. Callers must ensure the
 * preferred base exists before relying on it.
 */
export function scratchBaseOutsideRealState(preferredBase) {
  if (!isUnderRealState(preferredBase)) return preferredBase;
  return fs.mkdtempSync(path.join(osTempBase(), 'oracle-self-test.'));
}

/**
 * A private TMPDIR for a probe child, always outside the guard's real-state
 * prefix. The probes derive their whole workspace root (HOME/STATE_DIR/DB_PATH/
 * TMPDIR) from os.tmpdir(), so pointing TMPDIR here keeps state isolation real.
 */
export function safeProbeTmpdir() {
  return fs.mkdtempSync(path.join(osTempBase(), 'o12-probe-scratch.'));
}

/**
 * Build the explicit allow-list child env the O12 gate/probes run under: never
 * the caller's ambient authority, always guard=1 and false harnesses.
 */
export function o12ChildEnv({ tmpdir, extra = {} } = {}) {
  const env = {
    PATH: process.env.PATH ?? `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: tmpdir,
    TMPDIR: tmpdir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TAMANDUA_TEST_GUARD: '1',
    TAMANDUA_PI_BINARY: '/bin/false',
    TAMANDUA_HERMES_BINARY: '/bin/false',
    TAMANDUA_DSH_BINARY: '/bin/false',
    ...extra,
  };
  // O12-SCHEMA-13 US-006: the seed-EVIDENCE LOCATION override is honoured here
  // exactly as `run-self-tests-alone.mjs` honours it for the o12 group (US-004
  // runner pass-through). `o12.test.mjs`'s seed-pin assertion reads
  // TAMANDUA_O12_SEED_SNAPSHOT to point at an owned copy of the immutable seed
  // store on a host where the retained /opt/tamandua-storm-seed.* evidence is
  // not visible (e.g. a Matchlock VM). The O12 gate runner builds every child
  // env from this module, so without the pass-through its `o12.test.mjs` entry
  // could only ever judge the absent host path (red on such a host) even when
  // the caller supplied the owned copy. It is an EVIDENCE LOCATION, never
  // run/work authority: no other ambient TAMANDUA_* key is ever forwarded, and
  // an explicit `extra.TAMANDUA_O12_SEED_SNAPSHOT` still wins.
  if (process.env.TAMANDUA_O12_SEED_SNAPSHOT && env.TAMANDUA_O12_SEED_SNAPSHOT === undefined) {
    env.TAMANDUA_O12_SEED_SNAPSHOT = process.env.TAMANDUA_O12_SEED_SNAPSHOT;
  }
  return env;
}
