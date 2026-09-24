// O12 — DB-integrity oracle (torture-only, post-batch; NOT a campaign gate).
//
// Spec: torture-test/tamandua-torture-test-spec/03-oracles.md §"O12 — DB
// invariants (post-batch)".
//
// Scope decision (Storm O12): O12 is a post-batch hygiene oracle, not a tenth
// campaign-gating hook. GATING_ORACLE_IDS stays exactly
// [O1,O2,O3z,O4,O8,O9,O10,O11,O16]. O12 is registered only through
// REQUIRED_ORACLE_EVIDENCE.O12 (this one DB snapshot leg) in
// torture-test/bin/oracle-context.mjs so the shared v1 invocation loader can
// validate an O12 context; it consumes NO new mechanical_evidence key (adding
// one would be a contract-version change affecting the nine gating hooks — see
// torture-test/oracles/CONTRACT.md). The one O12-specific host-owned input
// (the reserved-key baseline/probe record) rides as a sidecar file in the
// oracle evidence directory (`o12-reserved-baseline.json`) or via the
// TT_O12_BASELINE env var, and is documented in this module and in the
// published storm-o12-contract.json deliverable.
//
// Read-only guarantee: the oracle only ever opens the controller-provided
// immutable database_snapshot through openEvidenceDatabase (node:sqlite
// { readOnly:true }, writable-file check, SHA-256 pinned by the shared
// context loader). It never opens the product DB through getDb()/migrate()
// and never mutates the snapshot. Evidence is written with the shared
// exclusive-create contained writer under TT_ORACLE_EVIDENCE_DIR.
//
// Legs (each with an explicit per-obligation coverage record; a leg that
// cannot be judged is NOT_EVALUABLE, never silently PASS):
//   R1 structural integrity + orphans          (spec O12 clause 1;
//      + the v13/Matchlock-lineage matchlock_policy value sub-check)
//   R2 run_number uniqueness (live rows)       (spec O12 clause 2)
//   R3 timestamp shape / instant / ordering    (spec O12 clause 3)
//   R4 context JSON parse/type + reserved keys (spec O12 clause 4)
//   R5 serial-pipeline composite-state rule    (spec O12 clause 5)
//   R6 per-obligation coverage/result record   (spec O12 clause 6)
//
// R1 records every orphan-matrix row with its own status (PASS/FAIL/
// NOT_EVALUABLE) and table/column present flags: an absent child/parent table
// or column is a visible NOT_EVALUABLE sub-check, never a silent skip, so R1
// cannot vacuous-PASS with an orphan probe that never ran. Exact totals are
// never derived from capped sample arrays: R1 orphan_count, R4 parse/
// type/overwrite counters and every other *_count report the FULL total while
// *_samples stay bounded (≤5).
//
// Schema chain (O12-SCHEMA-14, STORM-AGED-FULL): the supported snapshot schema
// set mirrors the product src/db.ts union chain 9..14 (see
// O12_SUPPORTED_SCHEMA_VERSIONS; v14 = v13 + LEDGER-DIAG suite_results.log_path).
// R1 resolves the descriptor for the snapshot's PRAGMA user_version —
// classifying the DUAL v12 lineage from the store's ACTUAL column shape exactly
// like the product's detectSchemaLineage() — and judges the version's required
// columns plus the declared type/default of every version-added column (from
// PRAGMA table_info). A declared-shape mismatch is a judgeable PRODUCT finding
// (O12_SCHEMA_COLUMN_DECLARATION_MISMATCH) that makes R1 FAIL; a version or
// shape this build cannot judge (unknown user_version, a v12 stamp carrying
// neither lineage discriminator, a v13 store missing either union column) fails
// closed as whole-oracle ERROR. The structural observation records user_version,
// supported_user_versions, the observed lineage and its discriminator columns.
//
// runs.matchlock_policy value sub-check (O12-SCHEMA-13): for a store whose
// version universe carries that column (v13, and the Matchlock-lineage v12
// shapes matchlock-v12 / v12-superset) R1 additionally validates the
// host-owned Matchlock execution-isolation policy stored as JSON on every run
// row. NULL is the NATIVE (non-Matchlock) case and is VALID — reported as a
// separate native count, never as an invalid policy. A present value that is
// not parseable JSON, is not a JSON object, lacks a required key, carries an
// unknown key or a wrong version/backend/enum value, or carries a
// credential-bearing key is judgeable PRODUCT data: it produces finding
// O12_SCHEMA_MATCHLOCK_POLICY_INVALID and makes R1 FAIL (exit 1, evidence
// written) — it never throws, so a malformed policy can never make the whole
// store unjudgeable. The required-key set is derived READ-ONLY from the union
// port's src/installer/matchlock/policy.ts (matchlockPolicyValidationErrors /
// MATCHLOCK_POLICY_VERSION — see O12_MATCHLOCK_POLICY_REQUIRED_KEYS). The
// counters follow the O12 exact-total discipline: policies_checked /
// valid_policies / native_runs / invalid_policy_count are FULL totals over
// every run row of the universe, kept separate from the bounded (≤5)
// representative sample list. The check is an R1 SUB-CHECK — the R1..R6 leg
// shape is unchanged. A universe without the column records the sub-check as
// NOT_APPLICABLE (never silently skipped) and is never failed by it.
//
// R4 reserved-key scope contract (Storm O12-close): the DEFAULT post-batch
// scope is EVERY snapshot run — a baseline can never choose its own smaller
// denominator and label full-state integrity PASS. A smaller scope is
// supported ONLY as an explicit host admission (`scope.mode: "explicit"` +
// `scope.run_ids`), reported as such (`snapshot_runs_outside_admitted_scope`),
// never a quiet escape. In explicit mode the admitted universe is the ONLY
// legal run set for the baseline's own coverage: an expected or
// expected_mutations entry naming a run outside scope.run_ids is a malformed
// cross-scope binding → ERROR (never silently ignored). In default mode a
// baseline may name runs absent from the snapshot (deleted after capture);
// those stale expectations are surfaced in the scope record
// (`expected_runs_not_in_snapshot_count/_samples`) instead of vanishing. For
// every in-scope run the host must supply captured typed presence/absence for
// the ENTIRE native reserved-key pin:
//   - schema_version 1 (legacy): enumerating a key only asserts PRESENT-with-
//     that-value; an unenumerated key asserts nothing ("no key supplied" is
//     never proof the key was originally absent). Incomplete v1 can never
//     PASS — only complete authoritative v1 data may (legacy migration rule).
//   - schema_version 2 (current): every in-scope run carries typed
//     presence/absence per pin key ({ presence: present|absent, value?,
//     provenance: "host" }); values, missing keys and empty strings are
//     distinct states.
// Malformed supplied input (bad JSON/schema/presence/provenance/alias
// duplicates/non-reserved keys/wrong producer/drifted key set/unknown scope/
// cross-scope expected-or-mutation bindings outside the admitted universe)
// is ERROR; unavailable coverage is NOT_EVALUABLE; demonstrated divergence is
// FAIL. FAIL dominates NOT_EVALUABLE, so a concrete finding on one run
// survives another run's missing coverage. Explicit legitimate host-managed
// transitions live in the pinned expected_mutations ledger (including
// presence changes when truly recorded). Non-reserved dictionary keys never
// count as reserved coverage. Full-coverage metrics count distinct
// runs/keys/known absences accurately.
//
// Overall mapping: any FAIL leg ⇒ FAIL; else any NOT_EVALUABLE leg ⇒
// NOT_EVALUABLE; else PASS. FAIL dominates so a concrete product finding is
// never hidden behind a missing leg (spec 03 taxonomy: findings survive even
// when another leg is unavailable).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';
import { requireContainedPath } from './paths.mjs';

// Supported snapshot schema versions. Mirrors the product src/db.ts
// SCHEMA_VERSION chain (MATCHLOCK-UNION-4 + LEDGER-DIAG: ONE chain, ending at
// 14 — the pre-union main and Matchlock lineages each claimed a version for
// their own column and the union renumbers them):
//   v9  — the base schema (src/db.ts applySchema CREATE TABLE set).
//   v10 — TIME-STORAGE: migrateInstantsToIsoZ() rewrites every stored naive
//         `YYYY-MM-DD HH:MM:SS` instant to ISO-8601 UTC. NO column is added:
//         the v10 column universe IS the v9 universe. (CORRECTION — this O12
//         build previously read v10 as the Matchlock branch's own
//         `runs.matchlock_policy` bump. In the union chain that column is the
//         12->13 step, so a v10 stamp no longer requires it; a v10 store that
//         carries it anyway is still accepted, because descriptors state
//         REQUIRED columns and extra columns are never rejected.)
//   v11 — REROUTE-BUDGET: steps.target_moved_reroute_count (INTEGER DEFAULT 0).
//   v12 — OUTAGE-ROUNDS: steps.preclaim_death_count (INTEGER NOT NULL
//         DEFAULT 0). DUAL LINEAGE: the pre-union Matchlock branch stamped
//         `PRAGMA user_version = 12` for a DIFFERENT column, so a v12 stamp is
//         classified by its ACTUAL column shape (mirroring the product's
//         detectSchemaLineage()):
//           preclaim present + matchlock absent → main-v12
//           matchlock present + preclaim absent → matchlock-v12
//           both present                        → v12-superset
//           neither present                     → whole-oracle ERROR
//   v13 — MATCHLOCK-UNION-4: runs.matchlock_policy (TEXT, nullable) joins the
//         chain. A v13 store must carry BOTH union columns (and the v11/v12
//         chain columns); missing either is a whole-oracle ERROR.
//   v14 — LEDGER-DIAG: suite_results.log_path TEXT (nullable; the absolute
//         path of the full suite log). The column lives on the NON-core
//         suite_results table, so the v14 runs/steps/stories core universe IS
//         the v13 universe; a v14 store must still carry BOTH union columns
//         (runs.matchlock_policy AND steps.preclaim_death_count). The column
//         itself is a product fact (src/ is never touched by this oracle).
// A snapshot whose PRAGMA user_version is outside this set cannot be judged
// against ANY descriptor: the whole oracle fails closed as an ERROR (exit 2,
// no evidence artifact) naming the observed version and this supported set —
// it is never NOT_EVALUABLE and never PASS.
export const O12_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([9, 10, 11, 12, 13, 14]);

// RESERVED_CONTEXT_KEYS — pinned mirror of the native set in
// src/installer/step-ops.ts. Agents can never overwrite these keys through
// parseOutputKeyValues merges. The calibration gate statically asserts parity
// with the native source literal so the pin cannot silently drift.
export const O12_RESERVED_CONTEXT_KEYS = Object.freeze([
  'repo',
  'working_directory_for_harness',
  'task',
  'run_id',
  'workspace_mode',
  'worktree_path',
  'worktree_origin_repository',
  'worktree_origin_ref',
  'worktree_origin_sha',
  'original_branch',
  'merge_gate',
  'fail_missing',
  'test_cmd_raw',
  'test_cmd_review_required',
  'test_cmd_review_candidate',
  'test_cmd_review_established',
  'test_cmd_rewriter_step',
]);

const RESERVED_KEY_SET = new Set(O12_RESERVED_CONTEXT_KEYS);

const O12_BASELINE_FILENAME = 'o12-reserved-baseline.json';
const O12_RESULT_ORDER = { FAIL: 0, NOT_EVALUABLE: 1, PASS: 2 };

// Core tables/columns each supported schema version always carries. Dependent
// tables (orphan targets) are optional per snapshot only in the sense that a
// table that is absent is recorded in the coverage record with its orphan
// sub-check NOT_EVALUABLE — a present table is always checked. stories is
// identical across every version; the chain touches runs (v13 matchlock_policy)
// and steps (v11 target_moved_reroute_count, v12 preclaim_death_count).
const V9_RUNS_COLUMNS = Object.freeze([
  'id', 'run_number', 'workflow_id', 'status', 'context', 'tokens_spent',
  'created_at', 'updated_at',
]);
const V9_STEPS_COLUMNS = Object.freeze([
  'id', 'run_id', 'step_id', 'agent_id', 'step_index', 'status', 'output',
  'type', 'loop_config', 'current_story_id', 'created_at', 'updated_at',
]);
const STORIES_COLUMNS = Object.freeze([
  'id', 'run_id', 'story_id', 'story_index', 'status', 'created_at', 'updated_at',
]);

// Version-added column names (the union chain's 10->11, 11->12 and 12->13
// steps). The discriminator pair is what classifies a v12 stamp's lineage.
const TARGET_MOVED_COLUMN = 'steps.target_moved_reroute_count';
const PRECLAIM_COLUMN = 'steps.preclaim_death_count';
const MATCHLOCK_POLICY_COLUMN = 'runs.matchlock_policy';

// Declared shape of every version-added column, derived READ-ONLY from the
// union port's src/db.ts applySchema guarded ALTER statements:
//   ALTER TABLE steps ADD COLUMN target_moved_reroute_count INTEGER DEFAULT 0
//   ALTER TABLE steps ADD COLUMN preclaim_death_count INTEGER NOT NULL DEFAULT 0
//   ALTER TABLE runs  ADD COLUMN matchlock_policy TEXT
// R1 judges type/default from PRAGMA table_info. A mismatch is a judgeable
// PRODUCT finding that makes R1 FAIL (O12_SCHEMA_COLUMN_DECLARATION_MISMATCH)
// — never a whole-oracle ERROR: the store is still usable, its declared column
// shape just disagrees with the schema chain its version number promises.
const V11_COLUMN_DECLARATIONS = Object.freeze({
  [TARGET_MOVED_COLUMN]: Object.freeze({ type: 'INTEGER', default: '0' }),
});
const V12_COLUMN_DECLARATIONS = Object.freeze({
  [PRECLAIM_COLUMN]: Object.freeze({ type: 'INTEGER', default: '0' }),
});
const MATCHLOCK_POLICY_COLUMN_DECLARATIONS = Object.freeze({
  [MATCHLOCK_POLICY_COLUMN]: Object.freeze({ type: 'TEXT', default: null }),
});

// ── runs.matchlock_policy VALUE contract (O12-SCHEMA-13, US-002) ───────────
//
// The union chain's 12->13 step added the nullable runs.matchlock_policy TEXT
// column, which stores the host-owned, IMMUTABLE Matchlock execution-isolation
// policy captured at run-creation admission (MTLK-ADMIT) as a JSON string, or
// NULL for a NATIVE (non-Matchlock) run. Everything below is derived READ-ONLY
// from the union port's src/installer/matchlock/policy.ts (908 lines):
// `matchlockPolicyValidationErrors()` is the product's own structural
// validator, `MATCHLOCK_POLICY_VERSION = 2`, `MATCHLOCK_MOUNT_POLICY_VERSION =
// 1`, `MATCHLOCK_NETWORK_POLICY_VERSION = 1`, `EXECUTION_ISOLATION_KEYS` is the
// exact allowed key set, the harness axis is pi|hermes|dsh with a
// harness-specific frozen submission block, and `assertNoCredentialValues()`
// rejects any record carrying a credential-bearing key (FORBIDDEN_KEY_FRAGMENTS).
//
//     git show refs/remotes/src/union-port:src/installer/matchlock/policy.ts
//
// O12 re-implements the STRUCTURAL judgement (types, required keys, enums,
// versions, credential-bearing keys) so a malformed, hostile or truncated
// policy blob is a VISIBLE finding instead of an unread blob. It deliberately
// does NOT re-implement the product's admission-time path-shaped pedantry that
// is not storable-shape observable here; the judged set is exactly what the
// finding text below claims. A present-but-unjudgeable value is product data,
// not an unjudgeable store: it must never throw (see evaluateO12's R1).
export const O12_MATCHLOCK_POLICY_VERSION = 2;
export const O12_MATCHLOCK_POLICY_BACKEND = 'matchlock';
export const O12_MATCHLOCK_POLICY_HARNESSES = Object.freeze(['pi', 'hermes', 'dsh']);
export const O12_MATCHLOCK_POLICY_WORK_PATH_MODE = 'host-absolute';
export const O12_MATCHLOCK_POLICY_MOUNT_POLICY_VERSION = 1;
export const O12_MATCHLOCK_POLICY_NETWORK_POLICY_VERSION = 1;
export const O12_MATCHLOCK_POLICY_DSH_HOME_SOURCES = Object.freeze(['env', 'default']);

// Harness-independent required keys (every version-2 policy carries them).
export const O12_MATCHLOCK_POLICY_REQUIRED_KEYS = Object.freeze([
  'version',
  'backend',
  'requestedImage',
  'resolvedImageDigest',
  'resolvedImageConfigDigest',
  'harness',
  'configurationRoot',
  'configurationProfile',
  'guestConfigurationRoot',
  'workPathMode',
  'workingDirectory',
  'workMounts',
  'originalRepositoryRoot',
  'gitMetadataRoots',
  'mountPolicyVersion',
  'networkPolicyVersion',
  'resourceLimits',
]);

// Keys that are legal but never required (the admission-resolved guest PATH).
export const O12_MATCHLOCK_POLICY_OPTIONAL_KEYS = Object.freeze(['imagePath']);

// Harness-specific keys: REQUIRED for that harness, forbidden on the others.
export const O12_MATCHLOCK_POLICY_HARNESS_KEYS = Object.freeze({
  hermes: Object.freeze(['hermes']),
  dsh: Object.freeze([
    'submissionHomeDir',
    'submissionCwd',
    'submissionDshHomeEnv',
    'submissionDshHomeSource',
  ]),
  pi: Object.freeze([]),
});

// The frozen Hermes submission block's key set (homeDir / cwd / hermesHomeEnv).
export const O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS = Object.freeze(['homeDir', 'cwd', 'hermesHomeEnv']);

// Bounded representative sample list for invalid policies; the COUNTS stay
// exact full totals over every run row (never the sample length).
export const O12_MATCHLOCK_POLICY_SAMPLE_CAP = 5;

// Recursive credential-bearing key fragments, mirroring the product's
// FORBIDDEN_KEY_FRAGMENTS / assertNoCredentialValues().
export const O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS = Object.freeze([
  'token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'credential',
  'private_key', 'bearer', 'auth',
]);

function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isBareProfileName(value) {
  return isNonEmptyString(value) && !value.includes('/') && !value.includes('\\');
}

function isHermesSubmissionBlock(value) {
  if (!isJsonObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS.includes(key)) return false;
  }
  return isNonEmptyString(value.homeDir)
    && isNonEmptyString(value.cwd)
    && (value.hermesHomeEnv === null || value.hermesHomeEnv === undefined
      || typeof value.hermesHomeEnv === 'string');
}

// Collect every credential-bearing key name (recursively), mirroring the
// product's assertNoCredentialValues(). A policy schema has no legitimate
// credential field, so such a key is a hard finding, never sanitizable.
function credentialKeyNames(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) credentialKeyNames(entry, found);
    return found;
  }
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
        found.push(key);
      }
      credentialKeyNames(entry, found);
    }
  }
  return found;
}

// Every structural error of ONE parsed policy value. Pure; never throws.
export function o12MatchlockPolicyErrors(parsed) {
  if (!isJsonObject(parsed)) {
    const observed = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    return [`policy record is not a JSON object (observed ${observed})`];
  }
  const errors = [];
  for (const key of credentialKeyNames(parsed)) {
    errors.push(`credential-bearing field "${key}" is not allowed`);
  }
  const harness = parsed.harness;
  const harnessKnown = O12_MATCHLOCK_POLICY_HARNESSES.includes(harness);
  const allowed = new Set([
    ...O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
    ...O12_MATCHLOCK_POLICY_OPTIONAL_KEYS,
    ...O12_MATCHLOCK_POLICY_HARNESS_KEYS.hermes,
    ...O12_MATCHLOCK_POLICY_HARNESS_KEYS.dsh,
  ]);
  const required = [...O12_MATCHLOCK_POLICY_REQUIRED_KEYS];
  if (harnessKnown) required.push(...O12_MATCHLOCK_POLICY_HARNESS_KEYS[harness]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }
  for (const key of required) {
    if (!(key in parsed)) errors.push(`required field "${key}" is missing`);
  }
  // ── fixed-value / enum axes ──
  if ('version' in parsed && parsed.version !== O12_MATCHLOCK_POLICY_VERSION) {
    errors.push(`version must be ${O12_MATCHLOCK_POLICY_VERSION} (got ${JSON.stringify(parsed.version)})`);
  }
  if ('backend' in parsed && parsed.backend !== O12_MATCHLOCK_POLICY_BACKEND) {
    errors.push(`backend must be "${O12_MATCHLOCK_POLICY_BACKEND}"`);
  }
  if ('workPathMode' in parsed && parsed.workPathMode !== O12_MATCHLOCK_POLICY_WORK_PATH_MODE) {
    errors.push(`workPathMode must be "${O12_MATCHLOCK_POLICY_WORK_PATH_MODE}"`);
  }
  if ('mountPolicyVersion' in parsed && parsed.mountPolicyVersion !== O12_MATCHLOCK_POLICY_MOUNT_POLICY_VERSION) {
    errors.push(`mountPolicyVersion must be ${O12_MATCHLOCK_POLICY_MOUNT_POLICY_VERSION} (got ${JSON.stringify(parsed.mountPolicyVersion)})`);
  }
  if ('networkPolicyVersion' in parsed && parsed.networkPolicyVersion !== O12_MATCHLOCK_POLICY_NETWORK_POLICY_VERSION) {
    errors.push(`networkPolicyVersion must be ${O12_MATCHLOCK_POLICY_NETWORK_POLICY_VERSION} (got ${JSON.stringify(parsed.networkPolicyVersion)})`);
  }
  // ── harness axis (each harness's own submission block) ──
  if ('harness' in parsed) {
    if (!harnessKnown) {
      errors.push('harness must be "pi", "hermes" or "dsh"');
    } else if (harness === 'hermes') {
      if (!isHermesSubmissionBlock(parsed.hermes)) {
        errors.push('harness "hermes" requires the frozen hermes submission block {homeDir, cwd, hermesHomeEnv} (non-empty strings; hermesHomeEnv may be null)');
      }
      for (const key of O12_MATCHLOCK_POLICY_HARNESS_KEYS.dsh) {
        if (key in parsed) errors.push(`field "${key}" is only valid on harness "dsh" policies`);
      }
    } else if (harness === 'dsh') {
      if ('hermes' in parsed) errors.push('harness "dsh" must not carry a hermes submission block');
      if ('submissionHomeDir' in parsed && !isNonEmptyString(parsed.submissionHomeDir)) {
        errors.push('submissionHomeDir must be a non-empty string for dsh policies');
      }
      if ('submissionCwd' in parsed && !isNonEmptyString(parsed.submissionCwd)) {
        errors.push('submissionCwd must be a non-empty string for dsh policies');
      }
      if ('submissionDshHomeEnv' in parsed
          && !(parsed.submissionDshHomeEnv === null || typeof parsed.submissionDshHomeEnv === 'string')) {
        errors.push('submissionDshHomeEnv must be null or a string for dsh policies');
      }
      if ('submissionDshHomeSource' in parsed
          && !O12_MATCHLOCK_POLICY_DSH_HOME_SOURCES.includes(parsed.submissionDshHomeSource)) {
        errors.push('submissionDshHomeSource must be "env" or "default" for dsh policies');
      }
    } else {
      if ('hermes' in parsed) errors.push('harness "pi" must not carry a hermes submission block');
      for (const key of O12_MATCHLOCK_POLICY_HARNESS_KEYS.dsh) {
        if (key in parsed) errors.push(`field "${key}" is only valid on harness "dsh" policies`);
      }
    }
  }
  // ── string / structural value axes ──
  if ('requestedImage' in parsed && !isNonEmptyString(parsed.requestedImage)) {
    errors.push('requestedImage must be a non-empty string');
  }
  if ('resolvedImageDigest' in parsed && !isNonEmptyString(parsed.resolvedImageDigest)) {
    errors.push('resolvedImageDigest must be a non-empty string (immutable content digest)');
  }
  if ('resolvedImageConfigDigest' in parsed && !isNonEmptyString(parsed.resolvedImageConfigDigest)) {
    errors.push('resolvedImageConfigDigest must be a non-empty string (immutable config digest)');
  }
  if ('imagePath' in parsed
      && !(isNonEmptyString(parsed.imagePath) && parsed.imagePath.split(':').every((segment) => segment.startsWith('/')))) {
    errors.push('imagePath must be a colon-separated list of absolute directories when present');
  }
  if ('configurationRoot' in parsed && !isNonEmptyString(parsed.configurationRoot)) {
    errors.push('configurationRoot must be a non-empty string');
  }
  if ('configurationProfile' in parsed && !isBareProfileName(parsed.configurationProfile)) {
    errors.push('configurationProfile must be a bare file name with no path separators');
  }
  if ('guestConfigurationRoot' in parsed && !isNonEmptyString(parsed.guestConfigurationRoot)) {
    errors.push('guestConfigurationRoot must be a non-empty string');
  }
  if ('workingDirectory' in parsed && !isNonEmptyString(parsed.workingDirectory)) {
    errors.push('workingDirectory must be a non-empty string');
  }
  if ('workMounts' in parsed) {
    if (!Array.isArray(parsed.workMounts) || parsed.workMounts.length === 0) {
      errors.push('workMounts must be a non-empty array');
    } else if (!parsed.workMounts.every((mount) => isJsonObject(mount)
        && isNonEmptyString(mount.hostPath)
        && isNonEmptyString(mount.hostRealPath)
        && isNonEmptyString(mount.guestPath)
        && mount.guestPath === mount.hostPath)) {
      errors.push('every workMount must carry non-empty hostPath/hostRealPath/guestPath strings with guestPath === hostPath');
    }
  }
  if ('originalRepositoryRoot' in parsed
      && !(parsed.originalRepositoryRoot === null || isNonEmptyString(parsed.originalRepositoryRoot))) {
    errors.push('originalRepositoryRoot must be null or a non-empty string');
  }
  if ('gitMetadataRoots' in parsed
      && !(Array.isArray(parsed.gitMetadataRoots) && parsed.gitMetadataRoots.every(isNonEmptyString))) {
    errors.push('gitMetadataRoots must be an array of non-empty strings');
  }
  if ('resourceLimits' in parsed
      && !(isJsonObject(parsed.resourceLimits)
        && isFinitePositive(parsed.resourceLimits.cpus)
        && isFinitePositive(parsed.resourceLimits.memoryMB)
        && isFinitePositive(parsed.resourceLimits.diskSizeMB))) {
    errors.push('resourceLimits must carry finite positive cpus/memoryMB/diskSizeMB');
  }
  return errors;
}

// Judge ONE stored runs.matchlock_policy value. Pure, never throws.
//   NULL/undefined        → { status: 'native' }  (a native run: VALID)
//   valid version-2 record → { status: 'valid' }
//   anything else          → { status: 'invalid', errors: [...] }
export function validateO12MatchlockPolicyValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return { status: 'native', errors: [] };
  if (typeof rawValue !== 'string') {
    return {
      status: 'invalid',
      errors: [`policy value is not a TEXT JSON string (observed ${typeof rawValue})`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    return { status: 'invalid', errors: [`policy value is not parseable JSON: ${error.message}`] };
  }
  const errors = o12MatchlockPolicyErrors(parsed);
  return { status: errors.length === 0 ? 'valid' : 'invalid', errors };
}

function columnDeclarations(...maps) {
  return Object.freeze(Object.assign({}, ...maps));
}

// Per-version column universes. v10 == v9 (TIME-STORAGE adds no column).
const V10_RUNS_COLUMNS = V9_RUNS_COLUMNS;
const V10_STEPS_COLUMNS = V9_STEPS_COLUMNS;
const V11_STEPS_COLUMNS = Object.freeze([...V9_STEPS_COLUMNS, 'target_moved_reroute_count']);
const V12_STEPS_COLUMNS = Object.freeze([...V11_STEPS_COLUMNS, 'preclaim_death_count']);
const MATCHLOCK_RUNS_COLUMNS = Object.freeze([...V9_RUNS_COLUMNS, 'matchlock_policy']);

// Declared FKs (CREATE TABLE REFERENCES clauses) and the undeclared-FK orphan
// matrix. steps.current_story_id references stories.id (the row UUID — see
// step-ops.ts claim/abandonment recovery SELECT * FROM stories WHERE id = ?)
// but is NOT declared as a foreign key; run_worktrees / story_abandonments /
// suite_results are not declared either. foreign_key_check only covers the
// declared pair, so the undeclared columns need explicit orphan probes.
const ORPHAN_MATRIX = Object.freeze([
  { table: 'steps', childColumn: 'run_id', parentTable: 'runs', parentColumn: 'id', nullAllowed: false, canonical: 'none' },
  { table: 'stories', childColumn: 'run_id', parentTable: 'runs', parentColumn: 'id', nullAllowed: false, canonical: 'none' },
  { table: 'steps', childColumn: 'current_story_id', parentTable: 'stories', parentColumn: 'id', nullAllowed: true, canonical: 'none' },
  { table: 'run_worktrees', childColumn: 'run_id', parentTable: 'runs', parentColumn: 'id', nullAllowed: false, canonical: 'none' },
  { table: 'story_abandonments', childColumn: 'run_id', parentTable: 'runs', parentColumn: 'id', nullAllowed: false, canonical: 'none' },
  { table: 'story_abandonments', childColumn: 'story_id', parentTable: 'stories', parentColumn: 'id', nullAllowed: false, canonical: 'none' },
  // suite_results.run_id is written by the shim from TAMANDUA_RUN_ID
  // (canonical 'run-…' form) while runs.id stores the bare UUID — canonicalize
  // both shapes when matching.
  { table: 'suite_results', childColumn: 'run_id', parentTable: 'runs', parentColumn: 'id', nullAllowed: true, canonical: 'run-prefix' },
]);

// Time columns judged per table (only when the table AND the column exist).
const TIMESTAMP_COLUMNS = Object.freeze({
  runs: ['created_at', 'updated_at', 'scheduling_requested_at', 'harness_probe_at'],
  steps: ['created_at', 'updated_at', 'claim_updated_at'],
  stories: ['created_at', 'updated_at'],
  story_abandonments: ['created_at'],
  run_worktrees: ['created_at', 'removed_at'],
  suite_results: ['created_at'],
  autoresearch_sessions: ['created_at', 'updated_at', 'last_seen_at', 'last_run_at'],
});

// Ordering pairs compared per row (created_at <= updated_at per spec O12).
// run_worktrees rows gain the (created_at, removed_at) pair when removed_at is
// present. Only tables that carry both created_at and updated_at are judged;
// single-column tables are judged for shape/validity only.
const ORDERING_PAIRS = Object.freeze([
  { table: 'runs', earlier: 'created_at', later: 'updated_at' },
  { table: 'steps', earlier: 'created_at', later: 'updated_at' },
  { table: 'stories', earlier: 'created_at', later: 'updated_at' },
  { table: 'autoresearch_sessions', earlier: 'created_at', later: 'updated_at' },
]);

// Per-version schema descriptor: the required core columns, the declared shape
// of every version-added column, the declared and undeclared FK-orphan matrix,
// the judged timestamp columns and the ordering pairs. R1 selects the
// descriptor for the snapshot's PRAGMA user_version (resolving the dual v12
// lineage through its actual column shape — see
// resolveO12SchemaExpectation), so each version is judged against its own
// column universe and R1 is EVALUABLE for every supported version. The orphan
// matrix, timestamp columns and ordering pairs are version-invariant today, but
// they ride in the descriptor so a future version can diverge without touching
// R1's selection logic.
function schemaDescriptor({ userVersion, lineage, runs, steps, columnDeclarations: declarations }) {
  return Object.freeze({
    user_version: userVersion,
    lineage,
    coreTables: Object.freeze({ runs, steps, stories: STORIES_COLUMNS }),
    columnDeclarations: columnDeclarations(declarations),
    orphanMatrix: ORPHAN_MATRIX,
    timestampColumns: TIMESTAMP_COLUMNS,
    orderingPairs: ORDERING_PAIRS,
  });
}

// The three legal v12 shapes. A pre-union main v12 store carries the whole
// main chain (v9 base + target_moved + preclaim); a pre-union Matchlock v12
// store carries the Matchlock line's own universe (v10 base + matchlock, which
// never had target_moved_reroute_count); a store carrying BOTH lineages' marks
// is judged against their union.
const O12_V12_LINEAGE_DESCRIPTORS = Object.freeze({
  'main-v12': schemaDescriptor({
    userVersion: 12,
    lineage: 'main-v12',
    runs: V9_RUNS_COLUMNS,
    steps: V12_STEPS_COLUMNS,
    columnDeclarations: columnDeclarations(V11_COLUMN_DECLARATIONS, V12_COLUMN_DECLARATIONS),
  }),
  'matchlock-v12': schemaDescriptor({
    userVersion: 12,
    lineage: 'matchlock-v12',
    runs: MATCHLOCK_RUNS_COLUMNS,
    steps: V9_STEPS_COLUMNS,
    columnDeclarations: MATCHLOCK_POLICY_COLUMN_DECLARATIONS,
  }),
  'v12-superset': schemaDescriptor({
    userVersion: 12,
    lineage: 'v12-superset',
    runs: MATCHLOCK_RUNS_COLUMNS,
    steps: V12_STEPS_COLUMNS,
    columnDeclarations: columnDeclarations(
      V11_COLUMN_DECLARATIONS, V12_COLUMN_DECLARATIONS, MATCHLOCK_POLICY_COLUMN_DECLARATIONS,
    ),
  }),
});

export const O12_SCHEMA_DESCRIPTORS = Object.freeze({
  9: schemaDescriptor({
    userVersion: 9, lineage: 'v9', runs: V9_RUNS_COLUMNS, steps: V9_STEPS_COLUMNS, columnDeclarations: {},
  }),
  10: schemaDescriptor({
    userVersion: 10, lineage: 'v10', runs: V10_RUNS_COLUMNS, steps: V10_STEPS_COLUMNS, columnDeclarations: {},
  }),
  11: schemaDescriptor({
    userVersion: 11,
    lineage: 'v11',
    runs: V9_RUNS_COLUMNS,
    steps: V11_STEPS_COLUMNS,
    columnDeclarations: V11_COLUMN_DECLARATIONS,
  }),
  // A v12 stamp is lineage-dependent: this entry hands out the per-lineage
  // descriptor once the shape is classified (resolveO12SchemaExpectation).
  12: Object.freeze({
    user_version: 12,
    lineage: 'lineage-dependent',
    discriminators: Object.freeze([MATCHLOCK_POLICY_COLUMN, PRECLAIM_COLUMN]),
    lineages: O12_V12_LINEAGE_DESCRIPTORS,
  }),
  13: schemaDescriptor({
    userVersion: 13,
    lineage: 'current',
    runs: MATCHLOCK_RUNS_COLUMNS,
    steps: V12_STEPS_COLUMNS,
    columnDeclarations: columnDeclarations(
      V11_COLUMN_DECLARATIONS, V12_COLUMN_DECLARATIONS, MATCHLOCK_POLICY_COLUMN_DECLARATIONS,
    ),
  }),
  // v14 (LEDGER-DIAG) adds only the NON-core suite_results.log_path column, so
  // the runs/steps/stories core universe is IDENTICAL to v13's and the same
  // both-union-columns fail-closed rule applies (resolveO12SchemaExpectation).
  14: schemaDescriptor({
    userVersion: 14,
    lineage: 'current',
    runs: MATCHLOCK_RUNS_COLUMNS,
    steps: V12_STEPS_COLUMNS,
    columnDeclarations: columnDeclarations(
      V11_COLUMN_DECLARATIONS, V12_COLUMN_DECLARATIONS, MATCHLOCK_POLICY_COLUMN_DECLARATIONS,
    ),
  }),
});

// Resolve the descriptor + observed lineage for a snapshot's PRAGMA
// user_version. Mirrors the product's detectSchemaLineage() classification for
// a v12 stamp (which reads the ACTUAL column shape through pragma_table_info
// because two pre-union lineages both stamped 12 for different columns) and the
// union's v13 requirement (BOTH union columns). Every shape that cannot be
// judged throws OracleRuntimeError — a whole-oracle ERROR (exit 2, zero
// evidence artifacts) naming the observed version/columns, never
// NOT_EVALUABLE and never PASS.
//
// PRECONDITION: the caller has already verified the runs/steps/stories tables
// exist (evaluateO12 fails closed on a missing core table BEFORE resolving).
// PRAGMA table_info on an absent table yields zero rows, so resolving first
// would misread a structurally malformed store as a missing-column shape.
export function resolveO12SchemaExpectation(database, userVersion) {
  const declared = O12_SCHEMA_DESCRIPTORS[userVersion];
  if (declared === undefined) {
    throw new OracleRuntimeError(`snapshot PRAGMA user_version ${userVersion} is not supported by this O12 build; supported schema versions are {${O12_SUPPORTED_SCHEMA_VERSIONS.join(', ')}}`);
  }
  const hasMatchlockPolicy = columnsOf(database, 'runs')?.has('matchlock_policy') ?? false;
  const hasPreclaim = columnsOf(database, 'steps')?.has('preclaim_death_count') ?? false;
  const lineageColumns = Object.freeze({
    [MATCHLOCK_POLICY_COLUMN]: hasMatchlockPolicy,
    [PRECLAIM_COLUMN]: hasPreclaim,
  });
  // The union-column requirement applies from v13 on: v13 is MATCHLOCK-UNION-4
  // and v14 is LEDGER-DIAG (which adds only the non-core suite_results.log_path
  // column), so a v14 store must still carry BOTH runs.matchlock_policy and
  // steps.preclaim_death_count. Missing either is a whole-oracle ERROR naming
  // the observed version and the missing column(s).
  if (userVersion === 13 || userVersion === 14) {
    const missing = [
      ...(hasMatchlockPolicy ? [] : [MATCHLOCK_POLICY_COLUMN]),
      ...(hasPreclaim ? [] : [PRECLAIM_COLUMN]),
    ];
    if (missing.length > 0) {
      const label = userVersion === 13 ? 'the MATCHLOCK-UNION-4 schema' : 'the LEDGER-DIAG schema';
      throw new OracleRuntimeError(`snapshot PRAGMA user_version ${userVersion} (${label}) requires BOTH union columns; missing ${missing.join(' and ')}`);
    }
  }
  if (userVersion === 12) {
    const lineage = hasPreclaim && hasMatchlockPolicy
      ? 'v12-superset'
      : hasPreclaim
        ? 'main-v12'
        : hasMatchlockPolicy
          ? 'matchlock-v12'
          : null;
    if (lineage === null) {
      throw new OracleRuntimeError(`snapshot PRAGMA user_version 12 carries neither schema-lineage discriminator column; missing ${MATCHLOCK_POLICY_COLUMN} and ${PRECLAIM_COLUMN} (a pre-union v12 store carries exactly one: steps.preclaim_death_count for the main lineage, runs.matchlock_policy for the Matchlock lineage)`);
    }
    return { descriptor: declared.lineages[lineage], lineage, lineageColumns };
  }
  return { descriptor: declared, lineage: declared.lineage, lineageColumns };
}

const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQLITE_NAIVE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NAIVE_SECOND_MS = 999;

// Resolve an id stored in either bare (uuid) or canonical (run-<uuid>) form to
// the bare form used by runs.id.
function bareId(value) {
  return typeof value === 'string' && value.startsWith('run-') ? value.slice(4) : value;
}

function resultRank(leg) {
  return O12_RESULT_ORDER[leg.result] ?? 99;
}

// ── schema helpers ─────────────────────────────────────────────────────────

function tableNames(database) {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
}

function columnsOf(database, table) {
  if (!tableNames(database).includes(table)) return null;
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function declaredForeignKeys(database, table) {
  return database.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => ({
    id: row.id, seq: row.seq, table: row.table, from: row.from, to: row.to,
  }));
}

// ── timestamp shape classification ──────────────────────────────────────────

// Shape families:
//   native-iso    canonical product ISO-8601 UTC with milliseconds ('Z')
//   native-sqlite product SQLite datetime('now') shape (naive UTC, seconds)
//   other-valid   parseable instant in some other representation (offsets,
//                 no-millisecond ISO, etc.) — a valid instant, never a
//                 product writer dialect
//   invalid       empty/non-string/unparseable
function classifyTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return 'invalid';
  if (CANONICAL_ISO_RE.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 'invalid' : 'native-iso';
  }
  if (SQLITE_NAIVE_RE.test(value)) return 'native-sqlite';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'invalid';
  return 'other-valid';
}

// Compare two timestamp instants for ordering. SQLite-naive values are UTC at
// second precision, so a naive instant denotes [t, t+999ms]. created_at may
// carry millisecond precision; a naive updated_at in the SAME second as a
// millisecond created_at is treated as satisfied (sub-second order is not
// observable) and reported as same-second indeterminacy by the caller.
function instantMs(value, shape) {
  if (shape === 'native-sqlite') return Date.parse(`${value.replace(' ', 'T')}Z`);
  return Date.parse(value);
}

// Returns 'violation' | 'satisfied' | 'indeterminate-same-second'.
function compareOrder(earlierValue, earlierShape, laterValue, laterShape) {
  if (earlierShape === 'invalid' || laterShape === 'invalid') return 'satisfied'; // handled by validity leg
  const earlier = instantMs(earlierValue, earlierShape);
  const later = instantMs(laterValue, laterShape);
  if (Number.isNaN(earlier) || Number.isNaN(later)) return 'satisfied';
  if (laterShape === 'native-sqlite') {
    const laterStart = later;
    const laterEnd = later + NAIVE_SECOND_MS;
    if (earlier <= laterEnd) return earlier < laterStart ? 'satisfied' : 'indeterminate-same-second';
    return 'violation';
  }
  if (earlierShape === 'native-sqlite') {
    if (earlier <= later) return 'satisfied';
    // earlier naive second strictly after later instant → violation
    return 'violation';
  }
  return earlier <= later ? 'satisfied' : 'violation';
}


function summarizeTimestamps(database, findings, observations, descriptor) {
  const shapeCounts = {}; // `${table}.${column}` -> { family: count }
  const columnFamilies = {}; // `${table}.${column}` -> Set of families
  const seenColumns = new Set();
  const counters = { invalid: 0, nativeMixed: 0, pairMismatch: 0, orderViolation: 0 };
  const samples = {
    invalid: [], nativeMixed: [], pairMismatch: [], orderViolation: [], sameSecond: [],
  };

  for (const [table, columns] of Object.entries(descriptor.timestampColumns)) {
    const columnsPresent = columnsOf(database, table);
    if (columnsPresent === null) continue;
    for (const column of columns) {
      if (!columnsPresent.has(column)) continue;
      seenColumns.add(`${table}.${column}`);
      const key = `${table}.${column}`;
      shapeCounts[key] ??= {};
      columnFamilies[key] ??= new Set();
      // Paginated read keeps working memory bounded on the aged 500k-run DB.
      let offset = 0;
      const batchSize = 5000;
      for (;;) {
        const rowIdColumn = table === 'run_worktrees' ? 'run_id' : 'id';
        const rows = database.prepare(
          `SELECT ${rowIdColumn} AS row_id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${rowIdColumn} LIMIT ? OFFSET ?`,
        ).all(batchSize, offset);
        if (rows.length === 0) break;
        for (const row of rows) {
          const shape = classifyTimestamp(row.value);
          shapeCounts[key][shape] = (shapeCounts[key][shape] ?? 0) + 1;
          columnFamilies[key].add(shape);
          if (shape === 'invalid') {
            counters.invalid += 1;
            if (samples.invalid.length < 5) samples.invalid.push({ table, column, row_id: String(row.row_id), sample: String(row.value).slice(0, 40) });
          }
        }
        offset += batchSize;
      }
    }
  }

  // Column-level native-family discipline: the product's two timestamp
  // writers (JS toISOString and SQLite datetime('now')) must not mix within a
  // single stored column.
  for (const key of Object.keys(columnFamilies).sort()) {
    const families = columnFamilies[key];
    if (families.has('native-iso') && families.has('native-sqlite')) {
      const [table, column] = key.split('.');
      counters.nativeMixed += 1;
      if (samples.nativeMixed.length < 5) samples.nativeMixed.push({ table, column });
    }
  }

  // Row-level ordering pairs (created_at <= updated_at).
  for (const pair of descriptor.orderingPairs) {
    const tableColumns = columnsOf(database, pair.table);
    if (tableColumns === null || !tableColumns.has(pair.earlier) || !tableColumns.has(pair.later)) continue;
    let offset = 0;
    const batchSize = 5000;
    for (;;) {
      const rowIdColumn = pair.table === 'run_worktrees' ? 'run_id' : 'id';
      const rows = database.prepare(
        `SELECT ${rowIdColumn} AS row_id, ${pair.earlier} AS earlier_value, ${pair.later} AS later_value FROM ${pair.table}
         WHERE ${pair.earlier} IS NOT NULL AND ${pair.later} IS NOT NULL ORDER BY ${rowIdColumn} LIMIT ? OFFSET ?`,
      ).all(batchSize, offset);
      if (rows.length === 0) break;
      for (const row of rows) {
        const earlierShape = classifyTimestamp(row.earlier_value);
        const laterShape = classifyTimestamp(row.later_value);
        const nativePair = [earlierShape, laterShape]
          .filter((shape) => shape === 'native-iso' || shape === 'native-sqlite');
        if (new Set(nativePair).size === 2) {
          // created_at (ISO) paired with an updated_at rewritten by SQLite
          // datetime('now') — the TIME finding shape awaiting product
          // reconciliation; recorded, never silently waived.
          counters.pairMismatch += 1;
          if (samples.pairMismatch.length < 5) samples.pairMismatch.push({ table: pair.table, row_id: String(row.row_id) });
        }
        const order = compareOrder(row.earlier_value, earlierShape, row.later_value, laterShape);
        if (order === 'violation') {
          counters.orderViolation += 1;
          if (samples.orderViolation.length < 5) samples.orderViolation.push({ table: pair.table, row_id: String(row.row_id) });
        } else if (order === 'indeterminate-same-second' && samples.sameSecond.length < 5) {
          samples.sameSecond.push({ table: pair.table, row_id: String(row.row_id) });
        }
      }
      offset += batchSize;
    }
  }
  // run_worktrees removal ordering (created_at <= removed_at) when removed_at set.
  const worktreeColumns = columnsOf(database, 'run_worktrees');
  if (worktreeColumns !== null && worktreeColumns.has('removed_at')) {
    const rows = database.prepare(
      "SELECT run_id AS row_id, created_at AS earlier_value, removed_at AS later_value FROM run_worktrees WHERE removed_at IS NOT NULL ORDER BY run_id",
    ).all();
    for (const row of rows) {
      const earlierShape = classifyTimestamp(row.earlier_value);
      const laterShape = classifyTimestamp(row.later_value);
      const order = compareOrder(row.earlier_value, earlierShape, row.later_value, laterShape);
      if (order === 'violation') {
        counters.orderViolation += 1;
        if (samples.orderViolation.length < 5) samples.orderViolation.push({ table: 'run_worktrees', row_id: String(row.row_id) });
      } else if (order === 'indeterminate-same-second' && samples.sameSecond.length < 5) {
        samples.sameSecond.push({ table: 'run_worktrees', row_id: String(row.row_id) });
      }
    }
  }

  // Findings: one per class, carrying exact counts and bounded samples.
  if (counters.invalid > 0) {
    findings.add('O12_TIME_INVALID', `${counters.invalid} unparseable/non-instant timestamp value(s) stored`, {
      count: counters.invalid, samples: samples.invalid,
    });
  }
  for (const sample of samples.nativeMixed) {
    findings.add('O12_TIME_MIXED_NATIVE_FORMAT', `column ${sample.table}.${sample.column} mixes native ISO-8601 and native SQLite timestamp writers`, sample);
  }
  if (counters.pairMismatch > 0) {
    findings.add('O12_TIME_PAIR_FORMAT_MISMATCH', `${counters.pairMismatch} created_at/updated_at pair(s) use different native formats`, {
      count: counters.pairMismatch, samples: samples.pairMismatch,
    });
  }
  if (counters.orderViolation > 0) {
    findings.add('O12_TIME_ORDER_VIOLATION', `${counters.orderViolation} updated_at value(s) precede their created_at instant`, {
      count: counters.orderViolation, samples: samples.orderViolation,
    });
  }

  const shapeHistogram = {};
  for (const key of Object.keys(shapeCounts).sort()) shapeHistogram[key] = { ...shapeCounts[key] };

  observations.push({
    scope: 'timestamps',
    columns_judged: [...seenColumns].sort(),
    shape_histogram: shapeHistogram,
    invalid_count: counters.invalid,
    native_mixed_column_count: counters.nativeMixed,
    pair_format_mismatch_count: counters.pairMismatch,
    order_violation_count: counters.orderViolation,
    order_violation_samples: samples.orderViolation,
    same_second_indeterminacy_samples: samples.sameSecond,
    note: 'shape uniformity and instant ordering are separate sub-checks; syntactic format findings are recorded independently of instant ordering',
  });

  return {
    invalidCount: counters.invalid,
    nativeMixed: counters.nativeMixed,
    pairMismatchCount: counters.pairMismatch,
    orderViolationCount: counters.orderViolation,
  };
}

// ── R5 composite serial-state evaluation ─────────────────────────────────────

// The only legal simultaneous executable (pending|running) step pair in a run
// is a parked verify_each stories-loop coordinator (type='loop', raw status
// 'running', current_story_id NULL, loop_config declaring verify_each +
// verify_step) together with its DECLARED verifier step (same run, that exact
// step_id, status pending|running). Anything else executable beyond that pair,
// or a pair that is not the declared-ownership shape, is a violation. The DISP
// mapping (raw running/null loop → display "verifying") is honored as
// presentation-only; the rule is judged on RAW stored statuses.
function parkedLoopConfig(loopConfig) {
  if (typeof loopConfig !== 'string' || loopConfig.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(loopConfig);
  } catch {
    return null; // malformed loop_config is not a parked verify_each shape
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verifyEach = parsed.verifyEach ?? parsed.verify_each;
  const verifyStep = parsed.verifyStep ?? parsed.verify_step;
  if (verifyEach !== true || typeof verifyStep !== 'string' || verifyStep.length === 0) return null;
  return verifyStep;
}

function evaluateSerialState(database, findings, observations) {
  const runs = database.prepare("SELECT id, status FROM runs ORDER BY id").all();
  const steps = database.prepare(`
    SELECT id, run_id, step_id, status, type, current_story_id, loop_config, step_index
    FROM steps ORDER BY run_id, step_index, id
  `).all();
  const byRun = new Map();
  for (const step of steps) {
    if (!byRun.has(step.run_id)) byRun.set(step.run_id, []);
    byRun.get(step.run_id).push(step);
  }
  const runRows = new Map(runs.map((run) => [run.id, run]));
  const violations = [];
  const parkedPairs = [];
  let runsWithExecutables = 0;

  for (const [runId, runSteps] of byRun) {
    const runStatus = runRows.get(runId)?.status;
    if (runStatus !== 'running') continue; // composite simultaneity only judged on live runs
    const executable = runSteps.filter((step) => step.status === 'pending' || step.status === 'running');
    if (executable.length === 0) continue;
    runsWithExecutables += 1;
    if (executable.length === 1) continue; // ordinary serial pipeline

    // More than one executable step: allowed ONLY for the parked pair shape.
    if (executable.length === 2) {
      const loop = executable.find((step) => step.type === 'loop'
        && step.status === 'running' && step.current_story_id === null);
      const other = executable.find((step) => step !== loop);
      if (loop !== undefined && other !== undefined) {
        const declaredVerifier = parkedLoopConfig(loop.loop_config);
        if (declaredVerifier !== null && other.step_id === declaredVerifier
            && (other.status === 'pending' || other.status === 'running')) {
          parkedPairs.push({ run_id: runId, loop_row_id: loop.id, verifier_row_id: other.id });
          continue; // legal pair
        }
        // A pair with a running loop that is NOT the declared shape (active
        // story, wrong verifier ownership, merely-named verifier).
        violations.push({
          run_id: runId,
          observed: executable.map((step) => ({
            row_id: step.id, step_id: step.step_id, status: step.status, type: step.type,
            current_story_id: step.current_story_id,
          })),
          reason: loop.current_story_id !== null
            ? 'active-story loop (current_story_id set) paired with another executable step'
            : (declaredVerifier === null
              ? 'running loop without declared verify_each ownership'
              : `declared verifier ${declaredVerifier} does not match the paired executable step`),
        });
        continue;
      }
    }
    violations.push({
      run_id: runId,
      observed: executable.map((step) => ({
        row_id: step.id, step_id: step.step_id, status: step.status, type: step.type,
        current_story_id: step.current_story_id,
      })),
      reason: executable.length > 2
        ? 'more than two simultaneous executable steps'
        : 'executable pair is not a declared verify_each parked loop + its verifier',
    });
  }

  for (const violation of violations.slice(0, 5)) {
    findings.add('O12_SERIAL_COMPOSITE_VIOLATION', `run ${violation.run_id} carries an illegal simultaneous executable step set`, {
      run_id: violation.run_id, reason: violation.reason, observed: violation.observed,
    });
  }

  observations.push({
    scope: 'serial-composite-state',
    runs_with_executable_steps: runsWithExecutables,
    legal_parked_verify_pairs: parkedPairs.map((pair) => ({ run_id: pair.run_id })),
    illegal_pair_count: violations.length,
    illegal_pair_samples: violations.slice(0, 5).map((v) => ({ run_id: v.run_id, reason: v.reason })),
  });

  return { violationCount: violations.length };
}

// ── R4 reserved-key baseline handling ────────────────────────────────────────

// The host-owned reserved-key input pins each scoped run's expected reserved
// context values at (or just after) run creation — the ONLY legitimate writer
// of reserved keys is host code (run.ts seedContext + in-process rewrite
// detector), never agent KEY: output. A final DB snapshot alone cannot
// establish historical non-overwrite, so this leg is NOT_EVALUABLE without the
// input. Schema (versioned separately from the shared oracle context, which is
// contract-version 1 and must not gain keys without a version change):
//
//   schema_version 1 (LEGACY — presence can only be asserted, never proved
//   absent): {
//     schema_version: 1,
//     captured_at: "<UTC ISO-8601 Z>",
//     producer: "host",
//     supported_reserved_keys: ["repo", ...],   // must equal the pin
//     runs: { "<run id bare|run- prefixed>": { "<reserved key>": "<value>", ... } },
//     expected_mutations: { "<run id>": { "<key>": { to: "<value>", source: "host" } } }
//   }
//   schema_version 1 is evaluated with the DEFAULT scope (every snapshot run)
//   and per-run entries that enumerate a key only assert that the key was
//   PRESENT with that value. A key that is not enumerated asserts nothing
//   ("no key supplied" is never proof the key was originally absent), so an
//   incomplete v1 baseline can never PASS: either the input is complete
//   authoritative data (every in-scope run enumerates the ENTIRE pin) or the
//   leg reports NOT_EVALUABLE. This is the legacy-migration rule: legacy
//   incomplete v1 cannot become full PASS simply by supplying one known value.
//
//   schema_version 2 (current): {
//     schema_version: 2,
//     captured_at: "<UTC ISO-8601 Z>",
//     producer: "host",
//     scope: { mode: "all-snapshot-runs" | "explicit", run_ids: ["<bare run uuid>", ...] },
//     supported_reserved_keys: ["repo", ...],   // must equal the pin
//     expected: {
//       "<bare run uuid>": {
//         "<reserved key>": { presence: "present", value: "<string>", provenance: "host" }
//                        | { presence: "absent", provenance: "host" }
//         // EVERY supported reserved key must appear (typed presence/absence);
//         // values, missing keys and empty strings are distinct.
//       }
//     },
//     expected_mutations: {
//       "<bare run uuid>": {
//         "<reserved key>": { presence: "present", value: "<string>", source: "host" }
//                        | { presence: "absent", source: "host" }
//       }
//     }
//   }
//
// Scope contract (Storm O12-close): the DEFAULT post-batch scope is EVERY
// snapshot run — a baseline can never choose its own smaller denominator and
// label full-state integrity PASS. A smaller scope is supported ONLY as an
// explicit host admission (`scope.mode: "explicit"` + `scope.run_ids`),
// reported as such (`snapshot_runs_outside_admitted_scope`), never a quiet
// escape. In explicit mode the admitted run universe is the ONLY legal
// denominator for the baseline's OWN coverage: every run named in `expected`
// or `expected_mutations` must lie inside `scope.run_ids`, otherwise the input
// is a malformed cross-scope binding → ERROR (never silently ignored). In the
// default all-snapshot mode a baseline may name runs absent from the snapshot
// (deleted after capture); those stale entries cannot be compared and are
// surfaced in the scope record (`expected_runs_not_in_snapshot_count/_samples`)
// rather than silently dropped. For every in-scope run the host must supply
// captured typed presence/absence for the ENTIRE native reserved-key pin;
// unavailable coverage is NOT_EVALUABLE, malformed input is ERROR, demonstrated
// divergence is FAIL (FAIL dominates NOT_EVALUABLE, so a concrete finding on
// one run survives another run's missing coverage). Non-reserved dictionary
// keys never count as reserved coverage; run ids are canonicalized from bare
// uuids or `run-<uuid>` aliases and duplicate/ambiguous bindings are ERROR.
const O12_BASELINE_V1 = 1;
const O12_BASELINE_V2 = 2;
const RUN_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

// Canonicalize a run id reference (bare uuid or 'run-<uuid>' alias) to the
// bare form used by runs.id. Anything else is a malformed reference.
function canonicalRunId(raw, label) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OracleRuntimeError(`${label} run id must be a non-empty string`);
  }
  const bare = raw.startsWith('run-') ? raw.slice('run-'.length) : raw;
  if (!RUN_UUID_RE.test(bare)) {
    throw new OracleRuntimeError(`${label} run id ${JSON.stringify(raw)} is not a bare run uuid or run-<uuid> alias`);
  }
  return bare.toLowerCase();
}

// Index an id-keyed map by canonical run id, rejecting ambiguous duplicate
// bindings (the same run under bare and run-<uuid> spellings, or a repeated
// canonical id) — cross-scope/duplicate aliases are ERROR, never guessed.
function indexByRunId(map, label) {
  const out = new Map();
  for (const [rawId, value] of Object.entries(map)) {
    const bare = canonicalRunId(rawId, label);
    if (out.has(bare)) {
      throw new OracleRuntimeError(`${label} binds run ${bare} more than once (ambiguous duplicate/cross-scope alias binding)`);
    }
    out.set(bare, value);
  }
  return out;
}

function requireExactReservedKeySet(keys, label) {
  if (!Array.isArray(keys)
      || JSON.stringify([...keys].sort()) !== JSON.stringify([...O12_RESERVED_CONTEXT_KEYS].sort())) {
    throw new OracleRuntimeError(`${label} does not match the pinned native reserved-key set`);
  }
}

// Normalize a v2 per-run expected entry map: every key must be a supported
// reserved key and every entry must be typed presence/absence with host
// provenance. Returns Map<key, {presence, value?}>.
function normalizeExpectedEntryV2(entry, runId) {
  const out = new Map();
  for (const [key, spec] of Object.entries(entry)) {
    if (!RESERVED_KEY_SET.has(key)) {
      throw new OracleRuntimeError(`v2 expected entry for run ${runId} names non-reserved key ${JSON.stringify(key)}; non-reserved keys never count as reserved coverage`);
    }
    const typed = assertObject(spec, `v2 expected entry for run ${runId}.${key}`);
    if (typed.presence !== 'present' && typed.presence !== 'absent') {
      throw new OracleRuntimeError(`v2 expected entry for run ${runId}.${key} has unknown presence representation ${JSON.stringify(typed.presence)}`);
    }
    if (typed.provenance !== 'host') {
      throw new OracleRuntimeError(`v2 expected entry for run ${runId}.${key} provenance must be "host", got ${JSON.stringify(typed.provenance)}`);
    }
    if (typed.presence === 'present') {
      if (typeof typed.value !== 'string') {
        throw new OracleRuntimeError(`v2 expected entry for run ${runId}.${key} presence "present" requires a string value (values, missing keys and empty strings are distinct)`);
      }
      out.set(key, { presence: 'present', value: typed.value });
    } else {
      if (Object.prototype.hasOwnProperty.call(typed, 'value') && typed.value !== undefined) {
        throw new OracleRuntimeError(`v2 expected entry for run ${runId}.${key} presence "absent" cannot carry a value`);
      }
      out.set(key, { presence: 'absent' });
    }
  }
  return out;
}

// Normalize the expected_mutations ledger (v1 legacy {to,source} and v2 typed
// {presence,value,source} both normalize to typed presence entries). Only
// host-source transitions may be recorded; a non-host source is malformed.
function normalizeMutationsV2(mutations, runId, key) {
  const typed = assertObject(mutations, `expected_mutations entry for run ${runId}.${key}`);
  if (typed.source !== 'host') {
    throw new OracleRuntimeError(`expected_mutations for run ${runId}.${key} source must be "host" (only legitimate host-managed transitions are pinnable)`);
  }
  if (typed.presence === 'present') {
    if (typeof typed.value !== 'string') {
      throw new OracleRuntimeError(`expected_mutations for run ${runId}.${key} presence "present" requires a string value`);
    }
    return { presence: 'present', value: typed.value };
  }
  if (typed.presence === 'absent') {
    if (Object.prototype.hasOwnProperty.call(typed, 'value') && typed.value !== undefined) {
      throw new OracleRuntimeError(`expected_mutations for run ${runId}.${key} presence "absent" cannot carry a value`);
    }
    return { presence: 'absent' };
  }
  throw new OracleRuntimeError(`expected_mutations for run ${runId}.${key} has unknown presence representation ${JSON.stringify(typed.presence)}`);
}

// Build the normalized internal model from a parsed baseline file. Throws
// OracleRuntimeError (→ whole-oracle ERROR) on malformed input.
function normalizeReservedBaseline(baseline) {
  const object = assertObject(baseline, 'O12 reserved-key baseline');
  const version = object.schema_version;
  if (version !== O12_BASELINE_V1 && version !== O12_BASELINE_V2) {
    throw new OracleRuntimeError(`unsupported O12 reserved-key baseline schema_version ${JSON.stringify(version)} (supported: 1 legacy, 2)`);
  }
  if (object.producer !== 'host') {
    throw new OracleRuntimeError('O12 reserved-key baseline producer must be "host"; agent-produced inputs are not oracle truth');
  }
  requireExactReservedKeySet(object.supported_reserved_keys, 'O12 reserved-key baseline supported_reserved_keys');

  if (version === O12_BASELINE_V1) {
    // Legacy scope: DEFAULT post-batch scope — every snapshot run. The v1
    // input cannot shrink the denominator (no scope field) and enumerating a
    // key only asserts presence-with-value; anything not enumerated asserts
    // nothing, which keeps incomplete legacy v1 from ever PASSing.
    const rawRuns = object.runs ?? {};
    const rawMutations = object.expected_mutations ?? {};
    const runsObj = assertObject(rawRuns, 'v1 reserved-key baseline runs');
    const mutObj = assertObject(rawMutations, 'v1 reserved-key baseline expected_mutations');
    const runsById = indexByRunId(runsObj, 'v1 reserved-key baseline runs');
    const mutationsByRun = indexByRunId(mutObj, 'v1 reserved-key baseline expected_mutations');
    const expected = new Map();
    const ignoredNonReserved = new Map();
    for (const [runId, entry] of runsById) {
      const entryObj = assertObject(entry, `v1 reserved-key baseline entry for run ${runId}`);
      const keyed = new Map();
      let dropped = 0;
      for (const [key, value] of Object.entries(entryObj)) {
        if (!RESERVED_KEY_SET.has(key)) {
          dropped += 1; // never reserved coverage
          continue;
        }
        if (typeof value !== 'string') {
          throw new OracleRuntimeError(`v1 reserved-key baseline value for ${runId}.${key} must be a string`);
        }
        keyed.set(key, { presence: 'present', value });
      }
      if (dropped > 0) ignoredNonReserved.set(runId, dropped);
      expected.set(runId, keyed);
    }
    const mutations = new Map();
    for (const [runId, runMutations] of mutationsByRun) {
      const runMutObj = assertObject(runMutations, `v1 expected_mutations entry for run ${runId}`);
      const keyed = new Map();
      for (const [key, mutation] of Object.entries(runMutObj)) {
        if (!RESERVED_KEY_SET.has(key)) continue; // non-reserved mutations never legitimize
        const typed = assertObject(mutation, `v1 expected_mutations for run ${runId}.${key}`);
        if (typed.source !== 'host') {
          throw new OracleRuntimeError(`v1 expected_mutations for run ${runId}.${key} source must be "host"`);
        }
        if (typeof typed.to !== 'string') {
          throw new OracleRuntimeError(`v1 expected_mutations for run ${runId}.${key} requires a string "to" value`);
        }
        keyed.set(key, { presence: 'present', value: typed.to });
      }
      mutations.set(runId, keyed);
    }
    return {
      schema_version: O12_BASELINE_V1,
      scope: { mode: 'all-snapshot-runs' },
      expected,
      mutations,
      ignoredNonReserved,
    };
  }

  // schema_version 2.
  const scope = assertObject(object.scope, 'v2 reserved-key baseline scope');
  if (scope.mode !== 'all-snapshot-runs' && scope.mode !== 'explicit') {
    throw new OracleRuntimeError(`v2 reserved-key baseline scope.mode must be "all-snapshot-runs" or "explicit", got ${JSON.stringify(scope.mode)}`);
  }
  let admitted = null;
  if (scope.mode === 'explicit') {
    if (!Array.isArray(scope.run_ids)) {
      throw new OracleRuntimeError('v2 reserved-key baseline scope.mode "explicit" requires a run_ids array');
    }
    admitted = new Set();
    for (const rawId of scope.run_ids) {
      const bare = canonicalRunId(rawId, 'v2 reserved-key baseline scope.run_ids');
      if (admitted.has(bare)) {
        throw new OracleRuntimeError(`v2 reserved-key baseline scope.run_ids binds run ${bare} more than once`);
      }
      admitted.add(bare);
    }
  }
  const rawExpected = object.expected ?? {};
  const rawMutations = object.expected_mutations ?? {};
  const expectedObj = assertObject(rawExpected, 'v2 reserved-key baseline expected');
  const mutObj = assertObject(rawMutations, 'v2 reserved-key baseline expected_mutations');
  const expected = new Map();
  for (const [runId, entry] of Object.entries(expectedObj)) {
    const bare = canonicalRunId(runId, 'v2 reserved-key baseline expected');
    if (expected.has(bare)) {
      throw new OracleRuntimeError(`v2 reserved-key baseline expected binds run ${bare} more than once (ambiguous duplicate/cross-scope alias binding)`);
    }
    if (admitted !== null && !admitted.has(bare)) {
      // Explicit admission defines the run universe; an expected entry for a
      // run outside scope.run_ids is a cross-scope binding that would otherwise
      // be silently ignored (the in-scope loop never reaches it) — fail closed.
      throw new OracleRuntimeError(`v2 reserved-key baseline expected names run ${bare} outside the explicitly admitted scope.run_ids; expected entries must stay inside the admitted run universe`);
    }
    expected.set(bare, normalizeExpectedEntryV2(assertObject(entry, `v2 expected entry for run ${bare}`), bare));
  }
  const mutations = new Map();
  for (const [runId, runMutations] of Object.entries(mutObj)) {
    const bare = canonicalRunId(runId, 'v2 reserved-key baseline expected_mutations');
    if (admitted !== null && !admitted.has(bare)) {
      throw new OracleRuntimeError(`v2 reserved-key baseline expected_mutations names run ${bare} outside the explicitly admitted scope.run_ids; the mutation ledger must stay inside the admitted run universe`);
    }
    const runMutObj = assertObject(runMutations, `v2 expected_mutations entry for run ${bare}`);
    const keyed = new Map();
    for (const [key, mutation] of Object.entries(runMutObj)) {
      if (!RESERVED_KEY_SET.has(key)) {
        throw new OracleRuntimeError(`v2 expected_mutations for run ${bare} names non-reserved key ${JSON.stringify(key)}`);
      }
      keyed.set(key, normalizeMutationsV2(mutation, bare, key));
    }
    if (mutations.has(bare)) {
      throw new OracleRuntimeError(`v2 reserved-key baseline expected_mutations binds run ${bare} more than once`);
    }
    mutations.set(bare, keyed);
  }
  return { schema_version: O12_BASELINE_V2, scope: { mode: scope.mode, run_ids: admitted }, expected, mutations };
}

function loadReservedBaseline(invocation) {
  const envPath = process.env.TT_O12_BASELINE;
  let candidate = null;
  if (typeof envPath === 'string' && envPath.length > 0) {
    if (!path.isAbsolute(envPath)) throw new OracleRuntimeError('TT_O12_BASELINE must be an absolute path');
    candidate = envPath;
  } else {
    const defaultPath = path.join(invocation.evidenceDir, O12_BASELINE_FILENAME);
    if (fs.existsSync(defaultPath)) candidate = defaultPath;
  }
  if (candidate === null) return null;
  const resolved = requireContainedPath(invocation.campaignRoot, candidate, { kind: 'file', label: 'O12 reserved-key baseline' });
  if ((fs.statSync(resolved).mode & 0o222) !== 0) {
    throw new OracleRuntimeError('O12 reserved-key baseline must be read-only (a writable input cannot pin host-owned values)');
  }
  const baselineSha = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new OracleRuntimeError(`O12 reserved-key baseline is not valid JSON: ${error.message}`, { cause: error });
  }
  const baseline = normalizeReservedBaseline(raw);
  return { resolved, baseline, sha256: baselineSha, raw: raw };
}

// ── R4 reserved-key coverage evaluation (complete independently admitted
//    scope) ────────────────────────────────────────────────────────────────

// Bounded sample caps: divergent-key samples stay ≤5 (mirroring every other
// O12 leg); coverage-gap id lists stay ≤10 while their *_count totals are
// exact. Exact totals are never derived from capped arrays.
const OVERWRITE_SAMPLE_CAP = 5;
const GAP_SAMPLE_CAP = 10;

function finalKeyState(context, key) {
  return Object.prototype.hasOwnProperty.call(context, key)
    ? { present: true, value: context[key] }
    : { present: false, value: undefined };
}

// An expectation matches the stored final state exactly: values, missing keys
// and empty strings are distinct states.
function expectationMatches(expected, final) {
  if (expected.presence === 'absent') return !final.present;
  return final.present && final.value === expected.value;
}

function divergenceKind(expected, final) {
  if (!final.present) return 'key-removed';
  if (expected.presence === 'absent') return 'key-introduced';
  return 'value-changed';
}

// Evaluate the reserved-key leg against the normalized baseline model and the
// snapshot runs. runRows come from `SELECT id, context FROM runs`. Returns the
// reserved_key_leg record (result PASS/FAIL/NOT_EVALUABLE) and pushes
// O12_RESERVED_KEY_OVERWRITE findings (bounded samples) for divergences.
function evaluateReservedKeyCoverage(model, runRows, findings) {
  const snapshotIds = runRows.map((run) => String(run.id).toLowerCase());
  const snapshotSet = new Set(snapshotIds);
  const snapshotById = new Map(runRows.map((run) => [String(run.id).toLowerCase(), run]));
  const mode = model.scope.mode;
  const admitted = model.scope.run_ids ?? null; // Set | null
  const inScope = [];
  const admittedNotInSnapshot = [];
  const snapshotRunsOutsideAdmitted = [];
  const expectedNotInSnapshot = [];
  if (mode === 'explicit') {
    for (const bare of [...admitted].sort()) {
      if (snapshotSet.has(bare)) inScope.push(bare);
      else admittedNotInSnapshot.push(bare);
    }
    // The explicit run universe is a host admission reported as such: snapshot
    // runs outside it are surfaced (never silently dropped from the record).
    for (const id of snapshotIds) {
      if (!admitted.has(id)) snapshotRunsOutsideAdmitted.push(id);
    }
  } else {
    inScope.push(...snapshotIds);
    // Default all-snapshot scope (v1 and v2): a baseline expected entry for a
    // run absent from the snapshot is stale (e.g. the run was deleted after
    // host capture) and can never be compared. Surface it in the scope record
    // (exact count + bounded samples) instead of silently dropping it — the
    // pre-close code surfaced baseline_runs_not_in_snapshot; the post-close
    // default-mode record must keep that observability.
    for (const id of model.expected.keys()) {
      if (!snapshotSet.has(id)) expectedNotInSnapshot.push(id);
    }
    expectedNotInSnapshot.sort();
  }

  const overwriteSamples = [];
  let overwriteCount = 0;
  let keysChecked = 0;
  let keysExpectedPresent = 0;
  let keysExpectedAbsent = 0;
  let knownAbsencesChecked = 0;
  let emptyStringPresentMatches = 0;
  let hostTransitionMatches = 0;
  let runsCompared = 0;
  let runsFullyExpected = 0;
  let keysUnassertedTotal = 0;
  let nonReservedIgnored = 0;
  const runsWithoutEntry = [];
  const runsPartialEntry = [];
  const runsUnparseable = [];
  let runsWithoutEntryCount = 0;
  let runsPartialEntryCount = 0;
  let runsUnparseableCount = 0;

  for (const id of inScope) {
    const expected = model.expected.get(id);
    if (expected === undefined) {
      runsWithoutEntryCount += 1;
      if (runsWithoutEntry.length < GAP_SAMPLE_CAP) runsWithoutEntry.push(id);
      continue;
    }
    const unasserted = O12_RESERVED_CONTEXT_KEYS.filter((key) => !expected.has(key));
    keysUnassertedTotal += unasserted.length;
    if (unasserted.length > 0) {
      runsPartialEntryCount += 1;
      if (runsPartialEntry.length < GAP_SAMPLE_CAP) {
        runsPartialEntry.push({ run_id: id, unasserted_keys: unasserted.length });
      }
    }
    if (model.ignoredNonReserved?.get(id)) nonReservedIgnored += model.ignoredNonReserved.get(id);
    const run = snapshotById.get(id);
    let context = null;
    if (run?.context != null) {
      try {
        const parsed = JSON.parse(run.context);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) context = parsed;
      } catch {
        context = null;
      }
    }
    if (context === null) {
      // The run's stored context cannot be read back as an object, so the
      // pinned keys cannot be compared: coverage is unavailable for this run
      // (a parse finding already FAILs R4 when one exists; the reserved
      // sub-leg fails closed rather than guessing).
      runsUnparseableCount += 1;
      if (runsUnparseable.length < GAP_SAMPLE_CAP) runsUnparseable.push(id);
      continue;
    }
    const runMutations = model.mutations.get(id) ?? new Map();
    let comparedThisRun = false;
    for (const key of O12_RESERVED_CONTEXT_KEYS) {
      const exp = expected.get(key);
      if (exp === undefined) continue; // unasserted — never counted as coverage
      comparedThisRun = true;
      keysChecked += 1;
      if (exp.presence === 'present') keysExpectedPresent += 1;
      else keysExpectedAbsent += 1;
      const final = finalKeyState(context, key);
      if (expectationMatches(exp, final)) {
        if (exp.presence === 'absent') knownAbsencesChecked += 1;
        else if (exp.value === '') emptyStringPresentMatches += 1;
        continue;
      }
      // Legitimate host-managed transition recorded in the pinned ledger?
      const mutation = runMutations.get(key);
      if (mutation !== undefined && expectationMatches(mutation, final)) {
        hostTransitionMatches += 1;
        continue;
      }
      overwriteCount += 1;
      if (overwriteSamples.length < OVERWRITE_SAMPLE_CAP) {
        overwriteSamples.push({ run_id: id, key, kind: divergenceKind(exp, final) });
      }
    }
    if (comparedThisRun) runsCompared += 1;
    if (unasserted.length === 0) runsFullyExpected += 1;
  }

  for (const sample of overwriteSamples) {
    findings.add('O12_RESERVED_KEY_OVERWRITE', 'reserved context key differs from the host-owned baseline', {
      run_id: sample.run_id, key: sample.key, kind: sample.kind,
    });
  }

  const gapCount = runsWithoutEntry.length + runsPartialEntry.length + runsUnparseable.length;
  let result;
  let reason;
  if (overwriteCount > 0) {
    result = 'FAIL';
    reason = 'reserved context key(s) differ from the host-owned baseline/probe input (demonstrated divergence)';
  } else if (gapCount > 0 || runsCompared === 0) {
    result = 'NOT_EVALUABLE';
    reason = runsCompared === 0
      ? 'no in-scope snapshot run could be compared against host-captured expectations (zero coverage; a zero-overlap baseline can never establish non-overwrite)'
      : 'reserved-key coverage is incomplete: some in-scope run(s) lack complete host-captured typed presence/absence for the entire reserved-key pin';
  } else {
    result = 'PASS';
    reason = 'every in-scope run matched its host-captured typed reserved-key expectations (values, known absences and empty strings verified)';
  }

  // Storm O12 probe-close (root review): a reserved-key PASS over an EXPLICIT
  // host-admitted subset must be unmistakably scoped — full_snapshot_covered is
  // true ONLY when every snapshot row was compared over the ENTIRE reserved-key
  // pin (ALL rows × ALL 17 keys, exact totals), false for any subset admission,
  // any admitted run absent from the snapshot, or any coverage gap. It records
  // comparison COVERAGE, not the verdict: a fully-compared FAIL (divergence) is
  // still full coverage; a subset PASS is not full-state-integrity coverage.
  const fullSnapshotCovered = snapshotIds.length > 0
    && inScope.length === snapshotIds.length
    && (mode !== 'explicit' || admittedNotInSnapshot.length === 0)
    && runsCompared === snapshotIds.length
    && keysChecked === O12_RESERVED_CONTEXT_KEYS.length * snapshotIds.length;

  const scopeRecord = { mode, full_snapshot_covered: fullSnapshotCovered };
  if (mode === 'explicit') {
    scopeRecord.run_universe_total = admitted.size;
    scopeRecord.snapshot_runs_total = snapshotIds.length;
    scopeRecord.snapshot_runs_in_scope = inScope.length;
    scopeRecord.snapshot_runs_outside_admitted_scope_count = snapshotRunsOutsideAdmitted.length;
    scopeRecord.snapshot_runs_outside_admitted_scope_samples = snapshotRunsOutsideAdmitted.slice(0, GAP_SAMPLE_CAP);
    scopeRecord.admitted_runs_not_in_snapshot_count = admittedNotInSnapshot.length;
    scopeRecord.admitted_runs_not_in_snapshot_samples = admittedNotInSnapshot.slice(0, GAP_SAMPLE_CAP);
  } else {
    scopeRecord.snapshot_runs_total = snapshotIds.length;
    scopeRecord.snapshot_runs_in_scope = snapshotIds.length;
    // Stale baseline expectations (runs absent from the snapshot): exact count
    // + bounded samples in the scope record so a baseline that outlives its
    // runs stays observable rather than vanishing (regression pin for the
    // pre-close baseline_runs_not_in_snapshot surfacing).
    scopeRecord.expected_runs_not_in_snapshot_count = expectedNotInSnapshot.length;
    scopeRecord.expected_runs_not_in_snapshot_samples = expectedNotInSnapshot.slice(0, GAP_SAMPLE_CAP);
  }

  return {
    result,
    reason,
    scope: scopeRecord,
    schema_version: model.schema_version,
    runs_compared: runsCompared,
    runs_fully_expected: runsFullyExpected,
    keys_checked: keysChecked,
    keys_expected_present: keysExpectedPresent,
    keys_expected_absent: keysExpectedAbsent,
    known_absences_checked: knownAbsencesChecked,
    empty_string_present_matches: emptyStringPresentMatches,
    host_transition_matches: hostTransitionMatches,
    overwrite_count: overwriteCount,
    overwrite_samples: overwriteSamples,
    keys_unasserted_total: keysUnassertedTotal,
    non_reserved_keys_ignored: nonReservedIgnored,
    coverage_gaps: {
      runs_without_expected_entry_count: runsWithoutEntryCount,
      runs_without_expected_entry_samples: runsWithoutEntry,
      runs_with_partial_expected_entry_count: runsPartialEntryCount,
      runs_with_partial_expected_entry_samples: runsPartialEntry,
      runs_with_unparseable_context_count: runsUnparseableCount,
      runs_with_unparseable_context_samples: runsUnparseable,
    },
    baseline_total_runs_expected: model.expected.size,
  };
}

// ── main evaluator ───────────────────────────────────────────────────────────

export function evaluateO12(invocation) {
  const findings = new FindingCollector();
  const observations = [];
  const database = openEvidenceDatabase(invocation);
  const coverage = {};
  try {
    const userVersion = (database.prepare('PRAGMA user_version').get()).user_version;
    // Fail closed on a version/shape this build cannot judge: no descriptor
    // means the snapshot cannot be judged against this build's schema
    // expectations, so the whole oracle errors out (exit 2, no evidence
    // artifact) naming the observed version and the supported set. A v12 stamp
    // whose column shape matches NEITHER pre-union lineage, and a v13/v14 store
    // missing either union column, are equally unjudgeable and error out the
    // same way. Never NOT_EVALUABLE, never PASS.
    // Core-table presence is checked FIRST so a structurally malformed store
    // (no runs/steps/stories at all) keeps its own precise fail-closed message
    // instead of being misread as a missing-lineage-column shape.
    const tables = tableNames(database);
    const missingCoreTables = ['runs', 'steps', 'stories'].filter((table) => !tables.includes(table));
    if (missingCoreTables.length > 0) {
      throw new OracleRuntimeError(`snapshot lacks core tamandua tables: ${missingCoreTables.join(', ')}`);
    }
    const { descriptor, lineage, lineageColumns } = resolveO12SchemaExpectation(database, userVersion);
    const coreTables = descriptor.coreTables;
    const schemaRecord = {
      user_version: userVersion,
      supported_user_versions: [...O12_SUPPORTED_SCHEMA_VERSIONS],
      supported_version: true,
      lineage,
      lineage_discriminators: lineageColumns,
      tables: tables,
      declared_foreign_keys: {},
      core_columns: {},
      column_declarations: [],
    };
    for (const table of Object.keys(coreTables)) schemaRecord.declared_foreign_keys[table] = declaredForeignKeys(database, table);
    // core_columns documents the required-column contract this build enforces
    // for the snapshot's version (never left as a dead empty map). Every listed
    // column has already been verified present (or the oracle ERRORs), so the
    // record states exactly what this version's descriptor required.
    for (const [table, requiredColumns] of Object.entries(coreTables)) {
      schemaRecord.core_columns[table] = { required: [...requiredColumns] };
    }

    // ── R1 structural / integrity / orphans ─────────────────────────────
    {
      // Safety net: the core tables were already verified present before the
      // descriptor was resolved (a missing core table is a whole-oracle ERROR
      // raised there), so this can only fire if the table set changed under us.
      const missingCore = Object.keys(coreTables).filter((table) => !tables.includes(table));
      if (missingCore.length > 0) {
        throw new OracleRuntimeError(`snapshot lacks core tamandua tables: ${missingCore.join(', ')}`);
      }
      const missingColumns = [];
      for (const [table, required] of Object.entries(coreTables)) {
        const present = columnsOf(database, table);
        for (const column of required) {
          if (!present.has(column)) missingColumns.push(`${table}.${column}`);
        }
      }
      if (missingColumns.length > 0) {
        // Missing required columns cannot produce a vacuous pass: the snapshot
        // is malformed for the supported schema → ERROR-grade structural fail.
        throw new OracleRuntimeError(`snapshot lacks required schema columns: ${missingColumns.join(', ')}`);
      }
      // Declared type/default of every version-added column in this version's
      // universe (the chain's target_moved_reroute_count / preclaim_death_count
      // / matchlock_policy), judged from PRAGMA table_info. A mismatch is a
      // judgeable PRODUCT finding that makes R1 FAIL — never a whole-oracle
      // ERROR: the store is usable, its declared column shape just disagrees
      // with the schema chain its version number promises. Every declared
      // column is also a required column (checked above), so a row for each one
      // always exists here.
      const columnDeclarationChecks = [];
      for (const [qualified, expected] of Object.entries(descriptor.columnDeclarations ?? {})) {
        const [table, column] = qualified.split('.');
        const row = database.prepare(`PRAGMA table_info(${table})`).all()
          .find((entry) => entry.name === column);
        if (row === undefined) continue;
        const observedType = typeof row.type === 'string' ? row.type.trim().toUpperCase() : '';
        const expectedType = String(expected.type).trim().toUpperCase();
        const observedDefault = row.dflt_value === null || row.dflt_value === undefined
          ? null
          : String(row.dflt_value);
        const expectedDefault = expected.default === null || expected.default === undefined
          ? null
          : String(expected.default);
        const typeOk = observedType === expectedType;
        const defaultOk = observedDefault === expectedDefault;
        const check = {
          column: qualified,
          expected_type: expected.type,
          observed_type: row.type ?? null,
          expected_default: expectedDefault,
          observed_default: observedDefault,
          type_ok: typeOk,
          default_ok: defaultOk,
          status: typeOk && defaultOk ? 'PASS' : 'FAIL',
        };
        columnDeclarationChecks.push(check);
        if (!typeOk || !defaultOk) {
          findings.add(
            'O12_SCHEMA_COLUMN_DECLARATION_MISMATCH',
            `column ${qualified} is declared ${row.type ?? '(no type)'} DEFAULT ${observedDefault === null ? 'NULL' : observedDefault}, but the schema chain declares ${expected.type} DEFAULT ${expectedDefault === null ? 'NULL' : expectedDefault}`,
            { column: qualified, expected_type: expected.type, observed_type: row.type ?? null, expected_default: expectedDefault, observed_default: observedDefault },
          );
        }
      }
      schemaRecord.column_declarations = columnDeclarationChecks;
      // matchlock_policy VALUE sub-check (R1 sub-check; no new leg). The
      // v13 / Matchlock-lineage v12 universes carry the host-owned
      // execution-isolation policy as JSON on every run row: a malformed
      // policy blob is judgeable PRODUCT data and must be a visible finding,
      // never an unread value and never a whole-oracle ERROR. NULL is the
      // native (non-Matchlock) case and stays VALID. Counts are FULL totals
      // over every run row of the universe, kept separate from the bounded
      // sample list (≤5) that drives the representative findings.
      const policyUniverse = (coreTables.runs ?? []).includes('matchlock_policy');
      let policyRecord;
      if (policyUniverse) {
        const policyRows = database.prepare('SELECT id, matchlock_policy AS policy FROM runs ORDER BY id').all();
        let validPolicies = 0;
        let nativeRuns = 0;
        let invalidPolicyCount = 0;
        const invalidPolicySamples = [];
        for (const row of policyRows) {
          const outcome = validateO12MatchlockPolicyValue(row.policy);
          if (outcome.status === 'native') {
            nativeRuns += 1;
            continue;
          }
          if (outcome.status === 'valid') {
            validPolicies += 1;
            continue;
          }
          invalidPolicyCount += 1;
          if (invalidPolicySamples.length >= O12_MATCHLOCK_POLICY_SAMPLE_CAP) continue;
          const sample = {
            run_id: String(row.id),
            error_count: outcome.errors.length,
            errors: outcome.errors.slice(0, 5),
          };
          invalidPolicySamples.push(sample);
          findings.add(
            'O12_SCHEMA_MATCHLOCK_POLICY_INVALID',
            `runs.matchlock_policy for run ${String(row.id)} is not a valid Matchlock policy: ${sample.errors.join('; ')}`,
            { run_id: String(row.id), error_count: outcome.errors.length, errors: sample.errors },
          );
        }
        policyRecord = {
          status: invalidPolicyCount === 0 ? 'PASS' : 'FAIL',
          policies_checked: policyRows.length,
          valid_policies: validPolicies,
          native_runs: nativeRuns,
          invalid_policy_count: invalidPolicyCount,
          invalid_policy_samples: invalidPolicySamples,
          sample_cap: O12_MATCHLOCK_POLICY_SAMPLE_CAP,
          policy_version: O12_MATCHLOCK_POLICY_VERSION,
          harnesses: [...O12_MATCHLOCK_POLICY_HARNESSES],
          required_keys: [...O12_MATCHLOCK_POLICY_REQUIRED_KEYS],
          note: 'exact totals over every run row of this universe; NULL is the native (non-Matchlock) case and is valid; only the sample list is capped',
        };
      } else {
        // The column is out of this version's universe. A store may still
        // CARRY it as an accepted extra column (descriptors state required
        // columns; extra columns are never rejected) — record how many such
        // rows exist so the unjudged value is visible, and never fail on it.
        const carriesColumn = columnsOf(database, 'runs')?.has('matchlock_policy') ?? false;
        const outOfUniversePolicyRows = carriesColumn
          ? database.prepare('SELECT COUNT(*) AS count FROM runs WHERE matchlock_policy IS NOT NULL').get().count
          : 0;
        policyRecord = {
          status: 'NOT_APPLICABLE',
          reason: `the snapshot's version universe (user_version ${userVersion}, lineage ${lineage}) does not carry runs.matchlock_policy; policy-value judging is scoped to the v13 and Matchlock-lineage v12 universes`,
          policies_checked: 0,
          valid_policies: 0,
          native_runs: 0,
          invalid_policy_count: 0,
          invalid_policy_samples: [],
          sample_cap: O12_MATCHLOCK_POLICY_SAMPLE_CAP,
          out_of_universe_policy_rows: outOfUniversePolicyRows,
          policy_version: O12_MATCHLOCK_POLICY_VERSION,
          required_keys: [...O12_MATCHLOCK_POLICY_REQUIRED_KEYS],
          note: 'accepted extra columns outside the version universe are recorded, never policy-judged',
        };
      }
      const integrity = database.prepare('PRAGMA integrity_check').all();
      const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
      const fkViolations = database.prepare('PRAGMA foreign_key_check').all();
      const orphanChecks = [];
      const orphanTargets = new Set(descriptor.orphanMatrix.map((entry) => entry.parentTable));
      const parentSets = {};
      const presentTables = new Set(tables);
      for (const target of orphanTargets) {
        if (presentTables.has(target)) {
          parentSets[target] = new Set(
            database.prepare(`SELECT id AS id FROM ${target}`).all().map((row) => row.id),
          );
        }
      }
      for (const entry of descriptor.orphanMatrix) {
        const childCols = columnsOf(database, entry.table);
        const parentCols = columnsOf(database, entry.parentTable);
        const present = {
          child_table: childCols !== null,
          parent_table: parentCols !== null,
          child_column: childCols !== null && childCols.has(entry.childColumn),
          parent_column: parentCols !== null && parentCols.has(entry.parentColumn),
        };
        const declaredFk = childCols !== null
          && (schemaRecord.declared_foreign_keys[entry.table]?.some(
            (fk) => fk.from === entry.childColumn && fk.table === entry.parentTable,
          ) ?? false);
        if (!present.child_table || !present.parent_table || !present.child_column || !present.parent_column) {
          // A matrix row whose child/parent table or column is absent cannot be
          // orphan-checked. Record it as an explicit NOT_EVALUABLE sub-check
          // with the present flags — never a silent skip — so an unsupported
          // sub-check stays visible in coverage (R6) instead of vanishing.
          const missing = [
            ...(present.child_table ? [] : [`child table ${entry.table}`]),
            ...(present.parent_table ? [] : [`parent table ${entry.parentTable}`]),
            ...(present.child_column ? [] : [`column ${entry.table}.${entry.childColumn}`]),
            ...(present.parent_column ? [] : [`column ${entry.parentTable}.${entry.parentColumn}`]),
          ].join(', ');
          orphanChecks.push({
            table: entry.table,
            child_column: entry.childColumn,
            parent: `${entry.parentTable}.${entry.parentColumn}`,
            declared_fk: declaredFk,
            status: 'NOT_EVALUABLE',
            reason: `orphan probe not run: missing ${missing}`,
            present,
          });
          continue;
        }
        const parent = parentSets[entry.parentTable];
        if (parent === undefined) continue;
        const rowIdColumn = entry.table === 'run_worktrees' ? 'run_id' : 'id';
        const rows = database.prepare(
          `SELECT ${rowIdColumn} AS row_id, ${entry.childColumn} AS child_value FROM ${entry.table} WHERE ${entry.childColumn} IS NOT NULL`,
        ).all();
        // Exact-total discipline: orphan_count is the FULL count over every
        // child row, kept separate from the capped sample list (≤5). The old
        // code read orphan_count from the sample array length, so 7 orphans
        // were reported as 5 whenever the sample cap filled — the same
        // capped-array counting mistake the R4 parse/type counters had.
        const orphanSamples = [];
        let orphanCount = 0;
        for (const row of rows) {
          const child = entry.canonical === 'run-prefix' ? bareId(row.child_value) : row.child_value;
          if (!parent.has(child)) {
            orphanCount += 1;
            if (orphanSamples.length < 5) orphanSamples.push({ row_id: String(row.row_id), value: String(row.child_value).slice(0, 60) });
          }
        }
        orphanChecks.push({
          table: entry.table, child_column: entry.childColumn, parent: `${entry.parentTable}.${entry.parentColumn}`,
          declared_fk: declaredFk,
          status: orphanCount === 0 ? 'PASS' : 'FAIL',
          orphan_count: orphanCount,
          present,
        });
        for (const sample of orphanSamples) {
          findings.add('O12_STRUCT_ORPHAN', `orphan ${entry.table}.${entry.childColumn} row without ${entry.parentTable}.${entry.parentColumn}`, {
            table: entry.table, column: entry.childColumn, parent: `${entry.parentTable}.${entry.parentColumn}`,
            row_id: sample.row_id,
          });
        }
      }
      if (!integrityOk) {
        findings.add('O12_STRUCT_INTEGRITY_FAILED', `PRAGMA integrity_check did not return ok`, {
          rows: integrity.map((row) => row.integrity_check).slice(0, 5),
        });
      }
      if (fkViolations.length > 0) {
        findings.add('O12_STRUCT_FOREIGN_KEY_FAILED', 'PRAGMA foreign_key_check reported violations', {
          samples: fkViolations.slice(0, 5).map((row) => ({
            table: row.table, rowid: row.rowid, parent: row.parent, fkid: row.fkid,
          })),
          count: fkViolations.length,
        });
      }
      const structuralFail = !integrityOk || fkViolations.length > 0
        || orphanChecks.some((check) => check.status === 'FAIL')
        || columnDeclarationChecks.some((check) => check.status === 'FAIL')
        || policyRecord.invalid_policy_count > 0;
      const orphanNotEvaluable = orphanChecks.some((check) => check.status === 'NOT_EVALUABLE');
      coverage.R1 = {
        obligation: 'structural-integrity-orphans',
        // A skipped (absent child/parent table or column) orphan sub-check is
        // NOT_EVALUABLE: R1 cannot silently PASS while an orphan probe it owns
        // never ran. Only a fully-present matrix can yield PASS here.
        result: structuralFail ? 'FAIL' : (orphanNotEvaluable ? 'NOT_EVALUABLE' : 'PASS'),
        integrity_check: integrityOk ? 'ok' : 'failed',
        foreign_key_check_violations: fkViolations.length,
        column_declaration_checks: columnDeclarationChecks,
        column_declaration_mismatch_count:
          columnDeclarationChecks.filter((check) => check.status === 'FAIL').length,
        // Sub-check record (same shape as the structural observation): the
        // exact policy totals plus the capped representative sample list.
        matchlock_policy: policyRecord,
        matchlock_policy_invalid_count: policyRecord.invalid_policy_count,
        orphan_checks: orphanChecks.map((check) => {
          const compact = {
            table: check.table, child_column: check.child_column, parent: check.parent,
            declared_fk: check.declared_fk, status: check.status, present: check.present,
          };
          if (check.orphan_count !== undefined) compact.orphan_count = check.orphan_count;
          else compact.reason = check.reason;
          return compact;
        }),
        note: 'every ORPHAN_MATRIX row is recorded with its own status; an absent child/parent table or column leaves that sub-check NOT_EVALUABLE (visible, never silently skipped)',
      };
      observations.push({ scope: 'structural', schema_metadata: schemaRecord, matchlock_policy: policyRecord, orphan_checks: orphanChecks });
    }

    // ── R2 run_number uniqueness (present rows) ─────────────────────────
    {
      const runs = database.prepare('SELECT id, run_number FROM runs ORDER BY id').all();
      const nullNumbers = runs.filter((run) => run.run_number === null);
      const invalidNumbers = runs.filter((run) => run.run_number !== null
        && (!Number.isSafeInteger(run.run_number) || run.run_number <= 0));
      const seen = new Map();
      for (const run of runs) {
        if (run.run_number === null) continue;
        if (!seen.has(run.run_number)) seen.set(run.run_number, []);
        seen.get(run.run_number).push(run.id);
      }
      const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1);
      for (const sample of nullNumbers.slice(0, 5)) {
        findings.add('O12_RUN_NUMBER_NULL', 'run row has no run_number', { run_id: sample.id });
      }
      for (const run of invalidNumbers.slice(0, 5)) {
        findings.add('O12_RUN_NUMBER_INVALID', 'run_number is not a positive integer', { run_id: run.id, observed: String(run.run_number) });
      }
      for (const [number, ids] of duplicates.slice(0, 5)) {
        findings.add('O12_RUN_NUMBER_DUPLICATE', 'run_number is not unique among present run rows', {
          run_number: number, run_ids: ids.slice(0, 5),
        });
      }
      const counts = runs.map((run) => run.run_number).filter((n) => n !== null);
      coverage.R2 = {
        obligation: 'run-number-uniqueness',
        result: nullNumbers.length === 0 && invalidNumbers.length === 0 && duplicates.length === 0 ? 'PASS' : 'FAIL',
        rows_checked: runs.length,
        null_count: nullNumbers.length,
        invalid_count: invalidNumbers.length,
        duplicate_number_count: duplicates.length,
        // Characterization, not a violation: the native allocator is
        // COALESCE(MAX(run_number),0)+1 in the INSERT subquery
        // (src/installer/run.ts), so deleting the highest-numbered row and
        // creating another MAY reuse that number. Monotonicity across deletes
        // is therefore outside snapshot observability and is characterized by
        // the owned real-API run-number probe in the O12 calibration gate,
        // never judged from a snapshot.
        allocation_policy: 'MAX+1 (COALESCE(MAX(run_number),0)+1); delete-recreate reuse is legal and NOT judged here',
        observed_min: counts.length === 0 ? null : Math.min(...counts),
        observed_max: counts.length === 0 ? null : Math.max(...counts),
      };
      observations.push({ scope: 'run-numbers', ...coverage.R2, duplicate_sample_run_ids: duplicates.slice(0, 5).map(([, ids]) => ids) });
    }

    // ── R3 timestamps ────────────────────────────────────────────────────
    {
      const timeSummary = summarizeTimestamps(database, findings, observations, descriptor);
      const timeFail = timeSummary.invalidCount > 0
        || timeSummary.nativeMixed > 0
        || timeSummary.pairMismatchCount > 0
        || timeSummary.orderViolationCount > 0;
      coverage.R3 = {
        obligation: 'timestamp-uniformity-instant-order',
        result: timeFail ? 'FAIL' : 'PASS',
        invalid_value_count: timeSummary.invalidCount,
        native_format_mix_column_count: timeSummary.nativeMixed,
        pair_format_mismatch_count: timeSummary.pairMismatchCount,
        order_violation_count: timeSummary.orderViolationCount,
        // Syntactic format and instant ordering are recorded separately: a
        // value can be a valid instant yet live in a non-uniform native shape,
        // and naive SQLite values carry second-precision ordering
        // indeterminacy that the oracle resolves in favor of the row.
        note: 'shape uniformity and instant ordering are separate sub-checks; native ISO/SQLite mixing is a TIME finding, not silently waived',
      };
    }

    // ── R4 context JSON + reserved keys ──────────────────────────────────
    // A PRESENT but unusable baseline (unreadable, writable, uncontained,
    // malformed JSON/schema, wrong producer, drifted key set, ambiguous alias
    // bindings) is malformed evidence for this input and fails closed as
    // ERROR; only an ABSENT baseline degrades the reserved-key sub-leg to
    // NOT_EVALUABLE.
    let reservedLeg = null;
    const reservedBaseline = loadReservedBaseline(invocation);
    {
      const runs = database.prepare('SELECT id, context FROM runs ORDER BY id').all();
      // Exact-total discipline (B): parse_failure_count / type_failure_count
      // are FULL counters over every run row, kept separate from the bounded
      // sample list (≤5) used only to emit representative findings. The old
      // code read the count from the capped sample array, so >5 failures
      // under-reported — the same capped-array mistake R1's orphan count had.
      const parseFailureSamples = [];
      const typeFailureSamples = [];
      let parseFailureCount = 0;
      let typeFailureCount = 0;
      const valueTypeHistogram = {};
      for (const run of runs) {
        let parsed;
        try {
          parsed = JSON.parse(run.context);
        } catch {
          parseFailureCount += 1;
          if (parseFailureSamples.length < 5) parseFailureSamples.push(String(run.id));
          continue;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          typeFailureCount += 1;
          if (typeFailureSamples.length < 5) typeFailureSamples.push(String(run.id));
          continue;
        }
        for (const [key, value] of Object.entries(parsed)) {
          const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          valueTypeHistogram[kind] = (valueTypeHistogram[kind] ?? 0) + 1;
        }
      }
      for (const runId of parseFailureSamples) {
        findings.add('O12_CONTEXT_UNPARSEABLE', 'run context is not valid JSON', { run_id: runId });
      }
      for (const runId of typeFailureSamples) {
        findings.add('O12_CONTEXT_TYPE_INVALID', 'run context JSON does not parse to an object', { run_id: runId });
      }
      // Reserved-key final-state integrity against the host-owned baseline.
      if (reservedBaseline !== null) {
        const leg = evaluateReservedKeyCoverage(reservedBaseline.baseline, runs, findings);
        reservedLeg = {
          ...leg,
          input: O12_BASELINE_FILENAME,
          baseline_sha256: reservedBaseline.sha256,
        };
      }
      if (reservedLeg === null) {
        reservedLeg = {
          result: 'NOT_EVALUABLE',
          reason: 'no host-owned reserved-key baseline/probe input supplied; a final snapshot alone cannot establish historical non-overwrite (agent output is never expected truth)',
        };
      }
      coverage.R4 = {
        obligation: 'context-json-reserved-keys',
        // Parse/type failures are real product findings and FAIL the leg on
        // their own; the reserved-key sub-leg is judged separately and only
        // dominates when no parse/type failure exists.
        result: parseFailureCount > 0 || typeFailureCount > 0 ? 'FAIL' : reservedLeg.result,
        parse_failure_count: parseFailureCount,
        type_failure_count: typeFailureCount,
        reserved_key_leg: reservedLeg,
        context_value_type_histogram: valueTypeHistogram,
        runs_checked: runs.length,
      };
      observations.push({ scope: 'context', runs_checked: runs.length, value_type_histogram: valueTypeHistogram, reserved_key_leg: reservedLeg });
    }

    // ── R5 composite serial state ────────────────────────────────────────
    {
      const serial = evaluateSerialState(database, findings, observations);
      coverage.R5 = {
        obligation: 'serial-composite-state',
        result: serial.violationCount === 0 ? 'PASS' : 'FAIL',
        violation_count: serial.violationCount,
        note: 'judged on RAW stored statuses (DISP display mapping applied only for reporting; raw running/null verify_each loop displays "verifying")',
      };
    }

    // ── R6 coverage/result record ─────────────────────────────────────────
    const legStatuses = Object.entries(coverage).map(([leg, record]) => ({ leg, result: record.result }));
    const ranks = legStatuses.map((record) => resultRank(record));
    let overall = 'PASS';
    if (ranks.includes(O12_RESULT_ORDER.FAIL)) overall = 'FAIL';
    else if (ranks.includes(O12_RESULT_ORDER.NOT_EVALUABLE)) overall = 'NOT_EVALUABLE';
    coverage.R6 = {
      obligation: 'per-obligation-coverage',
      result: 'PASS',
      legs: legStatuses,
      overall,
      mapping: 'FAIL dominates NOT_EVALUABLE dominates PASS; every unsupported/missing leg is visible in coverage',
    };

    const evidence = writeEvidenceJson(invocation, 'o12-db-integrity.json', {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      oracle_id: 'O12',
      overall_result: overall,
      coverage,
      observations,
      finding_ids: findings.toJSON().map((finding) => finding.id),
    }, 'sqlite-db-integrity');

    return {
      result: overall,
      findings: findings.toJSON(),
      evidence: [evidence],
    };
  } finally {
    database.close();
  }
}
