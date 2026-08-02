import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'canceled']);
const TERMINAL_STEP_STATUSES = new Set(['done', 'failed', 'canceled']);
const UNADMITTED_STATUSES = new Set([null, 'pending_register', 'queued']);
const MAX_UNADMITTED_MS = 5 * 60 * 1000;
const HEALTHY_STRAGGLER_POLICY = 'hermes-storm';
const RECENT_ROUND_EVENT = 'run.tokens.updated';
const MAX_FAST_RATE = 0.2;

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an array`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') throw new OracleRuntimeError(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed.valueOf();
}

function databaseTimestamp(value, label) {
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}.000Z`
    : value;
  return timestamp(normalized, label);
}

function readJson(file, label) {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), label);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}

function canonicalRunId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError('run ID must be nonempty');
  return value.startsWith('run-') ? value : `run-${value}`;
}

function databaseRunId(value) {
  const canonical = canonicalRunId(value);
  return canonical.slice(4);
}

function databaseStepId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError('step ID must be nonempty');
  return value.startsWith('step-') ? value.slice(5) : value;
}

function valueOf(row, camel, snake) {
  return row[camel] ?? row[snake] ?? null;
}

function displayStatus(step) {
  return step.type === 'loop' && step.status === 'running' && step.current_story_id === null
    ? 'verifying'
    : step.status;
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function requireColumns(database, table, required) {
  const present = columns(database, table);
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) throw new OracleRuntimeError(`${table} snapshot lacks required columns: ${missing.join(', ')}`);
}

function readDatabase(database) {
  requireColumns(database, 'runs', [
    'id', 'workflow_id', 'status', 'scheduling_status', 'scheduling_requested_at', 'created_at', 'updated_at',
  ]);
  requireColumns(database, 'steps', [
    'run_id', 'step_id', 'agent_id', 'step_index', 'status', 'type', 'current_story_id',
    'claim_pid', 'claim_updated_at', 'updated_at',
  ]);
  const runs = database.prepare(`
    SELECT id, workflow_id, status, scheduling_status, scheduling_requested_at, created_at, updated_at
    FROM runs ORDER BY id
  `).all();
  const steps = database.prepare(`
    SELECT run_id, step_id, agent_id, step_index, status, type, current_story_id,
           claim_pid, claim_updated_at, updated_at
    FROM steps ORDER BY run_id, step_index, step_id
  `).all();
  return { runs, steps };
}

function readEvents(file) {
  const artifact = readJson(file, 'run_events');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('run_events schema_version must be 1');
  timestamp(artifact.captured_at, 'run_events.captured_at');
  return array(artifact.rows, 'run_events.rows').map((row, index) => {
    const wrapped = object(row, `run_events.rows[${index}]`);
    return object(wrapped.event, `run_events.rows[${index}].event`);
  });
}

function readWorkflowStatus(file) {
  const artifact = readJson(file, 'workflow_status');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('workflow_status schema_version must be 1');
  const capturedAt = timestamp(artifact.captured_at, 'workflow_status.captured_at');
  const root = object(artifact.root, 'workflow_status.root');
  const discovered = array(artifact.discovered_runs, 'workflow_status.discovered_runs');
  return { capturedAt, rows: [root, ...discovered.map((row, index) => object(row, `workflow_status.discovered_runs[${index}]`))] };
}

function terminalEventPresent(events, runId, status) {
  const expected = `run.${status}`;
  return events.some((event) => {
    const eventRunId = event.runId ?? event.run_id;
    return typeof eventRunId === 'string'
      && canonicalRunId(eventRunId) === runId
      && (event.event ?? event.type) === expected;
  });
}

function recentTokenEvent(events, runId, workflowId, captureMs, recentMs) {
  return events.some((event) => {
    const eventRunId = event.runId ?? event.run_id;
    if (typeof eventRunId !== 'string'
        || canonicalRunId(eventRunId) !== runId
        || (event.event ?? event.type) !== RECENT_ROUND_EVENT
        || (event.workflowId ?? event.workflow_id) !== workflowId
        || !Number.isSafeInteger(event.tokenDelta) || event.tokenDelta <= 0
        || !Number.isSafeInteger(event.tokensSpent) || event.tokensSpent < event.tokenDelta) return false;
    try {
      const at = timestamp(event.ts, `${RECENT_ROUND_EVENT}.ts`);
      return at <= captureMs && captureMs - at <= recentMs;
    } catch {
      return false;
    }
  });
}

function healthyStraggler(context, projected, runId, run, steps, events) {
  const declared = context.case.chaos?.healthy_straggler;
  const capture = projected.straggler_capture;
  if (context.case.harness !== 'hermes'
      || declared?.policy !== HEALTHY_STRAGGLER_POLICY
      || !Array.isArray(declared.run_ids)
      || !declared.run_ids.includes(runId)
      || !Number.isSafeInteger(declared.recent_within_ms)
      || declared.recent_within_ms <= 0
      || declared.recent_within_ms > MAX_UNADMITTED_MS
      || run.status !== 'canceled'
      || capture === null) return false;
  const captureMs = timestamp(capture.captured_at, 'straggler_capture.captured_at');
  const capturedSteps = capture.steps_snapshot.steps;
  const live = capturedSteps.find((step) => {
    const stepId = databaseStepId(valueOf(step, 'stepId', 'step_id'));
    const dbStep = steps.find((candidate) => candidate.step_id === stepId);
    const claimPid = valueOf(step, 'claimPid', 'claim_pid');
    const claimUpdatedAt = valueOf(step, 'claimUpdatedAt', 'claim_updated_at');
    if (dbStep === undefined || step.status !== 'running' || !Number.isSafeInteger(claimPid) || claimPid <= 0 || typeof claimUpdatedAt !== 'string') return false;
    const claimAt = timestamp(claimUpdatedAt, `step ${stepId} captured claim_updated_at`);
    return claimAt <= captureMs && captureMs - claimAt <= declared.recent_within_ms;
  });
  if (live === undefined) return false;
  return recentTokenEvent(events, runId, run.workflow_id, captureMs, declared.recent_within_ms);
}

function evaluateDurationFloor(findings, wave) {
  const observations = [];
  const launchedWorkflows = [...new Set(wave.runs.map((run) => run.workflow))].sort();
  const floorsByWorkflow = new Map();
  for (const floor of wave.duration_floors) {
    const matching = floorsByWorkflow.get(floor.workflow) ?? [];
    matching.push(floor);
    floorsByWorkflow.set(floor.workflow, matching);
  }
  for (const workflow of [...floorsByWorkflow.keys()].sort()) {
    if (!launchedWorkflows.includes(workflow)) {
      findings.add('O1_DURATION_FLOOR_UNKNOWN', 'wave contains a duration floor for a workflow family that was not launched', {
        wave: wave.wave, workflow,
      });
    }
  }
  for (const workflow of launchedWorkflows) {
    const floors = floorsByWorkflow.get(workflow) ?? [];
    const eligible = wave.runs.filter((run) => run.workflow === workflow && !run.expected_fast_failure);
    if (floors.length === 0) {
      findings.add('O1_DURATION_FLOOR_MISSING', 'wave omits the duration floor row for a launched workflow family', {
        wave: wave.wave, workflow,
      });
      observations.push({ workflow, duration_floor_ms: null, source: 'omitted', run_count: eligible.length, fast_run_count: null });
      continue;
    }
    if (floors.length > 1) {
      findings.add('O1_DURATION_FLOOR_DUPLICATE', 'wave contains duplicate duration floor rows for a launched workflow family', {
        wave: wave.wave, workflow, row_count: floors.length,
      });
      observations.push({ workflow, duration_floor_ms: null, source: 'duplicate', run_count: eligible.length, fast_run_count: null });
      continue;
    }
    const [floor] = floors;
    if (eligible.length === 0) continue;
    if (floor.duration_floor_ms === null) {
      findings.add('O1_DURATION_FLOOR_MISSING', 'wave lacks a W1 or production duration floor for a launched workflow family', {
        wave: wave.wave, workflow: floor.workflow,
      });
      observations.push({ workflow: floor.workflow, duration_floor_ms: null, source: floor.source, run_count: eligible.length, fast_run_count: null });
      continue;
    }
    const fast = eligible.filter((run) => run.terminal_at !== null
      && timestamp(run.terminal_at, `o1_wave run ${run.run_id} terminal_at`)
        - timestamp(run.started_at, `o1_wave run ${run.run_id} started_at`) < floor.duration_floor_ms);
    const rate = fast.length / eligible.length;
    if (rate > MAX_FAST_RATE) {
      findings.add('O1_DURATION_FLOOR_RATE', 'more than 20% of a wave workflow family terminated below its measured duration floor', {
        wave: wave.wave,
        workflow: floor.workflow,
        duration_floor_ms: floor.duration_floor_ms,
        source: floor.source,
        run_count: eligible.length,
        fast_run_count: fast.length,
        fast_rate: rate,
        run_ids: fast.map((run) => run.run_id).sort(),
      });
    }
    observations.push({
      workflow: floor.workflow,
      duration_floor_ms: floor.duration_floor_ms,
      source: floor.source,
      run_count: eligible.length,
      fast_run_count: fast.length,
      fast_rate: rate,
    });
  }
  return observations;
}

function evaluateWaveRunCoverage(findings, context) {
  const launched = [
    ...context.attempts.filter((attempt) => attempt.run_id !== null),
    ...context.discovered_runs,
  ];
  const launchedById = new Map(launched.map((projected) => [canonicalRunId(projected.run_id), projected]));
  const rowsByRun = new Map();
  for (const row of context.o1_wave.runs) {
    const runId = canonicalRunId(row.run_id);
    const matches = rowsByRun.get(runId) ?? [];
    matches.push(row);
    rowsByRun.set(runId, matches);
    if (row.case_id === context.case.id && !launchedById.has(runId)) {
      findings.add('O1_WAVE_RUN_UNKNOWN', 'wave projection contains a current-case run absent from root attempts and discovered runs', {
        wave: context.o1_wave.wave,
        case_id: context.case.id,
        run_id: runId,
      });
    }
  }
  for (const [runId, rows] of [...rowsByRun.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (rows.length > 1) {
      findings.add('O1_WAVE_RUN_DUPLICATE', 'wave projection contains duplicate rows for a launched run', {
        wave: context.o1_wave.wave,
        run_id: runId,
        row_count: rows.length,
        case_ids: rows.map((row) => row.case_id).sort(),
      });
    }
  }
  for (const projected of launched) {
    const runId = canonicalRunId(projected.run_id);
    const matches = (rowsByRun.get(runId) ?? []).filter((run) => run.case_id === context.case.id);
    if (matches.length === 0) {
      findings.add('O1_WAVE_RUN_MISSING', 'wave projection omits a launched root or discovered run', {
        wave: context.o1_wave.wave,
        case_id: context.case.id,
        run_id: runId,
      });
      continue;
    }
    const [row] = matches;
    const expected = {
      workflow: context.case.workflow,
      started_at: projected.started_at,
      terminal_at: projected.terminal_at,
      terminal_status: projected.terminal_status,
    };
    const observed = {
      workflow: row.workflow,
      started_at: row.started_at,
      terminal_at: row.terminal_at,
      terminal_status: row.terminal_status,
    };
    if (Object.keys(expected).some((key) => expected[key] !== observed[key])) {
      findings.add('O1_WAVE_RUN_MISMATCH', 'wave projection disagrees with the launched run projection', {
        wave: context.o1_wave.wave,
        case_id: context.case.id,
        run_id: runId,
        expected,
        observed,
      });
    }
  }
}

function addFinding(findings, id, summary, runId, details = {}) {
  findings.add(id, summary, { run_id: runId, ...details });
}

function compareWorkflow(findings, runId, run, steps, workflowRow) {
  if (workflowRow === undefined) {
    addFinding(findings, 'O1_WORKFLOW_STATUS_MISSING', 'workflow-status evidence omitted a discovered run', runId);
    return;
  }
  const observedStatus = workflowRow.terminal_status;
  const expectedStatus = TERMINAL_RUN_STATUSES.has(run.status) ? run.status : null;
  if (observedStatus !== expectedStatus) {
    addFinding(findings, 'O1_WORKFLOW_DB_STATUS_MISMATCH', 'workflow-status and DB run status disagree at terminal capture', runId, {
      expected: expectedStatus, observed: observedStatus,
    });
  }
  const snapshot = workflowRow.steps_snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.steps)) {
    addFinding(findings, 'O1_WORKFLOW_STEPS_MISSING', 'workflow-status evidence omitted the step snapshot', runId);
    return;
  }
  const projected = new Map(snapshot.steps.map((step) => [databaseStepId(valueOf(step, 'stepId', 'step_id')), step]));
  for (const step of steps) {
    const observed = projected.get(step.step_id);
    if (observed === undefined) {
      addFinding(findings, 'O1_WORKFLOW_STEP_MISSING', 'workflow-status evidence omitted a DB step', runId, { step_id: step.step_id });
      continue;
    }
    if (observed.status !== step.status) {
      addFinding(findings, 'O1_WORKFLOW_DB_STEP_STATUS_MISMATCH', 'workflow-status raw step status disagrees with DB', runId, {
        step_id: step.step_id, expected: step.status, observed: observed.status,
      });
    }
    const observedDisplay = valueOf(observed, 'displayStatus', 'display_status');
    if (observedDisplay !== null && observedDisplay !== displayStatus(step)) {
      addFinding(findings, 'O1_DISP_STATUS_MISMATCH', 'workflow-status display status violates the DISP mapping', runId, {
        step_id: step.step_id, expected: displayStatus(step), observed: observedDisplay,
      });
    }
  }
  for (const stepId of projected.keys()) {
    if (!steps.some((step) => step.step_id === stepId)) {
      addFinding(findings, 'O1_WORKFLOW_STEP_UNKNOWN', 'workflow-status evidence contains a step absent from the DB', runId, { step_id: stepId });
    }
  }
}

export function evaluateO1(invocation) {
  const findings = new FindingCollector();
  const database = openEvidenceDatabase(invocation);
  let snapshot;
  try {
    snapshot = readDatabase(database);
  } finally {
    database.close();
  }
  const events = readEvents(invocation.evidencePaths.run_events);
  const workflow = readWorkflowStatus(invocation.evidencePaths.workflow_status);
  const currentRoot = invocation.context.run_id === null
    ? null
    : invocation.context.attempts.findLast((attempt) => attempt.run_id === invocation.context.run_id);
  if (invocation.context.run_id !== null && currentRoot === undefined) {
    throw new OracleRuntimeError('context run_id has no matching root attempt projection');
  }
  const contextRuns = [
    ...(currentRoot === null ? [] : [currentRoot]),
    ...invocation.context.discovered_runs,
  ];
  const uniqueContextRuns = new Map();
  for (const projected of contextRuns) {
    const runId = canonicalRunId(projected.run_id);
    if (uniqueContextRuns.has(runId)) throw new OracleRuntimeError(`duplicate run ${runId} in O1 context graph`);
    uniqueContextRuns.set(runId, projected);
  }
  const workflowRows = new Map();
  for (const row of workflow.rows) {
    const runId = canonicalRunId(row.run_id);
    if (workflowRows.has(runId)) throw new OracleRuntimeError(`duplicate run ${runId} in workflow_status`);
    workflowRows.set(runId, row);
  }

  const observations = [];
  let stragglerCount = 0;
  evaluateWaveRunCoverage(findings, invocation.context);
  const durationFloorObservations = evaluateDurationFloor(findings, invocation.context.o1_wave);
  for (const [runId, projected] of [...uniqueContextRuns.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const dbId = databaseRunId(runId);
    const run = snapshot.runs.find((candidate) => candidate.id === dbId || canonicalRunId(candidate.id) === runId);
    if (run === undefined) {
      addFinding(findings, 'O1_DB_RUN_MISSING', 'context run graph contains a run absent from the DB snapshot', runId);
      observations.push({ run_id: runId, db_status: null, healthy_straggler: false, step_statuses: [] });
      continue;
    }
    const steps = snapshot.steps.filter((step) => step.run_id === run.id);
    const allowedStraggler = healthyStraggler(invocation.context, projected, runId, run, steps, events);
    if (allowedStraggler) stragglerCount += 1;

    if (!TERMINAL_RUN_STATUSES.has(run.status) && !allowedStraggler) {
      addFinding(findings, 'O1_RUN_NONTERMINAL', 'run graph did not converge to a terminal state', runId, { observed: run.status });
    }
    if (run.status === 'completed') {
      for (const step of steps.filter((candidate) => !TERMINAL_STEP_STATUSES.has(candidate.status))) {
        addFinding(findings, 'O1_COMPLETED_STEP_NONTERMINAL', 'completed run retains a nonterminal step', runId, {
          step_id: step.step_id, observed: step.status,
        });
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status) && !terminalEventPresent(events, runId, run.status)) {
      addFinding(findings, 'O1_TERMINAL_EVENT_MISSING', 'terminal DB run lacks its matching terminal event', runId, {
        expected: `run.${run.status}`,
      });
    }
    if (run.scheduling_status === 'error') {
      addFinding(findings, 'O1_SCHEDULING_ERROR', 'run remains in scheduling_status=error', runId);
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status) && UNADMITTED_STATUSES.has(run.scheduling_status) && !allowedStraggler) {
      const requestedAt = databaseTimestamp(run.scheduling_requested_at ?? run.created_at, `run ${runId} scheduling timestamp`);
      if (workflow.capturedAt - requestedAt > MAX_UNADMITTED_MS) {
        addFinding(findings, 'O1_RUN_UNADMITTED', 'run remained unadmitted for more than five minutes', runId, {
          observed: run.scheduling_status, age_ms: workflow.capturedAt - requestedAt,
        });
      }
    }
    const projectedStatus = projected.terminal_status;
    const expectedProjected = TERMINAL_RUN_STATUSES.has(run.status) ? run.status : null;
    if (projectedStatus !== expectedProjected) {
      addFinding(findings, 'O1_CONTEXT_DB_STATUS_MISMATCH', 'controller run projection and DB status disagree', runId, {
        expected: expectedProjected, observed: projectedStatus,
      });
    }
    compareWorkflow(findings, runId, run, steps, workflowRows.get(runId));
    observations.push({
      run_id: runId,
      db_status: run.status,
      scheduling_status: run.scheduling_status,
      healthy_straggler: allowedStraggler,
      step_statuses: steps.map((step) => ({ step_id: step.step_id, status: step.status })).sort((left, right) => left.step_id.localeCompare(right.step_id)),
    });
  }
  for (const runId of [...workflowRows.keys()].sort()) {
    if (!uniqueContextRuns.has(runId)) {
      addFinding(findings, 'O1_WORKFLOW_RUN_UNKNOWN', 'workflow-status evidence contains a run absent from the controller graph', runId);
    }
  }

  const evidence = [writeEvidenceJson(invocation, 'o1-terminal-state.json', {
    schema_version: 1,
    captured_at: new Date(workflow.capturedAt).toISOString(),
    runs: observations,
    duration_floor_observations: durationFloorObservations,
  }, 'sqlite-events-workflow-status')];
  const result = findings.length === 0 ? 'PASS' : 'FAIL';
  return {
    result,
    findings: findings.toJSON(),
    evidence,
    classification: result === 'PASS' && stragglerCount > 0
      ? { ambiguous: { category: 'HEALTHY_STRAGGLER' } }
      : undefined,
  };
}
