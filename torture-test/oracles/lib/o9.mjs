import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  runGit,
  writeEvidenceJson,
} from './index.mjs';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASES = new Set(['lookup', 'execute', 'record', 'replay']);
const SINGLEFLIGHT_EVENTS = new Set(['execute_started', 'wait', 'record', 'replay', 'dead_owner_reclaimed', 'owner_released']);
const CACHE_MARKER = 'TAMANDUA-TEST CACHED';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OracleRuntimeError(`${label} must be a JSON object`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an array`);
  return value;
}
function readJson(file, label) {
  try { return object(JSON.parse(fs.readFileSync(file, 'utf8')), label); } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}
function timestampMs(value, label) {
  if (typeof value !== 'string') throw new OracleRuntimeError(`${label} must be a canonical timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  return parsed.valueOf();
}
function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be a nonempty string`);
  return value;
}
function requireOid(value, label) {
  if (typeof value !== 'string' || !OID.test(value)) throw new OracleRuntimeError(`${label} must be a lowercase Git object ID`);
  return value;
}
function requireCmdHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new OracleRuntimeError(`${label} must be a lowercase SHA-256 command hash`);
  return value;
}
function keyOf(value) { return `${value.origin_repo}\0${value.tree_hash}\0${value.cmd_hash}`; }
function sameKey(left, right) { return keyOf(left) === keyOf(right); }
function exactKeyShape(raw, label) {
  const value = object(raw, label);
  return {
    origin_repo: requireString(value.origin_repo, `${label}.origin_repo`),
    tree_hash: requireOid(value.tree_hash, `${label}.tree_hash`),
    cmd_hash: requireCmdHash(value.cmd_hash, `${label}.cmd_hash`),
  };
}

function suiteRowShape(raw, label) {
  const row = object(raw, label);
  if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new OracleRuntimeError(`${label}.id must be a positive integer`);
  const normalized = {
    id: row.id,
    origin_repo: requireString(row.origin_repo, `${label}.origin_repo`),
    tree_hash: requireOid(row.tree_hash, `${label}.tree_hash`),
    cmd_hash: requireCmdHash(row.cmd_hash, `${label}.cmd_hash`),
    cmd_display: requireString(row.cmd_display, `${label}.cmd_display`),
    exit_code: row.exit_code,
    duration_ms: row.duration_ms,
    log_tail: row.log_tail ?? null,
    run_id: row.run_id ?? null,
    step_id: row.step_id ?? null,
    created_at: row.created_at,
  };
  if (!Number.isSafeInteger(normalized.exit_code)) throw new OracleRuntimeError(`${label}.exit_code must be an integer`);
  if (!Number.isSafeInteger(normalized.duration_ms) || normalized.duration_ms < 0) throw new OracleRuntimeError(`${label}.duration_ms must be a non-negative integer`);
  if (normalized.log_tail !== null && typeof normalized.log_tail !== 'string') throw new OracleRuntimeError(`${label}.log_tail must be null or string`);
  if (normalized.run_id !== null && typeof normalized.run_id !== 'string') throw new OracleRuntimeError(`${label}.run_id must be null or string`);
  if (normalized.step_id !== null && typeof normalized.step_id !== 'string') throw new OracleRuntimeError(`${label}.step_id must be null or string`);
  timestampMs(normalized.created_at, `${label}.created_at`);
  return normalized;
}

// ── Current-attempt run scoping (S21) ─────────────────────────────────
//
// suite_results persists across campaign attempts (contained DB state is
// reused and fixture repos re-provision), so rows written by PRIOR attempts
// with the same origin_repo would otherwise be bundled and flagged
// O9_LEDGER_TREE_UNRESOLVED even though they are not part of this case's
// evidence. A bundle row is scoped to the current attempt when:
//
//   - its run_id is in the current case's run set
//     (context.attempts[*].run_id ∪ context.discovered_runs[*].run_id), or
//   - its run_id is NULL (unattributed legacy rows are retained), or
//   - the case's own captured observations reference it (a lookup
//     latest_row_id / record / replay / single-flight / special-exit
//     ledger_row_id): the current attempt actively used that row, so it
//     must still reconcile and resolve — never weaken tree resolution.
//
// Run identifiers are written in two formats across writers (bare UUID in
// suite_results.run_id vs `run-<uuid>` in the context projection), so both
// sides are compared with a leading `run-` prefix stripped. When no context
// is supplied (or the context carries no run ids at all) the run set is
// unknowable and the legacy unscoped behavior is kept — the oracle never
// weakens its own audit because of missing attribution.

function normalizeRunId(runId) {
  return typeof runId === 'string' && runId.startsWith('run-') ? runId.slice(4) : runId;
}

function currentCaseRunSet(invocation) {
  const context = invocation.context;
  const ids = [];
  if (context !== undefined && context !== null) {
    for (const attempt of Array.isArray(context.attempts) ? context.attempts : []) {
      if (typeof attempt?.run_id === 'string' && attempt.run_id.length > 0) ids.push(normalizeRunId(attempt.run_id));
    }
    for (const run of Array.isArray(context.discovered_runs) ? context.discovered_runs : []) {
      if (typeof run?.run_id === 'string' && run.run_id.length > 0) ids.push(normalizeRunId(run.run_id));
    }
  }
  return ids.length === 0 ? null : new Set(ids);
}

function observationReferencedLedgerRowIds(parsed) {
  const referenced = new Set();
  for (const row of parsed.rows) {
    if (Number.isSafeInteger(row.latest_row_id) && row.latest_row_id > 0) referenced.add(row.latest_row_id);
    if (Number.isSafeInteger(row.ledger_row_id) && row.ledger_row_id > 0) referenced.add(row.ledger_row_id);
  }
  for (const observation of parsed.singleflight) {
    for (const event of observation.events) {
      if (Number.isSafeInteger(event.ledger_row_id) && event.ledger_row_id > 0) referenced.add(event.ledger_row_id);
    }
  }
  for (const observation of parsed.specialExits) {
    if (Number.isSafeInteger(observation.ledger_row_id) && observation.ledger_row_id > 0) referenced.add(observation.ledger_row_id);
  }
  return referenced;
}

function isCurrentAttemptRow(row, runSet, referencedRowIds) {
  if (runSet === null) return true;
  if (row.run_id === null) return true;
  if (referencedRowIds.has(row.id)) return true;
  return runSet.has(normalizeRunId(row.run_id));
}

function readLedger(file) {
  const artifact = readJson(file, 'suite_ledger');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('suite_ledger.schema_version must be 1');
  timestampMs(artifact.captured_at, 'suite_ledger.captured_at');
  const rows = array(artifact.rows, 'suite_ledger.rows').map((row, index) => suiteRowShape(row, `suite_ledger.rows[${index}]`));
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(ids.toSorted((a, b) => a - b))) {
    throw new OracleRuntimeError('suite_ledger.rows must have unique ascending IDs');
  }
  return rows;
}

function readDatabaseLedger(invocation, bundleOrigins, runSet, referencedRowIds) {
  const database = openEvidenceDatabase(invocation);
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(suite_results)').all().map((row) => row.name));
    const required = ['id', 'origin_repo', 'tree_hash', 'cmd_hash', 'cmd_display', 'exit_code', 'duration_ms', 'log_tail', 'run_id', 'step_id', 'created_at'];
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) throw new OracleRuntimeError(`suite_results snapshot lacks required columns: ${missing.join(', ')}`);
    return database.prepare(`SELECT ${required.join(', ')} FROM suite_results ORDER BY id`).all()
      .filter((row) => bundleOrigins.has(row.origin_repo))
      .filter((row) => isCurrentAttemptRow(row, runSet, referencedRowIds))
      .map((row, index) => suiteRowShape(row, `suite_results[${index}]`));
  } finally {
    database.close();
  }
}

function readCaseBundleOrigins(invocation) {
  const origins = new Set();
  const launchIntentPath = invocation.evidencePaths.launch_intent;
  if (launchIntentPath !== undefined) {
    const artifact = readJson(launchIntentPath, 'launch_intent');
    if (artifact.schema_version !== 1) throw new OracleRuntimeError('launch_intent.schema_version must be 1');
    if (artifact.gate_key !== null && artifact.gate_key !== undefined) {
      const gateKey = object(artifact.gate_key, 'launch_intent.gate_key');
      origins.add(requireString(gateKey.origin_repo, 'launch_intent.gate_key.origin_repo'));
    }
  }
  const events = readJson(invocation.evidencePaths.run_events, 'run_events');
  if (events.schema_version !== 1) throw new OracleRuntimeError('run_events.schema_version must be 1');
  for (const raw of array(events.rows, 'run_events.rows')) {
    const wrapper = object(raw, 'run_events.rows[]');
    const event = object(wrapper.event, 'run_events.rows[].event');
    if (typeof event.originRepo === 'string' && event.originRepo.length > 0) origins.add(event.originRepo);
  }
  return origins;
}

function observationShape(raw, index) {
  const label = `suite_observations.rows[${index}]`;
  const row = object(raw, label);
  if (!Number.isSafeInteger(row.sequence) || row.sequence !== index + 1) throw new OracleRuntimeError(`${label}.sequence must equal its one-based ordered position`);
  if (!PHASES.has(row.phase)) throw new OracleRuntimeError(`${label}.phase is invalid`);
  if (typeof row.force !== 'boolean') throw new OracleRuntimeError(`${label}.force must be boolean`);
  const normalized = {
    ...row,
    id: requireString(row.id, `${label}.id`),
    invocation_id: requireString(row.invocation_id, `${label}.invocation_id`),
    origin_repo: requireString(row.origin_repo, `${label}.origin_repo`),
    tree_hash: requireOid(row.tree_hash, `${label}.tree_hash`),
    cmd_hash: requireCmdHash(row.cmd_hash, `${label}.cmd_hash`),
    observed_ms: timestampMs(row.observed_at, `${label}.observed_at`),
  };
  if (row.run_id !== null && row.run_id !== undefined && typeof row.run_id !== 'string') throw new OracleRuntimeError(`${label}.run_id must be null or string`);
  if (row.step_id !== null && row.step_id !== undefined && typeof row.step_id !== 'string') throw new OracleRuntimeError(`${label}.step_id must be null or string`);
  if (row.phase === 'lookup' && row.latest_row_id !== null && row.latest_row_id !== undefined && (!Number.isSafeInteger(row.latest_row_id) || row.latest_row_id <= 0)) {
    throw new OracleRuntimeError(`${label}.latest_row_id must be null or a positive integer`);
  }
  if (row.phase === 'execute') {
    normalized.started_ms = timestampMs(row.started_at, `${label}.started_at`);
    normalized.pre_tree_hash = requireOid(row.pre_tree_hash, `${label}.pre_tree_hash`);
    normalized.post_tree_hash = requireOid(row.post_tree_hash, `${label}.post_tree_hash`);
    if (!Number.isSafeInteger(row.exit_code)) throw new OracleRuntimeError(`${label}.exit_code must be an integer`);
    if (normalized.started_ms > normalized.observed_ms) throw new OracleRuntimeError(`${label}.started_at follows observed_at`);
  }
  if (row.phase === 'record' || row.phase === 'replay') {
    if (row.phase === 'record' && (!Number.isSafeInteger(row.ledger_row_id) || row.ledger_row_id <= 0)) throw new OracleRuntimeError(`${label}.ledger_row_id must be a positive integer`);
    if (row.phase === 'replay' && row.ledger_row_id !== null && (!Number.isSafeInteger(row.ledger_row_id) || row.ledger_row_id <= 0)) throw new OracleRuntimeError(`${label}.ledger_row_id must be null or a positive integer`);
    if (!Number.isSafeInteger(row.exit_code)) throw new OracleRuntimeError(`${label}.exit_code must be an integer`);
  }
  if (row.phase === 'replay') normalized.committed_tree_hash = requireOid(row.committed_tree_hash, `${label}.committed_tree_hash`);
  return normalized;
}

function readObservations(file) {
  const artifact = readJson(file, 'suite_observations');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('suite_observations.schema_version must be 1');
  timestampMs(artifact.captured_at, 'suite_observations.captured_at');
  if (!Number.isSafeInteger(artifact.ttl_green_ms) || artifact.ttl_green_ms <= 0) throw new OracleRuntimeError('suite_observations.ttl_green_ms must be a positive integer');
  const rows = array(artifact.rows, 'suite_observations.rows').map(observationShape);
  if (rows.length === 0) return { empty: true };
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new OracleRuntimeError('suite_observations rows must have unique IDs');
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].observed_ms < rows[index - 1].observed_ms) throw new OracleRuntimeError('suite_observations rows must be timestamp-ordered');
  }
  const originIdentities = array(artifact.origin_identities, 'suite_observations.origin_identities').map((raw, index) => {
    const label = `suite_observations.origin_identities[${index}]`;
    const identity = object(raw, label);
    const originRepo = requireString(identity.origin_repo, `${label}.origin_repo`);
    const normalized = requireString(identity.normalized_origin_repo, `${label}.normalized_origin_repo`);
    if (!path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized) throw new OracleRuntimeError(`${label}.normalized_origin_repo must be an absolute normalized path`);
    if (path.posix.normalize(originRepo) !== normalized) throw new OracleRuntimeError(`${label}.normalized_origin_repo does not normalize origin_repo`);
    return { origin_repo: originRepo, normalized_origin_repo: normalized };
  });
  if (originIdentities.length === 0) throw new OracleRuntimeError('suite_observations.origin_identities must not be empty');
  const normalizedOrigins = originIdentities.map((identity) => identity.normalized_origin_repo);
  if (new Set(normalizedOrigins).size !== normalizedOrigins.length) throw new OracleRuntimeError('independent origin identities must have unique normalized_origin_repo values');
  const singleflight = array(artifact.singleflight_observations, 'suite_observations.singleflight_observations').map((raw, index) => {
    const label = `suite_observations.singleflight_observations[${index}]`;
    const value = object(raw, label);
    const events = array(value.events, `${label}.events`).map((rawEvent, eventIndex) => {
      const eventLabel = `${label}.events[${eventIndex}]`;
      const event = object(rawEvent, eventLabel);
      if (!SINGLEFLIGHT_EVENTS.has(event.type)) throw new OracleRuntimeError(`${eventLabel}.type is invalid`);
      return { ...event, invocation_id: requireString(event.invocation_id, `${eventLabel}.invocation_id`), observed_ms: timestampMs(event.observed_at, `${eventLabel}.observed_at`) };
    });
    for (let eventIndex = 1; eventIndex < events.length; eventIndex += 1) if (events[eventIndex].observed_ms < events[eventIndex - 1].observed_ms) throw new OracleRuntimeError(`${label}.events must be timestamp-ordered`);
    if (!Number.isSafeInteger(value.configured_recovery_bound_ms) || value.configured_recovery_bound_ms <= 0) throw new OracleRuntimeError(`${label}.configured_recovery_bound_ms must be a positive integer`);
    const waiterIds = array(value.waiter_invocation_ids, `${label}.waiter_invocation_ids`).map((id, waiterIndex) => requireString(id, `${label}.waiter_invocation_ids[${waiterIndex}]`));
    if (waiterIds.length === 0 || new Set(waiterIds).size !== waiterIds.length) throw new OracleRuntimeError(`${label}.waiter_invocation_ids must contain unique waiters`);
    if (value.recovery !== undefined && value.recovery !== null
      && !['dead_owner', 'stop_cancel'].includes(value.recovery)) {
      throw new OracleRuntimeError(`${label}.recovery is invalid`);
    }
    return {
      id: requireString(value.id, `${label}.id`), key: exactKeyShape(value.key, `${label}.key`),
      owner_invocation_id: requireString(value.owner_invocation_id, `${label}.owner_invocation_id`),
      waiter_invocation_ids: waiterIds, configured_recovery_bound_ms: value.configured_recovery_bound_ms,
      recovery: value.recovery ?? null, events,
    };
  });
  const specialExits = array(artifact.special_exit_observations, 'suite_observations.special_exit_observations').map((raw, index) => {
    const label = `suite_observations.special_exit_observations[${index}]`;
    const value = object(raw, label);
    if (![86, 87, 88].includes(value.shim_exit_code)) throw new OracleRuntimeError(`${label}.shim_exit_code must be 86, 87, or 88`);
    if (value.command_exit_code !== null && !Number.isSafeInteger(value.command_exit_code)) throw new OracleRuntimeError(`${label}.command_exit_code must be null or an integer`);
    if (value.ledger_row_id !== null && (!Number.isSafeInteger(value.ledger_row_id) || value.ledger_row_id <= 0)) throw new OracleRuntimeError(`${label}.ledger_row_id must be null or positive`);
    for (const field of ['interrupted', 'tracked_dirty', 'junk_probe_tracked']) if (typeof value[field] !== 'boolean') throw new OracleRuntimeError(`${label}.${field} must be boolean`);
    return {
      ...value, ...exactKeyShape(value, label), invocation_id: requireString(value.invocation_id, `${label}.invocation_id`),
      observed_ms: timestampMs(value.observed_at, `${label}.observed_at`),
      pre_tree_hash: requireOid(value.pre_tree_hash, `${label}.pre_tree_hash`), post_tree_hash: requireOid(value.post_tree_hash, `${label}.post_tree_hash`),
    };
  });
  return { rows, ttl_green_ms: artifact.ttl_green_ms, originIdentities, singleflight, specialExits };
}

function inspectArchive(invocation) {
  const options = { cwd: invocation.campaignRoot, encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, LC_ALL: 'C' } };
  const names = spawnSync('/usr/bin/tar', ['--list', '--file', invocation.evidencePaths.git_bundle], options);
  const verbose = spawnSync('/usr/bin/tar', ['--list', '--verbose', '--numeric-owner', '--file', invocation.evidencePaths.git_bundle], options);
  for (const result of [names, verbose]) {
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new OracleRuntimeError(`cannot inspect git snapshot: ${result.error?.message ?? result.stderr?.trim() ?? result.signal}`);
  }
  for (const name of names.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = (name.startsWith('./') ? name.slice(2) : name).replace(/\/$/, '');
    if (normalized !== '' && (path.posix.isAbsolute(normalized) || normalized.includes('\\') || normalized.split('/').some((part) => part === '' || part === '..'))) {
      throw new OracleRuntimeError('git snapshot contains an unsafe archive path');
    }
  }
  if (verbose.stdout.split(/\r?\n/).filter(Boolean).some((line) => !['-', 'd'].includes(line[0]))) throw new OracleRuntimeError('git snapshot archive may contain only regular files and directories');
}
function extractGit(invocation) {
  inspectArchive(invocation);
  const destination = path.join(invocation.evidenceDir, `.o9-git-${process.pid}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const result = spawnSync('/usr/bin/tar', ['--extract', '--file', invocation.evidencePaths.git_bundle, '--directory', destination, '--no-same-owner', '--no-same-permissions'], {
    cwd: invocation.campaignRoot, encoding: 'utf8', shell: false, timeout: 5000, env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw new OracleRuntimeError(`cannot extract git snapshot: ${result.error?.message ?? result.stderr?.trim() ?? result.signal}`);
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new OracleRuntimeError('git snapshot contains unsafe extracted entries');
      if (entry.isDirectory()) walk(child);
    }
  };
  try {
    walk(destination);
    for (const unsafe of ['objects/info/alternates', 'objects/info/http-alternates', 'refs/replace']) {
      if (fs.existsSync(path.join(destination, unsafe))) throw new OracleRuntimeError(`git snapshot contains forbidden external-object mechanism ${unsafe}`);
    }
    return destination;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function addStateFinding(findings, invocationId, expected, observed) {
  findings.add('O9_STATE_ORDER', 'shim invocation did not follow lookup then execute/record or replay ordering', { invocation_id: invocationId, expected, observed });
}

export async function evaluateO9(invocation) {
  const bundleOrigins = readCaseBundleOrigins(invocation);
  if (bundleOrigins.size === 0) {
    return {
      result: 'NOT_EVALUABLE',
      findings: [],
      evidence: [writeEvidenceJson(invocation, 'o9-ledger-replay-audit.json', {
        schema_version: 1,
        not_evaluable: true,
        reason: 'launch_intent.gate_key is null and run_events carry no origin: cannot establish the case origin bundle',
      }, 'sqlite-git-and-shim-state-machine')],
    };
  }
  const parsed = readObservations(invocation.evidencePaths.suite_observations);
  if (parsed.empty) {
    return {
      result: 'NOT_EVALUABLE',
      findings: [],
      evidence: [writeEvidenceJson(invocation, 'o9-ledger-replay-audit.json', {
        schema_version: 1,
        not_evaluable: true,
        reason: 'suite_observations.rows is empty: no shim evidence for the case bundle',
      }, 'sqlite-git-and-shim-state-machine')],
    };
  }
  const {
    rows: observations, ttl_green_ms: ttl, originIdentities, singleflight, specialExits,
  } = parsed;
  const runSet = currentCaseRunSet(invocation);
  const referencedRowIds = observationReferencedLedgerRowIds(parsed);
  const ledger = readLedger(invocation.evidencePaths.suite_ledger);
  const observedOrigins = new Set([
    ...observations.map((row) => row.origin_repo),
    ...originIdentities.map((identity) => identity.origin_repo),
    ...singleflight.map((observation) => observation.key.origin_repo),
    ...specialExits.map((observation) => observation.origin_repo),
  ]);
  const skippedForeign = ledger.filter((row) => !bundleOrigins.has(row.origin_repo));
  const skippedStale = ledger.filter((row) => bundleOrigins.has(row.origin_repo) && !isCurrentAttemptRow(row, runSet, referencedRowIds));
  const inScopeLedger = ledger.filter((row) => bundleOrigins.has(row.origin_repo) && isCurrentAttemptRow(row, runSet, referencedRowIds));
  const databaseLedger = readDatabaseLedger(invocation, bundleOrigins, runSet, referencedRowIds);
  if (JSON.stringify(inScopeLedger) !== JSON.stringify(databaseLedger)) throw new OracleRuntimeError('suite_ledger does not reconcile exactly with read-only suite_results for case-bundle origins');
  const rowsById = new Map(inScopeLedger.map((row) => [row.id, row]));
  const findings = new FindingCollector();
  const identityByOrigin = new Map(originIdentities.map((identity) => [identity.origin_repo, identity]));
  for (const origin of new Set([...inScopeLedger.map((row) => row.origin_repo), ...observedOrigins])) {
    if (!identityByOrigin.has(origin)) findings.add('O9_ORIGIN_IDENTITY_MISSING', 'suite evidence origin lacks a captured normalized identity', { origin_repo: origin });
  }

  const repository = extractGit(invocation);
  let reachableTrees;
  try {
    reachableTrees = new Set(runGit({ campaignRoot: invocation.campaignRoot, repository, args: ['log', '--all', '--format=%T'] }).stdout.split(/\r?\n/).filter(Boolean));
    for (const row of inScopeLedger) {
      const type = runGit({ campaignRoot: invocation.campaignRoot, repository, args: ['cat-file', '-t', row.tree_hash], acceptedStatuses: [0, 128] });
      if (type.status !== 0 || type.stdout.trim() !== 'tree' || !reachableTrees.has(row.tree_hash)) {
        findings.add('O9_LEDGER_TREE_UNRESOLVED', 'suite ledger tree is not a captured committed fixture tree', { ledger_row_id: row.id, tree_hash: row.tree_hash });
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }

  const invocations = new Map();
  for (const row of observations) {
    const group = invocations.get(row.invocation_id) ?? [];
    group.push(row);
    invocations.set(row.invocation_id, group);
  }
  const replayRows = [];
  const forceExecutions = [];
  for (const [invocationId, group] of invocations) {
    const phases = group.map((row) => row.phase);
    const first = group[0];
    if (group.some((row) => !sameKey(row, first) || row.force !== first.force)) {
      findings.add('O9_INVOCATION_KEY_CHANGED', 'one shim invocation changed its exact suite key or force mode', { invocation_id: invocationId });
    }
    const lookup = group.find((row) => row.phase === 'lookup');
    const execute = group.find((row) => row.phase === 'execute');
    const record = group.find((row) => row.phase === 'record');
    const replay = group.find((row) => row.phase === 'replay');
    if (lookup === undefined || phases[0] !== 'lookup') addStateFinding(findings, invocationId, 'lookup first', phases);
    if (first.force && (execute === undefined || replay !== undefined)) {
      findings.add('O9_FORCE_DID_NOT_EXECUTE', '--force invocation replayed or skipped execution', { invocation_id: invocationId, phases });
    }
    if (replay !== undefined) {
      replayRows.push(replay);
      if (phases.length !== 2 || phases[1] !== 'replay' || execute !== undefined || record !== undefined) addStateFinding(findings, invocationId, ['lookup', 'replay'], phases);
      const ledgerRow = rowsById.get(replay.ledger_row_id);
      if (ledgerRow === undefined) {
        findings.add('O9_REPLAY_ROW_MISSING', 'replay named a suite_results row absent from the captured ledger', { invocation_id: invocationId, ledger_row_id: replay.ledger_row_id });
      } else {
        if (!sameKey(replay, ledgerRow) || lookup?.latest_row_id !== ledgerRow.id) {
          findings.add('O9_REPLAY_KEY_MISMATCH', 'replay row does not match the exact lookup origin/tree/command key', { invocation_id: invocationId, ledger_row_id: ledgerRow.id });
          if (replay.origin_repo !== ledgerRow.origin_repo && replay.tree_hash === ledgerRow.tree_hash && replay.cmd_hash === ledgerRow.cmd_hash) {
            findings.add('O9_CROSS_ORIGIN_EVIDENCE', 'independent normalized origins shared evidence for identical tree and command hashes', { invocation_id: invocationId, replay_origin_repo: replay.origin_repo, ledger_origin_repo: ledgerRow.origin_repo, ledger_row_id: ledgerRow.id });
          }
        }
        if (ledgerRow.exit_code !== 0) {
          findings.add('O9_REPLAY_NOT_GREEN', 'replay used red suite evidence', { invocation_id: invocationId, ledger_row_id: ledgerRow.id, exit_code: ledgerRow.exit_code });
          findings.add('O9_REPLAY_AFTER_RED', 'red evidence was replayed instead of forcing execution', { invocation_id: invocationId, ledger_row_id: ledgerRow.id });
        }
        const age = replay.observed_ms - timestampMs(ledgerRow.created_at, `suite row ${ledgerRow.id} created_at`);
        if (age < 0 || age > ttl) findings.add('O9_REPLAY_STALE', 'replay used suite evidence outside the green TTL', { invocation_id: invocationId, ledger_row_id: ledgerRow.id, age_ms: age, ttl_ms: ttl });
      }
      if (replay.marker !== CACHE_MARKER) findings.add('O9_REPLAY_CACHE_MARKER_MISSING', 'unchanged committed-tree replay lacked the mechanical TAMANDUA-TEST CACHED observation', { invocation_id: invocationId, observed: replay.marker ?? null });
      if (replay.exit_code !== 0 || replay.committed_tree_hash !== replay.tree_hash) findings.add('O9_REPLAY_TREE_CHANGED', 'cache replay did not bind to the unchanged committed tree with exit zero', { invocation_id: invocationId });
    } else if (execute !== undefined) {
      if (execute.force) forceExecutions.push(execute);
      const drifted = execute.pre_tree_hash !== execute.post_tree_hash;
      if (execute.pre_tree_hash !== execute.tree_hash) findings.add('O9_EXECUTION_TREE_KEY_MISMATCH', 'execution pre-tree did not match the lookup key', { invocation_id: invocationId });
      if (drifted && record !== undefined) findings.add('O9_DRIFT_RECORDED', 'repository-drifted execution produced a reusable evidence row', { invocation_id: invocationId, ledger_row_id: record.ledger_row_id });
      if (!drifted && record === undefined) addStateFinding(findings, invocationId, ['lookup', 'execute', 'record'], phases);
      if (record !== undefined) {
        const ledgerRow = rowsById.get(record.ledger_row_id);
        if (ledgerRow === undefined || !sameKey(record, ledgerRow) || ledgerRow.exit_code !== execute.exit_code || record.exit_code !== execute.exit_code) {
          findings.add('O9_RECORD_MISMATCH', 'record observation does not reconcile with execution and suite_results', { invocation_id: invocationId, ledger_row_id: record.ledger_row_id });
        } else {
          const created = timestampMs(ledgerRow.created_at, `suite row ${ledgerRow.id} created_at`);
          if (created < execute.observed_ms || created > record.observed_ms) findings.add('O9_RECORD_ORDER', 'ledger row timestamp is outside execute-to-record order', { invocation_id: invocationId, ledger_row_id: ledgerRow.id });
        }
      }
    } else if (replay === undefined) {
      addStateFinding(findings, invocationId, 'lookup followed by execute or replay', phases);
    }
  }

  for (const replay of replayRows) {
    for (const execute of forceExecutions) {
      if (sameKey(replay, execute) && execute.observed_ms > replay.observed_ms && execute.exit_code !== 0) {
        findings.add('O9_MONOTONICITY_VIOLATION', 'cache replay changed the mechanically observed would-run result', { replay_invocation_id: replay.invocation_id, force_invocation_id: execute.invocation_id, would_run_exit_code: execute.exit_code });
      }
    }
  }

  for (const observation of singleflight) {
    const executeEvents = observation.events.filter((event) => event.type === 'execute_started');
    const expectedExecutions = observation.recovery === null ? 1 : 2;
    if (executeEvents.length !== expectedExecutions) findings.add('O9_SINGLEFLIGHT_EXECUTOR_COUNT', 'same-key single-flight observation had an unjustified executor count', { observation_id: observation.id, expected: expectedExecutions, observed: executeEvents.length });
    const ownerExecutions = executeEvents.filter((event) => event.invocation_id === observation.owner_invocation_id);
    if (ownerExecutions.length !== 1) findings.add('O9_SINGLEFLIGHT_EXECUTOR_COUNT', 'single-flight observation must have exactly one owner execution', { observation_id: observation.id, observed: ownerExecutions.length });
    const nonOwnerExecutions = executeEvents.filter((event) => event.invocation_id !== observation.owner_invocation_id);
    const justifiedRecoveryExecutions = nonOwnerExecutions.filter((event) => observation.waiter_invocation_ids.includes(event.invocation_id));
    if ((observation.recovery === null && nonOwnerExecutions.length !== 0)
      || (observation.recovery !== null && (nonOwnerExecutions.length !== 1 || justifiedRecoveryExecutions.length !== 1))) {
      findings.add('O9_SINGLEFLIGHT_EXECUTOR_COUNT', 'additional single-flight execution was not exactly one declared recovery waiter', { observation_id: observation.id, observed: nonOwnerExecutions.map((event) => event.invocation_id) });
    }
    const deadReclaims = observation.events.filter((event) => event.type === 'dead_owner_reclaimed');
    const ownerReleases = observation.events.filter((event) => event.type === 'owner_released');
    const ownerRecords = observation.events.filter((event) => event.type === 'record' && event.invocation_id === observation.owner_invocation_id);
    const recoveryEvents = observation.recovery === 'dead_owner' ? deadReclaims
      : observation.recovery === 'stop_cancel' ? ownerReleases : [];
    for (const waiterId of observation.waiter_invocation_ids) {
      const wait = observation.events.find((event) => event.type === 'wait' && event.invocation_id === waiterId);
      const waiterExecutions = executeEvents.filter((event) => event.invocation_id === waiterId);
      if (observation.recovery !== null && waiterExecutions.some((event) => wait === undefined
        || recoveryEvents.length !== 1 || event.observed_ms <= wait.observed_ms
        || event.observed_ms <= recoveryEvents[0].observed_ms)) {
        findings.add('O9_SINGLEFLIGHT_RECOVERY_ORDER', 'recovery waiter executed before its wait and mechanically recorded release or reclaim event', {
          observation_id: observation.id,
          waiter_invocation_id: waiterId,
          execution_times: waiterExecutions.map((event) => event.observed_at),
          wait_at: wait?.observed_at ?? null,
          recovery_at: recoveryEvents[0]?.observed_at ?? null,
        });
      }
      const outcomes = observation.events.filter((event) => ['replay', 'execute_started'].includes(event.type)
        && event.invocation_id === waiterId && (wait === undefined || event.observed_ms >= wait.observed_ms));
      if (wait === undefined || outcomes.length !== 1) {
        findings.add('O9_SINGLEFLIGHT_WAITER_UNRESOLVED', 'single-flight waiter must have one wait and exactly one terminal replay or recovery execution', {
          observation_id: observation.id, waiter_invocation_id: waiterId, terminal_outcome_count: outcomes.length,
        });
        continue;
      }
      const [outcome] = outcomes;
      if (observation.recovery === null && outcome.type !== 'replay') findings.add('O9_SINGLEFLIGHT_EXECUTOR_COUNT', 'waiter executed without timeout or recovery evidence', { observation_id: observation.id, waiter_invocation_id: waiterId });

      if (outcome.type === 'replay') {
        const row = rowsById.get(outcome.ledger_row_id);
        const ownerRow = ownerRecords.length === 1 ? rowsById.get(ownerRecords[0].ledger_row_id) : undefined;
        if (row === undefined || row.exit_code !== 0 || !sameKey(row, observation.key)
          || ownerRow === undefined || ownerRow.exit_code !== 0 || !sameKey(ownerRow, observation.key)
          || outcome.ledger_row_id !== ownerRecords[0]?.ledger_row_id
          || outcome.observed_ms <= (ownerRecords[0]?.observed_ms ?? Number.POSITIVE_INFINITY)) {
          findings.add('O9_SINGLEFLIGHT_WAITER_REPLAY_INVALID', 'waiter did not replay the mechanically recorded owner green row for the exact key', {
            observation_id: observation.id,
            waiter_invocation_id: waiterId,
            ledger_row_id: outcome.ledger_row_id ?? null,
            owner_ledger_row_id: ownerRecords[0]?.ledger_row_id ?? null,
          });
        }
      }
    }
    if (observation.recovery === 'dead_owner') {
      if (deadReclaims.length !== 1) findings.add('O9_DEAD_OWNER_RECLAIM_MISSING', 'dead-owner recovery requires exactly one suite.claim_dead_owner_reclaimed observation', { observation_id: observation.id, observed: deadReclaims.length });
      if (ownerReleases.length !== 0) findings.add('O9_DEAD_OWNER_RELEASE_CONFLATED', 'dead-owner recovery was conflated with stop/cancel release', { observation_id: observation.id });
      const wait = observation.events.find((event) => event.type === 'wait');
      const reclaim = deadReclaims[0];
      if (wait !== undefined && reclaim !== undefined && (reclaim.observed_ms < wait.observed_ms || reclaim.observed_ms - wait.observed_ms > observation.configured_recovery_bound_ms)) findings.add('O9_DEAD_OWNER_RECOVERY_BOUND', 'dead-owner recovery exceeded its configured bound', { observation_id: observation.id, elapsed_ms: reclaim.observed_ms - wait.observed_ms, bound_ms: observation.configured_recovery_bound_ms });
    }
    if (observation.recovery === 'stop_cancel') {
      if (ownerReleases.length !== 1 || !['stop', 'cancel'].includes(ownerReleases[0]?.reason)) findings.add('O9_STOP_RELEASE_MISSING', 'stop/cancel recovery requires one mechanically attributed owner release', { observation_id: observation.id });
      if (deadReclaims.length !== 0) findings.add('O9_STOP_RELEASE_EMITTED_DEAD_OWNER', 'stop/cancel release incorrectly emitted suite.claim_dead_owner_reclaimed', { observation_id: observation.id, observed: deadReclaims.length });
    }
  }

  if (specialExits.length > 0) {
    for (const code of [86, 87, 88]) {
      if (specialExits.filter((observation) => observation.shim_exit_code === code).length !== 1) findings.add('O9_SPECIAL_EXIT_COVERAGE', 'special-exit injection set must contain exactly one observation for each code', { exit_code: code });
    }
    for (const observation of specialExits) {
      const ledgerRow = observation.ledger_row_id === null ? undefined : rowsById.get(observation.ledger_row_id);
      if (observation.junk_probe_tracked) findings.add('O9_JUNK_PROBE_TRACKED', 'special-exit run left its junk probe tracked', { invocation_id: observation.invocation_id, exit_code: observation.shim_exit_code });
      if (observation.shim_exit_code === 86 && (observation.command_exit_code !== 0 || observation.interrupted
        || observation.tracked_dirty || observation.pre_tree_hash === observation.post_tree_hash || ledgerRow !== undefined)) {
        findings.add('O9_SPECIAL_EXIT_ROW_FORBIDDEN', 'exit 86 must describe uninterrupted passing-command tree drift and create no ledger row', { invocation_id: observation.invocation_id, ledger_row_id: observation.ledger_row_id });
      }
      if (observation.shim_exit_code === 87 && (observation.command_exit_code !== 87 || !observation.interrupted
        || observation.tracked_dirty || observation.pre_tree_hash !== observation.post_tree_hash
        || ledgerRow?.exit_code !== 87 || !sameKey(observation, ledgerRow))) {
        findings.add('O9_INTERRUPTED_EVIDENCE_INVALID', 'exit 87 must record one interrupted red-87 row for the stable exact key', { invocation_id: observation.invocation_id, ledger_row_id: observation.ledger_row_id });
      }
      if (observation.shim_exit_code === 88 && (!observation.tracked_dirty || observation.interrupted
        || observation.command_exit_code !== null || observation.pre_tree_hash !== observation.post_tree_hash || ledgerRow !== undefined)) {
        findings.add('O9_SPECIAL_EXIT_ROW_FORBIDDEN', 'exit 88 must refuse a pre-dirty tree before command execution and create no ledger row', { invocation_id: observation.invocation_id, ledger_row_id: observation.ledger_row_id });
      }
    }
  }

  const evidence = [writeEvidenceJson(invocation, 'o9-ledger-replay-audit.json', {
    schema_version: 1,
    ledger_reconciled: true,
    ledger_row_count: inScopeLedger.length,
    skipped_foreign_rows: skippedForeign.length,
    skipped_foreign_row_ids: skippedForeign.map((row) => row.id),
    skipped_stale_rows: skippedStale.length,
    skipped_stale_row_ids: skippedStale.map((row) => row.id),
    committed_tree_count: reachableTrees.size,
    observation_count: observations.length,
    invocation_count: invocations.size,
    replay_count: replayRows.length,
    force_execution_count: forceExecutions.length,
    singleflight_observation_count: singleflight.length,
    special_exit_observation_count: specialExits.length,
    origin_identity_count: originIdentities.length,
    ttl_green_ms: ttl,
  }, 'sqlite-git-and-shim-state-machine')];
  return { result: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.toJSON(), evidence };
}
