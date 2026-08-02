import { loadOracleInvocation } from './context.mjs';
import { buildOracleResponse, RESULT_EXIT_CODES, validateOracleResponse } from './output.mjs';

export async function oracleMain(check, options = {}) {
  const startedAt = new Date().toISOString();
  let invocation;
  let response;
  try {
    invocation = loadOracleInvocation(options);
    const outcome = await check(invocation);
    const findings = outcome?.findings ?? [];
    const result = outcome?.result ?? (findings.length === 0 ? 'PASS' : 'FAIL');
    response = buildOracleResponse({
      oracleId: invocation.oracleId,
      result,
      startedAt,
      findings,
      evidence: outcome?.evidence ?? [],
      classification: outcome?.classification,
    });
    const expectedExit = RESULT_EXIT_CODES[response.result];
    const validationErrors = validateOracleResponse(response, invocation.oracleId, expectedExit, invocation.evidenceDir);
    if (validationErrors.length > 0) throw new Error(`oracle produced an invalid outcome: ${validationErrors.join('; ')}`);
  } catch (error) {
    response = buildOracleResponse({
      oracleId: invocation?.oracleId ?? options.env?.TT_ORACLE_ID ?? process.env.TT_ORACLE_ID ?? 'UNKNOWN',
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

export { validateOracleResponse };
