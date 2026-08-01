export const OUTCOMES = Object.freeze([
  'PASS',
  'PRODUCT_FAIL',
  'AGENT_FLAKE',
  'PROVIDER_FAIL',
  'TEST_INFRA_FAIL',
  'INVALID',
  'INCONCLUSIVE',
  'NOT_RUN',
]);

function result(outcome, category, evidence = {}) {
  return {
    outcome,
    ...(category === undefined ? {} : { reason: { category, ...evidence } }),
  };
}

function validOracleResults(oracleResults) {
  return (oracleResults ?? []).filter((item) =>
    item?.status === 'VALID' && item.response !== undefined);
}

export function classificationSignalsFromOracles(oracleResults) {
  const signals = {
    manipulation_checks: [],
    provider_failures: [],
    expectation_observations: [],
    agent_task_observations: [],
    ambiguities: [],
  };
  for (const item of validOracleResults(oracleResults)) {
    const classification = item.response.classification;
    if (classification === undefined) continue;
    for (const check of classification.manipulation_checks ?? []) {
      signals.manipulation_checks.push({ oracle_id: item.oracle_id, ...check });
    }
    if (classification.provider_failure !== undefined) {
      signals.provider_failures.push({ oracle_id: item.oracle_id, ...classification.provider_failure });
    }
    if (classification.expectation_met !== undefined) {
      signals.expectation_observations.push({
        oracle_id: item.oracle_id,
        value: classification.expectation_met,
      });
    }
    if (classification.agent_task_succeeded !== undefined) {
      signals.agent_task_observations.push({
        oracle_id: item.oracle_id,
        value: classification.agent_task_succeeded,
      });
    }
    if (classification.ambiguous !== undefined) {
      signals.ambiguities.push({ oracle_id: item.oracle_id, ...classification.ambiguous });
    }
  }
  return signals;
}

export function classifyAttempt(evidence) {
  const oracleResults = evidence.oracle_results ?? [];
  const failedOracles = validOracleResults(oracleResults)
    .filter((item) => item.response.result === 'FAIL');
  if (failedOracles.length > 0) {
    return result('PRODUCT_FAIL', 'oracle-failed', {
      oracles: failedOracles.map((item) => item.oracle_id).filter(Boolean),
    });
  }

  if (evidence.not_run !== undefined) return result('NOT_RUN', evidence.not_run.category, evidence.not_run);

  const oracleInfrastructure = oracleResults.filter((item) =>
    item?.status === 'TEST_INFRA'
      || (item?.status === 'VALID' && item.response?.result === 'ERROR'));
  if (oracleInfrastructure.length > 0) {
    return result('TEST_INFRA_FAIL', 'oracle-infrastructure', {
      oracles: oracleInfrastructure.map((item) => item.oracle_id).filter(Boolean),
    });
  }
  if (evidence.infrastructure_failure !== undefined) {
    return result('TEST_INFRA_FAIL', evidence.infrastructure_failure.category, evidence.infrastructure_failure);
  }

  const oracleSignals = classificationSignalsFromOracles(oracleResults);
  const manipulationChecks = [
    ...(evidence.manipulation_checks ?? []),
    ...oracleSignals.manipulation_checks,
  ];
  const failedManipulations = manipulationChecks.filter((check) =>
    check.required !== false && check.engaged !== true);
  if (failedManipulations.length > 0) {
    return result('INVALID', 'manipulation-not-engaged', { checks: failedManipulations });
  }

  const providerFailures = [
    ...(evidence.provider_failure === undefined ? [] : [evidence.provider_failure]),
    ...oracleSignals.provider_failures,
  ];
  const providerFailure = providerFailures.find((failure) =>
    failure.identified === true && failure.injected !== true);
  if (providerFailure !== undefined) {
    return result('PROVIDER_FAIL', 'provider-failure', { evidence: providerFailure });
  }
  const unidentifiedProvider = providerFailures.find((failure) =>
    failure.identified !== true && failure.injected !== true);
  if (unidentifiedProvider !== undefined) {
    return result('INCONCLUSIVE', 'provider-failure-unidentified', {
      evidence: unidentifiedProvider,
    });
  }

  if (evidence.cap_evidence !== undefined) {
    return result('INCONCLUSIVE', 'ambiguous-evidence', {
      ambiguities: [],
      cap: evidence.cap_evidence,
    });
  }
  if (oracleSignals.ambiguities.length > 0) {
    return result('INCONCLUSIVE', 'ambiguous-evidence', {
      ambiguities: oracleSignals.ambiguities,
    });
  }

  const expectationObservations = [
    ...(evidence.expectation_met === undefined ? [] : [evidence.expectation_met]),
    ...oracleSignals.expectation_observations.map((item) => item.value),
  ];
  if (expectationObservations.includes(false)) {
    if (evidence.caseClass === 'verification') {
      return result('PRODUCT_FAIL', 'verification-expectation-not-met');
    }
    if (evidence.caseClass === 'characterization') {
      return result('PASS', 'characterization-observed');
    }
  }

  const taskObservations = [
    ...(evidence.agent_task_succeeded === undefined ? [] : [evidence.agent_task_succeeded]),
    ...oracleSignals.agent_task_observations.map((item) => item.value),
  ];
  if (taskObservations.includes(false)) return result('AGENT_FLAKE', 'agent-task-failed');

  if (expectationObservations.includes(true) || taskObservations.includes(true)) return result('PASS');
  const ambiguities = evidence.ambiguous === undefined ? [] : [evidence.ambiguous];
  if (ambiguities.length > 0) {
    return result('INCONCLUSIVE', 'ambiguous-evidence', { ambiguities });
  }
  return result('INCONCLUSIVE', 'insufficient-mechanical-evidence');
}

export function providerRetryDecision({ outcome, attempts, backoffMs, nowMs = Date.now() }) {
  if (outcome !== 'PROVIDER_FAIL') return { retry: false };
  const providerAttempts = attempts.filter((attempt) => attempt.outcome === 'PROVIDER_FAIL');
  if (providerAttempts.length !== 1) return { retry: false };
  const attempt = providerAttempts[0];
  if (attempt.retry_of !== undefined) return { retry: false };
  return {
    retry: true,
    retry_of: attempt.id,
    retry_number: 1,
    retry_not_before: new Date(nowMs + backoffMs).toISOString(),
  };
}
