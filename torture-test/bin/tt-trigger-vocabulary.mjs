// tt-trigger-vocabulary.mjs — S29 (US-003) fail-closed trigger-vocabulary
// preflight, shared by bin/tt-controller and bin/tt-chaos.
//
// A probe `when` / chaos `trigger` marker names a step/agent
// (`step:<role>:<state>`) or a product event (`event:<type>`). Before arming
// any marker, the KNOWN VOCABULARY for the case's workflow must be consulted:
//   * step ids + agent ids from the workflow spec
//     (workflows/<workflow-id>/workflow.yml — TT-custom specs under
//     torture-test/workflows/, bundled-catalog specs under the repo
//     workflows/);
//   * the pinned product event-name vocabulary, derived from the emitters in
//     the contained product (src/installer/run.ts, step-ops.ts,
//     merge-branch.ts, agent-scheduler.ts, status.ts, the suite runner and
//     control-server).
// A marker naming a role/event that is NOT in the known vocabulary is an
// immediate scenario error (distinct machine-parseable reason) instead of a
// 4–8 minute silent probe-trigger-unreached / chaos-invocation-failed wait.
//
// Semantics mirror the runtime marker satisfiers:
//   * `step:<role>:<state>` fires when the contained steps table has a row
//     with `step_id = role OR agent_id LIKE %role%` and `status = state` —
//     so `role` must be a workflow step id OR agent id, and `state` a real
//     step status (probeStepMarkerSatisfied / tt-chaos checkStepMarker).
//   * `event:<type>` fires on a SUBSTRING match against emitted event names
//     (probeEventMarkerSatisfied / tt-chaos checkEventMarker) — so `type`
//     must be a substring of at least one pinned product event name.
// The preflight rejects exactly the markers that can NEVER fire by
// construction; a marker naming a REAL event that the scenario never emits
// (e.g. W4.33d `event:run.failed`, W4.48b `event:merge.target_moved`) is a
// premise-redesign question (US-004), not a vocabulary error, and passes.
//
// Dependency-free (node builtins only): self-tests import this module.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');

// ── Pinned product event-name vocabulary ────────────────────────────────
// Derived from the actual emitters in the contained product (grep of
// `event: "..."` across src/): run/step/merge/pipeline/dispatch/story/
// rugpull/suite/agent lifecycle + alert events. Namespace families
// (run.*, step.*, merge.*, dispatch.*, story.*, rugpull.*, suite.*,
// agent.*) are covered by the substring satisfier — `event:run` fires on
// run.started, `event:dispatch` on dispatch.render.validated, etc.
// A name in this list means the PRODUCT can emit it; whether the scenario
// ever makes it fire is a premise question, never a vocabulary error.
export const PRODUCT_EVENT_VOCABULARY = Object.freeze([
  // run lifecycle + terminal records
  'run.started',
  'run.completed',
  'run.failed',
  'run.canceled',
  'run.deleted',
  'run.force_failed',
  // run-level alerts / diagnostics
  'run.instant_fail_loop',
  'run.nudged',
  'run.base_capture_failed',
  'run.context_corrupt',
  // pause/resume lifecycle
  'run.paused',
  'run.pause_requested',
  'run.resumed',
  'run.resume_requested',
  'run.process_cleanup',
  // token accounting
  'run.tokens.updated',
  // rugpull lifecycle
  'run.rugpull_detected',
  'run.rugpull_relaunched',
  'run.rugpull_relaunch_failed',
  'run.rugpull_relaunch_suppressed',
  // step lifecycle
  'step.pending',
  'step.running',
  'step.done',
  'step.failed',
  'step.started',
  'step.retry',
  'step.rerouted',
  'step.reroute_noop',
  'step.reroute_error',
  'step.reroute_budget_exhausted',
  'step.expects.validated',
  'step.timeout',
  'step.released',
  'step.repended',
  'step.submit.rejected',
  'step.ceiling_expiry',
  'step.worker_lost',
  // pipeline
  'pipeline.advanced',
  // merge plumbing
  'merge.landed',
  'merge.target_moved',
  'merge.conflicts',
  'merge.accepted_already_landed',
  'merge.gate_overridden',
  'merge.landed_over_red_suite',
  'merge.landed_without_suite_evidence',
  // dispatch (scheduler rounds)
  'dispatch.render.validated',
  'dispatch.keys.rejected',
  // stories
  'story.started',
  'story.done',
  'story.failed',
  'story.retry',
  'story.abandoned',
  'story.verified',
  'stories.planned',
  // rugpull
  'rugpull.self_merge_detected',
  // suite execution (claim timeline + runner diagnostics)
  'suite.executed',
  'suite.execute_started',
  'suite.cache_hit',
  'suite.flaky_detected',
  'suite.singleflight_wait',
  'suite.special_exit_observed',
  'suite.tree_drift_detected',
  'suite.claim_wait',
  'suite.claim_granted',
  'suite.claim_owner_released',
  'suite.claim_dead_owner_reclaimed',
  // agent nudges
  'agent.nudged',
  'agent.nudge.skipped',
]);

// A `step:<role>:<state>` marker's state names the contained steps-table
// status the marker arms on. Pinned from the product's step lifecycle
// (src/installer/step-ops.ts writes waiting/pending/running/done/failed/
// canceled).
export const STEP_STATUS_VOCABULARY = Object.freeze([
  'waiting',
  'pending',
  'running',
  'done',
  'failed',
  'canceled',
]);

// An object-form awaited trigger `{"status": S, "timeout_s": T}` awaits the
// contained run's status. Pinned from the product's run lifecycle
// (src/installer/run.ts / step-ops.ts / status.ts).
export const RUN_STATUS_VOCABULARY = Object.freeze([
  'waiting',
  'pending',
  'running',
  'paused',
  'completed',
  'done',
  'failed',
  'canceled',
]);

// ── Workflow-spec resolution ─────────────────────────────────────────────
// The case's declared workflow id resolves to a spec at
//   torture-test/workflows/<id>/workflow.yml   (TT-custom specs)
//   <repo>/workflows/<id>/workflow.yml         (bundled catalog)
// The W2.24 'local' sentinel is resolved by the CONTROLLER before calling
// here (resolveLocalSentinel -> tt-docs-drift); tt-chaos receives the actual
// workflow id from the contained run row.

const WORKFLOW_SPEC_CACHE = new Map();

export function workflowSpecCandidates(workflowId) {
  return [
    path.join(TT_ROOT, 'workflows', workflowId, 'workflow.yml'),
    path.join(REPO_ROOT, 'workflows', workflowId, 'workflow.yml'),
  ];
}

export function findWorkflowSpecPath(workflowId) {
  for (const candidate of workflowSpecCandidates(workflowId)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing candidate — try the next.
    }
  }
  return null;
}

// Extract `- id: <x>` entries from a workflow.yml agents:/steps: block.
// Deliberately dependency-free (self-tests run with node builtins only) and
// strict: only lines that are ENTIRELY a list-item id
// (`\s*- id: <token>`) count — a nested prose example like
// `- id: "fix-001", "fix-002", etc.` (security-audit-merge's prioritize step
// input) never matches because it has trailing text.
const LIST_ITEM_ID_PATTERN = /^\s*-\s+id:\s*([A-Za-z0-9._-]+)\s*$/;

function yamlIdList(block) {
  const ids = [];
  for (const line of block.split(/\r?\n/)) {
    const match = LIST_ITEM_ID_PATTERN.exec(line);
    if (match !== null && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

// Parse a workflow.yml spec into its step/agent id vocabulary. The top-level
// `agents:` and `steps:` keys are anchored at column 0 (all bundled + TT
// specs use that layout); the agents block ends where steps begins.
export function parseWorkflowVocabulary(specPath) {
  const source = fs.readFileSync(specPath, 'utf8');
  const stepsIndex = source.indexOf('\nsteps:');
  const agentsIndex = source.indexOf('\nagents:');
  const agentsStart = agentsIndex === -1 ? source.indexOf('agents:') : agentsIndex + 1;
  const stepsStart = stepsIndex === -1 ? source.indexOf('steps:') : stepsIndex + 1;
  const agentsBlock = agentsStart === -1
    ? ''
    : source.slice(agentsStart, stepsStart === -1 || stepsStart < agentsStart ? undefined : stepsStart);
  const stepsBlock = stepsStart === -1 ? '' : source.slice(stepsStart);
  return { steps: yamlIdList(stepsBlock), agents: yamlIdList(agentsBlock) };
}

// Resolve + parse the workflow vocabulary for a workflow id. Returns
//   { workflowId, steps, agents, specPath, missing }
// where `missing: true` means no spec was found (the caller decides whether
// that is itself an error). Cached per workflow id.
export function workflowVocabularyFor(workflowId) {
  const cached = WORKFLOW_SPEC_CACHE.get(workflowId);
  if (cached !== undefined) return cached;
  const specPath = findWorkflowSpecPath(workflowId);
  let result;
  if (specPath === null) {
    result = {
      workflowId,
      steps: [],
      agents: [],
      specPath: null,
      missing: true,
      specCandidates: workflowSpecCandidates(workflowId),
    };
  } else {
    result = {
      workflowId,
      ...parseWorkflowVocabulary(specPath),
      specPath,
      missing: false,
    };
  }
  WORKFLOW_SPEC_CACHE.set(workflowId, result);
  return result;
}

// ── Marker vocabulary checks ─────────────────────────────────────────────
// `kind` selects the machine-parseable reason prefix: 'probe' ->
// `unknown-probe-trigger`, 'chaos' -> `unknown-chaos-trigger`.

function reasonPrefix(kind) {
  return kind === 'chaos' ? 'unknown-chaos-trigger' : 'unknown-probe-trigger';
}

// Check a single string phase marker (`now` | `step:<role>:<state>` |
// `event:<type>` | `file:<path>`). Returns an error string or null.
// `vocab` is the workflowVocabularyFor() result; `workflowId` is the
// case's resolved workflow id.
export function stringMarkerVocabularyError(marker, workflowId, vocab, kind = 'probe') {
  if (typeof marker !== 'string' || marker === 'now' || marker.startsWith('file:')) return null;
  const prefix = reasonPrefix(kind);
  if (marker.startsWith('step:')) {
    const rest = marker.slice('step:'.length);
    const parts = rest.split(':');
    if (parts.length !== 2) return null; // format error — the schema/validateMarker layer owns it
    const [role, state] = parts;
    if (vocab.missing) {
      return `${prefix}: cannot verify ${marker} — workflow ${JSON.stringify(workflowId)} spec not found (searched ${vocab.specCandidates.join(', ')})`;
    }
    if (!vocab.steps.includes(role) && !vocab.agents.includes(role)) {
      return `${prefix}: ${marker} not in workflow ${workflowId} step/agent vocabulary (steps: ${vocab.steps.join(', ')}; agents: ${vocab.agents.join(', ')})`;
    }
    if (!STEP_STATUS_VOCABULARY.includes(state)) {
      return `${prefix}: ${marker} state '${state}' not in step status vocabulary (${STEP_STATUS_VOCABULARY.join(', ')})`;
    }
    return null;
  }
  if (marker.startsWith('event:')) {
    const type = marker.slice('event:'.length);
    if (!PRODUCT_EVENT_VOCABULARY.some((name) => name.includes(type))) {
      return `${prefix}: ${marker} not in product event vocabulary`;
    }
    return null;
  }
  return null;
}

// Check an object-form awaited trigger `{"event": E, "timeout_s": T}` /
// `{"status": S, "timeout_s": T}`. Returns an error string or null.
// The event arm checks E against the pinned product event vocabulary
// (substring semantics, mirroring probeObjectTriggerSatisfied); the status
// arm checks S against the pinned run-status vocabulary.
export function objectTriggerVocabularyError(trigger, kind = 'probe') {
  const prefix = reasonPrefix(kind);
  if (typeof trigger !== 'object' || trigger === null) return null;
  if (typeof trigger.event === 'string' && trigger.event.length > 0) {
    if (!PRODUCT_EVENT_VOCABULARY.some((name) => name.includes(trigger.event))) {
      return `${prefix}: event ${JSON.stringify(trigger.event)} not in product event vocabulary`;
    }
    return null;
  }
  if (typeof trigger.status === 'string' && trigger.status.length > 0) {
    if (!RUN_STATUS_VOCABULARY.includes(trigger.status)) {
      return `${prefix}: status ${JSON.stringify(trigger.status)} not in run status vocabulary (${RUN_STATUS_VOCABULARY.join(', ')})`;
    }
    return null;
  }
  return null;
}

// Convenience: the workflow-spec-missing reason for a case whose markers need
// vocabulary verification but whose declared workflow has no resolvable spec.
export function unknownWorkflowSpecError(workflowId, vocab) {
  return `unknown-workflow-spec: workflow ${JSON.stringify(workflowId)} spec not found (searched ${vocab.specCandidates.join(', ')})`;
}
