import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ORACLE_CONTEXT_VERSION = 1;
export const GATING_ORACLE_IDS = Object.freeze(['O1', 'O2', 'O3z', 'O4', 'O8', 'O9', 'O10', 'O11', 'O16']);
// E3.C (US-003): evidence artifacts that only exist when the lifecycle-probe
// machinery ran. The snapshot leaves them null when absent; the oracles that
// need them (O16 probe_evidence, O4 chaos_log) enforce presence through
// REQUIRED_ORACLE_EVIDENCE instead of failing every non-probe case's capture.
export const OPTIONAL_ORACLE_EVIDENCE_KEYS = Object.freeze(['probe_evidence', 'chaos_log']);
export const ORACLE_EVIDENCE_KEYS = Object.freeze([
  'database_snapshot',
  'run_events',
  'workflow_status',
  'launch_intent',
  'git_bundle',
  'refs_before',
  'refs_after',
  'target_reflog',
  'checksum_baseline',
  'checksum_terminal',
  'suite_ledger',
  'suite_observations',
  'token_deltas',
  'round_usage',
  'system_tokens_before',
  'system_tokens_after',
  'submit_rejections',
  'expects_validations',
  'dispatch_renderings',
  'probe_evidence',
  'chaos_log',
]);

export const REQUIRED_ORACLE_EVIDENCE = Object.freeze({
  O1: Object.freeze(['database_snapshot', 'run_events', 'workflow_status']),
  O2: Object.freeze([
    'database_snapshot', 'run_events', 'launch_intent', 'git_bundle',
    'refs_before', 'refs_after', 'target_reflog', 'suite_ledger', 'suite_observations',
  ]),
  O3z: Object.freeze(['database_snapshot', 'system_tokens_before', 'system_tokens_after']),
  // O4 (spec 03 claim & dispatch hygiene): recorder/proc samples ride inside
  // chaos_log or a recorder evidence key; the chaos log is what lets O4
  // distinguish a watchdog-killed worker from a chaos-killed one.
  O4: Object.freeze(['database_snapshot', 'run_events', 'chaos_log']),
  O8: Object.freeze(['git_bundle', 'checksum_baseline', 'checksum_terminal']),
  O9: Object.freeze(['database_snapshot', 'run_events', 'git_bundle', 'suite_ledger', 'suite_observations']),
  O10: Object.freeze([
    'database_snapshot', 'run_events', 'launch_intent', 'refs_before', 'refs_after',
    'suite_ledger', 'suite_observations', 'submit_rejections',
  ]),
  O11: Object.freeze([
    'database_snapshot', 'run_events', 'token_deltas', 'round_usage',
    'system_tokens_before', 'system_tokens_after', 'submit_rejections',
    'expects_validations', 'dispatch_renderings',
  ]),
  // O16 (E3.C lifecycle probe-evidence oracle): judges the probe sequencer's
  // per-action evidence against the run event stream and database snapshot.
  O16: Object.freeze(['probe_evidence', 'run_events', 'database_snapshot']),
});

const MECHANICAL_STEP_FIELDS = Object.freeze([
  'stepId', 'step_id',
  'agentId', 'agent_id', 'agentRole',
  'status', 'displayStatus', 'display_status', 'type',
  'currentStoryId', 'current_story_id',
  'retryCount', 'retry_count',
  'stepIndex', 'step_index',
  'abandonedCount', 'abandoned_count',
  'rerouteCount', 'reroute_count',
  'claimPid', 'claim_pid',
  'claimUpdatedAt', 'claim_updated_at',
  'updatedAt', 'updated_at',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function canonicalMechanicalTimestamp(value) {
  if (isUtcTimestamp(value)) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
  }
  return value;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function projectStepsSnapshot(snapshot) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.steps)) return null;
  return {
    source: typeof snapshot.source === 'string' ? snapshot.source : null,
    captured_at: isUtcTimestamp(snapshot.captured_at) ? snapshot.captured_at : null,
    steps: snapshot.steps.map((step) => {
      if (!isObject(step)) return {};
      return Object.fromEntries(MECHANICAL_STEP_FIELDS
        .filter((field) => Object.hasOwn(step, field))
        .map((field) => [
          field,
          ['claimUpdatedAt', 'claim_updated_at', 'updatedAt', 'updated_at'].includes(field)
            ? canonicalMechanicalTimestamp(step[field])
            : step[field],
        ]));
    }),
  };
}

function projectAttempt(attempt) {
  return {
    id: attempt.id,
    kind: attempt.kind,
    phase: attempt.phase,
    execution_mode: attempt.execution_mode ?? null,
    run_id: attempt.run_id ?? null,
    started_at: attempt.started_at,
    terminal_at: attempt.terminal_at ?? null,
    terminal_status: attempt.terminal_status ?? null,
    tokens_observed: attempt.tokens_observed ?? 0,
    command_result: attempt.command === undefined ? null : {
      exit_code: attempt.command.exit_code,
      signal: attempt.command.signal,
    },
    steps_snapshot: projectStepsSnapshot(attempt.steps_snapshot),
    straggler_capture: projectStragglerCapture(attempt.straggler_capture),
  };
}

function projectStragglerCapture(capture) {
  if (!isObject(capture)) return null;
  const reason = isObject(capture.reason) ? capture.reason : {};
  return {
    captured_at: capture.captured_at,
    stop_intent_at: capture.stop_intent_at,
    reason: {
      cap: reason.cap ?? null,
      threshold: reason.threshold ?? null,
      observed: reason.observed ?? null,
    },
    steps_snapshot: projectStepsSnapshot(capture.steps_snapshot),
  };
}

function durationMs(attempt) {
  if (typeof attempt?.started_at !== 'string' || typeof attempt?.terminal_at !== 'string') return null;
  const duration = new Date(attempt.terminal_at).valueOf() - new Date(attempt.started_at).valueOf();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function projectWaveRun(caseState, attempt) {
  return {
    case_id: caseState.id,
    run_id: attempt.run_id,
    workflow: caseState.workflow,
    started_at: attempt.started_at,
    terminal_at: attempt.terminal_at ?? null,
    terminal_status: attempt.terminal_status ?? null,
    expected_fast_failure: caseState.expected_fast_failure === true,
  };
}

function createO1Wave(caseRecord, caseState, state) {
  const cases = Array.isArray(state.cases) ? state.cases : [];
  const waveCases = cases.filter((item) => item.wave === caseRecord.wave);
  const runs = waveCases.flatMap((item) => (item.attempts ?? [])
    .filter((attempt) => typeof attempt.run_id === 'string')
    .map((attempt) => projectWaveRun(item, attempt)));
  for (const discovered of state.discovered_runs ?? []) {
    const root = waveCases.find((item) => item.id === discovered.root_case_id);
    if (root !== undefined && typeof discovered.run_id === 'string') runs.push(projectWaveRun(root, discovered));
  }
  // The run under judgment (the case's own latest attempt run) must never
  // contribute to its own calibration sample.
  const judgedRunId = (caseState?.attempts ?? [])
    .findLast((attempt) => typeof attempt?.run_id === 'string')?.run_id ?? null;
  const medians = new Map();
  for (const workflow of [...new Set(runs.map((run) => run.workflow))]) {
    const calibration = cases
      .filter((item) => item.wave === 1 && item.workflow === workflow && item.expected_fast_failure !== true)
      .flatMap((item) => (item.attempts ?? [])
        .filter((attempt) => attempt.terminal_status === 'completed'
          && (judgedRunId === null || attempt.run_id !== judgedRunId))
        .map(durationMs)
        .filter((value) => value !== null));
    medians.set(workflow, { measured: median(calibration), sample_size: calibration.length });
  }
  const launched = new Map();
  for (const run of runs) {
    const key = `${run.case_id}\0${run.workflow}`;
    if (!launched.has(key)) launched.set(key, run);
  }
  const durationFloors = [...launched.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, run]) => {
      const item = cases.find((candidate) => candidate.id === run.case_id);
      const pinned = Number.isFinite(item?.production_duration_floor_ms) && item.production_duration_floor_ms > 0
        ? item.production_duration_floor_ms
        : null;
      if (pinned !== null) {
        return { workflow: run.workflow, case_id: run.case_id, duration_floor_ms: pinned, source: 'production-median', sample_size: 0 };
      }
      const { measured, sample_size } = medians.get(run.workflow) ?? { measured: null, sample_size: 0 };
      return measured !== null
        ? { workflow: run.workflow, case_id: run.case_id, duration_floor_ms: measured, source: 'w1-median', sample_size }
        : { workflow: run.workflow, case_id: run.case_id, duration_floor_ms: null, source: 'unavailable', sample_size: 0 };
    });
  return {
    schema_version: 1,
    wave: caseRecord.wave,
    duration_floors: durationFloors,
    runs: runs.sort((left, right) => `${left.case_id}\0${left.run_id}`.localeCompare(`${right.case_id}\0${right.run_id}`)),
  };
}

function projectEvidence(candidate) {
  const supplied = isObject(candidate) && isObject(candidate.references)
    ? candidate.references
    : {};
  return {
    schema_version: ORACLE_CONTEXT_VERSION,
    references: Object.fromEntries(ORACLE_EVIDENCE_KEYS.map((key) => [key, supplied[key] ?? null])),
  };
}

export function createOracleContext({ caseRecord, caseState, state, oracleId }) {
  const attempts = caseState.attempts.map(projectAttempt);
  const latestAttempt = caseState.attempts.at(-1);
  return {
    contract_version: ORACLE_CONTEXT_VERSION,
    oracle_id: oracleId,
    campaign: {
      id: state.campaign_id,
      created_at: state.created_at,
      manifest: {
        sha256: state.manifest.sha256,
        case_count: state.manifest.case_count,
        case_ids: state.manifest.case_ids,
      },
    },
    case: {
      id: caseRecord.id,
      wave: caseRecord.wave,
      workflow: caseRecord.workflow,
      fixture: caseRecord.fixture,
      harness: caseRecord.harness,
      class: caseRecord.class,
      caps: caseRecord.caps,
      boundary_files: caseRecord.boundary_files,
      forbidden: caseRecord.forbidden,
      chaos: caseRecord.chaos,
    },
    run_id: attempts.findLast((attempt) => attempt.run_id !== null)?.run_id ?? null,
    attempts,
    discovered_runs: (state.discovered_runs ?? [])
      .filter((run) => run.root_case_id === caseRecord.id)
      .map((run) => ({
        ...projectAttempt(run),
        parent_run_id: run.parent_run_id,
      })),
    o1_wave: createO1Wave(caseRecord, caseState, state),
    mechanical_evidence: projectEvidence(latestAttempt?.oracle_evidence),
  };
}

function validateReference(reference, key, campaignDir, errors) {
  const prefix = `mechanical_evidence.references.${key}`;
  if (!isObject(reference)
      || typeof reference.path !== 'string'
      || typeof reference.sha256 !== 'string'
      || typeof reference.captured_at !== 'string'
      || typeof reference.source !== 'string') {
    errors.push(`${prefix} must be null or a version-1 evidence reference`);
    return;
  }
  const segments = reference.path.split('/');
  if (reference.path.length === 0 || path.isAbsolute(reference.path)
      || reference.path.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    errors.push(`${prefix}.path must be a portable campaign-relative path`);
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(reference.sha256)) errors.push(`${prefix}.sha256 must be lowercase SHA-256`);
  if (!isUtcTimestamp(reference.captured_at)) errors.push(`${prefix}.captured_at must be a UTC ISO-8601 timestamp`);
  if (reference.source.length === 0) errors.push(`${prefix}.source must be nonempty`);

  const campaignRoot = fs.realpathSync(campaignDir);
  const candidate = path.resolve(campaignDir, reference.path);
  if (!pathIsWithin(campaignRoot, candidate)) {
    errors.push(`${prefix}.path must be a portable campaign-relative path`);
    return;
  }
  try {
    const details = fs.lstatSync(candidate);
    if (!details.isFile() || details.isSymbolicLink()
        || !pathIsWithin(campaignRoot, fs.realpathSync(candidate))) {
      errors.push(`${prefix}.path must name a contained regular non-symlink file`);
      return;
    }
    if (sha256(fs.readFileSync(candidate)) !== reference.sha256) {
      errors.push(`${prefix}.sha256 does not match the captured file`);
    }
  } catch {
    errors.push(`${prefix}.path must name a contained regular non-symlink file`);
  }
}

export function validateOracleContext(context, campaignDir, options = {}) {
  const errors = [];
  if (!isObject(context)) return ['oracle context must be a JSON object'];
  if (context.contract_version !== ORACLE_CONTEXT_VERSION) errors.push('contract_version must be 1');
  if (typeof context.oracle_id !== 'string' || context.oracle_id.length === 0) errors.push('oracle_id must be nonempty');
  if (!isObject(context.mechanical_evidence)
      || context.mechanical_evidence.schema_version !== ORACLE_CONTEXT_VERSION
      || !isObject(context.mechanical_evidence.references)) {
    errors.push('mechanical_evidence must use schema_version 1 and contain references');
    return errors;
  }
  const references = context.mechanical_evidence.references;
  const actualKeys = Object.keys(references);
  if (JSON.stringify(actualKeys) !== JSON.stringify(ORACLE_EVIDENCE_KEYS)) {
    errors.push('mechanical_evidence.references must contain the exact version-1 key set in contract order');
  }
  for (const key of ORACLE_EVIDENCE_KEYS) {
    const reference = references[key];
    if (reference !== null && reference !== undefined) validateReference(reference, key, campaignDir, errors);
  }
  if (options.requireOracleEvidence === true) {
    for (const key of REQUIRED_ORACLE_EVIDENCE[context.oracle_id] ?? []) {
      if (references[key] === null || references[key] === undefined) {
        errors.push(`mechanical_evidence.references.${key} is required for ${context.oracle_id}`);
      }
    }
  }
  return errors;
}
