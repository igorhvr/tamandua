#!/usr/bin/env node
// tt-oracle-replay.test.mjs — E3.B US-010: offline evidence-replay tool tests.
//
// Covers: deterministic pair collection, before->after delta reporting,
// NOT_EVALUABLE response parsing, copy-on-replay read-only enforcement on the
// source campaign, workspace cleanup, and the tool's exit-code contract.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const TT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const REPLAY_TOOL = path.join(TT_ROOT, 'bin', 'tt-oracle-replay');

const replay = await import(pathToFileURL(REPLAY_TOOL).href);

const CAPTURED_AT = '2026-08-01T12:00:00.000Z';
const RUN_ID = 'run-66666666-6666-4666-8666-666666666666';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function testRoot() {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(VAR_ROOT, 'tt-oracle-replay-test.'));
}

function reference(campaign, file) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(file)),
    captured_at: CAPTURED_AT,
    source: 'synthetic-replay-fixture',
  };
}

function writeSnapshot(snapshots, name, value) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return file;
}

function writeDatabase(snapshots, statements) {
  const file = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(file);
  database.exec(statements);
  database.close();
  fs.chmodSync(file, 0o400);
  return file;
}

function emptyReferences() {
  return Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
}

function context({ caseId, oracleId, runId, attempts, references }) {
  return {
    contract_version: 1,
    oracle_id: oracleId,
    campaign: {
      id: 'campaign-20260813T123604986Z-synthetic',
      created_at: CAPTURED_AT,
      manifest: { sha256: 'a'.repeat(64), case_count: 2, case_ids: ['C1', 'C2'] },
    },
    case: {
      id: caseId, wave: 1, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic',
      harness: 'scripted-pi', class: 'verification',
      caps: { tokens: 100, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: null,
    },
    run_id: runId,
    attempts,
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 1, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
}

function writePair(campaign, { caseId, oracle, contextValue, storedVerdict }) {
  const snapshots = path.join(campaign, 'snapshots', caseId, 'attempt-1');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  const oracleDir = path.join(campaign, 'evidence', caseId, 'attempt-1', 'oracles', oracle);
  fs.mkdirSync(oracleDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(oracleDir, 'context.json'), `${JSON.stringify(contextValue, null, 2)}\n`);
  fs.writeFileSync(path.join(oracleDir, 'stdout.json'), `${JSON.stringify(storedVerdict, null, 2)}\n`);
  return oracleDir;
}

// Synthetic two-oracle campaign (one case per oracle):
//   C1/O3z — the replayed evidence is honest (zero tokens everywhere, no runs),
//            so the oracle now PASSes while the stored stdout.json says FAIL:
//            a known before/after flip (FAIL -> PASS).
//   C2/O10 — launch_intent.gate_key is null: the replayed oracle answers
//            NOT_EVALUABLE while the stored stdout.json (campaign-#7 shape)
//            says ERROR: flip ERROR -> NOT_EVALUABLE.
function buildSyntheticCampaign(root) {
  const campaign = path.join(root, 'campaign-20260813T123604986Z-synthetic');
  fs.mkdirSync(campaign, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');

  {
    const caseId = 'C1';
    const snapshots = path.join(campaign, 'snapshots', caseId, 'attempt-1');
    fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
    const databasePath = writeDatabase(snapshots, `
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL);
      CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);
      INSERT INTO tamandua_stats VALUES (1, 0);
    `);
    const systemTokens = {
      schema_version: 1, captured_at: CAPTURED_AT, table_present: true,
      rows: [{ system_tokens_spent: 0 }], value: 0,
    };
    const references = emptyReferences();
    references.database_snapshot = reference(campaign, databasePath);
    references.system_tokens_before = reference(campaign, writeSnapshot(snapshots, 'system-tokens-before.json', systemTokens));
    references.system_tokens_after = reference(campaign, writeSnapshot(snapshots, 'system-tokens-after.json', systemTokens));
    writePair(campaign, {
      caseId,
      oracle: 'O3z',
      contextValue: context({ caseId, oracleId: 'O3z', runId: null, attempts: [], references }),
      storedVerdict: {
        contract_version: 1, oracle_id: 'O3z',
        result: 'FAIL', started_at: CAPTURED_AT, finished_at: CAPTURED_AT,
        findings: [{ id: 'O3Z_SYSTEM_TOKENS_NONZERO', summary: 'stale stored verdict (replayed evidence is honest)' }],
        evidence: [],
      },
    });
  }

  {
    const caseId = 'C2';
    const snapshots = path.join(campaign, 'snapshots', caseId, 'attempt-1');
    fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
    const databasePath = writeDatabase(snapshots, `
      CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE stories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
    `);
    const attempt = {
      id: 'attempt-1', kind: 'workflow', phase: 'terminal', execution_mode: 'scripted',
      run_id: RUN_ID, started_at: '2026-08-01T11:00:00.000Z', terminal_at: CAPTURED_AT,
      terminal_status: 'completed', tokens_observed: 0,
      command_result: { exit_code: 0, signal: null }, steps_snapshot: null, straggler_capture: null,
    };
    const references = emptyReferences();
    references.database_snapshot = reference(campaign, databasePath);
    references.run_events = reference(campaign, writeSnapshot(snapshots, 'run-events.json', {
      schema_version: 1, captured_at: CAPTURED_AT, run_ids: [RUN_ID], rows: [],
    }));
    references.launch_intent = reference(campaign, writeSnapshot(snapshots, 'launch-intent.json', {
      schema_version: 1, captured_at: CAPTURED_AT, case_id: caseId,
      workflow: 'feature-dev-merge-worktree', fixture: 'synthetic', harness: 'scripted-pi',
      execution_mode: 'scripted',
      repository: { path: 'fixtures/synthetic-replay', origin_repo: '/torture-test/fixtures/synthetic-replay' },
      policy: { merge_gate: 'off', fail_missing: null, execution_mode: 'scripted' },
      gate_key: null,
      argv: ['workflow', 'run'], argv_sha256: 'b'.repeat(64), launch_intent_at: CAPTURED_AT,
    }));
    references.refs_before = reference(campaign, writeSnapshot(snapshots, 'refs-before.json', {
      schema_version: 1, phase: 'before',
      repository: { path: 'fixtures/synthetic-replay', origin_repo: '/torture-test/fixtures/synthetic-replay' },
      target_ref: 'refs/heads/main', target_tip: 'c'.repeat(40), for_each_ref: '',
    }));
    references.refs_after = reference(campaign, writeSnapshot(snapshots, 'refs-after.json', {
      schema_version: 1, phase: 'after',
      repository: { path: 'fixtures/synthetic-replay', origin_repo: '/torture-test/fixtures/synthetic-replay' },
      target_ref: 'refs/heads/main', target_tip: 'c'.repeat(40), for_each_ref: '',
    }));
    references.suite_ledger = reference(campaign, writeSnapshot(snapshots, 'suite-ledger.json', {
      schema_version: 1, captured_at: CAPTURED_AT, rows: [],
    }));
    references.suite_observations = reference(campaign, writeSnapshot(snapshots, 'suite-observations.json', {
      schema_version: 1, captured_at: CAPTURED_AT, ttl_green_ms: 86_400_000, rows: [],
      singleflight_observations: [], special_exit_observations: [], origin_identities: [],
    }));
    references.submit_rejections = reference(campaign, writeSnapshot(snapshots, 'submit-rejections.json', {
      schema_version: 1, captured_at: CAPTURED_AT, rows: [],
    }));
    writePair(campaign, {
      caseId,
      oracle: 'O10',
      contextValue: context({ caseId, oracleId: 'O10', runId: RUN_ID, attempts: [attempt], references }),
      storedVerdict: {
        contract_version: 1, oracle_id: 'O10',
        result: 'ERROR', started_at: CAPTURED_AT, finished_at: CAPTURED_AT,
        findings: [{ id: 'ORACLE_RUNTIME_ERROR', summary: 'launch_intent.gate_key is null (campaign #7 stored shape)' }],
        evidence: [],
      },
    });
  }

  return campaign;
}

function runTool(campaign, extraArgs = [], workspaceRoot = null) {
  const root = workspaceRoot ?? fs.mkdtempSync(path.join(VAR_ROOT, 'tt-oracle-replay-workspaces.'));
  const result = spawnSync(process.execPath, [REPLAY_TOOL, '--campaign', campaign, '--workspace-root', root, ...extraArgs], {
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { root, result };
}

test('replays every case x oracle pair and reports before/after flips with finding ids', () => {
  const root = testRoot();
  try {
    const campaign = buildSyntheticCampaign(root);
    const digestBefore = replay.computeCampaignDigest(campaign);
    const jsonPath = path.join(root, 'replay.json');
    const { root: workspaceRoot, result } = runTool(campaign, ['--json', jsonPath]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const table = result.stdout;
    const o3zRow = table.split('\n').find((line) => line.includes('O3z'));
    const o10Row = table.split('\n').find((line) => line.includes('O10'));
    assert.match(o3zRow, /C1\s+attempt-1\s+O3z\s+FAIL\s+PASS\s+flip\s+-\s*$/);
    assert.match(o10Row, /C2\s+attempt-1\s+O10\s+ERROR\s+NOT_EVALUABLE\s+flip\s+-\s*$/);
    assert.match(table, /pairs: 2\s+flips: 2\s+unchanged: 0\s+invoke_failures: 0/);
    assert.match(table, /transitions: ERROR->NOT_EVALUABLE: 1, FAIL->PASS: 1/);

    const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(report.rows.map((row) => [row.caseId, row.attempt, row.oracle, row.before, row.after, row.delta]), [
      ['C1', 'attempt-1', 'O3z', 'FAIL', 'PASS', 'flip'],
      ['C2', 'attempt-1', 'O10', 'ERROR', 'NOT_EVALUABLE', 'flip'],
    ]);
    assert.deepEqual(report.rows.map((row) => row.findingIds), [[], []]);
    assert.ok(report.rows.every((row) => row.invokeError === null));
    assert.deepEqual(report.summary, {
      pairs: 2, flips: 2, unchanged: 0, invoke_failures: 0, source_campaign_unchanged: true,
    });

    // Read-only enforcement: the source campaign must be byte-identical.
    assert.deepEqual(replay.computeCampaignDigest(campaign), digestBefore);
    assert.deepEqual(replay.verifyCampaignUnchanged(digestBefore, campaign), []);

    // Copy-on-replay: the workspace was created beneath --workspace-root ...
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    // ... and cleaned up again after a completed replay (default behavior).
    const second = runTool(campaign, [], path.join(root, 'clean-check'));
    assert.equal(second.result.status, 0, `stderr: ${second.result.stderr}`);
    assert.deepEqual(fs.readdirSync(second.root), []);
    fs.rmSync(second.root, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read-only enforcement detects a modified source campaign file', () => {
  const root = testRoot();
  try {
    const campaign = buildSyntheticCampaign(root);
    const digestBefore = replay.computeCampaignDigest(campaign);
    const storedVerdict = path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z', 'stdout.json');
    fs.appendFileSync(storedVerdict, '\n');
    assert.deepEqual(replay.verifyCampaignUnchanged(digestBefore, campaign), [
      'evidence/C1/attempt-1/oracles/O3z/stdout.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectReplayPairs is deterministic and requires context.json + stdout.json', () => {
  const root = testRoot();
  try {
    const campaign = path.join(root, 'campaign-20260813T123604986Z-walk');
    fs.mkdirSync(path.join(campaign, 'evidence', 'C2', 'attempt-1', 'oracles', 'O9'), { recursive: true });
    fs.mkdirSync(path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z'), { recursive: true });
    fs.mkdirSync(path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O10'), { recursive: true });
    fs.mkdirSync(path.join(campaign, 'evidence', 'C3', 'attempt-2', 'oracles', 'O1'), { recursive: true });
    const write = (caseId, attempt, oracle, names) => {
      const dir = path.join(campaign, 'evidence', caseId, attempt, 'oracles', oracle);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(dir, name), '{}');
    };
    write('C2', 'attempt-1', 'O9', ['context.json', 'stdout.json']);
    write('C1', 'attempt-1', 'O3z', ['context.json', 'stdout.json']);
    write('C1', 'attempt-1', 'O10', ['context.json']); // missing stdout.json -> not replayable
    write('C3', 'attempt-2', 'O1', ['context.json', 'stdout.json']); // attempt-2, but no attempt-1
    const pairs = replay.collectReplayPairs(campaign);
    assert.deepEqual(pairs.map((pair) => [pair.caseId, pair.attempt, pair.oracle]), [
      ['C1', 'attempt-1', 'O3z'],
      ['C2', 'attempt-1', 'O9'],
      ['C3', 'attempt-2', 'O1'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pair with a corrupted context is recorded as an invoke error and the replay still completes', () => {
  const root = testRoot();
  try {
    const campaign = buildSyntheticCampaign(root);
    fs.writeFileSync(path.join(campaign, 'evidence', 'C2', 'attempt-1', 'oracles', 'O10', 'context.json'), '{not json');
    const { root: workspaceRoot, result } = runTool(campaign, []);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const o10Row = result.stdout.split('\n').find((line) => line.includes('O10'));
    assert.match(o10Row, /ERROR\s+ERROR\s+same\s+ORACLE_REPLAY_INVOKE_ERROR\s*$/);
    assert.match(result.stdout, /invoke_failures: 1/);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exit 1 when the campaign has no replayable pairs', () => {
  const root = testRoot();
  try {
    const campaign = path.join(root, 'campaign-empty');
    fs.mkdirSync(campaign, { recursive: true });
    fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');
    const { result } = runTool(campaign, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no replayable evidence pairs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exit 1 when no pair could be invoked', () => {
  const root = testRoot();
  try {
    const campaign = path.join(root, 'campaign-dead');
    fs.mkdirSync(path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z'), { recursive: true });
    fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');
    fs.writeFileSync(path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z', 'context.json'), '{not json');
    fs.writeFileSync(path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z', 'stdout.json'), '{}');
    const { result } = runTool(campaign, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no pair could be invoked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--keep-workspaces preserves the replay workspace; --help prints usage', () => {
  const root = testRoot();
  try {
    const campaign = buildSyntheticCampaign(root);
    const { root: workspaceRoot, result } = runTool(campaign, ['--keep-workspaces']);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const kept = fs.readdirSync(workspaceRoot).filter((name) => name.startsWith('replay-'));
    assert.equal(kept.length, 1);
    const sessionDir = path.join(workspaceRoot, kept[0]);
    assert.ok(fs.existsSync(path.join(sessionDir, 'state.json')));
    assert.ok(fs.existsSync(path.join(sessionDir, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z', 'o3z-token-gate.json')));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });

    const help = spawnSync(process.execPath, [REPLAY_TOOL, '--help'], { encoding: 'utf8', shell: false });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage: tt-oracle-replay/);
    assert.match(help.stdout, /TT_REPLAY_CAMPAIGN_DIR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs and campaign resolution follow the documented precedence', () => {
  assert.deepEqual(replay.parseArgs(['--campaign', '/tmp/x']).campaign, '/tmp/x');
  assert.equal(replay.parseArgs(['--help']).help, true);
  assert.throws(() => replay.parseArgs(['--bogus', 'x']), /invalid argument/);
  assert.throws(() => replay.parseArgs(['--workspace-root', TT_ROOT]), /not a source tree root/);

  const root = testRoot();
  try {
    const one = path.join(root, 'results', 'campaign-20260813T123604986Z-aaa');
    fs.mkdirSync(one, { recursive: true });
    fs.writeFileSync(path.join(one, 'state.json'), '{}\n');
    assert.equal(replay.autoDetectCampaign(path.join(root, 'results')), one);

    const two = path.join(root, 'results', 'campaign-20260813T123604986Z-bbb');
    fs.mkdirSync(two, { recursive: true });
    fs.writeFileSync(path.join(two, 'state.json'), '{}\n');
    assert.throws(() => replay.autoDetectCampaign(path.join(root, 'results')), /multiple/);

    fs.rmSync(two, { recursive: true, force: true });
    fs.rmSync(one, { recursive: true, force: true });
    assert.throws(() => replay.autoDetectCampaign(path.join(root, 'results')), /no campaign-20260813T123604986Z-/);

    const explicit = path.join(root, 'picked');
    fs.mkdirSync(explicit, { recursive: true });
    fs.writeFileSync(path.join(explicit, 'state.json'), '{}\n');
    assert.equal(replay.resolveCampaignDir({ campaign: null, workspaceRoot: '/tmp' }, { TT_REPLAY_CAMPAIGN_DIR: explicit }), explicit);
    assert.equal(replay.resolveCampaignDir({ campaign: explicit, workspaceRoot: '/tmp' }), explicit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
