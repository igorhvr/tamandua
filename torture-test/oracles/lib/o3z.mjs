import fs from 'node:fs';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  writeEvidenceJson,
} from './index.mjs';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function canonicalRunId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OracleRuntimeError('run ID must be nonempty');
  }
  return value.startsWith('run-') ? value : `run-${value}`;
}

function requireColumns(database, table, required) {
  const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table);
  if (tableNames.length !== 1) throw new OracleRuntimeError(`${table} snapshot table is required`);
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new OracleRuntimeError(`${table} snapshot lacks required columns: ${missing.join(', ')}`);
  }
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OracleRuntimeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function readDatabase(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    requireColumns(database, 'runs', ['id', 'status', 'tokens_spent']);
    requireColumns(database, 'tamandua_stats', ['system_tokens_spent']);
    const runs = database.prepare('SELECT id, status, tokens_spent FROM runs ORDER BY id').all().map((row) => ({
      source_id: row.id,
      id: canonicalRunId(row.id),
      status: row.status,
      tokens_spent: nonnegativeInteger(row.tokens_spent, `run ${canonicalRunId(row.id)} tokens_spent`),
    }));
    const systemRows = database.prepare('SELECT system_tokens_spent FROM tamandua_stats ORDER BY rowid').all();
    if (systemRows.length === 0) throw new OracleRuntimeError('tamandua_stats snapshot has no system-token row');
    const values = systemRows.map((row, index) => nonnegativeInteger(
      row.system_tokens_spent,
      `tamandua_stats row ${index} system_tokens_spent`,
    ));
    return { runs, systemRows: values, systemTotal: values.reduce((sum, value) => sum + value, 0) };
  } finally {
    database.close();
  }
}

function timestamp(value, label) {
  if (typeof value !== 'string') throw new OracleRuntimeError(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return value;
}

function readSystemSnapshot(file, label) {
  let artifact;
  try {
    artifact = object(JSON.parse(fs.readFileSync(file, 'utf8')), label);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
  if (artifact.schema_version !== 1) throw new OracleRuntimeError(`${label}.schema_version must be 1`);
  timestamp(artifact.captured_at, `${label}.captured_at`);
  if (artifact.table_present !== true) throw new OracleRuntimeError(`${label} did not capture tamandua_stats`);
  if (!Array.isArray(artifact.rows) || artifact.rows.length === 0) {
    throw new OracleRuntimeError(`${label}.rows must contain the captured tamandua_stats rows`);
  }
  const rows = artifact.rows.map((row, index) => {
    const value = object(row, `${label}.rows[${index}]`).system_tokens_spent;
    return nonnegativeInteger(value, `${label}.rows[${index}].system_tokens_spent`);
  });
  const value = nonnegativeInteger(artifact.value, `${label}.value`);
  const sum = rows.reduce((total, current) => total + current, 0);
  if (sum !== value) throw new OracleRuntimeError(`${label}.value does not equal its captured row sum`);
  return { captured_at: artifact.captured_at, rows, value };
}

function projectedRuns(context) {
  const runs = new Map();
  for (const projection of [...context.attempts, ...context.discovered_runs]) {
    if (projection.run_id === null) continue;
    const runId = canonicalRunId(projection.run_id);
    if (!['real', 'scripted'].includes(projection.execution_mode)) {
      throw new OracleRuntimeError(`run ${runId} has no mechanically identified execution mode`);
    }
    const prior = runs.get(runId);
    if (prior !== undefined) {
      if (prior.execution_mode !== projection.execution_mode) {
        throw new OracleRuntimeError(`run ${runId} has conflicting execution modes`);
      }
      continue;
    }
    runs.set(runId, { run_id: runId, execution_mode: projection.execution_mode });
  }
  return runs;
}

export function evaluateO3z(invocation) {
  const findings = new FindingCollector();
  const database = readDatabase(invocation);
  const before = readSystemSnapshot(invocation.evidencePaths.system_tokens_before, 'system_tokens_before');
  const after = readSystemSnapshot(invocation.evidencePaths.system_tokens_after, 'system_tokens_after');
  const projections = projectedRuns(invocation.context);
  const databaseRuns = new Map();
  const databaseRunSources = new Map();
  for (const run of database.runs) {
    const sources = databaseRunSources.get(run.id) ?? [];
    sources.push(run.source_id);
    databaseRunSources.set(run.id, sources);
    if (!databaseRuns.has(run.id)) databaseRuns.set(run.id, run);
  }
  for (const [runId, sourceIds] of databaseRunSources) {
    if (sourceIds.length > 1) {
      findings.add('O3Z_DB_RUN_ID_DUPLICATE', 'terminal database contains duplicate canonical run identities', {
        run_id: runId,
        source_ids: sourceIds,
      });
    }
  }
  const observations = [];

  for (const [runId, projection] of [...projections.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const run = databaseRuns.get(runId);
    if (run === undefined) {
      findings.add('O3Z_DB_RUN_MISSING', 'controller run projection is absent from the terminal database snapshot', {
        run_id: runId,
        execution_mode: projection.execution_mode,
      });
      continue;
    }
    if (projection.execution_mode === 'real' && run.status === 'completed' && run.tokens_spent === 0) {
      findings.add('O3Z_COMPLETED_REAL_ZERO_TOKENS', 'completed real run recorded zero tokens_spent', {
        run_id: runId,
        observed: 0,
      });
    }
    observations.push({
      run_id: runId,
      execution_mode: projection.execution_mode,
      status: run.status,
      tokens_spent: run.tokens_spent,
      real_nonzero_rule_applied: projection.execution_mode === 'real' && run.status === 'completed',
    });
  }

  for (const [phase, snapshot] of [['before', before], ['after', after]]) {
    if (snapshot.value !== 0 || snapshot.rows.some((value) => value !== 0)) {
      findings.add('O3Z_SYSTEM_TOKENS_NONZERO', 'legacy system token counter must remain absolute zero', {
        phase,
        observed: snapshot.value,
        rows: snapshot.rows,
      });
    }
  }
  if (database.systemTotal !== 0 || database.systemRows.some((value) => value !== 0)) {
    findings.add('O3Z_SYSTEM_TOKENS_NONZERO', 'terminal database legacy system token counter must remain absolute zero', {
      phase: 'terminal_database',
      observed: database.systemTotal,
      rows: database.systemRows,
    });
  }
  if (after.value !== database.systemTotal || JSON.stringify(after.rows) !== JSON.stringify(database.systemRows)) {
    findings.add('O3Z_SYSTEM_TOKENS_SNAPSHOT_MISMATCH', 'system_tokens_after does not reconcile with the terminal database snapshot', {
      artifact_value: after.value,
      artifact_rows: after.rows,
      database_value: database.systemTotal,
      database_rows: database.systemRows,
    });
  }

  const evidence = [writeEvidenceJson(invocation, 'o3z-token-gate.json', {
    schema_version: 1,
    captured_at: after.captured_at,
    runs: observations,
    system_tokens: {
      before: before.value,
      after: after.value,
      terminal_database: database.systemTotal,
    },
  }, 'sqlite-system-token-snapshots')];
  return {
    result: findings.length === 0 ? 'PASS' : 'FAIL',
    findings: findings.toJSON(),
    evidence,
  };
}
