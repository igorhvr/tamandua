#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O9 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_ID = 'run-99999999-9999-4999-8999-999999999999';
const STALE_RUN_ID = 'run-11111111-1111-4111-8111-111111111111';
const ORIGIN = '/torture-test/fixtures/synthetic-o9';
const OTHER_ORIGIN = '/torture-test/fixtures/synthetic-o9-independent';
const CMD_HASH = createHash('sha256').update('npm test').digest('hex');
const OTHER_CMD_HASH = createHash('sha256').update('npm run test:other').digest('hex');
const CAPTURED_AT = '2026-08-01T12:10:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];
const CASES = [
  { name: 'o9-green', expected: 'PASS', mutation: null },
  { name: 'o9-wrong-tree', expected: 'FAIL', mutation: 'wrong-tree', finding: 'O9_LEDGER_TREE_UNRESOLVED' },
  { name: 'o9-wrong-key', expected: 'FAIL', mutation: 'wrong-key', finding: 'O9_REPLAY_KEY_MISMATCH' },
  { name: 'o9-stale-replay', expected: 'FAIL', mutation: 'stale', finding: 'O9_REPLAY_STALE' },
  { name: 'o9-red-replay', expected: 'FAIL', mutation: 'red-replay', finding: 'O9_REPLAY_NOT_GREEN' },
  { name: 'o9-missing-replay-row', expected: 'FAIL', mutation: 'missing-replay-row', finding: 'O9_REPLAY_ROW_MISSING' },
  { name: 'o9-drift-recorded', expected: 'FAIL', mutation: 'drift-recorded', finding: 'O9_DRIFT_RECORDED' },
  { name: 'o9-force-skipped', expected: 'FAIL', mutation: 'force-skipped', finding: 'O9_FORCE_DID_NOT_EXECUTE' },
  { name: 'o9-monotonicity', expected: 'FAIL', mutation: 'monotonicity', finding: 'O9_MONOTONICITY_VIOLATION' },
  { name: 'o9-singleflight-green', expected: 'PASS', mutation: 'singleflight-green' },
  { name: 'o9-singleflight-double-execute', expected: 'FAIL', mutation: 'singleflight-double-execute', finding: 'O9_SINGLEFLIGHT_EXECUTOR_COUNT' },
  { name: 'o9-singleflight-wrong-owner-row', expected: 'FAIL', mutation: 'singleflight-wrong-owner-row', finding: 'O9_SINGLEFLIGHT_WAITER_REPLAY_INVALID' },
  { name: 'o9-singleflight-replay-before-record', expected: 'FAIL', mutation: 'singleflight-replay-before-record', finding: 'O9_SINGLEFLIGHT_WAITER_REPLAY_INVALID' },
  { name: 'o9-dead-owner-green', expected: 'PASS', mutation: 'dead-owner-green' },
  { name: 'o9-dead-owner-missing-event', expected: 'FAIL', mutation: 'dead-owner-missing-event', finding: 'O9_DEAD_OWNER_RECLAIM_MISSING' },
  { name: 'o9-dead-owner-early-execute', expected: 'FAIL', mutation: 'dead-owner-early-execute', finding: 'O9_SINGLEFLIGHT_RECOVERY_ORDER' },
  { name: 'o9-dead-owner-hidden-early-execute', expected: 'FAIL', mutation: 'dead-owner-hidden-early-execute', finding: 'O9_SINGLEFLIGHT_RECOVERY_ORDER' },
  { name: 'o9-dead-owner-double-outcome', expected: 'FAIL', mutation: 'dead-owner-double-outcome', finding: 'O9_SINGLEFLIGHT_WAITER_UNRESOLVED' },
  { name: 'o9-dead-owner-owner-double-execute', expected: 'FAIL', mutation: 'dead-owner-owner-double-execute', finding: 'O9_SINGLEFLIGHT_EXECUTOR_COUNT' },
  { name: 'o9-stop-release-green', expected: 'PASS', mutation: 'stop-release-green' },
  { name: 'o9-stop-release-false-reclaim', expected: 'FAIL', mutation: 'stop-release-false-reclaim', finding: 'O9_STOP_RELEASE_EMITTED_DEAD_OWNER' },
  { name: 'o9-stop-release-early-execute', expected: 'FAIL', mutation: 'stop-release-early-execute', finding: 'O9_SINGLEFLIGHT_RECOVERY_ORDER' },
  { name: 'o9-special-exits-green', expected: 'PASS', mutation: 'special-exits-green' },
  { name: 'o9-special-exit-row', expected: 'FAIL', mutation: 'special-exit-row', finding: 'O9_SPECIAL_EXIT_ROW_FORBIDDEN' },
  { name: 'o9-special-exit-missing-88', expected: 'FAIL', mutation: 'special-exit-missing-88', finding: 'O9_SPECIAL_EXIT_COVERAGE' },
  { name: 'o9-special-exit-88-not-dirty', expected: 'FAIL', mutation: 'special-exit-88-not-dirty', finding: 'O9_SPECIAL_EXIT_ROW_FORBIDDEN' },
  { name: 'o9-special-exit-88-interrupted', expected: 'FAIL', mutation: 'special-exit-88-interrupted', finding: 'O9_SPECIAL_EXIT_ROW_FORBIDDEN' },
  { name: 'o9-special-exit-87-command-mismatch', expected: 'FAIL', mutation: 'special-exit-87-command-mismatch', finding: 'O9_INTERRUPTED_EVIDENCE_INVALID' },
  { name: 'o9-special-exit-junk-tracked', expected: 'FAIL', mutation: 'special-exit-junk-tracked', finding: 'O9_JUNK_PROBE_TRACKED' },
  { name: 'o9-special-exit-origin-missing', expected: 'FAIL', mutation: 'special-exit-origin-missing', finding: 'O9_ORIGIN_IDENTITY_MISSING' },
  { name: 'o9-cross-origin-green', expected: 'PASS', mutation: 'cross-origin-green' },
  { name: 'o9-cross-origin-replay', expected: 'FAIL', mutation: 'cross-origin-replay', finding: 'O9_CROSS_ORIGIN_EVIDENCE' },
  { name: 'o9-foreign-ledger-rows', expected: 'PASS', mutation: 'foreign-ledger', skippedRows: 1, skippedDbForeignRows: 1 },
  { name: 'o9-stale-attempt-ledger', expected: 'PASS', mutation: 'stale-attempt-ledger', skippedStaleRows: 1 },
  { name: 'o9-foreign-db-rows', expected: 'PASS', mutation: 'foreign-db-rows', skippedDbForeignRows: 1 },
  { name: 'o9-unresolved-cache-hit', expected: 'PASS', mutation: 'unresolved-cache-hit', skippedReplayRows: 1 },
  { name: 'o9-in-scope-mismatch', expected: 'ERROR', mutation: 'in-scope-mismatch' },
  { name: 'o9-empty-observations', expected: 'NOT_EVALUABLE', mutation: 'empty-observations' },
  { name: 'o9-null-gate-key', expected: 'NOT_EVALUABLE', mutation: 'null-gate-key' },
  // S35 (US-005): the detached-HEAD snapshot contract (US-009) — a synthetic
  // repo whose HEAD is DETACHED at a commit OID (no symbolic ref checked out),
  // with refs_before/refs_after/target_reflog carrying target_ref = <40-hex
  // OID> + detached_head: true and non-empty suite_observations + suite_ledger
  // consistent with the fixture. The detached commit is reachable ONLY via the
  // detached HEAD (the branch is deleted) — the strictest detached-HEAD-only
  // shape: O9 must resolve the ledger tree from the detached HEAD commit per
  // the contract, never require a symbolic target ref, and never alter refs.
  // `o9-detached-green` must evaluate PASS; `o9-detached-wrong-tree` must
  // still FAIL with O9_LEDGER_TREE_UNRESOLVED (fail-closed preserved).
  // `o9-detached-launch-refused` reproduces the W4.30 launch-refused corridor
  // (empty suite evidence because the run was refused at launch on the
  // detached-HEAD origin): post-fix O9 renders the REAL judgment PASS with the
  // corridor + contract fields recorded — pre-fix it answered NOT_EVALUABLE,
  // which the campaign harness cannot classify (`result must be PASS, FAIL, or
  // ERROR` — the S35 ORACLE_TEST_INFRA).
  { name: 'o9-detached-green', expected: 'PASS', mutation: 'detached-green' },
  { name: 'o9-detached-wrong-tree', expected: 'FAIL', mutation: 'detached-wrong-tree', finding: 'O9_LEDGER_TREE_UNRESOLVED' },
  { name: 'o9-detached-launch-refused', expected: 'PASS', mutation: 'detached-launch-refused' },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'O9 Fixture',
      GIT_AUTHOR_EMAIL: 'o9@example.invalid',
      GIT_COMMITTER_NAME: 'O9 Fixture',
      GIT_COMMITTER_EMAIL: 'o9@example.invalid',
      GIT_AUTHOR_DATE: '2026-08-01T12:03:00Z',
      GIT_COMMITTER_DATE: '2026-08-01T12:03:00Z',
    },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function writeDeterministicGitArchive(repo, archive, cwd) {
  run('tar', [
    '--sort=name', '--format=gnu', '--mtime=2026-08-01T12:00:00Z',
    '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go=rX',
    '--exclude=./index', '--exclude=./logs',
    '-C', path.join(repo, '.git'), '-cf', archive, '.',
  ], cwd);
}
function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function reference(campaign, file, source) {
  return { path: path.relative(campaign, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)), captured_at: CAPTURED_AT, source };
}
function writeSnapshot(campaign, snapshots, name, value, source) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, source);
}
function key(treeHash, cmdHash = CMD_HASH) {
  return { origin_repo: ORIGIN, tree_hash: treeHash, cmd_hash: cmdHash };
}
function observation(id, invocationId, sequence, phase, observedAt, suiteKey, force, extra = {}) {
  return { id, invocation_id: invocationId, sequence, phase, observed_at: observedAt, ...suiteKey, force, run_id: RUN_ID, step_id: 'test', ...extra };
}

for (const fixture of CASES) {
  const campaign = path.join(workspace, fixture.name);
  const repo = path.join(campaign, 'repo');
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(snapshots);
  fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');
  run('git', ['init', '-b', 'main'], repo);
  run('git', ['config', 'user.name', 'O9 Fixture'], repo);
  run('git', ['config', 'user.email', 'o9@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'one\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'baseline'], repo);
  const committedTree = run('git', ['rev-parse', 'HEAD^{tree}'], repo);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'two\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'second committed tree'], repo);
  const secondTree = run('git', ['rev-parse', 'HEAD^{tree}'], repo);
  const secondCommit = run('git', ['rev-parse', 'HEAD'], repo);
  // S35 (US-005): the detached-HEAD fixtures commit a NEW tree while HEAD is
  // DETACHED, then delete the branch so the detached commit is reachable ONLY
  // via the detached HEAD (no symbolic ref checked out — the strictest
  // detached-HEAD-only shape the US-009 contract must resolve).
  let detachedCommit = null;
  let detachedTree = null;
  if (fixture.mutation?.startsWith('detached-')) {
    run('git', ['checkout', '-q', '--detach', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'value.txt'), 'three\n');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'detached HEAD commit'], repo);
    detachedCommit = run('git', ['rev-parse', 'HEAD'], repo);
    detachedTree = run('git', ['rev-parse', 'HEAD^{tree}'], repo);
    run('git', ['branch', '-D', 'main'], repo);
    const headContent = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim();
    if (headContent !== detachedCommit || headContent.startsWith('ref:')) {
      throw new Error(`detached fixture must have a raw-OID HEAD, got ${headContent}`);
    }
    if (fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'main'))) {
      throw new Error('detached fixture must not carry refs/heads/main');
    }
  }
  const ledgerTree = fixture.mutation === 'wrong-tree' ? 'f'.repeat(committedTree.length)
    : fixture.mutation === 'detached-wrong-tree' ? 'f'.repeat(40)
    : fixture.mutation?.startsWith('detached-') ? detachedTree : committedTree;
  const rowCreatedAt = fixture.mutation === 'stale' ? '2026-07-30T11:59:59.000Z' : '2026-08-01T12:00:00.000Z';
  const firstExit = fixture.mutation === 'red-replay' ? 1 : 0;
  const rows = [{
    id: 1, origin_repo: ORIGIN, tree_hash: ledgerTree, cmd_hash: CMD_HASH, cmd_display: 'npm test',
    exit_code: firstExit, duration_ms: 1000, log_tail: null, run_id: RUN_ID, step_id: 'test', created_at: rowCreatedAt,
  }];
  const replayKey = fixture.mutation === 'wrong-key' ? key(committedTree, OTHER_CMD_HASH) : key(ledgerTree);
  const replayForce = fixture.mutation === 'force-skipped';
  // S35 (US-005): for the detached-HEAD fixtures the mechanically committed
  // tree is the detached HEAD commit's tree (reachable only via the detached
  // HEAD per US-009) — the replay must bind to that tree.
  const committedTreeHash = fixture.mutation?.startsWith('detached-') ? detachedTree : committedTree;
  // S26 (US-003): `missing-replay-row` names a positive row id (999) that
  // exists nowhere — neither in the captured ledger nor in the database
  // snapshot — which keeps O9_REPLAY_ROW_MISSING fail-closed. An
  // `unresolved-cache-hit` (the attempt-1 W4.01/W4.02 cross-campaign shape)
  // names no attributable prior row (null): the shim mechanically replayed a
  // green cached row that the case's scoped evidence cannot resolve, so it is
  // annotated/skipped, never a missing-row finding.
  const replayRowId = fixture.mutation === 'missing-replay-row' ? 999
    : fixture.mutation === 'unresolved-cache-hit' ? null : 1;
  const observations = [
    observation('obs-1', 'inv-replay', 1, 'lookup', '2026-08-01T12:04:59.000Z', replayKey, replayForce, { latest_row_id: 1 }),
    observation('obs-2', 'inv-replay', 2, 'replay', '2026-08-01T12:05:00.000Z', replayKey, replayForce, {
      ledger_row_id: replayRowId, marker: 'TAMANDUA-TEST CACHED', exit_code: 0, committed_tree_hash: committedTreeHash,
    }),
  ];

  if (fixture.mutation === null || fixture.mutation === 'monotonicity') {
    const forceExit = fixture.mutation === 'monotonicity' ? 1 : 0;
    rows.push({
      id: 2, origin_repo: ORIGIN, tree_hash: committedTree, cmd_hash: CMD_HASH, cmd_display: 'npm test',
      exit_code: forceExit, duration_ms: 1200, log_tail: null, run_id: RUN_ID, step_id: 'force-test', created_at: '2026-08-01T12:06:02.000Z',
    });
    observations.push(
      observation('obs-3', 'inv-force', 3, 'lookup', '2026-08-01T12:06:00.000Z', key(committedTree), true, { latest_row_id: 1 }),
      observation('obs-4', 'inv-force', 4, 'execute', '2026-08-01T12:06:01.000Z', key(committedTree), true, {
        started_at: '2026-08-01T12:06:00.500Z', pre_tree_hash: committedTree, post_tree_hash: committedTree, exit_code: forceExit,
      }),
      observation('obs-5', 'inv-force', 5, 'record', '2026-08-01T12:06:02.000Z', key(committedTree), true, { ledger_row_id: 2, exit_code: forceExit }),
    );
  }
  if (fixture.mutation === 'drift-recorded') {
    rows.push({
      id: 2, origin_repo: ORIGIN, tree_hash: committedTree, cmd_hash: CMD_HASH, cmd_display: 'npm test',
      exit_code: 0, duration_ms: 1200, log_tail: null, run_id: RUN_ID, step_id: 'drift-test', created_at: '2026-08-01T12:06:02.000Z',
    });
    observations.push(
      observation('obs-3', 'inv-drift', 3, 'lookup', '2026-08-01T12:06:00.000Z', key(committedTree), false, { latest_row_id: 1 }),
      observation('obs-4', 'inv-drift', 4, 'execute', '2026-08-01T12:06:01.000Z', key(committedTree), false, {
        started_at: '2026-08-01T12:06:00.500Z', pre_tree_hash: committedTree, post_tree_hash: secondTree, exit_code: 0,
      }),
      observation('obs-5', 'inv-drift', 5, 'record', '2026-08-01T12:06:02.000Z', key(committedTree), false, { ledger_row_id: 2, exit_code: 0 }),
    );
  }

  if (fixture.mutation === 'empty-observations' || fixture.mutation === 'detached-launch-refused') observations.splice(0);

  const singleflight = [];
  const specialExits = [];
  const originIdentities = fixture.mutation === 'empty-observations' || fixture.mutation === 'detached-launch-refused'
    ? [] : [{ origin_repo: ORIGIN, normalized_origin_repo: ORIGIN }];
  const appendObservation = (invocationId, phase, observedAt, suiteKey, force, extra = {}) => {
    observations.push(observation(`obs-${observations.length + 1}`, invocationId, observations.length + 1, phase, observedAt, suiteKey, force, extra));
  };
  const addExecution = (invocationId, rowId, origin = ORIGIN, exitCode = 0, started = '2026-08-01T12:06:00.000Z', finished = '2026-08-01T12:06:02.000Z') => {
    const suiteKey = { origin_repo: origin, tree_hash: committedTree, cmd_hash: CMD_HASH };
    rows.push({
      id: rowId, ...suiteKey, cmd_display: 'npm test', exit_code: exitCode, duration_ms: 2000,
      log_tail: exitCode === 87 ? 'KILLED by external SIGTERM; NO USABLE EVIDENCE' : null,
      run_id: RUN_ID, step_id: invocationId, created_at: finished,
    });
    appendObservation(invocationId, 'lookup', started, suiteKey, false, { latest_row_id: 1 });
    appendObservation(invocationId, 'execute', finished, suiteKey, false, {
      started_at: started, pre_tree_hash: committedTree, post_tree_hash: committedTree, exit_code: exitCode,
    });
    appendObservation(invocationId, 'record', finished, suiteKey, false, { ledger_row_id: rowId, exit_code: exitCode });
  };
  const addReplay = (invocationId, rowId, origin = ORIGIN, at = '2026-08-01T12:06:03.000Z') => {
    const suiteKey = { origin_repo: origin, tree_hash: committedTree, cmd_hash: CMD_HASH };
    appendObservation(invocationId, 'lookup', at, suiteKey, false, { latest_row_id: rowId });
    appendObservation(invocationId, 'replay', at, suiteKey, false, {
      ledger_row_id: rowId, marker: 'TAMANDUA-TEST CACHED', exit_code: 0, committed_tree_hash: committedTree,
    });
  };

  if (fixture.mutation?.startsWith('singleflight-')) {
    addExecution('sf-owner', 2);
    const waiterRowId = fixture.mutation === 'singleflight-wrong-owner-row' ? 1 : 2;
    addReplay('sf-waiter-1', waiterRowId, ORIGIN, '2026-08-01T12:06:03.000Z');
    if (fixture.mutation === 'singleflight-double-execute') addExecution('sf-waiter-2', 3, ORIGIN, 0, '2026-08-01T12:06:04.000Z', '2026-08-01T12:06:06.000Z');
    else addReplay('sf-waiter-2', 2, ORIGIN, '2026-08-01T12:06:04.000Z');
    singleflight.push({
      id: 'sf-1', key: key(committedTree), owner_invocation_id: 'sf-owner', waiter_invocation_ids: ['sf-waiter-1', 'sf-waiter-2'],
      configured_recovery_bound_ms: 5000,
      events: [
        { type: 'execute_started', observed_at: '2026-08-01T12:06:00.000Z', invocation_id: 'sf-owner' },
        { type: 'wait', observed_at: '2026-08-01T12:06:00.100Z', invocation_id: 'sf-waiter-1' },
        { type: 'wait', observed_at: '2026-08-01T12:06:00.200Z', invocation_id: 'sf-waiter-2' },
        { type: 'record', observed_at: fixture.mutation === 'singleflight-replay-before-record' ? '2026-08-01T12:06:03.500Z' : '2026-08-01T12:06:02.000Z', invocation_id: 'sf-owner', ledger_row_id: 2 },
        { type: fixture.mutation === 'singleflight-double-execute' ? 'execute_started' : 'replay', observed_at: '2026-08-01T12:06:03.000Z', invocation_id: 'sf-waiter-1', ledger_row_id: waiterRowId },
        { type: fixture.mutation === 'singleflight-double-execute' ? 'execute_started' : 'replay', observed_at: '2026-08-01T12:06:04.000Z', invocation_id: 'sf-waiter-2', ledger_row_id: fixture.mutation === 'singleflight-double-execute' ? null : 2 },
      ].toSorted((left, right) => left.observed_at.localeCompare(right.observed_at)),
    });
  }

  if (fixture.mutation?.startsWith('dead-owner-') || fixture.mutation?.startsWith('stop-release-')) {
    const hiddenEarlyExecution = fixture.mutation === 'dead-owner-hidden-early-execute';
    const ownerDoubleExecution = fixture.mutation === 'dead-owner-owner-double-execute';
    if (hiddenEarlyExecution || ownerDoubleExecution) addReplay('recovery-waiter', 1, ORIGIN, '2026-08-01T12:06:03.000Z');
    else addExecution('recovery-waiter', 2, ORIGIN, 0, '2026-08-01T12:06:03.000Z', '2026-08-01T12:06:05.000Z');
    const deadOwner = fixture.mutation.startsWith('dead-owner-');
    const events = [
      { type: 'execute_started', observed_at: '2026-08-01T12:06:00.000Z', invocation_id: 'recovery-owner', owner_pid: 4100 },
      ...(hiddenEarlyExecution ? [
        { type: 'record', observed_at: '2026-08-01T12:06:00.500Z', invocation_id: 'recovery-owner', ledger_row_id: 1 },
        { type: 'execute_started', observed_at: '2026-08-01T12:06:00.750Z', invocation_id: 'recovery-waiter' },
      ] : []),
      ...(ownerDoubleExecution ? [
        { type: 'record', observed_at: '2026-08-01T12:06:00.500Z', invocation_id: 'recovery-owner', ledger_row_id: 1 },
        { type: 'execute_started', observed_at: '2026-08-01T12:06:00.750Z', invocation_id: 'recovery-owner' },
      ] : []),
      { type: 'wait', observed_at: '2026-08-01T12:06:01.000Z', invocation_id: 'recovery-waiter' },
    ];
    if (deadOwner && fixture.mutation !== 'dead-owner-missing-event') events.push({
      type: 'dead_owner_reclaimed', observed_at: '2026-08-01T12:06:02.000Z', invocation_id: 'recovery-waiter', owner_pid: 4100, reclaimer_pid: 4200,
    });
    if (!deadOwner) {
      events.push({ type: 'owner_released', observed_at: '2026-08-01T12:06:02.000Z', invocation_id: 'recovery-owner', reason: 'cancel' });
      if (fixture.mutation === 'stop-release-false-reclaim') events.push({
        type: 'dead_owner_reclaimed', observed_at: '2026-08-01T12:06:02.500Z', invocation_id: 'recovery-waiter', owner_pid: 4100, reclaimer_pid: 4200,
      });
    }
    const earlyExecution = fixture.mutation.endsWith('early-execute');
    events.push(hiddenEarlyExecution || ownerDoubleExecution
      ? { type: 'replay', observed_at: '2026-08-01T12:06:03.000Z', invocation_id: 'recovery-waiter', ledger_row_id: 1 }
      : { type: 'execute_started', observed_at: earlyExecution ? '2026-08-01T12:06:01.500Z' : '2026-08-01T12:06:03.000Z', invocation_id: 'recovery-waiter' });
    if (fixture.mutation === 'dead-owner-double-outcome') events.push({
      type: 'replay', observed_at: '2026-08-01T12:06:04.000Z', invocation_id: 'recovery-waiter', ledger_row_id: 1,
    });
    events.sort((left, right) => left.observed_at.localeCompare(right.observed_at));
    singleflight.push({
      id: 'recovery-1', key: key(committedTree), owner_invocation_id: 'recovery-owner', waiter_invocation_ids: ['recovery-waiter'],
      configured_recovery_bound_ms: 5000, recovery: deadOwner ? 'dead_owner' : 'stop_cancel', events,
    });
  }

  if (fixture.mutation?.startsWith('special-exit')) {
    addExecution('exit-87', 2, ORIGIN, 87);
    if (fixture.mutation === 'special-exit-row') {
      rows.push({
        id: 3, ...key(committedTree), cmd_display: 'npm test', exit_code: 86, duration_ms: 1000,
        log_tail: null, run_id: RUN_ID, step_id: 'exit-86', created_at: '2026-08-01T12:07:00.000Z',
      });
    }
    specialExits.push(
      { invocation_id: 'exit-86', ...key(committedTree), observed_at: '2026-08-01T12:07:00.000Z', shim_exit_code: 86, command_exit_code: 0, pre_tree_hash: committedTree, post_tree_hash: secondTree, ledger_row_id: fixture.mutation === 'special-exit-row' ? 3 : null, interrupted: false, tracked_dirty: false, junk_probe_tracked: false },
      { invocation_id: 'exit-87', ...key(committedTree), observed_at: '2026-08-01T12:07:01.000Z', shim_exit_code: 87, command_exit_code: fixture.mutation === 'special-exit-87-command-mismatch' ? 0 : 87, pre_tree_hash: committedTree, post_tree_hash: committedTree, ledger_row_id: 2, interrupted: true, tracked_dirty: false, junk_probe_tracked: false },
    );
    if (fixture.mutation !== 'special-exit-missing-88') specialExits.push({
      invocation_id: 'exit-88', ...key(committedTree),
      origin_repo: fixture.mutation === 'special-exit-origin-missing' ? OTHER_ORIGIN : ORIGIN,
      observed_at: '2026-08-01T12:07:02.000Z', shim_exit_code: 88,
      command_exit_code: null, pre_tree_hash: committedTree, post_tree_hash: committedTree, ledger_row_id: null,
      interrupted: fixture.mutation === 'special-exit-88-interrupted', tracked_dirty: fixture.mutation !== 'special-exit-88-not-dirty',
      junk_probe_tracked: fixture.mutation === 'special-exit-junk-tracked',
    });
  }

  if (fixture.mutation?.startsWith('cross-origin-')) {
    originIdentities.push({ origin_repo: OTHER_ORIGIN, normalized_origin_repo: OTHER_ORIGIN });
    rows.push({
      id: 2, origin_repo: OTHER_ORIGIN, tree_hash: committedTree, cmd_hash: CMD_HASH, cmd_display: 'npm test',
      exit_code: 0, duration_ms: 1000, log_tail: null, run_id: RUN_ID, step_id: 'origin-b', created_at: '2026-08-01T12:06:00.000Z',
    });
    addReplay('origin-b-replay', fixture.mutation === 'cross-origin-replay' ? 1 : 2, OTHER_ORIGIN, '2026-08-01T12:06:01.000Z');
  }

  if (fixture.mutation === 'foreign-ledger') {
    originIdentities.push({ origin_repo: OTHER_ORIGIN, normalized_origin_repo: OTHER_ORIGIN });
    rows.push({
      id: 2, origin_repo: OTHER_ORIGIN, tree_hash: 'f'.repeat(40), cmd_hash: OTHER_CMD_HASH, cmd_display: 'npm run test:other',
      exit_code: 0, duration_ms: 1000, log_tail: null, run_id: RUN_ID, step_id: 'foreign-row', created_at: '2026-08-01T12:06:00.000Z',
    });
  }

  if (fixture.mutation === 'stale-attempt-ledger') {
    // A row written by a PRIOR campaign attempt: same origin bundle, but a
    // run_id outside the current case's run set and an unresolvable tree.
    // Without current-attempt scoping this trips O9_LEDGER_TREE_UNRESOLVED;
    // with scoping the stale row is skipped and the case passes on its own
    // current-attempt row (id 1, run_id RUN_ID, resolvable committed tree).
    rows.push({
      id: 2, origin_repo: ORIGIN, tree_hash: 'f'.repeat(40), cmd_hash: CMD_HASH, cmd_display: 'npm test',
      exit_code: 0, duration_ms: 1000, log_tail: null, run_id: STALE_RUN_ID, step_id: 'stale-attempt', created_at: '2026-07-20T10:00:00.000Z',
    });
  }

  // S26 (US-003): DB-only rows are present in the database snapshot but NOT in
  // the scoped suite-ledger.json artifact. `foreign-db-rows` models the
  // cross-campaign contamination class: a row for a foreign origin (a sibling
  // case's fixture, or a previous campaign's reused fixture path) that O9's
  // case-bundle reconciliation must ignore — annotated as
  // skipped_db_foreign_row_ids, never a reconciliation ERROR.
  const dbOnlyRows = [];
  if (fixture.mutation === 'foreign-db-rows') {
    originIdentities.push({ origin_repo: OTHER_ORIGIN, normalized_origin_repo: OTHER_ORIGIN });
    dbOnlyRows.push({
      id: 2, origin_repo: OTHER_ORIGIN, tree_hash: 'f'.repeat(40), cmd_hash: OTHER_CMD_HASH, cmd_display: 'npm run test:other',
      exit_code: 0, duration_ms: 1000, log_tail: null, run_id: RUN_ID, step_id: 'foreign-db-row', created_at: '2026-08-01T12:06:00.000Z',
    });
  }
  // `in-scope-mismatch` models in-scope tamper: the artifact row and the DB
  // row share the case-bundle origin, but the DB copy was altered (exit_code
  // 0 -> 1) — O9 must fail closed with ORACLE_RUNTIME_ERROR, never PASS.
  const dbTamperedRowIds = new Set(fixture.mutation === 'in-scope-mismatch' ? [1] : []);

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE suite_results (
    id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL,
    cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL
  );`);
  const insert = database.prepare(`INSERT INTO suite_results
    (id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of [...rows, ...dbOnlyRows]) {
    const dbRow = dbTamperedRowIds.has(row.id) ? { ...row, exit_code: row.exit_code === 0 ? 1 : 0 } : row;
    insert.run(dbRow.id, dbRow.origin_repo, dbRow.tree_hash, dbRow.cmd_hash, dbRow.cmd_display, dbRow.exit_code, dbRow.duration_ms, dbRow.log_tail, dbRow.run_id, dbRow.step_id, dbRow.created_at);
  }
  database.close();
  fs.chmodSync(databasePath, 0o400);
  const gitTar = path.join(snapshots, 'repository.git.tar');
  writeDeterministicGitArchive(repo, gitTar, campaign);
  fs.chmodSync(gitTar, 0o400);

  const references = Object.fromEntries(REFERENCE_KEYS.map((name) => [name, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  // S35 (US-005): the W4.30 launch-refused corridor shape — the run failed at
  // launch (run.failed, no suite.* activity) because the product refused the
  // detached-HEAD origin; the run event stream must prove the shim never ran.
  const eventRows = fixture.mutation === 'detached-launch-refused'
    ? [{
      archive: 'all.jsonl', line: 1,
      event: {
        ts: CAPTURED_AT, event: 'run.failed', runId: RUN_ID, workflowId: 'feature-dev-merge-worktree',
      },
    }]
    : fixture.mutation?.startsWith('cross-origin-')
      ? [{
        archive: 'all.jsonl', line: 1,
        event: {
          ts: CAPTURED_AT, event: 'suite.executed', runId: RUN_ID, stepId: 'origin-b',
          originRepo: OTHER_ORIGIN, treeHash: committedTree, cmdHash: CMD_HASH, exitCode: 0, durationMs: 100, ledgerRowId: 2,
        },
      }]
      : [];
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED_AT, run_ids: [RUN_ID], rows: eventRows,
  }, 'self-test-events');
  references.git_bundle = reference(campaign, gitTar, 'git-common-dir-tar');
  references.launch_intent = writeSnapshot(campaign, snapshots, 'launch-intent.json', {
    schema_version: 1, captured_at: CAPTURED_AT,
    policy: { merge_gate: 'green', fail_missing: null },
    argv: ['workflow', 'run'],
    gate_key: fixture.mutation === 'null-gate-key' ? null : { origin_repo: ORIGIN, cmd_hash: CMD_HASH },
  }, 'controller-launch-intent');
  references.suite_ledger = writeSnapshot(campaign, snapshots, 'suite-ledger.json', {
    schema_version: 1, captured_at: CAPTURED_AT, rows,
  }, 'self-test-suite-ledger');
  references.suite_observations = writeSnapshot(campaign, snapshots, 'suite-observations.json', {
    schema_version: 1, captured_at: CAPTURED_AT, ttl_green_ms: 86_400_000, rows: observations,
    singleflight_observations: singleflight, special_exit_observations: specialExits,
    origin_identities: originIdentities,
  }, 'self-test-suite-observations');
  // S35 (US-005): the detached-HEAD snapshot contract (US-009) — a synthetic
  // repo whose HEAD is DETACHED at a commit OID with NO symbolic ref checked
  // out. refs_before/refs_after/target_reflog carry target_ref = <40-hex OID>
  // + detached_head: true exactly like the W4.30 evidence shape; the refs
  // evidence is what lets O9 consume the contract end-to-end.
  if (fixture.mutation?.startsWith('detached-')) {
    const repository = {
      fixture_path: 'var/fixtures/work/o9-detached/tt-ts',
      git_common_dir: 'var/fixtures/work/o9-detached/tt-ts/.git',
      object_format: 'sha1',
    };
    const refsShape = (phase) => ({
      schema_version: 1, phase, repository,
      target_ref: detachedCommit, target_tip: detachedCommit,
      detached_head: true, for_each_ref: '',
    });
    references.refs_before = writeSnapshot(campaign, snapshots, 'refs-before.json', refsShape('before'), 'controller-refs');
    references.refs_after = writeSnapshot(campaign, snapshots, 'refs-after.json', refsShape('after'), 'controller-refs');
    references.target_reflog = writeSnapshot(campaign, snapshots, 'target-reflog.json', {
      schema_version: 1, captured_at: CAPTURED_AT, repository,
      target_ref: detachedCommit, detached_head: true,
      entries: [{
        old_oid: secondCommit, new_oid: detachedCommit,
        actor: 'O9 Fixture <o9@example.invalid>',
        timestamp: 1788076643, timezone: '-0300',
        action: 'checkout: moving from main to HEAD',
        raw: `${secondCommit} ${detachedCommit} O9 Fixture <o9@example.invalid> 1788076643 -0300\tcheckout: moving from main to HEAD`,
      }],
    }, 'controller-reflog');
  }

  const attempts = fixture.mutation === 'detached-launch-refused'
    ? [{
      id: 'attempt-o9', kind: 'workflow', phase: 'terminal', execution_mode: 'scripted', run_id: RUN_ID,
      started_at: '2026-08-01T11:50:00.000Z', terminal_at: CAPTURED_AT, terminal_status: 'failed',
      tokens_observed: 1, command_result: { exit_code: 0, signal: null }, steps_snapshot: null, straggler_capture: null,
    }]
    : [{
      id: 'attempt-o9', kind: 'workflow', phase: 'terminal', execution_mode: 'scripted', run_id: RUN_ID,
      started_at: '2026-08-01T11:50:00.000Z', terminal_at: CAPTURED_AT, terminal_status: 'completed',
      tokens_observed: 1, command_result: { exit_code: 0, signal: null }, steps_snapshot: null, straggler_capture: null,
    }];
  const context = {
    contract_version: 1, oracle_id: 'O9',
    campaign: { id: `campaign-${fixture.name}`, created_at: '2026-08-01T11:50:00.000Z', manifest: { sha256: '9'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 4, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: 'scripted-pi', class: 'verification', caps: { tokens: 100, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: RUN_ID,
    attempts,
    discovered_runs: [], o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
  fs.rmSync(repo, { recursive: true, force: true });
}
