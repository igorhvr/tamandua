#!/usr/bin/env node
// post-batch.mjs — shared runtime for the post-batch hygiene oracle wrappers
// (O5, O6).
//
// The v1 oracle executable contract (CONTRACT.md) describes the PER-CASE
// invocation (`--contract-version 1 --context ...`). The post-batch hygiene
// oracles are CAMPAIGN-WIDE (spec 03: post-batch, mandatory in W6) and their
// required host inventory has no slot in the v1 per-case context
// (mechanical_evidence.references carries the fixed gating evidence-key set),
// so they consume the NARROW, EXPLICITLY VERSIONED companion input defined in
// hygiene-sidecar.mjs + POST-BATCH-CONTRACT.md:
//
//   oracles/<id> --contract-version 1 --sidecar <absolute-sidecar-path>
//
// Output is the SAME version-1 oracle response shape and exit codes as the
// per-case oracles (contract_version 1, result in PASS/FAIL/ERROR/
// NOT_EVALUABLE, exit 0/1/2/3, evidence paths relative to the evidence
// directory), so controller-side consumers, the self-test harness and the
// report pipeline treat a post-batch oracle exactly like any other oracle.
//
// The evidence directory is TT_ORACLE_EVIDENCE_DIR when the controller
// supplies one, else the sidecar file's own directory. Evidence entries are
// only ever REFERENCES to sidecar-declared raw capture artifacts that already
// exist (the checker never writes, never captures, never kills — see the
// read-only rules in POST-BATCH-CONTRACT.md).

import path from 'node:path';

import { loadHygieneSidecar } from './hygiene-sidecar.mjs';
import { OracleRuntimeError, requireContainedPath } from './paths.mjs';
import { buildOracleResponse, validateOracleResponse, RESULT_EXIT_CODES } from './output.mjs';

export function parsePostBatchArgs(argv) {
  const args = argv.slice(2);
  if (args.length !== 4 || args[0] !== '--contract-version' || args[2] !== '--sidecar') {
    throw new OracleRuntimeError('argv must be exactly --contract-version 1 --sidecar <absolute-sidecar-path>');
  }
  if (args[1] !== '1') throw new OracleRuntimeError(`unsupported contract version ${args[1]}`);
  if (!path.isAbsolute(args[3])) throw new OracleRuntimeError('sidecar path must be absolute');
  return { version: args[1], sidecarPath: path.resolve(args[3]) };
}

function resolveEvidenceDir(sidecarPath, env) {
  const fromEnv = env.TT_ORACLE_EVIDENCE_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!path.isAbsolute(fromEnv)) throw new OracleRuntimeError('TT_ORACLE_EVIDENCE_DIR must be absolute');
    return path.resolve(fromEnv);
  }
  return path.dirname(sidecarPath);
}

export async function runPostBatchOracle({ oracleId, evaluate, argv = process.argv, env = process.env }) {
  const startedAt = new Date().toISOString();
  let response;
  try {
    const parsed = parsePostBatchArgs(argv);
    if (env.TT_ORACLE_CONTRACT_VERSION !== undefined && env.TT_ORACLE_CONTRACT_VERSION !== '1') {
      throw new OracleRuntimeError('TT_ORACLE_CONTRACT_VERSION must be 1 when set');
    }
    if (env.TT_ORACLE_ID !== undefined && env.TT_ORACLE_ID !== oracleId) {
      throw new OracleRuntimeError(`TT_ORACLE_ID ${env.TT_ORACLE_ID} does not match ${oracleId}`);
    }
    const evidenceDir = resolveEvidenceDir(parsed.sidecarPath, env);
    const invocation = Object.freeze({
      ...loadHygieneSidecar(parsed.sidecarPath),
      evidenceDir,
    });
    const outcome = await evaluate(invocation);
    let findings = outcome?.findings ?? [];
    const result = outcome?.result ?? (findings.length === 0 ? 'PASS' : 'FAIL');
    // NOT_EVALUABLE may not carry findings (output contract,
    // validateOracleResponse): informational (non_failing) findings emitted by
    // an evaluator before it knew the final result are stripped here so a
    // clean-but-unresolved analysis returns NOT_EVALUABLE (exit 3) instead of
    // escalating to ERROR. They remain preserved in the evaluator's own summary
    // evidence file. A FAILING finding on a NOT_EVALUABLE result is an
    // evaluator contradiction and is NOT stripped — it surfaces loudly through
    // response validation as ERROR.
    if (result === 'NOT_EVALUABLE') {
      findings = findings.filter((finding) => finding.non_failing !== true);
    }
    // Evidence references must name existing contained regular files beneath
    // the evidence dir. evaluate returns only paths of files it created
    // (exclusive create into the evidence dir) or sidecar evidence_files.
    const evidence = [];
    for (const entry of outcome?.evidence ?? []) {
      if (typeof entry?.path !== 'string' || typeof entry?.kind !== 'string' || entry.kind.length === 0) {
        throw new OracleRuntimeError('evaluator evidence entries must carry nonempty path and kind');
      }
      requireContainedPath(evidenceDir, path.resolve(evidenceDir, entry.path), { kind: 'file', label: 'evidence' });
      evidence.push({ path: entry.path, kind: entry.kind });
    }
    response = buildOracleResponse({
      oracleId,
      result,
      startedAt,
      findings,
      evidence,
      classification: outcome?.classification,
    });
    const expectedExit = RESULT_EXIT_CODES[response.result];
    const validationErrors = validateOracleResponse(response, oracleId, expectedExit, evidenceDir);
    if (validationErrors.length > 0) throw new Error(`post-batch oracle produced an invalid outcome: ${validationErrors.join('; ')}`);
  } catch (error) {
    response = buildOracleResponse({
      oracleId,
      result: 'ERROR',
      startedAt,
      findings: [{ id: 'ORACLE_RUNTIME_ERROR', summary: error instanceof Error ? error.message : String(error) }],
      evidence: [],
    });
  }
  const exitCode = RESULT_EXIT_CODES[response.result];
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = exitCode;
  return response;
}
