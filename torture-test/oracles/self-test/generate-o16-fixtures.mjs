#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O16 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_1 = 'run-11111111-1111-4111-8111-111111111111';
const RUN_2 = 'run-22222222-2222-4222-8222-222222222222';
const RUN_3 = 'run-33333333-3333-4333-8333-333333333333';
const RUN_A = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-08-01T12:00:00.000Z';
const CAPTURED = '2026-08-01T12:10:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];

// Timestamp helpers: T0-based offsets so fixture windows line up with the
// probe action records and the event stream.
function at(seconds) {
  return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

function action(op, trigger, overrides = {}) {
  return { op, trigger, ...overrides };
}

// A canonical pause action record (sequencer shape from US-006): armed at +1s,
// CLI at +1..2s, hold +2..12s (10s hold).
function pauseAction(holdSeconds = 10) {
  return action('pause', 'step:developer:running', {
    run_ordinal: 1,
    armed_at: at(1),
    action_started_at: at(1),
    action_ended_at: at(2),
    argv: ['tamandua', 'workflow', 'pause', RUN_A],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: holdSeconds,
    hold_started_at: at(2),
    hold_ended_at: at(12),
    effect: { status_after: { queried_at: at(13), status: 'paused', tokensSpent: 0, error: null }, events_excerpt: { events: [], truncated: false, unavailable: false } },
    ok: true,
  });
}

function resumeAction(startSeconds = 13) {
  return action('resume', 'now', {
    run_ordinal: 1,
    armed_at: at(startSeconds),
    action_started_at: at(startSeconds),
    action_ended_at: at(startSeconds + 1),
    argv: ['tamandua', 'workflow', 'resume', RUN_A],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: null,
    hold_started_at: null,
    hold_ended_at: null,
    effect: { status_after: { queried_at: at(startSeconds + 2), status: 'running', tokensSpent: 0, error: null }, events_excerpt: { events: [], truncated: false, unavailable: false } },
    ok: true,
  });
}

function pauseDrainAction() {
  return action('pause_drain', 'step:developer:running', {
    run_ordinal: 1,
    armed_at: at(1),
    action_started_at: at(1),
    action_ended_at: at(2),
    argv: ['tamandua', 'workflow', 'pause', RUN_A, '--drain'],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: null,
    hold_started_at: null,
    hold_ended_at: null,
    effect: { status_after: { queried_at: at(3), status: 'paused', tokensSpent: 0, error: null }, events_excerpt: { events: [], truncated: false, unavailable: false } },
    ok: true,
  });
}

function cancelAction() {
  return action('cancel', 'step:developer:running', {
    run_ordinal: 1,
    armed_at: at(1),
    action_started_at: at(1),
    action_ended_at: at(2),
    argv: ['tamandua', 'workflow', 'cancel', RUN_A],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: null,
    hold_started_at: null,
    hold_ended_at: null,
    effect: { status_after: { queried_at: at(3), status: 'canceled', tokensSpent: 0, error: null }, events_excerpt: { events: [], truncated: false, unavailable: false } },
    ok: true,
  });
}

function failForceAction() {
  return action('fail_force', 'step:developer:running', {
    run_ordinal: 1,
    armed_at: at(1),
    action_started_at: at(1),
    action_ended_at: at(2),
    argv: ['tamandua', 'workflow', 'fail', RUN_A, '--force'],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: null,
    hold_started_at: null,
    hold_ended_at: null,
    effect: { status_after: { queried_at: at(3), status: 'failed', tokensSpent: 0, error: null }, events_excerpt: { events: [], truncated: false, unavailable: false } },
    ok: true,
  });
}

function restartAction(runId, runOrdinal, recovery) {
  return action('restart_daemon', 'step:developer:running', {
    run_ordinal: runOrdinal,
    armed_at: at(3),
    action_started_at: at(3),
    action_ended_at: at(4),
    argv: ['daemon-control', 'real', 'restart'],
    exit_code: 0,
    signal: null,
    error: null,
    hold_seconds: null,
    effect: { recovery },
  });
}

function recoveryRecord(runOrdinal, runId, overrides = {}) {
  return {
    run_ordinal: runOrdinal,
    run_id: runId,
    recovered: true,
    recovered_at: at(9),
    recovery_waited_ms: 5000,
    recovery_within_dispatch_intervals: true,
    status_after: 'running',
    tokens_before_restart: 10,
    tokens_after_restart: 10,
    token_flush_preserved: true,
    ...overrides,
  };
}

function eventRow(runId, eventName, seconds, line, extra = {}) {
  return { archive: 'all.jsonl', line, event: { ts: at(seconds), event: eventName, runId, ...extra } };
}

const CASES = [
  {
    name: 'o16-green-pause-hold',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-pause-hold', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(15),
      actions: [pauseAction(), resumeAction()], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.paused', 2, 2),
      eventRow(runId, 'run.resumed', 13, 3),
      eventRow(runId, 'run.completed', 15, 4),
    ] }),
    runs: [[RUN_A, 'completed', 1]],
  },
  {
    name: 'o16-round-during-hold',
    expected: 'FAIL',
    finding: 'O16_ROUND_DURING_HOLD',
    probe: () => ({
      schema_version: 1, case_id: 'o16-round-during-hold', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(15),
      actions: [pauseAction(), resumeAction()], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.paused', 2, 2),
      // A dispatch round fired INSIDE the hold window [2s, 12s].
      eventRow(runId, 'dispatch.render.validated', 5, 3),
      eventRow(runId, 'run.resumed', 13, 4),
      eventRow(runId, 'run.completed', 15, 5),
    ] }),
    runs: [[RUN_A, 'completed', 1]],
  },
  {
    name: 'o16-green-drain',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-drain', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(15),
      actions: [pauseDrainAction(), resumeAction(5)], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.pause_requested', 1, 2),
      // In-flight story step completes while draining — allowed (drain_waits_current).
      eventRow(runId, 'step.done', 3, 3),
      eventRow(runId, 'run.resumed', 5, 4),
      eventRow(runId, 'run.completed', 7, 5),
    ] }),
    runs: [[RUN_A, 'completed', 1]],
  },
  {
    name: 'o16-drain-dispatched-next-story',
    expected: 'FAIL',
    finding: 'O16_DRAIN_DISPATCHED_NEXT_STORY',
    probe: () => ({
      schema_version: 1, case_id: 'o16-drain-dispatched-next-story', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(15),
      actions: [pauseDrainAction(), resumeAction(5)], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.pause_requested', 1, 2),
      eventRow(runId, 'step.done', 3, 3),
      // The NEXT story was dispatched while the drain held — violation.
      eventRow(runId, 'step.running', 4, 4),
      eventRow(runId, 'run.resumed', 5, 5),
      eventRow(runId, 'run.completed', 7, 6),
    ] }),
    runs: [[RUN_A, 'completed', 1]],
  },
  {
    name: 'o16-green-cancel',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-cancel', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(5),
      actions: [cancelAction()], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.canceled', 3, 2),
    ] }),
    runs: [[RUN_A, 'canceled', 1]],
  },
  {
    name: 'o16-cancel-terminal-event-missing',
    expected: 'FAIL',
    finding: 'O16_CANCEL_TERMINAL_EVENT_MISSING',
    probe: () => ({
      schema_version: 1, case_id: 'o16-cancel-terminal-event-missing', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(5),
      actions: [cancelAction()], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      // No run.canceled terminal event landed (CNEV never emitted).
      eventRow(runId, 'step.done', 3, 2),
    ] }),
    runs: [[RUN_A, 'canceled', 1]],
  },
  {
    name: 'o16-green-resume',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-resume', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(8),
      actions: [failForceAction(), resumeAction(3)], failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.force_failed', 2, 2),
      eventRow(runId, 'run.completed', 6, 3),
    ] }),
    runs: [[RUN_A, 'completed', 1]],
  },
  {
    name: 'o16-resume-new-run-id',
    expected: 'FAIL',
    finding: 'O16_RESUME_NEW_RUN_ID',
    probe: () => ({
      schema_version: 1, case_id: 'o16-resume-new-run-id', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(8),
      actions: [failForceAction(), resumeAction(3)], failure: null,
    }),
    events: (runId) => ({
      [runId]: [
        eventRow(runId, 'run.started', 0, 1),
        eventRow(runId, 'run.force_failed', 2, 2),
      ],
      // resumeWorkflow-reuses-run-id trap: a NEW run started instead of
      // resuming run A; the new run completed while run A stayed failed.
      [RUN_B]: [
        eventRow(RUN_B, 'run.started', 3, 3),
        eventRow(RUN_B, 'run.completed', 6, 4),
      ],
    }),
    runs: [[RUN_A, 'failed', 1], [RUN_B, 'completed', 2]],
  },
  {
    name: 'o16-green-restart',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-restart', execution_mode: 'real',
      launch_shape: 'concurrent', sequence_outcome: 'completed', started_at: START, ended_at: at(12),
      runs: [
        { run_ordinal: 1, run_id: RUN_1, run_id_source: 'launch', launch_hook: 'launch', actions: [restartAction(RUN_1, 1, recoveryRecord(1, RUN_1))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(1, RUN_1) },
        { run_ordinal: 2, run_id: RUN_2, run_id_source: 'launch', launch_hook: 'launch_2', actions: [restartAction(RUN_2, 2, recoveryRecord(2, RUN_2))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(2, RUN_2) },
        { run_ordinal: 3, run_id: RUN_3, run_id_source: 'launch', launch_hook: 'launch_3', actions: [restartAction(RUN_3, 3, recoveryRecord(3, RUN_3))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(3, RUN_3) },
      ],
      daemon_restarts: [{
        op: 'restart_daemon', trigger: 'step:developer:running', run_ordinal: 1,
        armed_at: at(3), action_started_at: at(3), action_ended_at: at(4),
        argv: ['daemon-control', 'real', 'restart'], exit_code: 0, signal: null, error: null,
        hold_seconds: null, kind: 'real',
        recovery: [recoveryRecord(1, RUN_1), recoveryRecord(2, RUN_2), recoveryRecord(3, RUN_3)],
      }],
      failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.completed', 11, 2),
    ] }),
    runs: [[RUN_1, 'completed', 1], [RUN_2, 'completed', 1], [RUN_3, 'completed', 1]],
  },
  {
    name: 'o16-restart-recovery-exceeded',
    expected: 'FAIL',
    finding: 'O16_RESTART_RECOVERY_EXCEEDED',
    probe: () => ({
      schema_version: 1, case_id: 'o16-restart-recovery-exceeded', execution_mode: 'real',
      launch_shape: 'concurrent', sequence_outcome: 'completed', started_at: START, ended_at: at(12),
      runs: [
        { run_ordinal: 1, run_id: RUN_1, run_id_source: 'launch', launch_hook: 'launch', actions: [restartAction(RUN_1, 1, recoveryRecord(1, RUN_1))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(1, RUN_1) },
        { run_ordinal: 2, run_id: RUN_2, run_id_source: 'launch', launch_hook: 'launch_2', actions: [restartAction(RUN_2, 2, recoveryRecord(2, RUN_2, { recovered: false, recovery_within_dispatch_intervals: false, recovery_waited_ms: 35000, status_after: null }))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(2, RUN_2, { recovered: false, recovery_within_dispatch_intervals: false, recovery_waited_ms: 35000, status_after: null }) },
        { run_ordinal: 3, run_id: RUN_3, run_id_source: 'launch', launch_hook: 'launch_3', actions: [restartAction(RUN_3, 3, recoveryRecord(3, RUN_3))], terminal_status: 'completed', wait_exit_code: 0, recovery: recoveryRecord(3, RUN_3) },
      ],
      daemon_restarts: [{
        op: 'restart_daemon', trigger: 'step:developer:running', run_ordinal: 1,
        armed_at: at(3), action_started_at: at(3), action_ended_at: at(4),
        argv: ['daemon-control', 'real', 'restart'], exit_code: 0, signal: null, error: null,
        hold_seconds: null, kind: 'real',
        recovery: [recoveryRecord(1, RUN_1), recoveryRecord(2, RUN_2, { recovered: false, recovery_within_dispatch_intervals: false, recovery_waited_ms: 35000, status_after: null }), recoveryRecord(3, RUN_3)],
      }],
      failure: null,
    }),
    events: (runId) => ({ [runId]: [
      eventRow(runId, 'run.started', 0, 1),
      eventRow(runId, 'run.completed', 11, 2),
    ] }),
    runs: [[RUN_1, 'completed', 1], [RUN_2, 'completed', 1], [RUN_3, 'completed', 1]],
  },
  {
    name: 'o16-green-multi-cancel',
    expected: 'PASS',
    probe: () => ({
      schema_version: 1, case_id: 'o16-green-multi-cancel', execution_mode: 'real',
      launch_shape: 'sequential', sequence_outcome: 'completed', started_at: START, ended_at: at(8),
      runs: [
        { run_ordinal: 1, run_id: RUN_A, run_id_source: 'launch', launch_hook: 'launch', actions: [{ ...cancelAction(), run_ordinal: 1 }], terminal_status: 'canceled', wait_exit_code: 3, recovery: null },
        { run_ordinal: 2, run_id: RUN_B, run_id_source: 'launch', launch_hook: 'launch_2', actions: [{ ...cancelAction(), run_ordinal: 2, argv: ['tamandua', 'workflow', 'cancel', RUN_B] }], terminal_status: 'canceled', wait_exit_code: 3, recovery: null },
      ],
      daemon_restarts: [],
      failure: null,
    }),
    events: () => ({
      [RUN_A]: [
        eventRow(RUN_A, 'run.started', 0, 1),
        eventRow(RUN_A, 'run.canceled', 3, 2),
      ],
      [RUN_B]: [
        eventRow(RUN_B, 'run.started', 0, 1),
        eventRow(RUN_B, 'run.canceled', 3, 2),
      ],
    }),
    runs: [[RUN_A, 'canceled', 1], [RUN_B, 'canceled', 1]],
  },
  {
    name: 'o16-no-lifecycle-ops',
    expected: 'NOT_EVALUABLE',
    probe: () => ({
      schema_version: 1, case_id: 'o16-no-lifecycle-ops', run_id: RUN_A, run_ordinal: 1,
      execution_mode: 'real', sequence_outcome: 'completed', started_at: START, ended_at: at(5),
      // A chaos-style sequence with only the harness-injection verb — no
      // lifecycle op for O16 to judge.
      actions: [action('sigstop_sigcont', 'step:developer:running', {
        run_ordinal: 1, armed_at: at(1), action_started_at: at(1), action_ended_at: at(2),
        argv: ['tt-chaos', 'sigstop_sigcont', '--run', RUN_A, '--when', 'step:developer:running', '--hold-seconds', '600'],
        exit_code: 0, signal: null, error: null, hold_seconds: 600,
        hold_started_at: at(2), hold_ended_at: at(12),
        effect: null, ok: true,
      })],
      failure: null,
    }),
    events: () => ({ [RUN_A]: [eventRow(RUN_A, 'run.started', 0, 1)] }),
    runs: [[RUN_A, 'completed', 1]],
  },
];

function bare(runId) { return runId.slice(4); }

function attempt(runId, executionMode, status) {
  return {
    id: `attempt-${bare(runId)[0]}`, kind: 'workflow', phase: 'terminal', execution_mode: executionMode,
    run_id: runId, started_at: START, terminal_at: at(15), terminal_status: status,
    tokens_observed: 0, command_result: { exit_code: status === 'completed' ? 0 : 1, signal: null },
    steps_snapshot: null, straggler_capture: null,
  };
}

function reference(campaign, file, source) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    captured_at: CAPTURED,
    source,
  };
}

function writeSnapshot(campaign, snapshots, name, value) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture');
}

for (const fixture of CASES) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidence = path.join(campaign, 'evidence');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  const probe = fixture.probe();
  const eventsByRun = fixture.events(probe.runs?.[0]?.run_id ?? probe.run_id);
  const events = Object.entries(eventsByRun)
    .flatMap(([, rows]) => rows)
    .map((row, index) => ({ ...row, line: index + 1 }));

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER NOT NULL, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE stories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);`);
  const insertRun = database.prepare('INSERT INTO runs (id, run_number, status, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [runId, status, runNumber] of fixture.runs) {
    insertRun.run(bare(runId), runNumber, status, 0, START, at(15));
  }
  database.prepare('INSERT INTO tamandua_stats VALUES (1, 0)').run();
  database.close();
  fs.chmodSync(databasePath, 0o400);

  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED, run_ids: fixture.runs.map(([runId]) => runId).sort(), rows: events,
  });
  references.probe_evidence = writeSnapshot(campaign, snapshots, 'probe-evidence.json', probe);

  const primaryRunId = probe.runs?.[0]?.run_id ?? probe.run_id ?? RUN_A;
  const context = {
    contract_version: 1, oracle_id: 'O16',
    campaign: { id: `campaign-${fixture.name}`, created_at: START, manifest: { sha256: '2'.repeat(64), case_count: 1, case_ids: [fixture.name] } },
    case: { id: fixture.name, wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts', harness: 'pi', class: 'verification', caps: { tokens: 500000, wall_min: 148 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: primaryRunId,
    attempts: [attempt(primaryRunId, 'real', fixture.runs.find(([runId]) => runId === primaryRunId)?.[1] ?? 'completed')],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 3, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidence, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
}
