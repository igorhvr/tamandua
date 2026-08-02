import fs from 'node:fs';
import path from 'node:path';

import { pathIsWithin } from './paths.mjs';

export const RESULT_EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2 });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isPortableRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isUtc(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function validateOracleResponse(response, oracleId, exitCode, evidenceDir) {
  const errors = [];
  if (!isObject(response)) return ['response must be one JSON object'];
  const allowedTopLevel = new Set(['contract_version', 'oracle_id', 'result', 'started_at', 'finished_at', 'findings', 'evidence', 'classification']);
  for (const key of Object.keys(response)) {
    if (!allowedTopLevel.has(key)) errors.push(`response contains unknown property ${key}`);
  }
  if (response.contract_version !== 1) errors.push('contract_version must be 1');
  if (response.oracle_id !== oracleId) errors.push('oracle_id does not match the invoked oracle');
  if (!Object.hasOwn(RESULT_EXIT_CODES, response.result)) errors.push('result must be PASS, FAIL, or ERROR');
  if (!isUtc(response.started_at)) errors.push('started_at must be a UTC ISO-8601 timestamp');
  if (!isUtc(response.finished_at)) errors.push('finished_at must be a UTC ISO-8601 timestamp');
  if (isUtc(response.started_at) && isUtc(response.finished_at) && response.finished_at < response.started_at) errors.push('finished_at must not precede started_at');
  if (!Array.isArray(response.findings)) errors.push('findings must be an array');
  else {
    response.findings.forEach((finding, index) => {
      if (!isObject(finding) || typeof finding.id !== 'string' || finding.id.length === 0
          || typeof finding.summary !== 'string' || finding.summary.length === 0) errors.push(`findings[${index}] must contain nonempty id and summary strings`);
    });
    if (response.result === 'PASS' && response.findings.length !== 0) errors.push('PASS must not contain findings');
    if (response.result === 'FAIL' && response.findings.length === 0) errors.push('FAIL must contain a finding');
  }
  if (!Array.isArray(response.evidence)) errors.push('evidence must be an array');
  else response.evidence.forEach((reference, index) => {
    if (!hasOnlyKeys(reference, ['path', 'kind'])) {
      errors.push(`evidence[${index}] contains unknown properties`);
      return;
    }
    if (!isPortableRelative(reference.path)
        || typeof reference.kind !== 'string' || reference.kind.length === 0) {
      errors.push(`evidence[${index}] must contain a portable relative path and nonempty kind`);
      return;
    }
    const candidate = path.resolve(evidenceDir, reference.path);
    try {
      const root = fs.realpathSync(evidenceDir);
      const details = fs.lstatSync(candidate);
      if (!details.isFile() || details.isSymbolicLink() || !pathIsWithin(root, fs.realpathSync(candidate))) errors.push(`evidence[${index}].path is not a contained regular file`);
    } catch {
      errors.push(`evidence[${index}].path does not exist`);
    }
  });
  if (response.classification !== undefined) {
    const classification = response.classification;
    if (!isObject(classification)) {
      errors.push('classification must be an object');
    } else {
      const allowed = new Set(['manipulation_checks', 'provider_failure', 'expectation_met', 'agent_task_succeeded', 'ambiguous']);
      for (const key of Object.keys(classification)) {
        if (!allowed.has(key)) errors.push(`classification contains unknown property ${key}`);
      }
      if (classification.manipulation_checks !== undefined
          && (!Array.isArray(classification.manipulation_checks)
            || classification.manipulation_checks.some((check) => !hasOnlyKeys(check, ['id', 'engaged', 'required'])
              || typeof check.id !== 'string' || check.id.length === 0
              || typeof check.engaged !== 'boolean'
              || (check.required !== undefined && typeof check.required !== 'boolean')))) {
        errors.push('classification.manipulation_checks must contain structured checks');
      }
      if (classification.provider_failure !== undefined
          && (!hasOnlyKeys(classification.provider_failure, ['identified', 'injected', 'kind'])
            || classification.provider_failure.identified !== true
            || typeof classification.provider_failure.injected !== 'boolean'
            || typeof classification.provider_failure.kind !== 'string'
            || classification.provider_failure.kind.length === 0)) {
        errors.push('classification.provider_failure must identify a structured provider failure');
      }
      for (const key of ['expectation_met', 'agent_task_succeeded']) {
        if (classification[key] !== undefined && typeof classification[key] !== 'boolean') errors.push(`classification.${key} must be boolean`);
      }
      if (classification.ambiguous !== undefined
          && (!hasOnlyKeys(classification.ambiguous, ['category'])
            || typeof classification.ambiguous.category !== 'string'
            || classification.ambiguous.category.length === 0)) {
        errors.push('classification.ambiguous contains unknown properties or lacks a category');
      }
    }
  }
  const expected = RESULT_EXIT_CODES[response.result];
  if (expected !== undefined && expected !== exitCode) errors.push(`exit code ${exitCode} contradicts result ${response.result} (expected ${expected})`);
  return errors;
}

export function buildOracleResponse({ oracleId, result, startedAt, findings = [], evidence = [], classification }) {
  const response = {
    contract_version: 1,
    oracle_id: oracleId,
    result,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    findings,
    evidence,
  };
  if (classification !== undefined) response.classification = classification;
  return response;
}
