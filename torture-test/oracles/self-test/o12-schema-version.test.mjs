#!/usr/bin/env node

// o12-schema-version.test.mjs — focused O12 schema-version / lineage self-test.
//
// Drives the REAL committed O12 executable (torture-test/oracles/O12) against
// minimal immutable SQLite snapshots covering the product's union schema chain
// (src/db.ts SCHEMA_VERSION 9..14). Every expectation below is derived
// read-only from the union port (`git show refs/remotes/src/union-port:src/db.ts`
// plus src/db.test.ts for the lineage cases and its matchlock policy module):
//
//   9  -> 10   TIME-STORAGE: migrateInstantsToIsoZ() rewrites naive instants.
//              NO new column — the v10 universe IS the v9 universe, so a v10
//              store does NOT have to carry runs.matchlock_policy (the
//              pre-union Matchlock branch numbered that column 10/12; the union
//              numbers it 13).
//   10 -> 11   steps.target_moved_reroute_count INTEGER DEFAULT 0.
//   11 -> 12   steps.preclaim_death_count INTEGER NOT NULL DEFAULT 0.
//   12 -> 13   runs.matchlock_policy TEXT (nullable).
//   13 -> 14   LEDGER-DIAG: suite_results.log_path TEXT (nullable). That column
//              is NOT a runs/steps/stories core column, so the v14 core
//              universe IS the v13 one; a v14 stamp still requires BOTH union
//              columns (runs.matchlock_policy AND steps.preclaim_death_count).
//
// A v12 stamp is DUAL-LINEAGE (both pre-union lineages stamped 12 for
// different columns), so it is classified by its ACTUAL column shape exactly
// like the product's detectSchemaLineage():
//
//   ACCEPT — R1 EVALUABLE, structural observation records version + lineage:
//     v9                     base schema, no chain column
//     v10                    corrected v10 universe (matchlock_policy NOT
//                            required)
//     v10 + matchlock_policy the pre-union Matchlock v10 shape, still accepted
//                            (extra columns are never rejected)
//     v11                    steps.target_moved_reroute_count
//     v12 main-v12           v11 + steps.preclaim_death_count
//     v12 matchlock-v12      v10 + runs.matchlock_policy
//     v12 v12-superset       both lineage discriminators
//     v13 current            the union: BOTH runs.matchlock_policy and
//                            steps.preclaim_death_count (+ the v11/v12 chain)
//     v14 current            v13 + the non-core suite_results.log_path column;
//                            the runs/steps core universe equals v13's
//   FAIL — a judgeable PRODUCT finding, never a whole-oracle ERROR:
//     a version-added column declared with the wrong type or wrong default
//     (finding O12_SCHEMA_COLUMN_DECLARATION_MISMATCH makes R1 FAIL, exit 1)
//     a v13/v14 / Matchlock-lineage v12 run row whose runs.matchlock_policy
//     value is not a valid version-2 Matchlock policy (finding
//     O12_SCHEMA_MATCHLOCK_POLICY_INVALID makes R1 FAIL, exit 1; NULL is the
//     native case and stays VALID)
//   ERROR — exit code 2, ZERO evidence artifacts:
//     v12 carrying NEITHER lineage discriminator column
//     v13/v14 missing either union column
//     an unsupported user_version (8, 15), naming the observed version and the
//     supported set {9, 10, 11, 12, 13, 14}
//
// No src/ file is read or written. Cleanup discipline: no recursive disposal.
// The workspace is RETAINED under torture-test/var with a receipt so reviewers
// can replay the fixtures.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { ORACLE_EVIDENCE_KEYS } from '../../bin/oracle-context.mjs';
import {
  O12_MATCHLOCK_POLICY_HARNESSES,
  O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
  O12_MATCHLOCK_POLICY_SAMPLE_CAP,
  O12_MATCHLOCK_POLICY_VERSION,
  O12_SCHEMA_DESCRIPTORS,
  O12_SUPPORTED_SCHEMA_VERSIONS,
  validateO12MatchlockPolicyValue,
} from '../lib/o12.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O12');
const EXIT_BY_RESULT = { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 };
const CAPTURED = '2026-08-01T12:02:00.000Z';
const T = '2026-08-01T12:00:00.000Z';

// The declared DDL of every column the chain adds, verbatim from the union
// port's guarded ALTERs. A fixture may override one to provoke the
// declaration-mismatch finding.
const ADDED_COLUMN_DDL = Object.freeze({
  target_moved_reroute_count: 'INTEGER DEFAULT 0',
  preclaim_death_count: 'INTEGER NOT NULL DEFAULT 0',
  matchlock_policy: 'TEXT',
});

// The per-store column universes the chain produces. `runs`/`steps` list the
// version-added columns present; `overrides` may replace one column's DDL.
const RUNS_MATCHLOCK = ['matchlock_policy'];
const STEPS_V11 = ['target_moved_reroute_count'];
const STEPS_V12 = [...STEPS_V11, 'preclaim_death_count'];

const ACCEPT_CASES = [
  {
    name: 'o12-schema-v9',
    shape: { userVersion: 9, runs: [], steps: [] },
    lineage: 'v9',
    requires: { runs: [], steps: [] },
    forbids: { runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
  },
  {
    name: 'o12-schema-v10-without-matchlock-policy',
    shape: { userVersion: 10, runs: [], steps: [] },
    lineage: 'v10',
    requires: { runs: [], steps: [] },
    forbids: { runs: RUNS_MATCHLOCK, steps: STEPS_V11 },
  },
  {
    name: 'o12-schema-v10-with-matchlock-policy',
    shape: { userVersion: 10, runs: RUNS_MATCHLOCK, steps: [] },
    lineage: 'v10',
    requires: { runs: [], steps: [] },
    forbids: { steps: STEPS_V11 },
  },
  {
    name: 'o12-schema-v11',
    shape: { userVersion: 11, runs: [], steps: STEPS_V11 },
    lineage: 'v11',
    requires: { runs: [], steps: STEPS_V11 },
    forbids: { runs: RUNS_MATCHLOCK, steps: ['preclaim_death_count'] },
  },
  {
    name: 'o12-schema-v12-main',
    shape: { userVersion: 12, runs: [], steps: STEPS_V12 },
    lineage: 'main-v12',
    requires: { runs: [], steps: STEPS_V12 },
    forbids: { runs: RUNS_MATCHLOCK },
  },
  {
    name: 'o12-schema-v12-matchlock',
    shape: { userVersion: 12, runs: RUNS_MATCHLOCK, steps: [] },
    lineage: 'matchlock-v12',
    requires: { runs: RUNS_MATCHLOCK, steps: [] },
    forbids: { steps: STEPS_V11 },
  },
  {
    name: 'o12-schema-v12-superset',
    shape: { userVersion: 12, runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
    lineage: 'v12-superset',
    requires: { runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
  },
  {
    name: 'o12-schema-v13-native',
    shape: { userVersion: 13, runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
    lineage: 'current',
    requires: { runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
  },
  {
    // v14 (LEDGER-DIAG) adds only the NON-core suite_results.log_path column:
    // the runs/steps core universe is v13's and a v14 stamp is a legal native
    // shape when BOTH union columns are present. `logPath` makes the fixture
    // actually carry suite_results.log_path (the product fact).
    name: 'o12-schema-v14-native',
    shape: { userVersion: 14, runs: RUNS_MATCHLOCK, steps: STEPS_V12, logPath: true },
    lineage: 'current',
    requires: { runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
  },
];

// A version-added column declared with the wrong type/default is a judgeable
// PRODUCT finding (R1 FAIL, exit 1) — never an ERROR: the store is usable, its
// version number just promises a column shape it does not declare.
const DECLARATION_MISMATCH_CASES = [
  {
    name: 'o12-schema-v11-target-moved-wrong-type',
    shape: {
      userVersion: 11,
      runs: [],
      steps: STEPS_V11,
      overrides: { target_moved_reroute_count: 'TEXT DEFAULT 0' },
    },
    column: 'steps.target_moved_reroute_count',
    expected_type: 'INTEGER',
    observed_type: 'TEXT',
    expected_default: '0',
    observed_default: '0',
  },
  {
    name: 'o12-schema-v11-target-moved-wrong-default',
    shape: {
      userVersion: 11,
      runs: [],
      steps: STEPS_V11,
      overrides: { target_moved_reroute_count: 'INTEGER DEFAULT 7' },
    },
    column: 'steps.target_moved_reroute_count',
    expected_type: 'INTEGER',
    observed_type: 'INTEGER',
    expected_default: '0',
    observed_default: '7',
  },
  {
    name: 'o12-schema-v13-matchlock-policy-wrong-type',
    shape: {
      userVersion: 13,
      runs: RUNS_MATCHLOCK,
      steps: STEPS_V12,
      overrides: { matchlock_policy: 'INTEGER' },
    },
    column: 'runs.matchlock_policy',
    expected_type: 'TEXT',
    observed_type: 'INTEGER',
    expected_default: null,
    observed_default: null,
  },
];

// Whole-oracle ERROR cases: an unjudgeable version or shape (exit 2, zero
// evidence artifacts). `names` lists the strings the message must carry.
const ERROR_CASES = [
  {
    name: 'o12-schema-v12-neither-lineage',
    shape: { userVersion: 12, runs: [], steps: [] },
    names: ['12', 'runs.matchlock_policy', 'steps.preclaim_death_count'],
  },
  {
    name: 'o12-schema-v13-missing-preclaim',
    shape: { userVersion: 13, runs: RUNS_MATCHLOCK, steps: STEPS_V11 },
    names: ['13', 'steps.preclaim_death_count'],
  },
  {
    name: 'o12-schema-v13-missing-matchlock-policy',
    shape: { userVersion: 13, runs: [], steps: STEPS_V12 },
    names: ['13', 'runs.matchlock_policy'],
  },
  {
    // v14 (LEDGER-DIAG) still requires BOTH union columns: a v14 stamp missing
    // either is a whole-oracle ERROR naming the observed version and the
    // missing column.
    name: 'o12-schema-v14-missing-preclaim',
    shape: { userVersion: 14, runs: RUNS_MATCHLOCK, steps: STEPS_V11, logPath: true },
    names: ['14', 'steps.preclaim_death_count'],
  },
  {
    name: 'o12-schema-v14-missing-matchlock-policy',
    shape: { userVersion: 14, runs: [], steps: STEPS_V12, logPath: true },
    names: ['14', 'runs.matchlock_policy'],
  },
  {
    name: 'o12-schema-version-unsupported-8',
    shape: { userVersion: 8, runs: [], steps: [] },
    names: ['8', '{9, 10, 11, 12, 13, 14}'],
  },
  {
    // 15 (above LEDGER-DIAG) is the unsupported-version control now that 14 is
    // supported: it fails closed naming the observed version and the full
    // supported set.
    name: 'o12-schema-version-unsupported-15',
    shape: { userVersion: 15, runs: RUNS_MATCHLOCK, steps: STEPS_V12 },
    names: ['15', '{9, 10, 11, 12, 13, 14}'],
  },
];

// Minimal-but-complete tamandua schema: every ORPHAN_MATRIX parent/child table
// and column is present so R1's orphan probes all RUN (no NOT_EVALUABLE
// sub-check). The version-added columns are appended per fixture.
function ddl({ userVersion, runs = [], steps = [], overrides = {}, logPath = false }) {
  const clause = (column) => `${column} ${overrides[column] ?? ADDED_COLUMN_DDL[column]}`;
  const runsExtra = runs.map((column) => `,\n  ${clause(column)}`).join('');
  const stepsExtra = steps.map((column) => `,\n  ${clause(column)}`).join('');
  return `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
  tokens_spent INTEGER NOT NULL DEFAULT 0, notify_url TEXT, parent_run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  scheduling_status TEXT, scheduling_requested_at TEXT, scheduling_error TEXT,
  worker_lost_count INTEGER NOT NULL DEFAULT 0, ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
  instant_fail_count INTEGER NOT NULL DEFAULT 0,
  test_cmd_established TEXT, test_cmd_source TEXT, harness_probe_status TEXT, harness_probe_at TEXT${runsExtra},
  CHECK (1));
CREATE TABLE steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, input_template TEXT NOT NULL,
  expects TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', output TEXT,
  retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
  type TEXT NOT NULL DEFAULT 'single', loop_config TEXT, current_story_id TEXT,
  abandoned_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  claim_job_id TEXT, claim_pid INTEGER, claim_pgid INTEGER, claim_updated_at TEXT,
  reroute_count INTEGER DEFAULT 0, terminal_reroute_count INTEGER DEFAULT 0,
  ledger_concession_count INTEGER DEFAULT 0, claim_invalidated_by TEXT,
  conditional_condition TEXT, auto_completed INTEGER NOT NULL DEFAULT 0, auto_complete_reason TEXT${stepsExtra});
CREATE TABLE stories (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), story_index INTEGER NOT NULL,
  story_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
  output TEXT, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 4,
  resume_reset_count INTEGER NOT NULL DEFAULT 0, abandoned_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE story_abandonments (
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
  duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL${logPath ? ', log_path TEXT' : ''});
CREATE TABLE autoresearch_sessions (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, goal TEXT, metric_name TEXT, metric_unit TEXT,
  direction TEXT, command TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, last_run_at TEXT, total_runs INTEGER NOT NULL DEFAULT 0,
  baseline_metric REAL, best_metric REAL, best_run INTEGER, files_missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), system_tokens_spent INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version = ${userVersion};
`;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Build one fixture campaign: state.json at the root, a read-only snapshot, and
// an immutable context.json referencing it.
function buildFixture(workspace, name, shape) {
  const campaign = path.join(workspace, name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });
  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(ddl(shape));
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('INSERT INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)').run();
    // `runRows` (optional) drives the runs table: one row per entry with an
    // optional `policy` = the stored runs.matchlock_policy VALUE (a JSON
    // string, or null/absent for a native run). The default is a single
    // native (NULL policy) run — the column universe, not the policy value,
    // is what the version/lineage matrix above pins.
    const hasPolicyColumn = database.prepare('PRAGMA table_info(runs)').all()
      .some((column) => column.name === 'matchlock_policy');
    const runRows = shape.runRows ?? [{}];
    const insertRun = database.prepare(
      'INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at'
      + (hasPolicyColumn ? ', matchlock_policy' : '')
      + ") VALUES (?, ?, 'wf', 'task', 'completed', '{}', 0, ?, ?"
      + (hasPolicyColumn ? ', ?' : '') + ')',
    );
    runRows.forEach((row, index) => {
      const values = [
        row.id ?? `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
        index + 1,
        T,
        T,
      ];
      if (hasPolicyColumn) values.push(row.policy ?? null);
      insertRun.run(...values);
    });
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o400);
  const reference = {
    path: path.relative(campaign, databasePath).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(databasePath)),
    captured_at: CAPTURED,
    source: 'sqlite-self-test',
  };
  const references = Object.fromEntries(ORACLE_EVIDENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference;
  const context = {
    contract_version: 1, oracle_id: 'O12',
    campaign: { id: `campaign-${name}`, created_at: CAPTURED, manifest: { sha256: '1'.repeat(64), case_count: 1, case_ids: [name] } },
    case: { id: name, wave: 6, workflow: 'post-batch', fixture: 'synthetic', harness: 'scripted-pi', class: 'verification', caps: { tokens: 0, wall_min: 1 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 6, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return { campaign, evidence, databasePath, contextPath, context };
}

function invoke(fixture) {
  const { evidence, databasePath, contextPath, context } = fixture;
  const snapshotBefore = sha256(fs.readFileSync(databasePath));
  const evidenceBefore = fs.readdirSync(evidence).sort();
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', contextPath], {
    cwd: evidence,
    env: {
      PATH: process.env.PATH ?? `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: fixture.campaign, TMPDIR: fixture.campaign, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      TAMANDUA_TEST_GUARD: '1',
      TAMANDUA_PI_BINARY: '/usr/bin/false', TAMANDUA_DSH_BINARY: '/usr/bin/false', TAMANDUA_HERMES_BINARY: '/usr/bin/false',
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O12',
      TT_ORACLE_CONTEXT: contextPath, TT_ORACLE_EVIDENCE_DIR: evidence,
      TT_CASE_ID: context.case.id, TT_CAMPAIGN_ID: context.campaign.id,
    },
    encoding: 'utf8', shell: false, timeout: 30_000,
  });
  assert.ifError(result.error, `${context.case.id}: oracle spawn failed: ${result.error?.message}`);
  assert.equal(result.signal, null, `${context.case.id}: oracle terminated by signal`);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(sha256(fs.readFileSync(databasePath)), snapshotBefore, `${context.case.id}: snapshot was mutated`);
  const added = fs.readdirSync(evidence).sort().filter((file) => !evidenceBefore.includes(file));
  return { response, status: result.status, added };
}

// The single evidence artifact's structural schema observation.
function structuralMetadata(response, evidenceDir) {
  assert.equal(response.evidence.length, 1, 'expected exactly one evidence artifact');
  const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, response.evidence[0].path), 'utf8'));
  return { metadata: structuralObservation(evidence).schema_metadata, evidence };
}

// The structural observation record (carries the schema metadata AND the
// runs.matchlock_policy sub-check record).
function structuralObservation(evidence) {
  const observation = evidence.observations.find((entry) => entry.scope === 'structural');
  assert.ok(observation, 'structural schema observation must be present');
  return observation;
}

function findingIds(response) {
  return response.findings.map((finding) => finding.id);
}

test('O12 schema 9..14: descriptor set, dual v12 lineage, v13/v14 union and fail-closed shapes', () => {
  // ── the exported contract itself ─────────────────────────────────────
  assert.deepEqual([...O12_SUPPORTED_SCHEMA_VERSIONS], [9, 10, 11, 12, 13, 14],
    'supported set must be [9, 10, 11, 12, 13, 14]');
  assert.ok(Object.isFrozen(O12_SUPPORTED_SCHEMA_VERSIONS), 'supported set must be frozen');
  for (const version of O12_SUPPORTED_SCHEMA_VERSIONS) {
    const descriptor = O12_SCHEMA_DESCRIPTORS[version];
    assert.ok(descriptor, `every supported version needs a descriptor (missing ${version})`);
    assert.ok(Object.isFrozen(descriptor), `descriptor ${version} must be frozen`);
  }
  assert.equal(O12_SCHEMA_DESCRIPTORS[10].coreTables.runs.includes('matchlock_policy'), false,
    'the corrected v10 universe must NOT require runs.matchlock_policy');
  assert.ok(O12_SCHEMA_DESCRIPTORS[11].coreTables.steps.includes('target_moved_reroute_count'),
    'the v11 universe must require steps.target_moved_reroute_count');
  assert.deepEqual(Object.keys(O12_SCHEMA_DESCRIPTORS[12].lineages),
    ['main-v12', 'matchlock-v12', 'v12-superset'], 'v12 must resolve through its three lineages');

  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'o12-schema-version.'));
  const receipt = { versions: [], lineages: [], errors: [], findings: [] };
  try {
    // ── ACCEPT: every version/lineage is judged, never ERROR ────────────
    for (const entry of ACCEPT_CASES) {
      const fixture = buildFixture(workspace, entry.name, entry.shape);
      const run = invoke(fixture);
      const detail = `${entry.name}: ${JSON.stringify(run.response)}`;
      assert.notEqual(run.response.result, 'ERROR', `${entry.name} must not ERROR: ${detail}`);
      assert.equal(run.status, EXIT_BY_RESULT[run.response.result], `${entry.name}: exit must match result`);
      const { metadata, evidence } = structuralMetadata(run.response, fixture.evidence);
      assert.ok(['PASS', 'FAIL'].includes(evidence.coverage.R1.result),
        `${entry.name}: R1 must be EVALUABLE, got ${evidence.coverage.R1.result}`);
      assert.equal(metadata.user_version, entry.shape.userVersion, `${entry.name}: observed user_version`);
      assert.deepEqual(metadata.supported_user_versions, [9, 10, 11, 12, 13, 14],
        `${entry.name}: supported-version set recorded in the structural observation`);
      assert.equal(metadata.lineage, entry.lineage, `${entry.name}: observed lineage`);
      for (const column of entry.requires?.runs ?? []) {
        assert.ok(metadata.core_columns.runs.required.includes(column),
          `${entry.name}: runs universe must require ${column}`);
      }
      for (const column of entry.requires?.steps ?? []) {
        assert.ok(metadata.core_columns.steps.required.includes(column),
          `${entry.name}: steps universe must require ${column}`);
      }
      for (const column of entry.forbids?.runs ?? []) {
        assert.ok(!metadata.core_columns.runs.required.includes(column),
          `${entry.name}: runs universe must NOT require ${column}`);
      }
      for (const column of entry.forbids?.steps ?? []) {
        assert.ok(!metadata.core_columns.steps.required.includes(column),
          `${entry.name}: steps universe must NOT require ${column}`);
      }
      // Every version-added column of this universe is declaration-checked.
      const declared = Object.keys(O12_SCHEMA_DESCRIPTORS[entry.shape.userVersion].lineages?.[entry.lineage]
        ?.columnDeclarations ?? O12_SCHEMA_DESCRIPTORS[entry.shape.userVersion].columnDeclarations ?? {});
      assert.deepEqual(metadata.column_declarations.map((check) => check.column).sort(), declared.sort(),
        `${entry.name}: declaration checks must cover exactly this universe's added columns`);
      for (const check of metadata.column_declarations) {
        assert.equal(check.status, 'PASS', `${entry.name}: ${check.column} declaration must match`);
      }
      assert.equal(evidence.coverage.R1.column_declaration_mismatch_count, 0,
        `${entry.name}: no declaration mismatch`);
      assert.deepEqual(run.added, ['o12-db-integrity.json'], `${entry.name}: exactly one evidence artifact`);
      receipt.versions.push(`${entry.name}=${metadata.user_version}`);
      receipt.lineages.push(`${entry.name}=${metadata.lineage}`);
    }

    // ── FAIL: a declared-shape mismatch is a judgeable product finding ───
    for (const entry of DECLARATION_MISMATCH_CASES) {
      const fixture = buildFixture(workspace, entry.name, entry.shape);
      const run = invoke(fixture);
      const detail = `${entry.name}: ${JSON.stringify(run.response)}`;
      assert.notEqual(run.response.result, 'ERROR', `${entry.name} must not ERROR (a mismatch is a finding): ${detail}`);
      assert.equal(run.response.result, 'FAIL', `${entry.name}: mismatch must make the oracle FAIL`);
      assert.equal(run.status, 1, `${entry.name}: FAIL exit code must be 1`);
      assert.ok(findingIds(run.response).includes('O12_SCHEMA_COLUMN_DECLARATION_MISMATCH'),
        `${entry.name}: expected O12_SCHEMA_COLUMN_DECLARATION_MISMATCH, got ${JSON.stringify(findingIds(run.response))}`);
      const { metadata, evidence } = structuralMetadata(run.response, fixture.evidence);
      assert.equal(evidence.coverage.R1.result, 'FAIL', `${entry.name}: R1 must FAIL (not ERROR/NOT_EVALUABLE)`);
      assert.equal(evidence.coverage.R1.column_declaration_mismatch_count, 1, `${entry.name}: mismatch count`);
      const check = metadata.column_declarations.find((candidate) => candidate.column === entry.column);
      assert.ok(check, `${entry.name}: ${entry.column} must be declaration-checked`);
      assert.equal(check.status, 'FAIL', `${entry.name}: ${entry.column} declaration status`);
      assert.equal(check.observed_type, entry.observed_type, `${entry.name}: observed type`);
      assert.equal(check.observed_default, entry.observed_default, `${entry.name}: observed default`);
      assert.equal(check.expected_type, entry.expected_type, `${entry.name}: expected type`);
      assert.equal(check.expected_default, entry.expected_default, `${entry.name}: expected default`);
      assert.deepEqual(run.added, ['o12-db-integrity.json'], `${entry.name}: FAIL still emits evidence`);
      receipt.findings.push(`${entry.name}=O12_SCHEMA_COLUMN_DECLARATION_MISMATCH`);
    }

    // ── ERROR: unjudgeable version/shape, zero evidence artifacts ────────
    for (const entry of ERROR_CASES) {
      const fixture = buildFixture(workspace, entry.name, entry.shape);
      const run = invoke(fixture);
      assert.equal(run.response.result, 'ERROR', `${entry.name}: must ERROR, got ${run.response.result}`);
      assert.equal(run.status, 2, `${entry.name}: ERROR exit code must be 2`);
      assert.equal(run.response.evidence.length, 0, `${entry.name}: ERROR must emit no evidence`);
      assert.deepEqual(run.added, [], `${entry.name}: ERROR must write no evidence files`);
      const text = JSON.stringify(run.response);
      for (const needle of entry.names) {
        assert.ok(text.includes(needle), `${entry.name}: error message must carry ${needle}: ${text}`);
      }
      receipt.errors.push(`${entry.name}=${run.status}`);
    }

    // Retain the workspace with an identity receipt (never rmSync retained roots).
    const identity = fs.lstatSync(workspace);
    fs.writeFileSync(path.join(workspace, 'gate-receipt.json'), `${JSON.stringify({
      kind: 'o12-schema-version-retained-workspace-receipt',
      root: workspace,
      ownership: { dev: identity.dev, ino: identity.ino },
      retained: 'retained intentionally; no recursive filesystem disposal performed by this test',
      supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
      accept_cases: ACCEPT_CASES.map((entry) => entry.name),
      declaration_mismatch_cases: DECLARATION_MISMATCH_CASES.map((entry) => entry.name),
      error_cases: ERROR_CASES.map((entry) => entry.name),
      ...receipt,
    }, null, 2)}\n`);
    process.stderr.write(`o12 schema-version retained workspace: ${workspace}\n`);
  } catch (error) {
    throw error;
  }
});

// ── runs.matchlock_policy VALUE validation (O12-SCHEMA-13, US-002) ──────────
//
// The v13 (and Matchlock-lineage v12) universes carry the host-owned,
// immutable Matchlock execution-isolation policy as JSON on the run row. Every
// expectation below is derived read-only from the union port's
// src/installer/matchlock/policy.ts (matchlockPolicyValidationErrors /
// MATCHLOCK_POLICY_VERSION = 2 / EXECUTION_ISOLATION_KEYS /
// assertNoCredentialValues). NULL is the NATIVE case and stays valid.

const HOST_ROOT = '/home/kaladin/matchlock-work/o12';

// A complete, well-formed version-2 policy for the given harness. `overrides`
// replaces/adds top-level keys; `omit` removes keys, so the invalid variants
// stay readable one-liners.
function policyValue({ harness = 'pi', overrides = {}, omit = [] } = {}) {
  const policy = {
    version: O12_MATCHLOCK_POLICY_VERSION,
    backend: 'matchlock',
    requestedImage: 'ghcr.io/tetradactyla/matchlock-dev:2026-09',
    resolvedImageDigest: `sha256:${'a'.repeat(64)}`,
    resolvedImageConfigDigest: `sha256:${'b'.repeat(64)}`,
    harness,
    configurationRoot: `${HOST_ROOT}/config/agent`,
    configurationProfile: 'settings.json',
    guestConfigurationRoot: '/workspace/config/pi',
    workPathMode: 'host-absolute',
    workingDirectory: `${HOST_ROOT}/worktree`,
    workMounts: [{
      hostPath: `${HOST_ROOT}/worktree`,
      hostRealPath: `${HOST_ROOT}/worktree`,
      guestPath: `${HOST_ROOT}/worktree`,
    }],
    originalRepositoryRoot: `${HOST_ROOT}/origin`,
    gitMetadataRoots: [`${HOST_ROOT}/origin/.git`],
    mountPolicyVersion: 1,
    networkPolicyVersion: 1,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    ...overrides,
  };
  if (harness === 'hermes') {
    policy.configurationProfile = 'default';
    policy.guestConfigurationRoot = '/workspace/config/hermes';
    policy.hermes = {
      homeDir: `${HOST_ROOT}/home`,
      cwd: `${HOST_ROOT}/worktree`,
      hermesHomeEnv: null,
    };
  } else if (harness === 'dsh') {
    policy.configurationProfile = 'headless';
    policy.guestConfigurationRoot = '/workspace/config/dsh';
    policy.submissionHomeDir = `${HOST_ROOT}/home`;
    policy.submissionCwd = `${HOST_ROOT}/worktree`;
    policy.submissionDshHomeEnv = null;
    policy.submissionDshHomeSource = 'default';
  }
  for (const key of omit) delete policy[key];
  return JSON.stringify(policy);
}

// The three universes that carry the column (v13, matchlock-v12, v12-superset)
// and the ones that do not.
const V13_SHAPE = { userVersion: 13, runs: RUNS_MATCHLOCK, steps: STEPS_V12 };
const V12_MATCHLOCK_SHAPE = { userVersion: 12, runs: RUNS_MATCHLOCK, steps: [] };

// One oracle invocation per case. `expect.errors` lists the error fragments the
// emitted finding/sample must carry for an invalid policy.
const POLICY_CASES = [
  // ── VALID: no finding, R1 EVALUABLE ─────────────────────────────────
  // NOTE: the overall result of these fixtures is NOT_EVALUABLE (exit 3) —
  // not because of the policy sub-check, but because an isolated snapshot
  // carries no host-owned reserved-key baseline, so R4 is NOT_EVALUABLE and
  // NOT_EVALUABLE dominates PASS. R1 itself must be PASS here (asserted
  // below).
  {
    name: 'o12-schema-v13-policy-native-null',
    shape: V13_SHAPE,
    runRows: [{ policy: null }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 1, valid: 0, native: 1, invalid: 0 },
  },
  {
    name: 'o12-schema-v13-policy-valid-pi',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue() }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 1, valid: 1, native: 0, invalid: 0 },
  },
  {
    name: 'o12-schema-v13-policy-valid-hermes',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ harness: 'hermes' }) }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 1, valid: 1, native: 0, invalid: 0 },
  },
  {
    name: 'o12-schema-v13-policy-valid-dsh',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ harness: 'dsh' }) }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 1, valid: 1, native: 0, invalid: 0 },
  },
  {
    name: 'o12-schema-v13-policy-mixed-valid-and-native',
    shape: V13_SHAPE,
    runRows: [{ policy: null }, { policy: policyValue() }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 2, valid: 1, native: 1, invalid: 0 },
  },
  {
    name: 'o12-schema-v12-matchlock-policy-valid',
    shape: V12_MATCHLOCK_SHAPE,
    runRows: [{ policy: policyValue() }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'PASS', checked: 1, valid: 1, native: 0, invalid: 0 },
  },
  // ── INVALID: judgeable PRODUCT finding, R1 FAIL (exit 1, evidence) ───
  {
    name: 'o12-schema-v13-policy-invalid-json',
    shape: V13_SHAPE,
    runRows: [{ policy: '{"version": 2, "backend":' }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['not parseable JSON'] },
  },
  {
    name: 'o12-schema-v13-policy-not-a-json-object',
    shape: V13_SHAPE,
    runRows: [{ policy: JSON.stringify(['matchlock']) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['not a JSON object'] },
  },
  {
    name: 'o12-schema-v13-policy-missing-required-key',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ omit: ['requestedImage'] }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['required field "requestedImage" is missing'] },
  },
  {
    name: 'o12-schema-v13-policy-credential-bearing-key',
    shape: V13_SHAPE,
    runRows: [{
      policy: policyValue({
        overrides: {
          workMounts: [{
            hostPath: `${HOST_ROOT}/worktree`,
            hostRealPath: `${HOST_ROOT}/worktree`,
            guestPath: `${HOST_ROOT}/worktree`,
            credentialPath: `${HOST_ROOT}/secrets`,
          }],
        },
      }),
    }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['credential-bearing field "credentialPath" is not allowed'] },
  },
  {
    name: 'o12-schema-v13-policy-wrong-version',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { version: 1 } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['version must be 2 (got 1)'] },
  },
  {
    name: 'o12-schema-v13-policy-wrong-backend',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { backend: 'native' } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['backend must be "matchlock"'] },
  },
  {
    name: 'o12-schema-v13-policy-wrong-harness-enum',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { harness: 'claude' } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['harness must be "pi", "hermes" or "dsh"'] },
  },
  {
    name: 'o12-schema-v13-policy-wrong-work-path-mode',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { workPathMode: 'guest-relative' } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['workPathMode must be "host-absolute"'] },
  },
  {
    name: 'o12-schema-v13-policy-unknown-key',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { frobnicate: true } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['unknown field "frobnicate"'] },
  },
  {
    name: 'o12-schema-v13-policy-hermes-missing-submission-block',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ harness: 'hermes', omit: ['hermes'] }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['requires the frozen hermes submission block'] },
  },
  {
    name: 'o12-schema-v13-policy-non-positive-resource-limit',
    shape: V13_SHAPE,
    runRows: [{ policy: policyValue({ overrides: { resourceLimits: { cpus: 2, memoryMB: 0, diskSizeMB: 20480 } } }) }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['resourceLimits must carry finite positive'] },
  },
  {
    name: 'o12-schema-v12-matchlock-policy-invalid',
    shape: V12_MATCHLOCK_SHAPE,
    runRows: [{ policy: 'not-json-at-all' }],
    expect: { result: 'FAIL', status: 'FAIL', checked: 1, valid: 0, native: 0, invalid: 1, errors: ['not parseable JSON'] },
  },
];

// Exact-total discipline: the >sample-cap case proves invalid_policy_count is
// the FULL total over every run row while the emitted samples stay ≤5.
const POLICY_EXACT_COUNT_CASE = {
  name: 'o12-schema-v13-policy-invalid-exact-total',
  shape: V13_SHAPE,
  runRows: [
    { policy: null },
    { policy: policyValue() },
    { policy: policyValue({ harness: 'dsh' }) },
    { policy: '{"broken":' },
    { policy: 'not json' },
    { policy: JSON.stringify(['nope']) },
    { policy: policyValue({ omit: ['workMounts'] }) },
    { policy: policyValue({ overrides: { mountPolicyVersion: 9 } }) },
    { policy: policyValue({ overrides: { networkPolicyVersion: 9 } }) },
    { policy: policyValue({ overrides: { configurationProfile: '/etc/passwd' } }) },
  ],
  expect: { checked: 10, valid: 2, native: 1, invalid: 7, samples: O12_MATCHLOCK_POLICY_SAMPLE_CAP, findings: O12_MATCHLOCK_POLICY_SAMPLE_CAP },
};

// A store whose version universe does NOT carry the column is never failed by
// the policy sub-check: the sub-check is recorded NOT_APPLICABLE (visible, with
// the count of out-of-universe policy values), never a silent skip.
const POLICY_OUT_OF_UNIVERSE_CASES = [
  {
    // The v10 store CARRYING matchlock_policy is the accepted pre-union
    // Matchlock shape (extra columns are never rejected) — and its policy
    // value is deliberately invalid: it must still not fail R1.
    name: 'o12-schema-v10-extra-matchlock-policy-out-of-universe',
    shape: { userVersion: 10, runs: RUNS_MATCHLOCK, steps: [] },
    runRows: [{ policy: '{"version": 1}' }],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'NOT_APPLICABLE', checked: 0, valid: 0, native: 0, invalid: 0, outOfUniverse: 1 },
  },
  {
    name: 'o12-schema-v11-policy-out-of-universe',
    shape: { userVersion: 11, runs: [], steps: STEPS_V11 },
    runRows: [{}],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'NOT_APPLICABLE', checked: 0, valid: 0, native: 0, invalid: 0, outOfUniverse: 0 },
  },
  {
    name: 'o12-schema-v12-main-policy-out-of-universe',
    shape: { userVersion: 12, runs: [], steps: STEPS_V12 },
    runRows: [{}],
    expect: { result: 'NOT_EVALUABLE', r1: 'PASS', status: 'NOT_APPLICABLE', checked: 0, valid: 0, native: 0, invalid: 0, outOfUniverse: 0 },
  },
];

test('O12 runs.matchlock_policy: value contract judged as an R1 sub-check', () => {
  // ── the exported value-contract itself ───────────────────────────────
  assert.equal(O12_MATCHLOCK_POLICY_VERSION, 2, 'judged policy version must be the union port\'s MATCHLOCK_POLICY_VERSION (2)');
  assert.deepEqual([...O12_MATCHLOCK_POLICY_HARNESSES], ['pi', 'hermes', 'dsh'], 'harness axis');
  for (const key of ['version', 'backend', 'requestedImage', 'resolvedImageDigest',
    'resolvedImageConfigDigest', 'harness', 'configurationRoot', 'configurationProfile',
    'guestConfigurationRoot', 'workPathMode', 'workingDirectory', 'workMounts',
    'originalRepositoryRoot', 'gitMetadataRoots', 'mountPolicyVersion',
    'networkPolicyVersion', 'resourceLimits']) {
    assert.ok(O12_MATCHLOCK_POLICY_REQUIRED_KEYS.includes(key), `required key set must carry ${key}`);
  }
  // The pure judge itself: NULL is native, a complete record is valid, and the
  // malformed shapes are invalid — never a throw.
  assert.equal(validateO12MatchlockPolicyValue(null).status, 'native', 'NULL policy is the native case');
  assert.equal(validateO12MatchlockPolicyValue(undefined).status, 'native', 'an absent policy value is the native case');
  assert.equal(validateO12MatchlockPolicyValue(policyValue()).status, 'valid', 'a complete policy is valid');
  assert.equal(validateO12MatchlockPolicyValue('{oops').status, 'invalid', 'malformed JSON is invalid');
  assert.equal(validateO12MatchlockPolicyValue('{oops').errors.length > 0, true, 'an invalid policy carries its errors (never a throw)');

  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'o12-matchlock-policy.'));
  const receipt = { accepted: [], rejected: [], errors: [] };
  const cases = [...POLICY_CASES, ...POLICY_OUT_OF_UNIVERSE_CASES];
  try {
    for (const entry of cases) {
      const fixture = buildFixture(workspace, entry.name, { ...entry.shape, runRows: entry.runRows });
      const run = invoke(fixture);
      const detail = `${entry.name}: ${JSON.stringify(run.response)}`;
      assert.notEqual(run.response.result, 'ERROR', `${entry.name} must never ERROR (a policy value is product data): ${detail}`);
      assert.equal(run.response.result, entry.expect.result, `${entry.name}: overall result: ${detail}`);
      assert.equal(run.status, EXIT_BY_RESULT[entry.expect.result], `${entry.name}: exit code must match the result`);
      assert.deepEqual(run.added, ['o12-db-integrity.json'], `${entry.name}: exactly one evidence artifact`);
      const { evidence } = structuralMetadata(run.response, fixture.evidence);
      const observation = structuralObservation(evidence);
      const policy = observation.matchlock_policy;
      assert.ok(policy, `${entry.name}: the structural observation must record matchlock_policy`);
      // The R1..R6 leg shape is UNCHANGED (the policy check is a sub-check).
      assert.deepEqual(Object.keys(evidence.coverage).sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'],
        `${entry.name}: the leg shape must stay R1..R6`);
      assert.equal(evidence.coverage.R1.matchlock_policy.status, entry.expect.status, `${entry.name}: R1 sub-check status`);
      assert.deepEqual(evidence.coverage.R1.matchlock_policy, policy, `${entry.name}: the R1 coverage record and the structural observation must agree`);
      assert.equal(evidence.coverage.R1.matchlock_policy_invalid_count, entry.expect.invalid, `${entry.name}: R1 invalid-policy count`);
      assert.equal(policy.policies_checked, entry.expect.checked, `${entry.name}: policies_checked`);
      assert.equal(policy.valid_policies, entry.expect.valid, `${entry.name}: valid_policies`);
      assert.equal(policy.invalid_policy_count, entry.expect.invalid, `${entry.name}: invalid_policy_count`);
      assert.equal(policy.policy_version, O12_MATCHLOCK_POLICY_VERSION, `${entry.name}: judged policy version`);
      assert.deepEqual(policy.required_keys, [...O12_MATCHLOCK_POLICY_REQUIRED_KEYS], `${entry.name}: required key set recorded`);
      if (entry.expect.native !== undefined) {
        assert.equal(policy.native_runs, entry.expect.native, `${entry.name}: native_runs`);
      }
      if (entry.expect.outOfUniverse !== undefined) {
        assert.equal(policy.out_of_universe_policy_rows, entry.expect.outOfUniverse, `${entry.name}: out-of-universe policy rows`);
      }
      const ids = findingIds(run.response);
      if (entry.expect.status === 'FAIL') {
        assert.equal(evidence.coverage.R1.result, 'FAIL', `${entry.name}: an invalid policy must make R1 FAIL (not ERROR/NOT_EVALUABLE)`);
        assert.ok(ids.includes('O12_SCHEMA_MATCHLOCK_POLICY_INVALID'),
          `${entry.name}: expected O12_SCHEMA_MATCHLOCK_POLICY_INVALID, got ${JSON.stringify(ids)}`);
        const sampleText = policy.invalid_policy_samples
          .flatMap((sample) => sample.errors).join(' | ');
        for (const needle of entry.expect.errors ?? []) {
          assert.ok(sampleText.includes(needle), `${entry.name}: sample must carry ${needle}: ${sampleText}`);
        }
        receipt.rejected.push(`${entry.name}=O12_SCHEMA_MATCHLOCK_POLICY_INVALID`);
      } else {
        assert.ok(!ids.includes('O12_SCHEMA_MATCHLOCK_POLICY_INVALID'),
          `${entry.name}: no policy finding expected, got ${JSON.stringify(ids)}`);
        assert.equal(policy.invalid_policy_count, 0, `${entry.name}: no invalid policy`);
        assert.equal(policy.invalid_policy_samples.length, 0, `${entry.name}: no invalid policy samples`);
        assert.equal(evidence.coverage.R1.result, 'PASS', `${entry.name}: R1 must PASS for a valid/native/out-of-universe policy set`);
        receipt.accepted.push(`${entry.name}=${evidence.coverage.R1.matchlock_policy.status}`);
      }
    }

    // ── exact-total discipline: 7 invalid > the 5-sample cap ───────────
    {
      const entry = POLICY_EXACT_COUNT_CASE;
      const fixture = buildFixture(workspace, `${entry.name}-recheck`, { ...entry.shape, runRows: entry.runRows });
      const run = invoke(fixture);
      const ids = findingIds(run.response);
      const invalidFindings = ids.filter((id) => id === 'O12_SCHEMA_MATCHLOCK_POLICY_INVALID');
      const { evidence } = structuralMetadata(run.response, fixture.evidence);
      const policy = structuralObservation(evidence).matchlock_policy;
      assert.equal(run.response.result, 'FAIL', `${entry.name}: the mixed snapshot must FAIL`);
      assert.equal(policy.invalid_policy_count, entry.expect.invalid,
        `${entry.name}: invalid_policy_count must be the EXACT FULL total (${entry.expect.invalid}), not the capped sample length`);
      assert.equal(policy.invalid_policy_count > policy.invalid_policy_samples.length, true,
        `${entry.name}: the case must actually exceed the sample cap`);
      assert.equal(policy.invalid_policy_samples.length, entry.expect.samples, `${entry.name}: samples are capped`);
      assert.equal(invalidFindings.length, entry.expect.findings, `${entry.name}: representative findings are capped too`);
      assert.equal(policy.policies_checked, entry.expect.checked, `${entry.name}: policies_checked`);
      assert.equal(policy.valid_policies, entry.expect.valid, `${entry.name}: valid_policies`);
      assert.equal(policy.native_runs, entry.expect.native, `${entry.name}: native_runs`);
      assert.equal(policy.invalid_policy_count, evidence.coverage.R1.matchlock_policy_invalid_count,
        `${entry.name}: the R1 coverage counter mirrors the exact total`);
      receipt.rejected.push(`${entry.name}=${policy.invalid_policy_count}/${policy.invalid_policy_samples.length}`);
    }

    // Retain the workspace with an identity receipt (never rmSync retained roots).
    const identity = fs.lstatSync(workspace);
    fs.writeFileSync(path.join(workspace, 'matchlock-policy-receipt.json'), `${JSON.stringify({
      kind: 'o12-matchlock-policy-retained-workspace-receipt',
      root: workspace,
      ownership: { dev: identity.dev, ino: identity.ino },
      retained: 'retained intentionally; no recursive filesystem disposal performed by this test',
      policy_version: O12_MATCHLOCK_POLICY_VERSION,
      harnesses: [...O12_MATCHLOCK_POLICY_HARNESSES],
      required_keys: [...O12_MATCHLOCK_POLICY_REQUIRED_KEYS],
      sample_cap: O12_MATCHLOCK_POLICY_SAMPLE_CAP,
      ...receipt,
    }, null, 2)}\n`);
    process.stderr.write(`o12 matchlock-policy retained workspace: ${workspace}\n`);
  } catch (error) {
    throw error;
  }
});

