#!/usr/bin/env node

// o12-reserved-key-probe.mjs — controlled step-ops behavioral probe proving
// that ALL SEVENTEEN native reserved context keys are never overwritten OR
// introduced by agent KEY: output through the REAL completeStep merge.
//
// Storm O12 probe-close (root review 20:18:50Z): the previous probe seeded and
// attempted only THIRTEEN keys while advertising reserved_keys_guarded=17, and
// derived its preserved count from the seeded object rather than from an
// independent per-key verification. This probe:
//
//   * exercises every one of the 17 reserved keys against the real product
//     completeStep merge (stable pinned dist) in TWO owned runs:
//       - present-preservation: every reserved key is seeded present with a
//         freshly-owned value; malicious agent output attempts to overwrite
//         all 17 -> every seeded value must be preserved byte-for-byte.
//       - absent-introduction: the run context carries NONE of the reserved
//         keys; malicious output attempts to introduce all 17 -> every key
//         must stay absent (an "absent" key is never proven guarded unless
//         introduction is actually attempted).
//   * asserts equality of the INDEPENDENTLY enumerated expected/attempted/
//     checked reserved-key sets (expected = keys extracted from the pinned
//     native source literal; attempted = keys actually present in the output
//     text; checked = keys actually verified preserved/stayed-absent) and
//     reports per-key coverage — never a count disguised by a constant.
//   * uses FRESH OWNED paths inside the probe root for every seeded and
//     attempted value (never the fixed /tmp/harness-a or /tmp/harness-b
//     context paths; those external paths are neither inspected nor touched).
//   * verifies candidate/stable-dist compatibility BEFORE any fixture
//     allocation, environment mutation or product import/operation.
//   * strips parent Tamandua run/worker/step authority from the probe
//     environment (TAMANDUA_RUN_ID / TAMANDUA_WORKER_* / TAMANDUA_CONTROL_PORT)
//     and runs with a strict private HOME/TAMANDUA_STATE_DIR/TAMANDUA_DB_PATH/
//     TMPDIR + TAMANDUA_TEST_GUARD=1, zero real providers.
//   * POSITIVELY observes exact owned DB closure: a close error (or an
//     injected close error, env O12_PROBE_INJECT_DB_CLOSE_ERROR=1) makes the
//     probe NON-green — no swallowed close failure masquerades as closed.
//
// Exit 0 + JSON result on success; nonzero exit on any deviation.

import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const STEP_OPS_TS = path.join(REPO_ROOT, 'src', 'installer', 'step-ops.ts');
// Stable pinned product build the probe imports (library functions only; the
// step lifecycle CLI is never invoked with live state). Host-portable default
// (STORM-SEED-QUALIFY US-010): the repo's OWN dist, resolved from this probe's
// location, so the candidate/stable source-match guard holds on any host (a
// hardcoded /opt/tamandua/dist refuses every candidate branch when the live
// install is a different product lineage). TAMANDUA_O12_PROBE_DIST overrides.
const DIST_DIR = process.env.TAMANDUA_O12_PROBE_DIST ?? path.join(REPO_ROOT, 'dist');
const INJECT_DB_CLOSE_ERROR = process.env.O12_PROBE_INJECT_DB_CLOSE_ERROR === '1';

// ── candidate/stable-dist compatibility FIRST (pre-effect) ────────────────
// Read-only source inspection happens before any fixture allocation,
// environment mutation or product import/operation. A drift between the repo
// candidate and the stable pinned dist (or a changed reserved-key literal)
// refuses to characterize a drifted source with exit 2.
function extractReservedKeys(source) {
  const start = source.indexOf('const RESERVED_CONTEXT_KEYS = new Set([');
  if (start < 0) return null;
  const bodyStart = source.indexOf('[', start) + 1;
  const bodyEnd = source.indexOf(']);', bodyStart);
  const body = source.slice(bodyStart, bodyEnd);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

const stepOpsSource = fs.readFileSync(STEP_OPS_TS, 'utf8');
const stepOpsSha = createHash('sha256').update(stepOpsSource).digest('hex');
const distPkg = JSON.parse(fs.readFileSync(path.join(DIST_DIR, '..', 'package.json'), 'utf8'));
const distVersion = distPkg.version ?? 'unknown';
const distRevision = distPkg.gitHead ?? distPkg._resolved ?? 'unknown';

// Independently enumerated expected pin: the 17 keys extracted straight from
// the pinned native source literal. The probe literal below is guarded to
// equal it (drift -> exit 2), so the expected set is never self-derived.
const nativeReserved = extractReservedKeys(stepOpsSource);
const EXPECTED_RESERVED = [
  'repo', 'working_directory_for_harness', 'task', 'run_id', 'workspace_mode',
  'worktree_path', 'worktree_origin_repository', 'worktree_origin_ref', 'worktree_origin_sha',
  'original_branch', 'merge_gate', 'fail_missing', 'test_cmd_raw',
  'test_cmd_review_required', 'test_cmd_review_candidate', 'test_cmd_review_established',
  'test_cmd_rewriter_step',
].sort();
if (nativeReserved === null || JSON.stringify(nativeReserved) !== JSON.stringify(EXPECTED_RESERVED)) {
  console.error('RESERVED_CONTEXT_KEYS drifted from src/installer/step-ops.ts — refresh the probe literal');
  process.exit(2);
}

const stableStepOpsTs = path.join(DIST_DIR, '..', 'src', 'installer', 'step-ops.ts');
const stableSource = fs.readFileSync(stableStepOpsTs, 'utf8');
const distSource = fs.readFileSync(path.join(DIST_DIR, 'installer', 'step-ops.js'), 'utf8');
const sourceMatchesDist = createHash('sha256').update(stableSource).digest('hex') === stepOpsSha
  && JSON.stringify(extractReservedKeys(stableSource)) === JSON.stringify(EXPECTED_RESERVED)
  && extractReservedKeys(distSource) !== null
  && JSON.stringify(extractReservedKeys(distSource)) === JSON.stringify(EXPECTED_RESERVED);
if (!sourceMatchesDist) {
  console.error('candidate src/installer/step-ops.ts does not match the stable dist — refusing to probe a drifted source');
  process.exit(2);
}

// ── strip parent authority, then private fresh state ───────────────────────
const PARENT_AUTHORITY_ENV = [
  'TAMANDUA_RUN_ID',
  'TAMANDUA_WORKER_PID',
  'TAMANDUA_WORKER_PGID',
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_CONTROL_PORT',
];
const authorityStripped = PARENT_AUTHORITY_ENV.filter((name) => Object.prototype.hasOwnProperty.call(process.env, name));
for (const name of PARENT_AUTHORITY_ENV) delete process.env[name];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o12-reserved-key-probe.'));
const home = path.join(root, 'home');
const stateDir = path.join(root, 'state');
const tmp = path.join(root, 'tmp');
for (const dir of [home, stateDir, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
process.env.HOME = home;
process.env.TAMANDUA_STATE_DIR = stateDir;
process.env.TAMANDUA_DB_PATH = path.join(stateDir, 'tamandua.db');
process.env.TAMANDUA_TEST_GUARD = '1';
process.env.TMPDIR = tmp;

// Freshly OWNED fixture paths (created inside the probe root so any real path
// is valid and controlled): never the fixed /tmp/harness-a or /tmp/harness-b.
const owned = {
  repo: path.join(root, 'fixtures', 'repo'),
  workingDirectoryForHarness: path.join(root, 'fixtures', 'wd'),
  worktreePath: path.join(root, 'fixtures', 'wt'),
  worktreeOriginRepository: path.join(root, 'fixtures', 'origin.git'),
};
for (const dir of Object.values(owned)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// ── product import only after isolation is established ─────────────────────
const { completeStep } = await import(path.join(DIST_DIR, 'installer', 'step-ops.js'));
const { getDb } = await import(path.join(DIST_DIR, 'db.js'));

const db = getDb();
if (INJECT_DB_CLOSE_ERROR) {
  // Safe injected-close-error negative (test-only): the owned DB handle's
  // close is made to throw so the probe must report closure NOT observed and
  // exit non-green — proving a swallowed close error can never masquerade as
  // a positive closed receipt.
  db.close = () => { throw new Error('injected owned-DB close failure (probe negative control)'); };
}

const now = new Date().toISOString();

// Two owned runs: case 1 seeds every reserved key PRESENT (values must be
// preserved byte-for-byte under an overwrite attempt); case 2 seeds NONE
// (absent keys must stay absent under an introduction attempt).
function seedValuesFor(runId) {
  return {
    repo: owned.repo,
    working_directory_for_harness: owned.workingDirectoryForHarness,
    task: 'fix bug (owned probe fixture)',
    run_id: runId,
    workspace_mode: 'worktree',
    worktree_path: owned.worktreePath,
    worktree_origin_repository: owned.worktreeOriginRepository,
    worktree_origin_ref: 'refs/heads/main',
    worktree_origin_sha: 'c'.repeat(40),
    original_branch: 'main',
    merge_gate: 'green',
    fail_missing: 'off',
    test_cmd_raw: 'node --test',
    test_cmd_review_required: 'true',
    test_cmd_review_candidate: 'node --test --bail',
    test_cmd_review_established: 'node --test',
    test_cmd_rewriter_step: 'setup',
  };
}

// Malicious output builder: attempts to overwrite/introduce ALL 17 reserved
// keys (fresh owned evil values under the probe root) plus one non-reserved
// key (ARTIFACT) that must merge normally.
function maliciousOutputFor(label) {
  const lines = ['STATUS: done'];
  for (const key of EXPECTED_RESERVED) {
    const evilValue = path.join(root, 'fixtures', 'evil', label, key);
    lines.push(`${key.toUpperCase()}: ${evilValue}`);
  }
  lines.push('ARTIFACT: plan.md');
  return lines.join('\n');
}

function parseAttemptedKeys(outputText) {
  const keys = [];
  for (const line of outputText.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const lower = match[1].toLowerCase();
    if (EXPECTED_RESERVED.includes(lower)) keys.push(lower);
  }
  return [...new Set(keys)].sort();
}

const cases = [];
for (const [index, spec] of [
  { label: 'present-preservation', seed: (runId) => seedValuesFor(runId) },
  { label: 'absent-introduction', seed: () => ({}) },
].entries()) {
  const runId = crypto.randomUUID();
  const stepRowId = crypto.randomUUID();
  const seeded = spec.seed(runId);
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, ?, 'probe-wf', 'fix bug', 'running', ?, 0, ?, ?)",
  ).run(runId, index + 1, JSON.stringify(seeded), now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, 'plan', 'probe-wf_planner', 0, '{{task}}', '', 'running', 0, 4, 'single', ?, ?)`,
  ).run(stepRowId, runId, now, now);

  const output = maliciousOutputFor(spec.label);
  completeStep(stepRowId, output);

  const stored = JSON.parse(db.prepare('SELECT context FROM runs WHERE id = ?').get(runId).context);
  const stepStatus = db.prepare('SELECT status FROM steps WHERE id = ?').get(stepRowId).status;
  const parsedKeys = parseAttemptedKeys(output);
  cases.push({ label: spec.label, runId, stepRowId, seeded, stored, parsedKeys, stepStatus });
}

// ── positive exact owned-DB closure (no swallowed error/timeout) ───────────
const closure = { db_close: { observed: false } };
try {
  db.close();
  closure.db_close.observed = true;
} catch (error) {
  closure.db_close.error = String(error?.stack ?? error);
}

// ── per-key verification ───────────────────────────────────────────────────
const expectedKeys = [...EXPECTED_RESERVED];
const attemptedKeys = [...new Set(cases.flatMap((c) => c.parsedKeys))].sort();
const changed = [];
const introduced = [];
const keyCoverage = Object.fromEntries(expectedKeys.map((key) => [key, { present_preservation_verified: false, absent_introduction_verified: false }]));

const presentCase = cases.find((c) => c.label === 'present-preservation');
const absentCase = cases.find((c) => c.label === 'absent-introduction');
for (const [key, expectedValue] of Object.entries(presentCase.seeded)) {
  if (presentCase.stored[key] === expectedValue) {
    keyCoverage[key].present_preservation_verified = true;
  } else {
    changed.push({ key, expected: expectedValue, observed: presentCase.stored[key] });
  }
}
for (const key of expectedKeys) {
  if (!Object.prototype.hasOwnProperty.call(absentCase.stored, key)) {
    keyCoverage[key].absent_introduction_verified = true;
  } else {
    introduced.push({ key, observed: absentCase.stored[key] });
  }
}
const checkedKeys = Object.keys(keyCoverage).filter((key) =>
  keyCoverage[key].present_preservation_verified && keyCoverage[key].absent_introduction_verified).sort();
const coveredKeysCount = checkedKeys.length;

function setEquals(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
const keySetEquality = {
  expected_keys: expectedKeys,
  attempted_keys: attemptedKeys,
  checked_keys: checkedKeys,
  expected_equals_attempted: setEquals(expectedKeys, attemptedKeys),
  expected_equals_checked: setEquals(expectedKeys, checkedKeys),
};
const keySetsEqual = keySetEquality.expected_equals_attempted && keySetEquality.expected_equals_checked;
const nonReservedMerged = presentCase.stored.artifact === 'plan.md' && absentCase.stored.artifact === 'plan.md';
const allStepsDone = cases.every((c) => c.stepStatus === 'done');

const identity = fs.lstatSync(root);
const workspaceReceipt = {
  kind: 'o12-reserved-key-probe-workspace',
  root,
  ownership: { dev: identity.dev, ino: identity.ino },
  created_at: new Date().toISOString(),
  retained: 'retained intentionally; no recursive filesystem disposal',
};
fs.writeFileSync(path.join(root, 'probe-receipt.json'), `${JSON.stringify(workspaceReceipt, null, 2)}\n`, { flag: 'wx' });

const result = {
  probe: 'o12-reserved-key-step-ops',
  source_pinned: { file: 'src/installer/step-ops.ts', sha256: stepOpsSha, stable_dist: stableStepOpsTs, source_matches_dist: sourceMatchesDist },
  product_dist: { dir: DIST_DIR, version: distVersion, revision: distRevision },
  isolation: {
    home: home, state_dir: stateDir, db_path: process.env.TAMANDUA_DB_PATH,
    tmpdir: tmp, test_guard: process.env.TAMANDUA_TEST_GUARD,
    parent_authority_stripped: authorityStripped,
    control_port: '(stripped — no live daemon reachable)',
  },
  // Exact tested coverage: 17 of 17 keys verified BOTH ways (per-key booleans,
  // not a constant). reserved_keys_guarded is reported for compatibility but
  // the real coverage claim is covered_keys_count + key_coverage + key_sets.
  reserved_keys_guarded: EXPECTED_RESERVED.length,
  reserved_key_pin: expectedKeys,
  key_sets: keySetEquality,
  key_sets_equal: keySetsEqual,
  cases: cases.map((c) => ({
    label: c.label,
    run_id: c.runId,
    seeded_reserved_keys: Object.keys(c.seeded).filter((k) => EXPECTED_RESERVED.includes(k)).length,
    attempted_reserved_keys: c.parsedKeys.length,
    changed_keys: changed.filter((entry) => expectedKeys.includes(entry.key)).length,
    introduced_keys: introduced.length,
    step_terminal_status: c.stepStatus,
  })),
  covered_keys_count: coveredKeysCount,
  key_coverage: keyCoverage,
  changed_keys: changed,
  introduced_keys: introduced,
  non_reserved_merged: nonReservedMerged,
  steps_terminal_status: allStepsDone ? 'done' : 'not-all-done',
  closure,
  workspace_receipt: workspaceReceipt,
};
console.log(JSON.stringify(result, null, 2));

const green = changed.length === 0
  && introduced.length === 0
  && nonReservedMerged
  && allStepsDone
  && keySetsEqual
  && coveredKeysCount === EXPECTED_RESERVED.length
  && sourceMatchesDist
  && closure.db_close.observed === true;
process.exit(green ? 0 : 1);
