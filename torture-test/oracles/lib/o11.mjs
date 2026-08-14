import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';
import { evaluateO11OutputContract } from './o11-output-contract.mjs';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an object`);
  return value;
}
function canonicalRunId(value, label = 'run ID') {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be nonempty`);
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
  try { return object(JSON.parse(fs.readFileSync(file, 'utf8')), label); } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}
function readArtifact(file, label) {
  const artifact = readJson(file, label);
  if (artifact.schema_version !== 1 || !Array.isArray(artifact.rows)) throw new OracleRuntimeError(`${label} must be a schema-version 1 row artifact`);
  timestamp(artifact.captured_at, `${label}.captured_at`);
  return artifact;
}
function requireColumns(database, table, names) {
  const present = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table);
  if (present.length !== 1) throw new OracleRuntimeError(`${table} table is required`);
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const missing = names.filter((name) => !columns.has(name));
  if (missing.length > 0) throw new OracleRuntimeError(`${table} lacks required columns: ${missing.join(', ')}`);
}
function readDatabaseState(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    requireColumns(database, 'runs', ['id', 'status', 'tokens_spent']);
    requireColumns(database, 'steps', ['id', 'run_id', 'step_id', 'status', 'expects', 'type', 'loop_config']);
    requireColumns(database, 'stories', ['id', 'run_id', 'status']);
    const runs = database.prepare('SELECT id, status, tokens_spent FROM runs ORDER BY id').all().map((row) => ({
      run_id: canonicalRunId(row.id), status: row.status, tokens_spent: integer(row.tokens_spent, `run ${row.id} tokens_spent`),
    }));
    const steps = database.prepare('SELECT id, run_id, step_id, status, expects, type, loop_config FROM steps ORDER BY run_id, id').all().map((row) => ({
      step_row_id: nonempty(row.id, 'steps.id'), run_id: canonicalRunId(row.run_id),
      step_id: nonempty(row.step_id, `step ${row.id}.step_id`), status: nonempty(row.status, `step ${row.id}.status`),
      expects_required: typeof row.expects === 'string' && row.expects.trim().length > 0,
      type: typeof row.type === 'string' && row.type.length > 0 ? row.type : 'single',
      loop_config: row.loop_config,
    }));
    const stories = database.prepare('SELECT id, run_id, status FROM stories ORDER BY run_id, id').all().map((row) => ({
      story_row_id: nonempty(row.id, 'stories.id'), run_id: canonicalRunId(row.run_id),
      status: nonempty(row.status, `story ${row.id}.status`),
    }));
    return { runs, steps, stories };
  } finally { database.close(); }
}
function projections(context) {
  const result = new Map();
  for (const value of [...context.attempts, ...context.discovered_runs]) {
    if (value.run_id === null) continue;
    const runId = canonicalRunId(value.run_id);
    const prior = result.get(runId);
    if (prior && prior.execution_mode !== value.execution_mode) throw new OracleRuntimeError(`run ${runId} has conflicting execution modes`);
    result.set(runId, {
      run_id: runId, execution_mode: value.execution_mode, started_at: value.started_at,
      terminal_at: value.terminal_at, terminal_status: value.terminal_status, tokens_observed: value.tokens_observed,
    });
  }
  return result;
}
function eventIdentity(wrapper, label) {
  const row = object(wrapper, label);
  integer(row.line, `${label}.line`);
  if (typeof row.archive !== 'string' || row.archive.length === 0) throw new OracleRuntimeError(`${label}.archive is required`);
  const event = object(row.event, `${label}.event`);
  if (event.event !== 'run.tokens.updated') throw new OracleRuntimeError(`${label} is not run.tokens.updated`);
  return { wrapper: row, event };
}
function numericInput(inputs, key, label) {
  return integer(inputs[key] ?? 0, `${label}.${key}`);
}
function usageFormula(usage, label) {
  const inputs = object(usage.formula_inputs, `${label}.formula_inputs`);
  if (usage.harness === 'pi') {
    if (inputs.total !== null && inputs.total !== undefined) return integer(inputs.total, `${label}.formula_inputs.total`);
    return numericInput(inputs, 'input', label) + numericInput(inputs, 'output', label)
      + numericInput(inputs, 'cache_read', label) + numericInput(inputs, 'cache_write', label);
  }
  if (usage.harness === 'hermes') {
    numericInput(inputs, 'cache_read', label);
    numericInput(inputs, 'reasoning', label);
    return numericInput(inputs, 'input', label) + numericInput(inputs, 'output', label) + numericInput(inputs, 'cache_write', label);
  }
  if (usage.harness === 'scripted') return numericInput(inputs, 'synthetic_tokens', label);
  throw new OracleRuntimeError(`${label}.harness must be pi, hermes, or scripted`);
}

export function evaluateO11(invocation) {
  const findings = new FindingCollector();
  const databaseState = readDatabaseState(invocation);
  const databaseRuns = databaseState.runs;
  const projected = projections(invocation.context);
  const runEvents = readArtifact(invocation.evidencePaths.run_events, 'run_events');
  const deltaArtifact = readArtifact(invocation.evidencePaths.token_deltas, 'token_deltas');
  const usageArtifact = readArtifact(invocation.evidencePaths.round_usage, 'round_usage');
  if (!Array.isArray(usageArtifact.synthetic_ledger)) throw new OracleRuntimeError('round_usage.synthetic_ledger must be an array');
  const outputContract = evaluateO11OutputContract(invocation, projected, databaseState.steps, databaseState.stories);
  for (const finding of outputContract.findings) {
    const { id, summary, ...details } = finding;
    findings.add(id, summary, details);
  }

  const runEventTokens = runEvents.rows.filter((row) => row?.event?.event === 'run.tokens.updated');
  const eventKeys = (rows) => rows.map((row) => `${row.archive}:${row.line}:${JSON.stringify(row.event)}`).sort();
  if (JSON.stringify(eventKeys(runEventTokens)) !== JSON.stringify(eventKeys(deltaArtifact.rows))) {
    findings.add('O11_TOKEN_EVENT_SNAPSHOT_MISMATCH', 'token_deltas does not exactly reconcile with captured run.tokens.updated events');
  }

  const usages = [];
  const usageById = new Map();
  for (const [index, raw] of usageArtifact.rows.entries()) {
    const usage = object(raw, `round_usage.rows[${index}]`);
    if (typeof usage.id !== 'string' || usage.id.length === 0 || usageById.has(usage.id)) throw new OracleRuntimeError(`round_usage.rows[${index}].id must be unique and nonempty`);
    timestamp(usage.started_at, `usage ${usage.id}.started_at`);
    timestamp(usage.finished_at, `usage ${usage.id}.finished_at`);
    if (usage.finished_at < usage.started_at) throw new OracleRuntimeError(`usage ${usage.id} finishes before it starts`);
    if (!Array.isArray(usage.candidate_run_ids) || usage.candidate_run_ids.some((id) => typeof id !== 'string')) throw new OracleRuntimeError(`usage ${usage.id}.candidate_run_ids must be an array`);
    const normalized = {
      ...usage,
      run_id: usage.run_id === null ? null : canonicalRunId(usage.run_id, `usage ${usage.id}.run_id`),
      candidate_run_ids: usage.candidate_run_ids.map((id) => canonicalRunId(id)),
      expected_delta: usageFormula(usage, `usage ${usage.id}`),
      charges: [],
    };
    const overlaps = (run) => run !== undefined
      && usage.finished_at >= run.started_at
      && (run.terminal_at === null || usage.started_at <= run.terminal_at);
    if (normalized.run_id !== null && !overlaps(projected.get(normalized.run_id))) {
      findings.add('O11_USAGE_OUTSIDE_RUN_WINDOW', 'usage owner is unknown or does not overlap the captured run attempt window', {
        usage_id: usage.id, run_id: normalized.run_id,
      });
    }
    for (const candidateRunId of normalized.candidate_run_ids) {
      if (!overlaps(projected.get(candidateRunId))) {
        findings.add('O11_CANDIDATE_WINDOW_INVALID', 'usage candidate is unknown or does not overlap the captured attempt window', {
          usage_id: usage.id, run_id: candidateRunId,
        });
      }
    }
    if (normalized.run_id !== null && !normalized.candidate_run_ids.includes(normalized.run_id)) {
      findings.add('O11_OWNER_CANDIDATE_MISMATCH', 'usage owner is absent from its mechanically captured candidate set', {
        usage_id: usage.id, run_id: normalized.run_id, candidate_run_ids: normalized.candidate_run_ids,
      });
    }
    if (usage.harness === 'hermes' && (normalized.run_id === null || normalized.candidate_run_ids.length !== 1)) {
      findings.add('O11_HERMES_ATTRIBUTION_AMBIGUOUS', 'concurrent Hermes session evidence does not identify exactly one run', {
        usage_id: usage.id, candidate_run_ids: normalized.candidate_run_ids,
      });
    }
    usageById.set(usage.id, normalized);
    usages.push(normalized);
  }

  const deltasByRun = new Map();
  const tokenEvents = [];
  for (const [index, raw] of deltaArtifact.rows.entries()) {
    const { wrapper, event } = eventIdentity(raw, `token_deltas.rows[${index}]`);
    timestamp(event.ts, `token event ${wrapper.archive}:${wrapper.line}.ts`);
    const runId = canonicalRunId(event.runId, 'token event runId');
    const delta = integer(event.tokenDelta, 'token event tokenDelta');
    const total = integer(event.tokensSpent, 'token event tokensSpent');
    const identityFields = ['stepId', 'roundId', 'usageId'];
    if (!projected.has(runId)) findings.add('O11_DELTA_RUN_UNKNOWN', 'run.tokens.updated names a run outside the captured root/discovered graph', { run_id: runId, archive: wrapper.archive, line: wrapper.line });
    // Real tamandua runs emit `run.tokens.updated` without step/round/usage
    // identity and never emit `harness.usage.captured`, so there are no per-
    // usage observations to attach each delta to. Per-delta identity mapping is
    // only meaningful WHEN captured usage observations exist (scripted/controlled
    // harness telemetry). When there are none, skip these mapping checks — the
    // run-level ledger reconciliation below still verifies the honest invariant
    // (sum(tokenDelta) == runs.tokens_spent == controller tokens_observed).
    if (identityFields.some((key) => typeof event[key] !== 'string' || event[key].length === 0)) {
      if (usages.length > 0) findings.add('O11_DELTA_IDENTITY_MISSING', 'run.tokens.updated lacks captured step, round, or usage identity', { archive: wrapper.archive, line: wrapper.line, run_id: runId });
    }
    const usage = typeof event.usageId === 'string' ? usageById.get(event.usageId) : undefined;
    if (usage === undefined) {
      if (usages.length > 0) findings.add('O11_USAGE_MISSING', 'run.tokens.updated does not map to one captured usage observation', { archive: wrapper.archive, line: wrapper.line, usage_id: event.usageId ?? null });
    } else {
      usage.charges.push({ archive: wrapper.archive, line: wrapper.line, run_id: runId, delta });
      if (event.ts < usage.finished_at) findings.add('O11_DELTA_BEFORE_USAGE_FINISH', 'token event was emitted before its usage observation finished', { usage_id: usage.id, event_at: event.ts, usage_finished_at: usage.finished_at });
      if (usage.run_id !== null && usage.run_id !== runId) findings.add('O11_CROSS_CHARGE', 'captured round usage was charged to another run', { usage_id: usage.id, owner_run_id: usage.run_id, charged_run_id: runId });
      if (usage.step_id !== event.stepId || usage.round_id !== event.roundId) findings.add('O11_ROUND_IDENTITY_MISMATCH', 'token event step/round identity differs from its usage observation', { usage_id: usage.id });
      if (usage.expected_delta !== delta) findings.add('O11_USAGE_FORMULA_MISMATCH', 'token delta does not equal the harness-specific mechanical formula', { usage_id: usage.id, harness: usage.harness, expected: usage.expected_delta, observed: delta });
    }
    const rows = deltasByRun.get(runId) ?? [];
    rows.push({ ts: event.ts, delta, total, archive: wrapper.archive, line: wrapper.line });
    deltasByRun.set(runId, rows);
    tokenEvents.push({ run_id: runId, step_id: event.stepId ?? null, round_id: event.roundId ?? null, usage_id: event.usageId ?? null, delta, total });
  }

  for (const usage of usages) {
    if (usage.charges.length !== 1) findings.add('O11_USAGE_CHARGE_COUNT', 'each usage observation must be charged exactly once', { usage_id: usage.id, observed: usage.charges.length });
  }

  const dbByRun = new Map(databaseRuns.map((run) => [run.run_id, run]));
  if (dbByRun.size !== databaseRuns.length) findings.add('O11_DB_RUN_ID_DUPLICATE', 'terminal database contains duplicate canonical run identities');
  const runObservations = [];
  for (const [runId, projection] of [...projected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const run = dbByRun.get(runId);
    if (!run) { findings.add('O11_DB_RUN_MISSING', 'projected run is missing from terminal database', { run_id: runId }); continue; }
    if (projection.terminal_status !== run.status) findings.add('O11_RUN_STATUS_MISMATCH', 'controller terminal status does not reconcile with the database run row', { run_id: runId, expected: run.status, observed: projection.terminal_status });
    const rows = (deltasByRun.get(runId) ?? []).toSorted((a, b) => a.ts.localeCompare(b.ts) || a.line - b.line);
    let cumulative = 0;
    for (const row of rows) {
      cumulative += row.delta;
      if (row.total !== cumulative) findings.add('O11_DELTA_CUMULATIVE_MISMATCH', 'run.tokens.updated cumulative total is inconsistent with prior deltas', { run_id: runId, expected: cumulative, observed: row.total, archive: row.archive, line: row.line });
    }
    if (run.tokens_spent !== cumulative) findings.add('O11_RUN_LEDGER_MISMATCH', 'runs.tokens_spent does not equal the sum of attributed deltas', { run_id: runId, expected: cumulative, observed: run.tokens_spent });
    if (projection.tokens_observed !== run.tokens_spent) findings.add('O11_CONTROLLER_TOTAL_MISMATCH', 'controller token observation does not reconcile with runs.tokens_spent', { run_id: runId, expected: run.tokens_spent, observed: projection.tokens_observed });
    if (projection.execution_mode === 'real' && run.status === 'completed' && cumulative === 0) findings.add('O11_COMPLETED_REAL_ZERO_TOKENS', 'completed real run has no attributed token spend', { run_id: runId });
    runObservations.push({ run_id: runId, execution_mode: projection.execution_mode, status: run.status, attributed_tokens: cumulative, stored_tokens: run.tokens_spent });
  }

  const syntheticRows = new Map();
  for (const [index, raw] of usageArtifact.synthetic_ledger.entries()) {
    const row = object(raw, `round_usage.synthetic_ledger[${index}]`);
    const runId = canonicalRunId(row.run_id);
    if (syntheticRows.has(runId)) throw new OracleRuntimeError(`duplicate synthetic ledger row for ${runId}`);
    syntheticRows.set(runId, integer(row.expected_tokens, `synthetic ledger ${runId}.expected_tokens`));
  }
  const manifestSynthetic = invocation.context.case.chaos?.synthetic_token_ledger ?? [];
  if (!Array.isArray(manifestSynthetic)) throw new OracleRuntimeError('case.chaos.synthetic_token_ledger must be an array when present');
  const manifestRows = manifestSynthetic.map((raw, index) => {
    const row = object(raw, `case.chaos.synthetic_token_ledger[${index}]`);
    return {
      run_id: canonicalRunId(row.run_id),
      expected_tokens: integer(row.expected_tokens, `manifest synthetic ledger row ${index}.expected_tokens`),
    };
  }).toSorted((left, right) => left.run_id.localeCompare(right.run_id));
  const artifactRows = [...syntheticRows].map(([run_id, expected_tokens]) => ({ run_id, expected_tokens }))
    .toSorted((left, right) => left.run_id.localeCompare(right.run_id));
  if (JSON.stringify(manifestRows) !== JSON.stringify(artifactRows)) {
    findings.add('O11_SYNTHETIC_MANIFEST_MISMATCH', 'captured synthetic ledger does not equal the immutable manifest declaration', {
      expected: manifestRows,
      observed: artifactRows,
    });
  }
  for (const [runId, projection] of projected) {
    if (projection.execution_mode !== 'scripted') continue;
    if (!syntheticRows.has(runId)) findings.add('O11_SYNTHETIC_LEDGER_MISSING', 'scripted run lacks its manifest-declared synthetic ledger row', { run_id: runId });
    else if (syntheticRows.get(runId) !== (deltasByRun.get(runId) ?? []).reduce((sum, row) => sum + row.delta, 0)) findings.add('O11_SYNTHETIC_LEDGER_MISMATCH', 'scripted run attribution differs from its manifest-declared synthetic ledger', { run_id: runId, expected: syntheticRows.get(runId), observed: (deltasByRun.get(runId) ?? []).reduce((sum, row) => sum + row.delta, 0) });
  }
  for (const runId of syntheticRows.keys()) if (projected.get(runId)?.execution_mode !== 'scripted') findings.add('O11_SYNTHETIC_LEDGER_UNSCOPED', 'synthetic ledger names a non-scripted or unknown run', { run_id: runId });

  const evidence = [writeEvidenceJson(invocation, 'o11-token-attribution.json', {
    schema_version: 1, captured_at: usageArtifact.captured_at, runs: runObservations,
    usages: usages.map(({ charges, ...usage }) => ({ ...usage, charges })), token_events: tokenEvents,
    synthetic_ledger: artifactRows, output_contract: outputContract.observation,
  }, 'token-attribution-reconciliation')];
  return { result: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.toJSON(), evidence };
}
