import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ORACLE_EVIDENCE_KEYS, REQUIRED_ORACLE_EVIDENCE, validateOracleContext } from '../../bin/oracle-context.mjs';
import { OracleRuntimeError, findCampaignRoot, requireContainedPath, resolveEvidenceReference } from './paths.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

const ATTEMPT_KEYS = ['id', 'kind', 'phase', 'execution_mode', 'run_id', 'started_at', 'terminal_at', 'terminal_status', 'tokens_observed', 'command_result', 'steps_snapshot', 'straggler_capture'];
const STEP_KEYS = new Set([
  'stepId', 'step_id', 'agentId', 'agent_id', 'agentRole', 'status', 'displayStatus', 'display_status', 'type', 'currentStoryId',
  'current_story_id', 'retryCount', 'retry_count', 'stepIndex', 'step_index',
  'abandonedCount', 'abandoned_count', 'rerouteCount', 'reroute_count', 'claimPid',
  'claim_pid', 'claimUpdatedAt', 'claim_updated_at', 'updatedAt', 'updated_at',
]);
const STEP_STATUSES = new Set(['waiting', 'pending', 'running', 'done', 'failed', 'canceled']);
const STEP_TYPES = new Set(['single', 'loop']);

function aliasesAgree(value, camel, snake) {
  return value[camel] === undefined || value[snake] === undefined || value[camel] === value[snake];
}

function validateStepsSnapshot(snapshot) {
  if (snapshot === null) return true;
  return hasExactKeys(snapshot, ['source', 'captured_at', 'steps'])
    && typeof snapshot.source === 'string' && snapshot.source.length > 0
    && isUtcTimestamp(snapshot.captured_at) && Array.isArray(snapshot.steps)
    && snapshot.steps.every(validateStep);
}

function validateStep(step) {
  if (!isObject(step) || !Object.keys(step).every((key) => STEP_KEYS.has(key))) return false;
  const id = step.stepId ?? step.step_id;
  const agentId = step.agentId ?? step.agent_id ?? step.agentRole;
  if (typeof id !== 'string' || id.length === 0 || typeof agentId !== 'string' || agentId.length === 0
      || !STEP_STATUSES.has(step.status) || (step.type !== undefined && !STEP_TYPES.has(step.type))) return false;
  for (const [camel, snake] of [
    ['stepId', 'step_id'], ['agentId', 'agent_id'], ['currentStoryId', 'current_story_id'],
    ['displayStatus', 'display_status'],
    ['retryCount', 'retry_count'], ['stepIndex', 'step_index'], ['abandonedCount', 'abandoned_count'],
    ['rerouteCount', 'reroute_count'], ['claimPid', 'claim_pid'],
    ['claimUpdatedAt', 'claim_updated_at'], ['updatedAt', 'updated_at'],
  ]) {
    if (!aliasesAgree(step, camel, snake)) return false;
  }
  for (const key of ['stepId', 'step_id', 'agentId', 'agent_id', 'agentRole']) {
    if (step[key] !== undefined && (typeof step[key] !== 'string' || step[key].length === 0)) return false;
  }
  for (const key of ['currentStoryId', 'current_story_id']) {
    if (step[key] !== undefined && step[key] !== null && (typeof step[key] !== 'string' || step[key].length === 0)) return false;
  }
  for (const key of ['displayStatus', 'display_status']) {
    if (step[key] !== undefined && (typeof step[key] !== 'string' || step[key].length === 0)) return false;
  }
  for (const key of ['retryCount', 'retry_count', 'stepIndex', 'step_index', 'abandonedCount', 'abandoned_count', 'rerouteCount', 'reroute_count']) {
    if (step[key] !== undefined && (!Number.isSafeInteger(step[key]) || step[key] < 0)) return false;
  }
  for (const key of ['claimPid', 'claim_pid']) {
    if (step[key] !== undefined && step[key] !== null && (!Number.isSafeInteger(step[key]) || step[key] <= 0)) return false;
  }
  for (const key of ['claimUpdatedAt', 'claim_updated_at', 'updatedAt', 'updated_at']) {
    if (step[key] !== undefined && step[key] !== null && !isUtcTimestamp(step[key])) return false;
  }
  return true;
}

function validateStragglerCapture(capture) {
  if (capture === null) return true;
  return hasExactKeys(capture, ['captured_at', 'stop_intent_at', 'reason', 'steps_snapshot'])
    && isUtcTimestamp(capture.captured_at)
    && capture.stop_intent_at === capture.captured_at
    && hasExactKeys(capture.reason, ['cap', 'threshold', 'observed'])
    && typeof capture.reason.cap === 'string' && capture.reason.cap.length > 0
    && Number.isFinite(capture.reason.threshold) && capture.reason.threshold >= 0
    && Number.isFinite(capture.reason.observed) && capture.reason.observed >= 0
    && validateStepsSnapshot(capture.steps_snapshot);
}

function validateAttempt(attempt, discovered = false) {
  const keys = discovered ? [...ATTEMPT_KEYS, 'parent_run_id'] : ATTEMPT_KEYS;
  const valid = hasExactKeys(attempt, keys)
    && typeof attempt.id === 'string' && attempt.id.length > 0
    && typeof attempt.kind === 'string' && attempt.kind.length > 0
    && typeof attempt.phase === 'string' && attempt.phase.length > 0
    && ['real', 'scripted'].includes(attempt.execution_mode)
    && (attempt.run_id === null || (typeof attempt.run_id === 'string' && attempt.run_id.length > 0))
    && isUtcTimestamp(attempt.started_at)
    && (attempt.terminal_at === null || isUtcTimestamp(attempt.terminal_at))
    && (attempt.terminal_status === null || (typeof attempt.terminal_status === 'string' && attempt.terminal_status.length > 0))
    && Number.isSafeInteger(attempt.tokens_observed) && attempt.tokens_observed >= 0
    && (attempt.command_result === null || (hasExactKeys(attempt.command_result, ['exit_code', 'signal'])
      && (attempt.command_result.exit_code === null || Number.isInteger(attempt.command_result.exit_code))
      && (attempt.command_result.signal === null || typeof attempt.command_result.signal === 'string')))
    && validateStepsSnapshot(attempt.steps_snapshot)
    && validateStragglerCapture(attempt.straggler_capture)
    && (!discovered || (typeof attempt.parent_run_id === 'string' && attempt.parent_run_id.length > 0));
  if (!valid || ((attempt.terminal_at === null) !== (attempt.terminal_status === null))) return false;
  return attempt.terminal_at === null || attempt.terminal_at >= attempt.started_at;
}

function validateO1Wave(wave) {
  return hasExactKeys(wave, ['schema_version', 'wave', 'duration_floors', 'runs'])
    && wave.schema_version === 1
    && Number.isSafeInteger(wave.wave) && wave.wave >= 0
    && Array.isArray(wave.duration_floors)
    && wave.duration_floors.every((floor) => hasExactKeys(floor, ['workflow', 'duration_floor_ms', 'source', 'sample_size'])
      && typeof floor.workflow === 'string' && floor.workflow.length > 0
      && (floor.duration_floor_ms === null || (Number.isFinite(floor.duration_floor_ms) && floor.duration_floor_ms > 0))
      && ['w1-median', 'production-median', 'unavailable'].includes(floor.source)
      && Number.isSafeInteger(floor.sample_size) && floor.sample_size >= 0)
    && Array.isArray(wave.runs)
    && wave.runs.every((run) => hasExactKeys(run, ['case_id', 'run_id', 'workflow', 'started_at', 'terminal_at', 'terminal_status', 'expected_fast_failure'])
      && ['case_id', 'run_id', 'workflow'].every((key) => typeof run[key] === 'string' && run[key].length > 0)
      && isUtcTimestamp(run.started_at)
      && (run.terminal_at === null || isUtcTimestamp(run.terminal_at))
      && (run.terminal_status === null || typeof run.terminal_status === 'string')
      && ((run.terminal_at === null) === (run.terminal_status === null))
      && typeof run.expected_fast_failure === 'boolean');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length !== 4 || args[0] !== '--contract-version' || args[2] !== '--context') {
    throw new OracleRuntimeError('argv must be exactly --contract-version 1 --context <absolute-path>');
  }
  if (args[1] !== '1') throw new OracleRuntimeError(`unsupported contract version ${args[1]}`);
  if (!path.isAbsolute(args[3])) throw new OracleRuntimeError('context path must be absolute');
  return { version: args[1], contextPath: path.resolve(args[3]) };
}

function requireEnv(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${key} is required`);
  return value;
}

function validateTopLevel(context) {
  const exact = ['contract_version', 'oracle_id', 'campaign', 'case', 'run_id', 'attempts', 'discovered_runs', 'o1_wave', 'mechanical_evidence'];
  if (!hasExactKeys(context, exact)) {
    throw new OracleRuntimeError('malformed context: top-level CONTRACT v1 shape is required');
  }
  if (!hasExactKeys(context.campaign, ['id', 'created_at', 'manifest'])
      || typeof context.campaign.id !== 'string' || context.campaign.id.length === 0
      || !isUtcTimestamp(context.campaign.created_at)
      || !hasExactKeys(context.campaign.manifest, ['sha256', 'case_count', 'case_ids'])
      || !/^[a-f0-9]{64}$/.test(context.campaign.manifest.sha256)
      || !Number.isSafeInteger(context.campaign.manifest.case_count) || context.campaign.manifest.case_count < 0
      || !Array.isArray(context.campaign.manifest.case_ids)
      || context.campaign.manifest.case_ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new OracleRuntimeError('malformed context campaign identity');
  }
  if (!hasExactKeys(context.case, ['id', 'wave', 'workflow', 'fixture', 'harness', 'class', 'caps', 'boundary_files', 'forbidden', 'chaos'])
      || typeof context.case.id !== 'string' || context.case.id.length === 0
      || !Number.isSafeInteger(context.case.wave) || context.case.wave < 0
      || ['workflow', 'fixture', 'harness', 'class'].some((key) => typeof context.case[key] !== 'string' || context.case[key].length === 0)
      || !hasExactKeys(context.case.caps, ['tokens', 'wall_min'])
      || !Number.isFinite(context.case.caps.tokens) || context.case.caps.tokens < 0
      || !Number.isFinite(context.case.caps.wall_min) || context.case.caps.wall_min < 0
      || !Array.isArray(context.case.boundary_files) || context.case.boundary_files.some((item) => typeof item !== 'string')
      || !Array.isArray(context.case.forbidden) || context.case.forbidden.some((item) => typeof item !== 'string')
      || (context.case.chaos !== null && !isObject(context.case.chaos))) {
    throw new OracleRuntimeError('malformed context case metadata');
  }
  if ((context.run_id !== null && (typeof context.run_id !== 'string' || context.run_id.length === 0))
      || !Array.isArray(context.attempts) || !context.attempts.every((attempt) => validateAttempt(attempt))
      || !Array.isArray(context.discovered_runs) || !context.discovered_runs.every((attempt) => validateAttempt(attempt, true))
      || !validateO1Wave(context.o1_wave)) {
    throw new OracleRuntimeError('malformed context attempt projections');
  }
  const references = context.mechanical_evidence?.references;
  if (!hasExactKeys(context.mechanical_evidence, ['schema_version', 'references'])
      || !hasExactKeys(references, ORACLE_EVIDENCE_KEYS)
      || Object.values(references).some((reference) => reference !== null
        && !hasExactKeys(reference, ['path', 'sha256', 'captured_at', 'source']))) {
    throw new OracleRuntimeError('malformed context mechanical evidence references');
  }
}

export function loadOracleInvocation({ argv = process.argv, env = process.env } = {}) {
  const parsed = parseArgs(argv);
  if (requireEnv(env, 'TT_ORACLE_CONTRACT_VERSION') !== '1') throw new OracleRuntimeError('TT_ORACLE_CONTRACT_VERSION must be 1');
  if (requireEnv(env, 'TT_ORACLE_CONTEXT') !== parsed.contextPath) throw new OracleRuntimeError('context argv and TT_ORACLE_CONTEXT mismatch');
  const contextPath = parsed.contextPath;
  const campaignRoot = findCampaignRoot(contextPath);
  requireContainedPath(campaignRoot, contextPath, { kind: 'file', label: 'context' });
  let context;
  try {
    context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  } catch (error) {
    throw new OracleRuntimeError(`malformed context JSON: ${error.message}`, { cause: error });
  }
  validateTopLevel(context);
  const oracleId = requireEnv(env, 'TT_ORACLE_ID');
  if (context.contract_version !== 1) throw new OracleRuntimeError('context contract_version must be 1');
  if (context.oracle_id !== oracleId) throw new OracleRuntimeError('oracle ID mismatch between context and environment');
  if (context.case.id !== requireEnv(env, 'TT_CASE_ID')) throw new OracleRuntimeError('case ID mismatch between context and environment');
  if (context.campaign.id !== requireEnv(env, 'TT_CAMPAIGN_ID')) throw new OracleRuntimeError('campaign ID mismatch between context and environment');
  if ((context.run_id ?? undefined) !== env.TT_RUN_ID) throw new OracleRuntimeError('run ID mismatch between context and environment');
  const contextErrors = validateOracleContext(context, campaignRoot, { requireOracleEvidence: true });
  if (contextErrors.length > 0) throw new OracleRuntimeError(`invalid oracle context: ${contextErrors.join('; ')}`);

  const evidenceDirInput = requireEnv(env, 'TT_ORACLE_EVIDENCE_DIR');
  if (!path.isAbsolute(evidenceDirInput)) throw new OracleRuntimeError('TT_ORACLE_EVIDENCE_DIR must be absolute');
  const evidenceDir = requireContainedPath(campaignRoot, evidenceDirInput, { kind: 'directory', label: 'TT_ORACLE_EVIDENCE_DIR' });
  const evidencePaths = {};
  for (const key of ORACLE_EVIDENCE_KEYS) {
    const reference = context.mechanical_evidence.references[key];
    if (reference !== null) {
      const evidencePath = resolveEvidenceReference(campaignRoot, reference, `mechanical_evidence.references.${key}`);
      const actual = createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex');
      if (actual !== reference.sha256) throw new OracleRuntimeError(`${key} SHA-256 mismatch`);
      if (key === 'database_snapshot' && (fs.statSync(evidencePath).mode & 0o222) !== 0) {
        throw new OracleRuntimeError('database_snapshot is writable; read-only mechanical evidence is required');
      }
      evidencePaths[key] = evidencePath;
    }
  }
  for (const key of REQUIRED_ORACLE_EVIDENCE[oracleId] ?? []) {
    if (evidencePaths[key] === undefined) throw new OracleRuntimeError(`${key} required evidence is missing`);
  }
  const suppliedReferences = Object.values(context.mechanical_evidence.references).filter((reference) => reference !== null);
  const localCaseProfile = suppliedReferences.length > 0
    && suppliedReferences.every((reference) => reference.source === 'controller-local-case'
      && reference.path === suppliedReferences[0].path
      && reference.sha256 === suppliedReferences[0].sha256);
  if (suppliedReferences.some((reference) => reference.source === 'controller-local-case') && !localCaseProfile) {
    throw new OracleRuntimeError('local-case evidence references must all identify one immutable proof');
  }
  return Object.freeze({
    context, contextPath, campaignRoot, evidenceDir, evidencePaths: Object.freeze(evidencePaths),
    oracleId, localCaseProfile,
  });
}
