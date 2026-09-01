#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GATING_ORACLE_IDS,
  OPTIONAL_ORACLE_EVIDENCE_KEYS,
  ORACLE_EVIDENCE_KEYS,
  REQUIRED_ORACLE_EVIDENCE,
  createOracleContext,
  validateOracleContext,
} from './oracle-context.mjs';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(BIN_DIR, '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fixture() {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const campaignDir = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-context-test.'));
  const capturedAt = '2026-08-01T12:00:00.000Z';
  const references = {};
  for (const key of ORACLE_EVIDENCE_KEYS) {
    const relative = `snapshots/${key}.json`;
    const absolute = path.join(campaignDir, relative);
    const content = `${JSON.stringify({ key, mechanical: true })}\n`;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    references[key] = {
      path: relative,
      sha256: sha256(content),
      captured_at: capturedAt,
      source: 'controller-snapshot',
    };
  }
  const stepWithProse = {
    stepId: 'step-1', agentRole: 'developer', status: 'done', displayStatus: 'done', stepIndex: 0,
    claimUpdatedAt: '2026-08-01 11:59:59', updatedAt: '2026-08-01 12:00:00',
    output: 'STATUS: done AGENT_RESPONSE_SENTINEL',
    error: 'MODEL_TRANSCRIPT_SENTINEL',
  };
  const attempt = {
    id: 'attempt-1', kind: 'workflow', phase: 'terminal', execution_mode: 'real',
    run_id: 'run-11111111-1111-4111-8111-111111111111',
    started_at: capturedAt, terminal_at: capturedAt, terminal_status: 'completed',
    tokens_observed: 17,
    command: {
      exit_code: 0, signal: null,
      stdout: 'evidence/raw-agent-response.txt', stderr: 'evidence/model-transcript.txt',
    },
    terminal_evidence: { status: 'completed', agent_response: 'AGENT_RESPONSE_SENTINEL' },
    steps_snapshot: {
      source: 'workflow-status-json', captured_at: capturedAt,
      provenance: { database: '/home/operator/.tamandua/tamandua.db' },
      steps: [stepWithProse],
    },
    oracle_evidence: { schema_version: 1, references },
  };
  const state = {
    campaign_id: 'campaign-context-test', created_at: capturedAt,
    manifest: { path: '/operator/manifest.jsonl', sha256: 'a'.repeat(64), case_count: 1, case_ids: ['CASE-1'] },
    cases: [{
      id: 'CASE-1', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'running', expected_fast_failure: false,
      // T2.2 US-001: the controller projects the case execution mode onto the
      // state; the o1_wave projection carries it on every wave run row.
      execution_mode: 'real',
      production_duration_floor_ms: 120_000, attempts: [attempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    }, {
      id: 'W1-CALIBRATION', wave: 1, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'terminal', expected_fast_failure: false,
      execution_mode: 'real',
      production_duration_floor_ms: 120_000,
      attempts: [{ ...attempt, id: 'attempt-w1', run_id: 'run-44444444-4444-4444-8444-444444444444', started_at: '2026-08-01T11:55:00.000Z' }],
      findings: [], oracle_results: [], spend: { tokens_observed: 17, observations: [] },
    }],
    discovered_runs: [{
      ...attempt,
      id: 'discovered-1', kind: 'discovered-workflow',
      run_id: 'run-22222222-2222-4222-8222-222222222222',
      parent_run_id: attempt.run_id, root_case_id: 'CASE-1',
    }],
  };
  const caseRecord = {
    id: 'CASE-1', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
    harness: 'hermes', class: 'verification', caps: { tokens: 100, wall_min: 5 },
    boundary_files: ['src/'], forbidden: ['bait.txt'], chaos: null,
    context: { merge_gate: 'green', agent_response: 'AGENT_RESPONSE_SENTINEL' },
  };
  const caseState = { attempts: [attempt] };
  return { campaignDir, references, state, caseRecord, caseState };
}

function cleanup(campaignDir) {
  fs.rmSync(campaignDir, { recursive: true, force: true });
}

test('complete version-1 mechanical evidence context is accepted for every gating oracle', () => {
  const data = fixture();
  try {
    assert.deepEqual(GATING_ORACLE_IDS, ['O1', 'O2', 'O3z', 'O4', 'O8', 'O9', 'O10', 'O11', 'O16']);
    for (const oracleId of GATING_ORACLE_IDS) {
      const context = createOracleContext({ ...data, oracleId });
      assert.deepEqual(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }), []);
      assert.equal(context.oracle_id, oracleId);
      assert.equal(context.mechanical_evidence.schema_version, 1);
      assert.deepEqual(Object.keys(context.mechanical_evidence.references), ORACLE_EVIDENCE_KEYS);
      assert.equal(context.attempts[0].steps_snapshot.steps[0].updatedAt, data.state.created_at);
      assert.equal(context.o1_wave.duration_floors[0].source, 'production-median');
      assert.equal(context.o1_wave.duration_floors[0].duration_floor_ms, 120_000);
      assert.equal(context.o1_wave.duration_floors[0].case_id, 'CASE-1');
      assert.equal(context.o1_wave.runs[0].expected_fast_failure, false);
      // T2.2 US-001: every wave run row carries the case execution mode.
      assert.equal(context.o1_wave.runs[0].execution_mode, 'real');
    }
  } finally {
    cleanup(data.campaignDir);
  }
});

test('S43b US-007: o1_wave carries the campaign-wide wave_cases membership in manifest order (including cases that have not run yet)', () => {
  const data = fixture();
  try {
    // A second wave-3 case (manifest rank 1, NO attempts — it has not run
    // yet) must still be part of the wave membership: the O1 wave-family
    // reporter selection keys off the FULL wave case set, so every evaluating
    // case in the wave resolves the SAME reporter (the true final wave case
    // in manifest order) instead of re-selecting from its own partial
    // snapshot.
    data.state.manifest = { path: '/operator/manifest.jsonl', sha256: 'a'.repeat(64), case_count: 2, case_ids: ['CASE-1', 'CASE-2'] };
    data.state.cases.push({
      id: 'CASE-2', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'pending', expected_fast_failure: false,
      execution_mode: 'real', production_duration_floor_ms: 120_000,
      attempts: [], findings: [], oracle_results: [], spend: { tokens_observed: 0, observations: [] },
    });
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.wave_cases, ['CASE-1', 'CASE-2']);
    // Only the runs that EXIST are projected; the membership is not limited
    // to projected runs (CASE-1's own attempt + its discovered sibling).
    assert.deepEqual(context.o1_wave.runs.map((run) => run.case_id), ['CASE-1', 'CASE-1']);
    assert.deepEqual(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }), []);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('T2.2 US-001: o1_wave run rows carry per-run execution_mode from the case state, with harness fallback for stored evidence', () => {
  const data = fixture();
  try {
    // Declared mode on the case state wins: scripted case -> scripted runs.
    data.state.cases[0].execution_mode = 'scripted';
    let context = createOracleContext({ ...data, oracleId: 'O1' });
    for (const run of context.o1_wave.runs) {
      assert.equal(run.execution_mode, 'scripted', `${run.case_id}/${run.run_id} must project the case's scripted mode`);
    }
    // Discovered runs inherit their root case's mode (root_case_id CASE-1).
    assert.ok(context.o1_wave.runs.some((run) => run.run_id === 'run-22222222-2222-4222-8222-222222222222'),
      'discovered run must appear in the wave projection');

    // Stored-evidence fallback: a case state that predates the field (no
    // execution_mode) derives from the harness projection.
    delete data.state.cases[0].execution_mode;
    data.state.cases[0].harness = 'scripted-hermes';
    context = createOracleContext({ ...data, oracleId: 'O1' });
    for (const run of context.o1_wave.runs) {
      assert.equal(run.execution_mode, 'scripted', `harness fallback must mark ${run.case_id} scripted`);
    }

    // A non-scripted harness without a declared mode falls back to 'real'.
    data.state.cases[0].harness = 'hermes';
    context = createOracleContext({ ...data, oracleId: 'O1' });
    for (const run of context.o1_wave.runs) {
      assert.equal(run.execution_mode, 'real', `harness fallback must mark ${run.case_id} real`);
    }
  } finally {
    cleanup(data.campaignDir);
  }
});

test('E3.C registry: probe_evidence/chaos_log keys and O4/O16 gating wiring (US-003)', () => {
  const data = fixture();
  try {
    // Evidence contract recognizes the probe sequencer and chaos wiring outputs.
    assert.ok(ORACLE_EVIDENCE_KEYS.includes('probe_evidence'), 'probe_evidence must be a version-1 evidence key');
    assert.ok(ORACLE_EVIDENCE_KEYS.includes('chaos_log'), 'chaos_log must be a version-1 evidence key');
    assert.equal(ORACLE_EVIDENCE_KEYS.indexOf('probe_evidence'), ORACLE_EVIDENCE_KEYS.length - 2,
      'probe_evidence must be the penultimate key (append-only key set)');
    assert.equal(ORACLE_EVIDENCE_KEYS.indexOf('chaos_log'), ORACLE_EVIDENCE_KEYS.length - 1,
      'chaos_log must be the terminal key (append-only key set)');

    // O4 and O16 are first-class gating oracles.
    assert.ok(GATING_ORACLE_IDS.includes('O4'), 'O4 must be a gating oracle');
    assert.ok(GATING_ORACLE_IDS.includes('O16'), 'O16 must be a gating oracle');
    assert.ok(GATING_ORACLE_IDS.indexOf('O4') < GATING_ORACLE_IDS.indexOf('O8'),
      'O4 must sit in the spec-12 gating order (O1, O2, O3z, O4, O8, ...)');

    // The new keys are OPTIONAL snapshot artifacts (null when the probe
    // sequencer / tt-chaos never ran), so non-probe cases still capture.
    assert.deepEqual(OPTIONAL_ORACLE_EVIDENCE_KEYS, ['probe_evidence', 'chaos_log']);
    assert.ok(OPTIONAL_ORACLE_EVIDENCE_KEYS.every((key) => ORACLE_EVIDENCE_KEYS.includes(key)),
      'every optional key must still be a version-1 evidence key');

    // Required evidence legs per US-003.
    assert.deepEqual(REQUIRED_ORACLE_EVIDENCE.O4, ['database_snapshot', 'run_events', 'chaos_log']);
    // S25: O16's probe_evidence leg is non-gating (a case without a captured
    // probe sequence is a legal shape — O16 renders NOT_EVALUABLE on it);
    // run_events + database_snapshot remain required so the verdict stays
    // mechanically grounded.
    assert.deepEqual(REQUIRED_ORACLE_EVIDENCE.O16, ['run_events', 'database_snapshot']);

    // The fixture supplies every evidence key, so both new gating oracles pass
    // requireOracleEvidence validation (contract-valid contexts for O4/O16).
    for (const oracleId of ['O4', 'O16']) {
      const context = createOracleContext({ ...data, oracleId });
      assert.deepEqual(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }), [],
        `${oracleId} context must validate with the complete key set`);
      assert.equal(context.oracle_id, oracleId);
    }

    // A context missing probe_evidence is STILL contract-valid for O16 (S25):
    // the snapshot leaves the reference null when the probe machinery never
    // ran, and O16 answers NOT_EVALUABLE on that shape instead of failing
    // closed as TEST_INFRA. run_events/database_snapshot absence still fails
    // closed.
    const withoutProbe = createOracleContext({ ...data, oracleId: 'O16' });
    withoutProbe.mechanical_evidence.references.probe_evidence = null;
    assert.deepEqual(validateOracleContext(withoutProbe, data.campaignDir, { requireOracleEvidence: true }), [],
      'O16 must not require probe_evidence (non-probe case shape)');
    const withoutEvents = createOracleContext({ ...data, oracleId: 'O16' });
    withoutEvents.mechanical_evidence.references.run_events = null;
    assert.match(
      validateOracleContext(withoutEvents, data.campaignDir, { requireOracleEvidence: true }).join('\n'),
      /run_events is required for O16/,
    );
    // Same fail-closed behavior for O4's chaos_log leg.
    const withoutChaos = createOracleContext({ ...data, oracleId: 'O4' });
    withoutChaos.mechanical_evidence.references.chaos_log = null;
    assert.match(
      validateOracleContext(withoutChaos, data.campaignDir, { requireOracleEvidence: true }).join('\n'),
      /chaos_log is required for O4/,
    );
    // Optional keys stay optional for oracles that do not require them.
    const o1 = createOracleContext({ ...data, oracleId: 'O1' });
    o1.mechanical_evidence.references.probe_evidence = null;
    o1.mechanical_evidence.references.chaos_log = null;
    assert.deepEqual(validateOracleContext(o1, data.campaignDir, { requireOracleEvidence: true }), [],
      'O1 must not require probe_evidence/chaos_log');
  } finally {
    cleanup(data.campaignDir);
  }
});

test('projection excludes prose fields, raw stream references, STATUS lines, and absolute provenance paths', () => {
  const data = fixture();
  try {
    const serialized = JSON.stringify(createOracleContext({ ...data, oracleId: 'O11' }));
    for (const forbidden of [
      'AGENT_RESPONSE_SENTINEL', 'MODEL_TRANSCRIPT_SENTINEL', 'STATUS: done',
      'raw-agent-response.txt', 'model-transcript.txt', '/home/operator/.tamandua/tamandua.db',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `context leaked ${forbidden}`);
    }
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection pins the per-case production floor when W1 has no family sample', () => {
  const data = fixture();
  try {
    data.state.cases = data.state.cases.filter((item) => item.wave !== 1);
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.duration_floors, [{
      workflow: 'feature-dev-merge-worktree',
      case_id: 'CASE-1',
      duration_floor_ms: 120_000,
      source: 'production-median',
      sample_size: 0,
    }]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection keeps distinct per-case production floors inside one workflow family', () => {
  const data = fixture();
  try {
    data.state.cases = data.state.cases.filter((item) => item.wave !== 1);
    const secondAttempt = { ...data.caseState.attempts[0], run_id: 'run-33333333-3333-4333-8333-333333333333' };
    data.state.cases.push({
      id: 'CASE-2', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'running', expected_fast_failure: false,
      production_duration_floor_ms: 480_000, attempts: [secondAttempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    });
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.duration_floors, [
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-1', duration_floor_ms: 120_000, source: 'production-median', sample_size: 0 },
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-2', duration_floor_ms: 480_000, source: 'production-median', sample_size: 0 },
    ]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection falls back to the w1-median only for cases without a production pin', () => {
  const data = fixture();
  try {
    const secondAttempt = { ...data.caseState.attempts[0], run_id: 'run-33333333-3333-4333-8333-333333333333' };
    data.state.cases.push({
      id: 'CASE-2', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'running', expected_fast_failure: false,
      production_duration_floor_ms: null, attempts: [secondAttempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    });
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.duration_floors, [
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-1', duration_floor_ms: 120_000, source: 'production-median', sample_size: 0 },
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-2', duration_floor_ms: 300_000, source: 'w1-median', sample_size: 1 },
    ]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection records unavailable for a launched case with no pin and no W1 sample', () => {
  const data = fixture();
  try {
    data.state.cases = data.state.cases.filter((item) => item.wave !== 1);
    const secondAttempt = { ...data.caseState.attempts[0], run_id: 'run-33333333-3333-4333-8333-333333333333' };
    data.state.cases.push({
      id: 'CASE-2', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'running', expected_fast_failure: false,
      production_duration_floor_ms: null, attempts: [secondAttempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    });
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.duration_floors, [
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-1', duration_floor_ms: 120_000, source: 'production-median', sample_size: 0 },
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-2', duration_floor_ms: null, source: 'unavailable', sample_size: 0 },
    ]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection excludes non-completed attempts from the w1-median calibration sample', () => {
  const data = fixture();
  try {
    const w1 = data.state.cases.find((item) => item.id === 'W1-CALIBRATION');
    w1.attempts = [
      { ...data.caseState.attempts[0], id: 'attempt-w1-completed', run_id: 'run-55555555-5555-4555-8555-555555555555', started_at: '2026-08-01T11:55:00.000Z', terminal_status: 'completed' },
      { ...data.caseState.attempts[0], id: 'attempt-w1-canceled', run_id: 'run-66666666-6666-4666-8666-666666666666', started_at: '2026-08-01T11:59:30.000Z', terminal_status: 'canceled' },
      { ...data.caseState.attempts[0], id: 'attempt-w1-runaway', run_id: 'run-77777777-7777-4777-8777-777777777777', started_at: '2026-08-01T11:59:30.000Z', terminal_at: null, terminal_status: null, phase: 'running' },
    ];
    const secondAttempt = { ...data.caseState.attempts[0], run_id: 'run-33333333-3333-4333-8333-333333333333' };
    data.state.cases.push({
      id: 'CASE-2', wave: 3, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'running', expected_fast_failure: false,
      production_duration_floor_ms: null, attempts: [secondAttempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    });
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    // A median over all three attempts would be 30s; the completed-only sample is 300s.
    assert.deepEqual(context.o1_wave.duration_floors, [
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-1', duration_floor_ms: 120_000, source: 'production-median', sample_size: 0 },
      { workflow: 'feature-dev-merge-worktree', case_id: 'CASE-2', duration_floor_ms: 300_000, source: 'w1-median', sample_size: 1 },
    ]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('O1 wave projection never lets the run under judgment calibrate itself', () => {
  const data = fixture();
  try {
    const judgedAttempts = [
      { ...data.caseState.attempts[0], id: 'attempt-1-prior', run_id: 'run-prior-0000-0000-4000-8000-000000000000', started_at: '2026-08-01T11:55:00.000Z' },
      { ...data.caseState.attempts[0], id: 'attempt-2-judged', run_id: 'run-judged-0000-0000-4000-8000-000000000000', started_at: '2026-08-01T11:59:30.000Z' },
    ];
    data.caseRecord = { ...data.caseRecord, wave: 1 };
    data.state.cases = [{
      id: 'CASE-1', wave: 1, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'terminal', expected_fast_failure: false,
      production_duration_floor_ms: null, attempts: judgedAttempts, findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    }];
    const context = createOracleContext({ ...data, caseState: { attempts: judgedAttempts }, oracleId: 'O1' });
    // Without the exclusion the median of [300s, 30s] = 165s would become the floor.
    assert.deepEqual(context.o1_wave.duration_floors, [{
      workflow: 'feature-dev-merge-worktree',
      case_id: 'CASE-1',
      duration_floor_ms: 300_000,
      source: 'w1-median',
      sample_size: 1,
    }]);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('validation rejects malformed and escaping evidence references', () => {
  const data = fixture();
  try {
    const malformed = createOracleContext({ ...data, oracleId: 'O2' });
    malformed.mechanical_evidence.references.database_snapshot = { path: 42 };
    assert.match(validateOracleContext(malformed, data.campaignDir).join('\n'), /database_snapshot.*reference/);

    const escaping = createOracleContext({ ...data, oracleId: 'O2' });
    escaping.mechanical_evidence.references.database_snapshot = {
      ...data.references.database_snapshot,
      path: '../outside.sqlite',
    };
    assert.match(validateOracleContext(escaping, data.campaignDir).join('\n'), /database_snapshot.*campaign-relative/);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('validation rejects symlink evidence even when its target is contained', () => {
  const data = fixture();
  try {
    const linkPath = path.join(data.campaignDir, 'snapshots', 'database-link.json');
    fs.symlinkSync('database_snapshot.json', linkPath);
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    context.mechanical_evidence.references.database_snapshot = {
      ...data.references.database_snapshot,
      path: 'snapshots/database-link.json',
    };
    assert.match(validateOracleContext(context, data.campaignDir).join('\n'), /database_snapshot.*regular non-symlink/);
  } finally {
    cleanup(data.campaignDir);
  }
});

// S41 (US-004): probe-sequence sibling runs ride in the attempt's
// probe_evidence.runs[] (multi-run probe shapes — W4.10-restart-recovery's
// two concurrent runs). createOracleContext must register every non-root
// sibling in context.discovered_runs (projected through the validated
// attempt shape, parent = root run) so O1/O11 audit the sibling instead of
// firing O1_WORKFLOW_RUN_UNKNOWN / O11_DELTA_RUN_UNKNOWN, and must NOT
// duplicate siblings the controller already registered in
// state.discovered_runs.
test('S41: probe-sequence sibling runs are projected into context.discovered_runs (deduped against state)', () => {
  const data = fixture();
  try {
    const attempt = data.state.cases[0].attempts[0];
    const rootRunId = attempt.run_id;
    const siblingRunId = 'run-55555555-5555-4555-8555-555555555555';
    // The multi-run probe shape: the durable attempt carries probe_evidence
    // naming every probed run with its per-run terminal snapshot (the
    // controller now fills these from the harvested proxies).
    const siblingSteps = {
      source: 'workflow-status-json', captured_at: '2026-08-01T12:00:05.000Z',
      steps: [{ stepId: 'step-1', agentRole: 'developer', status: 'done' }],
    };
    attempt.probe_evidence = {
      schema_version: 1,
      case_id: 'CASE-1',
      launch_shape: 'concurrent',
      sequence_outcome: 'completed',
      runs: [
        { run_ordinal: 1, run_id: rootRunId, terminal_status: 'completed', tokens_observed: 17, steps_snapshot: attempt.steps_snapshot },
        { run_ordinal: 2, run_id: siblingRunId, terminal_status: 'completed', tokens_observed: 9, steps_snapshot: siblingSteps },
      ],
    };
    const caseState = { attempts: data.state.cases[0].attempts };
    const context = createOracleContext({ ...data, caseState, oracleId: 'O1' });
    const sibling = context.discovered_runs.find((run) => run.run_id === siblingRunId);
    assert.ok(sibling, 'probe-sequence sibling must be projected into context.discovered_runs');
    assert.equal(sibling.parent_run_id, rootRunId);
    assert.equal(sibling.terminal_status, 'completed');
    assert.equal(sibling.tokens_observed, 9);
    assert.deepEqual(sibling.steps_snapshot.steps, [{ stepId: 'step-1', agentRole: 'developer', status: 'done' }]);
    assert.equal(sibling.steps_snapshot.source, 'workflow-status-json');
    assert.equal(sibling.kind, 'discovered-workflow');
    assert.equal(sibling.phase, 'terminal');
    assert.equal(sibling.execution_mode, 'real');
    // The state.discovered_runs sibling (run-22222222...) is still present.
    assert.ok(context.discovered_runs.some((run) => run.run_id === 'run-22222222-2222-4222-8222-222222222222'));
    // The o1_wave projection includes the probe sibling (deduped against the
    // state-registered row) so O1's wave coverage never fires
    // O1_WAVE_RUN_MISSING on the fallback-registered sibling.
    const waveSiblingRows = context.o1_wave.runs.filter((run) => run.run_id === siblingRunId);
    assert.equal(waveSiblingRows.length, 1, 'o1_wave must include the probe sibling exactly once');
    assert.equal(waveSiblingRows[0].terminal_status, 'completed');
    // No duplicates across state + probe registrations.
    const runIds = context.discovered_runs.map((run) => run.run_id);
    assert.equal(new Set(runIds).size, runIds.length, 'discovered runs must be unique');
    assert.equal(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }).length, 0);
  } finally {
    cleanup(data.campaignDir);
  }
});

test('S41: the root attempt projection inherits the primary probe run terminal snapshot (O11 root reconciliation)', () => {
  const data = fixture();
  try {
    const attempt = data.state.cases[0].attempts[0];
    const rootRunId = attempt.run_id;
    const primarySteps = attempt.steps_snapshot;
    // The durable attempt was never harvested in the concurrent shape: its
    // tokens stayed 0 and steps null; the primary probe run carries the real
    // snapshot (the controller binds it back onto the attempt post-harvest).
    attempt.tokens_observed = 0;
    attempt.steps_snapshot = null;
    attempt.probe_evidence = {
      schema_version: 1,
      case_id: 'CASE-1',
      launch_shape: 'concurrent',
      sequence_outcome: 'completed',
      runs: [
        { run_ordinal: 1, run_id: rootRunId, terminal_status: 'completed', tokens_observed: 17, steps_snapshot: primarySteps },
      ],
    };
    // Simulate the controller's S41 binding of the primary snapshot onto the
    // durable attempt (executeMultiRunProbeCase copies it before classification).
    attempt.tokens_observed = 17;
    attempt.steps_snapshot = primarySteps;
    const caseState = { attempts: data.state.cases[0].attempts };
    const context = createOracleContext({ ...data, caseState, oracleId: 'O11' });
    const rootProjection = context.attempts.find((entry) => entry.run_id === rootRunId);
    assert.equal(rootProjection.tokens_observed, 17);
    assert.equal(rootProjection.steps_snapshot.source, 'workflow-status-json');
    assert.equal(rootProjection.steps_snapshot.steps[0].stepId, 'step-1');
    assert.equal(rootProjection.steps_snapshot.steps[0].status, 'done');
    assert.equal(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }).length, 0);
  } finally {
    cleanup(data.campaignDir);
  }
});
