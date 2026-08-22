import fs from 'node:fs';

import { FindingCollector, OracleRuntimeError } from './index.mjs';

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an object`);
  return value;
}
function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError(`${label} must be nonempty`);
  return value;
}
function canonicalRunId(value, label) {
  const id = nonempty(value, label);
  return id.startsWith('run-') ? id : `run-${id}`;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).valueOf()) || new Date(value).toISOString() !== value) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return value;
}
function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new OracleRuntimeError(`${label} must be an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) throw new OracleRuntimeError(`${label} must not contain duplicates`);
  return value;
}
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new OracleRuntimeError(`${label} must be a positive safe integer`);
  return value;
}
function readArtifact(file, label) {
  let artifact;
  try { artifact = object(JSON.parse(fs.readFileSync(file, 'utf8')), label); } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
  if (artifact.schema_version !== 1 || !Array.isArray(artifact.rows)) throw new OracleRuntimeError(`${label} must be a schema-version 1 row artifact`);
  timestamp(artifact.captured_at, `${label}.captured_at`);
  return artifact;
}
function sameArray(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

// Loop-step classification. A step with type === 'loop' iterates over the run's
// stories: each story iteration produces one accepted done transition (and, with
// verify_each, one for the decision step), so done-transition multiplicity on
// those steps equals the story count — never exactly one. loop_config must be a
// parseable object on loop steps (fail closed like every other malformed input).
function loopConfigOf(step) {
  if (step.type !== 'loop') return null;
  if (typeof step.loop_config !== 'string' || step.loop_config.trim().length === 0) {
    throw new OracleRuntimeError(`loop step ${step.step_row_id} lacks a loop_config`);
  }
  let config;
  try {
    config = object(JSON.parse(step.loop_config), `step ${step.step_row_id}.loop_config`);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`step ${step.step_row_id}.loop_config is not valid JSON: ${error.message}`, { cause: error });
  }
  const verifyEach = config.verifyEach ?? config.verify_each;
  const verifyStep = config.verifyStep ?? config.verify_step;
  if (verifyEach !== undefined && typeof verifyEach !== 'boolean') throw new OracleRuntimeError(`step ${step.step_row_id}.loop_config verify_each must be boolean`);
  if (verifyStep !== undefined && (typeof verifyStep !== 'string' || verifyStep.length === 0)) {
    throw new OracleRuntimeError(`step ${step.step_row_id}.loop_config verify_step must be a nonempty step_id`);
  }
  return { verify_each: verifyEach === true, verify_step_id: verifyStep ?? null };
}

// Accepts both snake_case (YAML) and camelCase (typed LoopConfig) spellings.
function loopMultiplicityScope(databaseSteps) {
  const loopStepRowIdsByRun = new Map();
  const decisionStepRowIdsByRun = new Map();
  for (const step of databaseSteps) {
    const config = loopConfigOf(step);
    if (config === null) continue;
    const loopIds = loopStepRowIdsByRun.get(step.run_id) ?? new Set();
    loopIds.add(step.step_row_id);
    loopStepRowIdsByRun.set(step.run_id, loopIds);
    if (config.verify_each && config.verify_step_id !== null) {
      const decisionIds = decisionStepRowIdsByRun.get(step.run_id) ?? new Set();
      for (const candidate of databaseSteps) {
        if (candidate.run_id === step.run_id && candidate.step_id === config.verify_step_id) decisionIds.add(candidate.step_row_id);
      }
      decisionStepRowIdsByRun.set(step.run_id, decisionIds);
    }
  }
  return { loopStepRowIdsByRun, decisionStepRowIdsByRun };
}

export function evaluateO11OutputContract(invocation, projected, databaseSteps, databaseStories) {
  const findings = new FindingCollector();
  const validationArtifact = readArtifact(invocation.evidencePaths.expects_validations, 'expects_validations');
  const rejectionArtifact = readArtifact(invocation.evidencePaths.submit_rejections, 'submit_rejections');
  const renderingArtifact = readArtifact(invocation.evidencePaths.dispatch_renderings, 'dispatch_renderings');
  const stepByRowId = new Map(databaseSteps.map((step) => [step.step_row_id, step]));
  if (stepByRowId.size !== databaseSteps.length) throw new OracleRuntimeError('terminal database contains duplicate step row IDs');

  const validationIds = new Set();
  const validationAttempts = new Set();
  const validations = validationArtifact.rows.map((raw, index) => {
    const label = `expects_validations.rows[${index}]`;
    const row = object(raw, label);
    const id = nonempty(row.id, `${label}.id`);
    if (validationIds.has(id)) throw new OracleRuntimeError(`${label}.id must be unique`);
    validationIds.add(id);
    const normalized = {
      id,
      observed_at: timestamp(row.observed_at, `${label}.observed_at`),
      run_id: canonicalRunId(row.run_id, `${label}.run_id`),
      step_row_id: nonempty(row.step_row_id, `${label}.step_row_id`),
      step_id: nonempty(row.step_id, `${label}.step_id`),
      claim_id: nonempty(row.claim_id, `${label}.claim_id`),
      attempt_number: positiveInteger(row.attempt_number, `${label}.attempt_number`),
      outcome: row.outcome,
      verdict: row.verdict,
      expects_required: row.expects_required,
      required_keys: stringArray(row.required_keys, `${label}.required_keys`),
      missing_keys: stringArray(row.missing_keys, `${label}.missing_keys`),
      invalid_keys: stringArray(row.invalid_keys, `${label}.invalid_keys`),
      diagnostic_code: nonempty(row.diagnostic_code, `${label}.diagnostic_code`),
    };
    if (!['accepted', 'rejected'].includes(normalized.outcome)) throw new OracleRuntimeError(`${label}.outcome must be accepted or rejected`);
    if (normalized.verdict !== null && !['done', 'retry', 'failed'].includes(normalized.verdict)) throw new OracleRuntimeError(`${label}.verdict is invalid`);
    if (typeof normalized.expects_required !== 'boolean') throw new OracleRuntimeError(`${label}.expects_required must be boolean`);
    const attemptKey = `${normalized.claim_id}\0${normalized.attempt_number}`;
    if (validationAttempts.has(attemptKey)) throw new OracleRuntimeError(`${label} duplicates a claim attempt`);
    validationAttempts.add(attemptKey);
    if (!Array.isArray(row.key_sources)) throw new OracleRuntimeError(`${label}.key_sources must be an array`);
    normalized.key_sources = row.key_sources.map((rawSource, sourceIndex) => {
      const source = object(rawSource, `${label}.key_sources[${sourceIndex}]`);
      return {
        key: nonempty(source.key, `${label}.key_sources[${sourceIndex}].key`),
        producer_step_row_id: source.producer_step_row_id === null ? null : nonempty(source.producer_step_row_id, `${label}.key_sources[${sourceIndex}].producer_step_row_id`),
      };
    });
    const transition = object(row.transition, `${label}.transition`);
    if (!['done', 'retry', 'reroute', 'fail'].includes(transition.action)) throw new OracleRuntimeError(`${label}.transition.action is invalid`);
    normalized.transition = {
      action: transition.action,
      target_step_row_id: nonempty(transition.target_step_row_id, `${label}.transition.target_step_row_id`),
    };
    const step = stepByRowId.get(normalized.step_row_id);
    if (!step || step.run_id !== normalized.run_id || step.step_id !== normalized.step_id || !projected.has(normalized.run_id)) {
      findings.add('O11_VALIDATION_STEP_UNKNOWN', 'expects validation does not identify one captured run step', { validation_id: id, run_id: normalized.run_id, step_row_id: normalized.step_row_id });
    } else if (step.expects_required !== normalized.expects_required) {
      findings.add('O11_EXPECTS_REQUIREMENT_MISMATCH', 'validation expects-required flag disagrees with the terminal step definition', { validation_id: id, step_row_id: normalized.step_row_id });
    }
    if (normalized.outcome === 'accepted' && (normalized.missing_keys.length > 0 || normalized.invalid_keys.length > 0)) {
      findings.add('O11_ACCEPTED_VALIDATION_HAS_ERRORS', 'accepted expects validation retains missing or invalid keys', { validation_id: id });
    }
    return normalized;
  });

  const renderingIds = new Set();
  const renderings = renderingArtifact.rows.map((raw, index) => {
    const label = `dispatch_renderings.rows[${index}]`;
    const row = object(raw, label);
    const id = nonempty(row.id, `${label}.id`);
    if (renderingIds.has(id)) throw new OracleRuntimeError(`${label}.id must be unique`);
    renderingIds.add(id);
    const normalized = {
      id,
      observed_at: timestamp(row.observed_at, `${label}.observed_at`),
      run_id: canonicalRunId(row.run_id, `${label}.run_id`),
      step_row_id: nonempty(row.step_row_id, `${label}.step_row_id`),
      step_id: nonempty(row.step_id, `${label}.step_id`),
      claim_id: nonempty(row.claim_id, `${label}.claim_id`),
      required_keys: stringArray(row.required_keys, `${label}.required_keys`),
      unresolved_placeholder_count: row.unresolved_placeholder_count,
      unresolved_keys: stringArray(row.unresolved_keys, `${label}.unresolved_keys`),
      dispatched: row.dispatched !== false,
      producer_step_row_id: row.producer_step_row_id == null ? null : nonempty(row.producer_step_row_id, `${label}.producer_step_row_id`),
    };
    if (!Number.isSafeInteger(normalized.unresolved_placeholder_count) || normalized.unresolved_placeholder_count < 0) throw new OracleRuntimeError(`${label}.unresolved_placeholder_count must be a non-negative safe integer`);
    if (normalized.unresolved_placeholder_count !== normalized.unresolved_keys.length) throw new OracleRuntimeError(`${label} unresolved count does not equal its key inventory`);
    if (normalized.dispatched && normalized.unresolved_placeholder_count > 0) findings.add('O11_DISPATCH_PLACEHOLDER_UNRESOLVED', 'dispatch metadata records a rendered [missing: <key>] placeholder', { rendering_id: id, run_id: normalized.run_id, step_row_id: normalized.step_row_id, unresolved_keys: normalized.unresolved_keys });
    if (!normalized.dispatched && normalized.unresolved_placeholder_count > 0) {
      const transition = row.transition == null ? null : object(row.transition, `${label}.transition`);
      const producer = normalized.producer_step_row_id === null ? undefined : stepByRowId.get(normalized.producer_step_row_id);
      if (!producer || producer.run_id !== normalized.run_id || producer.step_row_id === normalized.step_row_id) {
        findings.add('O11_PRODUCER_ATTRIBUTION_MISSING', 'missing producer key is not attributed to a distinct upstream producer step', { rendering_id: id, producer_step_row_id: normalized.producer_step_row_id });
      } else if (!transition || !['retry', 'reroute'].includes(transition.action) || transition.target_step_row_id !== producer.step_row_id) {
        findings.add('O11_PRODUCER_RETRY_MISROUTED', 'missing producer key consumed a consumer retry instead of targeting its producer', { rendering_id: id, producer_step_row_id: producer.step_row_id, transition });
      }
    }
    return normalized;
  });

  const { loopStepRowIdsByRun, decisionStepRowIdsByRun } = loopMultiplicityScope(databaseSteps);
  const doneStoriesByRun = new Map();
  for (const story of databaseStories) {
    if (story.status !== 'done') continue;
    doneStoriesByRun.set(story.run_id, (doneStoriesByRun.get(story.run_id) ?? 0) + 1);
  }

  for (const step of databaseSteps.filter((row) => projected.has(row.run_id) && row.status === 'done')) {
    const successes = validations.filter((row) => row.run_id === step.run_id && row.step_row_id === step.step_row_id
      && row.outcome === 'accepted' && row.verdict === 'done' && row.transition.action === 'done'
      && row.transition.target_step_row_id === step.step_row_id);
    const isLoopStep = loopStepRowIdsByRun.get(step.run_id)?.has(step.step_row_id) ?? false;
    const isDecisionStep = decisionStepRowIdsByRun.get(step.run_id)?.has(step.step_row_id) ?? false;
    if (isLoopStep || isDecisionStep) {
      // A loop step transitions done once per story iteration, and its
      // verify_each decision step once per story verification. Multiplicity
      // must therefore cover every completed story (at least one).
      const required = Math.max(1, doneStoriesByRun.get(step.run_id) ?? 0);
      if (successes.length < required) findings.add('O11_DONE_WITHOUT_EXPECTS_SUCCESS', 'loop/verify_each step does not have one accepted done transition per completed story', {
        run_id: step.run_id, step_row_id: step.step_row_id, observed: successes.length, required,
      });
    } else {
      // S22A: done-multiplicity is PER DISPATCH, not per step row. A step
      // may legally re-execute across multiple dispatches — an honest retry
      // (accepted retry verdict, transition.action='retry', step
      // re-dispatched, later accepted done) or the RTRV on_fail.retry_step
      // reroute corridor (transition.action='reroute', re-execution with its
      // own accepted done). Each dispatch must carry exactly one accepted
      // done; a step with no rendering telemetry is a single implicit
      // dispatch. The step must have at least one accepted done overall.
      const stepRenderings = renderings
        .filter((row) => row.run_id === step.run_id && row.step_row_id === step.step_row_id)
        .toSorted((left, right) => left.observed_at.localeCompare(right.observed_at));
      const perDispatch = new Map();
      for (const success of successes) {
        let dispatch = 'implicit';
        for (const rendering of stepRenderings) {
          if (rendering.observed_at <= success.observed_at) dispatch = rendering.id;
        }
        perDispatch.set(dispatch, (perDispatch.get(dispatch) ?? 0) + 1);
      }
      const duplicateDispatch = [...perDispatch.values()].find((count) => count > 1);
      if (successes.length === 0 || duplicateDispatch !== undefined) {
        findings.add('O11_DONE_WITHOUT_EXPECTS_SUCCESS', 'done step does not have exactly one successful done expects-validation transition per dispatch', {
          run_id: step.run_id, step_row_id: step.step_row_id, observed: successes.length,
          dispatches: [...perDispatch.entries()],
        });
      }
    }
  }
  for (const row of validations) {
    if (row.outcome === 'accepted' && row.verdict === 'retry' && projected.get(row.run_id)?.terminal_status === 'completed') {
      // On loop steps and their verify_each decision steps an accepted
      // STATUS: retry verdict is the story-reset re-dispatch: the agent
      // verdicts retry and the scheduler re-dispatches a fresh session for
      // the same story. That is by design for loop iteration — not a finding.
      const retryOnLoopStep = loopStepRowIdsByRun.get(row.run_id)?.has(row.step_row_id) ?? false;
      const retryOnDecisionStep = decisionStepRowIdsByRun.get(row.run_id)?.has(row.step_row_id) ?? false;
      if (retryOnLoopStep || retryOnDecisionStep) continue;
      // S22A: the seal fires only for a step that COMPLETED FROM the retry
      // verdict — either the retry verdict row's transition.action is 'done'
      // (the accepted retry verdict itself moved the step to done), or the
      // step reached done with NO later accepted done validation. Both legal
      // re-dispatch corridors carry a later separate accepted done and must
      // NOT fire: (a) honest single-step retry (transition.action='retry',
      // step re-dispatched, later accepted done) and (b) the RTRV
      // on_fail.retry_step reroute corridor (transition.action='reroute').
      const transitionedDone = row.transition.action === 'done';
      const laterAcceptedDone = validations.some((other) =>
        other.run_id === row.run_id && other.step_row_id === row.step_row_id
        && other.outcome === 'accepted' && other.verdict === 'done'
        && other.transition.action === 'done' && other.transition.target_step_row_id === row.step_row_id
        && other.observed_at > row.observed_at);
      if (transitionedDone || !laterAcceptedDone) {
        findings.add('O11_COMPLETED_FROM_RETRY_VERDICT', 'completed run contains an accepted retry verdict', { validation_id: row.id, run_id: row.run_id, step_row_id: row.step_row_id });
      }
    }
  }

  const genericCodes = new Set(['GENERIC', 'REJECTED', 'UNKNOWN', 'VALIDATION_FAILED', 'EXPECTS_REJECTED']);
  const rejectionIds = new Set();
  const rejectionAttempts = new Set();
  const rejections = rejectionArtifact.rows.map((raw, index) => {
    const label = `submit_rejections.rows[${index}]`;
    const row = object(raw, label);
    const id = nonempty(row.id, `${label}.id`);
    if (rejectionIds.has(id)) throw new OracleRuntimeError(`${label}.id must be unique`);
    rejectionIds.add(id);
    const normalized = {
      id,
      observed_at: timestamp(row.observed_at, `${label}.observed_at`),
      run_id: canonicalRunId(row.run_id, `${label}.run_id`),
      step_row_id: nonempty(row.step_row_id, `${label}.step_row_id`),
      step_id: nonempty(row.step_id, `${label}.step_id`),
      claim_id: nonempty(row.claim_id, `${label}.claim_id`),
      attempt_number: positiveInteger(row.attempt_number, `${label}.attempt_number`),
      validation_code: nonempty(row.validation_code, `${label}.validation_code`),
      missing_keys: stringArray(row.missing_keys, `${label}.missing_keys`),
      invalid_keys: stringArray(row.invalid_keys, `${label}.invalid_keys`),
      diagnostic_code: nonempty(row.diagnostic_code, `${label}.diagnostic_code`),
    };
    const attemptKey = `${normalized.claim_id}\0${normalized.attempt_number}`;
    if (rejectionAttempts.has(attemptKey)) throw new OracleRuntimeError(`${label} duplicates a claim attempt`);
    rejectionAttempts.add(attemptKey);
    if (genericCodes.has(normalized.diagnostic_code.toUpperCase())) findings.add('O11_REJECTION_DIAGNOSTIC_GENERIC', 'submit-time rejection retained only a generic, non-actionable diagnostic', { rejection_id: id, diagnostic_code: normalized.diagnostic_code });
    return normalized;
  });
  const rejectedValidations = validations.filter((row) => row.outcome === 'rejected');
  for (const validation of rejectedValidations) {
    const rejection = rejections.find((row) => row.claim_id === validation.claim_id && row.attempt_number === validation.attempt_number);
    if (!rejection || rejection.run_id !== validation.run_id || rejection.step_row_id !== validation.step_row_id
      || rejection.diagnostic_code !== validation.diagnostic_code
      || !sameArray(rejection.missing_keys, validation.missing_keys)
      || !sameArray(rejection.invalid_keys, validation.invalid_keys)) {
      findings.add('O11_REJECTION_VALIDATION_MISMATCH', 'rejected expects attempt does not retain a matching structured submit-time diagnostic', { validation_id: validation.id, claim_id: validation.claim_id, attempt_number: validation.attempt_number });
    }
  }
  for (const rejection of rejections) {
    if (!rejectedValidations.some((row) => row.claim_id === rejection.claim_id && row.attempt_number === rejection.attempt_number)) {
      findings.add('O11_REJECTION_WITHOUT_VALIDATION', 'submit rejection has no matching rejected expects validation', { rejection_id: rejection.id });
    }
  }
  for (const claimId of new Set(rejections.map((row) => row.claim_id))) {
    const rows = rejections.filter((row) => row.claim_id === claimId).toSorted((left, right) => left.attempt_number - right.attempt_number);
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].observed_at <= rows[index - 1].observed_at) findings.add('O11_REJECTION_ORDER_INVALID', 'submit rejections for one claim are not retained in strict attempt/time order', { claim_id: claimId });
    }
  }

  return {
    findings: findings.toJSON(),
    observation: {
      steps: databaseSteps.filter((step) => projected.has(step.run_id)),
      stories: databaseStories.filter((story) => projected.has(story.run_id)),
      validations,
      rejections,
      renderings,
    },
  };
}
