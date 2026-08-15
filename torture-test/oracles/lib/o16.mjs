import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';

// E3.C lifecycle probe-evidence oracle (US-009). O16 judges the probe
// sequencer's per-action evidence (probe_evidence) against the run event
// stream (run_events) and the terminal database snapshot (database_snapshot)
// for the five lifecycle dimensions the tier-1 cases declare:
//
//   * W3.18 pause (no drain): NO dispatch round may fire while the run is
//     paused during the hold window (no_rounds_during_hold).
//   * W3.19 pause --drain: the in-flight story step may complete, but the
//     next story must stay parked — no dispatch event may fire between the
//     drain completing and the resume (drain_waits_current + next_story_parked
//     + no draining_pause wedge: the run must reach completed after resume).
//   * W3.20 cancel: every cancel action must land a run.canceled terminal
//     event on the event stream (canceled_terminal_event, CNEV).
//   * W3.21 fail --force: the resume after a force-fail must reuse the SAME
//     run id (same_run_id_resumes) — a completed run row under a DIFFERENT id
//     is the resumeWorkflow-reuses-run-id trap; the resumed run must also
//     reach completed (run_completes).
//   * W3.22 restart_daemon: every in-flight run must recover within the
//     declared dispatch-interval window with the token flush preserved
//     (recovery_within_dispatch_intervals + token_flush_preserved, DC8).
//
// Every verdict is derived from mechanical evidence only. The sequencer's own
// observed-effect excerpts are corroboration at most; the oracle re-reads the
// event stream and database snapshot independently. A probe sequence that
// carries no lifecycle op at all (no pause/pause_drain/resume/cancel/
// fail_force/restart_daemon action) is NOT_EVALUABLE — there is nothing for a
// lifecycle oracle to judge.

// Event names that prove a dispatch round spawned work for a run. When a run
// is paused (or draining with the next story parked), none of these may fire.
const DISPATCH_EVENT_NAMES = new Set(['dispatch.render.validated', 'step.running', 'step.started']);
const LIFECYCLE_OPS = new Set(['pause', 'pause_drain', 'resume', 'cancel', 'fail_force', 'restart_daemon']);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function canonicalRunId(value, label = 'run ID') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OracleRuntimeError(`${label} must be nonempty`);
  }
  return value.startsWith('run-') ? value : `run-${value}`;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new OracleRuntimeError(`${label} must be a non-negative safe integer`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).valueOf()) || new Date(value).toISOString() !== value) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be nonempty`);
  return value;
}

function readJson(file, label) {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), label);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}

function readArtifact(file, label) {
  const artifact = readJson(file, label);
  if (artifact.schema_version !== 1 || !Array.isArray(artifact.rows)) {
    throw new OracleRuntimeError(`${label} must be a schema-version 1 row artifact`);
  }
  timestamp(artifact.captured_at, `${label}.captured_at`);
  return artifact;
}

function validateAction(action, label) {
  object(action, label);
  nonempty(action.op, `${label}.op`);
  nonempty(action.trigger, `${label}.trigger`);
  if (action.armed_at !== null && action.armed_at !== undefined) timestamp(action.armed_at, `${label}.armed_at`);
  if (action.action_started_at !== null && action.action_started_at !== undefined) {
    timestamp(action.action_started_at, `${label}.action_started_at`);
  }
  if (action.action_ended_at !== null && action.action_ended_at !== undefined) {
    timestamp(action.action_ended_at, `${label}.action_ended_at`);
  }
  if (action.hold_started_at !== null && action.hold_started_at !== undefined) {
    timestamp(action.hold_started_at, `${label}.hold_started_at`);
  }
  if (action.hold_ended_at !== null && action.hold_ended_at !== undefined) {
    timestamp(action.hold_ended_at, `${label}.hold_ended_at`);
  }
  return action;
}

function readProbeEvidence(invocation) {
  const evidence = readJson(invocation.evidencePaths.probe_evidence, 'probe_evidence');
  if (evidence.schema_version !== 1) throw new OracleRuntimeError('probe_evidence.schema_version must be 1');
  nonempty(evidence.case_id, 'probe_evidence.case_id');
  if (evidence.started_at !== null && evidence.started_at !== undefined) {
    timestamp(evidence.started_at, 'probe_evidence.started_at');
  }
  if (evidence.ended_at !== null && evidence.ended_at !== undefined) {
    timestamp(evidence.ended_at, 'probe_evidence.ended_at');
  }
  const caseId = evidence.case_id;
  const launchShape = typeof evidence.launch_shape === 'string' ? evidence.launch_shape : null;
  if (Array.isArray(evidence.runs)) {
    // Multi-run shape (W3.20 sequential / W3.22 concurrent, US-007).
    const runs = evidence.runs.map((run, index) => {
      object(run, `probe_evidence.runs[${index}]`);
      const runOrdinal = integer(run.run_ordinal, `probe_evidence.runs[${index}].run_ordinal`);
      const runId = canonicalRunId(run.run_id, `probe_evidence.runs[${index}].run_id`);
      const actions = Array.isArray(run.actions)
        ? run.actions.map((action, actionIndex) => validateAction(action, `probe_evidence.runs[${index}].actions[${actionIndex}]`))
        : [];
      return { run_ordinal: runOrdinal, run_id: runId, actions, recovery: run.recovery ?? null };
    });
    const daemonRestarts = Array.isArray(evidence.daemon_restarts) ? evidence.daemon_restarts : [];
    return { shape: 'multi', case_id: caseId, launch_shape: launchShape, runs, daemon_restarts: daemonRestarts };
  }
  // Single-run shape (W3.18 / W3.19 / W3.21, US-006).
  const runId = canonicalRunId(evidence.run_id, 'probe_evidence.run_id');
  const runOrdinal = evidence.run_ordinal === undefined ? 1 : integer(evidence.run_ordinal, 'probe_evidence.run_ordinal');
  const actions = Array.isArray(evidence.actions)
    ? evidence.actions.map((action, index) => validateAction(action, `probe_evidence.actions[${index}]`))
    : [];
  return {
    shape: 'single',
    case_id: caseId,
    launch_shape: launchShape,
    runs: [{ run_ordinal: runOrdinal, run_id: runId, actions, recovery: null }],
    daemon_restarts: [],
  };
}

function readRunEvents(invocation) {
  const artifact = readArtifact(invocation.evidencePaths.run_events, 'run_events');
  const byRun = new Map();
  const rows = [];
  artifact.rows.forEach((raw, index) => {
    const row = object(raw, `run_events.rows[${index}]`);
    integer(row.line, `run_events.rows[${index}].line`);
    nonempty(row.archive, `run_events.rows[${index}].archive`);
    const event = object(row.event, `run_events.rows[${index}].event`);
    nonempty(event.event, `run_events.rows[${index}].event.event`);
    const normalized = { archive: row.archive, line: row.line, event };
    rows.push(normalized);
    const eventRunIdValue = event.runId ?? event.run_id ?? null;
    if (typeof eventRunIdValue === 'string' && eventRunIdValue.length > 0) {
      const runId = canonicalRunId(eventRunIdValue);
      const list = byRun.get(runId) ?? [];
      list.push(normalized);
      byRun.set(runId, list);
    }
  });
  return { captured_at: artifact.captured_at, byRun, rows };
}

function readDatabaseRuns(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").all();
    if (tableNames.length !== 1) throw new OracleRuntimeError('runs table is required');
    const columns = new Set(database.prepare('PRAGMA table_info(runs)').all().map((row) => row.name));
    const missing = ['id', 'status'].filter((name) => !columns.has(name));
    if (missing.length > 0) throw new OracleRuntimeError(`runs lacks required columns: ${missing.join(', ')}`);
    const hasRunNumber = columns.has('run_number');
    const select = hasRunNumber
      ? 'SELECT id, status, run_number FROM runs ORDER BY id'
      : 'SELECT id, status FROM runs ORDER BY id';
    const runs = database.prepare(select).all().map((row) => ({
      run_id: canonicalRunId(row.id),
      status: nonempty(row.status, `run ${row.id} status`),
      run_number: hasRunNumber && row.run_number !== null && row.run_number !== undefined
        ? integer(row.run_number, `run ${row.id} run_number`)
        : null,
    }));
    const byId = new Map(runs.map((run) => [run.run_id, run]));
    return { runs, byId };
  } finally {
    database.close();
  }
}

function eventsForRun(runId, byRun) {
  return byRun.get(runId) ?? [];
}

function eventsInWindow(runId, byRun, startIso, endIso) {
  const start = new Date(startIso).valueOf();
  const end = new Date(endIso).valueOf();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  return eventsForRun(runId, byRun).filter((row) => {
    if (typeof row.event.ts !== 'string') return false;
    const ts = new Date(row.event.ts).valueOf();
    return Number.isFinite(ts) && ts >= start && ts <= end;
  });
}

function dispatchEventsInWindow(runId, byRun, startIso, endIso) {
  return eventsInWindow(runId, byRun, startIso, endIso)
    .filter((row) => DISPATCH_EVENT_NAMES.has(row.event.event));
}

function addEventFinding(findings, id, summary, runId, rows) {
  for (const row of rows) {
    findings.add(id, summary, {
      run_id: runId,
      event: row.event.event,
      ts: row.event.ts,
      archive: row.archive,
      line: row.line,
    });
  }
}

// pause (no drain): no dispatch round may fire during the hold window.
function judgePauseHold(findings, runId, action, byRun) {
  if (action.op !== 'pause') return;
  const holdStart = action.hold_started_at;
  const holdEnd = action.hold_ended_at;
  if (typeof holdStart !== 'string' || typeof holdEnd !== 'string') {
    findings.add('O16_PAUSE_HOLD_MISSING', 'pause action lacks a hold window; pause-held semantics cannot be verified', {
      run_id: runId,
      op: action.op,
    });
    return;
  }
  addEventFinding(
    findings,
    'O16_ROUND_DURING_HOLD',
    'a dispatch round fired while the run was paused during the hold window',
    runId,
    dispatchEventsInWindow(runId, byRun, holdStart, holdEnd),
  );
}

// pause --drain: the in-flight story step may complete, but the next story
// must stay parked — no dispatch event between the drain completing
// (action_ended_at) and the next action firing (or the evidence ending).
function judgeDrain(findings, runId, action, nextAction, evidenceEndedAt, byRun) {
  if (action.op !== 'pause_drain') return;
  const windowStart = action.action_ended_at;
  const windowEnd = nextAction?.action_started_at ?? evidenceEndedAt;
  if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') return;
  addEventFinding(
    findings,
    'O16_DRAIN_DISPATCHED_NEXT_STORY',
    'pause --drain dispatched a step while the next story should be parked',
    runId,
    dispatchEventsInWindow(runId, byRun, windowStart, windowEnd),
  );
}

// cancel: a run.canceled terminal event must land after the cancel action.
function judgeCancel(findings, runId, action, byRun) {
  if (action.op !== 'cancel') return;
  const since = action.action_started_at;
  if (typeof since !== 'string') {
    findings.add('O16_CANCEL_EVIDENCE_INVALID', 'cancel action lacks an action_started_at; terminal-event timing cannot be verified', {
      run_id: runId,
      op: action.op,
    });
    return;
  }
  const landed = eventsForRun(runId, byRun).some((row) => row.event.event === 'run.canceled'
    && typeof row.event.ts === 'string' && row.event.ts >= since);
  if (!landed) {
    findings.add('O16_CANCEL_TERMINAL_EVENT_MISSING', 'cancel action did not land a run.canceled terminal event', {
      run_id: runId,
      op: action.op,
      since,
    });
  }
}

// resume: the probed run must reach completed (run_completes) — this also
// proves no draining_pause wedge after a pause --drain.
function judgeResumeCompleted(findings, runId, action, dbByRun) {
  if (action.op !== 'resume') return;
  const row = dbByRun.get(runId);
  if (row === undefined || row.status !== 'completed') {
    findings.add('O16_RESUME_RUN_NOT_COMPLETED', 'run did not reach completed status after resume', {
      run_id: runId,
      status: row?.status ?? null,
    });
  }
}

// fail --force followed by resume: the resume must reuse the SAME run id (the
// resumeWorkflow-reuses-run-id trap). A completed run row under a DIFFERENT id
// while the probed id did not complete is the new-run-id violation; the
// resumed run must also be completed (run_completes).
function judgeFailForceResume(findings, runId, action, nextAction, dbByRun, dbRuns) {
  if (action.op !== 'fail_force' || nextAction?.op !== 'resume') return;
  const row = dbByRun.get(runId);
  if (row !== undefined && row.status === 'completed') return;
  const completedOthers = dbRuns
    .filter((run) => run.run_id !== runId && run.status === 'completed')
    .map((run) => ({ run_id: run.run_id, run_number: run.run_number }));
  if (completedOthers.length > 0) {
    findings.add('O16_RESUME_NEW_RUN_ID', 'resume after fail --force completed a NEW run id instead of resuming the same run', {
      run_id: runId,
      status: row?.status ?? null,
      completed_other_run_ids: completedOthers,
    });
  }
}

// restart_daemon: every in-flight run must recover within the declared
// dispatch-interval window with the token flush preserved (DC8).
function judgeRestartRecovery(findings, runId, recovery) {
  if (recovery === null || typeof recovery !== 'object') {
    findings.add('O16_RESTART_RECOVERY_MISSING', 'restart_daemon recovery observation is missing for the run', {
      run_id: runId,
    });
    return;
  }
  const recovered = recovery.recovered === true;
  const withinIntervals = recovery.recovery_within_dispatch_intervals === true;
  const tokenFlushPreserved = recovery.token_flush_preserved === true;
  if (!recovered || !withinIntervals || !tokenFlushPreserved) {
    findings.add('O16_RESTART_RECOVERY_EXCEEDED', 'run did not recover within the declared dispatch intervals with token flush preserved', {
      run_id: runId,
      recovered,
      recovery_within_dispatch_intervals: withinIntervals,
      token_flush_preserved: tokenFlushPreserved,
      recovery_waited_ms: recovery.recovery_waited_ms ?? null,
      status_after: recovery.status_after ?? null,
    });
  }
}

function collectRecoveryObservations(probe) {
  const observations = [];
  const seen = new Set();
  const push = (runOrdinal, runId, recovery) => {
    if (recovery === null || recovery === undefined) return;
    const key = `${runOrdinal}\0${runId}\0${JSON.stringify(recovery)}`;
    if (seen.has(key)) return;
    seen.add(key);
    observations.push({ run_ordinal: runOrdinal, run_id: runId, recovery });
  };
  for (const run of probe.runs) {
    push(run.run_ordinal, run.run_id, run.recovery);
    for (const action of run.actions) {
      if (action.op === 'restart_daemon' && action.effect !== null && action.effect !== undefined) {
        push(run.run_ordinal, run.run_id, action.effect.recovery ?? null);
      }
    }
  }
  for (const restart of probe.daemon_restarts) {
    object(restart, 'probe_evidence.daemon_restarts[]');
    if (!Array.isArray(restart.recovery)) continue;
    for (const entry of restart.recovery) {
      object(entry, 'probe_evidence.daemon_restarts[].recovery[]');
      const entryRunId = entry.run_id !== undefined && entry.run_id !== null
        ? canonicalRunId(entry.run_id, 'probe_evidence.daemon_restarts[].recovery[].run_id')
        : null;
      if (entryRunId !== null) push(entry.run_ordinal ?? null, entryRunId, entry);
    }
  }
  return observations;
}

export function evaluateO16(invocation) {
  const findings = new FindingCollector();
  const probe = readProbeEvidence(invocation);
  const runEvents = readRunEvents(invocation);
  const database = readDatabaseRuns(invocation);

  let lifecycleOpCount = 0;
  for (const run of probe.runs) {
    for (const action of run.actions) {
      if (LIFECYCLE_OPS.has(action.op)) lifecycleOpCount += 1;
    }
  }
  if (lifecycleOpCount === 0 && probe.daemon_restarts.length === 0) {
    // Nothing for a lifecycle oracle to judge: the sequence carried no
    // lifecycle op. NOT_EVALUABLE (degraded judgment scope), never a guessed
    // PASS — per the version-1 NOT_EVALUABLE vocabulary.
    return {
      result: 'NOT_EVALUABLE',
      findings: [],
      evidence: [writeEvidenceJson(invocation, 'o16-lifecycle-probe.json', {
        schema_version: 1,
        captured_at: runEvents.captured_at,
        case_id: probe.case_id ?? null,
        scope: 'no-lifecycle-ops',
        runs: probe.runs.map((run) => ({ run_ordinal: run.run_ordinal, run_id: run.run_id, ops: run.actions.map((action) => action.op) })),
      }, 'lifecycle-probe-judgment')],
    };
  }

  const runObservations = [];
  for (const run of probe.runs) {
    const runId = run.run_id;
    const judgments = [];
    for (const [index, action] of run.actions.entries()) {
      const nextAction = run.actions[index + 1] ?? null;
      const before = findings.length;
      judgePauseHold(findings, runId, action, runEvents.byRun);
      judgeDrain(findings, runId, action, nextAction, probe.ended_at ?? probe.started_at, runEvents.byRun);
      judgeCancel(findings, runId, action, runEvents.byRun);
      judgeResumeCompleted(findings, runId, action, database.byId);
      judgeFailForceResume(findings, runId, action, nextAction, database.byId, database.runs);
      judgments.push({
        op: action.op,
        trigger: action.trigger,
        finding_count: findings.length - before,
      });
    }
    runObservations.push({
      run_ordinal: run.run_ordinal,
      run_id: runId,
      actions: judgments,
      recovery: run.recovery === null ? null : {
        recovered: run.recovery?.recovered ?? null,
        recovery_within_dispatch_intervals: run.recovery?.recovery_within_dispatch_intervals ?? null,
        token_flush_preserved: run.recovery?.token_flush_preserved ?? null,
        recovery_waited_ms: run.recovery?.recovery_waited_ms ?? null,
      },
    });
  }

  for (const observation of collectRecoveryObservations(probe)) {
    judgeRestartRecovery(findings, observation.run_id, observation.recovery);
  }

  const evidence = [writeEvidenceJson(invocation, 'o16-lifecycle-probe.json', {
    schema_version: 1,
    captured_at: runEvents.captured_at,
    case_id: probe.case_id ?? null,
    launch_shape: probe.launch_shape ?? (probe.shape === 'multi' ? 'multi' : 'single'),
    runs: runObservations,
    daemon_restart_count: probe.daemon_restarts.length,
    finding_ids: findings.toJSON().map((finding) => finding.id),
  }, 'lifecycle-probe-judgment')];
  return {
    result: findings.length === 0 ? 'PASS' : 'FAIL',
    findings: findings.toJSON(),
    evidence,
  };
}
