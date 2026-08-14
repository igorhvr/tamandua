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
  'expects_validations', 'dispatch_renderings',
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
  for (const suiteRow of rows) database.prepare('INSERT INTO suite_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(suiteRow));
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
  if (expected.lands && !fixture.alreadyLanded) events.push(event('merge.landed', { stepId: 'finalize_merge', expectedTip: BEFORE, mergedCommit: AFTER, mergedTree: TREE }, 4));
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
