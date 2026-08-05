import fs from 'node:fs';

import { writeEvidenceJson } from './evidence.mjs';
import { OracleRuntimeError } from './paths.mjs';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function readProof(invocation) {
  const proofPath = invocation.evidencePaths.database_snapshot;
  let proof;
  try {
    proof = object(JSON.parse(fs.readFileSync(proofPath, 'utf8')), 'local-case proof');
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse local-case proof: ${error.message}`, { cause: error });
  }
  if (proof.schema_version !== 1 || proof.profile !== 'local-case') {
    throw new OracleRuntimeError('local-case proof must use schema_version 1 and profile local-case');
  }
  if (proof.case_id !== invocation.context.case.id) throw new OracleRuntimeError('local-case proof case identity mismatch');
  if (!Array.isArray(proof.declared_oracles) || !proof.declared_oracles.includes(invocation.oracleId)) {
    throw new OracleRuntimeError('local-case proof does not declare the invoked oracle');
  }
  const attempt = invocation.context.attempts.at(-1);
  if (attempt?.kind !== 'local' || attempt.run_id !== null || attempt.command_result === null) {
    throw new OracleRuntimeError('local-case profile requires one durable local command attempt without a workflow run ID');
  }
  if (JSON.stringify(proof.command_result) !== JSON.stringify(attempt.command_result)) {
    throw new OracleRuntimeError('local-case command result does not match the immutable attempt projection');
  }
  return proof;
}

export function evaluateLocalCase(invocation) {
  const proof = readProof(invocation);
  const checks = object(proof.checks, 'local-case proof checks');
  const failed = [];
  if (checks.command_passed !== true) failed.push('command_passed');
  if (checks.scenario_passed !== true) failed.push('scenario_passed');
  if (invocation.oracleId === 'O3z' && checks.token_gate_passed !== true) failed.push('token_gate_passed');
  const filename = invocation.oracleId === 'O3z' ? 'o3z-token-gate.json' : 'local-scenario-verdict.json';
  const evidence = writeEvidenceJson(invocation, filename, {
    schema_version: 1,
    captured_at: proof.captured_at,
    oracle_id: invocation.oracleId,
    case_id: proof.case_id,
    scenario_id: proof.scenario_id,
    scenario_result: proof.scenario_result,
    token_values: proof.token_values,
    runs: proof.runs,
    system_tokens: proof.system_tokens,
    checks: {
      ...checks,
      declared: proof.declared_oracles.includes(invocation.oracleId),
    },
  }, invocation.oracleId === 'O3z' ? 'zero-token-reconciliation' : 'local-scenario-mechanical-proof');
  return {
    result: failed.length === 0 ? 'PASS' : 'FAIL',
    findings: failed.map((check) => ({
      id: 'LOCAL_SCENARIO_EVIDENCE_FAILED',
      summary: `local-case mechanical check failed: ${check}`,
    })),
    evidence: [evidence],
  };
}