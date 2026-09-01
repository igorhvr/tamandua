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
const MIN_FLOOR_RATE_SAMPLE = 4;

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

// Deterministic reporter for the campaign-wide (family-level) duration-floor
// findings of a wave: the TRUE FINAL wave case in campaign.manifest.case_ids
// order (max manifest rank among the wave's full case membership). S43b
// (US-007): the controller now emits the wave's campaign-wide membership
// (`o1_wave.wave_cases` — every manifest case of the wave in manifest order,
// including cases that have not run yet), so the reporter selection is
// IDENTICAL for every evaluating case in the wave: it never re-derives from
// the per-case snapshot (which grows as later cases run at concurrency 1 and
// can therefore pick DIFFERENT max-manifest-rank cases per evaluating case —
// the campaign stamped the do-now family finding on TWO reporter cases, one
// not even do-now). Only the true final wave case merges family findings into
// its findings list. The reporter must be a real campaign case, so
// wave_cases entries absent from the manifest are filtered out. When the wave
// projection predates `wave_cases` (STORED schema-1 evidence, or fixture
// shapes that never declare it), the legacy per-snapshot fallback below keeps
// the pre-S43b deterministic behavior: wave rows whose case_id is absent from
// the manifest (e.g. fixture peer runs) can never win the reporter slot, and
// when the wave carries no manifest cases at all the full set is ranked
// deterministically (localeCompare), so a single-case wave still reports
// family findings from its only case.
// S43b (US-007): exported for direct unit arms (oracle self-test + tier2
// self-test) — the deterministic wave-family reporter selection.
export function waveReporterCaseId(context) {
  const wave = context.o1_wave;
  const manifestOrder = new Map(context.campaign.manifest.case_ids.map((id, index) => [id, index]));
  if (Array.isArray(wave.wave_cases) && wave.wave_cases.length > 0) {
    const inManifest = wave.wave_cases.filter((id) => manifestOrder.has(id));
    if (inManifest.length > 0) {
      const ordered = [...inManifest].sort((left, right) => manifestOrder.get(left) - manifestOrder.get(right));
      return ordered[ordered.length - 1] ?? null;
    }
  }
  const caseIds = new Set();
  for (const run of wave.runs) caseIds.add(run.case_id);
  for (const floor of wave.duration_floors) {
    if (typeof floor.case_id === 'string' && floor.case_id.length > 0) caseIds.add(floor.case_id);
  }
  const manifestCaseIds = [...caseIds].filter((id) => manifestOrder.has(id));
  const pool = manifestCaseIds.length > 0 ? manifestCaseIds : [...caseIds];
  const rank = (id) => (manifestOrder.has(id) ? manifestOrder.get(id) : Number.MAX_SAFE_INTEGER);
  const ordered = [...pool].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    return byRank !== 0 ? byRank : left.localeCompare(right);
  });
  return ordered[ordered.length - 1] ?? null;
}

function mergeFindings(target, source) {
  for (const finding of source.toJSON()) {
    const { id, summary, ...details } = finding;
    target.add(id, summary, details);
  }
}

// T2.2 US-002: classify a wave run as scripted (mechanically-fast, zero-token
// cell) for duration-floor evaluation. Duration floors exist to catch
// dishonestly-fast REAL runs; they are meaningless for scripted cells. The
// run's own `execution_mode` field (US-001) wins when present. STORED schema-1
// evidence predates the field: a run row without `execution_mode` is treated
// as scripted when the evaluating case is a 0-token-cap cell
// (context.case.caps.tokens === 0) — the deterministic reporter of a
// scripted-only wave snapshot. This fallback is exact for scripted-only
// campaign evidence and never applies to real cells (caps.tokens > 0), so no
// other stored-campaign replay is altered.
function isScriptedRun(run, caseCtx) {
  if (run.execution_mode === 'scripted') return true;
  if (run.execution_mode === 'real') return false;
  return Number.isFinite(caseCtx?.caps?.tokens) && caseCtx.caps.tokens === 0;
}

function evaluateDurationFloor(findings, wave, caseCtx) {
  const observations = [];
  const launchedWorkflows = [...new Set(wave.runs.map((run) => run.workflow))].sort();
  // Floor findings describe real-run families only: a wave whose runs are all
  // scripted (e.g. a 0-token tier2 cell's snapshot) has no real family to
  // judge, so the floor-level UNKNOWN guard is suppressed there.
  const hasRealRuns = wave.runs.some((run) => !isScriptedRun(run, caseCtx));
  const perCaseRows = new Map();
  const legacyRows = new Map();
  for (const floor of wave.duration_floors) {
    if (typeof floor.case_id === 'string' && floor.case_id.length > 0) {
      const rows = perCaseRows.get(floor.case_id) ?? [];
      rows.push(floor);
      perCaseRows.set(floor.case_id, rows);
      if (hasRealRuns && !launchedWorkflows.includes(floor.workflow)) {
        findings.add('O1_DURATION_FLOOR_UNKNOWN', 'wave contains a duration floor for a workflow family that was not launched', {
          wave: wave.wave, workflow: floor.workflow, case_id: floor.case_id,
        });
      }
    } else {
      const rows = legacyRows.get(floor.workflow) ?? [];
      rows.push(floor);
      legacyRows.set(floor.workflow, rows);
      if (hasRealRuns && !launchedWorkflows.includes(floor.workflow)) {
        findings.add('O1_DURATION_FLOOR_UNKNOWN', 'wave contains a duration floor for a workflow family that was not launched', {
          wave: wave.wave, workflow: floor.workflow,
        });
      }
    }
  }
  for (const workflow of launchedWorkflows) {
    const familyRuns = wave.runs.filter((run) => run.workflow === workflow);
    // S43a (US-006): a run whose case declares expected_fast_failure (the
    // per-cell fast-honest flag — its CORRECT behavior is early
    // termination: refusal / small-do-now / auth-expiry) is excluded from
    // BOTH the fast numerator and the eligible denominator of the family
    // rate: the per-cell flag is authoritative for that cell, so its honest
    // early termination is never flagged against the family
    // production-median floor. Non-flagged cells keep the family floor
    // (fail-closed default unchanged).
    const eligible = familyRuns.filter((run) => !run.expected_fast_failure);
    // T2.2 US-002: scripted runs are excluded from BOTH the fast numerator and
    // the eligible denominator — a mixed family counts only its real runs
    // toward the rate.
    const realEligible = eligible.filter((run) => !isScriptedRun(run, caseCtx));
    const legacy = legacyRows.get(workflow) ?? [];
    const caseIds = [...new Set(realEligible.map((run) => run.case_id))].sort();
    const resolutions = [];
    for (const caseId of caseIds) {
      const own = (perCaseRows.get(caseId) ?? []).filter((floor) => floor.workflow === workflow);
      const rows = own.length > 0 ? own : legacy;
      if (rows.length === 0) {
        findings.add('O1_DURATION_FLOOR_MISSING', 'wave omits the duration floor row for a launched workflow family', {
          wave: wave.wave, workflow, case_id: caseId,
        });
        resolutions.push({ ok: false, source: 'omitted' });
        continue;
      }
      if (rows.length > 1) {
        findings.add('O1_DURATION_FLOOR_DUPLICATE', 'wave contains duplicate duration floor rows for a launched workflow family', {
          wave: wave.wave, workflow, case_id: caseId, row_count: rows.length,
        });
        resolutions.push({ ok: false, source: 'duplicate' });
        continue;
      }
      const [floor] = rows;
      if (floor.duration_floor_ms === null) {
        findings.add('O1_DURATION_FLOOR_MISSING', 'wave lacks a W1 or production duration floor for a launched workflow family', {
          wave: wave.wave, workflow, case_id: caseId,
        });
        resolutions.push({ ok: false, source: floor.source });
        continue;
      }
      resolutions.push({ ok: true, case_id: caseId, floor });
    }
    if (eligible.length === 0) {
      // S43a (US-006): a family whose runs are ALL declared fast-honest
      // (expected_fast_failure) has no floor-judgeable run — the family
      // production-median floor cannot flag any of them, so no rate finding
      // is possible. Write the zero-run observation row anyway (mirroring
      // the scripted-only branch below) so campaign-wide duration-floor
      // evidence stays complete for the family.
      observations.push({
        workflow,
        case_floors: [],
        run_count: 0,
        fast_run_count: 0,
        fast_rate: 0,
      });
      continue;
    }
    if (realEligible.length === 0) {
      // Scripted-only family: no real runs to judge, so no
      // O1_DURATION_FLOOR_RATE/MISSING/DUPLICATE finding for this family. The
      // observation row is still written (run_count 0) so campaign-wide
      // duration-floor evidence stays complete for every case.
      observations.push({
        workflow,
        case_floors: [],
        run_count: 0,
        fast_run_count: 0,
        fast_rate: 0,
      });
      continue;
    }
    const failure = resolutions.find((resolution) => !resolution.ok);
    if (failure !== undefined) {
      observations.push({
        workflow,
        duration_floor_ms: null,
        source: failure.source,
        run_count: realEligible.length,
        fast_run_count: null,
      });
      continue;
    }
    const floorByCase = new Map(resolutions.map((resolution) => [resolution.case_id, resolution.floor]));
    // S43a (US-006): each run is judged against ITS OWN case's floor row —
    // a per-cell production_duration_floor_ms pin is authoritative for that
    // cell, never the family median. An un-flagged run finishing below its
    // own (or, absent a per-cell pin, the family) floor is still flagged:
    // genuinely-too-fast cells keep failing closed.
    const fast = realEligible.filter((run) => run.terminal_at !== null
      && timestamp(run.terminal_at, `o1_wave run ${run.run_id} terminal_at`)
        - timestamp(run.started_at, `o1_wave run ${run.run_id} started_at`) < floorByCase.get(run.case_id).duration_floor_ms);
    const rate = fast.length / realEligible.length;
    // A family rate finding is only meaningful with enough eligible runs:
    // below the minimum sample the wave cannot distinguish a fast wave from
    // noise, so the rate finding is suppressed (the observation is kept).
    if (realEligible.length >= MIN_FLOOR_RATE_SAMPLE && rate > MAX_FAST_RATE) {
      findings.add('O1_DURATION_FLOOR_RATE', 'more than 20% of a wave workflow family terminated below its measured duration floor', {
        wave: wave.wave,
        workflow,
        case_floors: resolutions.map((resolution) => ({
          case_id: resolution.case_id,
          duration_floor_ms: resolution.floor.duration_floor_ms,
          source: resolution.floor.source,
        })),
        run_count: realEligible.length,
        fast_run_count: fast.length,
        fast_rate: rate,
        run_ids: fast.map((run) => run.run_id).sort(),
      });
    }
    observations.push({
      workflow,
      case_floors: resolutions.map((resolution) => ({
        case_id: resolution.case_id,
        duration_floor_ms: resolution.floor.duration_floor_ms,
        source: resolution.floor.source,
      })),
      run_count: realEligible.length,
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
  // Family-level duration-floor findings describe the whole wave family, not a
  // single case: they are collected separately and reported exactly once, from
  // the deterministic reporter case for the wave. The observations still land
  // in every case's o1-terminal-state.json evidence (campaign-wide data); only
  // the findings list is deduplicated.
  const familyFindings = new FindingCollector();
  const durationFloorObservations = evaluateDurationFloor(familyFindings, invocation.context.o1_wave, invocation.context.case);
  const reporter = waveReporterCaseId(invocation.context);
  if (reporter !== null && reporter === invocation.context.case.id) {
    mergeFindings(findings, familyFindings);
  }
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

  // A case may only fail on findings that cite one of its own runs (run-scoped
  // findings such as O1_DB_RUN_MISSING / O1_WAVE_RUN_MISSING), plus the family
  // findings above when it is the wave reporter. Wave-level citations of a
  // sibling case's run (e.g. a duplicated wave row owned by a sibling case)
  // are the sibling's failure, not this case's. A run is this case's own when
  // the context graph launches it, a wave row attributes it to this case, or
  // this case's workflow-status evidence names it.
  const ownRunIds = new Set(uniqueContextRuns.keys());
  for (const row of invocation.context.o1_wave.runs) {
    if (row.case_id === invocation.context.case.id) ownRunIds.add(canonicalRunId(row.run_id));
  }
  for (const runId of workflowRows.keys()) ownRunIds.add(runId);
  const scopedFindings = findings.toJSON().filter((finding) => {
    if (typeof finding.run_id !== 'string') return true;
    return ownRunIds.has(canonicalRunId(finding.run_id));
  });

  const evidence = [writeEvidenceJson(invocation, 'o1-terminal-state.json', {
    schema_version: 1,
    captured_at: new Date(workflow.capturedAt).toISOString(),
    runs: observations,
    duration_floor_observations: durationFloorObservations,
  }, 'sqlite-events-workflow-status')];
  const result = scopedFindings.length === 0 ? 'PASS' : 'FAIL';
  return {
    result,
    findings: scopedFindings,
    evidence,
    classification: result === 'PASS' && stragglerCount > 0
      ? { ambiguous: { category: 'HEALTHY_STRAGGLER' } }
      : undefined,
  };
}
