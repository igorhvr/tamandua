import { createHash } from 'node:crypto';
import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';
import { rerouteCorridorByStep } from './reroute-discipline.mjs';

const FMIS_EVENTS = new Set([
  'step.rerouted', 'step.running', 'merge.gate_overridden',
  'merge.landed_without_suite_evidence', 'merge.landed_over_red_suite',
  'merge.accepted_already_landed', 'merge.landed',
  'run.completed', 'run.failed', 'run.canceled',
]);
// S27 real-cell regime: the merge-gate seal subset. On real cells the FULL
// event multiset includes one step.running per step execution plus legal
// reroutes (lifecycle events), so the exact-set seal applies only to the
// merge-gate corridor events (the annotations, merge.landed, and the terminal
// run event). run.canceled is deliberately included on the OBSERVED side so a
// canceled terminal event where the decision table says completed/failed is an
// anomaly (the expected side never emits run.canceled).
const MERGE_GATE_EVENTS = new Set([
  'merge.gate_overridden',
  'merge.landed_without_suite_evidence', 'merge.landed_over_red_suite',
  'merge.accepted_already_landed', 'merge.landed',
  'run.completed', 'run.failed', 'run.canceled',
]);
const STORY_ITERATION_EVENTS = ['story.started', 'story.done', 'story.verified'];
const STRICT_VALUES = new Set(['1', 'true', 'on']);

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
function databaseRunId(value) { return canonicalRunId(value).slice(4); }
function timestamp(value, label) {
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}.000Z` : value;
  if (typeof normalized !== 'string') throw new OracleRuntimeError(`${label} must be a timestamp`);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== normalized) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed.valueOf();
}
function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}
function requireColumns(database, table, required) {
  const present = columns(database, table);
  if (present.size === 0) throw new OracleRuntimeError(`${table} snapshot table is required`);
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) throw new OracleRuntimeError(`${table} snapshot lacks required columns: ${missing.join(', ')}`);
}
function normalizeMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'off' || normalized === 'green') return normalized;
  return 'default';
}

export function isStrictMissing(mode, failMissing) {
  if (mode === 'off') return false;
  if (mode === 'green') return true;
  return typeof failMissing === 'string' && STRICT_VALUES.has(failMissing.toLowerCase());
}

function readLaunchIntent(file) {
  const artifact = readJson(file, 'launch_intent');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('launch_intent.schema_version must be 1');
  timestamp(artifact.captured_at, 'launch_intent.captured_at');
  const policy = object(artifact.policy, 'launch_intent.policy');
  let gateKey = null;
  if (artifact.gate_key !== null && artifact.gate_key !== undefined) {
    gateKey = object(artifact.gate_key, 'launch_intent.gate_key');
    if (typeof gateKey.origin_repo !== 'string' || gateKey.origin_repo.length === 0
        || typeof gateKey.cmd_hash !== 'string' || !/^[0-9a-f]{64}$/.test(gateKey.cmd_hash)) {
      throw new OracleRuntimeError('launch_intent.gate_key must contain an exact origin_repo and SHA-256 cmd_hash');
    }
  }
  const mode = normalizeMode(policy.merge_gate);
  const strictMissing = isStrictMissing(mode, policy.fail_missing);
  return {
    mode,
    strictMissing,
    merge_gate: policy.merge_gate ?? null,
    fail_missing: policy.fail_missing ?? null,
    gateKey,
  };
}
function readRefs(file, phase) {
  const artifact = readJson(file, `refs_${phase}`);
  if (artifact.schema_version !== 1 || artifact.phase !== phase) throw new OracleRuntimeError(`refs_${phase} identity is invalid`);
  if (typeof artifact.target_ref !== 'string' || typeof artifact.target_tip !== 'string') {
    throw new OracleRuntimeError(`refs_${phase} lacks target ref identity`);
  }
  return artifact;
}
function readEvents(file) {
  const artifact = readJson(file, 'run_events');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('run_events.schema_version must be 1');
  timestamp(artifact.captured_at, 'run_events.captured_at');
  return array(artifact.rows, 'run_events.rows').map((row, index) => {
    const wrapper = object(row, `run_events.rows[${index}]`);
    const event = object(wrapper.event, `run_events.rows[${index}].event`);
    timestamp(event.ts, `run_events.rows[${index}].event.ts`);
    return event;
  });
}
function readLedger(file) {
  const artifact = readJson(file, 'suite_ledger');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('suite_ledger.schema_version must be 1');
  timestamp(artifact.captured_at, 'suite_ledger.captured_at');
  return array(artifact.rows, 'suite_ledger.rows');
}
function readDatabase(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    requireColumns(database, 'runs', ['id', 'workflow_id', 'status', 'context', 'updated_at']);
    requireColumns(database, 'steps', [
      'run_id', 'step_id', 'agent_id', 'status', 'output', 'reroute_count',
      'terminal_reroute_count', 'ledger_concession_count', 'updated_at',
    ]);
    requireColumns(database, 'suite_results', [
      'id', 'origin_repo', 'tree_hash', 'cmd_hash', 'cmd_display', 'exit_code',
      'duration_ms', 'log_tail', 'run_id', 'step_id', 'created_at',
    ]);
    // S27: steps.type / steps.loop_config are PRAGMA-optional — present on
    // real snapshots, absent on the minimal scripted fixture schema. Absent
    // columns read as undefined (treated as non-loop by the real-cell
    // lifecycle derivation, which is event-driven anyway).
    const stepColumns = columns(database, 'steps');
    const stepTypeSelect = stepColumns.has('type') ? ', type' : '';
    const stepLoopSelect = stepColumns.has('loop_config') ? ', loop_config' : '';
    return {
      runs: database.prepare('SELECT id, workflow_id, status, context, updated_at FROM runs ORDER BY id').all(),
      steps: database.prepare(`SELECT id, run_id, step_id, agent_id, status, output, reroute_count,
        terminal_reroute_count, ledger_concession_count, updated_at${stepTypeSelect}${stepLoopSelect}
        FROM steps ORDER BY run_id, step_id, updated_at, id`).all(),
      ledger: database.prepare(`SELECT id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code,
        duration_ms, log_tail, run_id, step_id, created_at FROM suite_results ORDER BY id`).all(),
    };
  } finally {
    database.close();
  }
}
function normalizedLedgerRow(row) {
  return {
    id: row.id, origin_repo: row.origin_repo, tree_hash: row.tree_hash, cmd_hash: row.cmd_hash,
    cmd_display: row.cmd_display, exit_code: row.exit_code, duration_ms: row.duration_ms,
    log_tail: row.log_tail, run_id: row.run_id, step_id: row.step_id, created_at: row.created_at,
  };
}
function runContext(raw, runId) {
  try {
    return object(JSON.parse(raw), `run ${runId} context`);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse run ${runId} context: ${error.message}`, { cause: error });
  }
}
function policyValue(context, key) {
  return Object.hasOwn(context, key) ? context[key] ?? null : null;
}
function verifyLaunchInvariance(findings, launch, context, runId) {
  const mismatches = [];
  for (const key of ['merge_gate', 'fail_missing']) {
    const launched = launch[key];
    const effective = policyValue(context, key);
    if (effective !== launched) mismatches.push({ key, launched, effective });
  }
  if (mismatches.length > 0) findings.add(
    'O10_LAUNCH_INTENT_MUTATION',
    'effective merge-gate policy differs from the immutable launch intent',
    { run_id: runId, mismatches },
  );
}
function suiteEvidence(rows, key, tree, decisionMs) {
  const exact = rows.filter((row) => row.origin_repo === key.origin_repo
    && row.tree_hash === tree && row.cmd_hash === key.cmd_hash
    && timestamp(row.created_at, `suite row ${row.id} created_at`) <= decisionMs)
    .toSorted((left, right) => timestamp(right.created_at, `suite row ${right.id} created_at`)
      - timestamp(left.created_at, `suite row ${left.id} created_at`) || right.id - left.id);
  if (exact.length === 0) return { status: 'missing', row: null };
  return { status: exact[0].exit_code === 0 ? 'green' : 'red', row: exact[0] };
}
function expectedCell(mode, strictMissing, evidence) {
  if (mode === 'off') return { lands: true, reroutes: 0, merger_invocations: 1, annotations: ['merge.gate_overridden'] };
  if (evidence === 'green') return { lands: true, reroutes: 0, merger_invocations: 1, annotations: [] };
  if (evidence === 'red' && mode === 'default') return { lands: true, reroutes: 0, merger_invocations: 1, annotations: ['merge.landed_over_red_suite'] };
  if (evidence === 'missing' && !strictMissing) return { lands: true, reroutes: 1, merger_invocations: 1, annotations: ['merge.landed_without_suite_evidence'] };
  return { lands: false, reroutes: 1, merger_invocations: 0, annotations: [] };
}

// S47 (US-005): attempt-aware finalize-step ordering. A legitimately
// refused/rerouted finalize can accrue MULTIPLE finalize_merge step ROWS (one
// per attempt on the refusal/reroute corridor) while the workflow keeps its
// single finalize_merge step, so rows are ordered by (updated_at, id) and the
// LAST row is the TERMINAL attempt — the row that carries the run's final
// finalize disposition and drives the decision table.
function attemptRowOrder(left, right) {
  const leftAt = timestamp(left.updated_at, `run step ${left.step_id ?? ''} updated_at`);
  const rightAt = timestamp(right.updated_at, `run step ${right.step_id ?? ''} updated_at`);
  if (leftAt !== rightAt) return leftAt - rightAt;
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

// S47 (US-005): the attempt-aware finalize-step model for one run.
//   runSteps: the run's terminal steps rows (ALL rows, finalize_merge
//             included), as read from the terminal database snapshot.
// Returns { rows, terminal, attempts } where rows are the run's finalize_merge
// rows in attempt order (updated_at, id) ascending, attempts is their count,
// and terminal is the last row — or null when the run has NO finalize_merge
// row at all (the launch/setup-time refusal or never-executed corridor, which
// is NOT_EVALUABLE, never an oracle runtime error).
export function finalizeStepModel(runSteps) {
  const rows = runSteps
    .filter((step) => step.step_id === 'finalize_merge')
    .toSorted(attemptRowOrder);
  return { rows, terminal: rows.length === 0 ? null : rows[rows.length - 1], attempts: rows.length };
}
function eventNames(events) {
  return events.map((event) => event.event).filter((name) => FMIS_EVENTS.has(name)).sort();
}
function expectedEventNames(expected, status, alreadyLanded) {
  return [
    ...(expected.reroutes === 1 ? ['step.rerouted'] : []),
    ...(expected.merger_invocations === 1 ? ['step.running'] : []),
    ...expected.annotations,
    ...(expected.lands && !alreadyLanded ? ['merge.landed'] : []),
    `run.${status}`,
  ].sort();
}
// S27 real-cell regime helpers. These are pure and exported for unit testing.
// Scripted FMIS probe cells do NOT use them — they keep the exact
// eventNames/expectedEventNames comparison byte-for-byte (the seal).

// The observed merge-gate corridor multiset: the decision-table annotations,
// merge.landed, and the terminal run events. run.canceled is included so a
// canceled terminal event where the table says completed/failed is an anomaly
// (the expected side never emits run.canceled).
export function mergeGateSubset(events) {
  return events.map((event) => event.event)
    .filter((name) => MERGE_GATE_EVENTS.has(name))
    .sort();
}

// The decision-table expected merge-gate multiset: annotations plus the
// terminal event. step.rerouted / finalize_merge step.running are lifecycle
// events on real cells (validated separately) and are NOT part of the seal.
export function expectedMergeGateNames(expected, status, alreadyLanded) {
  return [
    ...expected.annotations,
    ...(expected.lands && !alreadyLanded ? ['merge.landed'] : []),
    `run.${status}`,
  ].sort();
}

// Real-cell lifecycle derivation for the step.running stream.
//   events:   the run's captured event stream (run_events rows: objects with
//             .event, .runId/.run_id, .stepId, .agentId), in capture order.
//   dbSteps:  the run's terminal steps rows (finalize_merge excluded by the
//             caller): { step_id, agent_id, type? }.
// Every non-finalize step.running must name a steps row of the run (stepId AND
// agentId), and each step's observed step.running count must equal the
// mechanically derived execution count:
//   base 1 per step row, plus (story-iteration count - 1) for steps iterated
//   over the run's stories (derive iterations from the captured
//   story.started/story.done/story.verified events naming the step — covers
//   both type='loop' steps and their verify_each decision steps), plus
//   step.retry events (each accepted retry verdict re-dispatches and executes
//   again — the DB steps.retry_count is NOT used because it counts dispatch
//   retries, not executions), plus reroute-target re-executions (the step
//   whose step.running event follows a step.rerouted event chronologically
//   re-executes once per reroute). Everything is derived from the captured
//   evidence, never a constant.
// Returns { anomalies, per_step } with no side effects.
export function lifecycleRunning(events, dbSteps) {
  const nonFinalize = dbSteps.filter((step) => step.step_id !== 'finalize_merge');
  const stepIds = new Set(nonFinalize.map((step) => step.step_id));
  const rowsByKey = new Map(nonFinalize.map((step) => [`${step.step_id}\0${step.agent_id}`, step]));

  const perNameCounts = new Map();
  const retryEvents = new Map();
  for (const event of events) {
    if (STORY_ITERATION_EVENTS.includes(event.event) && typeof event.stepId === 'string') {
      const counts = perNameCounts.get(event.stepId) ?? { story_started: 0, story_done: 0, story_verified: 0 };
      if (event.event === 'story.started') counts.story_started += 1;
      else if (event.event === 'story.done') counts.story_done += 1;
      else counts.story_verified += 1;
      perNameCounts.set(event.stepId, counts);
    } else if (event.event === 'step.retry' && typeof event.stepId === 'string') {
      retryEvents.set(event.stepId, (retryEvents.get(event.stepId) ?? 0) + 1);
    }
  }
  const storyIterations = new Map();
  for (const [stepId, counts] of perNameCounts) {
    storyIterations.set(stepId, Math.max(counts.story_started, counts.story_done, counts.story_verified));
  }

  const rerouteTargets = new Map();
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].event !== 'step.rerouted') continue;
    for (let next = index + 1; next < events.length; next += 1) {
      if (events[next].event === 'step.running' && typeof events[next].stepId === 'string') {
        const target = events[next].stepId;
        rerouteTargets.set(target, (rerouteTargets.get(target) ?? 0) + 1);
        break;
      }
    }
  }

  const expectedByStepId = new Map();
  for (const step of nonFinalize) {
    const iterations = storyIterations.get(step.step_id) ?? 0;
    // A step iterated over stories executes once per story iteration; a step
    // with no captured story events executes once (the single base execution
    // recorded by its step row). Accepted-retry re-dispatches (step.retry
    // events) and reroute-target re-executions add on top.
    const expected = (iterations > 0 ? iterations : 1)
      + (retryEvents.get(step.step_id) ?? 0)
      + (rerouteTargets.get(step.step_id) ?? 0);
    expectedByStepId.set(step.step_id, expected);
  }

  const observedByStepId = new Map();
  const running = events.filter((event) => event.event === 'step.running');
  const nonFinalizeRunning = running.filter((event) => event.stepId !== 'finalize_merge');
  for (const event of nonFinalizeRunning) {
    if (typeof event.stepId === 'string') {
      observedByStepId.set(event.stepId, (observedByStepId.get(event.stepId) ?? 0) + 1);
    }
  }

  const anomalies = [];
  for (const event of nonFinalizeRunning) {
    const stepId = event.stepId;
    if (typeof stepId !== 'string' || !stepIds.has(stepId) || !rowsByKey.has(`${stepId}\0${event.agentId}`)) {
      anomalies.push({ kind: 'unknown-step-running', step_id: stepId ?? null, agent_id: event.agentId ?? null });
    }
  }
  for (const step of nonFinalize) {
    const observed = observedByStepId.get(step.step_id) ?? 0;
    const expected = expectedByStepId.get(step.step_id) ?? 1;
    if (observed !== expected) {
      anomalies.push({ kind: 'running-count-mismatch', step_id: step.step_id, expected, observed });
    }
  }

  return {
    anomalies,
    per_step: nonFinalize.map((step) => ({
      step_id: step.step_id,
      agent_id: step.agent_id,
      type: step.type ?? null,
      retry_events: retryEvents.get(step.step_id) ?? 0,
      story_iterations: storyIterations.get(step.step_id) ?? 0,
      reroute_target_executions: rerouteTargets.get(step.step_id) ?? 0,
      expected: expectedByStepId.get(step.step_id) ?? 1,
      observed: observedByStepId.get(step.step_id) ?? 0,
    })),
  };
}
// Optional dispatch_renderings read (S27 US-002). The dispatch_renderings
// evidence key is optional for O10 (its reference is null on legacy/scripted
// fixtures and on cases where no dispatch telemetry was captured); when the
// reference is present the artifact must be a well-formed schema-version 1 row
// artifact (fail closed on malformed input, like every other evidence read).
// Returns the normalized rows array, or null when the key is absent.
function readOptionalDispatchRenderings(invocation) {
  const file = invocation.evidencePaths.dispatch_renderings;
  if (file === undefined) return null;
  const artifact = readJson(file, 'dispatch_renderings');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('dispatch_renderings.schema_version must be 1');
  timestamp(artifact.captured_at, 'dispatch_renderings.captured_at');
  return array(artifact.rows, 'dispatch_renderings.rows').map((row, index) => {
    const label = `dispatch_renderings.rows[${index}]`;
    const entry = object(row, label);
    for (const key of ['run_id', 'step_id', 'step_row_id']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        throw new OracleRuntimeError(`${label}.${key} must be nonempty`);
      }
    }
    if (entry.transition !== null && entry.transition !== undefined) {
      const transition = object(entry.transition, `${label}.transition`);
      if (typeof transition.action !== 'string' || transition.action.length === 0
          || typeof transition.target_step_row_id !== 'string' || transition.target_step_row_id.length === 0) {
        throw new OracleRuntimeError(`${label}.transition must carry action and target_step_row_id`);
      }
    }
    if (entry.producer_step_row_id !== null && entry.producer_step_row_id !== undefined
        && (typeof entry.producer_step_row_id !== 'string' || entry.producer_step_row_id.length === 0)) {
      throw new OracleRuntimeError(`${label}.producer_step_row_id must be null or a nonempty string`);
    }
    return entry;
  });
}

// Real-cell per-step reroute reconciliation (S27 US-002). This is the
// O10_REROUTE_COUNT model for REAL cells; scripted FMIS probe cells keep the
// exact decision-table comparison in evaluateO10 and never reach this helper.
//
//   events:   the run's captured event stream (objects with .event, .stepId).
//   runSteps: the run's terminal steps rows (ALL steps, finalize_merge
//             included): { step_id, terminal_reroute_count }.
//   corridor: { rows, byStepId } from rerouteCorridorByStep — empty when the
//             dispatch_renderings artifact is absent or carries no legal
//             reroute corridor rows for the run (the fallback regime).
//   refusalExpectedReroutes: null on landing cells; expected.reroutes (1) on
//             refusal cells, where the decision table GENUINELY bounds
//             reroutes — the strict missing/green refusal doctrine prescribes
//             exactly one obstructing reroute before refusing, so
//             finalize_merge's DB counter and event count must both equal the
//             bound (never reconciled away).
//
// Per step: the step.rerouted event count must equal the step's DB
// terminal_reroute_count (the product only increments that counter through
// its legal reroute machinery), and each reroute must lie on a legal
// corridor: when the run's dispatch_renderings artifact carries legal reroute
// corridor rows (the shared on_fail.retry_step discipline O11 recognizes),
// the corridor rows naming the step must cover its step.rerouted events;
// otherwise the DB-counter reconciliation is the attestation (fallback).
// S47 (US-005): rows are grouped by step_id. A refused/rerouted finalize can
// legitimately accrue MULTIPLE finalize_merge rows (per-attempt rows on the
// refusal/reroute corridor) while the workflow keeps its single finalize_merge
// step. Within a group the rows are ordered by (updated_at, id) — the LAST row
// is the TERMINAL attempt that carries the step's final disposition and is the
// only row reconciled against the DB counter and the strict decision-table
// bounds; earlier rows are SUPERSEDED attempts, reconciled as attempts (each
// must be separated from the next attempt by a step.rerouted event of the
// step, and a done/landed attempt can never be superseded by a later row).
// Returns { anomalies, per_step, corridor_evidence } with no side effects.
export function reconcileReroutes(events, runSteps, corridor, refusalExpectedReroutes) {
  const perStepEvents = new Map();
  for (const event of events) {
    if (event.event === 'step.rerouted' && typeof event.stepId === 'string') {
      perStepEvents.set(event.stepId, (perStepEvents.get(event.stepId) ?? 0) + 1);
    }
  }
  const corridorPresent = (corridor?.rows?.length ?? 0) > 0;
  const corridorByStep = corridor?.byStepId ?? new Map();
  const anomalies = [];
  const per_step = [];
  const stepIds = new Set(runSteps.map((step) => step.step_id));
  // Every step.rerouted event must name a step row of the run (mirroring the
  // step.running discipline in lifecycleRunning): a reroute event for an
  // unknown step cannot be reconciled against any terminal counter.
  for (const [stepId, count] of perStepEvents) {
    if (!stepIds.has(stepId)) {
      anomalies.push({ kind: 'unknown-step-rerouted', step_id: stepId, reroute_events: count });
    }
  }
  const groups = new Map();
  for (const step of runSteps) {
    const group = groups.get(step.step_id) ?? [];
    group.push(step);
    groups.set(step.step_id, group);
  }
  for (const [stepId, rows] of groups) {
    let ordered = rows;
    if (ordered.length > 1) {
      try {
        ordered = [...rows].toSorted(attemptRowOrder);
      } catch {
        // rows without canonical updated_at keep their snapshot order (only
        // reachable from direct unit-test rows, never from the DB evidence).
        ordered = rows;
      }
    }
    const terminal = ordered[ordered.length - 1];
    const superseded = ordered.slice(0, -1);
    const observed = perStepEvents.get(stepId) ?? 0;
    const database = terminal.terminal_reroute_count ?? 0;
    const bounded = stepId === 'finalize_merge' && refusalExpectedReroutes !== null;
    const expected = bounded ? refusalExpectedReroutes : database;
    const countMismatch = bounded
      ? observed !== expected || database !== expected
      : observed !== expected;
    if (countMismatch) {
      anomalies.push({
        kind: bounded ? 'refusal-count-mismatch' : 'count-mismatch',
        step_id: stepId,
        expected,
        database,
        observed,
      });
    }
    const corridorCount = corridorByStep.get(stepId) ?? 0;
    if (observed > 0 && corridorPresent && corridorCount < observed) {
      anomalies.push({
        kind: 'corridor-missing',
        step_id: stepId,
        corridor_rows: corridorCount,
        reroute_events: observed,
      });
    }
    // S47 attempt corridor: every superseded attempt row must be separated
    // from the next attempt by a step.rerouted event (each refusal re-arms the
    // upstream producer through on_fail.retry_step and the re-dispatch
    // produces the next attempt row), and a done (landed) attempt can never be
    // superseded by a later finalize row.
    if (superseded.length > 0 && observed < superseded.length) {
      anomalies.push({
        kind: 'attempt-without-reroute',
        step_id: stepId,
        superseded_rows: superseded.length,
        reroute_events: observed,
      });
    }
    for (const attempt of superseded) {
      if (attempt.status === 'done') {
        anomalies.push({
          kind: 'superseded-done-attempt',
          step_id: stepId,
          attempt_row_id: attempt.id ?? null,
        });
      }
    }
    per_step.push({
      step_id: terminal.step_id,
      terminal_reroute_count: database,
      reroute_events: observed,
      corridor_rows: corridorCount,
      corridor: corridorPresent ? 'corroborated' : 'fallback',
      decision_table_bound: bounded ? expected : null,
      attempts: ordered.length,
      superseded_rows: superseded.length,
    });
    for (const [index, attempt] of superseded.entries()) {
      per_step.push({
        step_id: attempt.step_id,
        attempt_index: index + 1,
        superseded: true,
        terminal_reroute_count: attempt.terminal_reroute_count ?? 0,
        status: attempt.status ?? null,
        corridor: corridorPresent ? 'corroborated' : 'fallback',
      });
    }
  }
  return {
    anomalies,
    per_step,
    corridor_evidence: corridorPresent ? 'corroborated' : 'fallback',
  };
}
function outputValues(output) {
  const values = new Map();
  if (typeof output !== 'string') return values;
  let currentKey = null;
  let currentValue = null;
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+): (.*)$/.exec(line);
    if (match) {
      if (currentKey !== null) values.set(currentKey, currentValue);
      currentKey = match[1];
      currentValue = match[2];
    } else if (currentKey === 'LOG_TAIL' && currentValue !== null) {
      // S59 (US-017): LOG_TAIL is the gate's multi-line key. Its value runs
      // from the LOG_TAIL keyline until the next KEYLINE (or the end of the
      // block), so a multi-line ledger log_tail — plus any gate-generated
      // remediation advice the gate appends after the tail — is captured
      // whole instead of stopping at the first line.
      currentValue += `\n${line}`;
    }
  }
  if (currentKey !== null) values.set(currentKey, currentValue);
  return values;
}
// S59 (US-017): O10's exact refusal self-diagnosis model. verifyDiagnosis was
// a single-branch model: it compared the refusal keylines against the oracle's
// OWN decision evidence (the exact-key row when the oracle found one red, or
// the DECLARED command identity when the oracle concluded missing). Real
// strict-ledger refusals do not always take that shape:
//   (1) red-evidence branch: the gate appends its remediation sentence after
//       the LOG_TAIL keyline (a multi-line key), so the parsed LOG_TAIL value
//       = the ledger row log_tail + trailing advice and an exact compare
//       failed. O10 captures the full multi-line value and PREFIX-compares it
//       against the cited row's log_tail (terminating at the trailing advice).
//   (2) missing-with-nearest branch: the worker produced no ledger row for the
//       DECLARED command, so the gate grounded its refusal on the NEAREST red
//       evidence row it could find (LEDGER_ROW_ID / LEDGER_EVIDENCE: red plus
//       THAT row's CMD_HASH/TEST_CMD), while the oracle expected the declared
//       command's hash and LEDGER_EVIDENCE: missing. O10 now models the gate's
//       two branches and compares every key against the row the gate ACTUALLY
//       cites (LEDGER_ROW_ID).
// The oracle stays strict: refusal text must still be gate-generated keylines
// (never agent prose), LEDGER_ROW_ID must name a real row of the case's scoped
// ledger, and the cited row must reconcile with the oracle's own decision
// evidence (an exact-key red row the oracle found must be the row the gate
// cites; a row the gate cites as exact while the oracle concluded missing is
// an inconsistent diagnosis).
// Returns { branch: 'red-cited-row' | 'missing', cited_row_id, mismatched_keys }.
export function refusalDiagnosis(output, evidence, key, tree, oracleRow, ledgerRows) {
  const values = outputValues(output);
  const mismatched = [];
  const check = (keyName, value) => { if (values.get(keyName) !== value) mismatched.push(keyName); };
  const requireNonempty = (keyName) => {
    if (!values.has(keyName) || values.get(keyName) === '') mismatched.push(keyName);
  };
  const addUnique = (keyName) => { if (!mismatched.includes(keyName)) mismatched.push(keyName); };

  check('FAILURE_CLASS', 'refused_permanent');

  const citedRowId = values.get('LEDGER_ROW_ID');
  const citedRow = citedRowId !== undefined && citedRowId !== ''
    ? (ledgerRows.find((candidate) => String(candidate.id) === citedRowId) ?? null)
    : null;
  if (citedRowId !== undefined && citedRowId !== '' && citedRow === null) addUnique('LEDGER_ROW_ID');
  const branch = citedRow === null ? 'missing' : 'red-cited-row';

  let commandHash = key.cmd_hash;
  if (branch === 'red-cited-row') {
    const row = citedRow;
    check('LEDGER_EVIDENCE', 'red');
    check('ORIGIN_REPO', row.origin_repo);
    check('TREE_HASH', row.tree_hash);
    check('CMD_HASH', row.cmd_hash);
    commandHash = row.cmd_hash;
    check('LEDGER_ROW_ID', String(row.id));
    check('EXIT_CODE', String(row.exit_code));
    check('TIMESTAMP', row.created_at);
    check('DURATION_MS', String(row.duration_ms));
    check('LEDGER_RUN_ID', row.run_id ?? '');
    check('LEDGER_STEP_ID', row.step_id ?? '');
    // S59 (1): prefix-compare the multi-line LOG_TAIL value against the cited
    // row's log_tail so a gate-appended remediation sentence after the tail
    // never fails the exact compare.
    const logTail = row.log_tail ?? '';
    const parsedLogTail = values.get('LOG_TAIL');
    if (typeof parsedLogTail !== 'string' || !parsedLogTail.startsWith(logTail)) addUnique('LOG_TAIL');
    // S59 (2): reconcile the cited row with the oracle's own decision evidence.
    const isExact = row.origin_repo === key.origin_repo
      && row.tree_hash === tree && row.cmd_hash === key.cmd_hash;
    if (evidence === 'red') {
      // The oracle found an exact-key red row: a correct refusal on the red
      // branch must cite THAT row (never a nearest or foreign row).
      if (oracleRow === null || String(oracleRow.id) !== String(row.id) || !isExact) addUnique('LEDGER_ROW_ID');
    } else if (isExact) {
      // The oracle concluded missing but the gate cites the exact-key row the
      // oracle could not find: the refusal diagnosis does not reconcile with
      // the oracle's decision evidence.
      addUnique('LEDGER_EVIDENCE');
    }
  } else {
    check('LEDGER_EVIDENCE', 'missing');
    check('ORIGIN_REPO', key.origin_repo);
    check('TREE_HASH', tree);
    check('CMD_HASH', key.cmd_hash);
  }
  for (const keyName of ['TEST_CMD', 'WORKSPACE_STATE', 'NEAREST_EVIDENCE', 'ACTION']) requireNonempty(keyName);
  const testCommand = values.get('TEST_CMD');
  if (typeof testCommand === 'string'
      && createHash('sha256').update(testCommand).digest('hex') !== commandHash) {
    addUnique('TEST_CMD');
  }
  return {
    branch,
    cited_row_id: citedRowId !== undefined && citedRowId !== '' ? citedRowId : null,
    mismatched_keys: [...new Set(mismatched)].sort(),
  };
}
function verifyDiagnosis(findings, runId, step, evidence, key, tree, oracleRow, ledgerRows) {
  const diagnosis = refusalDiagnosis(step.output, evidence, key, tree, oracleRow, ledgerRows);
  if (diagnosis.mismatched_keys.length > 0) {
    findings.add('O10_REFUSAL_DIAGNOSIS', 'strict ledger refusal lacks exact mechanical self-diagnosis evidence', {
      run_id: runId,
      evidence,
      missing_or_mismatched_keys: diagnosis.mismatched_keys,
      refusal_diagnosis: { branch: diagnosis.branch, cited_row_id: diagnosis.cited_row_id },
    });
  }
  return diagnosis;
}

export function evaluateO10(invocation) {
  const findings = new FindingCollector();
  const launch = readLaunchIntent(invocation.evidencePaths.launch_intent);
  if (launch.gateKey === null) {
    return {
      result: 'NOT_EVALUABLE',
      findings: [],
      evidence: [writeEvidenceJson(invocation, 'o10-fmis-decision-table.json', {
        schema_version: 1,
        not_evaluable: true,
        reason: 'launch_intent.gate_key is null: cannot establish the immutable launch suite key',
        run_count: 0,
        runs: [],
      }, 'sqlite-events-launch-refs-ledger')],
    };
  }
  const refsBefore = readRefs(invocation.evidencePaths.refs_before, 'before');
  const refsAfter = readRefs(invocation.evidencePaths.refs_after, 'after');
  if (refsBefore.target_ref !== refsAfter.target_ref) throw new OracleRuntimeError('target ref identity changed between snapshots');
  const events = readEvents(invocation.evidencePaths.run_events);
  // S27 US-002: optional dispatch_renderings corridor evidence. The key may be
  // null (legacy/scripted fixtures and cases without dispatch telemetry); the
  // real-cell reroute reconciliation falls back to the DB-counter attestation
  // when the artifact is absent or carries no legal reroute corridor rows.
  const dispatchRenderings = readOptionalDispatchRenderings(invocation);
  const artifactLedger = readLedger(invocation.evidencePaths.suite_ledger);
  const database = readDatabase(invocation);
  // S26: reconcile WITHIN the case's suite-origin scope. The snapshotter
  // scoped suite-ledger.json to the gate-key origin + captured event origins
  // (bin/oracle-evidence-snapshot.mjs ~:1150-1157); O10 recomputes the SAME
  // scope from its own inputs and treats rows from any other origin as
  // foreign (S13 doctrine), never as reconciliation failures. In-scope
  // tamper detection stays byte-for-field fail-closed.
  const suiteOrigins = new Set([launch.gateKey.origin_repo]);
  for (const event of events) {
    if (typeof event.originRepo === 'string' && event.originRepo.length > 0) suiteOrigins.add(event.originRepo);
  }
  const scopedArtifactLedger = artifactLedger.filter((row) => suiteOrigins.has(row.origin_repo));
  const scopedDatabaseLedger = database.ledger.filter((row) => suiteOrigins.has(row.origin_repo));
  if (JSON.stringify(scopedArtifactLedger.map(normalizedLedgerRow)) !== JSON.stringify(scopedDatabaseLedger.map(normalizedLedgerRow))) {
    throw new OracleRuntimeError('suite_ledger does not reconcile byte-for-field with the read-only database snapshot');
  }
  const projected = [...invocation.context.attempts, ...invocation.context.discovered_runs]
    .filter((run) => run.run_id !== null);
  // S27: key the two event-set regimes on the projected run's execution_mode
  // ('real' | 'scripted'). A run seen from multiple projections is real if any
  // of them says real (missing/unknown modes default to the scripted exact
  // regime so existing fixtures and legacy contexts are unaffected).
  const runRegimes = new Map();
  for (const projection of projected) {
    const runId = canonicalRunId(projection.run_id);
    if (projection.execution_mode === 'real') runRegimes.set(runId, 'real');
    else if (!runRegimes.has(runId)) runRegimes.set(runId, 'scripted');
  }
  const observations = [];
  // S47 (US-005) / S59 (US-017): projected runs with no applicable
  // step-level gate evidence are recorded here — NEVER as oracle runtime
  // errors and never as PRODUCT_FAIL verdicts over evidence the FMIS decision
  // table cannot apply: runs with no finalize_merge step row (launch/setup-time
  // refusal) and runs that never reached a claimed step (S59 never-executed
  // arm — no step.running and no executed steps row).
  const notEvaluable = [];

  for (const projection of projected) {
    const runId = canonicalRunId(projection.run_id);
    const dbRunId = databaseRunId(runId);
    const run = database.runs.find((candidate) => candidate.id === dbRunId);
    if (run === undefined) {
      findings.add('O10_DB_RUN_MISSING', 'merge-run projection is absent from the terminal database snapshot', { run_id: runId });
      continue;
    }
    const regime = runRegimes.get(runId) ?? 'scripted';
    const runSteps = database.steps.filter((step) => step.run_id === dbRunId);
    const runEvents = events.filter((event) => typeof (event.runId ?? event.run_id) === 'string'
      && canonicalRunId(event.runId ?? event.run_id) === runId);
    // S47 (US-005): attempt-aware finalize-step selection. The workflow
    // defines ONE finalize_merge step, but a refused/rerouted finalize
    // legitimately accrues MULTIPLE finalize_merge step ROWS (per-attempt rows
    // on the refusal/reroute corridor); finalizeStepModel selects the TERMINAL
    // attempt (the row carrying the run's final finalize disposition) and the
    // decision table is applied to that row.
    const finalize = finalizeStepModel(runSteps);
    if (finalize.terminal === null) {
      notEvaluable.push({
        run_id: runId,
        regime,
        reason: 'run has no finalize_merge step row: no step-level gate evidence to apply the FMIS decision table (launch/setup-time refusal or never-executed run)',
      });
      continue;
    }
    // S59 (US-017) never-executed arm: a run that NEVER reached a claimed
    // step — no step.running event was ever captured for it and no steps row
    // of the run is in an executed state (the W4.dsh-fdmw shape: a dsh
    // harness instant-failing under the contained daemon, 0 tokens, canceled
    // at the wall cap with the workflow's step rows still waiting/pending/
    // canceled) has no step-level gate evidence the FMIS decision table can
    // apply. O10 records it run-level NOT_EVALUABLE with the reason so the
    // case classifies INCONCLUSIVE/TIF — never a PRODUCT_FAIL via
    // O10_EVENT_SET_MISMATCH over a stream that never executed. Refusal cells
    // DO reach a claimed step (their pre-finalize steps execute; only the
    // finalize dispatch is refused), and canceled runs whose steps executed
    // keep the canceled-run anomaly doctrine — this arm is scoped to REAL
    // cells, where an executed run always emits step.running events.
    const executedStepRows = runSteps.some((candidate) => ['done', 'failed', 'running'].includes(candidate.status));
    if (regime === 'real' && !executedStepRows
        && !runEvents.some((event) => event.event === 'step.running')) {
      notEvaluable.push({
        run_id: runId,
        regime,
        reason: 'run never reached a claimed step: no step.running event was captured and no steps row executed (waiting/pending/canceled rows only — the 0-token canceled-before-dispatch class), so no step-level gate evidence exists to apply the FMIS decision table',
      });
      continue;
    }
    const step = finalize.terminal;
    const effectiveContext = runContext(run.context, runId);
    verifyLaunchInvariance(findings, launch, effectiveContext, runId);
    const landings = runEvents.filter((event) => event.event === 'merge.landed');
    const landing = landings[0];
    const acceptedEvents = runEvents.filter((event) => event.event === 'merge.accepted_already_landed');
    const acceptedAlreadyLanded = acceptedEvents.length > 0;
    const refusalValues = outputValues(step.output);
    const attestedMergedCommit = refusalValues.get('MERGED_COMMIT');
    const attestedMergedTree = refusalValues.get('MERGED_TREE');
    const tree = landing?.mergedTree ?? landing?.merged_tree
      ?? effectiveContext.tested_tree
      ?? (acceptedAlreadyLanded ? attestedMergedTree : undefined)
      ?? refusalValues.get('TREE_HASH');
    if (typeof tree !== 'string' || tree.length === 0) throw new OracleRuntimeError(`run ${runId} has no mechanically attested gate tree`);
    const decisionMs = timestamp(step.updated_at, `run ${runId} finalize updated_at`);
    const evidence = suiteEvidence(scopedArtifactLedger, launch.gateKey, tree, decisionMs);
    const concessionEvents = runEvents.filter((event) => event.event === 'merge.landed_without_suite_evidence');
    for (const concession of concessionEvents) {
      if (concession.origin !== launch.gateKey.origin_repo
          || concession.treeHash !== tree
          || concession.cmdHash !== launch.gateKey.cmd_hash) {
        findings.add('O10_CONCESSION_KEY_MISMATCH', 'missing-evidence concession does not name the exact gate-evaluation key', {
          run_id: runId,
          expected: { ...launch.gateKey, tree_hash: tree },
          observed: {
            origin_repo: concession.origin ?? null,
            tree_hash: concession.treeHash ?? null,
            cmd_hash: concession.cmdHash ?? null,
          },
        });
      }
    }
    if (concessionEvents.length > 0 && evidence.status === 'red') {
      findings.add('O10_EXACT_KEY_RED_LAUNDERED', 'exact-key red suite evidence was laundered into a missing-evidence concession', {
        run_id: runId,
        exact_key: { ...launch.gateKey, tree_hash: tree },
        ledger_row_id: evidence.row.id,
        gate_evaluated_at: new Date(decisionMs).toISOString(),
      });
    }
    const expected = acceptedAlreadyLanded
      ? { lands: true, reroutes: 0, merger_invocations: 1, annotations: ['merge.accepted_already_landed'] }
      : expectedCell(launch.mode, launch.strictMissing, evidence.status);
    const expectedStatus = expected.lands ? 'completed' : 'failed';
    const refMoved = refsBefore.target_tip !== refsAfter.target_tip;
    const rerouteEvents = runEvents.filter((event) => event.event === 'step.rerouted' && event.stepId === 'finalize_merge').length;
    const mergerInvocations = runEvents.filter((event) => event.event === 'step.running'
      && event.stepId === 'finalize_merge' && event.agentId === step.agent_id).length;

    if (run.status !== expectedStatus || projection.terminal_status !== expectedStatus || step.status !== (expected.lands ? 'done' : 'failed')) {
      findings.add('O10_TERMINAL_DISPOSITION', 'FMIS cell terminal disposition does not match launch policy and exact-key evidence', {
        run_id: runId, expected_status: expectedStatus, database_status: run.status,
        projected_status: projection.terminal_status, finalize_status: step.status,
      });
    }
    const expectedRefMovement = expected.lands && !acceptedAlreadyLanded;
    if (refMoved !== expectedRefMovement) findings.add('O10_REF_MOVEMENT', 'FMIS cell target-ref movement does not match its disposition', {
      run_id: runId, expected_moved: expectedRefMovement, observed_moved: refMoved,
    });
    const looksLikeUnannotatedAcceptance = !acceptedAlreadyLanded && landings.length === 0
      && run.status === 'completed' && attestedMergedCommit !== undefined;
    if (acceptedAlreadyLanded
        && (acceptedEvents.length !== 1 || launch.mode === 'off' || landings.length !== 0
          || evidence.status === 'green'
          || refsBefore.target_tip !== refsAfter.target_tip
          || attestedMergedCommit !== refsAfter.target_tip
          || typeof attestedMergedTree !== 'string' || attestedMergedTree !== tree)) {
      findings.add('O10_ALREADY_LANDED_INVALID', 'already-landed acceptance lacks its exact mechanically verified no-movement shape', {
        run_id: runId, event_count: acceptedEvents.length, landing_count: landings.length,
        mode: launch.mode, before_tip: refsBefore.target_tip, after_tip: refsAfter.target_tip,
        merged_commit: attestedMergedCommit ?? null, merged_tree: attestedMergedTree ?? null,
        gate_tree: tree,
      });
    } else if (looksLikeUnannotatedAcceptance) {
      findings.add('O10_ALREADY_LANDED_INVALID', 'completed no-landing path omitted merge.accepted_already_landed', {
        run_id: runId,
      });
    }
    // S27 US-002: O10_REROUTE_COUNT is regime-aware.
    //  - SCRIPTED FMIS probe cells keep the exact decision-table semantics
    //    unchanged: reroutes (DB terminal counter AND step.rerouted events for
    //    finalize_merge) must equal expected.reroutes, 0 or 1 — the seal.
    //  - REAL cells reconcile per step: the count of step.rerouted events for
    //    that stepId must equal that step's DB terminal_reroute_count (the
    //    product only increments it through its legal reroute machinery), and
    //    each reroute must lie on a legal corridor (shared O11 discipline via
    //    dispatch_renderings when present; DB-counter reconciliation as the
    //    fallback). The strict refusal doctrine keeps the decision table's
    //    exact bound on refusal cells: strict missing/green refusal prescribes
    //    exactly one obstructing reroute before refusing, so the TERMINAL
    //    finalize_merge row's counter and the event count must BOTH equal
    //    expected.reroutes there (superseded attempt rows are reconciled as
    //    attempts — S47 — never against the bound).
    let rerouteReconciliation = null;
    if (regime === 'real') {
      const corridor = rerouteCorridorByStep(dispatchRenderings, runId);
      rerouteReconciliation = reconcileReroutes(runEvents, runSteps, corridor, expected.lands ? null : expected.reroutes);
      for (const anomaly of rerouteReconciliation.anomalies) {
        if (anomaly.kind === 'count-mismatch') {
          findings.add('O10_REROUTE_COUNT', 'real-cell step reroute event count does not reconcile with its DB terminal_reroute_count', {
            run_id: runId, step_id: anomaly.step_id, expected: anomaly.expected, observed: anomaly.observed,
          });
        } else if (anomaly.kind === 'refusal-count-mismatch') {
          findings.add('O10_REROUTE_COUNT', 'obstructing FMIS path must reroute exactly once and permissive paths must not reroute', {
            run_id: runId, step_id: anomaly.step_id, expected: anomaly.expected, database: anomaly.database, events: anomaly.observed,
          });
        } else if (anomaly.kind === 'unknown-step-rerouted') {
          findings.add('O10_REROUTE_COUNT', 'step.rerouted event names a step absent from the run terminal step evidence', {
            run_id: runId, step_id: anomaly.step_id, reroute_events: anomaly.reroute_events,
          });
        } else if (anomaly.kind === 'attempt-without-reroute') {
          // S47: a superseded finalize attempt row must be separated from the
          // next attempt by a reroute of the step — a multi-attempt finalize
          // with no matching reroute stream is never absorbed.
          findings.add('O10_REROUTE_COUNT', 'multi-attempt finalize must be separated by a reroute: every superseded attempt row is re-dispatched through the on_fail.retry_step corridor', {
            run_id: runId, step_id: anomaly.step_id, superseded_rows: anomaly.superseded_rows, reroute_events: anomaly.reroute_events,
          });
        } else if (anomaly.kind === 'superseded-done-attempt') {
          findings.add('O10_TERMINAL_DISPOSITION', 'a done finalize_merge attempt row is superseded by a later finalize row: the finalize step disposition is ambiguous', {
            run_id: runId, step_id: anomaly.step_id, attempt_row_id: anomaly.attempt_row_id,
          });
        } else {
          findings.add('O10_REROUTE_COUNT', 'step reroute is not corroborated by a legal dispatch_renderings corridor row', {
            run_id: runId, step_id: anomaly.step_id, corridor_rows: anomaly.corridor_rows, reroute_events: anomaly.reroute_events,
          });
        }
      }
    } else if (step.terminal_reroute_count !== expected.reroutes || rerouteEvents !== expected.reroutes) {
      findings.add('O10_REROUTE_COUNT', 'obstructing FMIS path must reroute exactly once and permissive paths must not reroute', {
        run_id: runId, expected: expected.reroutes, database: step.terminal_reroute_count, events: rerouteEvents,
      });
    }
    if (mergerInvocations !== expected.merger_invocations) findings.add('O10_MERGER_INVOCATION_COUNT', 'FMIS cell merger invocation count is invalid', {
      run_id: runId, expected: expected.merger_invocations, observed: mergerInvocations,
    });
    let eventSetObservation;
    if (regime === 'real') {
      // Real-cell regime: the merge-gate event subset keeps EXACT
      // decision-table semantics (the seal — anomalies still FAIL), while the
      // non-finalize step.running stream is validated mechanically against the
      // captured DB steps rows and story events.
      const actualSubset = mergeGateSubset(runEvents);
      const expectedSubset = expectedMergeGateNames(expected, expectedStatus, acceptedAlreadyLanded);
      eventSetObservation = { merge_gate_subset: { expected: expectedSubset, observed: actualSubset } };
      if (JSON.stringify(actualSubset) !== JSON.stringify(expectedSubset)) {
        findings.add('O10_EVENT_SET_MISMATCH', 'FMIS cell emitted an inexact merge-gate event set', {
          run_id: runId, regime: 'real', expected: expectedSubset, observed: actualSubset,
        });
      }
      const lifecycle = lifecycleRunning(runEvents, runSteps);
      eventSetObservation.lifecycle = { anomalies: lifecycle.anomalies, per_step: lifecycle.per_step };
      for (const anomaly of lifecycle.anomalies) {
        findings.add('O10_EVENT_SET_MISMATCH', 'FMIS cell lifecycle step.running stream is inconsistent with the captured step evidence', {
          run_id: runId, regime: 'real', ...anomaly,
        });
      }
    } else {
      // Scripted FMIS probe cells: the exact single-step, no-reroute event
      // multiset comparison, unchanged (the seal).
      const actualEvents = eventNames(runEvents);
      const expectedEvents = expectedEventNames(expected, expectedStatus, acceptedAlreadyLanded);
      eventSetObservation = { event_set: { expected: expectedEvents, observed: actualEvents } };
      if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) findings.add('O10_EVENT_SET_MISMATCH', 'FMIS cell emitted an inexact merge-gate event set', {
        run_id: runId, expected: expectedEvents, observed: actualEvents,
      });
    }
    let refusalDiagnosisObservation = null;
    if (!expected.lands) {
      // S59 (US-017): the exact refusal self-diagnosis model — the gate's
      // red-cited-row and missing branches, compared against the row the gate
      // actually cites (LEDGER_ROW_ID) with the multi-line LOG_TAIL prefix
      // compared against the cited row's log_tail.
      const diagnosis = verifyDiagnosis(findings, runId, step, evidence.status, launch.gateKey, tree, evidence.row, scopedArtifactLedger);
      refusalDiagnosisObservation = {
        branch: diagnosis.branch,
        cited_row_id: diagnosis.cited_row_id,
        mismatched_keys: diagnosis.mismatched_keys,
      };
    }

    observations.push({
      run_id: runId,
      regime,
      ...eventSetObservation,
      ...(refusalDiagnosisObservation !== null ? { refusal_diagnosis: refusalDiagnosisObservation } : {}),
      ...(rerouteReconciliation !== null ? {
        reroute_reconciliation: {
          decision_table_reroutes: expected.reroutes,
          refusal_cell: !expected.lands,
          corridor_evidence: rerouteReconciliation.corridor_evidence,
          per_step: rerouteReconciliation.per_step,
        },
      } : {}),
      launch: { mode: launch.mode, fail_missing: launch.fail_missing, strict_missing: launch.strictMissing },
      exact_key: { ...launch.gateKey, tree_hash: tree },
      finalize_step: {
        step_id: 'finalize_merge',
        rows: finalize.attempts,
        terminal_attempt: finalize.attempts,
        terminal_row_id: step.id ?? null,
      },
      expected: {
        mode: launch.mode === 'default' && launch.strictMissing ? 'fail-missing' : launch.mode,
        evidence: evidence.status, already_landed: acceptedAlreadyLanded, ...expected,
      },
      observed: {
        terminal_status: run.status, finalize_status: step.status, ref_moved: refMoved,
        terminal_reroute_count: step.terminal_reroute_count, merger_invocations: mergerInvocations,
        events: eventNames(runEvents), ledger_row_id: evidence.row?.id ?? null,
      },
    });
  }

  // S47 (US-005) + S59 (US-017): a case whose every projected run is
  // not-evaluable (no finalize_merge step evidence — launch/setup-time
  // refusal — or a never-executed run that never reached a claimed step)
  // answers NOT_EVALUABLE with the reason, mirroring the gate-key-null
  // evidence shape. Never a runtime error, never a PRODUCT_FAIL verdict over
  // evidence the FMIS decision table cannot apply.
  if (observations.length === 0 && notEvaluable.length > 0) {
    const evidence = [writeEvidenceJson(invocation, 'o10-fmis-decision-table.json', {
      schema_version: 1, captured_at: new Date().toISOString(), not_evaluable: true,
      reason: notEvaluable[0].reason, run_count: 0, runs: [], not_evaluable_runs: notEvaluable,
    }, 'sqlite-events-launch-refs-ledger')];
    return { result: 'NOT_EVALUABLE', findings: [], evidence };
  }
  const evidence = [writeEvidenceJson(invocation, 'o10-fmis-decision-table.json', {
    schema_version: 1, captured_at: new Date().toISOString(), run_count: observations.length, runs: observations,
    ...(notEvaluable.length > 0 ? { not_evaluable_runs: notEvaluable } : {}),
  }, 'sqlite-events-launch-refs-ledger')];
  return { result: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.toJSON(), evidence };
}
