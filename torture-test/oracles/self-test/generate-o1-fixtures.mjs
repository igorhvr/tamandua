#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O1 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const ROOT = 'run-11111111-1111-4111-8111-111111111111';
const CHILD = 'run-22222222-2222-4222-8222-222222222222';
const PRIOR = 'run-33333333-3333-4333-8333-333333333333';
const CAPTURED_AT = '2026-08-01T12:10:00.000Z';
const STARTED_AT = '2026-08-01T12:00:00.000Z';
const TERMINAL_AT = '2026-08-01T12:09:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings',
];

function bare(id) {
  return id.startsWith('run-') ? id.slice(4) : id;
}

function step(runId, overrides = {}) {
  return {
    id: `row-${bare(runId).slice(0, 4)}`,
    run_id: bare(runId),
    step_id: `step-${bare(runId).slice(0, 4)}`,
    agent_id: 'synthetic_agent',
    step_index: 0,
    status: 'done',
    type: 'single',
    current_story_id: null,
    claim_pid: null,
    claim_updated_at: null,
    updated_at: TERMINAL_AT,
    ...overrides,
  };
}

function projectedTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? new Date(`${value.replace(' ', 'T')}Z`).toISOString()
    : value;
}

function projectedStep(row, overrides = {}) {
  return {
    stepId: `step-${row.step_id}`,
    agentRole: row.agent_id.split('_').at(-1),
    stepIndex: row.step_index,
    status: row.status,
    displayStatus: row.type === 'loop' && row.status === 'running' && row.current_story_id === null ? 'verifying' : row.status,
    claimPid: row.claim_pid,
    claimUpdatedAt: projectedTimestamp(row.claim_updated_at),
    updatedAt: projectedTimestamp(row.updated_at),
    ...overrides,
  };
}

function attempt(id, status, steps) {
  const terminal = ['completed', 'failed', 'canceled'].includes(status);
  return {
    id: `attempt-${bare(id).slice(0, 4)}`,
    kind: 'workflow',
    phase: terminal ? 'terminal' : 'running',
    execution_mode: 'real',
    run_id: id,
    started_at: STARTED_AT,
    terminal_at: terminal ? TERMINAL_AT : null,
    terminal_status: terminal ? status : null,
    tokens_observed: 1,
    command_result: terminal ? { exit_code: status === 'completed' ? 0 : 1, signal: null } : null,
    steps_snapshot: {
      source: 'workflow-status-json',
      captured_at: CAPTURED_AT,
      steps: steps.map((row) => projectedStep(row)),
    },
    straggler_capture: null,
  };
}

const cases = [
  { name: 'o1-green', expected: 'PASS', childStatus: 'failed', childStepStatus: 'running', childStepType: 'loop', historicalAttempt: true },
  { name: 'o1-fast-wave', expected: 'FAIL', fastWave: true, finding: 'O1_DURATION_FLOOR_RATE' },
  { name: 'o1-fast-failure-excluded', expected: 'PASS', excludedFast: true },
  { name: 'o1-duration-floor-missing', expected: 'FAIL', missingDurationFloor: true, finding: 'O1_DURATION_FLOOR_MISSING' },
  { name: 'o1-duration-floor-omitted', expected: 'FAIL', omitDurationFloor: true, finding: 'O1_DURATION_FLOOR_MISSING' },
  { name: 'o1-duration-floor-duplicate', expected: 'FAIL', duplicateDurationFloor: true, finding: 'O1_DURATION_FLOOR_DUPLICATE' },
  { name: 'o1-duration-floor-unknown', expected: 'FAIL', unknownDurationFloor: true, finding: 'O1_DURATION_FLOOR_UNKNOWN' },
  { name: 'o1-wave-runs-omitted', expected: 'FAIL', omitWaveProjection: true, finding: 'O1_WAVE_RUN_MISSING' },
  { name: 'o1-wave-run-duplicate', expected: 'FAIL', duplicateWaveRun: true, finding: 'O1_WAVE_RUN_DUPLICATE' },
  { name: 'o1-wave-run-unknown', expected: 'FAIL', unknownWaveRun: true, finding: 'O1_WAVE_RUN_UNKNOWN' },
  { name: 'o1-wave-run-mismatch', expected: 'FAIL', mismatchedWaveRun: true, finding: 'O1_WAVE_RUN_MISMATCH' },
  { name: 'o1-run-nonterminal', expected: 'FAIL', rootStatus: 'running', finding: 'O1_RUN_NONTERMINAL' },
  { name: 'o1-step-nonterminal', expected: 'FAIL', rootStepStatus: 'pending', finding: 'O1_COMPLETED_STEP_NONTERMINAL' },
  { name: 'o1-missing-terminal-event', expected: 'FAIL', omitRootEvent: true, finding: 'O1_TERMINAL_EVENT_MISSING' },
  { name: 'o1-status-disagreement', expected: 'FAIL', workflowRootStatus: 'failed', finding: 'O1_WORKFLOW_DB_STATUS_MISMATCH' },
  { name: 'o1-scheduling-error', expected: 'FAIL', schedulingStatus: 'error', finding: 'O1_SCHEDULING_ERROR' },
  { name: 'o1-unadmitted-old', expected: 'FAIL', rootStatus: 'running', schedulingStatus: 'pending_register', finding: 'O1_RUN_UNADMITTED' },
  { name: 'o1-queued-old', expected: 'FAIL', rootStatus: 'running', schedulingStatus: 'queued', finding: 'O1_RUN_UNADMITTED' },
  { name: 'o1-discovered-nonterminal', expected: 'FAIL', childStatus: 'running', finding: 'O1_RUN_NONTERMINAL' },
  { name: 'o1-healthy-straggler', expected: 'PASS', childStatus: 'canceled', healthyStraggler: true },
];

for (const fixture of cases) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidenceDir = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  const rootStatus = fixture.rootStatus ?? 'completed';
  const childStatus = fixture.childStatus ?? 'completed';
  const rootStep = step(ROOT, { status: fixture.rootStepStatus ?? 'done' });
  const childStep = step(CHILD, fixture.healthyStraggler ? {
    status: 'running', type: 'single', claim_pid: 4242,
    claim_updated_at: '2026-08-01 12:09:30', updated_at: '2026-08-01 12:09:45',
  } : {
    status: fixture.childStepStatus ?? (childStatus === 'running' ? 'pending' : 'done'),
    type: fixture.childStepType ?? 'single',
  });
  const rootAttempt = attempt(ROOT, rootStatus, [rootStep]);
  if (fixture.fastWave) rootAttempt.terminal_at = '2026-08-01T12:00:30.000Z';
  const childAttempt = { ...attempt(CHILD, childStatus, [childStep]), parent_run_id: ROOT };

  const databasePath = path.join(snapshots, 'database.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
      scheduling_status TEXT, scheduling_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL, status TEXT NOT NULL, type TEXT NOT NULL, current_story_id TEXT,
      claim_pid INTEGER, claim_updated_at TEXT, updated_at TEXT NOT NULL
    );
  `);
  const insertRun = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertRun.run(bare(ROOT), 'feature-dev-merge-worktree', rootStatus, fixture.schedulingStatus ?? null, STARTED_AT, STARTED_AT, TERMINAL_AT);
  insertRun.run(bare(CHILD), 'feature-dev-merge-worktree', childStatus, null, STARTED_AT, STARTED_AT, TERMINAL_AT);
  const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of [rootStep, childStep]) insertStep.run(...Object.values(row));
  db.close();
  fs.chmodSync(databasePath, 0o400);

  const events = [];
  if (!fixture.omitRootEvent && ['completed', 'failed', 'canceled'].includes(rootStatus)) {
    events.push({ archive: 'all.jsonl', line: 1, event: { ts: TERMINAL_AT, event: `run.${rootStatus}`, runId: ROOT } });
  }
  if (['completed', 'failed', 'canceled'].includes(childStatus)) {
    events.push({ archive: 'all.jsonl', line: 2, event: { ts: TERMINAL_AT, event: `run.${childStatus}`, runId: CHILD } });
  }
  if (fixture.healthyStraggler) {
    events.push({ archive: 'all.jsonl', line: 3, event: { ts: '2026-08-01T12:09:50.000Z', event: 'run.tokens.updated', runId: CHILD, workflowId: 'feature-dev-merge-worktree', tokenDelta: 1, tokensSpent: 1 } });
  }
  const workflow = {
    schema_version: 1,
    captured_at: CAPTURED_AT,
    root: {
      run_id: ROOT,
      terminal_status: fixture.workflowRootStatus ?? rootAttempt.terminal_status,
      tokens_observed: 1,
      steps_snapshot: rootAttempt.steps_snapshot,
    },
    discovered_runs: [{
      run_id: CHILD,
      parent_run_id: ROOT,
      terminal_status: childAttempt.terminal_status,
      tokens_observed: 1,
      steps_snapshot: childAttempt.steps_snapshot,
    }],
  };

  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED_AT, run_ids: [ROOT, CHILD], rows: events,
  });
  references.workflow_status = writeSnapshot(campaign, snapshots, 'workflow-status.json', workflow);

  const context = {
    contract_version: 1,
    oracle_id: 'O1',
    campaign: { id: `campaign-${fixture.name}`, created_at: STARTED_AT, manifest: { sha256: 'a'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: {
      id: fixture.name, wave: 4, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: 'hermes',
      class: 'verification', caps: { tokens: 10, wall_min: 60 }, boundary_files: [], forbidden: [],
      chaos: fixture.healthyStraggler ? { healthy_straggler: { policy: 'hermes-storm', run_ids: [CHILD], recent_within_ms: 300000 } } : null,
    },
    run_id: ROOT,
    attempts: fixture.historicalAttempt ? [attempt(PRIOR, 'failed', [step(PRIOR, { status: 'failed' })]), rootAttempt] : [rootAttempt],
    discovered_runs: [fixture.healthyStraggler ? {
      ...childAttempt,
      straggler_capture: {
        captured_at: '2026-08-01T12:09:55.000Z',
        stop_intent_at: '2026-08-01T12:09:55.000Z',
        reason: { cap: 'wall_min', threshold: 60, observed: 60 },
        steps_snapshot: { source: 'workflow-status-json', captured_at: '2026-08-01T12:09:55.000Z', steps: [projectedStep(childStep)] },
      },
    } : childAttempt],
    o1_wave: {
      schema_version: 1,
      wave: 4,
      duration_floors: fixture.omitWaveProjection ? [] : [
        ...(fixture.omitDurationFloor ? [] : [{ workflow: 'feature-dev-merge-worktree', duration_floor_ms: fixture.missingDurationFloor ? null : 300000, source: fixture.missingDurationFloor ? 'unavailable' : 'production-median', sample_size: 0 }]),
        ...(fixture.duplicateDurationFloor ? [{ workflow: 'feature-dev-merge-worktree', duration_floor_ms: 300000, source: 'production-median', sample_size: 0 }] : []),
        ...(fixture.unknownDurationFloor ? [{ workflow: 'unknown-workflow', duration_floor_ms: 300000, source: 'production-median', sample_size: 0 }] : []),
      ],
      runs: fixture.omitWaveProjection ? [] : [
        { case_id: fixture.name, run_id: ROOT, workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: rootAttempt.terminal_at, terminal_status: fixture.mismatchedWaveRun ? 'failed' : rootAttempt.terminal_status, expected_fast_failure: false },
        { case_id: fixture.name, run_id: CHILD, workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: childAttempt.terminal_at, terminal_status: childAttempt.terminal_status, expected_fast_failure: false },
        ...(fixture.historicalAttempt ? [{ case_id: fixture.name, run_id: PRIOR, workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: 'failed', expected_fast_failure: false }] : []),
        ...(fixture.duplicateWaveRun ? [{ case_id: fixture.name, run_id: ROOT, workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: rootAttempt.terminal_at, terminal_status: rootAttempt.terminal_status, expected_fast_failure: false }] : []),
        ...(fixture.unknownWaveRun ? [{ case_id: fixture.name, run_id: 'run-unknown', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: 'completed', expected_fast_failure: false }] : []),
        { case_id: 'wave-peer-1', run_id: 'run-wave-peer-1', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: fixture.fastWave ? '2026-08-01T12:00:40.000Z' : TERMINAL_AT, terminal_status: 'completed', expected_fast_failure: false },
        { case_id: 'wave-peer-2', run_id: 'run-wave-peer-2', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: 'completed', expected_fast_failure: false },
        { case_id: 'wave-peer-3', run_id: 'run-wave-peer-3', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: 'completed', expected_fast_failure: false },
        { case_id: 'wave-peer-4', run_id: 'run-wave-peer-4', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: 'completed', expected_fast_failure: false },
        ...(fixture.excludedFast ? [{ case_id: 'wave-fast-failure', run_id: 'run-wave-fast-failure', workflow: 'feature-dev-merge-worktree', started_at: STARTED_AT, terminal_at: '2026-08-01T12:00:10.000Z', terminal_status: 'failed', expected_fast_failure: true }] : []),
      ],
    },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}

function writeSnapshot(campaign, directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture');
}

function reference(campaign, file, source) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    captured_at: CAPTURED_AT,
    source,
  };
}
