#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  beginOracleEvidenceSnapshot,
  completeOracleEvidenceSnapshot,
  parseTargetReflogLine,
  projectExpectsValidations,
  projectSubmitRejections,
} from './oracle-evidence-snapshot.mjs';
import { ORACLE_EVIDENCE_KEYS } from './oracle-context.mjs';
import { evaluateO9 } from '../oracles/lib/o9.mjs';

const TT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const RUN_ID = 'run-11111111-1111-4111-8111-111111111111';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-snapshot-test.'));
  const stateDir = path.join(root, 'state');
  const repoDir = path.join(root, 'repo');
  const campaignDir = path.join(root, 'results', 'campaign-test');
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.mkdirSync(repoDir);
  run('git', ['init', '-b', 'main'], repoDir);
  run('git', ['config', 'user.name', 'Snapshot Test'], repoDir);
  run('git', ['config', 'user.email', 'snapshot@example.invalid'], repoDir);
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.mkdirSync(path.join(repoDir, 'test'));
  fs.writeFileSync(path.join(repoDir, 'src', 'value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'test', 'value.test.ts'), 'test("value", () => {});\n');
  fs.writeFileSync(path.join(repoDir, 'bait.txt'), 'do not touch\n');
  run('git', ['add', '.'], repoDir);
  run('git', ['commit', '-m', 'fixture'], repoDir);
  const suiteTree = run('git', ['rev-parse', 'HEAD^{tree}'], repoDir);
  const suiteCommandHash = createHash('sha256').update('npm test').digest('hex');
  const suiteOrigin = fs.realpathSync(repoDir);
  fs.writeFileSync(path.join(repoDir, 'junk-probe.tmp'), 'untracked by design\n');

  const databasePath = path.join(stateDir, 'tamandua.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, tokens_spent INTEGER);
    CREATE TABLE suite_results (
      id INTEGER PRIMARY KEY, origin_repo TEXT, tree_hash TEXT, cmd_hash TEXT,
      cmd_display TEXT, exit_code INTEGER, duration_ms INTEGER, log_tail TEXT,
      run_id TEXT, step_id TEXT, created_at TEXT
    );
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER);
    INSERT INTO runs VALUES ('11111111-1111-4111-8111-111111111111', 'completed', 17);
    INSERT INTO tamandua_stats VALUES (1, 0);
  `);
  db.prepare('INSERT INTO suite_results VALUES (1, ?, ?, ?, ?, 0, 12, NULL, ?, ?, ?)').run(
    suiteOrigin, suiteTree, suiteCommandHash, 'npm test', RUN_ID, 'step-1', '2026-08-01T12:00:00.000Z',
  );
  db.prepare('INSERT INTO suite_results VALUES (2, ?, ?, ?, ?, 0, 100, NULL, ?, ?, ?)').run(
    suiteOrigin, suiteTree, suiteCommandHash, 'npm test', 'run-reclaimer', 'step-reclaimer', '2026-08-01T12:00:00.100Z',
  );
  db.prepare('INSERT INTO suite_results VALUES (3, ?, ?, ?, ?, 87, 50, NULL, ?, ?, ?)').run(
    suiteOrigin, suiteTree, suiteCommandHash, 'npm test', RUN_ID, 'exit-87', '2026-08-01T12:00:00.200Z',
  );
  db.prepare('INSERT INTO suite_results VALUES (4, ?, ?, ?, ?, 0, 100, NULL, ?, ?, ?)').run(
    suiteOrigin, suiteTree, suiteCommandHash, 'npm test', 'run-ordinary-owner', 'step-ordinary-owner', '2026-08-01T12:00:04.400Z',
  );
  db.prepare('INSERT INTO suite_results VALUES (5, ?, ?, ?, ?, 0, 100, NULL, ?, ?, ?)').run(
    suiteOrigin, suiteTree, suiteCommandHash, 'npm test', 'run-stop-waiter', 'step-stop-waiter', '2026-08-01T12:00:05.600Z',
  );
  db.close();
  fs.writeFileSync(path.join(stateDir, 'events', 'all.jsonl'), [
    JSON.stringify({ ts: '2026-08-01T11:59:58.000Z', event: 'suite.claim_granted', runId: 'run-owner', stepId: 'step-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-owner', ownerStepId: 'step-owner', ownerPid: 4100 }),
    JSON.stringify({ ts: '2026-08-01T11:59:58.250Z', event: 'suite.execute_started', runId: 'run-owner', stepId: 'step-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash }),
    JSON.stringify({ ts: '2026-08-01T11:59:59.500Z', event: 'suite.claim_dead_owner_reclaimed', runId: 'run-reclaimer', stepId: 'step-reclaimer', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-owner', ownerStepId: 'step-owner', ownerPid: 4100, reclaimerRunId: 'run-reclaimer', reclaimerStepId: 'step-reclaimer', reclaimerPid: 4200 }),
    JSON.stringify({ ts: '2026-08-01T11:59:59.600Z', event: 'suite.claim_granted', runId: 'run-reclaimer', stepId: 'step-reclaimer', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-reclaimer', ownerStepId: 'step-reclaimer', ownerPid: 4200 }),
    JSON.stringify({ ts: '2026-08-01T11:59:59.700Z', event: 'suite.execute_started', runId: 'run-reclaimer', stepId: 'step-reclaimer', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash }),
    JSON.stringify({ ts: '2026-08-01T12:00:00.000Z', event: 'run.started', runId: RUN_ID }),
    JSON.stringify({ ts: '2026-08-01T12:00:00.000Z', event: 'suite.executed', runId: RUN_ID, stepId: 'step-1', treeHash: suiteTree, cmdDisplay: 'npm test', durationMs: 12, exitCode: 0, force: true }),
    JSON.stringify({ ts: '2026-08-01T12:00:00.100Z', event: 'suite.executed', runId: 'run-reclaimer', stepId: 'step-reclaimer', treeHash: suiteTree, cmdDisplay: 'npm test', durationMs: 100, exitCode: 0, force: false }),
    JSON.stringify({ ts: '2026-08-01T12:00:01.000Z', event: 'run.tokens.updated', runId: RUN_ID, tokenDelta: 17, tokensSpent: 17, stepId: 'step-1', roundId: 'round-1', usageId: 'usage-1' }),
    JSON.stringify({ ts: '2026-08-01T12:00:00.900Z', event: 'harness.usage.captured', runId: RUN_ID, stepId: 'step-1', roundId: 'round-1', usageId: 'usage-1', harness: 'pi', sessionId: null, startedAt: '2026-08-01T12:00:00.100Z', finishedAt: '2026-08-01T12:00:00.900Z', inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 17, candidateRunIds: [RUN_ID] }),
    JSON.stringify({ ts: '2026-08-01T12:00:02.000Z', event: 'suite.cache_hit', runId: RUN_ID, stepId: 'step-1', treeHash: suiteTree.slice(0, 12), cmdDisplay: 'npm test', savedDurationMs: 12, force: false }),
    JSON.stringify({ ts: '2026-08-01T12:00:02.100Z', event: 'suite.special_exit_observed', runId: RUN_ID, stepId: 'exit-86', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, shimExitCode: 86, commandExitCode: 0, preTreeHash: suiteTree, postTreeHash: 'a'.repeat(suiteTree.length), ledgerRowId: null, interrupted: false, trackedDirty: false, junkProbePath: 'junk-probe.tmp', junkProbeTracked: false }),
    JSON.stringify({ ts: '2026-08-01T12:00:02.200Z', event: 'suite.special_exit_observed', runId: RUN_ID, stepId: 'exit-87', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, shimExitCode: 87, commandExitCode: 87, preTreeHash: suiteTree, postTreeHash: suiteTree, ledgerRowId: 3, interrupted: true, trackedDirty: false, junkProbePath: 'junk-probe.tmp', junkProbeTracked: false }),
    JSON.stringify({ ts: '2026-08-01T12:00:02.300Z', event: 'suite.special_exit_observed', runId: RUN_ID, stepId: 'exit-88', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, shimExitCode: 88, commandExitCode: null, preTreeHash: suiteTree, postTreeHash: suiteTree, ledgerRowId: null, interrupted: false, trackedDirty: true, junkProbePath: 'junk-probe.tmp', junkProbeTracked: false }),
    JSON.stringify({ ts: '2026-08-01T12:00:03.000Z', event: 'step.submit.rejected', recordId: 'rejection-1', runId: RUN_ID, stepRowId: 'row-step-1', stepId: 'step-1', claimId: 'claim-1', attemptNumber: 1, validationCode: 'EXPECTS_REJECTED', missingKeys: ['TESTS'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_TESTS', detail: 'agent prose must not be copied' }),
    JSON.stringify({ ts: '2026-08-01T12:00:03.100Z', event: 'step.expects.validated', recordId: 'validation-1', runId: RUN_ID, stepRowId: 'row-step-1', stepId: 'step-1', claimId: 'claim-1', attemptNumber: 1, outcome: 'rejected', verdict: null, expectsRequired: true, requiredKeys: ['STATUS', 'TESTS'], missingKeys: ['TESTS'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_TESTS', producerStepRowId: 'row-producer', transitionAction: 'reroute', transitionTargetStepRowId: 'row-producer' }),
    JSON.stringify({ ts: '2026-08-01T12:00:03.200Z', event: 'dispatch.render.validated', recordId: 'render-1', runId: RUN_ID, stepRowId: 'row-step-1', stepId: 'step-1', claimId: 'claim-1', requiredKeys: ['ARTIFACT'], unresolvedPlaceholderCount: 0, unresolvedKeys: [] }),
    JSON.stringify({ ts: '2026-08-01T12:00:04.000Z', event: 'suite.claim_granted', runId: 'run-ordinary-owner', stepId: 'step-ordinary-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-ordinary-owner', ownerStepId: 'step-ordinary-owner', ownerPid: 4300 }),
    JSON.stringify({ ts: '2026-08-01T12:00:04.100Z', event: 'suite.execute_started', runId: 'run-ordinary-owner', stepId: 'step-ordinary-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, startedAt: '2026-08-01T12:00:04.050Z' }),
    JSON.stringify({ ts: '2026-08-01T12:00:04.200Z', event: 'suite.claim_wait', runId: 'run-ordinary-waiter', stepId: 'step-ordinary-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-ordinary-owner', ownerStepId: 'step-ordinary-owner' }),
    JSON.stringify({ ts: '2026-08-01T12:00:04.400Z', event: 'suite.executed', runId: 'run-ordinary-owner', stepId: 'step-ordinary-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, durationMs: 100, exitCode: 0, ledgerRowId: 4 }),
    JSON.stringify({ ts: '2026-08-01T12:00:04.500Z', event: 'suite.cache_hit', runId: 'run-ordinary-waiter', stepId: 'step-ordinary-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ledgerRowId: 4 }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.000Z', event: 'suite.claim_granted', runId: 'run-stop-owner', stepId: 'step-stop-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-stop-owner', ownerStepId: 'step-stop-owner', ownerPid: 4400 }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.100Z', event: 'suite.execute_started', runId: 'run-stop-owner', stepId: 'step-stop-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, startedAt: '2026-08-01T12:00:05.050Z' }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.200Z', event: 'suite.claim_wait', runId: 'run-stop-waiter', stepId: 'step-stop-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-stop-owner', ownerStepId: 'step-stop-owner' }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.300Z', event: 'suite.claim_owner_released', runId: 'run-stop-owner', stepId: 'step-stop-owner', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-stop-owner', ownerStepId: 'step-stop-owner', releaseReason: 'cancel' }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.400Z', event: 'suite.claim_granted', runId: 'run-stop-waiter', stepId: 'step-stop-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, ownerRunId: 'run-stop-waiter', ownerStepId: 'step-stop-waiter', ownerPid: 4500 }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.500Z', event: 'suite.execute_started', runId: 'run-stop-waiter', stepId: 'step-stop-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, startedAt: '2026-08-01T12:00:05.450Z' }),
    JSON.stringify({ ts: '2026-08-01T12:00:05.600Z', event: 'suite.executed', runId: 'run-stop-waiter', stepId: 'step-stop-waiter', originRepo: suiteOrigin, treeHash: suiteTree, cmdHash: suiteCommandHash, durationMs: 100, exitCode: 0, ledgerRowId: 5 }),
  ].join('\n') + '\n');
  return { root, stateDir, repoDir, campaignDir, databasePath, suiteOrigin };
}

// E3.C US-003: the probe sequencer writes a per-attempt probe-evidence JSON
// artifact into the controller's per-attempt evidence dir, and tt-chaos
// appends structured entries to var/chaos/chaos.log. The terminal snapshot
// must capture both under the probe_evidence / chaos_log evidence keys. The
// artifacts are planted per-test (the rejection tests assert the campaign
// directory stays untouched on a failed begin, so the shared fixture must not
// pre-create them).
function plantLifecycleEvidence(data) {
  const probeEvidencePath = path.join(data.campaignDir, 'evidence', 'CASE-1', 'attempt-1', 'probe-evidence.json');
  fs.mkdirSync(path.dirname(probeEvidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probeEvidencePath, `${JSON.stringify({
    schema_version: 1,
    actions: [
      {
        op: 'pause', trigger: 'step:developer:running',
        started_at: '2026-08-01T12:00:01.000Z', finished_at: '2026-08-01T12:00:02.000Z',
        exit_code: 0, effect: { run_paused: true },
      },
      {
        op: 'resume', trigger: 'now',
        started_at: '2026-08-01T12:10:01.000Z', finished_at: '2026-08-01T12:10:01.500Z',
        exit_code: 0, effect: { run_resumed: true },
      },
    ],
  })}\n`);

  const chaosLogPath = path.join(data.root, 'chaos', 'chaos.log');
  fs.mkdirSync(path.dirname(chaosLogPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(chaosLogPath, [
    JSON.stringify({ ts: '2026-08-01T12:00:00.500Z', action: 'sigstop_sigcont', entry: 'start', run_id: RUN_ID, pid: 4242 }),
    JSON.stringify({ ts: '2026-08-01T12:00:00.600Z', action: 'sigstop_sigcont', entry: 'hold', run_id: RUN_ID, pid: 4242 }),
    JSON.stringify({ ts: '2026-08-01T12:00:01.500Z', action: 'sigstop_sigcont', entry: 'cont', run_id: RUN_ID, pid: 4242 }),
  ].join('\n') + '\n');
}

// S41 (US-004): plant a MULTI-RUN probe-evidence artifact (the
// W4.10-restart-recovery concurrent shape) whose runs[] records carry the
// per-run terminal snapshot (terminal_status / tokens_observed /
// steps_snapshot). The durable attempt is bound to the primary run (run
// ordinal 1); the sibling (run ordinal 2) exists ONLY in this artifact.
function plantMultiRunProbeEvidence(data, rootRunId, rootSteps, rootTokens, siblingRunId, siblingSteps, siblingTokens) {
  const probeEvidencePath = path.join(data.campaignDir, 'evidence', 'CASE-1', 'attempt-1', 'probe-evidence.json');
  fs.mkdirSync(path.dirname(probeEvidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probeEvidencePath, `${JSON.stringify({
    schema_version: 1,
    case_id: 'CASE-1',
    launch_shape: 'concurrent',
    sequence_outcome: 'completed',
    runs: [
      {
        run_ordinal: 1, run_id: rootRunId, terminal_status: 'completed',
        tokens_observed: rootTokens, steps_snapshot: rootSteps, actions: [],
      },
      {
        run_ordinal: 2, run_id: siblingRunId, terminal_status: 'completed',
        tokens_observed: siblingTokens, steps_snapshot: siblingSteps, actions: [],
      },
    ],
  }, null, 2)}\n`);
}

function input(data) {
  return {
    ttRoot: TT_ROOT,
    campaignDir: data.campaignDir,
    stateDir: data.stateDir,
    databasePath: data.databasePath,
    repositoryPath: data.repoDir,
    // US-003: the terminal snapshot copies tt-chaos's chaos.log (default
    // <ttRoot>/var/chaos/chaos.log); tests pin a hermetic copy under the
    // fixture root so they never touch shared var/chaos state.
    chaosLogPath: path.join(data.root, 'chaos', 'chaos.log'),
    caseRecord: {
      id: 'CASE-1', workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts', harness: 'hermes',
      context: { merge_gate: 'green', fail_missing: '1', test_cmd: 'npm test', prose: 'do not capture me' },
      boundary_files: ['src'], forbidden: ['bait.txt'],
    },
    attempt: {
      id: 'attempt-1', run_id: RUN_ID, launch_intent_at: '2026-08-01T12:00:00.000Z',
      execution_mode: 'real', terminal_status: 'completed', tokens_observed: 17,
      steps_snapshot: { source: 'workflow-status-json', captured_at: '2026-08-01T12:00:04.000Z', steps: [] },
    },
    launchArgv: ['workflow', 'run', 'feature-dev-merge-worktree', '--context', 'merge_gate=green'],
    discoveredRuns: [
      { run_id: 'run-reclaimer', parent_run_id: RUN_ID },
      { run_id: 'run-owner', parent_run_id: RUN_ID },
      { run_id: 'run-ordinary-owner', parent_run_id: RUN_ID },
      { run_id: 'run-ordinary-waiter', parent_run_id: RUN_ID },
      { run_id: 'run-stop-owner', parent_run_id: RUN_ID },
      { run_id: 'run-stop-waiter', parent_run_id: RUN_ID },
    ],
  };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('harvests a complete immutable snapshot that passes O9 with immediate reclaim and cancel evidence', async () => {
  const data = fixture();
  try {
    const request = input(data);
    const sourceDatabaseHash = digest(data.databasePath);
    fs.writeFileSync(`${data.databasePath}-wal`, '');
    plantLifecycleEvidence(data);
    const started = beginOracleEvidenceSnapshot(request);
    assert.equal(fs.existsSync(`${data.databasePath}-shm`), false, 'baseline read created source SHM');
    fs.rmSync(`${data.databasePath}-wal`);
    assert.equal(started.status, 'BASELINE_CAPTURED');
    fs.writeFileSync(path.join(data.repoDir, 'src', 'value.ts'), 'export const value = 2;\n');
    run('git', ['add', 'src/value.ts'], data.repoDir);
    run('git', ['commit', '-m', 'terminal'], data.repoDir);
    const unattachedCommit = run('git', [
      'commit-tree', run('git', ['rev-parse', 'HEAD^{tree}'], data.repoDir), '-m', 'unattached tested commit',
    ], data.repoDir);
    fs.writeFileSync(`${data.databasePath}-wal`, '');

    const completed = completeOracleEvidenceSnapshot(request, started);
    assert.equal(fs.existsSync(`${data.databasePath}-shm`), false, 'terminal read created source SHM');
    assert.equal(completed.status, 'COMPLETE');
    assert.equal(digest(data.databasePath), sourceDatabaseHash, 'source database was modified');
    assert.deepEqual(Object.keys(completed.references), ORACLE_EVIDENCE_KEYS);
    for (const [key, reference] of Object.entries(completed.references)) {
      assert.ok(reference, `${key} was not captured`);
      const absolute = path.join(data.campaignDir, reference.path);
      assert.equal(digest(absolute), reference.sha256, `${key} hash mismatch`);
      assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false);
      assert.equal(fs.statSync(absolute).mode & 0o222, 0, `${key} is writable`);
    }

    // US-003: the probe_evidence artifact and chaos.log are captured under
    // their evidence keys with content intact (O16/O4 consumption surface).
    const probeEvidence = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.probe_evidence.path), 'utf8',
    ));
    assert.equal(probeEvidence.schema_version, 1);
    assert.deepEqual(probeEvidence.actions.map((action) => action.op), ['pause', 'resume']);
    assert.equal(probeEvidence.actions[0].trigger, 'step:developer:running');
    const chaosLog = fs.readFileSync(
      path.join(data.campaignDir, completed.references.chaos_log.path), 'utf8',
    );
    assert.deepEqual(
      [...chaosLog.matchAll(/"action":"sigstop_sigcont","entry":"(start|hold|cont)"/g)].map((match) => match[1]),
      ['start', 'hold', 'cont'],
      'chaos.log copy must preserve every tt-chaos sigstop_sigcont entry',
    );
    assert.match(completed.references.probe_evidence.source, /controller-probe-sequence/);
    assert.match(completed.references.chaos_log.source, /tt-chaos-log/);

    const dbCopy = new DatabaseSync(path.join(data.campaignDir, completed.references.database_snapshot.path), { readOnly: true });
    assert.equal(dbCopy.prepare('SELECT tokens_spent FROM runs').get().tokens_spent, 17);
    dbCopy.close();
    const extractedGit = path.join(data.root, 'extracted-git');
    fs.mkdirSync(extractedGit);
    run('tar', ['-C', extractedGit, '-xf', path.join(data.campaignDir, completed.references.git_bundle.path)], data.root);
    run('git', [`--git-dir=${extractedGit}`, 'cat-file', '-e', `${unattachedCommit}^{commit}`], data.root);
    const refsBefore = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.refs_before.path)));
    const refsAfter = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.refs_after.path)));
    assert.notEqual(refsBefore.target_tip, refsAfter.target_tip);
    assert.match(refsAfter.for_each_ref, /refs\/heads\/main/);
    const reflog = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.target_reflog.path)));
    assert.equal(reflog.target_ref, 'refs/heads/main');
    assert.ok(Array.isArray(reflog.entries));
    const baseline = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.checksum_baseline.path)));
    assert.ok(baseline.entries.some((entry) => entry.path === 'bait.txt' && entry.categories.includes('forbidden')));
    assert.ok(baseline.entries.some((entry) => entry.path === 'test/value.test.ts' && entry.categories.includes('seeded-test')));
    assert.deepEqual(
      baseline.entries.find((entry) => entry.path === 'test/value.test.ts').test_markers,
      { skip: 0, todo: 0, xfail: 0 },
    );
    const events = fs.readFileSync(path.join(data.campaignDir, completed.references.run_events.path), 'utf8');
    assert.equal(events.includes('agent prose must not be copied'), false);
    const roundUsage = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.round_usage.path)));
    assert.equal(roundUsage.rows[0].id, 'usage-1');
    assert.equal(roundUsage.rows[0].formula_inputs.total, 17);
    assert.deepEqual(roundUsage.rows[0].candidate_run_ids, [RUN_ID]);
    assert.deepEqual(roundUsage.synthetic_ledger, []);
    const submitRejections = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.submit_rejections.path)));
    assert.deepEqual(submitRejections.rows[0], {
      id: 'rejection-1', observed_at: '2026-08-01T12:00:03.000Z', run_id: RUN_ID,
      step_row_id: 'row-step-1', step_id: 'step-1', claim_id: 'claim-1', attempt_number: 1,
      validation_code: 'EXPECTS_REJECTED', missing_keys: ['TESTS'], invalid_keys: [], diagnostic_code: 'EXPECTS_MISSING_TESTS',
    });
    const expectsValidations = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.expects_validations.path)));
    assert.deepEqual(expectsValidations.rows[0].key_sources, [{ key: 'TESTS', producer_step_row_id: 'row-producer' }]);
    assert.deepEqual(expectsValidations.rows[0].transition, { action: 'reroute', target_step_row_id: 'row-producer' });
    const dispatchRenderings = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.dispatch_renderings.path)));
    assert.deepEqual(dispatchRenderings.rows[0].required_keys, ['ARTIFACT']);
    assert.equal(dispatchRenderings.rows[0].unresolved_placeholder_count, 0);
    const suiteObservations = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.references.suite_observations.path)));
    assert.equal(suiteObservations.ttl_green_ms, 86_400_000);
    assert.deepEqual(suiteObservations.rows.map((row) => row.phase).slice(0, 8), ['lookup', 'execute', 'record', 'lookup', 'execute', 'record', 'lookup', 'replay']);
    assert.equal(suiteObservations.rows[0].force, true);
    assert.equal(suiteObservations.rows[6].force, false);
    assert.equal(suiteObservations.rows[7].ledger_row_id, 1);
    assert.equal(suiteObservations.rows[7].marker, 'TAMANDUA-TEST CACHED');
    assert.deepEqual(suiteObservations.origin_identities, [{ origin_repo: data.suiteOrigin, normalized_origin_repo: data.suiteOrigin }]);
    assert.equal(suiteObservations.singleflight_observations.length, 3);
    assert.equal(suiteObservations.singleflight_observations[0].recovery, 'dead_owner');
    assert.deepEqual(
      suiteObservations.singleflight_observations[0].events.map((event) => event.type),
      ['execute_started', 'wait', 'dead_owner_reclaimed', 'execute_started'],
    );
    assert.equal(
      suiteObservations.singleflight_observations[0].events.at(-1).observed_at,
      '2026-08-01T11:59:59.700Z',
      'real execution start must not be reconstructed or clamped to reclaim time',
    );
    assert.deepEqual(
      suiteObservations.singleflight_observations.map((observation) => observation.recovery),
      ['dead_owner', null, 'stop_cancel'],
    );
    assert.deepEqual(
      suiteObservations.singleflight_observations[1].events.map((event) => event.type),
      ['execute_started', 'wait', 'record', 'replay'],
    );
    assert.equal(
      suiteObservations.singleflight_observations[2].events.some((event) => event.type === 'dead_owner_reclaimed'),
      false,
      'stop/cancel release must not be laundered into dead-owner recovery',
    );
    assert.deepEqual(suiteObservations.special_exit_observations.map((row) => row.shim_exit_code), [86, 87, 88]);
    assert.deepEqual(suiteObservations.special_exit_observations.map((row) => row.junk_probe_tracked), [false, false, false]);
    assert.equal(suiteObservations.special_exit_observations[2].tracked_dirty, true);
    assert.equal(suiteObservations.special_exit_observations[2].command_exit_code, null);
    const o9EvidenceDir = path.join(data.campaignDir, 'o9-evidence');
    fs.mkdirSync(o9EvidenceDir);
    const o9Result = await evaluateO9({
      campaignRoot: data.campaignDir,
      evidenceDir: o9EvidenceDir,
      evidencePaths: Object.fromEntries(Object.entries(completed.references)
        .map(([key, reference]) => [key, path.join(data.campaignDir, reference.path)])),
    });
    assert.equal(o9Result.result, 'PASS', JSON.stringify(o9Result.findings));
    const launchIntent = fs.readFileSync(path.join(data.campaignDir, completed.references.launch_intent.path), 'utf8');
    assert.equal(launchIntent.includes('do not capture me'), false);
    const launchIntentJson = JSON.parse(launchIntent);
    assert.equal(launchIntentJson.gate_key.origin_repo, fs.realpathSync(data.repoDir));
    assert.equal(launchIntentJson.gate_key.cmd_hash, createHash('sha256').update('npm test').digest('hex'));
    const provenance = JSON.parse(fs.readFileSync(path.join(data.campaignDir, completed.provenance.path)));
    assert.equal(provenance.status, 'COMPLETE');
    assert.deepEqual(Object.keys(provenance.files), ORACLE_EVIDENCE_KEYS);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

// S41 (US-004) — probe-sequence sibling runs + the ROOT terminal snapshot in
// workflow-status.json. In multi-run probe shapes (W4.10-restart-recovery's
// two concurrent runs) only the per-run proxies are harvested, so the durable
// attempt's steps_snapshot stays null and tokens_observed stays 0 while the
// probe-evidence artifact carries every probed run. The terminal snapshot
// must register each sibling in the root/discovered graph with its per-run
// terminal snapshot and fall the ROOT row back to the primary probe run's
// snapshot (concurrent shapes) — the campaign graph voided O1/O2/O11 with
// `steps_snapshot: null, tokens_observed: 0, discovered_runs: []`.
test('S41: registers probe-sequence sibling runs with terminal snapshots in workflow-status.json (root fallback)', async () => {
  const data = fixture();
  try {
    const request = input(data);
    // The concurrent W4.10-restart-recovery shape: the durable attempt is
    // bound to the primary run but was never harvested itself.
    request.attempt.terminal_status = 'completed';
    request.attempt.tokens_observed = 0;
    request.attempt.steps_snapshot = null;
    const primarySteps = {
      source: 'workflow-status-json', captured_at: '2026-08-01T12:00:04.000Z',
      steps: [{ stepId: 'step-1', agentRole: 'developer', status: 'done' }],
    };
    const siblingSteps = {
      source: 'workflow-status-json', captured_at: '2026-08-01T12:00:05.000Z',
      steps: [{ stepId: 'step-1', agentRole: 'developer', status: 'done' }],
    };
    plantMultiRunProbeEvidence(
      data, RUN_ID, primarySteps, 17,
      'run-22222222-2222-4222-8222-222222222222', siblingSteps, 9,
    );
    // The controller graph intentionally lacks the sibling (pre-fix shape);
    // one discovered run is present so the pre-existing rows survive.
    request.discoveredRuns = [{ run_id: 'run-reclaimer', parent_run_id: RUN_ID }];
    const started = beginOracleEvidenceSnapshot(request);
    assert.equal(started.status, 'BASELINE_CAPTURED');
    const completed = completeOracleEvidenceSnapshot(request, started);
    assert.equal(completed.status, 'COMPLETE');
    const workflowStatus = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.workflow_status.path), 'utf8',
    ));
    assert.equal(workflowStatus.schema_version, 1);
    // ROOT: the primary probe run's terminal snapshot is the root snapshot
    // (the attempt itself was never harvested in the concurrent shape).
    assert.equal(workflowStatus.root.run_id, RUN_ID);
    assert.equal(workflowStatus.root.terminal_status, 'completed');
    assert.equal(workflowStatus.root.tokens_observed, 17);
    assert.deepEqual(workflowStatus.root.steps_snapshot, primarySteps);
    // The sibling run is registered with its own terminal snapshot.
    const sibling = workflowStatus.discovered_runs.find((run) => run.run_id === 'run-22222222-2222-4222-8222-222222222222');
    assert.ok(sibling, 'probe-sequence sibling run must be registered in workflow-status.json');
    assert.equal(sibling.parent_run_id, RUN_ID);
    assert.equal(sibling.terminal_status, 'completed');
    assert.equal(sibling.tokens_observed, 9);
    assert.deepEqual(sibling.steps_snapshot, siblingSteps);
    // Pre-existing discovered runs are preserved (never dropped).
    assert.ok(workflowStatus.discovered_runs.some((run) => run.run_id === 'run-reclaimer'));
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

// S41 (US-004): a sibling already present in the controller graph (a
// discovered-run record that predates the terminal snapshot) is MERGED — its
// missing snapshot fields are filled from the probe artifact, never
// overwritten — and a harvested ROOT attempt's own snapshot is never
// overridden by the primary probe record.
test('S41: merges the probe sibling into an existing discovered-run row and never overrides a harvested root snapshot', async () => {
  const data = fixture();
  try {
    const request = input(data);
    const harvestedRootSteps = request.attempt.steps_snapshot;
    plantMultiRunProbeEvidence(
      data, RUN_ID, harvestedRootSteps, request.attempt.tokens_observed,
      'run-33333333-3333-4333-8333-333333333333', harvestedRootSteps, 5,
    );
    // The sibling is already in the controller graph but its record predates
    // the terminal snapshot (tokens_observed 0, no steps).
    request.discoveredRuns = [{
      run_id: 'run-33333333-3333-4333-8333-333333333333',
      parent_run_id: RUN_ID,
      terminal_status: 'completed',
      tokens_observed: 0,
      steps_snapshot: null,
    }];
    const started = beginOracleEvidenceSnapshot(request);
    assert.equal(started.status, 'BASELINE_CAPTURED');
    const completed = completeOracleEvidenceSnapshot(request, started);
    assert.equal(completed.status, 'COMPLETE');
    const workflowStatus = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.workflow_status.path), 'utf8',
    ));
    // The harvested root keeps its own snapshot (never overridden by the
    // primary probe record — single-run/ordinary shapes unchanged).
    assert.deepEqual(workflowStatus.root.steps_snapshot, harvestedRootSteps);
    assert.equal(workflowStatus.root.tokens_observed, request.attempt.tokens_observed);
    // The sibling row is merged: snapshot fields come from the probe
    // artifact, parent_run_id stays from the discovered record, no dupes.
    const sibling = workflowStatus.discovered_runs.find((run) => run.run_id === 'run-33333333-3333-4333-8333-333333333333');
    assert.ok(sibling, 'existing discovered sibling row must be kept');
    assert.equal(sibling.parent_run_id, RUN_ID);
    assert.equal(sibling.terminal_status, 'completed');
    assert.equal(sibling.tokens_observed, 5);
    assert.deepEqual(sibling.steps_snapshot, harvestedRootSteps);
    assert.equal(workflowStatus.discovered_runs.length, 1, 'no duplicate sibling rows');
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

// S31 (US-009) — W4.30-detached-head-origin: a detached-HEAD fixture must NOT
// throw `fixture repository has no symbolic target ref` (the campaign's
// scheduler-execution-failed line). The target identity resolves per the
// case's declared contract — the detached HEAD commit — and is recorded with
// a detached_head marker on refs_before/refs_after/target_reflog; the reflog
// capture reads logs/HEAD. The named-target (refs/...) shape is unchanged
// (pinned by the harvest test above).
test('S31: a detached-HEAD fixture begins and completes the snapshot with the detached commit identity (no symbolic-target-ref throw)', () => {
  const data = fixture();
  try {
    const request = input(data);
    // W4.30's reset hook detached the work-clone HEAD: git symbolic-ref -q
    // HEAD is empty (exit 1) and the target identity is the HEAD commit.
    run('git', ['checkout', '-q', '--detach', 'HEAD'], data.repoDir);
    const symbolicProbe = spawnSync('git', ['-C', data.repoDir, 'symbolic-ref', '-q', 'HEAD'], {
      encoding: 'utf8', shell: false,
    });
    assert.equal(symbolicProbe.stdout.trim(), '', 'premise: the fixture must be in detached HEAD');
    const headSha = run('git', ['rev-parse', 'HEAD'], data.repoDir);
    // A launch-refused run (the W4.30 corridor) never moves the target: the
    // run row records the failed launch and the repo stays put.
    const db = new DatabaseSync(data.databasePath, { open: true });
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run('11111111-1111-4111-8111-111111111111');
    db.close();
    fs.writeFileSync(`${data.databasePath}-wal`, '');

    const started = beginOracleEvidenceSnapshot(request);
    assert.equal(started.status, 'BASELINE_CAPTURED');
    fs.rmSync(`${data.databasePath}-wal`);
    const refsBefore = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, started.references.refs_before.path), 'utf8',
    ));
    assert.equal(refsBefore.target_ref, headSha, 'detached fixture target_ref must be the HEAD commit');
    assert.equal(refsBefore.target_tip, headSha, 'detached fixture target_tip must be the HEAD commit');
    assert.equal(refsBefore.detached_head, true, 'refs_before must carry detached_head');

    const completed = completeOracleEvidenceSnapshot(request, started);
    assert.equal(completed.status, 'COMPLETE');
    const refsAfter = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.refs_after.path), 'utf8',
    ));
    assert.equal(refsAfter.target_ref, headSha);
    assert.equal(refsAfter.detached_head, true, 'refs_after must carry detached_head');
    assert.equal(refsAfter.target_ref, refsBefore.target_ref, 'target identity must agree across snapshots');
    const reflog = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.target_reflog.path), 'utf8',
    ));
    assert.equal(reflog.target_ref, headSha, 'target_reflog must carry the detached target identity');
    assert.equal(reflog.detached_head, true, 'target_reflog must carry detached_head');
    assert.ok(Array.isArray(reflog.entries) && reflog.entries.length > 0,
      `detached reflog must capture logs/HEAD entries, got ${reflog.entries.length}`);
    // The detached checkout entry is present (moving from main to the commit).
    assert.ok(reflog.entries.some((entry) => /checkout: moving from main to /.test(entry.raw ?? '')),
      'detached reflog must carry the checkout entry');
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('US-010: appends process-recorder samples to the chaos_log bundle at the default chaos log path (O4 liveness provenance)', async () => {
  const data = fixture();
  try {
    // Plant the chaos log at the DEFAULT location under a hermetic ttRoot
    // (<ttRoot>/var/chaos/chaos.log) plus recorder samples under
    // <ttRoot>/var/recorder — the O4 liveness-provenance bundle. The
    // controller pins chaosLogPath to exactly this default path (US-008), so
    // the append must fire for the pinned path too (US-010 fix: gate on
    // path-equality with the derivation, not on undefined-ness).
    const varDir = path.join(data.root, 'var');
    const chaosDir = path.join(varDir, 'chaos');
    const recorderDir = path.join(varDir, 'recorder');
    fs.mkdirSync(chaosDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(recorderDir, { recursive: true, mode: 0o700 });
    const chaosLogPath = path.join(chaosDir, 'chaos.log');
    fs.writeFileSync(chaosLogPath, [
      JSON.stringify({ ts: '2026-08-01T12:00:00.500Z', action: 'sigstop_sigcont', entry: 'start', run_id: RUN_ID, pid: 4242 }),
      JSON.stringify({ ts: '2026-08-01T12:00:00.600Z', action: 'sigstop_sigcont', entry: 'hold', run_id: RUN_ID, pid: 4242 }),
      JSON.stringify({ ts: '2026-08-01T12:00:01.500Z', action: 'sigstop_sigcont', entry: 'cont', run_id: RUN_ID, pid: 4242 }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(recorderDir, 'samples-20260801T120000Z.jsonl'), [
      JSON.stringify({ ts: '2026-08-01T12:00:01.000Z', pid: 7001, pgid: 7001, ppid: 1, cwd: `/repo/var/runs/${RUN_ID}`, cmdline: `node /repo/var/harness-${RUN_ID} --run ${RUN_ID}`, rss: 120000, fd: 24 }),
      JSON.stringify({ ts: '2026-08-01T12:00:06.000Z', pid: 7001, pgid: 7001, ppid: 1, cwd: `/repo/var/runs/${RUN_ID}`, cmdline: `node /repo/var/harness-${RUN_ID} --run ${RUN_ID}`, rss: 120000, fd: 24 }),
    ].join('\n') + '\n');

    const request = { ...input(data), ttRoot: data.root, chaosLogPath };
    fs.writeFileSync(`${data.databasePath}-wal`, '');
    const started = beginOracleEvidenceSnapshot(request);
    fs.rmSync(`${data.databasePath}-wal`);
    assert.equal(started.status, 'BASELINE_CAPTURED');
    fs.writeFileSync(`${data.databasePath}-wal`, '');
    const completed = completeOracleEvidenceSnapshot(request, started);
    assert.equal(completed.status, 'COMPLETE');

    const chaosLog = fs.readFileSync(
      path.join(data.campaignDir, completed.references.chaos_log.path), 'utf8',
    );
    assert.match(chaosLog, /# recorder-samples/, 'recorder bundle must carry the section marker');
    assert.match(chaosLog, /"pid":7001/, 'recorder samples must be appended');
    const lines = chaosLog.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(lines.filter((line) => line.includes('"entry":"start"')).length, 1, 'chaos entries preserved');
    assert.ok(
      lines.indexOf('# recorder-samples') > lines.findIndex((line) => line.includes('"entry":"cont"')),
      'recorder bundle must follow the chaos entries',
    );
    assert.equal(lines.length, 3 + 1 + 2, '3 chaos entries + marker + 2 recorder samples');

    // The hermetic override path stays byte-exact: pin chaosLogPath elsewhere
    // (same recorder dir present) and the append must NOT fire.
    const hermeticLog = path.join(data.root, 'hermetic', 'chaos.log');
    fs.mkdirSync(path.dirname(hermeticLog), { recursive: true, mode: 0o700 });
    fs.copyFileSync(chaosLogPath, hermeticLog);
    const hermeticRequest = {
      ...input(data), ttRoot: data.root, chaosLogPath: hermeticLog,
      attempt: { ...input(data).attempt, id: 'attempt-hermetic' },
    };
    const hermeticStarted = beginOracleEvidenceSnapshot(hermeticRequest);
    const hermeticCompleted = completeOracleEvidenceSnapshot(hermeticRequest, hermeticStarted);
    const hermeticChaosLog = fs.readFileSync(
      path.join(data.campaignDir, hermeticCompleted.references.chaos_log.path), 'utf8',
    );
    assert.doesNotMatch(hermeticChaosLog, /# recorder-samples/, 'hermetic override must stay byte-exact');
    assert.equal(
      hermeticChaosLog.split(/\r?\n/).filter((line) => line.trim() !== '').length, 3,
      'hermetic override carries exactly the chaos entries',
    );
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('preserves an unresolved cache hit beside a valid invocation so O9 can reject it', () => {
  const data = fixture();
  try {
    fs.appendFileSync(
      path.join(data.stateDir, 'events', 'all.jsonl'),
      `${JSON.stringify({
        ts: '2026-08-01T12:00:04.000Z', event: 'suite.cache_hit', runId: RUN_ID,
        stepId: 'step-invalid', treeHash: 'ffffffffffff', cmdDisplay: 'npm test',
        savedDurationMs: 999, force: true,
      })}\n`,
    );
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    const completed = completeOracleEvidenceSnapshot(request, started);
    const observations = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_observations.path),
      'utf8',
    ));
    const invalid = observations.rows.filter((row) => row.step_id === 'step-invalid');
    assert.deepEqual(invalid.map((row) => row.phase), ['lookup', 'replay']);
    assert.deepEqual(invalid.map((row) => row.force), [true, true]);
    assert.equal(invalid[0].latest_row_id, null);
    assert.equal(invalid[1].ledger_row_id, null);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('preserves the event-time junk-probe state when the terminal index later changes', () => {
  const data = fixture();
  try {
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    run('git', ['add', 'junk-probe.tmp'], data.repoDir);
    const completed = completeOracleEvidenceSnapshot(request, started);
    const observations = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_observations.path),
      'utf8',
    ));
    assert.deepEqual(observations.special_exit_observations.map((row) => row.junk_probe_tracked), [false, false, false]);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('rejects incomplete targeted special-exit process evidence instead of dropping it', () => {
  const data = fixture();
  try {
    fs.appendFileSync(path.join(data.stateDir, 'events', 'all.jsonl'), `${JSON.stringify({
      ts: '2026-08-01T12:00:03.500Z', event: 'suite.special_exit_observed', runId: RUN_ID,
      stepId: 'exit-incomplete', originRepo: data.suiteOrigin, treeHash: 'a'.repeat(40),
      cmdHash: createHash('sha256').update('npm test').digest('hex'), shimExitCode: 88,
      commandExitCode: null, preTreeHash: 'a'.repeat(40), postTreeHash: 'a'.repeat(40),
      ledgerRowId: null, interrupted: false, junkProbePath: 'junk-probe.tmp',
    })}\n`);
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    assert.throws(
      () => completeOracleEvidenceSnapshot(request, started),
      /special_exit_observed lacks complete mechanical process\/tree evidence/,
    );
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('rejects malformed mechanical event lines instead of silently dropping evidence', () => {
  const data = fixture();
  try {
    fs.appendFileSync(path.join(data.stateDir, 'events', 'all.jsonl'), '{not-json}\n');
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    assert.throws(
      () => completeOracleEvidenceSnapshot(request, started),
      /event source all\.jsonl:\d+ contains malformed JSON/,
    );
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('rejects production-state paths outside the controller-provided TT state', () => {
  const data = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-production-state.'));
  try {
    const outsideDb = path.join(outside, 'tamandua.db');
    fs.copyFileSync(data.databasePath, outsideDb);
    assert.throws(
      () => beginOracleEvidenceSnapshot({ ...input(data), databasePath: outsideDb }),
      /database.*outside controller-provided TT state/i,
    );
    assert.equal(fs.readdirSync(data.campaignDir).length, 0);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('rejects a symlinked SQLite WAL or SHM sidecar before opening the source', () => {
  const data = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-sidecar-state.'));
  try {
    const outsideWal = path.join(outside, 'tamandua.db-wal');
    fs.writeFileSync(outsideWal, 'outside WAL bytes');
    fs.symlinkSync(outsideWal, `${data.databasePath}-wal`);
    assert.throws(
      () => beginOracleEvidenceSnapshot(input(data)),
      /database sidecar.*regular file|outside controller-provided TT state/i,
    );
    assert.equal(fs.readdirSync(data.campaignDir).length, 0);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('rejects pre-existing symlink components in the snapshot destination', () => {
  const data = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-snapshot-escape.'));
  try {
    fs.symlinkSync(outside, path.join(data.campaignDir, 'snapshots'));
    assert.throws(() => beginOracleEvidenceSnapshot(input(data)), /snapshot directory.*symlink/i);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('an interrupted or partial snapshot remains TEST_INFRA and is never resumed as complete', async () => {
  const data = fixture();
  try {
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    const ledgerPath = path.join(data.campaignDir, started.ledger_path);
    const interrupted = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    interrupted.status = 'RUNNING';
    fs.writeFileSync(ledgerPath, `${JSON.stringify(interrupted, null, 2)}\n`);
    const reloaded = await import(`./oracle-evidence-snapshot.mjs?interrupted=${Date.now()}`);
    assert.throws(
      () => reloaded.completeOracleEvidenceSnapshot(request, { ...started, status: 'RUNNING' }),
      /interrupted.*TEST_INFRA/i,
    );
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).status, 'TEST_INFRA');
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('scopes suite evidence to the case\'s own origins, excluding sibling rows that share only cmd_hash', () => {
  const data = fixture();
  try {
    const siblingDir = path.join(data.root, 'sibling-repo');
    fs.mkdirSync(siblingDir);
    const siblingOrigin = fs.realpathSync(siblingDir);
    const gateCommandHash = createHash('sha256').update('npm test').digest('hex');
    const lintCommandHash = createHash('sha256').update('npm run lint').digest('hex');
    const db = new DatabaseSync(data.databasePath);
    // Sibling case row: different origin, same cmd_hash as the captured gate key.
    db.prepare('INSERT INTO suite_results VALUES (6, ?, ?, ?, ?, 0, 10, NULL, ?, ?, ?)').run(
      siblingOrigin, 'b'.repeat(40), gateCommandHash, 'npm test', 'run-sibling', 'step-sibling', '2026-08-01T12:00:06.000Z',
    );
    // Own-origin row with an unrelated command still belongs to the case bundle.
    db.prepare('INSERT INTO suite_results VALUES (7, ?, ?, ?, ?, 0, 10, NULL, ?, ?, ?)').run(
      data.suiteOrigin, 'c'.repeat(40), lintCommandHash, 'npm run lint', RUN_ID, 'step-lint', '2026-08-01T12:00:07.000Z',
    );
    db.close();
    const request = input(data);
    const started = beginOracleEvidenceSnapshot(request);
    const completed = completeOracleEvidenceSnapshot(request, started);
    const ledger = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_ledger.path), 'utf8',
    ));
    assert.deepEqual(ledger.rows.map((row) => row.id), [1, 2, 3, 4, 5, 7]);
    assert.deepEqual(new Set(ledger.rows.map((row) => row.origin_repo)), new Set([data.suiteOrigin]));
    const observations = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_observations.path), 'utf8',
    ));
    assert.equal(
      JSON.stringify(observations).includes(siblingOrigin), false,
      'sibling origin leaked into suite_observations',
    );
    assert.deepEqual(observations.origin_identities, [{ origin_repo: data.suiteOrigin, normalized_origin_repo: data.suiteOrigin }]);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('survives a null gate key with event-carried origins only', () => {
  const data = fixture();
  try {
    const siblingDir = path.join(data.root, 'sibling-repo');
    fs.mkdirSync(siblingDir);
    const siblingOrigin = fs.realpathSync(siblingDir);
    const db = new DatabaseSync(data.databasePath);
    db.prepare('INSERT INTO suite_results VALUES (6, ?, ?, ?, ?, 0, 10, NULL, ?, ?, ?)').run(
      siblingOrigin, 'b'.repeat(40), createHash('sha256').update('npm test').digest('hex'), 'npm test',
      'run-sibling', 'step-sibling', '2026-08-01T12:00:06.000Z',
    );
    db.close();
    const base = input(data);
    const request = {
      ...base,
      caseRecord: {
        ...base.caseRecord,
        context: { merge_gate: 'green', fail_missing: '1', test_cmd: null, prose: 'do not capture me' },
      },
    };
    const started = beginOracleEvidenceSnapshot(request);
    const completed = completeOracleEvidenceSnapshot(request, started);
    const launchIntent = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.launch_intent.path), 'utf8',
    ));
    assert.equal(launchIntent.gate_key, null);
    const ledger = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_ledger.path), 'utf8',
    ));
    assert.deepEqual(ledger.rows.map((row) => row.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(new Set(ledger.rows.map((row) => row.origin_repo)), new Set([data.suiteOrigin]));
    const observations = JSON.parse(fs.readFileSync(
      path.join(data.campaignDir, completed.references.suite_observations.path), 'utf8',
    ));
    assert.equal(JSON.stringify(observations).includes(siblingOrigin), false);
    assert.ok(observations.rows.length > 0, 'event-carried origins still produce shim observations');
    assert.equal(observations.origin_identities.some((entry) => entry.origin_repo === data.suiteOrigin), true);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

// ── S20 (US-001): target-reflog capture parser tolerates message-less lines ──
//
// The landing update-ref writes reflog entries with NO message segment
// ("<old> <new> <identity> <ts> <tz>"). The parser must still extract the
// before/after OIDs, identity, timestamp and timezone from such lines; the
// \t<message> tail is optional. Truly unparseable lines stay archived as
// { raw } exactly as before.

test('S20: a message-less target-reflog line parses to oids/actor/timestamp/timezone with no action', () => {
  const line = 'b919c0981b5f7b167a6d8f87a07e85cd7075f415 4f5613be5f89c45a251afdc74d2af6512b8467d3 Tamandua Torture Test <tt@tamandua.test> 1787385718 -0300';
  assert.deepEqual(parseTargetReflogLine(line), {
    old_oid: 'b919c0981b5f7b167a6d8f87a07e85cd7075f415',
    new_oid: '4f5613be5f89c45a251afdc74d2af6512b8467d3',
    actor: 'Tamandua Torture Test <tt@tamandua.test>',
    timestamp: 1787385718,
    timezone: '-0300',
    raw: line,
  });
});

test('S20: a message-bearing target-reflog line still parses exactly as before', () => {
  const line = '0000000000000000000000000000000000000000 b919c0981b5f7b167a6d8f87a07e85cd7075f415 Igor Hjelmstrom Vinhas Ribeiro <igorhvr@iasylum.net> 1787385422 -0300\tclone: from /home/igorhvr/idm/tamandua/torture-test/var/fixtures/golden/tt-python@master.git';
  assert.deepEqual(parseTargetReflogLine(line), {
    old_oid: '0000000000000000000000000000000000000000',
    new_oid: 'b919c0981b5f7b167a6d8f87a07e85cd7075f415',
    actor: 'Igor Hjelmstrom Vinhas Ribeiro <igorhvr@iasylum.net>',
    timestamp: 1787385422,
    timezone: '-0300',
    action: 'clone: from /home/igorhvr/idm/tamandua/torture-test/var/fixtures/golden/tt-python@master.git',
    raw: line,
  });
});

test('S20: a message-less line with a trailing tab parses with an empty action', () => {
  const line = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb Some Actor <a@example.invalid> 1787385718 -0300\t';
  assert.deepEqual(parseTargetReflogLine(line), {
    old_oid: 'a'.repeat(40),
    new_oid: 'b'.repeat(40),
    actor: 'Some Actor <a@example.invalid>',
    timestamp: 1787385718,
    timezone: '-0300',
    action: '',
    raw: line,
  });
});

test('S20: a truly unparseable target-reflog line is archived as { raw }', () => {
  const line = 'this is not a reflog line at all';
  assert.deepEqual(parseTargetReflogLine(line), { raw: line });
});

// ── S22B (US-002): shared attempt-number synthesis across both streams ──
//
// projectSubmitRejections and projectExpectsValidations previously kept
// INDEPENDENT per-stream per-claim counters. On a rejected->accepted->rejected
// sequence the second physical attempt received attempt number 2 in
// submit_rejections but 3 in expects_validations (its rejected expects
// validation), so O11's claim_id+attempt_number join flagged the same
// physical event twice (O11_REJECTION_VALIDATION_MISMATCH +
// O11_REJECTION_WITHOUT_VALIDATION). Both artifacts must now derive attempt
// numbers from ONE shared per-claim counter over both streams in
// chronological order.

function submissionEvent(line, event) {
  return { archive: 'all.jsonl', line, event };
}

test('S22B: a rejected->accepted->rejected sequence shares one per-claim attempt counter across both artifacts', () => {
  const claimId = 'claim-tester';
  const events = [
    submissionEvent(1, { ts: '2026-08-01T12:00:01.000Z', event: 'step.submit.rejected', recordId: 'rejection-1', runId: RUN_ID, stepRowId: 'row-tester', stepId: 'step-tester', claimId, validationCode: 'EXPECTS_REJECTED', missingKeys: ['CHANGES'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_CHANGES' }),
    submissionEvent(2, { ts: '2026-08-01T12:00:01.001Z', event: 'step.expects.validated', recordId: 'validation-1', runId: RUN_ID, stepRowId: 'row-tester', stepId: 'step-tester', claimId, outcome: 'rejected', verdict: null, expectsRequired: true, requiredKeys: ['STATUS', 'CHANGES', 'TESTS'], missingKeys: ['CHANGES'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_CHANGES', producerStepRowId: 'row-producer', transitionAction: 'retry', transitionTargetStepRowId: 'row-tester' }),
    submissionEvent(3, { ts: '2026-08-01T12:00:02.000Z', event: 'step.expects.validated', recordId: 'validation-2', runId: RUN_ID, stepRowId: 'row-tester', stepId: 'step-tester', claimId, outcome: 'accepted', verdict: 'done', expectsRequired: true, requiredKeys: ['STATUS', 'CHANGES', 'TESTS'], missingKeys: [], invalidKeys: [], diagnosticCode: 'EXPECTS_SATISFIED', producerStepRowId: null, transitionAction: 'done', transitionTargetStepRowId: 'row-tester' }),
    submissionEvent(4, { ts: '2026-08-01T12:00:03.000Z', event: 'step.submit.rejected', recordId: 'rejection-2', runId: RUN_ID, stepRowId: 'row-tester', stepId: 'step-tester', claimId, validationCode: 'EXPECTS_REJECTED', missingKeys: ['TESTS'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_TESTS' }),
    submissionEvent(5, { ts: '2026-08-01T12:00:03.001Z', event: 'step.expects.validated', recordId: 'validation-3', runId: RUN_ID, stepRowId: 'row-tester', stepId: 'step-tester', claimId, outcome: 'rejected', verdict: null, expectsRequired: true, requiredKeys: ['STATUS', 'CHANGES', 'TESTS'], missingKeys: ['TESTS'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_TESTS', producerStepRowId: 'row-producer', transitionAction: 'retry', transitionTargetStepRowId: 'row-tester' }),
  ];
  const rejections = projectSubmitRejections(events);
  const validations = projectExpectsValidations(events);

  // Physical attempts: rejection 1 + its rejected validation = attempt 1,
  // accepted validation = attempt 2, rejection 2 + its rejected validation = attempt 3.
  assert.deepEqual(rejections.map((row) => row.attempt_number), [1, 3]);
  assert.deepEqual(validations.map((row) => row.attempt_number), [1, 2, 3]);
  assert.deepEqual(
    validations.filter((row) => row.outcome === 'rejected').map((row) => row.attempt_number),
    [1, 3],
    'rejected expects validations must carry the SAME attempt numbers as their submit rejections',
  );

  // The O11_REJECTION_VALIDATION_MISMATCH / O11_REJECTION_WITHOUT_VALIDATION
  // join is by claim_id + attempt_number — no mismatch pair may exist.
  const rejectedValidations = validations.filter((row) => row.outcome === 'rejected');
  for (const rejection of rejections) {
    assert.ok(
      rejectedValidations.some((row) => row.claim_id === rejection.claim_id
        && row.attempt_number === rejection.attempt_number),
      `rejection ${rejection.id} (attempt ${rejection.attempt_number}) must have a matching rejected validation`,
    );
  }
  for (const validation of rejectedValidations) {
    assert.ok(
      rejections.some((row) => row.claim_id === validation.claim_id
        && row.attempt_number === validation.attempt_number),
      `rejected validation ${validation.id} (attempt ${validation.attempt_number}) must have a matching rejection`,
    );
  }
});

test('S22B: an explicit event.attemptNumber still wins and re-seeds the shared counter', () => {
  const claimId = 'claim-explicit';
  const events = [
    submissionEvent(1, { ts: '2026-08-01T12:00:01.000Z', event: 'step.submit.rejected', recordId: 'rejection-1', runId: RUN_ID, stepRowId: 'row-1', stepId: 'step-1', claimId, attemptNumber: 7, validationCode: 'EXPECTS_REJECTED', missingKeys: ['CHANGES'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_CHANGES' }),
    submissionEvent(2, { ts: '2026-08-01T12:00:01.001Z', event: 'step.expects.validated', recordId: 'validation-1', runId: RUN_ID, stepRowId: 'row-1', stepId: 'step-1', claimId, outcome: 'rejected', verdict: null, expectsRequired: true, requiredKeys: ['STATUS', 'CHANGES'], missingKeys: ['CHANGES'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_CHANGES', producerStepRowId: 'row-producer', transitionAction: 'retry', transitionTargetStepRowId: 'row-1' }),
    submissionEvent(3, { ts: '2026-08-01T12:00:02.000Z', event: 'step.expects.validated', recordId: 'validation-2', runId: RUN_ID, stepRowId: 'row-1', stepId: 'step-1', claimId, outcome: 'accepted', verdict: 'done', expectsRequired: true, requiredKeys: ['STATUS', 'CHANGES'], missingKeys: [], invalidKeys: [], diagnosticCode: 'EXPECTS_SATISFIED', producerStepRowId: null, transitionAction: 'done', transitionTargetStepRowId: 'row-1' }),
  ];
  assert.deepEqual(projectSubmitRejections(events).map((row) => row.attempt_number), [7]);
  assert.deepEqual(
    projectExpectsValidations(events).map((row) => row.attempt_number), [7, 8],
    'the shared counter continues from an explicit attemptNumber',
  );
});

test('S22B: a standalone rejected validation without a preceding rejection still gets a consistent attempt number', () => {
  const claimId = 'claim-standalone';
  const events = [
    submissionEvent(1, { ts: '2026-08-01T12:00:01.000Z', event: 'step.expects.validated', recordId: 'validation-1', runId: RUN_ID, stepRowId: 'row-1', stepId: 'step-1', claimId, outcome: 'rejected', verdict: null, expectsRequired: true, requiredKeys: ['STATUS'], missingKeys: ['STATUS'], invalidKeys: [], diagnosticCode: 'EXPECTS_MISSING_STATUS', producerStepRowId: 'row-producer', transitionAction: 'retry', transitionTargetStepRowId: 'row-1' }),
  ];
  assert.deepEqual(projectSubmitRejections(events), []);
  assert.deepEqual(projectExpectsValidations(events).map((row) => row.attempt_number), [1]);
});
