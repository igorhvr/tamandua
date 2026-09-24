#!/usr/bin/env node

// generate-o12-fixtures.mjs — O12 DB-integrity mutation fixtures.
//
// Produces `o12-*` fixture directories under an oracle-self-test.* workspace.
// Each fixture carries a read-only SQLite database_snapshot (RAW-SQL
// calibration copy — explicitly permitted for oracle calibration; this is NOT
// the forbidden production-scale history seed, which the aged-state generator
// run builds with REAL product APIs), an immutable context.json, an
// expectation.json, and (for reserved-key fixtures) the host-owned
// o12-reserved-baseline.json sidecar the evaluator consumes.
//
// Calibration discipline mirrors the shared battery: fixtures must prove each
// obligation's positive AND negative controls against the REAL committed O12
// executable through the shared harness (stdout JSON + exit-code contract).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
  O12_MATCHLOCK_POLICY_VERSION,
  O12_SUPPORTED_SCHEMA_VERSIONS,
  validateO12MatchlockPolicyValue,
} from '../lib/o12.mjs';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O12 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];

const CAPTURED = '2026-08-01T12:02:00.000Z';
const T = '2026-08-01T12:00:00.000Z';
const NAIVE = '2026-08-01 12:00:00';
const NAIVE_LATER = '2026-08-01 12:00:05';

// Valid UUID-shaped ids (bare form, as runs.id stores them).
const RUN1 = '11111111-1111-4111-8111-111111111111';
const RUN2 = '22222222-2222-4222-8222-222222222222';
const RUN3 = '33333333-3333-4333-8333-333333333333';
const RUN4 = '44444444-4444-4444-8444-444444444444';
const RUN5 = '55555555-5555-4555-8555-555555555555';
const RUN6 = '66666666-6666-4666-8666-666666666666';
const RUN7 = '77777777-7777-4777-8777-777777777777';
const RUN8 = '88888888-8888-4888-8888-888888888888';
const RUN9 = 'aaaaaaa9-9999-4999-8999-999999999999';
const RUN10 = 'bbbbbbb0-0000-4000-8000-000000000000';
const RUN11 = 'ccccccc1-1111-4111-8111-111111111111';
const RUN12 = 'ddddddd2-2222-4222-8222-222222222222';
const RUN13 = 'eeeeeee3-3333-4333-8333-333333333333';
const STEP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STEP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STEP3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STORY1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GHOST_RUN = '99999999-9999-4999-8999-999999999999';
const GHOST_STORY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function reference(campaign, file, source) {
  return { path: path.relative(campaign, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)), captured_at: CAPTURED, source };
}

// ── fixture schema DDL builder ──────────────────────────────────────────────
//
// The DEFAULT calibration fixture snapshot is the CURRENT product schema (the
// union chain, user_version 13). Every shape below mirrors one point of that
// chain, derived read-only from the union port's src/db.ts applySchema guarded
// ALTERs — see O12-CONTRACT.md "Supported schema versions":
//
//   v9            base schema (the applySchema CREATE TABLE set).
//   v10 = v9      TIME-STORAGE rewrites stored instants to ISO-8601 UTC; NO
//                 column is added, so the v10 column universe IS the v9 one.
//   v11 = v10  +  steps.target_moved_reroute_count INTEGER DEFAULT 0
//   v12-main      v11 + steps.preclaim_death_count INTEGER NOT NULL DEFAULT 0
//   v12-matchlock v10 + runs.matchlock_policy TEXT — the pre-union Matchlock
//                 lineage stamped its OWN version 12 for that column and never
//                 carried target_moved_reroute_count.
//   v13 = union   v12-main + runs.matchlock_policy: BOTH union columns.
//
// A shape names its user_version EXPLICITLY and independently of its column
// universe, because a MISMATCH between the two is exactly what the fail-closed
// rules judge: a v12 stamp carrying neither lineage discriminator, a v13 store
// missing one of the union columns. Those malformed stores are built from the
// mismatching shape directly rather than by mutating a complete store, so the
// fixture's DDL states the exact column universe under test.
function schemaShape({ userVersion, matchlockPolicy = false, targetMovedRerouteCount = false, preclaimDeathCount = false, suiteResultsLogPath = false }) {
  return Object.freeze({ userVersion, matchlockPolicy, targetMovedRerouteCount, preclaimDeathCount, suiteResultsLogPath });
}

const SCHEMA_SHAPES = Object.freeze({
  v9: schemaShape({ userVersion: 9 }),
  v10: schemaShape({ userVersion: 10 }),
  // A v10 stamp whose runs table DOES carry a populated matchlock_policy: a
  // pre-union Matchlock-lineage store. Extra columns are never rejected.
  'v10-matchlock': schemaShape({ userVersion: 10, matchlockPolicy: true }),
  v11: schemaShape({ userVersion: 11, targetMovedRerouteCount: true }),
  'v12-main': schemaShape({ userVersion: 12, targetMovedRerouteCount: true, preclaimDeathCount: true }),
  'v12-matchlock': schemaShape({ userVersion: 12, matchlockPolicy: true }),
  // Neither lineage discriminator: unjudgeable ⇒ whole-oracle ERROR.
  'v12-neither': schemaShape({ userVersion: 12 }),
  v13: schemaShape({ userVersion: 13, matchlockPolicy: true, targetMovedRerouteCount: true, preclaimDeathCount: true }),
  // v13 stamp missing exactly one union column ⇒ whole-oracle ERROR.
  'v13-missing-preclaim': schemaShape({ userVersion: 13, matchlockPolicy: true, targetMovedRerouteCount: true }),
  'v13-missing-matchlock': schemaShape({ userVersion: 13, targetMovedRerouteCount: true, preclaimDeathCount: true }),
  // v14 (LEDGER-DIAG) adds ONLY the NON-core suite_results.log_path column; the
  // runs/steps core universe equals the v13 one and BOTH union columns are still
  // required. A v14 stamp missing a union column is a whole-oracle ERROR.
  v14: schemaShape({ userVersion: 14, matchlockPolicy: true, targetMovedRerouteCount: true, preclaimDeathCount: true, suiteResultsLogPath: true }),
  'v14-missing-preclaim': schemaShape({ userVersion: 14, matchlockPolicy: true, targetMovedRerouteCount: true, suiteResultsLogPath: true }),
});

function fixtureDdl(shape) {
  const matchlockPolicy = shape.matchlockPolicy ? ', matchlock_policy TEXT' : '';
  const targetMoved = shape.targetMovedRerouteCount ? ',\n  target_moved_reroute_count INTEGER DEFAULT 0' : '';
  const preclaim = shape.preclaimDeathCount ? ',\n  preclaim_death_count INTEGER NOT NULL DEFAULT 0' : '';
  return `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
  tokens_spent INTEGER NOT NULL DEFAULT 0, notify_url TEXT, parent_run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  scheduling_status TEXT, scheduling_requested_at TEXT, scheduling_error TEXT,
  worker_lost_count INTEGER NOT NULL DEFAULT 0, ceiling_expiry_count INTEGER NOT NULL DEFAULT 0,
  instant_fail_count INTEGER NOT NULL DEFAULT 0,
  test_cmd_established TEXT, test_cmd_source TEXT, harness_probe_status TEXT, harness_probe_at TEXT${matchlockPolicy});
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
  conditional_condition TEXT, auto_completed INTEGER NOT NULL DEFAULT 0, auto_complete_reason TEXT${targetMoved}${preclaim});
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
  duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL${shape.suiteResultsLogPath ? ',\n  log_path TEXT' : ''});
CREATE TABLE autoresearch_sessions (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, goal TEXT, metric_name TEXT, metric_unit TEXT,
  direction TEXT, command TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, last_run_at TEXT, total_runs INTEGER NOT NULL DEFAULT 0,
  baseline_metric REAL, best_metric REAL, best_run INTEGER, files_missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), system_tokens_spent INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version = ${shape.userVersion};
`;
}

// Per-version/per-lineage DDL. DDL_V9 stays available for the raw v9
// compatibility fixture; DDL (the default for every fixture that does not name
// one) is the CURRENT product schema.
const DDL_V9 = fixtureDdl(SCHEMA_SHAPES.v9);
const DDL_V10 = fixtureDdl(SCHEMA_SHAPES.v10);
const DDL_V10_MATCHLOCK = fixtureDdl(SCHEMA_SHAPES['v10-matchlock']);
const DDL_V11 = fixtureDdl(SCHEMA_SHAPES.v11);
const DDL_V12_MAIN = fixtureDdl(SCHEMA_SHAPES['v12-main']);
const DDL_V12_MATCHLOCK = fixtureDdl(SCHEMA_SHAPES['v12-matchlock']);
const DDL_V12_NEITHER = fixtureDdl(SCHEMA_SHAPES['v12-neither']);
const DDL_V13 = fixtureDdl(SCHEMA_SHAPES.v13);
const DDL_V13_MISSING_PRECLAIM = fixtureDdl(SCHEMA_SHAPES['v13-missing-preclaim']);
const DDL_V13_MISSING_MATCHLOCK = fixtureDdl(SCHEMA_SHAPES['v13-missing-matchlock']);
const DDL_V14 = fixtureDdl(SCHEMA_SHAPES.v14);
const DDL_V14_MISSING_PRECLAIM = fixtureDdl(SCHEMA_SHAPES['v14-missing-preclaim']);
// Default fixture DDL: the CURRENT product schema (union chain, user_version 13).
const DDL = DDL_V13;

// The schema metadata each fixture records in its expectation.json (read by
// o12.test.mjs for the per-version shape assertions). It is the shape the DDL
// was built from — the version stamp AND the column universe, so a fixture
// whose stamp and universe deliberately disagree is visible as such.
function schemaRecord(shape) {
  return {
    user_version: shape.userVersion,
    runs_matchlock_policy: shape.matchlockPolicy,
    steps_target_moved_reroute_count: shape.targetMovedRerouteCount,
    steps_preclaim_death_count: shape.preclaimDeathCount,
    suite_results_log_path: shape.suiteResultsLogPath,
  };
}

// ── Matchlock execution-isolation policy fixtures (12 -> 13 column) ─────────
//
// runs.matchlock_policy stores the host-owned, immutable Matchlock policy as a
// JSON string, or NULL for a native run. The valid sample below is built from
// the SAME required-key set the oracle judges (O12_MATCHLOCK_POLICY_REQUIRED_KEYS
// — derived read-only from the union ref's src/installer/matchlock/policy.ts)
// and is self-checked at generation time, so a fixture asserting a "valid"
// policy can never drift into an invalid one (which would silently turn its
// PASS control into a FAIL).
const FIXTURE_HOST_ROOT = '/synthetic/matchlock-host';

function validMatchlockPolicy() {
  return {
    version: O12_MATCHLOCK_POLICY_VERSION,
    backend: 'matchlock',
    requestedImage: 'ghcr.io/tetradactyla/matchlock-dev:2026-09',
    resolvedImageDigest: `sha256:${'a'.repeat(64)}`,
    resolvedImageConfigDigest: `sha256:${'b'.repeat(64)}`,
    harness: 'pi',
    configurationRoot: `${FIXTURE_HOST_ROOT}/config/agent`,
    configurationProfile: 'settings.json',
    guestConfigurationRoot: '/workspace/config/pi',
    workPathMode: 'host-absolute',
    workingDirectory: `${FIXTURE_HOST_ROOT}/worktree`,
    workMounts: [{
      hostPath: `${FIXTURE_HOST_ROOT}/worktree`,
      hostRealPath: `${FIXTURE_HOST_ROOT}/worktree`,
      guestPath: `${FIXTURE_HOST_ROOT}/worktree`,
    }],
    originalRepositoryRoot: `${FIXTURE_HOST_ROOT}/origin`,
    gitMetadataRoots: [`${FIXTURE_HOST_ROOT}/origin/.git`],
    mountPolicyVersion: 1,
    networkPolicyVersion: 1,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
  };
}

{
  const policy = validMatchlockPolicy();
  const keys = Object.keys(policy);
  const missing = O12_MATCHLOCK_POLICY_REQUIRED_KEYS.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !O12_MATCHLOCK_POLICY_REQUIRED_KEYS.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`the fixture's valid policy must carry exactly the required key set (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`);
  }
  const verdict = validateO12MatchlockPolicyValue(JSON.stringify(policy));
  if (verdict.status !== 'valid') {
    throw new Error(`the fixture's valid policy is judged invalid by the oracle: ${verdict.errors.join('; ')}`);
  }
}

const VALID_MATCHLOCK_POLICY = JSON.stringify(validMatchlockPolicy());
// A present policy that is NOT valid: an unknown value on a fixed-value axis.
// Used by the v13 invalid-policy FAIL control (never an ERROR).
const INVALID_MATCHLOCK_POLICY = JSON.stringify({ ...validMatchlockPolicy(), workPathMode: 'guest-relative' });

{
  const verdict = validateO12MatchlockPolicyValue(INVALID_MATCHLOCK_POLICY);
  if (verdict.status !== 'invalid') {
    throw new Error("the fixture's invalid policy must be judged invalid by the oracle (allowed values: native|valid|invalid)");
  }
}

const RUN_COLUMNS = 'id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at';

// matchlockPolicy is only supplied where the fixture's shape carries the
// runs.matchlock_policy column, so the INSERT omits it (storing SQL NULL, the
// NATIVE case) unless a value is given.
function insertRun(db, { id, runNumber = null, status = 'completed', context = '{}', created = T, updated = T, schedulingRequestedAt = null, harnessProbeAt = null, matchlockPolicy = null }) {
  const includeMatchlock = matchlockPolicy !== null;
  const matchlockColumn = includeMatchlock ? ', matchlock_policy' : '';
  const matchlockPlaceholder = includeMatchlock ? ', ?' : '';
  const args = [id, runNumber, status, context, created, updated, schedulingRequestedAt, harnessProbeAt];
  if (includeMatchlock) args.push(matchlockPolicy);
  db.prepare(
    `INSERT INTO runs (${RUN_COLUMNS}, scheduling_requested_at, harness_probe_at${matchlockColumn})
     VALUES (?, ?, 'wf', 'task', ?, ?, 0, ?, ?, ?, ?${matchlockPlaceholder})`,
  ).run(...args);
}

function insertStep(db, { id, runId, stepId, status, type = 'single', loopConfig = null, currentStoryId = null, created = T, updated = T, agentId = 'wf_agent' }) {
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       type, loop_config, current_story_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'input', 'STATUS: done', ?, ?, ?, ?, ?, ?)`,
  ).run(id, runId, stepId, agentId, status, type, loopConfig, currentStoryId, created, updated);
}

function insertStory(db, { id, runId, status = 'done', created = T, updated = T }) {
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at)
     VALUES (?, ?, 0, 'story-1', 't', '', '[]', ?, ?, ?)`,
  ).run(id, runId, status, created, updated);
}

function insertWorktree(db, { runId, created = T, removedAt = null }) {
  db.prepare(
    `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
      worktree_path, status, cleanup_policy, created_at, removed_at)
     VALUES (?, '/repo', '/repo/.git', '/wt', 'kept', 'keep', ?, ?)`,
  ).run(runId, created, removedAt);
}

// suite_results rows. run_id is nullable (nullAllowed) and, when set, is
// written by the suite shim from TAMANDUA_RUN_ID — the canonical 'run-<uuid>'
// form — while runs.id stores the bare UUID. The R1 orphan probe canonicalizes
// both shapes when matching (ORPHAN_MATRIX canonical: 'run-prefix').
function insertSuiteResult(db, { runId = null, created = T }) {
  db.prepare(
    `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code,
       duration_ms, log_tail, run_id, step_id, created_at)
     VALUES (?, ?, ?, ?, 0, 1, NULL, ?, NULL, ?)`,
  ).run('/repo', 't'.repeat(40), 'c'.repeat(64), 'node --test', runId, created);
}

function insertAbandonment(db, { runId, storyId, created = T }) {
  db.prepare(
    `INSERT INTO story_abandonments (story_id, run_id, reason, abandoned_count, step_id, created_at)
     VALUES (?, ?, 'calibration fixture', 1, NULL, ?)`,
  ).run(storyId, runId, created);
}

// Creates the fixture directory structure and returns { campaign, evidenceDir, databasePath }.
function beginFixture(name) {
  const campaign = path.join(workspace, name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });
  const databasePath = path.join(snapshots, 'database.sqlite');
  return { campaign, snapshots, evidence, databasePath };
}

function finishFixture({ fixture, campaign, evidence, databasePath }) {
  fs.chmodSync(databasePath, 0o400);
  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  const context = {
    contract_version: 1, oracle_id: 'O12',
    campaign: { id: `campaign-${fixture.name}`, created_at: CAPTURED, manifest: { sha256: '1'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 6, workflow: 'post-batch', fixture: 'synthetic', harness: 'scripted-pi', class: 'verification', caps: { tokens: 0, wall_min: 1 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 6, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}

// Reserved-key pin mirror (must equal torture-test/oracles/lib/o12.mjs
// O12_RESERVED_CONTEXT_KEYS AND the native src/installer/step-ops.ts literal;
// o12.test.mjs statically asserts the parity of the evaluator pin with the
// native literal, and the fixture sidecar's supported_reserved_keys is
// validated against the evaluator pin at load time).
const RESERVED_KEY_LIST = [
  'repo', 'working_directory_for_harness', 'task', 'run_id', 'workspace_mode',
  'worktree_path', 'worktree_origin_repository', 'worktree_origin_ref', 'worktree_origin_sha',
  'original_branch', 'merge_gate', 'fail_missing', 'test_cmd_raw',
  'test_cmd_review_required', 'test_cmd_review_candidate', 'test_cmd_review_established',
  'test_cmd_rewriter_step',
];
const RESERVED_KEY_SET = new Set(RESERVED_KEY_LIST);

// v2 typed per-key helpers: values, missing keys and empty strings are
// distinct; every supported reserved key needs typed presence/absence.
const entryPresent = (value) => ({ presence: 'present', value, provenance: 'host' });
const entryAbsent = () => ({ presence: 'absent', provenance: 'host' });
const mutationTo = (value) => ({ presence: 'present', value, source: 'host' });
const mutationRemove = () => ({ presence: 'absent', source: 'host' });

// Build a COMPLETE per-run v2 expected entry: presentValues pins PRESENT keys
// (each with an exact string value, '' allowed); every other supported
// reserved key is pinned ABSENT (a host-captured known absence).
function fullExpectedEntry(presentValues) {
  const entry = {};
  for (const key of RESERVED_KEY_LIST) {
    entry[key] = Object.prototype.hasOwnProperty.call(presentValues, key)
      ? entryPresent(presentValues[key])
      : entryAbsent();
  }
  return entry;
}

// v2 baseline writer. scope: { mode: 'all-snapshot-runs' } (default) or
// { mode: 'explicit', run_ids: [...] } — the explicit run universe is the
// host-admitted scope, reported by the oracle (never a quiet smaller
// denominator).
function writeReservedBaselineV2(evidence, expected, options = {}) {
  const { scope, mutations = {}, producer = 'host', supportedKeys = [...RESERVED_KEY_LIST] } = options;
  const baseline = {
    schema_version: 2,
    captured_at: CAPTURED,
    producer,
    scope: scope ?? { mode: 'all-snapshot-runs' },
    supported_reserved_keys: [...supportedKeys],
    expected,
    expected_mutations: mutations,
  };
  fs.writeFileSync(path.join(evidence, 'o12-reserved-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
}

// v1 LEGACY baseline writer — used only by fixtures that pin the legacy
// migration rule (partial/incomplete v1 must NOT_EVALUABLE, never PASS).
function writeReservedBaselineV1(evidence, runs, extra = {}) {
  const baseline = {
    schema_version: 1,
    captured_at: CAPTURED,
    producer: 'host',
    supported_reserved_keys: [...RESERVED_KEY_LIST],
    runs,
    expected_mutations: {},
    ...extra,
  };
  fs.writeFileSync(path.join(evidence, 'o12-reserved-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
}

const GREEN_CONTEXT = JSON.stringify({ repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green' });

const CASES = [
  // ── overall PASS: every leg demonstrated green with a host-owned baseline ──
  {
    name: 'o12-green', expected: 'PASS',
    // full_snapshot_covered must be true: default all-snapshot mode, every
    // snapshot row (RUN1/RUN2/RUN3 incl. the canonical run-<uuid> alias)
    // compared over the ENTIRE 17-key pin.
    r4FullSnapshotCovered: true,
    build(db) {
      // The genuinely COMPLETE current scoped baseline: every in-scope snapshot
      // run carries host-captured typed presence/absence for the ENTIRE pin.
      // RUN1 demonstrates present values, a known-empty-string (original_branch
      // ''), and a legitimate host-managed presence change (test_cmd_review_required
      // absent at creation → present via the pinned expected-mutations ledger).
      // RUN2 demonstrates full known-absence coverage; RUN3's expected entry is
      // keyed by its valid canonical 'run-<uuid>' alias (unambiguous binding).
      insertRun(db, {
        id: RUN1, runNumber: 1,
        context: JSON.stringify({ repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green', original_branch: '', test_cmd_review_required: 'true' }),
        schedulingRequestedAt: T, harnessProbeAt: T,
      });
      insertRun(db, { id: RUN2, runNumber: 2 });
      insertRun(db, { id: RUN3, runNumber: 3 });
      insertStep(db, { id: STEP1, runId: RUN1, stepId: 'setup', status: 'done' });
      insertStep(db, { id: STEP2, runId: RUN2, stepId: 'setup', status: 'done' });
      insertStory(db, { id: STORY1, runId: RUN1 });
      insertWorktree(db, { runId: RUN1, removedAt: '2026-08-01T12:01:00.000Z' });
      insertWorktree(db, { runId: RUN2 });
      // Dependent-table positive rows: every ORPHAN_MATRIX entry must be
      // demonstrably clean on the all-green fixture. story_abandonments rows
      // reference a real run + story; suite_results rows exercise the
      // run-prefix canonicalization branch (run-<uuid> AND bare uuid AND the
      // null run_id the shim leaves before attribution) — any false orphan
      // here would flip R1 and break the PASS.
      insertAbandonment(db, { runId: RUN1, storyId: STORY1 });
      insertSuiteResult(db, { runId: `run-${RUN2}` });
      insertSuiteResult(db, { runId: RUN1 });
      insertSuiteResult(db, { runId: null });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green', original_branch: '' }),
        [RUN2]: fullExpectedEntry({}),
        [`run-${RUN3}`]: fullExpectedEntry({}),
      }, {
        mutations: { [RUN1]: { test_cmd_review_required: mutationTo('true') } },
      });
    },
  },

  // ── missing reserved-key leg ⇒ NOT_EVALUABLE overall (never a silent PASS) ──
  { name: 'o12-not-evaluable-no-baseline', expected: 'NOT_EVALUABLE', build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); } },

  // ── R1 structural negative controls ──
  { name: 'o12-orphan', expected: 'FAIL', finding: 'O12_STRUCT_ORPHAN', build(db) {
      // Undeclared-FK orphans only: current_story_id -> stories.id and
      // run_worktrees.run_id -> runs.id carry no REFERENCES clause, so only the
      // explicit orphan probes can catch them (foreign_key_check cannot).
      insertRun(db, { id: RUN1, runNumber: 1 });
      insertStep(db, { id: STEP1, runId: RUN1, stepId: 'loop', status: 'done', currentStoryId: 'ghost-story' });
      insertWorktree(db, { runId: 'ghost-worktree-run' });
    } },
  { name: 'o12-foreign-key', expected: 'FAIL', finding: 'O12_STRUCT_FOREIGN_KEY_FAILED', build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); insertStep(db, { id: STEP1, runId: '22222222-2222-4222-8222-000000000000', stepId: 'setup', status: 'done' }); } },
  {
    // story_abandonments.run_id/.story_id and suite_results.run_id carry no
    // REFERENCES clause, so ONLY the explicit orphan probes can catch them.
    // The suite_results rows exercise run-prefix canonicalization both ways:
    // 'run-<RUN1>' resolves to a real run (no false orphan) while
    // 'run-<ghost>' still orphans after the prefix is stripped.
    name: 'o12-orphan-dependents', expected: 'FAIL', finding: 'O12_STRUCT_ORPHAN', r1expected: 'FAIL',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1 });
      insertStory(db, { id: STORY1, runId: RUN1 });
      insertAbandonment(db, { runId: GHOST_RUN, storyId: STORY1 });   // run orphan
      insertAbandonment(db, { runId: RUN1, storyId: GHOST_STORY });   // story orphan
      insertSuiteResult(db, { runId: `run-${RUN1}` });                // canonicalization positive
      insertSuiteResult(db, { runId: `run-${GHOST_RUN}` });           // canonicalization negative
    },
  },
  // ── schema fixture matrix: every supported version and lineage ──────────
  // Each fixture is built from the shape for its version/lineage (see
  // SCHEMA_SHAPES) and judged by the REAL O12 executable. The DEFAULT fixture
  // DDL is the CURRENT product schema (union chain, user_version 13), so a
  // fixture that does not name its own DDL is a v13 store. A v13 stamp missing
  // one of the union columns — and a v12 stamp carrying neither lineage
  // discriminator — are fail-closed whole-oracle ERRORs.
  //
  // Every positive control carries a COMPLETE reserved-key baseline: without
  // one the R4 reserved-key leg is NOT_EVALUABLE and NOT_EVALUABLE dominates
  // PASS, so the fixture could not demonstrate an overall PASS.
  {
    // v9 (base schema: no version-added column).
    name: 'o12-schema-v9-compat', expected: 'PASS',
    ddl: DDL_V9, schema: schemaRecord(SCHEMA_SHAPES.v9),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v10 == the v9 universe (TIME-STORAGE adds NO column), so the union-chain
    // v10 store has no runs.matchlock_policy: that IS the legal shape — a
    // POSITIVE control, not the fail-closed case the pre-union reading assumed
    // (runs.matchlock_policy belongs to the 12->13 step).
    name: 'o12-schema-v10-missing-matchlock-policy', expected: 'PASS',
    ddl: DDL_V10, schema: schemaRecord(SCHEMA_SHAPES.v10),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // A pre-union Matchlock-lineage store stamped 10: its runs table carries a
    // POPULATED matchlock_policy and is still accepted (extra columns are never
    // rejected). The v10 descriptor's runs universe does NOT include the
    // column, so the policy VALUE sub-check is NOT_APPLICABLE here — the
    // literal 'enforce' value proves the scope rule is universe membership and
    // not "the column exists".
    name: 'o12-schema-v10-matchlock-policy', expected: 'PASS',
    ddl: DDL_V10_MATCHLOCK, schema: schemaRecord(SCHEMA_SHAPES['v10-matchlock']),
    r1expected: 'PASS',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }), matchlockPolicy: 'enforce' });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v11 (REROUTE-BUDGET): steps.target_moved_reroute_count INTEGER DEFAULT 0.
    name: 'o12-schema-v11', expected: 'PASS',
    ddl: DDL_V11, schema: schemaRecord(SCHEMA_SHAPES.v11),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v12, MAIN lineage (OUTAGE-ROUNDS): preclaim_death_count present,
    // matchlock_policy absent.
    name: 'o12-schema-v12-main', expected: 'PASS',
    ddl: DDL_V12_MAIN, schema: schemaRecord(SCHEMA_SHAPES['v12-main']),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v12, MATCHLOCK lineage: runs.matchlock_policy present, no
    // target_moved_reroute_count / preclaim_death_count. This universe DOES
    // carry the column, so the policy VALUE sub-check runs — a complete valid
    // policy must stay green.
    name: 'o12-schema-v12-matchlock', expected: 'PASS',
    ddl: DDL_V12_MATCHLOCK, schema: schemaRecord(SCHEMA_SHAPES['v12-matchlock']),
    r1expected: 'PASS',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }), matchlockPolicy: VALID_MATCHLOCK_POLICY });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v12 carrying NEITHER lineage discriminator: unjudgeable ⇒ whole-oracle
    // ERROR naming the missing discriminator columns (exit 2, no evidence).
    name: 'o12-schema-v12-neither-lineage', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR',
    ddl: DDL_V12_NEITHER, schema: schemaRecord(SCHEMA_SHAPES['v12-neither']),
    build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); },
  },
  {
    // v13 with a NATIVE run: the union column is present and NULL (the INSERT
    // omits it, storing NULL) — VALID, counted as native, no finding.
    name: 'o12-schema-v13-native', expected: 'PASS',
    ddl: DDL_V13, schema: schemaRecord(SCHEMA_SHAPES.v13),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v13 with a complete, well-formed Matchlock policy ⇒ valid, no finding.
    name: 'o12-schema-v13-matchlock-present', expected: 'PASS',
    ddl: DDL_V13, schema: schemaRecord(SCHEMA_SHAPES.v13),
    r1expected: 'PASS',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }), matchlockPolicy: VALID_MATCHLOCK_POLICY });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // A present but malformed policy is judgeable PRODUCT data: finding
    // O12_SCHEMA_MATCHLOCK_POLICY_INVALID makes R1 FAIL (exit 1, evidence still
    // written) — never a whole-oracle ERROR, so a bad policy can never make the
    // store unjudgeable.
    name: 'o12-schema-v13-matchlock-invalid', expected: 'FAIL', finding: 'O12_SCHEMA_MATCHLOCK_POLICY_INVALID',
    ddl: DDL_V13, schema: schemaRecord(SCHEMA_SHAPES.v13),
    r1expected: 'FAIL',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }), matchlockPolicy: INVALID_MATCHLOCK_POLICY });
    },
  },
  {
    // v13 stamp missing steps.preclaim_death_count ⇒ whole-oracle ERROR.
    name: 'o12-schema-v13-missing-preclaim', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR',
    ddl: DDL_V13_MISSING_PRECLAIM, schema: schemaRecord(SCHEMA_SHAPES['v13-missing-preclaim']),
    build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); },
  },
  {
    // v13 stamp missing runs.matchlock_policy ⇒ whole-oracle ERROR.
    name: 'o12-schema-v13-missing-matchlock-policy', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR',
    ddl: DDL_V13_MISSING_MATCHLOCK, schema: schemaRecord(SCHEMA_SHAPES['v13-missing-matchlock']),
    build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); },
  },
  {
    // v14 (LEDGER-DIAG) ACCEPT: the runs/steps/stories core universe equals
    // v13's and the store carries the non-core suite_results.log_path column.
    name: 'o12-schema-v14-native', expected: 'PASS',
    ddl: DDL_V14, schema: schemaRecord(SCHEMA_SHAPES.v14),
    r1expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // v14 stamp missing steps.preclaim_death_count ⇒ whole-oracle ERROR (a v14
    // store still requires BOTH union columns).
    name: 'o12-schema-v14-missing-preclaim', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR',
    ddl: DDL_V14_MISSING_PRECLAIM, schema: schemaRecord(SCHEMA_SHAPES['v14-missing-preclaim']),
    build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); },
  },
  // An unknown schema version is a WHOLE-ORACLE ERROR (exit 2, no evidence):
  // the supported set is {9, 10, 11, 12, 13, 14} and anything outside it fails
  // closed rather than degrading to a leg-level NOT_EVALUABLE. 15 is the
  // unknown-version control now that 14 is supported; 8 pins the same rule
  // below the base schema. Both stores carry a complete union universe, so ONLY
  // the version stamp is out of range.
  { name: 'o12-schema-version-unsupported-15', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR', ddl: DDL_V14, schema: schemaRecord({ ...SCHEMA_SHAPES.v14, userVersion: 15 }), schemaOverride(db) { db.exec('PRAGMA user_version = 15'); }, build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); } },
  { name: 'o12-schema-version-unsupported', expected: 'ERROR', finding: 'ORACLE_RUNTIME_ERROR', schema: schemaRecord({ ...SCHEMA_SHAPES.v13, userVersion: 8 }), schemaOverride(db) { db.exec('PRAGMA user_version = 8'); }, build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); } },
  { name: 'o12-struct-missing-column', expected: 'ERROR', malformed: true },
  { name: 'o12-struct-missing-table', expected: 'ERROR', missingTable: true },
  {
    // A supported-version snapshot missing a DEPENDENT (non-core) table: core
    // presence is fail-closed (ERROR), but a missing dependent table means the
    // orphan probe for it cannot run — the matrix row must be recorded as a
    // NOT_EVALUABLE sub-check with present flags (never a silent skip), and R1
    // cannot PASS while an orphan probe it owns never ran.
    name: 'o12-struct-dependent-table-missing', expected: 'NOT_EVALUABLE',
    r1expected: 'NOT_EVALUABLE', r1SkippedSubCheck: 'suite_results',
    dropTable: 'suite_results',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
  },

  // ── R2 run_number negative controls ──
  { name: 'o12-run-number-duplicate', expected: 'FAIL', finding: 'O12_RUN_NUMBER_DUPLICATE', build(db) { insertRun(db, { id: RUN1, runNumber: 7 }); insertRun(db, { id: RUN2, runNumber: 7 }); } },
  { name: 'o12-run-number-null', expected: 'FAIL', finding: 'O12_RUN_NUMBER_NULL', build(db) { insertRun(db, { id: RUN1, runNumber: 1 }); insertRun(db, { id: RUN2 }); } },

  // ── R3 timestamp controls ──
  {
    name: 'o12-time-invalid', expected: 'FAIL', finding: 'O12_TIME_INVALID',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, created: 'not-a-timestamp' }); },
  },
  {
    name: 'o12-time-order', expected: 'FAIL', finding: 'O12_TIME_ORDER_VIOLATION',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, created: '2026-08-01T12:00:00.000Z', updated: '2026-08-01T11:59:00.000Z' }); },
  },
  {
    // Exact mirror of the real native product writer mix (JS toISOString
    // created_at + SQLite datetime('now') updated_at) — must be detected as a
    // TIME finding, never silently waived to manufacture green.
    name: 'o12-time-native-mixed', expected: 'FAIL', finding: 'O12_TIME_PAIR_FORMAT_MISMATCH',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, created: T, updated: NAIVE_LATER });
      insertRun(db, { id: RUN2, runNumber: 2, created: T, updated: NAIVE });
    },
  },
  {
    // Positive cross-timezone/order control: created_at in UTC ISO, updated_at
    // in an explicit +02:00 offset later instant. Both parse to valid instants
    // in the correct order; the format leg records the offset shape in the
    // inventory without a native-mix finding (no baseline → overall
    // NOT_EVALUABLE, R3 leg must PASS).
    name: 'o12-time-cross-timezone-valid', expected: 'NOT_EVALUABLE', r3expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, created: '2026-08-01T10:00:00.000Z', updated: '2026-08-01T12:00:00.000+02:00' }); },
  },
  {
    // Positive uniform SQLite-naive control: all timestamps in the product's
    // second native writer shape and correctly ordered.
    name: 'o12-time-uniform-sqlite', expected: 'NOT_EVALUABLE', r3expected: 'PASS',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, created: NAIVE, updated: NAIVE_LATER }); },
  },

  // ── R4 context controls ──
  { name: 'o12-context-unparseable', expected: 'FAIL', finding: 'O12_CONTEXT_UNPARSEABLE', build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: '{not json' }); } },
  { name: 'o12-context-type-invalid', expected: 'FAIL', finding: 'O12_CONTEXT_TYPE_INVALID', build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: '["array"]' }); } },
  {
    name: 'o12-reserved-overwrite', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    build(db) {
      // Host pinned repo='host-repo' (the other 16 keys were truly absent at
      // creation); the stored context shows an agent-overwritten repo.
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'agent-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
      });
    },
  },
  {
    // Exact-counter control: EIGHT divergent reserved keys on one run must
    // report overwrite_count 8 while the capped sample list stays at 5 — the
    // count source is never the capped sample list (regression pin for the
    // under-reporting bug where overwrite_count capped at 5). The complete v2
    // baseline also verifies the nine truly-absent keys (known absences), so
    // keys_checked is the full 17-key pin.
    name: 'o12-reserved-overwrite-many', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4OverwriteCount: 8, r4KeysChecked: 17, r4KeysExpectedAbsent: 9, r4KnownAbsencesChecked: 9,
    build(db) {
      insertRun(db, {
        id: RUN1, runNumber: 1,
        context: JSON.stringify({
          repo: 'agent-repo', working_directory_for_harness: 'agent-wd', task: 'agent-task',
          run_id: 'agent-run', workspace_mode: 'agent-mode', worktree_path: 'agent-wt',
          worktree_origin_repository: 'agent-origin', worktree_origin_sha: 'agent-sha',
        }),
      });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({
          repo: 'host-repo', working_directory_for_harness: 'host-wd', task: 'host-task',
          run_id: 'host-run', workspace_mode: 'host-mode', worktree_path: 'host-wt',
          worktree_origin_repository: 'host-origin', worktree_origin_sha: 'host-sha',
        }),
      });
    },
  },
  {
    // Host-managed transition accounted for: the native rewrite detector
    // legitimately writes test_cmd_review_* keys in-process; the typed v2
    // baseline (test_cmd_review_required present 'false' at creation) plus the
    // pinned expected-mutation (host transition to 'true') means the final
    // value is NOT an overwrite finding.
    name: 'o12-reserved-host-mutation', expected: 'PASS', r4expected: 'PASS', r4ReservedExpected: 'PASS',
    build(db) {
      insertRun(db, {
        id: RUN1, runNumber: 1,
        context: JSON.stringify({ repo: 'host-repo', test_cmd_review_required: 'true' }),
      });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence,
        { [RUN1]: fullExpectedEntry({ repo: 'host-repo', test_cmd_review_required: 'false' }) },
        { mutations: { [RUN1]: { test_cmd_review_required: mutationTo('true') } } });
    },
  },
  {
    // A writable baseline cannot pin host-owned values: the oracle must fail
    // closed rather than trust an input that an agent could have rewritten.
    name: 'o12-reserved-baseline-writable', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence, fixtureDir) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green' }) });
      fs.chmodSync(path.join(evidence, 'o12-reserved-baseline.json'), 0o644);
    },
  },
  {
    // Explicit host admission that references NO snapshot run: the admitted
    // run universe is entirely absent from the snapshot, so ZERO reserved-key
    // comparisons are possible. A zero-coverage admission proves nothing about
    // historical non-overwrite — the sub-leg is NOT_EVALUABLE (never a vacuous
    // PASS), with the admitted-but-absent runs surfaced in the record.
    name: 'o12-reserved-baseline-disjoint', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4AdmittedNotInSnapshotCount: 2,
    // The admitted universe covers ZERO snapshot rows, so the comparison never
    // covers the full snapshot: full_snapshot_covered false.
    r4FullSnapshotCovered: false,
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN4]: fullExpectedEntry({ repo: 'host-repo', task: 'host-task' }),
        [`run-${GHOST_RUN}`]: fullExpectedEntry({ repo: 'host-repo' }),
      }, {
        scope: { mode: 'explicit', run_ids: [RUN4, `run-${GHOST_RUN}`] },
      });
    },
  },
  {
    // Unparseable context WITH a present baseline: the parse failure is a real
    // product finding (FAIL leg), and the reserved-key sub-leg additionally
    // fails closed — a run whose stored context cannot be read back as an
    // object cannot be compared against its pinned baseline, so the sub-leg is
    // NOT_EVALUABLE rather than guessing.
    name: 'o12-context-unparseable-with-baseline', expected: 'FAIL',
    finding: 'O12_CONTEXT_UNPARSEABLE', r4expected: 'FAIL', r4ReservedExpected: 'NOT_EVALUABLE',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: '{not json' }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo', task: 'host-task' }) });
    },
  },

  // ── R5 serial composite-state controls ──
  {
    // Legal parked pair: verify_each stories-loop coordinator parked raw
    // running with current_story_id NULL + its DECLARED verifier pending.
    name: 'o12-serial-parked-positive', expected: 'NOT_EVALUABLE', r5expected: 'PASS',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, status: 'running' });
      insertStep(db, {
        id: STEP1, runId: RUN1, stepId: 'implement', status: 'running', type: 'loop',
        loopConfig: JSON.stringify({ over: 'stories', verify_each: true, verify_step: 'verify' }),
      });
      insertStep(db, { id: STEP2, runId: RUN1, stepId: 'verify', status: 'pending' });
    },
  },
  {
    // Active-story conflict: the loop is mid-story (current_story_id set) while
    // another step is simultaneously executable.
    name: 'o12-serial-active-story', expected: 'FAIL', finding: 'O12_SERIAL_COMPOSITE_VIOLATION',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, status: 'running' });
      insertStory(db, { id: STORY1, runId: RUN1, status: 'running' });
      insertStep(db, {
        id: STEP1, runId: RUN1, stepId: 'implement', status: 'running', type: 'loop',
        currentStoryId: STORY1,
        loopConfig: JSON.stringify({ over: 'stories', verify_each: true, verify_step: 'verify' }),
      });
      insertStep(db, { id: STEP2, runId: RUN1, stepId: 'verify', status: 'pending' });
    },
  },
  {
    // Unrelated pending/running steps: two single steps simultaneously
    // executable without any declared verify_each ownership.
    name: 'o12-serial-unrelated', expected: 'FAIL', finding: 'O12_SERIAL_COMPOSITE_VIOLATION',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, status: 'running' });
      insertStep(db, { id: STEP1, runId: RUN1, stepId: 'plan', status: 'pending' });
      insertStep(db, { id: STEP2, runId: RUN1, stepId: 'setup', status: 'running' });
    },
  },
  {
    // Merely-named verifier (cross-run / ownership mismatch): a parked-looking
    // loop whose executable second step is NOT its declared verifier.
    name: 'o12-serial-wrong-owner', expected: 'FAIL', finding: 'O12_SERIAL_COMPOSITE_VIOLATION',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, status: 'running' });
      insertStep(db, {
        id: STEP1, runId: RUN1, stepId: 'implement', status: 'running', type: 'loop',
        loopConfig: JSON.stringify({ over: 'stories', verify_each: true, verify_step: 'verify' }),
      });
      insertStep(db, { id: STEP2, runId: RUN1, stepId: 'audit', status: 'pending' });
    },
  },
  {
    // True cross-run ownership mismatch: the declared verifier ('verify') is
    // executable (pending) in ANOTHER running run, while the parked loop's own
    // run pairs it with an undeclared step ('audit'). Ownership is run-scoped
    // (native claim SQL pins vloop.run_id = s.run_id) — the cross-run 'verify'
    // must NOT legitimize run A's illegal pair, and run B's lone executable
    // must not itself be a violation. The violation is attributed to run A.
    name: 'o12-serial-cross-run-verifier', expected: 'FAIL', finding: 'O12_SERIAL_COMPOSITE_VIOLATION',
    r5expected: 'FAIL',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, status: 'running' });
      insertStep(db, {
        id: STEP1, runId: RUN1, stepId: 'implement', status: 'running', type: 'loop',
        loopConfig: JSON.stringify({ over: 'stories', verify_each: true, verify_step: 'verify' }),
      });
      insertStep(db, { id: STEP2, runId: RUN1, stepId: 'audit', status: 'pending' });
      // The merely-named verifier lives in another run — never an owner.
      insertRun(db, { id: RUN2, runNumber: 2, status: 'running' });
      insertStep(db, { id: STEP3, runId: RUN2, stepId: 'verify', status: 'pending' });
    },
  },

  // ── O12-CLOSE correction-A controls: complete independently admitted scope ──
  {
    // Root counterexample 1 mirror (legacy v1): DB carries three runs but the
    // legacy baseline pins only RUN1's four keys. Legacy incomplete v1 can
    // never become full PASS: keys it does not enumerate assert nothing, and
    // RUN2/RUN3 have no captured expectations, so reserved-key coverage is
    // unavailable → NOT_EVALUABLE (never a silent full-state PASS).
    name: 'o12-close-legacy-partial-scope', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4KeysUnassertedTotal: 13, r4RunsWithoutEntryCount: 2,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT });
      insertRun(db, { id: RUN2, runNumber: 2 });
      insertRun(db, { id: RUN3, runNumber: 3 });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, { [RUN1]: { repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green' } });
    },
  },
  {
    // Root counterexample 2 mirror: a complete v2 baseline for RUN1 only while
    // the default scope covers all three snapshot runs (RUN2's stored repo/task
    // are unverified and RUN3 has no expectations at all) → NOT_EVALUABLE.
    name: 'o12-close-partial-run-baseline', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4RunsWithoutEntryCount: 2,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT });
      insertRun(db, { id: RUN2, runNumber: 2, context: JSON.stringify({ repo: 'unverified-repo', task: 'unverified-task' }) });
      insertRun(db, { id: RUN3, runNumber: 3 });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo', task: 'host-task', run_id: RUN1, merge_gate: 'green' }),
      });
    },
  },
  {
    // Root counterexample 3 mirror: v1 baseline enumerates ONLY RUN1.repo
    // (which matches) while RUN1.task/merge_gate and RUN2/RUN3 stay
    // unverified → NOT_EVALUABLE (partial-key baseline can never PASS).
    name: 'o12-close-partial-key-baseline', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4KeysUnassertedTotal: 16, r4RunsWithoutEntryCount: 2,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo', task: 'unverified-task', run_id: RUN1, merge_gate: 'off' }) });
      insertRun(db, { id: RUN2, runNumber: 2, context: JSON.stringify({ repo: 'unverified-repo', task: 'unverified-task' }) });
      insertRun(db, { id: RUN3, runNumber: 3 });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, { [RUN1]: { repo: 'host-repo' } });
    },
  },
  {
    // Root counterexample 4 mirror: baseline carries ONLY a non-reserved key.
    // Non-reserved dictionary keys NEVER count as reserved coverage, so zero
    // reserved-key comparisons are possible → NOT_EVALUABLE (keys_checked 0).
    name: 'o12-close-non-reserved-only-baseline', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4KeysChecked: 0, r4NonReservedIgnored: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ unrelated: 'matches', repo: 'unverified-repo', task: 'unverified-task' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, { [RUN1]: { unrelated: 'matches' } });
    },
  },
  {
    // A partial v2 per-run entry (only one of the 17 pin keys enumerated) is
    // schema-valid but coverage-incomplete: the asserted key matches, the
    // other 16 keys are unasserted → NOT_EVALUABLE with keys_unasserted_total.
    name: 'o12-close-v2-partial-key-entry', expected: 'NOT_EVALUABLE',
    r4expected: 'NOT_EVALUABLE', r4ReservedExpected: 'NOT_EVALUABLE',
    r4KeysUnassertedTotal: 16, r4RunsPartialEntryCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: { repo: entryPresent('host-repo') },
      });
    },
  },
  {
    // Genuinely complete current scoped baseline that stays PASS with a valid
    // canonical-alias scope key AND a known-empty-string value.
    name: 'o12-close-empty-string-match', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4KeysChecked: 17, r4EmptyStringPresentMatches: 1, r4KnownAbsencesChecked: 16,
    r4FullSnapshotCovered: true,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ merge_gate: '' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [`run-${RUN1}`]: fullExpectedEntry({ merge_gate: '' }) });
    },
  },
  {
    // Empty strings are distinct from missing keys and other values: baseline
    // proved merge_gate was the empty string, the stored value is 'green' →
    // demonstrated divergence → FAIL.
    name: 'o12-close-empty-string-divergence', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ merge_gate: 'green' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ merge_gate: '' }) });
    },
  },
  {
    // Introduced reserved key where the baseline PROVED absence: repo was
    // host-captured absent at creation, the final context carries it, and no
    // host-managed transition accounts for it → FAIL (kind key-introduced).
    name: 'o12-close-key-introduced', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({}) });
    },
  },
  {
    // Reserved key removed: baseline pinned repo present 'host-repo', the
    // final context no longer carries it, and no host removal is recorded →
    // FAIL (kind key-removed).
    name: 'o12-close-key-removed', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: '{}' });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // Incomplete coverage mixed with a genuine finding: RUN2 has no captured
    // expectations (a gap) but RUN1 shows a demonstrated overwrite. FAIL
    // dominates NOT_EVALUABLE — the concrete finding survives the missing leg.
    name: 'o12-close-finding-survives-gap', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    r4RunsWithoutEntryCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'agent-repo' }) });
      insertRun(db, { id: RUN2, runNumber: 2, context: '{}' });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) });
    },
  },
  {
    // Legitimate host-managed removal, recorded in the pinned ledger: repo was
    // present at creation and the host later removed it (presence change
    // present→absent) — final absence matches the ledger → PASS.
    name: 'o12-close-mutation-removal-positive', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: '{}' });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence,
        { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) },
        { mutations: { [RUN1]: { repo: mutationRemove() } } });
    },
  },
  {
    // Legitimate host-managed introduction, recorded in the pinned ledger:
    // repo was absent at creation and the host later added it (presence change
    // absent→present with the exact value) → PASS.
    name: 'o12-close-host-introduced-key-positive', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4HostTransitionMatches: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence,
        { [RUN1]: fullExpectedEntry({}) },
        { mutations: { [RUN1]: { repo: mutationTo('host-repo') } } });
    },
  },
  {
    // Explicit host-admitted scope (smaller than the snapshot) is supported and
    // REPORTED: RUN1 is fully verified (PASS) while RUN2 — even though it
    // carries a divergent reserved key — is outside the admitted universe and
    // surfaced as such in the coverage record (never a quiet escape).
    name: 'o12-close-scope-explicit-positive', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4ScopeOutsideCount: 1, r4RunsCompared: 1,
    // The subset PASS is unmistakably SCOPED: RUN2 is outside the admission, so
    // full_snapshot_covered is false (a subset PASS never claims full-state
    // integrity) — all-snapshot qualification would require ALL rows × ALL 17.
    r4FullSnapshotCovered: false,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
      insertRun(db, { id: RUN2, runNumber: 2, context: JSON.stringify({ repo: 'agent-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
      }, { scope: { mode: 'explicit', run_ids: [RUN1] } });
    },
  },
  {
    // Reviewer-issue corner (do-again): an EXPLICIT admission that covers the
    // whole snapshot AND ALSO names an admitted-but-absent (ghost) run, with
    // every snapshot row fully compared over the ENTIRE 17-key pin
    // (runs_compared 1, keys_checked 17). lib/o12.mjs's documented semantics
    // forbid any admitted-but-absent run in explicit mode, so
    // full_snapshot_covered stays FALSE even though the compared rows/keys
    // totals are whole — a naive test-side mirror computed from
    // runs_compared/keys_checked alone would expect true here and mis-flag
    // correct lib behavior. The mirror in o12.test.mjs reproduces the exact
    // lib predicate (in-scope equality + no ghost in explicit mode) and this
    // fixture pins the corner.
    name: 'o12-close-scope-explicit-ghost-fully-compared', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4AdmittedNotInSnapshotCount: 1,
    r4RunsCompared: 1, r4RunsFullyExpected: 1, r4KeysChecked: 17,
    r4FullSnapshotCovered: false,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
        [`run-${GHOST_RUN}`]: fullExpectedEntry({}),
      }, {
        scope: { mode: 'explicit', run_ids: [RUN1, `run-${GHOST_RUN}`] },
      });
    },
  },
  {
    // Legacy v1 COMPLETE authoritative data may still PASS: every in-scope run
    // enumerates the ENTIRE pin with string values that match the stored
    // context. (v1 can only assert presence-with-value — this fixture is the
    // migration-complete case, distinct from partial v1 which must NOT
    // evaluate.)
    name: 'o12-close-v1-complete-positive', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4KeysChecked: 17, r4RunsCompared: 1,
    build(db) {
      insertRun(db, {
        id: RUN1, runNumber: 1,
        context: JSON.stringify({
          repo: 'host-repo', working_directory_for_harness: '/wd', task: 'host-task', run_id: RUN1,
          workspace_mode: 'direct', worktree_path: '', worktree_origin_repository: '/origin',
          worktree_origin_ref: 'main', worktree_origin_sha: 'abcd', original_branch: '',
          merge_gate: 'green', fail_missing: 'off', test_cmd_raw: 'npm test',
          test_cmd_review_required: 'true', test_cmd_review_candidate: 'npm run build',
          test_cmd_review_established: 'npm test', test_cmd_rewriter_step: 'setup',
        }),
      });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, {
        [RUN1]: {
          repo: 'host-repo', working_directory_for_harness: '/wd', task: 'host-task', run_id: RUN1,
          workspace_mode: 'direct', worktree_path: '', worktree_origin_repository: '/origin',
          worktree_origin_ref: 'main', worktree_origin_sha: 'abcd', original_branch: '',
          merge_gate: 'green', fail_missing: 'off', test_cmd_raw: 'npm test',
          test_cmd_review_required: 'true', test_cmd_review_candidate: 'npm run build',
          test_cmd_review_established: 'npm test', test_cmd_rewriter_step: 'setup',
        },
      });
    },
  },
  {
    // A legacy partial v1 with an ASSERTED divergence still surfaces the
    // concrete finding (FAIL dominates the coverage gaps from its unasserted
    // keys).
    name: 'o12-close-v1-partial-finding-survives', expected: 'FAIL', finding: 'O12_RESERVED_KEY_OVERWRITE',
    r4expected: 'FAIL', r4ReservedExpected: 'FAIL', r4OverwriteCount: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'agent-repo', task: 'host-task' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, { [RUN1]: { repo: 'host-repo', task: 'host-task' } });
    },
  },
  {
    // Malformed v2 expected entry: unknown presence representation → ERROR.
    name: 'o12-close-v2-bad-presence', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: { repo: { presence: 'maybe', provenance: 'host' } } });
    },
  },
  {
    // Malformed v2 expected entry: a non-reserved key inside the expected map
    // can never be reserved coverage → ERROR (the input is not canonical v2).
    name: 'o12-close-v2-unknown-key', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: { unrelated: entryPresent('x') } });
    },
  },
  {
    // Malformed v2 expected entry: presence present without a string value
    // (values, missing keys and empty strings are the only distinct states) →
    // ERROR.
    name: 'o12-close-v2-value-not-string', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: { repo: { presence: 'present', value: 42, provenance: 'host' } } });
    },
  },
  {
    // Malformed v2 expected entry: presence absent cannot carry a value → ERROR.
    name: 'o12-close-v2-absent-with-value', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: { repo: { presence: 'absent', value: 'x', provenance: 'host' } } });
    },
  },
  {
    // Ambiguous duplicate/cross-scope alias binding: the same run appears under
    // its bare id AND its run-<uuid> alias in one expected map → ERROR.
    name: 'o12-close-alias-duplicate', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
        [`run-${RUN1}`]: fullExpectedEntry({ repo: 'host-repo' }),
      });
    },
  },
  {
    // Malformed run id reference in the baseline → ERROR.
    name: 'o12-close-invalid-run-id', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { ['not-a-run-id']: fullExpectedEntry({}) });
    },
  },
  {
    // Malformed mutation ledger: a non-host source can never legitimize a
    // divergence → ERROR.
    name: 'o12-close-mutation-agent-source', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence,
        { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) },
        { mutations: { [RUN1]: { repo: { presence: 'present', value: 'agent-repo', source: 'agent' } } } });
    },
  },
  {
    // Malformed mutation ledger: unknown presence representation → ERROR.
    name: 'o12-close-mutation-bad-presence', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence,
        { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) },
        { mutations: { [RUN1]: { repo: { presence: 'sometimes', source: 'host' } } } });
    },
  },
  {
    // Wrong producer: only host-produced inputs are oracle truth → ERROR.
    name: 'o12-close-baseline-wrong-producer', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({ repo: 'host-repo' }) }, { producer: 'agent' });
    },
  },
  {
    // Drifted supported_reserved_keys: the sidecar no longer matches the pinned
    // native set → ERROR (a drifted pin cannot be trusted).
    name: 'o12-close-supported-keys-drift', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({}) },
        { supportedKeys: RESERVED_KEY_LIST.filter((key) => key !== 'repo') });
    },
  },
  {
    // Unknown scope mode → ERROR (a scope that is not host-declared
    // all-snapshot or explicit cannot be judged).
    name: 'o12-close-scope-mode-invalid', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, { [RUN1]: fullExpectedEntry({}) }, { scope: { mode: 'guess' } });
    },
  },
  {
    // Unsupported baseline schema_version → ERROR.
    name: 'o12-close-schema-unsupported', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: GREEN_CONTEXT }); },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, { [RUN1]: { repo: 'host-repo' } }, { schema_version: 3 });
    },
  },

  // ── Reviewer-issue controls (do-again round): cross-scope hardening + stale
  //    baseline observability ─────────────────────────────────────────────────
  {
    // Issue-one negative: v2 EXPLICIT mode, an expected entry for a run NOT in
    // scope.run_ids is a cross-scope binding — before this control it was
    // silently ignored (the in-scope loop never reached it); now it is a
    // malformed input → ERROR.
    name: 'o12-close-explicit-expected-outside-admission', expected: 'ERROR',
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
      insertRun(db, { id: RUN2, runNumber: 2, context: JSON.stringify({ repo: 'agent-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
        [RUN2]: fullExpectedEntry({ repo: 'agent-repo' }),
      }, { scope: { mode: 'explicit', run_ids: [RUN1] } });
    },
  },
  {
    // Issue-one negative: v2 EXPLICIT mode, an expected_mutations ledger entry
    // for a run NOT in scope.run_ids is a cross-scope binding → ERROR (never
    // silently ignored).
    name: 'o12-close-explicit-mutation-outside-admission', expected: 'ERROR',
    build(db) { insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) }); },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
      }, {
        scope: { mode: 'explicit', run_ids: [RUN1] },
        mutations: { [RUN2]: { repo: mutationTo('x') } },
      });
    },
  },
  {
    // Issue-two control (v2 default mode): the baseline expected set is a
    // SUPERSET of the snapshot (RUN3 was host-captured but is absent from the
    // snapshot — deleted after capture). Every in-snapshot run is fully
    // compared and matches, so the leg PASSes, and the stale expected run is
    // surfaced in the default-mode scope record
    // (expected_runs_not_in_snapshot_count 1 + samples) instead of vanishing.
    name: 'o12-close-default-expected-superset', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4ExpectedNotInSnapshotCount: 1, r4RunsCompared: 2,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
      insertRun(db, { id: RUN2, runNumber: 2, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
        [RUN2]: fullExpectedEntry({ repo: 'host-repo' }),
        [RUN3]: fullExpectedEntry({ repo: 'host-repo' }),
      });
    },
  },
  {
    // Issue-two control (v1 default mode): complete authoritative v1 baseline
    // for both in-snapshot runs plus a stale RUN3 entry. In-snapshot coverage
    // is complete → PASS; the stale RUN3 baseline run is surfaced in the scope
    // record (regression pin for the pre-close baseline_runs_not_in_snapshot
    // surfacing that v1 default mode had lost).
    name: 'o12-close-v1-expected-superset', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4ExpectedNotInSnapshotCount: 1, r4RunsCompared: 1,
    build(db) {
      insertRun(db, {
        id: RUN1, runNumber: 1,
        context: JSON.stringify({
          repo: 'host-repo', working_directory_for_harness: '/wd', task: 'host-task', run_id: RUN1,
          workspace_mode: 'direct', worktree_path: '', worktree_origin_repository: '/origin',
          worktree_origin_ref: 'main', worktree_origin_sha: 'abcd', original_branch: '',
          merge_gate: 'green', fail_missing: 'off', test_cmd_raw: 'npm test',
          test_cmd_review_required: 'true', test_cmd_review_candidate: 'npm run build',
          test_cmd_review_established: 'npm test', test_cmd_rewriter_step: 'setup',
        }),
      });
    },
    baseline(evidence) {
      writeReservedBaselineV1(evidence, {
        [RUN1]: {
          repo: 'host-repo', working_directory_for_harness: '/wd', task: 'host-task', run_id: RUN1,
          workspace_mode: 'direct', worktree_path: '', worktree_origin_repository: '/origin',
          worktree_origin_ref: 'main', worktree_origin_sha: 'abcd', original_branch: '',
          merge_gate: 'green', fail_missing: 'off', test_cmd_raw: 'npm test',
          test_cmd_review_required: 'true', test_cmd_review_candidate: 'npm run build',
          test_cmd_review_established: 'npm test', test_cmd_rewriter_step: 'setup',
        },
        [RUN3]: { repo: 'host-repo' },
      });
    },
  },
  {
    // Issue-two exact-total control (v2 default mode): TWELVE stale expected
    // runs (RUN2..RUN13 all absent from the snapshot) while RUN1 is fully
    // covered and matches. expected_runs_not_in_snapshot_count must be the
    // exact 12 even though the samples list stays capped at 10 (the same
    // exact-total-vs-bounded-samples discipline every O12 counter follows).
    name: 'o12-close-default-many-stale-expected', expected: 'PASS',
    r4expected: 'PASS', r4ReservedExpected: 'PASS',
    r4ExpectedNotInSnapshotCount: 12, r4RunsCompared: 1,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1, context: JSON.stringify({ repo: 'host-repo' }) });
    },
    baseline(evidence) {
      const stale = {};
      for (const runId of [RUN2, RUN3, RUN4, RUN5, RUN6, RUN7, RUN8, RUN9, RUN10, RUN11, RUN12, RUN13]) {
        stale[runId] = fullExpectedEntry({ repo: 'host-repo' });
      }
      writeReservedBaselineV2(evidence, {
        [RUN1]: fullExpectedEntry({ repo: 'host-repo' }),
        ...stale,
      });
    },
  },

  // ── O12-CLOSE correction-B controls: exact totals vs bounded examples ──────
  {
    // SEVEN orphaned run_worktrees exist; R1 must report orphan_count 7 (the
    // exact total) even though the emitted findings/examples stay capped.
    name: 'o12-close-seven-orphans-count', expected: 'FAIL', finding: 'O12_STRUCT_ORPHAN',
    r1expected: 'FAIL', r1ExactOrphanCount: 7,
    build(db) {
      insertRun(db, { id: RUN1, runNumber: 1 });
      const insert = db.prepare(
        'INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, status, cleanup_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < 7; i += 1) {
        insert.run(`root-orphan-${i}`, '/synthetic/repo', '/synthetic/repo/.git', `/synthetic/wt/${i}`, 'kept', 'keep', T);
      }
    },
  },
  {
    // SEVEN unparseable contexts: parse_failure_count must be the exact 7 even
    // though only 5 representative findings are emitted.
    name: 'o12-close-many-parse-failures', expected: 'FAIL', finding: 'O12_CONTEXT_UNPARSEABLE',
    r4expected: 'FAIL', r4ParseFailureCount: 7,
    build(db) {
      const ids = [RUN1, RUN2, RUN3, RUN4, RUN5, RUN6, RUN7];
      for (let i = 0; i < ids.length; i += 1) {
        insertRun(db, { id: ids[i], runNumber: i + 1, context: '{not json' });
      }
    },
  },
  {
    // SEVEN non-object contexts: type_failure_count must be the exact 7 even
    // though only 5 representative findings are emitted.
    name: 'o12-close-many-type-failures', expected: 'FAIL', finding: 'O12_CONTEXT_TYPE_INVALID',
    r4expected: 'FAIL', r4TypeFailureCount: 7,
    build(db) {
      const ids = [RUN1, RUN2, RUN3, RUN4, RUN5, RUN6, RUN7];
      for (let i = 0; i < ids.length; i += 1) {
        insertRun(db, { id: ids[i], runNumber: i + 1, context: '["array"]' });
      }
    },
  },
];

for (const fixture of CASES) {
  const { campaign, snapshots, evidence, databasePath } = beginFixture(fixture.name);
  const database = new DatabaseSync(databasePath);
  try {
    if (fixture.missingTable) {
      // Structurally malformed snapshot: no core tables at all.
      database.exec(`PRAGMA user_version = ${fixture.schema?.user_version ?? 13}`);
    } else {
      // Default DDL is the CURRENT v13 product schema; every other fixture
      // names the DDL for its own version/lineage shape.
      database.exec(fixture.ddl ?? DDL);
      // Disable FK enforcement on the WRITER connection so calibration
      // fixtures can deliberately embed foreign_key_check violations; the
      // oracle later reads the immutable file read-only and reports them.
      database.exec('PRAGMA foreign_keys = OFF');
      if (fixture.dropTable) {
        // Deliberately drop a DEPENDENT (non-core) table so the orphan matrix
        // sub-check for it is recorded NOT_EVALUABLE instead of silently
        // skipped (calibration-only; raw SQL on a fresh owned copy).
        database.exec(`DROP TABLE IF EXISTS ${fixture.dropTable}`);
      }
      database.prepare("INSERT INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)").run();
      if (fixture.schemaOverride) fixture.schemaOverride(database);
      if (fixture.build) fixture.build(database);
      if (fixture.malformed) {
        // o12-struct-missing-column: drop run_number from runs so the oracle
        // fails closed (ERROR) instead of passing vacuously.
        database.exec('ALTER TABLE runs DROP COLUMN run_number');
      }
    }
  } finally {
    database.close();
  }
  if (fixture.baseline) fixture.baseline(evidence);
  finishFixture({ fixture, campaign, evidence, databasePath });
}

// Retained-workspace receipt (never rmSync a generated workspace): records the
// exact fixture set so a standalone generator run is replayable. The gate
// (o12.test.mjs) adds its own gate-receipt.json alongside this one. The
// supported-version list is the ORACLE's own frozen constant (never re-typed),
// and default_user_version is the shape the default DDL stamps.
const workspaceIdentity = fs.lstatSync(workspace);
fs.writeFileSync(path.join(workspace, 'generation-receipt.json'), `${JSON.stringify({
  kind: 'o12-fixture-generation-receipt',
  root: workspace,
  ownership: { dev: workspaceIdentity.dev, ino: workspaceIdentity.ino },
  fixture_count: CASES.length,
  fixtures: CASES.map((fixture) => fixture.name),
  default_user_version: SCHEMA_SHAPES.v13.userVersion,
  supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
  retained: 'retained intentionally; no recursive filesystem disposal performed by the generator',
}, null, 2)}\n`, { flag: 'wx' });

process.stdout.write(`generated ${CASES.length} O12 fixtures under ${workspace}\n`);
