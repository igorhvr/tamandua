#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GATING_ORACLE_IDS,
  ORACLE_EVIDENCE_KEYS,
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
      production_duration_floor_ms: 120_000, attempts: [attempt], findings: [], oracle_results: [],
      spend: { tokens_observed: 17, observations: [] },
    }, {
      id: 'W1-CALIBRATION', wave: 1, workflow: 'feature-dev-merge-worktree', fixture: 'tt-ts',
      harness: 'hermes', class: 'verification', phase: 'terminal', expected_fast_failure: false,
      production_duration_floor_ms: 120_000,
      attempts: [{ ...attempt, id: 'attempt-w1', started_at: '2026-08-01T11:55:00.000Z' }],
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
    assert.deepEqual(GATING_ORACLE_IDS, ['O1', 'O2', 'O3z', 'O8', 'O9', 'O10', 'O11']);
    for (const oracleId of GATING_ORACLE_IDS) {
      const context = createOracleContext({ ...data, oracleId });
      assert.deepEqual(validateOracleContext(context, data.campaignDir, { requireOracleEvidence: true }), []);
      assert.equal(context.oracle_id, oracleId);
      assert.equal(context.mechanical_evidence.schema_version, 1);
      assert.deepEqual(Object.keys(context.mechanical_evidence.references), ORACLE_EVIDENCE_KEYS);
      assert.equal(context.attempts[0].steps_snapshot.steps[0].updatedAt, data.state.created_at);
      assert.equal(context.o1_wave.duration_floors[0].source, 'w1-median');
      assert.equal(context.o1_wave.duration_floors[0].duration_floor_ms, 300_000);
      assert.equal(context.o1_wave.runs[0].expected_fast_failure, false);
    }
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

test('O1 wave projection falls back to the pinned production median when W1 has no family sample', () => {
  const data = fixture();
  try {
    data.state.cases = data.state.cases.filter((item) => item.wave !== 1);
    const context = createOracleContext({ ...data, oracleId: 'O1' });
    assert.deepEqual(context.o1_wave.duration_floors, [{
      workflow: 'feature-dev-merge-worktree',
      duration_floor_ms: 120_000,
      source: 'production-median',
      sample_size: 0,
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
