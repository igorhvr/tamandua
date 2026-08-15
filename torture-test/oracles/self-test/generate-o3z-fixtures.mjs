#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O3z fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const ROOT = 'run-44444444-4444-4444-8444-444444444444';
const CHILD = 'run-55555555-5555-4555-8555-555555555555';
const STARTED_AT = '2026-08-01T12:00:00.000Z';
const TERMINAL_AT = '2026-08-01T12:01:00.000Z';
const CAPTURED_AT = '2026-08-01T12:02:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];

const cases = [
  { name: 'o3z-green-real', expected: 'PASS', tokens: 17 },
  { name: 'o3z-zero-real', expected: 'FAIL', tokens: 0, finding: 'O3Z_COMPLETED_REAL_ZERO_TOKENS' },
  { name: 'o3z-duplicate-canonical-run', expected: 'FAIL', tokens: 0, duplicateCanonical: true, finding: 'O3Z_DB_RUN_ID_DUPLICATE' },
  { name: 'o3z-green-scripted-zero', expected: 'PASS', executionMode: 'scripted', tokens: 0 },
  { name: 'o3z-green-failed-real-zero', expected: 'PASS', status: 'failed', tokens: 0 },
  { name: 'o3z-system-before-nonzero', expected: 'FAIL', tokens: 17, before: 1, finding: 'O3Z_SYSTEM_TOKENS_NONZERO' },
  { name: 'o3z-system-after-nonzero', expected: 'FAIL', tokens: 17, after: 2, finding: 'O3Z_SYSTEM_TOKENS_NONZERO' },
  { name: 'o3z-terminal-db-nonzero', expected: 'FAIL', tokens: 17, dbAfter: 3, finding: 'O3Z_SYSTEM_TOKENS_NONZERO' },
  { name: 'o3z-discovered-real-zero', expected: 'FAIL', tokens: 17, childTokens: 0, finding: 'O3Z_COMPLETED_REAL_ZERO_TOKENS' },
];

function bare(runId) {
  return runId.slice(4);
}

function attempt(runId, executionMode, status, tokens, parentRunId) {
  const value = {
    id: `attempt-${bare(runId).slice(0, 4)}`,
    kind: 'workflow',
    phase: 'terminal',
    execution_mode: executionMode,
    run_id: runId,
    started_at: STARTED_AT,
    terminal_at: TERMINAL_AT,
    terminal_status: status,
    tokens_observed: tokens,
    command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null },
    steps_snapshot: null,
    straggler_capture: null,
  };
  return parentRunId === undefined ? value : { ...value, parent_run_id: parentRunId };
}

function reference(campaign, file, source) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    captured_at: CAPTURED_AT,
    source,
  };
}

function writeSnapshot(campaign, snapshots, name, value) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture');
}

for (const fixture of cases) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidenceDir = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  const executionMode = fixture.executionMode ?? 'real';
  const status = fixture.status ?? 'completed';
  const rootAttempt = attempt(ROOT, executionMode, status, fixture.tokens);
  const childAttempt = fixture.childTokens === undefined
    ? null
    : attempt(CHILD, 'real', 'completed', fixture.childTokens, ROOT);

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL);
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);
  `);
  const insertRun = database.prepare('INSERT INTO runs VALUES (?, ?, ?)');
  insertRun.run(bare(ROOT), status, fixture.tokens);
  if (fixture.duplicateCanonical) insertRun.run(ROOT, status, 17);
  if (childAttempt !== null) insertRun.run(bare(CHILD), 'completed', fixture.childTokens);
  database.prepare('INSERT INTO tamandua_stats VALUES (1, ?)').run(fixture.dbAfter ?? fixture.after ?? 0);
  database.close();
  fs.chmodSync(databasePath, 0o400);

  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.system_tokens_before = writeSnapshot(campaign, snapshots, 'system-tokens-before.json', {
    schema_version: 1,
    captured_at: STARTED_AT,
    table_present: true,
    rows: [{ system_tokens_spent: fixture.before ?? 0 }],
    value: fixture.before ?? 0,
  });
  references.system_tokens_after = writeSnapshot(campaign, snapshots, 'system-tokens-after.json', {
    schema_version: 1,
    captured_at: CAPTURED_AT,
    table_present: true,
    rows: [{ system_tokens_spent: fixture.after ?? 0 }],
    value: fixture.after ?? 0,
  });

  const context = {
    contract_version: 1,
    oracle_id: 'O3z',
    campaign: {
      id: `campaign-${fixture.name}`,
      created_at: STARTED_AT,
      manifest: { sha256: 'b'.repeat(64), case_count: 1, case_ids: [fixture.name] },
    },
    case: {
      id: fixture.name,
      wave: 4,
      workflow: 'feature-dev-merge-worktree',
      fixture: 'synthetic',
      harness: executionMode === 'scripted' ? 'scripted-pi' : 'pi',
      class: 'verification',
      caps: { tokens: 100, wall_min: 10 },
      boundary_files: [],
      forbidden: [],
      chaos: null,
    },
    run_id: ROOT,
    attempts: [rootAttempt],
    discovered_runs: childAttempt === null ? [] : [childAttempt],
    o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}
