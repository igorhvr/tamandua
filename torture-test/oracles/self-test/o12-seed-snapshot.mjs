#!/usr/bin/env node

// o12-seed-snapshot.mjs — Storm O12-REPIN US-004.
//
// Runs the REAL working-tree O12 oracle (`torture-test/oracles/O12`) over an
// OWNED copy of the retained immutable aged-state seed snapshot + the
// host-owned reserved-key sidecar, and publishes the per-leg R1..R6 matrix
// with exact counts.
//
// The retained seed root under /opt is READ-ONLY evidence: this runner never
// writes into it. It copies the snapshot + sidecar into a fresh, unique,
// owned evidence directory under `torture-test/var/results/`, keeps the copy
// read-only (0o444) through the run, builds the shared version-1 oracle
// invocation context (contract_version 1, `database_snapshot` reference with
// the copied snapshot's sha256, `source: 'aged-state-seed'`,
// `TT_O12_BASELINE` → the copied sidecar), invokes the oracle read-only, and
// retains the full stdout/stderr plus the emitted `o12-db-integrity.json`.
//
// Expected matrix on the RETAINED user_version-10 seed (R1 is EVALUABLE
// because this build supports every schema version 9..14,
// {9, 10, 11, 12, 13, 14}):
//   R1 PASS, R2 PASS, R3 FAIL (native TIME product finding), R4 PASS,
//   R5 PASS, R6 overall FAIL because only R3 FAILs.
//
// The R3 FAIL is the native product TIME defect (bead tamandua-6sy.31 /
// TZPI tamandua-6sy.27) — NOT seed corruption and NOT a validator defect.
//
// O12-SCHEMA-13 US-004 adds the OWNED-COPY STORE acceptance below
// (OWNED_STORE_CASES / runOwnedStoreAcceptance): stores stamped 9..13 are
// built from DDL derived from the oracle's own schema descriptors and run
// through the REAL O12 executable, so the v13 seed campaign and every legacy
// seed stay judgeable (R1 EVALUABLE) instead of degrading to NOT_EVALUABLE.
// Only the retained aged-state seed has a "copied from a read-only source"
// linkage; an owned store has no source to copy from, so its matrix records
// the built store's own identity instead.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { writeOracleContext } from '../../aged/validate.mjs';
import { sha256FileStream } from '../../aged/seedcommon.mjs';
import {
  O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
  O12_MATCHLOCK_POLICY_VERSION,
  O12_RESERVED_CONTEXT_KEYS,
  O12_SCHEMA_DESCRIPTORS,
  O12_SUPPORTED_SCHEMA_VERSIONS,
  validateO12MatchlockPolicyValue,
} from '../lib/o12.mjs';
import { o12ChildEnv, safeProbeTmpdir } from './o12-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');
const RESULTS_ROOT = path.join(TT_ROOT, 'var', 'results');

export const SEED_SNAPSHOT_BASENAME = 'db-full-post-2026-09-15T07-22-31-764Z.sqlite';
export const SEED_SIDECAR_BASENAME = 'o12-reserved-baseline.json';
export const SEED_CASE_ID = 'aged-seed-o12-postbatch';

// Retained immutable evidence (READ-ONLY). No default path is ever written to.
export const DEFAULT_SEED_ROOT = '/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/'
  + 'storm-aged.2026-09-15T05-25-19-366Z.8f48ed54.nVrXyi';

// The retained snapshot's published sha256 (aged seed evidence). The runner
// recomputes it from the source and records the observed value; this constant
// is the expected pin so a swapped source is visible.
export const SEED_SNAPSHOT_SHA256 = '3f2d098824f93abb793f63c90552700be2ca1d9e5da7f5ea0e78fb3b420934f2';

/**
 * The expected R1..R6 matrix and exact counts for the retained seed snapshot.
 * `r3_pair_breakdown` is derived read-only from the copied snapshot (the
 * marginal shape histogram cannot attribute pairs to a table).
 */
export const SEED_SNAPSHOT_EXPECTED = Object.freeze({
  kind: 'o12-seed-snapshot-matrix',
  user_version: 10,
  lineage: 'v10',
  supported_user_versions: Object.freeze([...O12_SUPPORTED_SCHEMA_VERSIONS]),
  exit_code: 1,
  r3_attribution: true,
  source_linkage: true,
  legs: Object.freeze({
    R1: Object.freeze({ result: 'PASS', integrity_check: 'ok', foreign_key_check_violations: 0, orphan_count_total: 0 }),
    R2: Object.freeze({ result: 'PASS', rows_checked: 5000, duplicate_number_count: 0 }),
    R3: Object.freeze({
      result: 'FAIL',
      invalid_value_count: 0,
      native_format_mix_column_count: 1,
      pair_format_mismatch_count: 24166,
      order_violation_count: 0,
      runs_pair_mismatch_count: 5000,
      steps_pair_mismatch_count: 19166,
      steps_updated_at_native_sqlite: 19166,
      steps_updated_at_native_iso: 7360,
      steps_updated_at_total: 26526,
    }),
    R4: Object.freeze({
      result: 'PASS',
      runs_checked: 5000,
      parse_failure_count: 0,
      type_failure_count: 0,
      keys_checked: 85000,
      overwrite_count: 0,
      host_transition_matches: 150,
    }),
    R5: Object.freeze({ result: 'PASS', violation_count: 0 }),
    R6: Object.freeze({ result: 'PASS', overall: 'FAIL' }),
  }),
  overall_result: 'FAIL',
});

/** The plain-language attribution recorded with the matrix. */
export const SEED_SNAPSHOT_R3_ATTRIBUTION = Object.freeze({
  finding: 'R3 timestamp-uniformity-instant-order FAILs',
  attribution: 'native product TIME defect (bead tamandua-6sy.31 / TZPI tamandua-6sy.27)',
  not_seed_corruption: true,
  not_validator_defect: true,
  detail: 'product createRun/step-ops write created_at as ISO-8601 while updated_at uses SQLite-native '
    + "'YYYY-MM-DD HH:MM:SS'; the snapshot is internally consistent (R1/R2/R4/R5 PASS) and only the "
    + 'cross-writer timestamp shape leg fails.',
  r1_evaluable: 'R1 is EVALUABLE on the retained user_version-10 seed because this O12 build supports every schema version 9..14 '
    + '({9, 10, 11, 12, 13, 14}); the prior schema-9-only build reported R1 NOT_EVALUABLE.',
});

// The two product native writers O12 classifies; mirrored here so the
// per-table pair breakdown uses exactly the oracle's shape predicates.
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQLITE_NAIVE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function isNativeIso(value) {
  return typeof value === 'string' && CANONICAL_ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isNativeSqlite(value) {
  return typeof value === 'string' && SQLITE_NAIVE_RE.test(value);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function statIdentity(target) {
  const stat = fs.statSync(target);
  return {
    path: target,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    mode: stat.mode & 0o777,
  };
}

function relativeIdentity(before, after) {
  return {
    path_unchanged: before.path === after.path,
    mtime_unchanged: before.mtime_ms === after.mtime_ms,
    ctime_unchanged: before.ctime_ms === after.ctime_ms,
    size_unchanged: before.size === after.size,
    ...after,
  };
}

/**
 * Count, per table, the rows whose (created_at, updated_at) pair uses two
 * different native writers. This mirrors O12's R3 pair predicate and is the
 * supplementary read-only breakdown the marginal shape histogram cannot give.
 * The snapshot is opened read-only and never mutated.
 */
export function readPairMismatchBreakdown(snapshotPath) {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  const breakdown = {};
  try {
    for (const table of ['runs', 'steps']) {
      const rows = db.prepare(
        `SELECT id AS row_id, created_at AS earlier_value, updated_at AS later_value FROM ${table}`
        + ' WHERE created_at IS NOT NULL AND updated_at IS NOT NULL',
      ).all();
      let count = 0;
      for (const row of rows) {
        const earlierIso = isNativeIso(row.earlier_value);
        const earlierSqlite = isNativeSqlite(row.earlier_value);
        const laterIso = isNativeIso(row.later_value);
        const laterSqlite = isNativeSqlite(row.later_value);
        if ((earlierIso && laterSqlite) || (earlierSqlite && laterIso)) count += 1;
      }
      breakdown[table] = { rows_with_pair: rows.length, pair_mismatch_count: count };
    }
  } finally {
    db.close();
  }
  breakdown.total_pair_mismatch_count = breakdown.runs.pair_mismatch_count + breakdown.steps.pair_mismatch_count;
  return breakdown;
}

function scopeObservation(evidenceJson, scope) {
  return (evidenceJson.observations ?? []).find((entry) => entry.scope === scope) ?? null;
}

/**
 * Shape the emitted `o12-db-integrity.json` + stdout JSON + the supplementary
 * pair breakdown into the published R1..R6 matrix. Pure: no I/O.
 *
 * `kind` selects the matrix family: `o12-seed-snapshot-matrix` (the retained
 * aged-state seed copy) or `o12-owned-store-matrix` (an owned store built from
 * DDL for the store-acceptance cases); `r3Attribution` is the seed's
 * attribution record and is null for an owned store.
 */
export function buildSeedSnapshotMatrix({
  evidenceJson, stdoutJson, exitCode, signal = null, pairBreakdown = null,
  copied = null, source = null, invocation = null,
  kind = 'o12-seed-snapshot-matrix', r3Attribution = SEED_SNAPSHOT_R3_ATTRIBUTION,
}) {
  if (!evidenceJson || typeof evidenceJson !== 'object') throw new Error('evidenceJson is required');
  const coverage = evidenceJson.coverage ?? {};
  const structural = scopeObservation(evidenceJson, 'structural');
  const timestamps = scopeObservation(evidenceJson, 'timestamps');
  const histogram = timestamps?.shape_histogram ?? {};
  const schemaMetadata = structural?.schema_metadata ?? {};

  const r1 = coverage.R1 ?? {};
  const orphanChecks = r1.orphan_checks ?? [];
  const orphanCountTotal = orphanChecks.reduce((sum, check) => sum + (check.orphan_count ?? 0), 0);
  const orphanNotEvaluable = orphanChecks.filter((check) => check.status === 'NOT_EVALUABLE').length;

  const r2 = coverage.R2 ?? {};
  const r3 = coverage.R3 ?? {};
  const r4 = coverage.R4 ?? {};
  const r4Reserved = r4.reserved_key_leg ?? {};
  const r5 = coverage.R5 ?? {};
  const r6 = coverage.R6 ?? {};

  const stepsUpdated = histogram['steps.updated_at'] ?? {};
  const legs = {
    R1: {
      obligation: r1.obligation ?? 'structural-integrity-orphans',
      result: r1.result ?? null,
      integrity_check: r1.integrity_check ?? null,
      foreign_key_check_violations: r1.foreign_key_check_violations ?? null,
      orphan_probe_count: orphanChecks.length,
      orphan_count_total: orphanCountTotal,
      orphan_not_evaluable_count: orphanNotEvaluable,
    },
    R2: {
      obligation: r2.obligation ?? 'run-number-uniqueness',
      result: r2.result ?? null,
      rows_checked: r2.rows_checked ?? null,
      null_count: r2.null_count ?? null,
      invalid_count: r2.invalid_count ?? null,
      duplicate_number_count: r2.duplicate_number_count ?? null,
    },
    R3: {
      obligation: r3.obligation ?? 'timestamp-uniformity-instant-order',
      result: r3.result ?? null,
      invalid_value_count: r3.invalid_value_count ?? null,
      native_format_mix_column_count: r3.native_format_mix_column_count ?? null,
      pair_format_mismatch_count: r3.pair_format_mismatch_count ?? null,
      order_violation_count: r3.order_violation_count ?? null,
      runs_pair_mismatch_count: pairBreakdown?.runs?.pair_mismatch_count ?? null,
      steps_pair_mismatch_count: pairBreakdown?.steps?.pair_mismatch_count ?? null,
      steps_updated_at_native_sqlite: stepsUpdated['native-sqlite'] ?? 0,
      steps_updated_at_native_iso: stepsUpdated['native-iso'] ?? 0,
      steps_updated_at_total: Object.values(stepsUpdated).reduce((sum, count) => sum + count, 0),
    },
    R4: {
      obligation: r4.obligation ?? 'context-json-reserved-keys',
      result: r4.result ?? null,
      runs_checked: r4.runs_checked ?? null,
      parse_failure_count: r4.parse_failure_count ?? null,
      type_failure_count: r4.type_failure_count ?? null,
      keys_checked: r4Reserved.keys_checked ?? null,
      overwrite_count: r4Reserved.overwrite_count ?? null,
      host_transition_matches: r4Reserved.host_transition_matches ?? null,
      runs_compared: r4Reserved.runs_compared ?? null,
    },
    R5: {
      obligation: r5.obligation ?? 'serial-composite-state',
      result: r5.result ?? null,
      violation_count: r5.violation_count ?? null,
    },
    R6: {
      obligation: r6.obligation ?? 'per-obligation-coverage',
      result: r6.result ?? null,
      overall: r6.overall ?? evidenceJson.overall_result ?? null,
    },
  };

  const findings = (stdoutJson?.findings ?? []).map((finding) => finding.id);
  return {
    kind,
    contract_version: 1,
    generated_at: new Date().toISOString(),
    oracle: 'O12',
    source: source ?? null,
    copied_artifacts: copied ?? null,
    invocation: invocation ?? null,
    schema: {
      user_version: schemaMetadata.user_version ?? null,
      lineage: schemaMetadata.lineage ?? null,
      lineage_discriminators: schemaMetadata.lineage_discriminators ?? null,
      supported_user_versions: schemaMetadata.supported_user_versions ?? null,
      supported_version: schemaMetadata.supported_version ?? null,
      tables: schemaMetadata.tables ?? null,
      required_columns: schemaMetadata.core_columns ?? null,
    },
    legs,
    matrix: Object.entries(legs).map(([leg, record]) => ({ leg, result: record.result, counts: record })),
    overall_result: evidenceJson.overall_result ?? null,
    stdout_result: stdoutJson?.result ?? null,
    exit_code: exitCode,
    signal,
    finding_ids: findings,
    r3_attribution: r3Attribution,
  };
}

/**
 * Validate the published matrix against an expectation record. Returns
 * `{ ok, problems }`; never throws.
 *
 * The default expectation is the RETAINED aged-state seed's exact matrix
 * (user_version 10, exact per-leg counts, exit 1). An owned-store acceptance
 * case passes its own expectation (ownedStoreExpectation): the version/lineage
 * that store was built for, an EVALUABLE R1 (PASS or FAIL, never
 * NOT_EVALUABLE) and the family's own `kind`.
 *
 * Version rules that hold for EVERY family: the matrix's
 * `supported_user_versions` must equal the oracle's own supported set
 * (9..14 as of O12-SCHEMA-14), and the recorded `user_version` must be a
 * member of it — a matrix can never claim support for a version the oracle
 * does not carry, nor report a stamp outside the supported set.
 */
export function validateSeedSnapshotMatrix(matrix, expected = SEED_SNAPSHOT_EXPECTED) {
  const problems = [];
  if (!matrix || typeof matrix !== 'object') return { ok: false, problems: ['matrix is not an object'] };
  if (matrix.kind !== (expected.kind ?? 'o12-seed-snapshot-matrix')) {
    problems.push(`matrix.kind must be ${expected.kind ?? 'o12-seed-snapshot-matrix'} (got ${JSON.stringify(matrix.kind)})`);
  }
  const supported = [...O12_SUPPORTED_SCHEMA_VERSIONS];
  const observedSupported = Array.isArray(matrix.schema?.supported_user_versions)
    ? matrix.schema.supported_user_versions
    : null;
  if (observedSupported === null || observedSupported.join(',') !== supported.join(',')) {
    problems.push(`schema.supported_user_versions ${JSON.stringify(observedSupported)} must equal the oracle's supported set ${JSON.stringify(supported)}`);
  }
  if (expected.user_version !== undefined) {
    if (matrix.schema?.user_version !== expected.user_version) {
      problems.push(`schema.user_version ${matrix.schema?.user_version} !== ${expected.user_version}`);
    }
  } else if (!supported.includes(matrix.schema?.user_version)) {
    problems.push(`schema.user_version ${matrix.schema?.user_version} is not a member of the supported set ${JSON.stringify(supported)}`);
  }
  if (expected.lineage !== undefined && matrix.schema?.lineage !== expected.lineage) {
    problems.push(`schema.lineage ${JSON.stringify(matrix.schema?.lineage)} !== ${JSON.stringify(expected.lineage)}`);
  }
  if (expected.overall_result !== undefined && matrix.overall_result !== expected.overall_result) {
    problems.push(`overall_result ${matrix.overall_result} !== ${expected.overall_result}`);
  }
  if (expected.overall_result !== undefined && matrix.stdout_result !== expected.overall_result) {
    problems.push(`stdout_result ${matrix.stdout_result} !== ${expected.overall_result}`);
  }
  for (const [leg, expectedLeg] of Object.entries(expected.legs ?? {})) {
    const observed = matrix.legs?.[leg];
    if (!observed) {
      problems.push(`leg missing: ${leg}`);
      continue;
    }
    for (const [field, value] of Object.entries(expectedLeg)) {
      if (observed[field] !== value) {
        problems.push(`${leg}.${field}: ${JSON.stringify(observed[field])} !== expected ${JSON.stringify(value)}`);
      }
    }
  }
  // Every leg of the R1..R6 shape must be recorded. R1 has one extra rule for
  // every family: it is EVALUABLE (PASS or FAIL) — NOT_EVALUABLE would mean the
  // store's schema was never judged.
  for (const leg of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    const observed = matrix.legs?.[leg];
    if (!observed) {
      if (expected.legs?.[leg] === undefined) problems.push(`leg missing: ${leg}`);
      continue;
    }
    if (leg === 'R1' && !['PASS', 'FAIL'].includes(observed.result)) {
      problems.push(`R1.result ${JSON.stringify(observed.result)} must be EVALUABLE (PASS or FAIL), never NOT_EVALUABLE`);
    }
    if (expected.r1_result !== undefined && leg === 'R1' && observed.result !== expected.r1_result) {
      problems.push(`R1.result ${JSON.stringify(observed.result)} !== ${expected.r1_result}`);
    }
  }
  if (expected.r3_attribution === true) {
    const attribution = matrix.r3_attribution ?? {};
    if (attribution.not_seed_corruption !== true || attribution.not_validator_defect !== true) {
      problems.push('r3_attribution must state the R3 FAIL is neither seed corruption nor a validator defect');
    }
    if (!String(attribution.attribution ?? '').includes('TIME')) {
      problems.push('r3_attribution must name the native product TIME defect');
    }
    if (!String(attribution.r1_evaluable ?? '').includes('9, 10, 11, 12, 13, 14')) {
      problems.push('r3_attribution.r1_evaluable must name the full supported set {9, 10, 11, 12, 13, 14}');
    }
  }
  if (expected.source_linkage === true) {
    if (matrix.copied_artifacts?.snapshot?.sha256 !== matrix.source?.snapshot?.sha256) {
      problems.push('copied snapshot sha256 must equal the source snapshot sha256');
    }
    if (matrix.copied_artifacts?.sidecar?.sha256 !== matrix.source?.sidecar?.sha256) {
      problems.push('copied sidecar sha256 must equal the source sidecar sha256');
    }
    if (matrix.source?.retained_root_unchanged !== true) {
      problems.push('source.retained_root_unchanged must be true');
    }
  }
  if (expected.source_mode !== undefined && matrix.source?.mode !== expected.source_mode) {
    problems.push(`source.mode ${JSON.stringify(matrix.source?.mode)} !== ${JSON.stringify(expected.source_mode)}`);
  }
  if (expected.exit_code !== undefined && matrix.exit_code !== expected.exit_code) {
    problems.push(`oracle exit_code ${matrix.exit_code} !== ${expected.exit_code}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Hash + stat identity for the read-only source artifacts. */
export function captureSourceIdentity(sourceRoot) {
  const snapshotPath = path.join(sourceRoot, 'evidence', SEED_SNAPSHOT_BASENAME);
  const sidecarPath = path.join(sourceRoot, 'evidence', SEED_SIDECAR_BASENAME);
  const rootStat = statIdentity(sourceRoot);
  const evidenceStat = statIdentity(path.join(sourceRoot, 'evidence'));
  const snapshotStat = statIdentity(snapshotPath);
  const sidecarStat = statIdentity(sidecarPath);
  return {
    root: sourceRoot,
    snapshot: { basename: SEED_SNAPSHOT_BASENAME, sha256: sha256FileStream(snapshotPath), bytes: snapshotStat.size, mode: snapshotStat.mode },
    sidecar: { basename: SEED_SIDECAR_BASENAME, sha256: sha256FileStream(sidecarPath), bytes: sidecarStat.size, mode: sidecarStat.mode },
    mtimes: { root: rootStat, evidence: evidenceStat, snapshot: snapshotStat, sidecar: sidecarStat },
  };
}

/**
 * Run the real working-tree O12 oracle over an owned copy of the retained
 * snapshot. Writes every artifact under `destDir`; nothing is ever written
 * into the source root.
 */
export function runSeedSnapshotOracle({ repoRoot, sourceRoot, destDir, pairBreakdownFn = readPairMismatchBreakdown }) {
  fs.mkdirSync(destDir, { recursive: true });
  const before = captureSourceIdentity(sourceRoot);

  const evidenceDir = path.join(destDir, 'copied-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const snapshotCopy = path.join(evidenceDir, SEED_SNAPSHOT_BASENAME);
  const sidecarCopy = path.join(evidenceDir, SEED_SIDECAR_BASENAME);
  fs.copyFileSync(path.join(sourceRoot, 'evidence', SEED_SNAPSHOT_BASENAME), snapshotCopy);
  fs.copyFileSync(path.join(sourceRoot, 'evidence', SEED_SIDECAR_BASENAME), sidecarCopy);
  // Keep the copy read-only through the whole run: the O12 context validator
  // refuses a writable database_snapshot and a writable reserved-key baseline.
  fs.chmodSync(snapshotCopy, 0o444);
  fs.chmodSync(sidecarCopy, 0o444);

  const campaignId = path.basename(destDir);
  // The oracle context loader discovers the campaign root by walking up to a
  // directory containing state.json; the owned copy root is that results dir.
  fs.writeFileSync(path.join(destDir, 'state.json'), `${JSON.stringify({ campaign: campaignId, kind: 'aged-state-seed' }, null, 2)}\n`, 'utf-8');

  const pairBreakdown = pairBreakdownFn(snapshotCopy);

  return (async () => {
    const context = await writeOracleContext({
      seedRoot: destDir,
      oracleId: 'O12',
      caseId: SEED_CASE_ID,
      campaignId,
      snapshot: snapshotCopy,
      importedOracleDir: repoRoot,
    });
    const contextPath = path.join(destDir, 'oracle-context-O12.json');
    const runEvidenceDir = path.join(destDir, 'oracle-evidence', 'o12', timestamp());
    fs.mkdirSync(runEvidenceDir, { recursive: true });

    const env = {
      ...o12ChildEnv({ tmpdir: safeProbeTmpdir() }),
      TT_ORACLE_CONTRACT_VERSION: '1',
      TT_ORACLE_ID: 'O12',
      TT_ORACLE_CONTEXT: contextPath,
      TT_ORACLE_EVIDENCE_DIR: runEvidenceDir,
      TT_CASE_ID: SEED_CASE_ID,
      TT_CAMPAIGN_ID: campaignId,
      TT_O12_BASELINE: sidecarCopy,
    };
    // TT_RUN_ID must be absent (the aged-state context has run_id null).
    delete env.TT_RUN_ID;

    const entry = path.join(repoRoot, 'torture-test', 'oracles', 'O12');
    const startedAt = new Date().toISOString();
    const res = spawnSync(process.execPath, [entry, '--contract-version', '1', '--context', contextPath], {
      env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    });
    const finishedAt = new Date().toISOString();

    fs.writeFileSync(path.join(destDir, 'o12.stdout.log'), res.stdout ?? '');
    fs.writeFileSync(path.join(destDir, 'o12.stderr.log'), res.stderr ?? '');

    let stdoutJson = null;
    try {
      stdoutJson = JSON.parse((res.stdout ?? '').trim());
    } catch {
      stdoutJson = null;
    }

    const evidenceFile = path.join(runEvidenceDir, 'o12-db-integrity.json');
    const evidenceJson = fs.existsSync(evidenceFile)
      ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
      : null;

    // Re-verify the read-only source is untouched AFTER the run.
    const after = captureSourceIdentity(sourceRoot);
    const retainedRootUnchanged = before.snapshot.sha256 === after.snapshot.sha256
      && before.sidecar.sha256 === after.sidecar.sha256
      && before.mtimes.root.mtime_ms === after.mtimes.root.mtime_ms
      && before.mtimes.evidence.mtime_ms === after.mtimes.evidence.mtime_ms
      && before.mtimes.snapshot.mtime_ms === after.mtimes.snapshot.mtime_ms
      && before.mtimes.sidecar.mtime_ms === after.mtimes.sidecar.mtime_ms;

    const copied = {
      snapshot: { path: snapshotCopy, basename: SEED_SNAPSHOT_BASENAME, sha256: sha256FileStream(snapshotCopy), bytes: fs.statSync(snapshotCopy).size, mode: fs.statSync(snapshotCopy).mode & 0o777 },
      sidecar: { path: sidecarCopy, basename: SEED_SIDECAR_BASENAME, sha256: sha256FileStream(sidecarCopy), bytes: fs.statSync(sidecarCopy).size, mode: fs.statSync(sidecarCopy).mode & 0o777 },
    };
    const source = {
      root: sourceRoot,
      snapshot: before.snapshot,
      sidecar: before.sidecar,
      retained_root_unchanged: retainedRootUnchanged,
      observed_snapshot_sha256_matches_pin: before.snapshot.sha256 === SEED_SNAPSHOT_SHA256,
      mtimes_before: before.mtimes,
      mtimes_after: {
        root: relativeIdentity(before.mtimes.root, after.mtimes.root),
        evidence: relativeIdentity(before.mtimes.evidence, after.mtimes.evidence),
        snapshot: relativeIdentity(before.mtimes.snapshot, after.mtimes.snapshot),
        sidecar: relativeIdentity(before.mtimes.sidecar, after.mtimes.sidecar),
      },
    };
    const invocation = {
      oracle: 'O12',
      entry,
      contract_version: 1,
      case_id: SEED_CASE_ID,
      campaign_id: campaignId,
      context_path: contextPath,
      context_database_reference: context.mechanical_evidence.references.database_snapshot,
      evidence_dir: runEvidenceDir,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: res.status,
      signal: res.signal ?? null,
      baseline: { path: sidecarCopy, sha256: copied.sidecar.sha256 },
      env: {
        TAMANDUA_TEST_GUARD: env.TAMANDUA_TEST_GUARD,
        TAMANDUA_PI_BINARY: env.TAMANDUA_PI_BINARY,
        TAMANDUA_HERMES_BINARY: env.TAMANDUA_HERMES_BINARY,
        TAMANDUA_DSH_BINARY: env.TAMANDUA_DSH_BINARY,
        TT_RUN_ID_absent: env.TT_RUN_ID === undefined,
      },
    };

    const matrix = buildSeedSnapshotMatrix({ evidenceJson, stdoutJson, exitCode: res.status, signal: res.signal ?? null, pairBreakdown, copied, source, invocation });
    const validation = validateSeedSnapshotMatrix(matrix);
    matrix.validation = validation;
    matrix.verdict = validation.ok ? 'EXPECTED_MATRIX' : 'UNEXPECTED_MATRIX';
    matrix.evidence = {
      o12_db_integrity: evidenceFile,
      o12_stdout: path.join(destDir, 'o12.stdout.log'),
      o12_stderr: path.join(destDir, 'o12.stderr.log'),
      copied_snapshot: snapshotCopy,
      copied_sidecar: sidecarCopy,
    };

    const matrixPath = path.join(destDir, 'seed-snapshot-matrix.json');
    fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf-8');
    const receiptPath = path.join(destDir, 'seed-snapshot-receipt.json');
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      kind: 'o12-seed-snapshot-receipt',
      generated_at: new Date().toISOString(),
      dest_dir: destDir,
      source_root: sourceRoot,
      matrix_path: matrixPath,
      contract_version: 1,
      source: source,
      copied_artifacts: copied,
      invocation,
      evidence: matrix.evidence,
    }, null, 2)}\n`, 'utf-8');

    return { destDir, matrixPath, receiptPath, matrix, validation, evidenceJson, stdoutJson, exitCode: res.status, stderr: res.stderr ?? '' };
  })();
}

// ── owned-copy store acceptance (O12-SCHEMA-13 US-004) ─────────────────────
//
// The seed campaign is regenerated on the current product build (schema 13),
// while older seeds stay stamped 9..12. The oracle must judge ALL of them with
// R1 EVALUABLE: a store whose stamp is outside the supported set — or whose
// column universe its version number does not promise — degrades the whole
// seed gate to NOT_EVALUABLE.
//
// Every case below therefore builds an OWNED store (never a copy of a host
// path, which does not exist inside the Matchlock VM) from DDL derived from
// the ORACLE'S OWN schema descriptors: the table/column universes come from
// `coreTables`, and every version-added column carries the chain's declared
// type/default from `columnDeclarations`. Nothing about a store's shape is
// retyped here, so an oracle descriptor change moves the stores with it — and
// the drift guard in o12-seed-snapshot.test.mjs compares the BUILT store's real
// PRAGMA columns against the resolved descriptor, so a divergence fails loudly
// instead of silently judging a universe the oracle no longer promises.

const OWNED_STORE_T = '2026-08-01T12:00:00.000Z';
const OWNED_STORE_REMOVED = '2026-08-01T12:00:05.000Z';
const OWNED_RUN1 = '11111111-1111-4111-8111-111111111111';
const OWNED_RUN2 = '22222222-2222-4222-8222-222222222222';
const OWNED_STEP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNED_STEP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNED_STORY1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNED_STORE_HOST_ROOT = '/synthetic/owned-store-host';

/**
 * The owned-store acceptance cases: one per supported version and per v12
 * lineage. `lineage` is the lineage the oracle's structural observation must
 * report for the store (the oracle's own descriptor lineage: v9/v10/v11 for
 * the plain versions, the classified v12 lineage, `current` for v13).
 */
export const OWNED_STORE_CASES = Object.freeze([
  Object.freeze({ id: 'owned-store-legacy-v9', user_version: 9, lineage: 'v9', lineage_key: null, policy_row: false }),
  Object.freeze({ id: 'owned-store-legacy-v10', user_version: 10, lineage: 'v10', lineage_key: null, policy_row: false }),
  Object.freeze({ id: 'owned-store-legacy-v11', user_version: 11, lineage: 'v11', lineage_key: null, policy_row: false }),
  Object.freeze({ id: 'owned-store-legacy-v12-main', user_version: 12, lineage: 'main-v12', lineage_key: 'main-v12', policy_row: false }),
  Object.freeze({ id: 'owned-store-legacy-v12-matchlock', user_version: 12, lineage: 'matchlock-v12', lineage_key: 'matchlock-v12', policy_row: true }),
  Object.freeze({ id: 'owned-store-current-v13', user_version: 13, lineage: 'current', lineage_key: null, policy_row: true }),
]);

/** The owned-store case record for `caseId`; throws on an unknown case. */
export function ownedStoreCase(caseId) {
  const entry = OWNED_STORE_CASES.find((candidate) => candidate.id === caseId);
  if (entry === undefined) {
    throw new Error(`unknown owned-store case ${JSON.stringify(caseId)}; known cases: ${OWNED_STORE_CASES.map((c) => c.id).join(', ')}`);
  }
  return entry;
}

/**
 * The oracle descriptor the owned store for `entry` is built against. A v12
 * stamp is lineage-dependent, so the case names the pre-union lineage it
 * stands for and the descriptor is taken from the oracle's own lineage map.
 */
export function ownedStoreDescriptor(entry) {
  const declared = O12_SCHEMA_DESCRIPTORS[entry.user_version];
  if (declared === undefined) throw new Error(`no O12 schema descriptor for user_version ${entry.user_version}`);
  return entry.lineage_key === null ? declared : declared.lineages[entry.lineage_key];
}

// A complete, valid Matchlock execution-isolation policy for the runs that sit
// in a policy-carrying universe (v12-Matchlock, v13). Built from the oracle's
// own required-key set and SELF-CHECKED at module load with the oracle's own
// judge, so a store claiming a valid policy can never silently become an
// invalid one (which would flip its acceptance from PASS to FAIL).
function ownedStorePolicy() {
  return {
    version: O12_MATCHLOCK_POLICY_VERSION,
    backend: 'matchlock',
    requestedImage: 'ghcr.io/tetradactyla/matchlock-dev:2026-09',
    resolvedImageDigest: `sha256:${'a'.repeat(64)}`,
    resolvedImageConfigDigest: `sha256:${'b'.repeat(64)}`,
    harness: 'pi',
    configurationRoot: `${OWNED_STORE_HOST_ROOT}/config/agent`,
    configurationProfile: 'settings.json',
    guestConfigurationRoot: '/workspace/config/pi',
    workPathMode: 'host-absolute',
    workingDirectory: `${OWNED_STORE_HOST_ROOT}/worktree`,
    workMounts: [{
      hostPath: `${OWNED_STORE_HOST_ROOT}/worktree`,
      hostRealPath: `${OWNED_STORE_HOST_ROOT}/worktree`,
      guestPath: `${OWNED_STORE_HOST_ROOT}/worktree`,
    }],
    originalRepositoryRoot: `${OWNED_STORE_HOST_ROOT}/origin`,
    gitMetadataRoots: [`${OWNED_STORE_HOST_ROOT}/origin/.git`],
    mountPolicyVersion: 1,
    networkPolicyVersion: 1,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
  };
}

/** The valid policy JSON the policy-carrying owned stores carry on one row. */
export const OWNED_STORE_VALID_POLICY = JSON.stringify(ownedStorePolicy());

{
  const policy = ownedStorePolicy();
  const keys = Object.keys(policy);
  const missing = O12_MATCHLOCK_POLICY_REQUIRED_KEYS.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !O12_MATCHLOCK_POLICY_REQUIRED_KEYS.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`the owned store's valid policy must carry exactly the oracle's required key set (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`);
  }
  const verdict = validateO12MatchlockPolicyValue(OWNED_STORE_VALID_POLICY);
  if (verdict.status !== 'valid') {
    throw new Error(`the owned store's valid policy is judged invalid by the oracle: ${verdict.errors.join('; ')}`);
  }
}

// The dependent tables the oracle's orphan matrix probes (run_worktrees.run_id,
// story_abandonments.run_id/.story_id, suite_results.run_id) plus the two
// remaining product tables, so an owned store is a complete store rather than
// a three-table stub. Their columns are not version-dependent.
const OWNED_STORE_DEPENDENT_DDL = `CREATE TABLE story_abandonments (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL, run_id TEXT NOT NULL, reason TEXT NOT NULL,
  abandoned_count INTEGER NOT NULL, step_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE run_worktrees (
  run_id TEXT PRIMARY KEY, worktree_origin_repository TEXT NOT NULL,
  worktree_origin_git_common_dir TEXT NOT NULL, worktree_path TEXT NOT NULL,
  worktree_origin_ref TEXT, worktree_origin_sha TEXT, original_branch TEXT,
  status TEXT NOT NULL DEFAULT 'creating', cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
  created_at TEXT NOT NULL, removed_at TEXT, error TEXT);
CREATE TABLE suite_results (
  id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL,
  cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE autoresearch_sessions (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, goal TEXT, metric_name TEXT, metric_unit TEXT,
  direction TEXT, command TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, last_run_at TEXT, total_runs INTEGER NOT NULL DEFAULT 0,
  baseline_metric REAL, best_metric REAL, best_run INTEGER, files_missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), system_tokens_spent INTEGER NOT NULL DEFAULT 0);
`;

// One column's declaration. The id columns are primary keys; a version-added
// column carries the chain's declared type/default; everything else is a plain
// TEXT/INTEGER column (the oracle only judges the DECLARED shape of the
// columns a version adds).
function ownedStoreColumnSql(table, column, descriptor) {
  if (column === 'id') return 'id TEXT PRIMARY KEY';
  const declared = (descriptor.columnDeclarations ?? {})[`${table}.${column}`];
  if (declared !== undefined) {
    const defaultSql = declared.default === null || declared.default === undefined ? '' : ` DEFAULT ${declared.default}`;
    return `${column} ${declared.type}${defaultSql}`;
  }
  if (column === 'run_number') return `${column} INTEGER`;
  return `${column} TEXT`;
}

/** The complete DDL for the owned store of `entry` (schema 9..13). */
export function ownedStoreDdl(entry) {
  const descriptor = ownedStoreDescriptor(entry);
  const table = (name) => `CREATE TABLE ${name} (\n  ${descriptor.coreTables[name]
    .map((column) => ownedStoreColumnSql(name, column, descriptor)).join(',\n  ')}\n);\n`;
  return `${table('runs')}${table('steps')}${table('stories')}${OWNED_STORE_DEPENDENT_DDL}PRAGMA user_version = ${descriptor.user_version};\n`;
}

function ownedInsertRun(db, { id, runNumber, context, policyValue = undefined }) {
  const columns = ['id', 'run_number', 'workflow_id', 'status', 'context', 'tokens_spent', 'created_at', 'updated_at'];
  const values = [id, runNumber, 'wf', 'completed', context, 0, OWNED_STORE_T, OWNED_STORE_T];
  if (policyValue !== undefined) {
    columns.push('matchlock_policy');
    values.push(policyValue);
  }
  db.prepare(`INSERT INTO runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
}

function ownedInsertStep(db, { id, runId, stepId }) {
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status, output, type, loop_config,
       current_story_id, created_at, updated_at)
     VALUES (?, ?, ?, 'wf_agent', 0, 'done', NULL, 'single', NULL, NULL, ?, ?)`,
  ).run(id, runId, stepId, OWNED_STORE_T, OWNED_STORE_T);
}

/**
 * The complete typed v2 reserved-key baseline for an owned store: every run
 * row carries host-captured typed presence/absence over the ENTIRE reserved
 * key pin, which is what keeps the R4 reserved-key leg PASS (an absent
 * baseline would make the whole store NOT_EVALUABLE).
 */
export function ownedStoreReservedBaseline() {
  const entryFor = (presentValues) => Object.fromEntries(O12_RESERVED_CONTEXT_KEYS.map((key) => [key,
    Object.prototype.hasOwnProperty.call(presentValues, key)
      ? { presence: 'present', value: presentValues[key], provenance: 'host' }
      : { presence: 'absent', provenance: 'host' }]));
  return {
    schema_version: 2,
    captured_at: OWNED_STORE_REMOVED,
    producer: 'host',
    scope: { mode: 'all-snapshot-runs' },
    supported_reserved_keys: [...O12_RESERVED_CONTEXT_KEYS],
    expected: {
      [OWNED_RUN1]: entryFor({ repo: OWNED_STORE_HOST_ROOT, run_id: OWNED_RUN1 }),
      [OWNED_RUN2]: entryFor({}),
    },
    expected_mutations: {},
  };
}

/**
 * Write the owned store of `entry` under `storeDir`: the read-only snapshot,
 * the read-only reserved-key baseline, the campaign marker and the rest of a
 * complete product store. Returns the built artifact identities. Existing
 * files are overwritten (the caller owns `storeDir`).
 */
export function writeOwnedStore({ storeDir, entry }) {
  const descriptor = ownedStoreDescriptor(entry);
  const snapshotsDir = path.join(storeDir, 'snapshots');
  const evidenceDir = path.join(storeDir, 'evidence');
  fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(storeDir, 'state.json'),
    `${JSON.stringify({ campaign: path.basename(storeDir), kind: 'owned-store' }, null, 2)}\n`, 'utf-8');

  const snapshotPath = path.join(snapshotsDir, 'database.sqlite');
  const baselinePath = path.join(evidenceDir, SEED_SIDECAR_BASENAME);
  // Idempotent rebuild: a previous build leaves both artifacts read-only, so
  // this exact owned pair is replaced before the store is written. Never a
  // glob/recursive removal.
  fs.rmSync(snapshotPath, { force: true });
  fs.rmSync(baselinePath, { force: true });
  const hasPolicyColumn = (descriptor.coreTables.runs ?? []).includes('matchlock_policy');
  const database = new DatabaseSync(snapshotPath);
  try {
    database.exec(ownedStoreDdl(entry));
    // RUN1: a native run (matchlock_policy NULL where the universe carries the
    // column) with a host-captured reserved key; RUN2: the policy-carrying row
    // where the universe has the column, and a run with an empty context
    // otherwise. Both are 'completed', so the R5 serial-composite leg judges
    // no live run.
    ownedInsertRun(database, {
      id: OWNED_RUN1,
      runNumber: 1,
      context: JSON.stringify({ repo: OWNED_STORE_HOST_ROOT, run_id: OWNED_RUN1 }),
      policyValue: hasPolicyColumn ? null : undefined,
    });
    ownedInsertRun(database, {
      id: OWNED_RUN2,
      runNumber: 2,
      context: '{}',
      policyValue: hasPolicyColumn ? OWNED_STORE_VALID_POLICY : undefined,
    });
    ownedInsertStep(database, { id: OWNED_STEP1, runId: OWNED_RUN1, stepId: 'setup' });
    ownedInsertStep(database, { id: OWNED_STEP2, runId: OWNED_RUN2, stepId: 'setup' });
    database.prepare(
      `INSERT INTO stories (id, run_id, story_id, story_index, status, created_at, updated_at)
       VALUES (?, ?, 'story-1', 0, 'done', ?, ?)`,
    ).run(OWNED_STORY1, OWNED_RUN1, OWNED_STORE_T, OWNED_STORE_T);
    database.prepare(
      `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status,
         cleanup_policy, created_at, removed_at, error)
       VALUES (?, ?, ?, ?, 'refs/heads/main', ?, 'main', 'kept', 'keep', ?, ?, NULL)`,
    ).run(OWNED_RUN2, OWNED_STORE_HOST_ROOT, `${OWNED_STORE_HOST_ROOT}/.git`,
      `${OWNED_STORE_HOST_ROOT}/wt`, 'd'.repeat(40), OWNED_STORE_T, OWNED_STORE_REMOVED);
    database.prepare(
      `INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at)
       VALUES (?, ?, ?, 'owned-store acceptance', 1, NULL, ?)`,
    ).run(OWNED_STEP1, OWNED_STORY1, OWNED_RUN1, OWNED_STORE_T);
    database.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code,
         duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, 'node --test', 0, 1, NULL, ?, NULL, ?)`,
    ).run(OWNED_STORE_HOST_ROOT, 'e'.repeat(40), 'f'.repeat(64), `run-${OWNED_RUN1}`, OWNED_STORE_T);
  } finally {
    database.close();
  }
  // Read-only inputs: the oracle refuses a writable database_snapshot and a
  // writable reserved-key baseline.
  fs.chmodSync(snapshotPath, 0o444);

  fs.writeFileSync(baselinePath, `${JSON.stringify(ownedStoreReservedBaseline(), null, 2)}\n`, { mode: 0o400 });
  fs.chmodSync(baselinePath, 0o400);

  const identity = (target) => {
    const stat = fs.statSync(target);
    return {
      path: target,
      basename: path.basename(target),
      sha256: sha256FileStream(target),
      bytes: stat.size,
      mode: stat.mode & 0o777,
    };
  };
  return {
    entry,
    descriptor,
    storeDir,
    statePath: path.join(storeDir, 'state.json'),
    snapshotPath,
    baselinePath,
    snapshot: identity(snapshotPath),
    sidecar: identity(baselinePath),
  };
}

/** The expectation an owned-store acceptance case's matrix must satisfy. */
export function ownedStoreExpectation(entry) {
  return Object.freeze({
    kind: 'o12-owned-store-matrix',
    user_version: entry.user_version,
    lineage: entry.lineage,
    r1_evaluable: true,
    r1_result: 'PASS',
    overall_result: 'PASS',
    exit_code: 0,
    source_mode: 'owned-copy-ddl',
  });
}

/**
 * Build ONE owned store and run the REAL working-tree O12 executable over it,
 * retaining every artifact under `caseDir`. Nothing is read from a host path:
 * the store is written by this process from the oracle's own descriptors.
 */
export async function runOwnedStoreCase({ repoRoot, caseDir, caseId }) {
  const entry = ownedStoreCase(caseId);
  // The oracle's context loader requires ABSOLUTE paths, so a caller-supplied
  // relative case dir is resolved once here.
  const resolvedCaseDir = path.resolve(caseDir);
  fs.mkdirSync(resolvedCaseDir, { recursive: true });
  const built = writeOwnedStore({ storeDir: resolvedCaseDir, entry });
  const campaignId = path.basename(resolvedCaseDir);
  const caseLabel = `o12-${entry.id}`;

  const pairBreakdown = readPairMismatchBreakdown(built.snapshotPath);
  const context = await writeOracleContext({
    seedRoot: resolvedCaseDir,
    oracleId: 'O12',
    caseId: caseLabel,
    campaignId,
    snapshot: built.snapshotPath,
    importedOracleDir: path.resolve(repoRoot),
  });
  const contextPath = path.join(resolvedCaseDir, 'oracle-context-O12.json');
  const runEvidenceDir = path.join(resolvedCaseDir, 'oracle-evidence', 'o12', timestamp());
  fs.mkdirSync(runEvidenceDir, { recursive: true });

  const env = {
    ...o12ChildEnv({ tmpdir: safeProbeTmpdir() }),
    TT_ORACLE_CONTRACT_VERSION: '1',
    TT_ORACLE_ID: 'O12',
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: runEvidenceDir,
    TT_CASE_ID: caseLabel,
    TT_CAMPAIGN_ID: campaignId,
    TT_O12_BASELINE: built.baselinePath,
  };
  delete env.TT_RUN_ID;

  const scaffoldEntry = path.join(repoRoot, 'torture-test', 'oracles', 'O12');
  const startedAt = new Date().toISOString();
  const res = spawnSync(process.execPath, [scaffoldEntry, '--contract-version', '1', '--context', contextPath], {
    env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();

  fs.writeFileSync(path.join(resolvedCaseDir, 'o12.stdout.log'), res.stdout ?? '');
  fs.writeFileSync(path.join(resolvedCaseDir, 'o12.stderr.log'), res.stderr ?? '');

  let stdoutJson = null;
  try {
    stdoutJson = JSON.parse((res.stdout ?? '').trim());
  } catch {
    stdoutJson = null;
  }
  const evidenceFile = path.join(runEvidenceDir, 'o12-db-integrity.json');
  const evidenceJson = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : null;

  const source = {
    mode: 'owned-copy-ddl',
    origin: 'owned store built in this process from the oracle\'s own schema descriptors (no host path copied)',
    store_dir: resolvedCaseDir,
    campaign_id: campaignId,
    snapshot: built.snapshot,
    sidecar: built.sidecar,
    retained_root_unchanged: null,
  };
  const invocation = {
    oracle: 'O12',
    entry: scaffoldEntry,
    contract_version: 1,
    case_id: caseLabel,
    campaign_id: campaignId,
    context_path: contextPath,
    // The shared aged-state context writer hardcodes this reference source;
    // the store itself is owned/DDL-built (recorded, never hidden).
    context_database_reference: context.mechanical_evidence.references.database_snapshot,
    evidence_dir: runEvidenceDir,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: res.status,
    signal: res.signal ?? null,
    baseline: { path: built.baselinePath, sha256: built.sidecar.sha256 },
    store: {
      user_version: entry.user_version,
      lineage: entry.lineage,
      ddl_columns: Object.fromEntries(Object.entries(built.descriptor.coreTables)
        .map(([table, columns]) => [table, [...columns]])),
      declared_columns: built.descriptor.columnDeclarations ?? {},
      policy_row_run_id: entry.policy_row ? OWNED_RUN2 : null,
      native_policy_row_run_id: entry.policy_row ? OWNED_RUN1 : null,
    },
    env: {
      TAMANDUA_TEST_GUARD: env.TAMANDUA_TEST_GUARD,
      TAMANDUA_PI_BINARY: env.TAMANDUA_PI_BINARY,
      TAMANDUA_HERMES_BINARY: env.TAMANDUA_HERMES_BINARY,
      TAMANDUA_DSH_BINARY: env.TAMANDUA_DSH_BINARY,
      TT_RUN_ID_absent: env.TT_RUN_ID === undefined,
    },
  };

  const matrix = buildSeedSnapshotMatrix({
    evidenceJson, stdoutJson, exitCode: res.status, signal: res.signal ?? null,
    pairBreakdown, copied: null, source, invocation,
    kind: 'o12-owned-store-matrix', r3Attribution: null,
  });
  const expectation = ownedStoreExpectation(entry);
  const validation = validateSeedSnapshotMatrix(matrix, expectation);
  matrix.expectation = expectation;
  matrix.validation = validation;
  matrix.verdict = validation.ok ? 'EXPECTED_MATRIX' : 'UNEXPECTED_MATRIX';
  matrix.evidence = {
    o12_db_integrity: evidenceFile,
    o12_stdout: path.join(resolvedCaseDir, 'o12.stdout.log'),
    o12_stderr: path.join(resolvedCaseDir, 'o12.stderr.log'),
    snapshot: built.snapshotPath,
    baseline: built.baselinePath,
  };

  const matrixPath = path.join(resolvedCaseDir, 'owned-store-matrix.json');
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf-8');

  return {
    caseId, caseLabel, entry, expectation, matrix, matrixPath, validation,
    exitCode: res.status, stderr: res.stderr ?? '', evidenceJson, stdoutJson, built,
  };
}

/**
 * Run every owned-store acceptance case (or the named subset) into a fresh
 * retained evidence root and write the aggregate receipt. The per-case R1..R6
 * matrices and the aggregate are the retained evidence: nothing is disposed.
 */
export async function runOwnedStoreAcceptance({ repoRoot, resultsRoot = RESULTS_ROOT, caseIds = null, root = null }) {
  const ids = caseIds ?? OWNED_STORE_CASES.map((entry) => entry.id);
  const acceptanceRoot = root ?? path.join(resultsRoot, `o12-owned-store-acceptance-${timestamp()}`);
  fs.mkdirSync(acceptanceRoot, { recursive: true });

  const cases = [];
  for (const caseId of ids) {
    const caseDir = path.join(acceptanceRoot, caseId);
    const result = await runOwnedStoreCase({ repoRoot, caseDir, caseId });
    cases.push({
      case_id: caseId,
      case_dir: caseDir,
      matrix_path: result.matrixPath,
      expectation: result.expectation,
      user_version: result.matrix.schema.user_version,
      lineage: result.matrix.schema.lineage,
      supported_user_versions: result.matrix.schema.supported_user_versions,
      legs: Object.fromEntries(Object.entries(result.matrix.legs).map(([leg, record]) => [leg, record.result])),
      overall_result: result.matrix.overall_result,
      stdout_result: result.matrix.stdout_result,
      exit_code: result.exitCode,
      findings: result.matrix.finding_ids,
      verdict: result.matrix.verdict,
      validation_ok: result.validation.ok,
      validation_problems: result.validation.problems,
      r1_evaluable: ['PASS', 'FAIL'].includes(result.matrix.legs.R1?.result),
      evidence: result.matrix.evidence,
      store: {
        snapshot: result.built.snapshot,
        baseline: result.built.sidecar,
        ddl_columns: result.matrix.invocation.store.ddl_columns,
      },
    });
  }

  const allOk = cases.every((record) => record.validation_ok);
  const receipt = {
    kind: 'o12-owned-store-acceptance',
    contract_version: 1,
    generated_at: new Date().toISOString(),
    oracle: 'O12',
    acceptance_root: acceptanceRoot,
    supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
    store_origin: 'owned store built from the oracle\'s own schema descriptors (DDL), never a copied host path',
    case_count: cases.length,
    cases,
    verdict: allOk ? 'ALL_CASES_EXPECTED' : 'CASE_MATRIX_MISMATCH',
    // The R1..R6 matrix of every case, and the aggregate verdict above, are the
    // retained evidence for the legacy (9..12) and schema-13 store acceptance.
    r1_evaluable_all: cases.every((record) => record.r1_evaluable),
  };
  const receiptPath = path.join(acceptanceRoot, 'owned-store-acceptance-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  return { acceptanceRoot, receiptPath, receipt, cases, ok: allOk };
}

// The two flat, well-known owned seed-snapshot paths the O12 gate consumes
// through TAMANDUA_O12_SEED_SNAPSHOT (the v13 seed the upcoming campaign
// produces, and a legacy main-v12 store). `torture-test/var` is gitignored, so
// no binary store is ever committed.
export const OWNED_SEED_SNAPSHOTS = Object.freeze([
  Object.freeze({ basename: 'seed-snapshot-v13.sqlite', caseId: 'owned-store-current-v13', label: 'v13' }),
  Object.freeze({ basename: 'seed-snapshot-legacy-v12.sqlite', caseId: 'owned-store-legacy-v12-main', label: 'legacy-v12-main' }),
]);

/**
 * Materialize the flat owned seed snapshots under `varRoot`. The stores are
 * built in an owned staging root under `varRoot` and the read-only snapshot is
 * copied to the well-known flat path; a receipt records the identities.
 */
export function materializeOwnedSeedSnapshots({ varRoot, storeRoot = null }) {
  const stagingRoot = storeRoot ?? path.join(varRoot, `owned-seed-snapshots-${timestamp()}`);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const snapshots = OWNED_SEED_SNAPSHOTS.map(({ basename, caseId, label }) => {
    const entry = ownedStoreCase(caseId);
    const caseDir = path.join(stagingRoot, caseId);
    const built = writeOwnedStore({ storeDir: caseDir, entry });
    const flatPath = path.join(varRoot, basename);
    // The flat path is a well-known, owned, regenerable artifact: replace this
    // exact file (a previous materialization left it read-only, so a plain
    // copy would fail EACCES). Never a glob/recursive removal.
    fs.rmSync(flatPath, { force: true });
    fs.copyFileSync(built.snapshotPath, flatPath);
    fs.chmodSync(flatPath, 0o444);
    const stat = fs.statSync(flatPath);
    return {
      label,
      case_id: caseId,
      path: flatPath,
      basename,
      user_version: entry.user_version,
      lineage: entry.lineage,
      sha256: sha256FileStream(flatPath),
      bytes: stat.size,
      mode: stat.mode & 0o777,
      built_from: built.snapshotPath,
    };
  });
  const receipt = {
    kind: 'o12-owned-seed-snapshots',
    contract_version: 1,
    generated_at: new Date().toISOString(),
    var_root: varRoot,
    staging_root: stagingRoot,
    supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
    note: 'owned stores built from the oracle\'s own schema descriptors; the flat copies are what TAMANDUA_O12_SEED_SNAPSHOT points at',
    snapshots,
  };
  const receiptPath = path.join(stagingRoot, 'owned-seed-snapshots-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  return { ...receipt, receiptPath, stagingRoot };
}

function parseArgs(argv) {
  const args = {
    sourceRoot: process.env.TAMANDUA_O12_SEED_ROOT ?? DEFAULT_SEED_ROOT,
    resultsRoot: RESULTS_ROOT,
    out: null,
    mode: 'seed',
    varRoot: path.join(TT_ROOT, 'var'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-root') { args.sourceRoot = argv[++index]; }
    else if (arg === '--results-root') { args.resultsRoot = argv[++index]; }
    else if (arg === '--out') { args.out = argv[++index]; }
    else if (arg === '--owned-store-acceptance') { args.mode = 'owned-store-acceptance'; }
    else if (arg === '--owned-store-case') { args.mode = 'owned-store-case'; args.caseId = argv[++index]; }
    else if (arg === '--materialize-seed-snapshots') { args.mode = 'materialize'; args.varRoot = argv[++index] ?? args.varRoot; }
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function printLegs(matrix) {
  for (const [leg, record] of Object.entries(matrix.legs)) process.stdout.write(`  ${leg}: ${record.result}\n`);
  process.stdout.write(`  overall: ${matrix.overall_result}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'materialize') {
    fs.mkdirSync(args.varRoot, { recursive: true });
    const result = materializeOwnedSeedSnapshots({ varRoot: args.varRoot });
    for (const snapshot of result.snapshots) {
      process.stdout.write(`owned seed snapshot ${snapshot.label}: user_version ${snapshot.user_version} (lineage ${snapshot.lineage}) -> ${snapshot.path}\n`);
    }
    process.stdout.write(`receipt: ${result.receiptPath}\n`);
    process.exit(0);
  }

  if (args.mode === 'owned-store-acceptance' || args.mode === 'owned-store-case') {
    fs.mkdirSync(args.resultsRoot, { recursive: true });
    if (args.mode === 'owned-store-case') {
      const caseDir = args.out
        ? path.resolve(args.out)
        : fs.mkdtempSync(path.join(args.resultsRoot, `o12-owned-store-${args.caseId}.`));
      const result = await runOwnedStoreCase({ repoRoot: REPO_ROOT, caseDir, caseId: args.caseId });
      process.stdout.write(`O12 owned-store acceptance: ${args.caseId}\n`);
      printLegs(result.matrix);
      process.stdout.write(`  oracle exit code: ${result.exitCode}\n`);
      process.stdout.write(`  matrix: ${result.matrixPath}\n`);
      if (!result.validation.ok) {
        for (const problem of result.validation.problems) process.stderr.write(`MATRIX PROBLEM: ${problem}\n`);
        process.stderr.write(`${result.stderr.slice(-2000)}\n`);
        process.exit(1);
      }
      process.exit(0);
    }
    const result = await runOwnedStoreAcceptance({ repoRoot: REPO_ROOT, resultsRoot: args.resultsRoot });
    process.stdout.write('O12 owned-store acceptance (legacy 9..12 + current 13):\n');
    for (const record of result.cases) {
      process.stdout.write(`  ${record.case_id}: user_version ${record.user_version} lineage ${record.lineage} `
        + `R1 ${record.legs.R1} overall ${record.overall_result} exit ${record.exit_code} -> ${record.verdict}\n`);
    }
    process.stdout.write(`  verdict: ${result.receipt.verdict}\n`);
    process.stdout.write(`  evidence retained: ${result.acceptanceRoot}\n`);
    process.stdout.write(`  receipt: ${result.receiptPath}\n`);
    if (!result.ok) process.exit(1);
    process.exit(0);
  }

  fs.mkdirSync(args.resultsRoot, { recursive: true });
  const destDir = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(args.resultsRoot, `o12-seed-snapshot-${timestamp()}.`));
  const result = await runSeedSnapshotOracle({ repoRoot: REPO_ROOT, sourceRoot: args.sourceRoot, destDir });

  process.stdout.write('O12 seed-snapshot matrix (owned copy of the retained aged-state seed):\n');
  printLegs(result.matrix);
  process.stdout.write(`  oracle exit code: ${result.exitCode}\n`);
  process.stdout.write(`  evidence retained: ${result.destDir}\n`);
  process.stdout.write(`  matrix: ${result.matrixPath}\n`);
  if (!result.validation.ok) {
    for (const problem of result.validation.problems) process.stderr.write(`MATRIX PROBLEM: ${problem}\n`);
    process.stderr.write(`${result.stderr.slice(-2000)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
