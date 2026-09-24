#!/usr/bin/env node

// o12-seed-snapshot.test.mjs — focused tests for the O12-REPIN US-004
// seed-snapshot run machinery and the O12-SCHEMA-13 US-004 owned-store
// acceptance.
//
// Unit-tests the pure matrix shaping/validation and the supplementary
// read-only pair breakdown, then (when the retained seed root is available)
// drives the REAL working-tree O12 oracle over an owned copy of the retained
// immutable snapshot and asserts the published R1..R6 matrix with exact counts.
// It also re-validates the newest retained `seed-snapshot-matrix.json`.
//
// O12-SCHEMA-13 US-004 adds the owned-store acceptance: an owned store is
// built per supported schema version/lineage (9, 10, 11, 12-main,
// 12-matchlock, 13) from the oracle's own descriptors, the real O12 oracle
// judges each one (R1 must be EVALUABLE — PASS or FAIL, never NOT_EVALUABLE),
// and the per-case R1..R6 matrices plus the aggregate receipt are retained
// under torture-test/var/results/. The two flat owned seed snapshots
// (seed-snapshot-v13.sqlite, seed-snapshot-legacy-v12.sqlite) that
// TAMANDUA_O12_SEED_SNAPSHOT points at are materialized from the same builders.
//
// Override the source root with TAMANDUA_O12_SEED_ROOT; the retained results
// root can be overridden with TAMANDUA_O12_SEED_RESULTS. The heavy real-oracle
// run is skipped (with a message) when the source snapshot is absent, so the
// pure assertions still run on a host without the retained evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_SEED_ROOT,
  OWNED_SEED_SNAPSHOTS,
  OWNED_STORE_CASES,
  SEED_SNAPSHOT_EXPECTED,
  buildSeedSnapshotMatrix,
  captureSourceIdentity,
  materializeOwnedSeedSnapshots,
  ownedStoreCase,
  ownedStoreDescriptor,
  ownedStoreExpectation,
  readPairMismatchBreakdown,
  runOwnedStoreAcceptance,
  runSeedSnapshotOracle,
  validateSeedSnapshotMatrix,
  writeOwnedStore,
} from './o12-seed-snapshot.mjs';
import { O12_RESERVED_CONTEXT_KEYS, O12_SUPPORTED_SCHEMA_VERSIONS, resolveO12SchemaExpectation } from '../lib/o12.mjs';
import { safeProbeTmpdir } from './o12-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const RESULTS_ROOT = path.join(TT_ROOT, 'var', 'results');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const SOURCE_ROOT = process.env.TAMANDUA_O12_SEED_ROOT ?? DEFAULT_SEED_ROOT;
const SNAPSHOT_PATH = path.join(SOURCE_ROOT, 'evidence', 'db-full-post-2026-09-15T07-22-31-764Z.sqlite');

function shapeHistogram() {
  return {
    'runs.created_at': { 'native-iso': 5000 },
    'runs.updated_at': { 'native-sqlite': 5000 },
    'steps.created_at': { 'native-iso': 26526 },
    'steps.updated_at': { 'native-sqlite': 19166, 'native-iso': 7360 },
  };
}

function syntheticEvidence() {
  return {
    schema_version: 1,
    oracle_id: 'O12',
    overall_result: 'FAIL',
    coverage: {
      R1: {
        obligation: 'structural-integrity-orphans',
        result: 'PASS',
        integrity_check: 'ok',
        foreign_key_check_violations: 0,
        orphan_checks: Array.from({ length: 7 }, () => ({ status: 'PASS', orphan_count: 0 })),
      },
      R2: { obligation: 'run-number-uniqueness', result: 'PASS', rows_checked: 5000, null_count: 0, invalid_count: 0, duplicate_number_count: 0 },
      R3: {
        obligation: 'timestamp-uniformity-instant-order', result: 'FAIL',
        invalid_value_count: 0, native_format_mix_column_count: 1, pair_format_mismatch_count: 24166, order_violation_count: 0,
      },
      R4: {
        obligation: 'context-json-reserved-keys', result: 'PASS', runs_checked: 5000, parse_failure_count: 0, type_failure_count: 0,
        reserved_key_leg: { result: 'PASS', runs_compared: 5000, keys_checked: 85000, overwrite_count: 0, host_transition_matches: 150 },
      },
      R5: { obligation: 'serial-composite-state', result: 'PASS', violation_count: 0 },
      R6: { obligation: 'per-obligation-coverage', result: 'PASS', overall: 'FAIL' },
    },
    observations: [
      {
        scope: 'structural',
        schema_metadata: { user_version: 10, lineage: 'v10', supported_user_versions: [9, 10, 11, 12, 13, 14], supported_version: true, tables: ['runs', 'steps', 'stories'], core_columns: { runs: { required: ['id', 'matchlock_policy'] } } },
      },
      { scope: 'timestamps', shape_histogram: shapeHistogram(), pair_format_mismatch_count: 24166 },
    ],
  };
}

function syntheticMatrix() {
  const copied = { snapshot: { sha256: 'a'.repeat(64) }, sidecar: { sha256: 'b'.repeat(64) } };
  const source = { root: '/opt/seed', snapshot: { sha256: 'a'.repeat(64) }, sidecar: { sha256: 'b'.repeat(64) }, retained_root_unchanged: true };
  return buildSeedSnapshotMatrix({
    evidenceJson: syntheticEvidence(),
    stdoutJson: { result: 'FAIL', findings: [{ id: 'O12_TIME_PAIR_FORMAT_MISMATCH' }] },
    exitCode: 1,
    pairBreakdown: {
      runs: { pair_mismatch_count: 5000 },
      steps: { pair_mismatch_count: 19166 },
      total_pair_mismatch_count: 24166,
    },
    copied,
    source,
    invocation: { oracle: 'O12', exit_code: 1 },
  });
}

test('buildSeedSnapshotMatrix shapes the expected R1..R6 matrix with exact counts', () => {
  const matrix = syntheticMatrix();
  assert.equal(matrix.kind, 'o12-seed-snapshot-matrix');
  assert.equal(matrix.legs.R1.result, 'PASS');
  assert.equal(matrix.legs.R1.integrity_check, 'ok');
  assert.equal(matrix.legs.R1.foreign_key_check_violations, 0);
  assert.equal(matrix.legs.R1.orphan_count_total, 0);
  assert.equal(matrix.legs.R2.result, 'PASS');
  assert.equal(matrix.legs.R2.rows_checked, 5000);
  assert.equal(matrix.legs.R3.result, 'FAIL');
  assert.equal(matrix.legs.R3.pair_format_mismatch_count, 24166);
  assert.equal(matrix.legs.R3.runs_pair_mismatch_count, 5000);
  assert.equal(matrix.legs.R3.steps_pair_mismatch_count, 19166);
  assert.equal(matrix.legs.R3.steps_updated_at_native_sqlite, 19166);
  assert.equal(matrix.legs.R3.steps_updated_at_native_iso, 7360);
  assert.equal(matrix.legs.R3.steps_updated_at_total, 26526);
  assert.equal(matrix.legs.R4.result, 'PASS');
  assert.equal(matrix.legs.R4.keys_checked, 85000);
  assert.equal(matrix.legs.R4.overwrite_count, 0);
  assert.equal(matrix.legs.R4.host_transition_matches, 150);
  assert.equal(matrix.legs.R5.result, 'PASS');
  assert.equal(matrix.legs.R5.violation_count, 0);
  assert.equal(matrix.legs.R6.result, 'PASS');
  assert.equal(matrix.legs.R6.overall, 'FAIL');
  assert.equal(matrix.overall_result, 'FAIL');
  const validation = validateSeedSnapshotMatrix(matrix);
  assert.equal(validation.ok, true, validation.problems.join('; '));
});

test('validateSeedSnapshotMatrix rejects result/count/attribution/linkage drift', () => {
  const green = validateSeedSnapshotMatrix(syntheticMatrix());
  assert.equal(green.ok, true, green.problems.join('; '));

  const wrongLeg = syntheticMatrix();
  wrongLeg.legs.R1.result = 'NOT_EVALUABLE';
  assert.equal(validateSeedSnapshotMatrix(wrongLeg).ok, false);

  const wrongCount = syntheticMatrix();
  wrongCount.legs.R3.pair_format_mismatch_count = 24165;
  assert.equal(validateSeedSnapshotMatrix(wrongCount).ok, false);

  const wrongR4 = syntheticMatrix();
  wrongR4.legs.R4.keys_checked = 84999;
  assert.equal(validateSeedSnapshotMatrix(wrongR4).ok, false);

  const wrongOverall = syntheticMatrix();
  wrongOverall.legs.R6.overall = 'PASS';
  assert.equal(validateSeedSnapshotMatrix(wrongOverall).ok, false);

  const wrongAttribution = syntheticMatrix();
  wrongAttribution.r3_attribution = { attribution: 'seed corruption', not_seed_corruption: false, not_validator_defect: true };
  assert.equal(validateSeedSnapshotMatrix(wrongAttribution).ok, false);

  const wrongSource = syntheticMatrix();
  wrongSource.source.retained_root_unchanged = false;
  assert.equal(validateSeedSnapshotMatrix(wrongSource).ok, false);

  const wrongHash = syntheticMatrix();
  wrongHash.copied_artifacts.snapshot.sha256 = 'c'.repeat(64);
  assert.equal(validateSeedSnapshotMatrix(wrongHash).ok, false);

  const wrongVersion = syntheticMatrix();
  wrongVersion.schema.user_version = 9;
  assert.equal(validateSeedSnapshotMatrix(wrongVersion).ok, false);

  assert.equal(validateSeedSnapshotMatrix(null).ok, false);
});

test('readPairMismatchBreakdown counts only cross-writer created_at/updated_at pairs', () => {
  const tmpdir = safeProbeTmpdir();
  const dbPath = path.join(tmpdir, 'pairs.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of ['runs', 'steps']) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT)`);
    }
    const insertRun = db.prepare('INSERT INTO runs (id, created_at, updated_at) VALUES (?, ?, ?)');
    const insertStep = db.prepare('INSERT INTO steps (id, created_at, updated_at) VALUES (?, ?, ?)');
    insertRun.run('r1', '2026-09-15T00:00:00.000Z', '2026-09-15 00:00:01');
    insertRun.run('r2', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:01.000Z');
    insertStep.run('s1', '2026-09-15T00:00:00.000Z', '2026-09-15 00:00:01');
    insertStep.run('s2', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:01.000Z');
    insertStep.run('s3', '2026-09-15T00:00:00.000Z', '2026-09-15 00:00:02');
    insertStep.run('s4', '2026-09-15T00:00:00.000Z', null);
  } finally {
    db.close();
  }
  const breakdown = readPairMismatchBreakdown(dbPath);
  assert.equal(breakdown.runs.rows_with_pair, 2);
  assert.equal(breakdown.runs.pair_mismatch_count, 1);
  assert.equal(breakdown.steps.rows_with_pair, 3);
  assert.equal(breakdown.steps.pair_mismatch_count, 2);
  assert.equal(breakdown.total_pair_mismatch_count, 3);
});

test('captureSourceIdentity records hashes/mtimes for the retained artifacts', () => {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    process.stderr.write(`no retained seed snapshot at ${SOURCE_ROOT}; skipping source-identity assertion\n`);
    return;
  }
  const identity = captureSourceIdentity(SOURCE_ROOT);
  assert.match(identity.snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.match(identity.sidecar.sha256, /^[a-f0-9]{64}$/);
  assert.ok(identity.mtimes.root.mtime_ms > 0);
  assert.ok(identity.mtimes.snapshot.mtime_ms > 0);
});

test('real O12 oracle over an owned copy of the retained seed publishes the expected matrix', async () => {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    process.stderr.write(`no retained seed snapshot at ${SOURCE_ROOT}; skipping real seed-snapshot O12 run\n`);
    return;
  }
  const resultsRoot = process.env.TAMANDUA_O12_SEED_RESULTS
    ? path.resolve(process.env.TAMANDUA_O12_SEED_RESULTS)
    : RESULTS_ROOT;
  fs.mkdirSync(resultsRoot, { recursive: true });
  const destDir = fs.mkdtempSync(path.join(resultsRoot, 'o12-seed-snapshot-'));
  const result = await runSeedSnapshotOracle({ repoRoot: path.resolve(TT_ROOT, '..'), sourceRoot: SOURCE_ROOT, destDir });

  assert.equal(result.exitCode, 1, `oracle exit must be 1 (FAIL); stderr: ${result.stderr.slice(-1000)}`);
  assert.equal(result.validation.ok, true, result.validation.problems.join('; '));
  assert.equal(result.matrix.verdict, 'EXPECTED_MATRIX');
  assert.equal(result.matrix.overall_result, 'FAIL');
  assert.equal(result.matrix.legs.R1.result, 'PASS');
  assert.equal(result.matrix.legs.R1.orphan_not_evaluable_count, 0);
  assert.equal(result.matrix.legs.R2.result, 'PASS');
  assert.equal(result.matrix.legs.R3.result, 'FAIL');
  assert.equal(result.matrix.legs.R4.result, 'PASS');
  assert.equal(result.matrix.legs.R5.result, 'PASS');
  assert.equal(result.matrix.legs.R6.overall, 'FAIL');
  assert.equal(result.matrix.schema.user_version, 10);
  assert.ok(result.matrix.schema.supported_user_versions.includes(10));

  // Exactly one evidence artifact was emitted, it is retained, and the copied
  // read-only inputs carry the source hashes.
  const evidenceFiles = fs.readdirSync(path.join(destDir, 'oracle-evidence', 'o12'))
    .flatMap((stamp) => fs.readdirSync(path.join(destDir, 'oracle-evidence', 'o12', stamp)));
  assert.deepEqual(evidenceFiles, ['o12-db-integrity.json']);
  assert.ok(fs.existsSync(result.matrixPath), 'matrix summary must be retained');
  assert.ok(fs.existsSync(result.matrix.evidence.o12_db_integrity), 'emitted evidence must be retained');
  assert.equal(result.matrix.copied_artifacts.snapshot.sha256, result.matrix.source.snapshot.sha256);
  assert.equal(result.matrix.copied_artifacts.sidecar.sha256, result.matrix.source.sidecar.sha256);
  assert.equal(result.matrix.copied_artifacts.snapshot.mode & 0o222, 0, 'copied snapshot must stay read-only');
  assert.equal(result.matrix.copied_artifacts.sidecar.mode & 0o222, 0, 'copied sidecar must stay read-only');
  assert.equal(result.matrix.source.retained_root_unchanged, true);
  assert.equal(result.matrix.source.observed_snapshot_sha256_matches_pin, true);
});

test('newest retained seed-snapshot summary validates against the expected matrix', () => {
  const resultsRoot = process.env.TAMANDUA_O12_SEED_RESULTS
    ? path.resolve(process.env.TAMANDUA_O12_SEED_RESULTS)
    : RESULTS_ROOT;
  if (!fs.existsSync(resultsRoot)) {
    process.stderr.write('no retained O12 seed-snapshot results root; skipping retained-summary assertion\n');
    return;
  }
  const candidates = fs.readdirSync(resultsRoot)
    .filter((name) => name.startsWith('o12-seed-snapshot-'))
    .map((name) => path.join(resultsRoot, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'seed-snapshot-matrix.json')))
    .sort();
  const newest = candidates.at(-1);
  if (!newest) {
    process.stderr.write('no retained O12 seed-snapshot run found; skipping retained-summary assertion\n');
    return;
  }
  const matrix = JSON.parse(fs.readFileSync(path.join(newest, 'seed-snapshot-matrix.json'), 'utf8'));
  const validation = validateSeedSnapshotMatrix(matrix);
  assert.equal(validation.ok, true, `${newest}: ${validation.problems.join('; ')}`);
  assert.equal(matrix.legs.R1.result, 'PASS');
  assert.equal(matrix.legs.R3.result, 'FAIL');
  assert.equal(matrix.overall_result, 'FAIL');
  // The retained summary names the concrete evidence artifacts.
  for (const key of ['o12_db_integrity', 'o12_stdout', 'o12_stderr', 'copied_snapshot', 'copied_sidecar']) {
    assert.ok(typeof matrix.evidence?.[key] === 'string' && matrix.evidence[key].length > 0, `evidence.${key} missing`);
  }
});

// ── owned-store acceptance (O12-SCHEMA-13 US-004) ───────────────────────────

function syntheticOwnedEvidence(entry) {
  return {
    schema_version: 1,
    oracle_id: 'O12',
    overall_result: 'PASS',
    coverage: {
      R1: {
        obligation: 'structural-integrity-orphans',
        result: 'PASS',
        integrity_check: 'ok',
        foreign_key_check_violations: 0,
        orphan_checks: Array.from({ length: 7 }, () => ({ status: 'PASS', orphan_count: 0 })),
      },
      R2: { obligation: 'run-number-uniqueness', result: 'PASS', rows_checked: 2, null_count: 0, invalid_count: 0, duplicate_number_count: 0 },
      R3: {
        obligation: 'timestamp-uniformity-instant-order', result: 'PASS',
        invalid_value_count: 0, native_format_mix_column_count: 0, pair_format_mismatch_count: 0, order_violation_count: 0,
      },
      R4: {
        obligation: 'context-json-reserved-keys', result: 'PASS', runs_checked: 2, parse_failure_count: 0, type_failure_count: 0,
        reserved_key_leg: { result: 'PASS', runs_compared: 2, keys_checked: 34, overwrite_count: 0, host_transition_matches: 0 },
      },
      R5: { obligation: 'serial-composite-state', result: 'PASS', violation_count: 0 },
      R6: { obligation: 'per-obligation-coverage', result: 'PASS', overall: 'PASS' },
    },
    observations: [
      {
        scope: 'structural',
        schema_metadata: {
          user_version: entry.user_version,
          lineage: entry.lineage,
          supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
          supported_version: true,
        },
      },
      { scope: 'timestamps', shape_histogram: {}, pair_format_mismatch_count: 0 },
    ],
  };
}

function syntheticOwnedMatrix(entry) {
  const artifacts = { snapshot: { sha256: 'a'.repeat(64) }, sidecar: { sha256: 'b'.repeat(64) } };
  return buildSeedSnapshotMatrix({
    evidenceJson: syntheticOwnedEvidence(entry),
    stdoutJson: { result: 'PASS', findings: [] },
    exitCode: 0,
    pairBreakdown: { runs: { pair_mismatch_count: 0 }, steps: { pair_mismatch_count: 0 }, total_pair_mismatch_count: 0 },
    source: { mode: 'owned-copy-ddl', snapshot: artifacts.snapshot, sidecar: artifacts.sidecar, retained_root_unchanged: null },
    invocation: { oracle: 'O12', exit_code: 0 },
    kind: 'o12-owned-store-matrix',
    r3Attribution: null,
  });
}

test('validateSeedSnapshotMatrix enforces an owned-store expectation (R1 EVALUABLE, family kind, exit code)', () => {
  const entry = ownedStoreCase('owned-store-current-v13');
  const expectation = ownedStoreExpectation(entry);
  const green = syntheticOwnedMatrix(entry);
  const ok = validateSeedSnapshotMatrix(green, expectation);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.equal(green.schema.user_version, 13);
  assert.equal(green.schema.lineage, 'current');
  assert.equal(green.r3_attribution, null, 'an owned store carries no seed R3 attribution');

  const notEvaluable = syntheticOwnedMatrix(entry);
  notEvaluable.legs.R1.result = 'NOT_EVALUABLE';
  assert.equal(validateSeedSnapshotMatrix(notEvaluable, expectation).ok, false,
    'a not-evaluable R1 must be rejected on an owned store');

  const wrongExit = syntheticOwnedMatrix(entry);
  wrongExit.exit_code = 3;
  assert.equal(validateSeedSnapshotMatrix(wrongExit, expectation).ok, false);

  const wrongKind = syntheticOwnedMatrix(entry);
  wrongKind.kind = 'o12-seed-snapshot-matrix';
  assert.equal(validateSeedSnapshotMatrix(wrongKind, expectation).ok, false);

  const wrongLineage = syntheticOwnedMatrix(entry);
  wrongLineage.schema.lineage = 'v9';
  assert.equal(validateSeedSnapshotMatrix(wrongLineage, expectation).ok, false);

  const wrongVersion = syntheticOwnedMatrix(entry);
  wrongVersion.schema.user_version = 12;
  assert.equal(validateSeedSnapshotMatrix(wrongVersion, expectation).ok, false);

  // The stale pre-O12-SCHEMA-13 supported set is no longer acceptable: the
  // matrix must report the oracle's real supported set (9..13).
  const staleSupported = syntheticOwnedMatrix(entry);
  staleSupported.schema.supported_user_versions = [9, 10];
  assert.equal(validateSeedSnapshotMatrix(staleSupported, expectation).ok, false);

  const wrongSourceMode = syntheticOwnedMatrix(entry);
  wrongSourceMode.source.mode = 'aged-state-copy';
  assert.equal(validateSeedSnapshotMatrix(wrongSourceMode, expectation).ok, false);

  const missingLeg = syntheticOwnedMatrix(entry);
  delete missingLeg.legs.R5;
  assert.equal(validateSeedSnapshotMatrix(missingLeg, expectation).ok, false);

  // A seed expectation must never accept an owned-store matrix (or vice versa).
  assert.equal(validateSeedSnapshotMatrix(syntheticOwnedMatrix(entry), SEED_SNAPSHOT_EXPECTED).ok, false);
});

test('owned-store DDL is derived from the oracle descriptors (drift guard)', () => {
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'o12-owned-store-shape.'));
  for (const entry of OWNED_STORE_CASES) {
    const storeDir = path.join(workspace, entry.id);
    const built = writeOwnedStore({ storeDir, entry });
    const descriptor = ownedStoreDescriptor(entry);
    assert.equal(built.descriptor, descriptor, `${entry.id}: the built store must use the case's descriptor`);
    assert.equal(descriptor.user_version, entry.user_version,
      `${entry.id}: the descriptor's own version must match the case`);
    assert.equal(descriptor.lineage, entry.lineage,
      `${entry.id}: the descriptor's own lineage must match the case`);
    assert.equal(built.snapshot.mode & 0o222, 0, `${entry.id}: the built snapshot must be read-only`);
    assert.equal(built.sidecar.mode & 0o222, 0, `${entry.id}: the built baseline must be read-only`);

    const database = new DatabaseSync(built.snapshotPath, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, entry.user_version,
        `${entry.id}: the store must be stamped with the case's user_version`);
      for (const [table, required] of Object.entries(descriptor.coreTables)) {
        const columns = database.prepare(`PRAGMA table_info(${table})`).all();
        assert.deepEqual(columns.map((row) => row.name), [...required],
          `${entry.id}: ${table} columns must equal the oracle descriptor's universe`);
        for (const row of columns) {
          const declared = (descriptor.columnDeclarations ?? {})[`${table}.${row.name}`];
          if (declared === undefined) continue;
          assert.equal(String(row.type).trim().toUpperCase(), String(declared.type).trim().toUpperCase(),
            `${entry.id}: ${table}.${row.name} declared type must match the chain`);
          const observedDefault = row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value);
          const expectedDefault = declared.default === null || declared.default === undefined ? null : String(declared.default);
          assert.equal(observedDefault, expectedDefault,
            `${entry.id}: ${table}.${row.name} declared default must match the chain`);
        }
      }
      // The oracle's own resolution must classify the built store as the case's
      // lineage (a v12 store by its actual discriminator columns).
      const resolved = resolveO12SchemaExpectation(database, entry.user_version);
      assert.equal(resolved.lineage, entry.lineage, `${entry.id}: the oracle must classify the store's lineage`);
      assert.equal(resolved.descriptor.user_version, entry.user_version, `${entry.id}: resolved descriptor version`);
    } finally {
      database.close();
    }

    // The baseline is a complete typed v2 over the ENTIRE reserved-key pin for
    // every run row, which is what keeps R4 evaluable.
    const baseline = JSON.parse(fs.readFileSync(built.baselinePath, 'utf8'));
    assert.equal(baseline.schema_version, 2, `${entry.id}: baseline schema_version`);
    assert.equal(baseline.producer, 'host', `${entry.id}: baseline producer`);
    assert.equal(baseline.scope.mode, 'all-snapshot-runs', `${entry.id}: baseline scope`);
    assert.deepEqual(baseline.supported_reserved_keys, [...O12_RESERVED_CONTEXT_KEYS], `${entry.id}: baseline key set`);
    const baselineRuns = Object.keys(baseline.expected);
    assert.equal(baselineRuns.length, 2, `${entry.id}: both snapshot runs must carry a baseline entry`);
    for (const runId of baselineRuns) {
      assert.equal(Object.keys(baseline.expected[runId]).length, O12_RESERVED_CONTEXT_KEYS.length,
        `${entry.id}: run ${runId} must pin every reserved key`);
    }
  }
  process.stderr.write(`owned-store shape workspace retained: ${workspace}\n`);
});

test('real O12 oracle accepts every owned store (legacy 9..12 + v13) with R1 EVALUABLE', async () => {
  const resultsRoot = process.env.TAMANDUA_O12_SEED_RESULTS
    ? path.resolve(process.env.TAMANDUA_O12_SEED_RESULTS)
    : RESULTS_ROOT;
  fs.mkdirSync(resultsRoot, { recursive: true });
  const result = await runOwnedStoreAcceptance({ repoRoot: path.resolve(TT_ROOT, '..'), resultsRoot });

  assert.equal(result.receipt.case_count, OWNED_STORE_CASES.length, 'every owned-store case must run');
  assert.equal(result.receipt.r1_evaluable_all, true, 'R1 must be EVALUABLE for every owned store');
  assert.equal(result.receipt.verdict, 'ALL_CASES_EXPECTED', JSON.stringify(result.receipt.cases, null, 2));
  assert.equal(result.ok, true);
  assert.deepEqual(result.receipt.supported_user_versions, [...O12_SUPPORTED_SCHEMA_VERSIONS]);

  const byId = Object.fromEntries(result.cases.map((record) => [record.case_id, record]));
  for (const entry of OWNED_STORE_CASES) {
    const record = byId[entry.id];
    assert.ok(record, `${entry.id}: case record missing`);
    assert.equal(record.user_version, entry.user_version, `${entry.id}: observed user_version`);
    assert.equal(record.lineage, entry.lineage, `${entry.id}: observed lineage`);
    assert.equal(record.exit_code, 0, `${entry.id}: oracle exit code (stderr in ${record.evidence.o12_stderr})`);
    assert.equal(record.overall_result, 'PASS', `${entry.id}: overall result`);
    assert.equal(record.stdout_result, 'PASS', `${entry.id}: stdout result`);
    assert.equal(record.verdict, 'EXPECTED_MATRIX', `${entry.id}: ${record.validation_problems.join('; ')}`);
    // AC: R1 is EVALUABLE (PASS or FAIL, never NOT_EVALUABLE) on legacy 9..12
    // AND on the schema-13 store.
    assert.ok(['PASS', 'FAIL'].includes(record.legs.R1), `${entry.id}: R1 must be EVALUABLE, got ${record.legs.R1}`);
    assert.equal(record.legs.R1, 'PASS', `${entry.id}: R1 must PASS on a clean owned store`);
    for (const leg of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      assert.ok(record.legs[leg], `${entry.id}: leg ${leg} missing`);
    }
    assert.deepEqual(record.findings, [], `${entry.id}: a clean store must produce no findings`);
    assert.deepEqual(record.supported_user_versions, [...O12_SUPPORTED_SCHEMA_VERSIONS],
      `${entry.id}: the matrix must report the oracle's supported set`);
    assert.ok(fs.existsSync(record.matrix_path), `${entry.id}: the per-case matrix must be retained`);
    assert.ok(fs.existsSync(record.evidence.o12_db_integrity), `${entry.id}: the emitted evidence must be retained`);

    // The v13 / Matchlock-v12 universes carry runs.matchlock_policy, so the R1
    // policy VALUE sub-check must have run there (exactly one native run and one
    // valid policy); a universe without the column records NOT_APPLICABLE.
    const evidence = JSON.parse(fs.readFileSync(record.evidence.o12_db_integrity, 'utf8'));
    const policy = evidence.coverage.R1.matchlock_policy;
    if (['owned-store-current-v13', 'owned-store-legacy-v12-matchlock'].includes(entry.id)) {
      assert.equal(policy.status, 'PASS', `${entry.id}: policy sub-check status`);
      assert.equal(policy.policies_checked, 2, `${entry.id}: policies_checked`);
      assert.equal(policy.valid_policies, 1, `${entry.id}: valid_policies`);
      assert.equal(policy.native_runs, 1, `${entry.id}: native_runs (NULL matchlock_policy)`);
      assert.equal(policy.invalid_policy_count, 0, `${entry.id}: invalid_policy_count`);
    } else {
      assert.equal(policy.status, 'NOT_APPLICABLE',
        `${entry.id}: the version universe does not carry runs.matchlock_policy`);
    }
  }

  // The v13 store's structural observation records user_version 13 AND its
  // lineage (AC), and both discriminator columns.
  const v13 = byId['owned-store-current-v13'];
  const v13Evidence = JSON.parse(fs.readFileSync(v13.evidence.o12_db_integrity, 'utf8'));
  const v13Structural = v13Evidence.observations.find((observation) => observation.scope === 'structural');
  assert.equal(v13Structural.schema_metadata.user_version, 13, 'v13 store: observed user_version');
  assert.equal(v13Structural.schema_metadata.lineage, 'current', 'v13 store: observed lineage');
  assert.deepEqual(v13Structural.schema_metadata.lineage_discriminators,
    { 'runs.matchlock_policy': true, 'steps.preclaim_death_count': true },
    'v13 store: both union discriminators must be present');

  const v12Main = byId['owned-store-legacy-v12-main'];
  const v12MainEvidence = JSON.parse(fs.readFileSync(v12Main.evidence.o12_db_integrity, 'utf8'));
  const v12MainStructural = v12MainEvidence.observations.find((observation) => observation.scope === 'structural');
  assert.equal(v12MainStructural.schema_metadata.lineage, 'main-v12', 'legacy v12 store: observed lineage');
  assert.deepEqual(v12MainStructural.schema_metadata.lineage_discriminators,
    { 'runs.matchlock_policy': false, 'steps.preclaim_death_count': true },
    'legacy v12 store: main lineage discriminator only');

  process.stderr.write(`owned-store acceptance evidence retained: ${result.acceptanceRoot}\n`);
});

test('materializeOwnedSeedSnapshots writes the flat owned seed snapshots (read-only, stamped)', () => {
  const varRoot = process.env.TAMANDUA_O12_SEED_RESULTS
    ? path.resolve(process.env.TAMANDUA_O12_SEED_RESULTS)
    : VAR_ROOT;
  fs.mkdirSync(varRoot, { recursive: true });
  const result = materializeOwnedSeedSnapshots({ varRoot });
  assert.equal(result.snapshots.length, OWNED_SEED_SNAPSHOTS.length);
  assert.ok(fs.existsSync(result.receiptPath), 'the materialization receipt must be retained');
  for (const snapshot of result.snapshots) {
    assert.ok(fs.existsSync(snapshot.path), `${snapshot.label}: flat seed snapshot missing`);
    assert.equal(path.dirname(snapshot.path), varRoot, `${snapshot.label}: must sit at the well-known flat path`);
    assert.equal(snapshot.mode & 0o222, 0, `${snapshot.label}: the flat seed snapshot must be read-only`);
    const database = new DatabaseSync(snapshot.path, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, snapshot.user_version,
        `${snapshot.label}: flat seed snapshot stamp`);
      const resolved = resolveO12SchemaExpectation(database, snapshot.user_version);
      assert.equal(resolved.lineage, snapshot.lineage, `${snapshot.label}: flat seed snapshot lineage`);
    } finally {
      database.close();
    }
  }
  const v13 = result.snapshots.find((snapshot) => snapshot.basename === 'seed-snapshot-v13.sqlite');
  assert.ok(v13, 'the v13 flat seed snapshot must be materialized');
  assert.equal(v13.user_version, 13);
});

test('newest retained owned-store acceptance validates against its recorded expectations', () => {
  const resultsRoot = process.env.TAMANDUA_O12_SEED_RESULTS
    ? path.resolve(process.env.TAMANDUA_O12_SEED_RESULTS)
    : RESULTS_ROOT;
  if (!fs.existsSync(resultsRoot)) {
    process.stderr.write('no retained results root; skipping retained owned-store assertion\n');
    return;
  }
  const candidates = fs.readdirSync(resultsRoot)
    .filter((name) => name.startsWith('o12-owned-store-acceptance-'))
    .map((name) => path.join(resultsRoot, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'owned-store-acceptance-receipt.json')))
    .sort();
  const newest = candidates.at(-1);
  if (!newest) {
    process.stderr.write('no retained owned-store acceptance run found; skipping retained assertion\n');
    return;
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(newest, 'owned-store-acceptance-receipt.json'), 'utf8'));
  assert.equal(receipt.verdict, 'ALL_CASES_EXPECTED', `${newest}: ${JSON.stringify(receipt.cases.map((c) => c.validation_problems))}`);
  assert.equal(receipt.r1_evaluable_all, true, 'the retained acceptance must show R1 EVALUABLE for every store');
  assert.equal(receipt.case_count, OWNED_STORE_CASES.length, 'the retained acceptance must cover every case');
  for (const record of receipt.cases) {
    const matrix = JSON.parse(fs.readFileSync(record.matrix_path, 'utf8'));
    const validation = validateSeedSnapshotMatrix(matrix, matrix.expectation);
    assert.equal(validation.ok, true, `${record.case_id}: ${validation.problems.join('; ')}`);
    assert.ok(['PASS', 'FAIL'].includes(matrix.legs.R1.result), `${record.case_id}: retained R1 must be EVALUABLE`);
    assert.equal(matrix.exit_code, 0, `${record.case_id}: retained exit code`);
  }
});
