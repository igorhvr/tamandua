#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FindingCollector,
  loadOracleInvocation,
  openEvidenceDatabase,
  runGit,
  validateOracleResponse,
  writeEvidenceJson,
} from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ALL_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function makeFixture(oracleId = 'O1') {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const campaignRoot = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-runtime-test.'));
  fs.writeFileSync(path.join(campaignRoot, 'state.json'), '{}\n');
  const snapshots = path.join(campaignRoot, 'snapshots');
  const evidenceDir = path.join(campaignRoot, 'evidence', 'CASE-1', 'attempt-1', 'oracles', oracleId);
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const capturedAt = '2026-08-01T12:00:00.000Z';
  const references = Object.fromEntries(ALL_KEYS.map((key) => [key, null]));
  for (const key of ['run_events', 'workflow_status']) {
    const content = `${JSON.stringify({ key })}\n`;
    const file = path.join(snapshots, `${key}.json`);
    fs.writeFileSync(file, content, { mode: 0o400 });
    references[key] = { path: `snapshots/${key}.json`, sha256: sha256(content), captured_at: capturedAt, source: 'controller-snapshot' };
  }
  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES (\'mechanical\')');
  database.close();
  fs.chmodSync(databasePath, 0o400);
  references.database_snapshot = {
    path: 'snapshots/database.sqlite', sha256: sha256(fs.readFileSync(databasePath)),
    captured_at: capturedAt, source: 'controller-snapshot',
  };
  const context = {
    contract_version: 1,
    oracle_id: oracleId,
    campaign: { id: 'campaign-test', created_at: capturedAt, manifest: { sha256: 'a'.repeat(64), case_count: 1, case_ids: ['CASE-1'] } },
    case: { id: 'CASE-1', wave: 0, workflow: 'local', fixture: 'tt-ts', harness: 'local', class: 'verification', caps: { tokens: 1, wall_min: 1 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: 'run-11111111-1111-4111-8111-111111111111',
    attempts: [{ id: 'attempt-1', kind: 'workflow', phase: 'terminal', execution_mode: 'real', run_id: 'run-11111111-1111-4111-8111-111111111111', started_at: capturedAt, terminal_at: capturedAt, terminal_status: 'completed', tokens_observed: 1, command_result: { exit_code: 0, signal: null }, steps_snapshot: null, straggler_capture: null }],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 0, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400 });
  const env = {
    TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: oracleId,
    TT_ORACLE_CONTEXT: contextPath, TT_ORACLE_EVIDENCE_DIR: evidenceDir,
    TT_CASE_ID: 'CASE-1', TT_CAMPAIGN_ID: 'campaign-test', TT_RUN_ID: context.run_id,
  };
  return { campaignRoot, context, contextPath, databasePath, evidenceDir, env };
}

function invocationArgs(contextPath, version = '1') {
  return ['node', 'oracle', '--contract-version', version, '--context', contextPath];
}

function cleanup(root) {
  fs.chmodSync(path.join(root, 'snapshots', 'database.sqlite'), 0o600);
  fs.rmSync(root, { recursive: true, force: true });
}

test('loads a complete contained CONTRACT v1 invocation and opens SQLite read-only', () => {
  const fixture = makeFixture();
  try {
    const invocation = loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env });
    assert.equal(invocation.oracleId, 'O1');
    assert.equal(invocation.campaignRoot, fixture.campaignRoot);
    const database = openEvidenceDatabase(invocation, 'database_snapshot');
    assert.equal(database.prepare('SELECT value FROM sample').get().value, 'mechanical');
    assert.throws(() => database.exec("INSERT INTO sample VALUES ('forbidden')"), /read.?only/i);
    database.close();
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('rejects wrong versions, identity mismatches, malformed context, and missing evidence', () => {
  const fixture = makeFixture();
  try {
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath, '2'), env: fixture.env }), /contract version/i);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: { ...fixture.env, TT_ORACLE_ID: 'O2' } }), /oracle.*mismatch/i);
    const malformedPath = path.join(fixture.evidenceDir, 'malformed.json');
    fs.writeFileSync(malformedPath, '{}\n');
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(malformedPath), env: { ...fixture.env, TT_ORACLE_CONTEXT: malformedPath } }), /malformed|contract_version|context/i);
    const malformedContext = structuredClone(fixture.context);
    malformedContext.attempts = [{ id: null, output: 'agent prose must not enter a mechanical context' }];
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(malformedContext)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /malformed.*attempt/i);
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(fixture.context)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    const malformedStepContext = structuredClone(fixture.context);
    malformedStepContext.attempts[0].steps_snapshot = {
      source: 'workflow-status-json', captured_at: '2026-08-01T12:00:00.000Z',
      steps: [{ stepId: 'step-a', step_id: 'step-b', agentId: 'agent-1', status: 'invented', type: 'prose', retryCount: 1, retry_count: 2 }],
    };
    malformedStepContext.attempts[0].terminal_at = null;
    malformedStepContext.attempts[0].terminal_status = 'done';
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(malformedStepContext)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /malformed.*attempt/i);
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(fixture.context)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    const malformedReferenceContext = structuredClone(fixture.context);
    malformedReferenceContext.mechanical_evidence.references.run_events.extra = 'covert';
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(malformedReferenceContext)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /malformed.*evidence/i);
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(fixture.context)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    const missingPath = path.join(fixture.campaignRoot, 'snapshots', 'run_events.json');
    fs.chmodSync(missingPath, 0o600);
    fs.rmSync(missingPath);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /run_events.*missing|regular non-symlink/i);
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('rejects context and evidence symlink or path escapes', () => {
  const fixture = makeFixture();
  try {
    const contextLink = path.join(fixture.evidenceDir, 'context-link.json');
    fs.symlinkSync('context.json', contextLink);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(contextLink), env: { ...fixture.env, TT_ORACLE_CONTEXT: contextLink } }), /context.*symlink/i);

    fixture.context.mechanical_evidence.references.run_events.path = '../outside.json';
    fs.chmodSync(fixture.contextPath, 0o600);
    fs.writeFileSync(fixture.contextPath, `${JSON.stringify(fixture.context)}\n`);
    fs.chmodSync(fixture.contextPath, 0o400);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /run_events.*campaign-relative/i);
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('database access has no default fallback and rejects writable snapshots', () => {
  const fixture = makeFixture();
  try {
    const invocation = loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env });
    assert.throws(() => openEvidenceDatabase(invocation, 'not_a_reference'), /not.*evidence reference/i);
    fs.chmodSync(fixture.databasePath, 0o600);
    assert.throws(() => openEvidenceDatabase(invocation, 'database_snapshot'), /writable/i);
    assert.throws(() => loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env }), /database_snapshot.*writable/i);
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('evidence writes are contained, exclusive, and response validation pins result exits', () => {
  const fixture = makeFixture();
  try {
    const invocation = loadOracleInvocation({ argv: invocationArgs(fixture.contextPath), env: fixture.env });
    const reference = writeEvidenceJson(invocation, 'queries/result.json', { rows: 1 }, 'sqlite');
    assert.deepEqual(reference, { path: 'queries/result.json', kind: 'sqlite' });
    assert.throws(() => writeEvidenceJson(invocation, 'queries/result.json', { rows: 2 }, 'sqlite'), /exist|exclusive/i);
    assert.throws(() => writeEvidenceJson(invocation, '../escape.json', {}, 'filesystem'), /contained|relative/i);

    const now = new Date().toISOString();
    const response = { contract_version: 1, oracle_id: 'O1', result: 'PASS', started_at: now, finished_at: now, findings: [], evidence: [reference] };
    assert.deepEqual(validateOracleResponse(response, 'O1', 0, fixture.evidenceDir), []);
    assert.match(validateOracleResponse(response, 'O1', 1, fixture.evidenceDir).join('\n'), /contradicts/i);
    const notEvaluable = { ...response, result: 'NOT_EVALUABLE' };
    assert.deepEqual(validateOracleResponse(notEvaluable, 'O1', 3, fixture.evidenceDir), []);
    assert.match(validateOracleResponse(notEvaluable, 'O1', 0, fixture.evidenceDir).join('\n'), /contradicts/i);
    assert.match(validateOracleResponse({ ...notEvaluable, findings: [{ id: 'X', summary: 'degraded evidence must carry no findings' }] }, 'O1', 3, fixture.evidenceDir).join('\n'), /NOT_EVALUABLE must not contain findings/i);
    assert.match(validateOracleResponse({ ...response, classification: { prose: 'not mechanical' } }, 'O1', 0, fixture.evidenceDir).join('\n'), /classification.*unknown/i);
    assert.match(validateOracleResponse({ ...response, prose: 'not part of CONTRACT v1' }, 'O1', 0, fixture.evidenceDir).join('\n'), /unknown.*prose/i);
    assert.match(validateOracleResponse({ ...response, classification: { ambiguous: { category: 'test', extra: 'covert' } } }, 'O1', 0, fixture.evidenceDir).join('\n'), /ambiguous.*unknown/i);
    assert.match(validateOracleResponse({ ...response, evidence: [{ ...reference, extra: 'covert' }] }, 'O1', 0, fixture.evidenceDir).join('\n'), /evidence.*unknown/i);
    assert.match(validateOracleResponse({ ...response, evidence: [{ path: 'queries/../result.json', kind: 'sqlite' }] }, 'O1', 0, fixture.evidenceDir).join('\n'), /portable relative/i);
    assert.match(validateOracleResponse({ ...response, evidence: [{ path: 'C:/result.json', kind: 'sqlite' }] }, 'O1', 0, fixture.evidenceDir).join('\n'), /portable relative/i);
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('finding aggregation is deterministic and safe git execution stays contained', () => {
  const fixture = makeFixture();
  try {
    const findings = new FindingCollector();
    findings.add('B', 'second');
    findings.add('A', 'first', { observed: 1 });
    assert.deepEqual(findings.toJSON().map((item) => item.id), ['A', 'B']);

    const repo = path.join(fixture.campaignRoot, 'repo');
    fs.mkdirSync(repo);
    assert.equal(spawnSync('git', ['init', '-q', repo], { shell: false }).status, 0);
    const result = runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['rev-parse', '--is-inside-work-tree'] });
    assert.equal(result.stdout.trim(), 'true');
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: path.dirname(fixture.campaignRoot), args: ['rev-parse', 'HEAD'] }), /contained/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['-c', 'core.hooksPath=/tmp', 'status'] }), /unsafe/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['--git-dir=/tmp/outside', 'rev-parse', 'HEAD'] }), /unsafe/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['commit', '--allow-empty', '-m', 'mutation'] }), /read-only plumbing/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['reflog', 'delete', 'HEAD@{0}'] }), /read-only plumbing/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['log', '--show-signature', '-1'] }), /unsafe/i);
    assert.throws(() => runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['cat-file', '--filters', 'HEAD:file'] }), /unsafe/i);

    const fakeBin = path.join(fixture.campaignRoot, 'fake-bin');
    const marker = path.join(fixture.campaignRoot, 'fake-git-ran');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      assert.equal(runGit({ campaignRoot: fixture.campaignRoot, repository: repo, args: ['rev-parse', '--is-inside-work-tree'] }).stdout.trim(), 'true');
      assert.equal(fs.existsSync(marker), false);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    cleanup(fixture.campaignRoot);
  }
});

test('oracleMain emits one contract JSON object and maps PASS, FAIL, ERROR, and NOT_EVALUABLE to 0, 1, 2, and 3', () => {
  const fixture = makeFixture();
  try {
    const probe = path.join(fixture.campaignRoot, 'oracle-probe.mjs');
    const runtimeUrl = new URL('./index.mjs', import.meta.url).href;
    fs.writeFileSync(probe, `#!/usr/bin/env node\nimport {oracleMain} from ${JSON.stringify(runtimeUrl)};\nawait oracleMain(async () => {\n  if (process.env.PROBE_RESULT === 'ERROR') throw new Error('synthetic error');\n  if (process.env.PROBE_RESULT === 'INVALID') return {result:'PASS',findings:[{id:'BAD',summary:'invalid pass finding'}]};\n  if (process.env.PROBE_RESULT === 'NOT_EVALUABLE') return {result:'NOT_EVALUABLE',findings:[]};\n  return process.env.PROBE_RESULT === 'FAIL'\n    ? {result:'FAIL',findings:[{id:'PROBE',summary:'synthetic violation'}]}\n    : {result:'PASS',findings:[]};\n});\n`, { mode: 0o700 });
    for (const [probeResult, expectedResult, expectedExit] of [['PASS', 'PASS', 0], ['FAIL', 'FAIL', 1], ['ERROR', 'ERROR', 2], ['NOT_EVALUABLE', 'NOT_EVALUABLE', 3], ['INVALID', 'ERROR', 2]]) {
      const result = spawnSync(process.execPath, [probe, '--contract-version', '1', '--context', fixture.contextPath], {
        cwd: fixture.evidenceDir,
        encoding: 'utf8',
        shell: false,
        env: { ...process.env, ...fixture.env, PROBE_RESULT: probeResult },
      });
      assert.equal(result.status, expectedExit, result.stderr);
      const response = JSON.parse(result.stdout.trim());
      assert.equal(response.result, expectedResult);
      assert.deepEqual(validateOracleResponse(response, 'O1', expectedExit, fixture.evidenceDir), []);
      assert.equal(result.stdout.trim().split('\n').length, 1);
    }
  } finally {
    cleanup(fixture.campaignRoot);
  }
});
