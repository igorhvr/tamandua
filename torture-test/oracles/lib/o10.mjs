import { createHash } from 'node:crypto';
import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';

const FMIS_EVENTS = new Set([
  'step.rerouted', 'step.running', 'merge.gate_overridden',
  'merge.landed_without_suite_evidence', 'merge.landed_over_red_suite',
  'merge.accepted_already_landed', 'merge.landed',
  'run.completed', 'run.failed', 'run.canceled',
]);
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
    return {
      runs: database.prepare('SELECT id, workflow_id, status, context, updated_at FROM runs ORDER BY id').all(),
      steps: database.prepare(`SELECT run_id, step_id, agent_id, status, output, reroute_count,
        terminal_reroute_count, ledger_concession_count, updated_at FROM steps ORDER BY run_id, step_id`).all(),
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
function outputValues(output) {
  const values = new Map();
  if (typeof output !== 'string') return values;
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+): (.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}
function verifyDiagnosis(findings, runId, step, evidence, key, tree, row) {
  const values = outputValues(step.output);
  const expected = new Map([
    ['FAILURE_CLASS', 'refused_permanent'], ['LEDGER_EVIDENCE', evidence],
    ['ORIGIN_REPO', key.origin_repo], ['TREE_HASH', tree], ['CMD_HASH', key.cmd_hash],
  ]);
  if (evidence === 'red' && row !== null) {
    expected.set('LEDGER_ROW_ID', String(row.id));
    expected.set('EXIT_CODE', String(row.exit_code));
    expected.set('TIMESTAMP', row.created_at);
    expected.set('DURATION_MS', String(row.duration_ms));
    expected.set('LEDGER_RUN_ID', row.run_id ?? '');
    expected.set('LEDGER_STEP_ID', row.step_id ?? '');
    expected.set('LOG_TAIL', row.log_tail ?? '');
  }
  const missing = [...expected].filter(([keyName, value]) => values.get(keyName) !== value)
    .map(([keyName]) => keyName);
  for (const keyName of ['TEST_CMD', 'WORKSPACE_STATE', 'NEAREST_EVIDENCE', 'ACTION']) {
    if (!values.has(keyName) || values.get(keyName) === '') missing.push(keyName);
  }
  const testCommand = values.get('TEST_CMD');
  if (typeof testCommand === 'string'
      && createHash('sha256').update(testCommand).digest('hex') !== key.cmd_hash) {
    missing.push('TEST_CMD');
  }
  if (missing.length > 0) findings.add('O10_REFUSAL_DIAGNOSIS', 'strict ledger refusal lacks exact mechanical self-diagnosis evidence', {
    run_id: runId, evidence, missing_or_mismatched_keys: [...new Set(missing)].sort(),
  });
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
  const artifactLedger = readLedger(invocation.evidencePaths.suite_ledger);
  const database = readDatabase(invocation);
  if (JSON.stringify(artifactLedger.map(normalizedLedgerRow)) !== JSON.stringify(database.ledger.map(normalizedLedgerRow))) {
    throw new OracleRuntimeError('suite_ledger does not reconcile byte-for-field with the read-only database snapshot');
  }
  const projected = [...invocation.context.attempts, ...invocation.context.discovered_runs]
    .filter((run) => run.run_id !== null);
  const observations = [];

  for (const projection of projected) {
    const runId = canonicalRunId(projection.run_id);
    const dbRunId = databaseRunId(runId);
    const run = database.runs.find((candidate) => candidate.id === dbRunId);
    if (run === undefined) {
      findings.add('O10_DB_RUN_MISSING', 'merge-run projection is absent from the terminal database snapshot', { run_id: runId });
      continue;
    }
    const finalize = database.steps.filter((step) => step.run_id === dbRunId && step.step_id === 'finalize_merge');
    if (finalize.length !== 1) throw new OracleRuntimeError(`run ${runId} must have exactly one finalize_merge step`);
    const [step] = finalize;
    const effectiveContext = runContext(run.context, runId);
    verifyLaunchInvariance(findings, launch, effectiveContext, runId);
    const runEvents = events.filter((event) => typeof (event.runId ?? event.run_id) === 'string'
      && canonicalRunId(event.runId ?? event.run_id) === runId);
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
    const evidence = suiteEvidence(artifactLedger, launch.gateKey, tree, decisionMs);
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
    if (step.terminal_reroute_count !== expected.reroutes || rerouteEvents !== expected.reroutes) {
      findings.add('O10_REROUTE_COUNT', 'obstructing FMIS path must reroute exactly once and permissive paths must not reroute', {
        run_id: runId, expected: expected.reroutes, database: step.terminal_reroute_count, events: rerouteEvents,
      });
    }
    if (mergerInvocations !== expected.merger_invocations) findings.add('O10_MERGER_INVOCATION_COUNT', 'FMIS cell merger invocation count is invalid', {
      run_id: runId, expected: expected.merger_invocations, observed: mergerInvocations,
    });
    const actualEvents = eventNames(runEvents);
    const expectedEvents = expectedEventNames(expected, expectedStatus, acceptedAlreadyLanded);
    if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) findings.add('O10_EVENT_SET_MISMATCH', 'FMIS cell emitted an inexact merge-gate event set', {
      run_id: runId, expected: expectedEvents, observed: actualEvents,
    });
    if (!expected.lands) verifyDiagnosis(findings, runId, step, evidence.status, launch.gateKey, tree, evidence.row);

    observations.push({
      run_id: runId,
      launch: { mode: launch.mode, fail_missing: launch.fail_missing, strict_missing: launch.strictMissing },
      exact_key: { ...launch.gateKey, tree_hash: tree },
      expected: {
        mode: launch.mode === 'default' && launch.strictMissing ? 'fail-missing' : launch.mode,
        evidence: evidence.status, already_landed: acceptedAlreadyLanded, ...expected,
      },
      observed: {
        terminal_status: run.status, finalize_status: step.status, ref_moved: refMoved,
        terminal_reroute_count: step.terminal_reroute_count, merger_invocations: mergerInvocations,
        events: actualEvents, ledger_row_id: evidence.row?.id ?? null,
      },
    });
  }

  const evidence = [writeEvidenceJson(invocation, 'o10-fmis-decision-table.json', {
    schema_version: 1, captured_at: new Date().toISOString(), run_count: observations.length, runs: observations,
  }, 'sqlite-events-launch-refs-ledger')];
  return { result: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.toJSON(), evidence };
}
