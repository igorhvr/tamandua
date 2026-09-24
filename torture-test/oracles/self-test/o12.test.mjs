#!/usr/bin/env node

// o12.test.mjs — focused O12 calibration/self-test entrypoint (Storm O12
// designated gate).
//
// Runs the REAL committed O12 executable against real immutable SQLite
// fixtures through the shared stdout/exit contract, exercising each
// obligation's positive AND negative controls, malformed evidence, exact
// counter discipline (full totals independent of capped samples), the
// complete independently admitted reserved-key scope contract (v1 legacy +
// v2 typed sidecar), and zero unintended writes; then drives the owned
// behavioral probes (real-API run_number allocation characterization + the
// retained SQL-replica allocator calibration + the reserved-key step-ops
// probe over ALL 17 reserved keys, present-preservation and
// absent-introduction) and the isolation/closure negatives (injected close
// error/timeout must make the native probes NON-green — they run BEFORE the
// real native probes).
//
// Storm O12-ENV portability contract: the gate builds EVERY child (probe,
// generator, O12 executable) environment EXPLICITLY from an allow-list and
// never spreads its own ambient env, so the gate result cannot depend on
// whatever authority the gate's own caller happens to inherit (a live Tamandua
// run injects TAMANDUA_RUN_ID/worker pid-pgid-job/control port; an independent
// clean caller injects none of them). Authority assertions compare the probe's
// reported removed names against the names the gate ACTUALLY injected: an
// authority-free caller injects nothing, so EMPTY removal is the correct
// legitimate result; a dedicated contaminated-caller fixture injects only
// clearly fake non-live sentinel values and asserts exactly those names are
// reported removed and the probe stays green with a private effective env.
//
// This file mirrors the o1/o11/o16 self-test pattern: it is NOT part of
// `npm test`; it runs standalone (`node --test torture-test/oracles/self-test/o12.test.mjs`)
// and its fixtures also feed the shared oracle mutation harness
// (torture-test/oracles/self-test/run.sh). Full TAP and producer exits are
// preserved by the caller (no pipelines hide exits).
//
// Cleanup discipline (Storm O12-close): NO recursive filesystem disposal.
// The generated fixture workspace (and every probe root inside it) is
// RETAINED under torture-test/var and a receipt (root identity/path/ino)
// is written into it and echoed on stderr, so reviewers can replay exactly
// what this gate produced. Only exact owned child/listener handles are
// closed by the probes themselves.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  O12_RESERVED_CONTEXT_KEYS,
  O12_SUPPORTED_SCHEMA_VERSIONS,
  resolveO12SchemaExpectation,
  validateO12MatchlockPolicyValue,
} from '../lib/o12.mjs';
import { scratchBaseOutsideRealState } from './o12-scratch.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');

// Probe scratch base: a tamandua-run worktree lives under the real
// ~/.tamandua state prefix the product guard rejects, so probe children cannot
// use a scratch workspace inside the repo on such hosts. `o12-scratch.mjs`
// returns torture-test/var when it is safe, else a fresh owned dir outside the
// guard's prefix. (Direct fixture generation / the O12 executable only open
// SQLite snapshots read-only and are unaffected.) Created once, retained.
const PROBE_SCRATCH_BASE = scratchBaseOutsideRealState(VAR_ROOT);
const ORACLE = path.resolve(HERE, '..', 'O12');
const GENERATOR = path.join(HERE, 'generate-o12-fixtures.mjs');
const STEP_OPS_TS = path.join(REPO_ROOT, 'src', 'installer', 'step-ops.ts');
const DB_TS = path.join(REPO_ROOT, 'src', 'db.ts');
const EXIT_BY_RESULT = { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 };
// Fixture count after the schema-13 refresh (O12-SCHEMA-13 US-003): the 69
// fixtures pinned by O12-REPIN, minus `o12-schema-version-unsupported-11`
// (retired — 11 is a SUPPORTED version now), plus the 10 per-version/lineage
// fixture cases added for the union chain (v11, v12-main, v12-matchlock,
// v12-neither-lineage, v13-native, v13-matchlock-present, v13-matchlock-invalid,
// v13-missing-preclaim, v13-missing-matchlock-policy, the LEDGER-DIAG v14
// shapes v14-native/v14-missing-preclaim and the unknown-version controls
// o12-schema-version-unsupported-15 / o12-schema-version-unsupported). Pinned
// exactly; the calibration test asserts the generated set equals this AND that
// the generator's own generation-receipt fixture_count agrees.
const EXPECTED_FIXTURE_COUNT = 80;

// Per-version/lineage shape matrix (O12-SCHEMA-13 US-003). Each entry pins the
// version stamp AND the full column universe of one generated fixture; the
// calibration test asserts the fixture's recorded schema record AND its real
// snapshot columns agree. A v12/v13 entry whose stamp disagrees with its
// universe is exactly the malformed shape the fail-closed fixtures pin.
const O12_SCHEMA_SHAPE_FIXTURES = [
  { name: 'o12-schema-v9-compat', user_version: 9, matchlock: false, targetMoved: false, preclaim: false },
  { name: 'o12-schema-v10-missing-matchlock-policy', user_version: 10, matchlock: false, targetMoved: false, preclaim: false },
  { name: 'o12-schema-v10-matchlock-policy', user_version: 10, matchlock: true, targetMoved: false, preclaim: false },
  { name: 'o12-schema-v11', user_version: 11, matchlock: false, targetMoved: true, preclaim: false },
  { name: 'o12-schema-v12-main', user_version: 12, matchlock: false, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v12-matchlock', user_version: 12, matchlock: true, targetMoved: false, preclaim: false },
  { name: 'o12-schema-v12-neither-lineage', user_version: 12, matchlock: false, targetMoved: false, preclaim: false },
  { name: 'o12-schema-v13-native', user_version: 13, matchlock: true, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v13-matchlock-present', user_version: 13, matchlock: true, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v13-matchlock-invalid', user_version: 13, matchlock: true, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v13-missing-preclaim', user_version: 13, matchlock: true, targetMoved: true, preclaim: false },
  { name: 'o12-schema-v13-missing-matchlock-policy', user_version: 13, matchlock: false, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v14-native', user_version: 14, matchlock: true, targetMoved: true, preclaim: true },
  { name: 'o12-schema-v14-missing-preclaim', user_version: 14, matchlock: true, targetMoved: true, preclaim: false },
  { name: 'o12-schema-version-unsupported-15', user_version: 15, matchlock: true, targetMoved: true, preclaim: true },
  { name: 'o12-schema-version-unsupported', user_version: 8, matchlock: true, targetMoved: true, preclaim: true },
];

// The whole-oracle ERROR fixtures of the shape matrix (exit 2, zero evidence
// artifacts): a v12 stamp with neither lineage discriminator, a v13 store
// missing either union column, and the out-of-range version stamps.
const O12_SCHEMA_SHAPE_ERROR_FIXTURES = [
  'o12-schema-v12-neither-lineage',
  'o12-schema-v13-missing-preclaim',
  'o12-schema-v13-missing-matchlock-policy',
  'o12-schema-v14-missing-preclaim',
  'o12-schema-version-unsupported-15',
  'o12-schema-version-unsupported',
];

// The eight executable O12-CLOSE correction cases (Storm O12-close): seven
// named fixtures plus the run-number allocator characterization (the two
// dedicated probes, covered by the behavioral-probe tests below). Every named
// fixture must be generated and expected == observed in the calibration loop.
const O12_CLOSE_CASE_FIXTURES = [
  'o12-close-partial-run-baseline',
  'o12-close-partial-key-baseline',
  'o12-close-non-reserved-only-baseline',
  'o12-close-v2-unknown-key',
  'o12-close-key-introduced',
  'o12-close-empty-string-divergence',
  'o12-close-seven-orphans-count',
];

// The retained seed snapshot the storm's seed-validation gate consumes
// (READ-ONLY evidence: never written by this gate). This is the immutable
// snapshot the pinned O12 build is qualified against. Its user_version must be
// a MEMBER of O12_SUPPORTED_SCHEMA_VERSIONS — a legacy seed stamped 9..12 and
// the regenerated schema-13 seed are both legal — and the version-specific
// required columns for that stamp must be present (a v13 seed carries BOTH
// runs.matchlock_policy and steps.preclaim_death_count). A host that validates
// an owned copy points the assertion at it explicitly via
// TAMANDUA_O12_SEED_SNAPSHOT (the O12 gate materializes the v13 owned copy at
// torture-test/var/seed-snapshot-v13.sqlite — see o12-seed-snapshot.mjs).
const SEED_SNAPSHOT = process.env.TAMANDUA_O12_SEED_SNAPSHOT
  ?? '/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-aged.2026-09-15T05-25-19-366Z.8f48ed54.nVrXyi/evidence/db-full-post-2026-09-15T07-22-31-764Z.sqlite';

// The repo's own product SCHEMA_VERSION literal (the v9->v10 delta is derived
// from this file's applySchema). Read-only; no src/ file is written.
function extractSchemaVersion(source) {
  const match = source.match(/export const SCHEMA_VERSION = (\d+);/);
  assert.ok(match, 'SCHEMA_VERSION literal not found in src/db.ts');
  return Number(match[1]);
}

// Read an immutable snapshot's schema metadata read-only (the same discipline
// as the oracle's openEvidenceDatabase): user_version plus the runs and steps
// column universes.
function readSnapshotSchema(snapshotPath) {
  assert.ok(fs.existsSync(snapshotPath), `snapshot not found: ${snapshotPath}`);
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const userVersion = database.prepare('PRAGMA user_version').get().user_version;
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name);
    const columnsOf = (table) => (tables.includes(table)
      ? database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
      : []);
    return { user_version: userVersion, tables, runs_columns: columnsOf('runs'), steps_columns: columnsOf('steps') };
  } finally {
    database.close();
  }
}

// Resolve the seed snapshot's version expectation through the ORACLE'S OWN
// descriptor resolution (read-only): the observed stamp must be a supported
// version (9..13), the descriptor for that stamp decides the required column
// universe — a v12 stamp is classified by its actual lineage discriminator
// columns, a v13 stamp must carry BOTH union columns — and every required
// column of the resolved descriptor must be present in the snapshot. The
// column universe is therefore never retyped in this gate.
function resolveSeedSchemaExpectation(snapshotPath) {
  assert.ok(fs.existsSync(snapshotPath), `snapshot not found: ${snapshotPath}`);
  const supported = [...O12_SUPPORTED_SCHEMA_VERSIONS];
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const userVersion = database.prepare('PRAGMA user_version').get().user_version;
    assert.ok(supported.includes(userVersion),
      `the retained seed snapshot ${snapshotPath} must be stamped with a supported schema version `
      + `(observed ${userVersion}; supported {${supported.join(', ')}}) — a legacy 9..12 seed and the `
      + 'regenerated schema-13 seed are both acceptable');
    const { descriptor, lineage, lineageColumns } = resolveO12SchemaExpectation(database, userVersion);
    const missing = [];
    for (const [table, required] of Object.entries(descriptor.coreTables)) {
      const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
      for (const column of required) {
        if (!columns.has(column)) missing.push(`${table}.${column}`);
      }
    }
    assert.deepEqual(missing, [],
      `the seed snapshot ${snapshotPath} (user_version ${userVersion}, lineage ${lineage}) lacks the `
      + `version-specific required columns: ${missing.join(', ') || 'none'}`);
    return { user_version: userVersion, lineage, lineage_columns: lineageColumns, descriptor };
  } finally {
    database.close();
  }
}

// Host-portable stable product dist (STORM-SEED-QUALIFY US-010): the stable
// build the probes import is the REPO'S OWN dist, resolved from this file's
// location. The candidate/stable source-match guard is only meaningful when the
// presumed "stable install" is the same checkout as the candidate; a hardcoded
// /opt/tamandua/dist refuses every candidate branch whenever the host's live
// install is a different product lineage (as on vaimetal). An explicit
// TAMANDUA_O12_PROBE_DIST still overrides the probes when invoked directly.
const STABLE_DIST = path.join(REPO_ROOT, 'dist');

// Storm O12-ENV: the parent-authority env names the native probes are designed
// to strip on entry (exact mirror of each probe's own PARENT_AUTHORITY_ENV
// literal). The gate injects ONLY clearly fake, non-live sentinel values under
// these names (synthetic contaminated-caller fixture) and compares the probe's
// reported removed names against the names it ACTUALLY injected — empty
// removal is the correct, legitimate clean-caller result.
const PROBE_AUTHORITY_ENV_NAMES = [
  'TAMANDUA_RUN_ID',
  'TAMANDUA_WORKER_PID',
  'TAMANDUA_WORKER_PGID',
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_CONTROL_PORT',
];

// Clearly fake, non-live sentinel authority values for the contaminated-caller
// fixture: never a real run id, pid/pgid, job, control port, secret, provider
// key or reporting env. (The probes delete these names before any product
// operation, so the values are only ever reported, never connected to.)
function fakeAuthoritySentinels(seed) {
  return {
    TAMANDUA_RUN_ID: `run-o12-env-fake-${seed}-00000000-0000-4000-8000-000000000000`,
    TAMANDUA_WORKER_PID: `${920000 + seed}`,
    TAMANDUA_WORKER_PGID: `${930000 + seed}`,
    TAMANDUA_WORKER_JOB_ID: `o12-env-fake-job-${seed}`,
    TAMANDUA_CONTROL_PORT: `${59000 + seed}`,
  };
}

// EXPLICIT child env (Storm O12-ENV): the gate never spreads its own ambient
// env into a probe/fixture child. Whatever authority the gate's own caller
// happens to inherit (live TAMANDUA_RUN_ID / worker pid-pgid-job / control
// port / provider keys / reporting env) is therefore never forwarded; only an
// allow-list plus caller-supplied knobs is provided. Callers pass `extra` for
// test-only knobs (e.g. O12_PROBE_INJECT_*) or fake sentinel authority.
function childEnv({ tmpdir, extra = {} } = {}) {
  return {
    PATH: process.env.PATH ?? `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: tmpdir,
    TMPDIR: tmpdir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TAMANDUA_TEST_GUARD: '1',
    TAMANDUA_O12_PROBE_DIST: STABLE_DIST,
    // No real harness/daemon can ever be reached from a probe child, even by
    // accident (mirrors the root's clean authority-free boundary).
    TAMANDUA_PI_BINARY: '/bin/false',
    TAMANDUA_DSH_BINARY: '/bin/false',
    TAMANDUA_HERMES_BINARY: '/bin/false',
    ...extra,
  };
}

// Effective-isolation verification for a green native probe report (Storm
// O12-ENV): beyond merely asserting the stripped array exists, verify the
// probe actually ran under a private effective env rooted at the caller-owned
// tmpdir with guard=1, and that the reported removed authority names equal the
// names the caller actually injected (`expectedInjected`, empty for a clean
// caller).
function assertEffectivePrivateIsolation(report, tmpdir, expectedInjected, label) {
  const iso = report?.isolation;
  assert.ok(iso && typeof iso === 'object', `${label}: probe must report an isolation record`);
  assert.ok(Array.isArray(iso.parent_authority_stripped),
    `${label}: probe must report parent_authority_stripped as an array`);
  assert.deepEqual([...iso.parent_authority_stripped].sort(), [...expectedInjected].sort(),
    `${label}: reported removed authority names must equal the names actually injected (empty for a clean caller)`);
  assert.equal(iso.test_guard, '1', `${label}: probe must run under TAMANDUA_TEST_GUARD=1`);
  for (const field of ['home', 'state_dir', 'db_path', 'tmpdir']) {
    assert.ok(typeof iso[field] === 'string' && iso[field].startsWith(tmpdir),
      `${label}: effective isolation.${field} must be rooted at the private caller tmpdir (${JSON.stringify(iso[field])})`);
  }
}

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const evidenceDir = path.dirname(expectation.context);
  const snapshotPath = path.join(workspace, name, 'snapshots', 'database.sqlite');
  const snapshotBefore = createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
  const snapshotFilesBefore = fs.readdirSync(path.dirname(snapshotPath)).sort();
  const evidenceFilesBefore = fs.readdirSync(evidenceDir).sort();
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: evidenceDir,
    // Storm O12-ENV: explicit allow-list caller env (never the gate's ambient
    // env / live authority). The O12 executable itself is authority-agnostic,
    // but the gate forwards nothing it does not have to.
    env: {
      ...childEnv({ tmpdir: workspace }),
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O12',
      TT_ORACLE_CONTEXT: expectation.context, TT_ORACLE_EVIDENCE_DIR: evidenceDir,
      TT_CASE_ID: context.case.id, TT_CAMPAIGN_ID: context.campaign.id,
    },
    encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error, `${name}: oracle spawn failed: ${result.error?.message}`);
  assert.equal(result.signal, null, `${name}: oracle terminated by signal`);
  const response = JSON.parse(result.stdout.trim());
  // zero-unintended-writes: immutable snapshot untouched, no new snapshot files
  assert.equal(createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex'), snapshotBefore,
    `${name}: oracle mutated the immutable database snapshot`);
  assert.deepEqual(fs.readdirSync(path.dirname(snapshotPath)).sort(), snapshotFilesBefore,
    `${name}: oracle added/removed files in the snapshot directory`);
  const evidenceAfter = fs.readdirSync(evidenceDir).sort();
  const added = evidenceAfter.filter((file) => !evidenceFilesBefore.includes(file));
  return { expectation, response, status: result.status, evidenceDir, addedFiles: added };
}

function extractReservedKeys(source) {
  const start = source.indexOf('const RESERVED_CONTEXT_KEYS = new Set([');
  assert.ok(start >= 0, 'RESERVED_CONTEXT_KEYS literal not found in src/installer/step-ops.ts');
  const bodyStart = source.indexOf('[', start) + 1;
  const bodyEnd = source.indexOf(']);', bodyStart);
  return [...source.slice(bodyStart, bodyEnd).matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

function writeReceipt(workspace, extra = {}) {
  const identity = fs.lstatSync(workspace);
  const receipt = {
    kind: 'o12-gate-retained-workspace-receipt',
    root: workspace,
    ownership: { dev: identity.dev, ino: identity.ino },
    retained: 'retained intentionally; no recursive filesystem disposal performed by this gate',
    ...extra,
  };
  fs.writeFileSync(path.join(workspace, 'gate-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stderr.write(`o12 gate retained workspace: ${workspace}\n`);
  return receipt;
}

test('O12 reserved-key pin matches the native source literal; schema pin covers the repo SCHEMA_VERSION, 10 and the seed snapshot stamp', () => {
  const source = fs.readFileSync(STEP_OPS_TS, 'utf8');
  assert.deepEqual(extractReservedKeys(source), [...O12_RESERVED_CONTEXT_KEYS].sort(),
    'lib/o12.mjs reserved-key pin drifted from src/installer/step-ops.ts');
  // The schema pin is no longer a single version: O12 must support the repo's
  // own product SCHEMA_VERSION (the baseline schema), version 10 (the
  // TIME-STORAGE bump) and every version the union chain added up to the
  // current build (11 reroute budget, 12 outage rounds, 13 Matchlock union).
  const repoSchemaVersion = extractSchemaVersion(fs.readFileSync(DB_TS, 'utf8'));
  assert.ok(O12_SUPPORTED_SCHEMA_VERSIONS.includes(repoSchemaVersion),
    `O12 supported set ${JSON.stringify([...O12_SUPPORTED_SCHEMA_VERSIONS])} must include the repo SCHEMA_VERSION ${repoSchemaVersion}`);
  assert.ok(O12_SUPPORTED_SCHEMA_VERSIONS.includes(10),
    `O12 supported set ${JSON.stringify([...O12_SUPPORTED_SCHEMA_VERSIONS])} must include schema version 10`);
  // The retained seed snapshot is judged by ITS OWN stamp: the stamp must be a
  // MEMBER of the supported set (legacy seeds stamped 9..12 stay acceptable,
  // and the regenerated schema-13 seed is accepted too), and the
  // version-specific required columns for that stamp must be present — a v13
  // seed carries BOTH runs.matchlock_policy and steps.preclaim_death_count,
  // while a v9/v10 seed promises neither. Read-only open through the oracle's
  // own descriptor resolution; the retained root is never written.
  const seedSchema = readSnapshotSchema(SEED_SNAPSHOT);
  const seedExpectation = resolveSeedSchemaExpectation(SEED_SNAPSHOT);
  assert.equal(seedExpectation.user_version, seedSchema.user_version,
    'the resolved seed expectation must be for the snapshot\'s observed user_version');
  assert.ok(typeof seedExpectation.lineage === 'string' && seedExpectation.lineage.length > 0,
    'the seed snapshot must resolve to a named lineage');
  // The seeded required-column universe is the descriptor's, so a store the
  // resolved version does not promise (e.g. a v12 stamp with neither lineage
  // discriminator, or a v13 store missing a union column) fails resolution.
  assert.deepEqual(Object.keys(seedExpectation.descriptor.coreTables).sort(), ['runs', 'steps', 'stories'],
    'the resolved seed descriptor must be a full schema descriptor');
  assert.ok(seedExpectation.descriptor.columnDeclarations !== undefined,
    'the resolved seed descriptor must carry its declared column shapes');
});

// STORM-SEED-QUALIFY US-010 red-arming test: before the portability fix the
// gate pinned the stable dist to the absolute host path /opt/tamandua/dist, so
// on any host whose live install is a different product lineage the probe's
// candidate/stable source-match guard refused every candidate branch. The
// stable build must be the repo's own dist, both for the gate's child env and
// for a direct "run alone" probe invocation (no env override).
test('O12 stable dist is the repo-built product dist (host-portable pin, not /opt/tamandua)', () => {
  assert.equal(STABLE_DIST, path.join(REPO_ROOT, 'dist'), 'stable dist must resolve under the repo root');
  const env = childEnv({ tmpdir: TT_ROOT });
  assert.equal(env.TAMANDUA_O12_PROBE_DIST, path.join(REPO_ROOT, 'dist'),
    'gate must pin the repo-built dist so the candidate/stable source match holds on any host');
  assert.ok(fs.existsSync(path.join(STABLE_DIST, 'installer', 'step-ops.js')),
    'repo-built dist/installer/step-ops.js must exist (run npm run build)');
  assert.ok(fs.existsSync(path.join(STABLE_DIST, 'installer', 'run.js')),
    'repo-built dist/installer/run.js must exist (run npm run build)');
  for (const probe of ['o12-reserved-key-probe.mjs', 'o12-run-number-probe.mjs']) {
    const src = fs.readFileSync(path.join(HERE, probe), 'utf8');
    assert.match(src, /TAMANDUA_O12_PROBE_DIST \?\? path\.join\(REPO_ROOT, 'dist'\)/,
      `${probe} must default its stable dist to the repo-built dist`);
    assert.doesNotMatch(src, /TAMANDUA_O12_PROBE_DIST \?\? '\/opt\/tamandua\/dist'/,
      `${probe} must not hardcode /opt/tamandua/dist as the default stable dist`);
  }
});

test('O12 DB-integrity calibration: positive/negative controls per obligation through the real executable', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], {
      encoding: 'utf8', shell: false,
      env: childEnv({ tmpdir: workspace }),
    });
    assert.equal(generated.status, 0, `fixture generator failed: ${generated.stderr}`);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o12-')).sort();
    assert.equal(names.length, EXPECTED_FIXTURE_COUNT,
      `expected ${EXPECTED_FIXTURE_COUNT} O12 fixtures, got ${names.length}: ${names.join(', ')}`);
    writeReceipt(workspace, { fixture_count: names.length, fixtures: names });

    // ── schema fixture matrix (O12-SCHEMA-13 US-003) ─────────────────────
    // The DEFAULT fixture DDL is the CURRENT product schema (union chain,
    // user_version 13). The matrix below covers every supported version and
    // lineage: the raw v9 compatibility fixture, both v10 shapes (the legal
    // union-chain store without matchlock_policy and the pre-union
    // Matchlock-lineage store that carries it), v11, the three v12 lineages and
    // the v13 store — plus the fail-closed cases (a v12 stamp with neither
    // lineage discriminator, a v13/v14 store missing either union column, and
    // the out-of-range version stamps 8 and 15).
    const expectationByName = Object.fromEntries(names.map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8')),
    ]));
    for (const required of [
      'o12-schema-v9-compat',
      'o12-schema-v10-matchlock-policy',
      'o12-schema-v10-missing-matchlock-policy',
      'o12-schema-v11',
      'o12-schema-v12-main',
      'o12-schema-v12-matchlock',
      'o12-schema-v12-neither-lineage',
      'o12-schema-v13-native',
      'o12-schema-v13-matchlock-present',
      'o12-schema-v13-matchlock-invalid',
      'o12-schema-v13-missing-preclaim',
      'o12-schema-v13-missing-matchlock-policy',
      'o12-schema-v14-native',
      'o12-schema-v14-missing-preclaim',
      'o12-schema-version-unsupported',
      'o12-schema-version-unsupported-15',
    ]) {
      assert.ok(names.includes(required), `schema-version fixture matrix must include ${required}`);
    }
    // 11 is a SUPPORTED version now: no fixture may expect it to be unsupported.
    assert.ok(!names.includes('o12-schema-version-unsupported-11'),
      'no fixture may expect schema 11 to be unsupported (11 is in the supported set)');
    // Every supported version is represented by at least one generated fixture.
    for (const version of [9, 10, 11, 12, 13, 14]) {
      assert.ok(names.some((name) => expectationByName[name].schema?.user_version === version),
        `a fixture must exist for every supported schema version (missing ${version})`);
    }
    // The generator's own receipt: the pinned count, the version set it built
    // for (taken from the oracle constant, never re-typed in the generator) and
    // the version its default DDL stamps.
    const generationReceipt = JSON.parse(fs.readFileSync(path.join(workspace, 'generation-receipt.json'), 'utf8'));
    assert.equal(generationReceipt.kind, 'o12-fixture-generation-receipt', 'generation receipt kind');
    assert.equal(generationReceipt.fixture_count, EXPECTED_FIXTURE_COUNT,
      'the generation receipt fixture_count must equal the pinned EXPECTED_FIXTURE_COUNT');
    assert.deepEqual(generationReceipt.supported_user_versions, [...O12_SUPPORTED_SCHEMA_VERSIONS],
      'the generation receipt must record the oracle supported version set');
    assert.deepEqual(generationReceipt.supported_user_versions, [9, 10, 11, 12, 13, 14],
      'the generation receipt must record supported_user_versions [9, 10, 11, 12, 13, 14]');
    assert.equal(generationReceipt.default_user_version, 13,
      'the generation receipt must record default_user_version 13');
    assert.deepEqual([...generationReceipt.fixtures].sort(), names,
      'the generation receipt must enumerate exactly the generated fixtures');
    // The DEFAULT fixture DDL is the CURRENT product schema: a v13 stamp whose
    // runs table carries matchlock_policy and whose steps table carries both
    // chain columns.
    const defaultSchema = readSnapshotSchema(path.join(workspace, 'o12-green', 'snapshots', 'database.sqlite'));
    assert.equal(defaultSchema.user_version, 13, 'default fixture DDL must be schema user_version 13');
    assert.ok(defaultSchema.runs_columns.includes('matchlock_policy'),
      'default v13 fixture runs table must carry the union runs.matchlock_policy column');
    assert.ok(defaultSchema.steps_columns.includes('preclaim_death_count'),
      'default v13 fixture steps table must carry steps.preclaim_death_count');
    assert.ok(defaultSchema.steps_columns.includes('target_moved_reroute_count'),
      'default v13 fixture steps table must carry steps.target_moved_reroute_count');
    // Every shape fixture: the recorded shape AND the real generated columns
    // must agree with the matrix (a stamp/universe mismatch is exactly what the
    // fail-closed fixtures pin, so it must be stated explicitly, never implied).
    for (const shape of O12_SCHEMA_SHAPE_FIXTURES) {
      const record = expectationByName[shape.name].schema;
      assert.equal(record.user_version, shape.user_version, `${shape.name}: recorded user_version`);
      assert.equal(record.runs_matchlock_policy, shape.matchlock, `${shape.name}: recorded runs.matchlock_policy shape`);
      assert.equal(record.steps_target_moved_reroute_count, shape.targetMoved,
        `${shape.name}: recorded steps.target_moved_reroute_count shape`);
      assert.equal(record.steps_preclaim_death_count, shape.preclaim,
        `${shape.name}: recorded steps.preclaim_death_count shape`);
      const snapshotSchema = readSnapshotSchema(path.join(workspace, shape.name, 'snapshots', 'database.sqlite'));
      assert.equal(snapshotSchema.user_version, shape.user_version, `${shape.name}: snapshot user_version`);
      assert.equal(snapshotSchema.runs_columns.includes('matchlock_policy'), shape.matchlock,
        `${shape.name}: snapshot runs.matchlock_policy presence`);
      assert.equal(snapshotSchema.steps_columns.includes('target_moved_reroute_count'), shape.targetMoved,
        `${shape.name}: snapshot steps.target_moved_reroute_count presence`);
      assert.equal(snapshotSchema.steps_columns.includes('preclaim_death_count'), shape.preclaim,
        `${shape.name}: snapshot steps.preclaim_death_count presence`);
    }
    // The policy column's VALUE is part of each fixture's contract: a populated
    // non-policy literal on the v10 (out-of-universe) fixture, a complete valid
    // policy on the v12-matchlock/v13 fixtures, NULL on the native v13 one and a
    // present-but-malformed blob on the invalid control. The oracle's own judge
    // decides validity, so the fixture claim cannot drift.
    const policyValues = (name) => {
      const database = new DatabaseSync(path.join(workspace, name, 'snapshots', 'database.sqlite'), { readOnly: true });
      try {
        return database.prepare('SELECT matchlock_policy AS value FROM runs ORDER BY run_number').all()
          .map((row) => row.value);
      } finally {
        database.close();
      }
    };
    assert.deepEqual(policyValues('o12-schema-v10-matchlock-policy'), ['enforce'],
      'the v10 matchlock fixture must carry a POPULATED runs.matchlock_policy value');
    assert.deepEqual(policyValues('o12-schema-v13-native'), [null],
      'the v13 native fixture must store NULL runs.matchlock_policy');
    for (const name of ['o12-schema-v12-matchlock', 'o12-schema-v13-matchlock-present']) {
      const [value] = policyValues(name);
      assert.equal(validateO12MatchlockPolicyValue(value).status, 'valid',
        `${name}: the fixture's stored policy must be a COMPLETE valid policy`);
    }
    const [invalidPolicyValue] = policyValues('o12-schema-v13-matchlock-invalid');
    assert.equal(validateO12MatchlockPolicyValue(invalidPolicyValue).status, 'invalid',
      'the v13 invalid-policy control must store a present-but-malformed policy');
    // The fail-closed fixtures must be whole-oracle ERRORs (the loop below
    // asserts the exit code, zero evidence artifacts and no stray writes).
    for (const name of O12_SCHEMA_SHAPE_ERROR_FIXTURES) {
      assert.equal(expectationByName[name].expected, 'ERROR', `${name} must expect whole-oracle ERROR`);
    }
    assert.equal(expectationByName['o12-schema-v13-matchlock-invalid'].expected, 'FAIL',
      'an invalid Matchlock policy is judgeable product data: FAIL, never ERROR');
    for (const name of ['o12-schema-v11', 'o12-schema-v12-main', 'o12-schema-v12-matchlock', 'o12-schema-v13-native', 'o12-schema-v13-matchlock-present']) {
      assert.equal(expectationByName[name].expected, 'PASS', `${name} must be a positive (PASS) control`);
    }
    // The eight executable O12-CLOSE correction cases: the seven named fixtures
    // must all be generated, and their expected == observed is asserted by the
    // loop below. The eighth (the run-number allocator characterization) is the
    // real-API probe + retained SQL-replica calibration covered by the
    // dedicated behavioral-probe tests.
    for (const name of O12_CLOSE_CASE_FIXTURES) {
      assert.ok(names.includes(name), `O12-CLOSE correction-case fixture must be present: ${name}`);
    }

    for (const name of names) {
      const { expectation, response, status, addedFiles } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, EXIT_BY_RESULT[expectation.expected], `${name}: exit code mismatch`);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding),
          `${name}: omitted finding ${expectation.finding}; got ${response.findings.map((f) => f.id).join(',')}`);
      }
      // ERROR fixtures fail closed (malformed evidence/snapshot): no evidence
      // artifact, no other writes beyond the immutable inputs.
      if (expectation.expected === 'ERROR') {
        assert.equal(response.evidence.length, 0, `${name}: ERROR must not produce evidence`);
        assert.deepEqual(addedFiles, [], `${name}: ERROR must not write evidence files`);
        continue;
      }
      // Every non-ERROR invocation writes exactly its single evidence artifact.
      assert.deepEqual(addedFiles, ['o12-db-integrity.json'],
        `${name}: unexpected evidence writes: ${addedFiles.join(', ')}`);
      // Per-obligation coverage record is always present and honest.
      assert.equal(response.evidence.length, 1, `${name}: evidence length`);
      const evidencePath = path.join(workspace, name, 'evidence', response.evidence[0].path);
      const observation = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      assert.equal(observation.schema_version, 1, `${name}: evidence schema`);
      assert.equal(observation.overall_result, expectation.expected, `${name}: coverage overall_result`);
      for (const leg of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
        assert.ok(observation.coverage[leg], `${name}: coverage record ${leg} missing`);
        assert.ok(['PASS', 'FAIL', 'NOT_EVALUABLE', 'ERROR'].includes(observation.coverage[leg].result),
          `${name}: coverage ${leg} has invalid result ${observation.coverage[leg].result}`);
      }
      if (expectation.r3expected) {
        assert.equal(observation.coverage.R3.result, expectation.r3expected, `${name}: R3 leg result`);
      }
      if (expectation.r5expected) {
        assert.equal(observation.coverage.R5.result, expectation.r5expected, `${name}: R5 leg result`);
      }
      if (expectation.r1expected) {
        assert.equal(observation.coverage.R1.result, expectation.r1expected, `${name}: R1 leg result`);
      }
      if (expectation.r1SkippedSubCheck) {
        // An orphan matrix sub-check that could not run (absent child/parent
        // table or column) must be visible: NOT_EVALUABLE status with the
        // present flags recorded — never a silent skip.
        const skipped = (observation.coverage.R1.orphan_checks || [])
          .find((c) => c.status === 'NOT_EVALUABLE' && c.table === expectation.r1SkippedSubCheck);
        assert.ok(skipped, `${name}: expected a NOT_EVALUABLE orphan sub-check for ${expectation.r1SkippedSubCheck}`);
        assert.equal(skipped.present.child_table, false,
          `${name}: skipped sub-check must record the absent child table flag`);
        assert.ok(skipped.present && typeof skipped.present === 'object',
          `${name}: skipped sub-check must record present flags`);
      }
      if (expectation.r1ExactOrphanCount !== undefined) {
        // Exact-total discipline (Storm O12-close B): when N orphans exist the
        // orphan-matrix row reports orphan_count N even though only ≤5 samples
        // are emitted as findings.
        const row = (observation.coverage.R1.orphan_checks || [])
          .find((c) => Number.isInteger(c.orphan_count) && c.orphan_count > 0);
        assert.ok(row, `${name}: expected an orphan-matrix FAIL row with an exact orphan_count`);
        assert.equal(row.orphan_count, expectation.r1ExactOrphanCount,
          `${name}: orphan_count must be the exact total (${expectation.r1ExactOrphanCount})`);
        assert.equal(row.status, 'FAIL', `${name}: orphan row with orphans must be FAIL`);
        const findings = response.findings.filter((finding) => finding.id === 'O12_STRUCT_ORPHAN');
        assert.ok(findings.length <= 5,
          `${name}: orphan findings must stay capped at 5 while orphan_count is exact (got ${findings.length})`);
      }
      if (expectation.r4expected) {
        assert.equal(observation.coverage.R4.result, expectation.r4expected, `${name}: R4 leg result`);
      }
      if (expectation.r4ReservedExpected) {
        assert.ok(observation.coverage.R4.reserved_key_leg, `${name}: R4 reserved_key_leg record missing`);
        assert.equal(observation.coverage.R4.reserved_key_leg.result, expectation.r4ReservedExpected,
          `${name}: R4 reserved-key sub-leg result`);
      }
      if (expectation.r4ParseFailureCount !== undefined) {
        assert.equal(observation.coverage.R4.parse_failure_count, expectation.r4ParseFailureCount,
          `${name}: parse_failure_count must be the exact total (${expectation.r4ParseFailureCount})`);
        assert.ok(observation.coverage.R4.parse_failure_count >= 0, `${name}: parse_failure_count sanity`);
      }
      if (expectation.r4TypeFailureCount !== undefined) {
        assert.equal(observation.coverage.R4.type_failure_count, expectation.r4TypeFailureCount,
          `${name}: type_failure_count must be the exact total (${expectation.r4TypeFailureCount})`);
      }
      // Exact-counter discipline on the reserved-key leg: every *_count is a
      // full total independent of the bounded *_samples lists.
      const rl = observation.coverage.R4?.reserved_key_leg;
      if (rl && typeof rl.overwrite_count === 'number') {
        assert.ok(Array.isArray(rl.overwrite_samples) && rl.overwrite_samples.length <= 5,
          `${name}: reserved-key overwrite samples must be capped at 5`);
        assert.ok(rl.overwrite_count >= rl.overwrite_samples.length,
          `${name}: overwrite_count must not under-report the sample list`);
      }
      const numericExpectations = [
        ['r4OverwriteCount', 'overwrite_count'],
        ['r4KeysChecked', 'keys_checked'],
        ['r4KeysExpectedAbsent', 'keys_expected_absent'],
        ['r4KeysExpectedPresent', 'keys_expected_present'],
        ['r4KnownAbsencesChecked', 'known_absences_checked'],
        ['r4EmptyStringPresentMatches', 'empty_string_present_matches'],
        ['r4HostTransitionMatches', 'host_transition_matches'],
        ['r4RunsCompared', 'runs_compared'],
        ['r4RunsFullyExpected', 'runs_fully_expected'],
        ['r4KeysUnassertedTotal', 'keys_unasserted_total'],
        ['r4NonReservedIgnored', 'non_reserved_keys_ignored'],
        ['r4RunsWithoutEntryCount', 'coverage_gaps.runs_without_expected_entry_count'],
        ['r4RunsPartialEntryCount', 'coverage_gaps.runs_with_partial_expected_entry_count'],
        ['r4RunsUnparseableCount', 'coverage_gaps.runs_with_unparseable_context_count'],
        ['r4ScopeOutsideCount', 'scope.snapshot_runs_outside_admitted_scope_count'],
        ['r4AdmittedNotInSnapshotCount', 'scope.admitted_runs_not_in_snapshot_count'],
        ['r4ExpectedNotInSnapshotCount', 'scope.expected_runs_not_in_snapshot_count'],
        ['r4FullSnapshotCovered', 'scope.full_snapshot_covered'],
      ];
      for (const [expectKey, recordPath] of numericExpectations) {
        if (expectation[expectKey] === undefined) continue;
        const value = recordPath.split('.').reduce((acc, part) => acc?.[part], rl);
        assert.equal(value, expectation[expectKey],
          `${name}: reserved-key leg ${recordPath} must equal ${expectation[expectKey]} (got ${JSON.stringify(value)})`);
      }
      // Storm O12 probe-close: a reserved-key PASS over an explicit host-admitted
      // subset must be unmistakably scoped. full_snapshot_covered is true ONLY
      // when the whole snapshot (every row) was compared over the ENTIRE pin
      // (exact totals: runs_compared === snapshot rows, keys_checked === 17 ×
      // snapshot rows); any subset admission, absent admitted run or coverage
      // gap leaves it false. It records comparison COVERAGE, not the verdict.
      if (rl?.scope) {
        assert.equal(typeof rl.scope.full_snapshot_covered, 'boolean',
          `${name}: reserved-key scope record must carry full_snapshot_covered`);
        // The mirror reproduces the lib/o12.mjs predicate EXACTLY:
        // snapshotIds.length > 0 AND inScope.length === snapshotIds.length
        // (here snapshot_runs_in_scope === snapshot_runs_total — set in BOTH
        // modes) AND (mode !== 'explicit' || admittedNotInSnapshot.length === 0)
        // (here the absent-admission count, which explicit mode always emits)
        // AND runsCompared === snapshotIds.length AND keysChecked === 17 ×
        // snapshotIds.length. A subset admission, an admitted-but-absent
        // (ghost) run or any coverage gap leaves it false even when the
        // compared rows/keys totals are whole: an explicit-mode run that fully
        // compares every snapshot row yet also names a ghost stays false.
        const expectedFullCoverage = rl.scope.snapshot_runs_total > 0
          && rl.scope.snapshot_runs_in_scope === rl.scope.snapshot_runs_total
          && (rl.scope.mode !== 'explicit' || (rl.scope.admitted_runs_not_in_snapshot_count ?? 0) === 0)
          && rl.runs_compared === rl.scope.snapshot_runs_total
          && rl.keys_checked === O12_RESERVED_CONTEXT_KEYS.length * rl.scope.snapshot_runs_total;
        assert.equal(rl.scope.full_snapshot_covered, expectedFullCoverage,
          `${name}: full_snapshot_covered must mirror the lib predicate (whole-snapshot × whole-pin coverage, zero out-of-scope/ghost admissions)`);
        if (expectation.expected === 'PASS' && rl.scope.mode === 'explicit') {
          assert.equal(rl.scope.snapshot_runs_total > 0 && rl.scope.full_snapshot_covered,
            rl.scope.snapshot_runs_outside_admitted_scope_count === 0
              && rl.scope.admitted_runs_not_in_snapshot_count === 0
              && rl.runs_fully_expected === rl.scope.snapshot_runs_total,
            `${name}: an explicit-mode PASS may claim full_snapshot_covered only with zero out-of-admission/absent runs and every snapshot row fully expected`);
        }
      }
      // Bounded-evidence discipline on the new default-mode stale-run surface:
      // expected_runs_not_in_snapshot_samples stays capped while the _count is
      // exact and never under-reports the emitted samples (mirrors every other
      // O12 count/sample pair).
      if (rl?.scope && Array.isArray(rl.scope.expected_runs_not_in_snapshot_samples)) {
        assert.ok(rl.scope.expected_runs_not_in_snapshot_samples.length <= 10,
          `${name}: expected_runs_not_in_snapshot_samples must stay capped at 10`);
        assert.ok(Number.isInteger(rl.scope.expected_runs_not_in_snapshot_count)
          && rl.scope.expected_runs_not_in_snapshot_count >= 0
          && rl.scope.expected_runs_not_in_snapshot_count >= rl.scope.expected_runs_not_in_snapshot_samples.length,
          `${name}: expected_runs_not_in_snapshot_count must be an exact total >= the emitted samples`);
      }
      // PASS fixtures must demonstrate every leg green (no silently missing leg).
      if (expectation.expected === 'PASS') {
        for (const leg of ['R1', 'R2', 'R3', 'R4', 'R5']) {
          assert.equal(observation.coverage[leg].result, 'PASS', `${name}: PASS requires ${leg} green`);
        }
      }
      // Bounded evidence: no full task/context/step bodies are copied.
      const serialized = JSON.stringify(observation);
      assert.ok(!serialized.includes('{{task}}') && !serialized.includes('STATUS: done\nCHANGES'),
        `${name}: evidence must stay bounded (no template bodies)`);
    }
  } finally {
    // Storm O12-close C: the workspace is intentionally RETAINED (receipt
    // written above). No recursive filesystem disposal runs here.
  }
});

test('O12 isolation/closure negatives: injected DB-close errors and listener-close timeouts make the native probes NON-green (no swallowed close)', () => {
  // Storm O12 probe-close: these run BEFORE the real native probes and prove
  // that a probe can never publish a closed receipt after swallowing a close
  // error or an unknown close timeout. Each injected run must exit nonzero and
  // report the exact owned handle's closure as NOT observed.
  fs.mkdirSync(VAR_ROOT, { recursive: true });

  // Reserved-key probe: injected owned-DB close error → non-green, db NOT
  // observed closed (the probe still exercises the full 17-key matrix first).
  const reservedTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.reserved-neg-tmp.'));
  const reservedNeg = spawnSync(process.execPath, [path.join(HERE, 'o12-reserved-key-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 30_000,
    env: childEnv({ tmpdir: reservedTmp, extra: { O12_PROBE_INJECT_DB_CLOSE_ERROR: '1' } }),
  });
  assert.notEqual(reservedNeg.status, 0, `reserved probe with injected DB-close error must be NON-green:\n${reservedNeg.stdout}\n${reservedNeg.stderr}`);
  const reservedReport = JSON.parse(reservedNeg.stdout.trim());
  assert.equal(reservedReport.closure.db_close.observed, false,
    'reserved probe must report the injected DB close as NOT observed');
  assert.match(reservedReport.closure.db_close.error ?? '', /injected owned-DB close failure/,
    'reserved probe must surface the DB close error, not swallow it');

  // Real-API run-number probe: injected owned-DB close error → non-green.
  const dbErrTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.probe-neg-db-tmp.'));
  const dbErrNeg = spawnSync(process.execPath, [path.join(HERE, 'o12-run-number-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 120_000,
    env: childEnv({ tmpdir: dbErrTmp, extra: { O12_PROBE_INJECT_DB_CLOSE_ERROR: '1' } }),
  });
  assert.notEqual(dbErrNeg.status, 0, `run-number probe with injected DB-close error must be NON-green:\n${dbErrNeg.stdout}\n${dbErrNeg.stderr}`);
  const dbErrReport = JSON.parse(dbErrNeg.stdout.trim());
  assert.equal(dbErrReport.closure.db_close.observed, false,
    'run-number probe must report the injected DB close as NOT observed');
  assert.match(dbErrReport.closure.db_close.error ?? '', /injected owned-DB close failure/,
    'run-number probe must surface the DB close error, not swallow it');

  // Real-API run-number probe: injected listener close that never completes →
  // the bounded timeout is an UNKNOWN outcome and must make the probe non-green.
  const listenerTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.probe-neg-ln-tmp.'));
  const listenerNeg = spawnSync(process.execPath, [path.join(HERE, 'o12-run-number-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 30_000,
    env: childEnv({
      tmpdir: listenerTmp,
      extra: { O12_PROBE_INJECT_LISTENER_CLOSE_TIMEOUT: '1', O12_PROBE_CLOSE_TIMEOUT_MS: '2000' },
    }),
  });
  assert.notEqual(listenerNeg.status, 0, `run-number probe with injected listener-close timeout must be NON-green:\n${listenerNeg.stdout}\n${listenerNeg.stderr}`);
  const listenerReport = JSON.parse(listenerNeg.stdout.trim());
  assert.equal(listenerReport.closure.listener_close.observed, false,
    'run-number probe must report the timed-out listener close as NOT observed');
  assert.match(listenerReport.closure.listener_close.error ?? '', /did not complete within|unknown outcome/,
    'run-number probe must surface the unknown listener-close outcome, not swallow it');
  process.stderr.write('o12 isolation/closure negatives: injected close error/timeout correctly NON-green\n');
});

test('O12 behavioral probe: real-API run_number MAX+1 delete-recreate reuse (createA/createB, owned deletion, createC)', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const probeTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.probe-tmp.'));
  // Storm O12-ENV: the probe is spawned from an EXPLICIT authority-free caller
  // env (childEnv never forwards whatever authority this gate's own caller
  // inherits). Nothing was injected, so the probe legitimately reports an EMPTY
  // parent_authority_stripped list — empty removal is the correct clean-caller
  // result. The synthetic contaminated-caller direction is covered by its own
  // dedicated test below.
  const result = spawnSync(process.execPath, [path.join(HERE, 'o12-run-number-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 120_000,
    env: childEnv({ tmpdir: probeTmp }),
  });
  assert.equal(result.status, 0, `real-API run-number probe failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.probe, 'o12-run-number-real-api');
  assert.equal(report.real_api_observation, true);
  assert.equal(report.delete_recreate_reuse_observed, true);
  assert.equal(report.live_rows_unique, true);
  assert.deepEqual(report.live_rows_after, [1, 2]);
  assert.deepEqual(report.allocated_sequence, [1, 2, 2]);
  assert.equal(report.source_pinned.source_matches_dist, true, 'repo candidate source must match the stable dist source');
  assert.match(report.source_pinned.sha256, /^[a-f0-9]{64}$/);
  // Positive exact owned-handle closure must be OBSERVED (not a swallowed
  // best-effort receipt) under a clean authority-free caller.
  assert.equal(report.closure.listener_close.observed, true, 'real-API probe must positively observe listener close');
  assert.equal(report.closure.db_close.observed, true, 'real-API probe must positively observe DB close');
  // Authority-free caller: reported removed names must equal the names actually
  // injected (none) and the effective private env/paths must be intact.
  assertEffectivePrivateIsolation(report, probeTmp, [], 'real-API run-number probe (clean caller)');
  assert.ok(typeof report.workspace_receipt?.root === 'string' && report.workspace_receipt.root.length > 0,
    'real-API probe must publish a retained workspace receipt');
  process.stderr.write(`o12 run-number real-API probe retained: ${report.workspace_receipt?.root ?? '?'}\n`);
});

test('O12 calibration: retained SQL-replica allocator replay (explicitly named calibration, NOT the real-API observation)', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const probeTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.calib-tmp.'));
  const result = spawnSync(process.execPath, [path.join(HERE, 'o12-run-number-allocator-calibration.mjs')], {
    encoding: 'utf8', shell: false, timeout: 30_000,
    env: childEnv({ tmpdir: probeTmp }),
  });
  assert.equal(result.status, 0, `allocator calibration probe failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.probe, 'o12-run-number-allocator-calibration');
  assert.equal(report.calibration_kind, 'sql-replica');
  assert.equal(report.delete_recreate_reuse_observed, true);
  assert.equal(report.live_rows_unique, true);
  assert.deepEqual(report.live_rows_after, [1, 2]);
  assert.match(report.source_pinned.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof report.workspace_receipt?.root === 'string' && report.workspace_receipt.root.length > 0,
    'calibration probe must publish a retained workspace receipt');
});

test('O12 behavioral probe: ALL 17 reserved context keys (incl. the 4 worktree keys) survive malicious agent output through the real step-ops merge — present-preservation AND absent-introduction', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const probeTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.reserved-tmp.'));
  // Storm O12-ENV: explicit authority-free caller env (childEnv never forwards
  // whatever authority this gate's own caller inherits). Nothing was injected,
  // so an EMPTY parent_authority_stripped list is the correct clean-caller
  // result; the contaminated-caller direction is its own dedicated test below.
  const result = spawnSync(process.execPath, [path.join(HERE, 'o12-reserved-key-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 30_000,
    env: childEnv({ tmpdir: probeTmp }),
  });
  assert.equal(result.status, 0, `reserved-key probe failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.probe, 'o12-reserved-key-step-ops');
  // All 17 reserved keys (never a 13-key subset disguised by a 17 constant):
  // expected/attempted/checked key sets are equal and every key is covered
  // BOTH ways (present-preservation verified AND absent-introduction verified).
  assert.equal(report.reserved_keys_guarded, 17);
  assert.equal(report.key_sets_equal, true, 'expected/attempted/checked reserved-key sets must be equal');
  assert.equal(report.key_sets.expected_equals_attempted, true);
  assert.equal(report.key_sets.expected_equals_checked, true);
  assert.equal(report.covered_keys_count, 17, 'exact tested coverage must be 17 keys, not a constant size');
  for (const key of report.key_sets.expected_keys) {
    const coverage = report.key_coverage?.[key];
    assert.ok(coverage && coverage.present_preservation_verified && coverage.absent_introduction_verified,
      `key ${key} must be verified present-preserved AND absent-introduction-blocked`);
  }
  assert.ok(report.key_sets.expected_keys.includes('worktree_path')
    && report.key_sets.expected_keys.includes('worktree_origin_repository')
    && report.key_sets.expected_keys.includes('worktree_origin_ref')
    && report.key_sets.expected_keys.includes('worktree_origin_sha'),
    'the four worktree reserved keys must be exercised');
  assert.equal(report.changed_keys.length, 0, 'no seeded reserved value may change');
  assert.equal(report.introduced_keys.length, 0, 'no absent reserved key may be introduced');
  assert.equal(report.non_reserved_merged, true);
  assert.equal(report.steps_terminal_status, 'done');
  assert.equal(report.closure.db_close.observed, true, 'reserved-key probe must positively observe DB close');
  // Authority-free caller: reported removed names must equal the names actually
  // injected (none) and the effective private env/paths must be intact.
  assertEffectivePrivateIsolation(report, probeTmp, [], 'reserved-key probe (clean caller)');
  assert.equal(report.isolation?.control_port, '(stripped — no live daemon reachable)',
    'reserved-key probe must report no live daemon control plane reachable');
  assert.equal(report.source_pinned.source_matches_dist, true, 'candidate step-ops source must match the stable dist semantics');
  assert.match(report.source_pinned.sha256, /^[a-f0-9]{64}$/);
  assert.ok(typeof report.workspace_receipt?.root === 'string' && report.workspace_receipt.root.length > 0,
    'reserved-key probe must publish a retained workspace receipt');
  process.stderr.write(`o12 reserved-key probe retained: ${report.workspace_receipt?.root ?? '?'}\n`);
});

test('O12 isolation/authority: synthetic contaminated caller — both native probes strip exactly the injected fake authority names and stay green', () => {
  // Storm O12-ENV: the gate must faithfully test an EXPLICIT contaminated
  // caller without depending on whatever authority the gate's own caller
  // happens to inherit. Here we inject ONLY clearly fake non-live sentinel
  // values (fake run id / worker pid-pgid-job / control port — never the real
  // live values, never provider keys or reporting env) and assert each native
  // probe reports removing EXACTLY those injected names while staying green
  // with a private effective env. (The authority-free caller direction is
  // asserted in the two clean-caller probe tests above.)
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const injected = fakeAuthoritySentinels(2);
  const injectedNames = Object.keys(injected);
  // The contaminated fixture must inject EVERY parent-authority name the probes
  // are designed to strip (never a silent subset), so the reported removed
  // names can be compared 1:1 with the injected names.
  assert.deepEqual([...injectedNames].sort(), [...PROBE_AUTHORITY_ENV_NAMES].sort(),
    'contaminated-caller fixture must inject all five parent-authority env names');

  // Reserved-key probe under the synthetic contaminated caller.
  const reservedTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.reserved-auth-tmp.'));
  const reservedRes = spawnSync(process.execPath, [path.join(HERE, 'o12-reserved-key-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 30_000,
    env: childEnv({ tmpdir: reservedTmp, extra: injected }),
  });
  assert.equal(reservedRes.status, 0, `reserved-key probe under injected fake authority must stay green:\n${reservedRes.stdout}\n${reservedRes.stderr}`);
  const reservedReport = JSON.parse(reservedRes.stdout.trim());
  // Reported removed names must equal the names ACTUALLY injected.
  assertEffectivePrivateIsolation(reservedReport, reservedTmp, injectedNames, 'reserved-key probe (contaminated caller)');
  assert.equal(reservedReport.covered_keys_count, 17,
    'reserved-key probe under injected fake authority must still cover all 17 keys');
  assert.equal(reservedReport.closure.db_close.observed, true,
    'reserved-key probe under injected fake authority must still positively observe DB close');

  // Real-API run-number probe under the synthetic contaminated caller.
  const probeTmp = fs.mkdtempSync(path.join(PROBE_SCRATCH_BASE, 'oracle-self-test.run-number-auth-tmp.'));
  const probeRes = spawnSync(process.execPath, [path.join(HERE, 'o12-run-number-probe.mjs')], {
    encoding: 'utf8', shell: false, timeout: 120_000,
    env: childEnv({ tmpdir: probeTmp, extra: injected }),
  });
  assert.equal(probeRes.status, 0, `run-number probe under injected fake authority must stay green:\n${probeRes.stdout}\n${probeRes.stderr}`);
  const probeReport = JSON.parse(probeRes.stdout.trim());
  assertEffectivePrivateIsolation(probeReport, probeTmp, injectedNames, 'run-number probe (contaminated caller)');
  assert.deepEqual(probeReport.allocated_sequence, [1, 2, 2],
    'run-number probe under injected fake authority must still observe the real MAX+1 reuse sequence');
  assert.equal(probeReport.closure.listener_close.observed, true,
    'run-number probe under injected fake authority must still positively observe listener close');
  assert.equal(probeReport.closure.db_close.observed, true,
    'run-number probe under injected fake authority must still positively observe DB close');
  process.stderr.write('o12 contaminated-caller fixture: both native probes stripped exactly the injected fake authority names and stayed green\n');
});
