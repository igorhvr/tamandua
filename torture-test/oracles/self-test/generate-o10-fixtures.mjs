#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O10 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_ID = 'run-10101010-1010-4010-8010-101010101010';
const DB_RUN_ID = RUN_ID.slice(4);
const ORIGIN = '/torture-test/fixtures/synthetic-o10';
const EVENT_ORIGIN = '/torture-test/fixtures/synthetic-o10-event-origin';
const FOREIGN_ORIGIN = '/torture-test/fixtures/synthetic-o10-foreign-case';
const TREE = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const AFTER = 'c'.repeat(40);
const TEST_CMD = 'npm test';
const CMD_HASH = createHash('sha256').update(TEST_CMD).digest('hex');
const CAPTURED_AT = '2026-08-01T12:10:00.000Z';
const DECISION_AT = '2026-08-01T12:05:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];
const MODES = [
  { id: 'off', mergeGate: 'off', failMissing: 'true' },
  { id: 'default', mergeGate: null, failMissing: null },
  { id: 'fail-missing', mergeGate: null, failMissing: '1' },
  { id: 'green', mergeGate: 'green', failMissing: null },
];
const EVIDENCE = ['missing', 'red', 'green'];
const CASES = MODES.flatMap((mode) => EVIDENCE.map((evidence) => ({
  name: `o10-${mode.id}-${evidence}`,
  expected: 'PASS', mode, evidence,
}))).concat([
  { name: 'o10-off-mutation-missing-override', expected: 'FAIL', mode: MODES[0], evidence: 'missing', mutation: 'missing-override', finding: 'O10_EVENT_SET_MISMATCH' },
  { name: 'o10-default-mutation-no-reroute', expected: 'FAIL', mode: MODES[1], evidence: 'missing', mutation: 'no-reroute', finding: 'O10_REROUTE_COUNT' },
  { name: 'o10-fail-missing-mutation-concedes', expected: 'FAIL', mode: MODES[2], evidence: 'missing', mutation: 'concedes', finding: 'O10_TERMINAL_DISPOSITION' },
  { name: 'o10-green-mutation-lands-red', expected: 'FAIL', mode: MODES[3], evidence: 'red', mutation: 'lands-red', finding: 'O10_TERMINAL_DISPOSITION' },
  { name: 'o10-default-green-mutation-context-laundered', expected: 'FAIL', mode: MODES[1], evidence: 'green', mutation: 'context-laundered', finding: 'O10_LAUNCH_INTENT_MUTATION' },
  { name: 'o10-default-green-already-landed-mutation', expected: 'FAIL', mode: MODES[1], evidence: 'green', alreadyLanded: true, finding: 'O10_ALREADY_LANDED_INVALID' },
  { name: 'o10-green-red-already-landed-row-flip', expected: 'PASS', mode: MODES[3], evidence: 'red', alreadyLanded: true },
  { name: 'o10-green-missing-already-landed-row-delete-mutation', expected: 'FAIL', mode: MODES[3], evidence: 'missing', alreadyLanded: true, mutation: 'missing-accepted-event', finding: 'O10_ALREADY_LANDED_INVALID' },
  { name: 'o10-default-red-exact-key-laundered-mutation', expected: 'FAIL', mode: MODES[1], evidence: 'red', mutation: 'launder-exact-red', finding: 'O10_EXACT_KEY_RED_LAUNDERED' },
  { name: 'o10-default-missing-different-key-red', expected: 'PASS', mode: MODES[1], evidence: 'missing', ledgerEvidence: 'different-key-red' },
  { name: 'o10-default-missing-later-exact-red', expected: 'PASS', mode: MODES[1], evidence: 'missing', ledgerEvidence: 'later-exact-red' },
  { name: 'o10-default-missing-concession-key-mutation', expected: 'FAIL', mode: MODES[1], evidence: 'missing', mutation: 'concession-key-mismatch', finding: 'O10_CONCESSION_KEY_MISMATCH' },
  { name: 'o10-rugpull-replacement-launch-invariant', expected: 'PASS', mode: MODES[1], evidence: 'green', replacement: true },
  { name: 'o10-rugpull-replacement-context-laundered-mutation', expected: 'FAIL', mode: MODES[1], evidence: 'green', mutation: 'context-laundered', replacement: true, finding: 'O10_LAUNCH_INTENT_MUTATION' },
  { name: 'o10-null-gate-key', expected: 'NOT_EVALUABLE', mode: MODES[1], evidence: 'missing', nullGateKey: true },
  // S26 scoped-reconciliation red-arm: foreign-origin rows accumulated by
  // multi-case campaigns (stale cross-campaign or intra-campaign) are foreign
  // per S13 doctrine, never reconciliation failures.
  { name: 'o10-scoped-foreign-db-rows', expected: 'PASS', mode: MODES[1], evidence: 'green', foreignDbRows: true },
  { name: 'o10-scoped-in-scope-mismatch', expected: 'ERROR', mode: MODES[1], evidence: 'green', inScopeMismatch: true },
]);

function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function reference(campaign, file, source) {
  return { path: path.relative(campaign, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)), captured_at: CAPTURED_AT, source };
}
function writeSnapshot(campaign, snapshots, name, value, source) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, source);
}
function wrappedEvents(events) {
  return events.map((event, index) => ({ archive: 'all.jsonl', line: index + 1, event }));
}
function event(name, extra = {}, seconds = 0) {
  return { ts: `2026-08-01T12:05:${String(seconds).padStart(2, '0')}.000Z`, event: name, runId: DB_RUN_ID, workflowId: 'feature-dev-merge-worktree', ...extra };
}
function expectedCell(mode, evidence) {
  if (mode.id === 'off') return { lands: true, reroutes: 0, mergerInvocations: 1, annotations: ['merge.gate_overridden'] };
  if (evidence === 'green') return { lands: true, reroutes: 0, mergerInvocations: 1, annotations: [] };
  if (evidence === 'red' && mode.id !== 'green') return { lands: true, reroutes: 0, mergerInvocations: 1, annotations: ['merge.landed_over_red_suite'] };
  if (evidence === 'missing' && mode.id === 'default') return { lands: true, reroutes: 1, mergerInvocations: 1, annotations: ['merge.landed_without_suite_evidence'] };
  return { lands: false, reroutes: 1, mergerInvocations: 0, annotations: [] };
}
function refusalText(evidence, row) {
  const lines = [
    'FAILURE_CLASS: refused_permanent',
    `LEDGER_EVIDENCE: ${evidence}`,
    `ORIGIN_REPO: ${ORIGIN}`,
    `TREE_HASH: ${TREE}`,
    `CMD_HASH: ${CMD_HASH}`,
    `TEST_CMD: ${TEST_CMD}`,
  ];
  if (evidence === 'red') lines.push(
    `LEDGER_ROW_ID: ${row.id}`,
    `EXIT_CODE: ${row.exit_code}`,
    `TIMESTAMP: ${row.created_at}`,
    `DURATION_MS: ${row.duration_ms}`,
    `LEDGER_RUN_ID: ${row.run_id}`,
    `LEDGER_STEP_ID: ${row.step_id}`,
    `LOG_TAIL: ${row.log_tail}`,
  );
  lines.push(
    'WORKSPACE_STATE: clean',
    evidence === 'missing' ? 'NEAREST_EVIDENCE: none' : `NEAREST_EVIDENCE: exact-key red row ${row.id}`,
    'ACTION: Run the EXACT shim-wrapped test command, preserve the committed tree, and retry finalize_merge.',
  );
  return lines.join('\n');
}

for (const fixture of CASES) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidenceDir = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(evidenceDir);
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');

  const row = {
    id: 1,
    origin_repo: fixture.ledgerEvidence === 'different-key-red' ? `${ORIGIN}-other` : ORIGIN,
    tree_hash: TREE,
    cmd_hash: CMD_HASH,
    cmd_display: TEST_CMD,
    exit_code: fixture.evidence === 'green' ? 0 : 17, duration_ms: 321, log_tail: 'synthetic red',
    run_id: 'writer-run', step_id: 'test',
    created_at: fixture.ledgerEvidence === 'later-exact-red' ? '2026-08-01T12:11:00.000Z' : '2026-08-01T12:04:00.000Z',
  };
  const rows = fixture.evidence === 'missing' && fixture.ledgerEvidence === undefined ? [] : [row];
  // S26: the snapshotter scoped suite-ledger.json to the case's suite origins
  // (gate-key origin + captured event originRepo); O10 recomputes the same
  // scope. These fixtures put rows OUTSIDE that scope into the database to
  // prove they are treated as foreign (never reconciliation failures), and
  // one fixture tampers an IN-SCOPE row to prove fail-closed detection.
  let dbRows = rows;
  if (fixture.foreignDbRows) {
    const eventOriginRow = { ...row, id: 2, origin_repo: EVENT_ORIGIN, exit_code: 0, log_tail: 'event-origin green', created_at: '2026-08-01T12:06:00.000Z' };
    const foreignRows = [
      { ...row, id: 3, origin_repo: FOREIGN_ORIGIN, exit_code: 3, duration_ms: 111, log_tail: 'foreign stale row A', created_at: '2026-07-20T10:00:00.000Z' },
      { ...row, id: 4, origin_repo: FOREIGN_ORIGIN, exit_code: 4, duration_ms: 222, log_tail: 'foreign stale row B', created_at: '2026-07-21T10:00:00.000Z' },
    ];
    rows.push(eventOriginRow);
    dbRows = [row, eventOriginRow, ...foreignRows];
  }
  if (fixture.inScopeMismatch) {
    dbRows = [
      { ...row, exit_code: row.exit_code === 0 ? 17 : 0, log_tail: 'in-scope tampered row' },
      { ...row, id: 2, origin_repo: FOREIGN_ORIGIN, exit_code: 3, duration_ms: 111, log_tail: 'foreign stale row', created_at: '2026-07-20T10:00:00.000Z' },
    ];
  }
  let expected = expectedCell(fixture.mode, fixture.evidence);
  if (fixture.mutation === 'concedes' || fixture.mutation === 'lands-red') {
    expected = { lands: true, reroutes: 1, mergerInvocations: 1, annotations: fixture.mutation === 'concedes'
      ? ['merge.landed_without_suite_evidence'] : ['merge.landed_over_red_suite'] };
  }
  if (fixture.mutation === 'no-reroute') expected = { ...expected, reroutes: 0 };
  if (fixture.mutation === 'launder-exact-red') {
    expected = { lands: true, reroutes: 1, mergerInvocations: 1, annotations: ['merge.landed_without_suite_evidence'] };
  }
  if (fixture.alreadyLanded) {
    expected = { lands: true, reroutes: 0, mergerInvocations: 1, annotations: ['merge.accepted_already_landed'] };
  }
  const status = expected.lands ? 'completed' : 'failed';
  const stepStatus = expected.lands ? 'done' : 'failed';
  const stepOutput = expected.lands ? `STATUS: done\nMERGED_COMMIT: ${AFTER}\nMERGED_TREE: ${TREE}` : refusalText(fixture.evidence, row);

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, output TEXT, reroute_count INTEGER NOT NULL, terminal_reroute_count INTEGER NOT NULL, ledger_concession_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE suite_results (id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL, cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL, duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL);
  `);
  database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(
    DB_RUN_ID, 'feature-dev-merge-worktree', status,
    JSON.stringify({
      merge_gate: fixture.mutation === 'context-laundered' ? 'off' : fixture.mode.mergeGate,
      fail_missing: fixture.mutation === 'context-laundered' ? 'true' : fixture.mode.failMissing,
      test_cmd_raw: TEST_CMD, tested_tree: TREE,
    }),
    '2026-08-01T12:00:00.000Z', CAPTURED_AT,
  );
  database.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'finalize-row', DB_RUN_ID, 'finalize_merge', 'merger', stepStatus, stepOutput,
    expected.reroutes, expected.reroutes, fixture.mode.id === 'default' && fixture.evidence === 'missing' ? expected.reroutes : 0,
    CAPTURED_AT,
  );
  if (fixture.mutation === 'context-laundered') {
    database.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'producer-row', DB_RUN_ID, 'implement', 'developer', 'done',
      'STATUS: done\nMERGE_GATE: off\nFAIL_MISSING: true',
      0, 0, 0, '2026-08-01T12:03:00.000Z',
    );
  }
  for (const suiteRow of dbRows) database.prepare('INSERT INTO suite_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(suiteRow));
  database.close();
  fs.chmodSync(databasePath, 0o400);

  const events = [];
  if (expected.reroutes > 0) events.push(event('step.rerouted', { stepId: 'finalize_merge' }, 1));
  if (expected.mergerInvocations > 0) events.push(event('step.running', { stepId: 'finalize_merge', agentId: 'merger' }, 2));
  for (const annotation of expected.annotations) events.push(event(annotation, {
    stepId: 'finalize_merge', gateMode: fixture.mode.id === 'off' ? 'off' : 'default',
    origin: fixture.mutation === 'concession-key-mismatch' ? `${ORIGIN}-other` : ORIGIN,
    treeHash: TREE, cmdHash: CMD_HASH,
    ...(annotation === 'merge.landed_over_red_suite' ? { ledgerRowId: row.id, exitCode: row.exit_code, ledgerCreatedAt: row.created_at, durationMs: row.duration_ms } : {}),
  }, 3));
  if (fixture.mutation === 'missing-override') events.splice(events.findIndex((entry) => entry.event === 'merge.gate_overridden'), 1);
  if (fixture.mutation === 'missing-accepted-event') events.splice(events.findIndex((entry) => entry.event === 'merge.accepted_already_landed'), 1);
  if (expected.lands && !fixture.alreadyLanded) events.push(event('merge.landed', {
    stepId: 'finalize_merge', expectedTip: BEFORE, mergedCommit: AFTER, mergedTree: TREE,
    ...(fixture.foreignDbRows ? { originRepo: EVENT_ORIGIN } : {}),
  }, 4));
  events.push(event(`run.${status}`, {}, 5));

  const references = Object.fromEntries(REFERENCE_KEYS.map((name) => [name, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED_AT, run_ids: [RUN_ID], rows: wrappedEvents(events),
  }, 'self-test-events');
  references.launch_intent = writeSnapshot(campaign, snapshots, 'launch-intent.json', {
    schema_version: 1, captured_at: '2026-08-01T12:00:00.000Z', case_id: fixture.name,
    workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: 'scripted-pi', execution_mode: 'scripted',
    repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    policy: { merge_gate: fixture.mode.mergeGate, fail_missing: fixture.mode.failMissing, execution_mode: 'scripted' },
    gate_key: fixture.nullGateKey ? null : { origin_repo: ORIGIN, cmd_hash: CMD_HASH },
    argv: ['workflow', 'run'], argv_sha256: '1'.repeat(64), launch_intent_at: '2026-08-01T12:00:00.000Z',
  }, 'controller-launch-intent');
  references.refs_before = writeSnapshot(campaign, snapshots, 'refs-before.json', {
    schema_version: 1, phase: 'before', repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    target_ref: 'refs/heads/main', target_tip: fixture.alreadyLanded ? AFTER : BEFORE,
    for_each_ref: `${fixture.alreadyLanded ? AFTER : BEFORE}\tcommit\trefs/heads/main\t`,
  }, 'git-plumbing-before');
  references.refs_after = writeSnapshot(campaign, snapshots, 'refs-after.json', {
    schema_version: 1, phase: 'after', repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    target_ref: 'refs/heads/main', target_tip: expected.lands ? AFTER : BEFORE,
    for_each_ref: `${expected.lands ? AFTER : BEFORE}\tcommit\trefs/heads/main\t`,
  }, 'git-plumbing-after');
  references.suite_ledger = writeSnapshot(campaign, snapshots, 'suite-ledger.json', { schema_version: 1, captured_at: CAPTURED_AT, rows }, 'sqlite-readonly-suite-ledger');
  references.suite_observations = writeSnapshot(campaign, snapshots, 'suite-observations.json', {
    schema_version: 1, captured_at: CAPTURED_AT, ttl_green_ms: 86_400_000, rows: [],
    singleflight_observations: [], special_exit_observations: [], origin_identities: [{ origin_repo: ORIGIN, normalized_origin_repo: ORIGIN }],
  }, 'controller-suite-state-machine');
  references.submit_rejections = writeSnapshot(campaign, snapshots, 'submit-rejections.json', { schema_version: 1, captured_at: CAPTURED_AT, rows: [] }, 'controller-submit-rejections');

  const context = {
    contract_version: 1, oracle_id: 'O10',
    campaign: { id: `campaign-${fixture.name}`, created_at: '2026-08-01T11:50:00.000Z', manifest: { sha256: '9'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 4, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: 'scripted-pi', class: 'verification', caps: { tokens: 100, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: RUN_ID,
    attempts: fixture.replacement ? [] : [{ id: 'attempt-o10', kind: 'workflow', phase: 'terminal', execution_mode: 'scripted', run_id: RUN_ID, started_at: '2026-08-01T12:00:00.000Z', terminal_at: CAPTURED_AT, terminal_status: status, tokens_observed: 1, command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null }, steps_snapshot: null, straggler_capture: null }],
    discovered_runs: fixture.replacement ? [{ id: 'replacement-o10', kind: 'discovered-workflow', phase: 'terminal', execution_mode: 'scripted', run_id: RUN_ID, parent_run_id: 'run-20202020-2020-4020-8020-202020202020', started_at: '2026-08-01T12:00:00.000Z', terminal_at: CAPTURED_AT, terminal_status: status, tokens_observed: 1, command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null }, steps_snapshot: null, straggler_capture: null }] : [], o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({
    name: fixture.name, expected: fixture.expected, mode: fixture.mode.id, evidence: fixture.evidence,
    finding: fixture.finding ?? null, context: contextPath,
  })}\n`, { flag: 'wx' });
}

// ---- S27 real-cell fixtures (US-001) ----
// Modeled on the attempt-2 evidence shapes (W4.02's 6-row/7-running/1-reroute
// stream, W4.15's loop shape) with synthetic contained paths and canonical
// run_id/timestamps. Real snapshots carry steps.type/loop_config (absent on
// the minimal scripted fixture schema) and the run_events stream carries one
// step.running per step execution plus legal reroutes, so the two-regime
// model is exercised end to end.
const REAL_RUN_ID = 'run-30303030-3030-4030-8030-303030303030';
const REAL_DB_RUN_ID = REAL_RUN_ID.slice(4);
const REAL_CAPTURED_AT = '2026-08-02T12:10:00.000Z';
const LOOP_CONFIG = JSON.stringify({ over: 'stories', completion: 'all_done', fresh_session: true, verify_each: true, verify_step: 'verify' });

function realEvent(workflow, name, extra = {}, seconds = 0) {
  return { ts: `2026-08-02T12:05:${String(seconds).padStart(2, '0')}.000Z`, event: name, runId: REAL_DB_RUN_ID, workflowId: workflow, ...extra };
}

// spec: { name, expected, finding, workflow, mode, evidence, lands,
//         steps, stream: [{event, stepId?, agentId?, storyId?}], terminalReroutes,
//         dispatchRenderings?: [{...dispatch_renderings row fields}] }
// The stream is the ordered run_events sequence: one step.running per step
// execution, step.rerouted BEFORE the reroute target's re-execution (matching
// the captured attempt-2 stream shape), story events per iteration, the
// merge-gate annotations/landing, then the terminal event. When
// dispatchRenderings is provided, a dispatch-renderings.json snapshot is
// written (S27 US-002 corridor corroboration) and the context reference set.
function writeRealCellFixture(workspace, spec) {
  const campaign = path.join(workspace, spec.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidenceDir = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(evidenceDir);
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');

  const row = {
    id: 1,
    origin_repo: ORIGIN,
    tree_hash: TREE,
    cmd_hash: CMD_HASH,
    cmd_display: TEST_CMD,
    exit_code: spec.evidence === 'green' ? 0 : 17, duration_ms: 321, log_tail: 'synthetic red',
    run_id: 'writer-run', step_id: 'test',
    created_at: '2026-08-02T12:04:00.000Z',
  };
  const rows = spec.evidence === 'missing' ? [] : [row];

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL, task TEXT, status TEXT NOT NULL, context TEXT NOT NULL, tokens_spent INTEGER, notify_url TEXT, parent_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, scheduling_status TEXT, scheduling_requested_at TEXT, scheduling_error TEXT, worker_lost_count INTEGER, ceiling_expiry_count INTEGER, instant_fail_count INTEGER);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT NOT NULL, step_index INTEGER, input_template TEXT, expects TEXT, status TEXT NOT NULL, output TEXT, retry_count INTEGER, max_retries INTEGER, type TEXT, loop_config TEXT, current_story_id TEXT, abandoned_count INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claim_job_id TEXT, claim_pid INTEGER, claim_pgid INTEGER, claim_updated_at TEXT, reroute_count INTEGER NOT NULL, terminal_reroute_count INTEGER NOT NULL, ledger_concession_count INTEGER NOT NULL, claim_invalidated_by TEXT);
    CREATE TABLE suite_results (id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL, cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL, duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE stories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, story_index INTEGER, story_id TEXT, title TEXT, description TEXT, acceptance_criteria TEXT, status TEXT NOT NULL, output TEXT, retry_count INTEGER, max_retries INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, abandoned_count INTEGER);
  `);
  database.prepare('INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, parent_run_id, created_at, updated_at, scheduling_status, scheduling_requested_at, scheduling_error, worker_lost_count, ceiling_expiry_count, instant_fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    REAL_DB_RUN_ID, 1, spec.workflow, null,
    spec.lands ? 'completed' : 'failed',
    JSON.stringify({
      merge_gate: spec.mode.mergeGate,
      fail_missing: spec.mode.failMissing,
      test_cmd_raw: TEST_CMD, tested_tree: TREE,
    }),
    1000, null, null, '2026-08-02T12:00:00.000Z', REAL_CAPTURED_AT,
    'idle', null, null, 0, 0, 0,
  );
  let stepIndex = 0;
  for (const step of spec.steps) {
    const isFinalize = step.step_id === 'finalize_merge';
    const stepStatus = spec.lands ? 'done' : 'failed';
    const stepOutput = spec.lands
      ? `STATUS: done\nMERGED_COMMIT: ${AFTER}\nMERGED_TREE: ${TREE}`
      : refusalText(spec.evidence, row);
    database.prepare('INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, loop_config, current_story_id, abandoned_count, created_at, updated_at, claim_job_id, claim_pid, claim_pgid, claim_updated_at, reroute_count, terminal_reroute_count, ledger_concession_count, claim_invalidated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `${step.step_id}-row`, REAL_DB_RUN_ID, step.step_id, step.agent_id, stepIndex, null, null,
      stepStatus, stepOutput, step.retries ?? 0, 4,
      step.type ?? 'single', step.loop_config ?? null, null, 0,
      '2026-08-02T12:00:00.000Z', REAL_CAPTURED_AT, null, null, null, null,
      0, isFinalize ? spec.terminalReroutes : 0, isFinalize && spec.evidence === 'missing' && spec.mode.id === 'default' ? spec.terminalReroutes : 0,
      null,
    );
    stepIndex += 1;
  }
  if (spec.stories !== undefined) {
    let storyIndex = 0;
    for (const story of spec.stories) {
      database.prepare('INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, retry_count, max_retries, created_at, updated_at, abandoned_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        `story-${story.storyId}`, REAL_DB_RUN_ID, storyIndex, story.storyId, story.storyId, null, null,
        'done', null, 0, 0, '2026-08-02T12:01:00.000Z', '2026-08-02T12:05:00.000Z', 0,
      );
      storyIndex += 1;
    }
  }
  for (const suiteRow of rows) database.prepare('INSERT INTO suite_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(suiteRow));
  database.close();
  fs.chmodSync(databasePath, 0o400);

  const events = spec.stream.map((entry, index) => {
    const extra = { ...entry };
    delete extra.event;
    return realEvent(spec.workflow, entry.event, extra, index + 1);
  });

  const references = Object.fromEntries(REFERENCE_KEYS.map((name) => [name, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: REAL_CAPTURED_AT, run_ids: [REAL_RUN_ID], rows: wrappedEvents(events),
  }, 'self-test-events');
  references.launch_intent = writeSnapshot(campaign, snapshots, 'launch-intent.json', {
    schema_version: 1, captured_at: '2026-08-02T12:00:00.000Z', case_id: spec.name,
    workflow: spec.workflow, fixture: 'synthetic', harness: 'pi', execution_mode: 'real',
    repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    policy: { merge_gate: spec.mode.mergeGate, fail_missing: spec.mode.failMissing, execution_mode: 'real' },
    gate_key: { origin_repo: ORIGIN, cmd_hash: CMD_HASH },
    argv: ['workflow', 'run'], argv_sha256: '1'.repeat(64), launch_intent_at: '2026-08-02T12:00:00.000Z',
  }, 'controller-launch-intent');
  references.refs_before = writeSnapshot(campaign, snapshots, 'refs-before.json', {
    schema_version: 1, phase: 'before', repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    target_ref: 'refs/heads/main', target_tip: BEFORE,
    for_each_ref: `${BEFORE}\tcommit\trefs/heads/main\t`,
  }, 'git-plumbing-before');
  references.refs_after = writeSnapshot(campaign, snapshots, 'refs-after.json', {
    schema_version: 1, phase: 'after', repository: { path: 'fixtures/synthetic-o10', origin_repo: ORIGIN },
    target_ref: 'refs/heads/main', target_tip: spec.lands ? AFTER : BEFORE,
    for_each_ref: `${spec.lands ? AFTER : BEFORE}\tcommit\trefs/heads/main\t`,
  }, 'git-plumbing-after');
  references.suite_ledger = writeSnapshot(campaign, snapshots, 'suite-ledger.json', { schema_version: 1, captured_at: REAL_CAPTURED_AT, rows }, 'sqlite-readonly-suite-ledger');
  references.suite_observations = writeSnapshot(campaign, snapshots, 'suite-observations.json', {
    schema_version: 1, captured_at: REAL_CAPTURED_AT, ttl_green_ms: 86_400_000, rows: [],
    singleflight_observations: [], special_exit_observations: [], origin_identities: [{ origin_repo: ORIGIN, normalized_origin_repo: ORIGIN }],
  }, 'controller-suite-state-machine');
  references.submit_rejections = writeSnapshot(campaign, snapshots, 'submit-rejections.json', { schema_version: 1, captured_at: REAL_CAPTURED_AT, rows: [] }, 'controller-submit-rejections');
  if (spec.dispatchRenderings !== undefined) {
    references.dispatch_renderings = writeSnapshot(campaign, snapshots, 'dispatch-renderings.json', {
      schema_version: 1, captured_at: REAL_CAPTURED_AT, rows: spec.dispatchRenderings,
    }, 'controller-dispatch-render-events');
  }

  const context = {
    contract_version: 1, oracle_id: 'O10',
    campaign: { id: `campaign-${spec.name}`, created_at: '2026-08-02T11:50:00.000Z', manifest: { sha256: '9'.repeat(64), case_count: 1, case_ids: [spec.name] } },
    case: { id: spec.name, wave: 4, workflow: spec.workflow, fixture: 'synthetic', harness: 'pi', class: 'verification', caps: { tokens: 100, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: REAL_RUN_ID,
    attempts: [{ id: 'attempt-o10', kind: 'workflow', phase: 'terminal', execution_mode: 'real', run_id: REAL_RUN_ID, started_at: '2026-08-02T12:00:00.000Z', terminal_at: REAL_CAPTURED_AT, terminal_status: spec.lands ? 'completed' : 'failed', tokens_observed: 1000, command_result: { exit_code: spec.lands ? 0 : 1, signal: null }, steps_snapshot: null, straggler_capture: null }],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({
    name: spec.name, expected: spec.expected, mode: spec.mode.id, evidence: spec.evidence,
    finding: spec.finding ?? null, context: contextPath,
  })}\n`, { flag: 'wx' });
}

const BUGFIX_STEPS = [
  { step_id: 'triage', agent_id: 'bug-fix-merge-worktree_triager', type: 'single' },
  { step_id: 'investigate', agent_id: 'bug-fix-merge-worktree_investigator', type: 'single' },
  { step_id: 'setup', agent_id: 'bug-fix-merge-worktree_setup', type: 'single' },
  { step_id: 'fix', agent_id: 'bug-fix-merge-worktree_fixer', type: 'single' },
  { step_id: 'verify', agent_id: 'bug-fix-merge-worktree_verifier', type: 'single' },
  { step_id: 'finalize_merge', agent_id: 'bug-fix-merge-worktree_merger', type: 'single' },
];
const RUN = (stepId, agentId) => ({ event: 'step.running', stepId, agentId });
const CONCESSION = {
  event: 'merge.landed_without_suite_evidence', stepId: 'finalize_merge', gateMode: 'default',
  origin: ORIGIN, treeHash: TREE, cmdHash: CMD_HASH,
};
const LANDED = {
  event: 'merge.landed', stepId: 'finalize_merge', origin: ORIGIN, branch: 'bugfix/synthetic',
  target: 'refs/heads/main', expectedTip: BEFORE, mergedCommit: AFTER, mergedTree: TREE,
  noop: false, checkoutRefresh: 'refreshed',
};
// The W4.02-class stream: one step.running per step execution; the legal
// finalize_merge -> verify reroute corridor fires BEFORE verify's
// re-execution; then the concession annotation, landing, and terminal event.
const LEGAL_REROUTE_STREAM = [
  RUN('triage', 'bug-fix-merge-worktree_triager'),
  RUN('investigate', 'bug-fix-merge-worktree_investigator'),
  RUN('setup', 'bug-fix-merge-worktree_setup'),
  RUN('fix', 'bug-fix-merge-worktree_fixer'),
  RUN('verify', 'bug-fix-merge-worktree_verifier'),
  { event: 'step.rerouted', stepId: 'finalize_merge' },
  RUN('verify', 'bug-fix-merge-worktree_verifier'),
  RUN('finalize_merge', 'bug-fix-merge-worktree_merger'),
  CONCESSION,
  LANDED,
  { event: 'run.completed' },
];

// 1. Legal multi-step stream with a legal corridor reroute and a missing
//    evidence concession -> PASS (the W4.02 class).
writeRealCellFixture(workspace, {
  name: 'o10-real-multistep-legal-reroute', expected: 'PASS',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, stream: LEGAL_REROUTE_STREAM, terminalReroutes: 1,
});

// 2. Double merge.landed on an otherwise legal stream -> O10_EVENT_SET_MISMATCH.
writeRealCellFixture(workspace, {
  name: 'o10-real-double-landed', expected: 'FAIL', finding: 'O10_EVENT_SET_MISMATCH',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, terminalReroutes: 1,
  stream: [...LEGAL_REROUTE_STREAM.slice(0, -1), LANDED, { event: 'run.completed' }],
});

// 3. Missing terminal run.completed/run.failed event -> O10_EVENT_SET_MISMATCH.
writeRealCellFixture(workspace, {
  name: 'o10-real-missing-terminal', expected: 'FAIL', finding: 'O10_EVENT_SET_MISMATCH',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, terminalReroutes: 1,
  stream: [...LEGAL_REROUTE_STREAM.slice(0, -1)],
});

// 4. step.running naming a stepId absent from the run's DB steps rows ->
//    O10_EVENT_SET_MISMATCH.
writeRealCellFixture(workspace, {
  name: 'o10-real-unknown-step-running', expected: 'FAIL', finding: 'O10_EVENT_SET_MISMATCH',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, terminalReroutes: 1,
  stream: [
    RUN('triage', 'bug-fix-merge-worktree_triager'),
    RUN('investigate', 'bug-fix-merge-worktree_investigator'),
    RUN('setup', 'bug-fix-merge-worktree_setup'),
    RUN('fix', 'bug-fix-merge-worktree_fixer'),
    RUN('verify', 'bug-fix-merge-worktree_verifier'),
    { event: 'step.rerouted', stepId: 'finalize_merge' },
    RUN('verify', 'bug-fix-merge-worktree_verifier'),
    RUN('finalize_merge', 'bug-fix-merge-worktree_merger'),
    RUN('ghost-step', 'bug-fix-merge-worktree_ghost'),
    CONCESSION,
    LANDED,
    { event: 'run.completed' },
  ],
});

// 5. feature-dev-merge-worktree loop shape: type='loop' implement iterates
//    over 3 stories (3 step.running for implement and 3 for verify per the
//    story events) plus finalize -> PASS (the W4.15 class).
const FDMW_STEPS = [
  { step_id: 'plan', agent_id: 'feature-dev-merge-worktree_planner', type: 'single', retries: 1 },
  { step_id: 'setup', agent_id: 'feature-dev-merge-worktree_setup', type: 'single' },
  { step_id: 'implement', agent_id: 'feature-dev-merge-worktree_developer', type: 'loop', loop_config: LOOP_CONFIG },
  { step_id: 'verify', agent_id: 'feature-dev-merge-worktree_verifier', type: 'single' },
  { step_id: 'test', agent_id: 'feature-dev-merge-worktree_tester', type: 'single' },
  { step_id: 'finalize_merge', agent_id: 'feature-dev-merge-worktree_merger', type: 'single' },
];
const FDMW_STORIES = ['US-001', 'US-002', 'US-003'].flatMap((storyId) => [
  { event: 'story.started', stepId: 'implement', storyId },
  RUN('implement', 'feature-dev-merge-worktree_developer'),
  { event: 'story.done', stepId: 'implement', storyId },
  RUN('verify', 'feature-dev-merge-worktree_verifier'),
  { event: 'story.verified', stepId: 'verify', storyId },
]);
writeRealCellFixture(workspace, {
  name: 'o10-real-loop-multistep', expected: 'PASS',
  workflow: 'feature-dev-merge-worktree', mode: MODES[3], evidence: 'green', lands: true,
  steps: FDMW_STEPS, terminalReroutes: 0,
  stories: ['US-001', 'US-002', 'US-003'].map((storyId) => ({ storyId })),
  stream: [
    RUN('plan', 'feature-dev-merge-worktree_planner'),
    { event: 'step.retry', stepId: 'plan' },
    RUN('plan', 'feature-dev-merge-worktree_planner'),
    RUN('setup', 'feature-dev-merge-worktree_setup'),
    ...FDMW_STORIES,
    RUN('test', 'feature-dev-merge-worktree_tester'),
    RUN('finalize_merge', 'feature-dev-merge-worktree_merger'),
    LANDED,
    { event: 'run.completed' },
  ],
});

// 6. S27 US-002: real-cell reroute reconciliation — the corridor-corroborated
//    shape. The same legal finalize_merge -> verify corridor reroute as
//    o10-real-multistep-legal-reroute, but the dispatch_renderings artifact
//    now CARRIES the legal reroute corridor row (transition.action='reroute'
//    targeting the verify producer step row — the shared O11 discipline), so
//    the corridor corroboration leg is exercised: per-step event count
//    (1) equals the DB terminal_reroute_count (1) and the corridor row covers
//    it -> PASS with no O10_REROUTE_COUNT (US-002 AC2).
const DISPATCHED_KEYS = {
  triage: ['task', 'retry_feedback'],
  investigate: ['task', 'repo', 'severity', 'problem_statement', 'retry_feedback'],
  setup: ['repo', 'branch', 'original_branch', 'retry_feedback'],
  fix: ['task', 'repo', 'branch', 'test_cmd', 'root_cause', 'fix_approach', 'retry_feedback'],
  verify: ['task', 'repo', 'branch', 'test_cmd', 'changes', 'regression_test', 'retry_feedback'],
  finalize_merge: ['run_id', 'task', 'repo', 'branch', 'changes', 'tested_tree', 'retry_feedback'],
};
function dispatchedRendering(stepId, seconds) {
  return {
    id: `rendering-${stepId}-${seconds}`, observed_at: `2026-08-02T12:05:${String(seconds).padStart(2, '0')}.000Z`,
    run_id: REAL_DB_RUN_ID, step_row_id: `${stepId}-row`, step_id: stepId,
    claim_id: `tamandua-bug-fix-merge-worktree-${REAL_DB_RUN_ID}-${stepId}`,
    required_keys: DISPATCHED_KEYS[stepId] ?? ['task'], unresolved_placeholder_count: 0,
    unresolved_keys: [], dispatched: true, producer_step_row_id: null, transition: null,
  };
}
// The legal corridor row: finalize_merge's dispatch was blocked because the
// verify producer key was unresolved; the pre-dispatch guard reroutes to the
// producer step row (O11's corridor shape: transition.target_step_row_id ===
// producer_step_row_id, a distinct same-run upstream step).
const CORRIDOR_RENDERING = {
  id: 'rendering-finalize-reroute', observed_at: '2026-08-02T12:06:00.000Z',
  run_id: REAL_DB_RUN_ID, step_row_id: 'finalize_merge-row', step_id: 'finalize_merge',
  claim_id: `finalize_merge-row:missing-context`, required_keys: DISPATCHED_KEYS.finalize_merge,
  unresolved_placeholder_count: 1, unresolved_keys: ['verified'], dispatched: false,
  producer_step_row_id: 'verify-row', transition: { action: 'reroute', target_step_row_id: 'verify-row' },
};
writeRealCellFixture(workspace, {
  name: 'o10-real-corridor-corroborated', expected: 'PASS',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, stream: LEGAL_REROUTE_STREAM, terminalReroutes: 1,
  dispatchRenderings: [
    dispatchedRendering('triage', 1),
    dispatchedRendering('investigate', 5),
    dispatchedRendering('setup', 9),
    dispatchedRendering('fix', 13),
    dispatchedRendering('verify', 17),
    CORRIDOR_RENDERING,
    dispatchedRendering('verify', 25),
    dispatchedRendering('finalize_merge', 29),
  ],
});

// 7. S27 US-002 red-arm: real-cell reroute count reconciliation. The stream
//    still carries ONE finalize_merge step.rerouted event (the verify
//    re-execution follows), but the DB finalize_merge terminal_reroute_count
//    is 0 -> the event count does not reconcile with the database counter ->
//    O10_REROUTE_COUNT (US-002 AC3).
writeRealCellFixture(workspace, {
  name: 'o10-real-reroute-count-mismatch', expected: 'FAIL', finding: 'O10_REROUTE_COUNT',
  workflow: 'bug-fix-merge-worktree', mode: MODES[1], evidence: 'missing', lands: true,
  steps: BUGFIX_STEPS, stream: LEGAL_REROUTE_STREAM, terminalReroutes: 0,
});
