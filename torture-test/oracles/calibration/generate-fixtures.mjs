#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const SELF_TEST_DIR = path.join(HERE, '..', 'self-test');
const workspace = path.resolve(process.argv[2] ?? '');

if (workspace === VAR_ROOT || !workspace.startsWith(`${VAR_ROOT}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('calibration workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const staging = path.join(workspace, 'oracle-self-test.calibration');
fs.mkdirSync(staging, { mode: 0o700, flag: 'wx' });

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
if (manifest.schema_version !== 1 || manifest.contract_version !== 1 || manifest.runtime_root !== 'torture-test/var') {
  throw new Error('unsupported calibration manifest');
}

for (const oracleId of [...new Set(manifest.cases.map((item) => item.oracle_id))]) {
  const generator = path.join(SELF_TEST_DIR, `generate-${oracleId.toLowerCase()}-fixtures.mjs`);
  const generated = spawnSync(process.execPath, [generator, staging], {
    cwd: TT_ROOT,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, HOME: path.join(workspace, 'no-production-home') },
  });
  if (generated.status !== 0) throw new Error(`${path.basename(generator)} failed: ${generated.stderr}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
}

function mechanicalShape(oracleId, fixture) {
  const snapshots = path.join(fixture, 'snapshots');
  if (oracleId === 'O2') {
    const context = readJson(path.join(fixture, 'evidence', 'context.json'));
    const events = readJson(path.join(snapshots, 'run-events.json')).rows;
    const before = readJson(path.join(snapshots, 'refs-before.json'));
    const after = readJson(path.join(snapshots, 'refs-after.json'));
    const landing = events.find((row) => row.event?.event === 'merge.landed');
    return {
      completed_run: context.attempts[0]?.terminal_status === 'completed',
      annotated_merge_event: Boolean(landing),
      plausible_source_ref: landing?.event?.branch ?? null,
      target_ref: before.target_ref,
      target_ref_moved: before.target_tip !== after.target_tip,
      before_tip: before.target_tip,
      after_tip: after.target_tip,
    };
  }
  if (oracleId === 'O9') {
    const ledger = readJson(path.join(snapshots, 'suite-ledger.json')).rows[0];
    const observations = readJson(path.join(snapshots, 'suite-observations.json')).rows;
    const replay = observations.find((row) => row.phase === 'replay');
    return {
      replay_tree_matches_ledger: replay?.tree_hash === ledger.tree_hash,
      ledger_finished_at: ledger.created_at,
      suite_duration_ms: ledger.duration_ms,
      suite_change_committed_at: '2026-08-01T12:03:00.000Z',
      replay_observed_at: replay?.observed_at ?? null,
      committed_suite_change: 'second committed tree in captured git snapshot',
    };
  }
  const usages = readJson(path.join(snapshots, 'round-usage.json')).rows;
  const deltas = readJson(path.join(snapshots, 'token-deltas.json')).rows;
  const usage = usages[0];
  const charged = deltas.find((row) => row.event?.usageId === usage.id)?.event;
  return {
    overlapping_runs: true,
    usage_id: usage.id,
    usage_owner_run_id: usage.run_id,
    charged_run_id: charged?.runId ?? null,
    owner_window: [usage.started_at, usage.finished_at],
  };
}

for (const item of manifest.cases) {
  const source = path.join(staging, item.source_fixture);
  const destination = path.join(workspace, `calibration-${item.id}`);
  if (!fs.statSync(source).isDirectory()) throw new Error(`missing generated source fixture ${item.source_fixture}`);
  fs.renameSync(source, destination);

  const contextPath = path.join(destination, 'evidence', 'context.json');
  const context = readJson(contextPath);
  context.case.id = item.id;
  context.case.chaos = { calibration_case: item.id, calibration_schema_version: manifest.schema_version };
  context.campaign.id = `campaign-calibration-${item.id}`;
  context.campaign.manifest.case_ids = [item.id];
  writeJson(contextPath, context);

  fs.rmSync(path.join(destination, 'expectation.json'), { force: true });
  fs.writeFileSync(path.join(destination, 'calibration.json'), `${JSON.stringify({
    schema_version: manifest.schema_version,
    contract_version: manifest.contract_version,
    case_id: item.id,
    oracle_id: item.oracle_id,
    expected_result: item.expected_result,
    expected_finding: item.expected_finding,
    production_state_access: false,
    runtime_root: manifest.runtime_root,
    construction: ['git plumbing with fixed identities and timestamps', 'node:sqlite fixture database', 'controller-shaped immutable JSON events'],
    mechanical_shape: mechanicalShape(item.oracle_id, destination),
  }, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
}
fs.rmSync(staging, { recursive: true, force: true });
