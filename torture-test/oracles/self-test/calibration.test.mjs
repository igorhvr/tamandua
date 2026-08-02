#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const CALIBRATION_DIR = path.resolve(HERE, '..', 'calibration');
const GENERATOR = path.join(CALIBRATION_DIR, 'generate-fixtures.mjs');
const RUNNER = path.join(CALIBRATION_DIR, 'run.mjs');
const EXPECTED = [
  ['o2-phantom-merge', 'O2', 'O2_PHANTOM_MERGE'],
  ['o9-stale-replay', 'O9', 'O9_REPLAY_STALE'],
  ['o11-cross-charge', 'O11', 'O11_CROSS_CHARGE'],
];

function fixtureHashes(root) {
  const hashes = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        hashes.set(
          path.relative(root, file).split(path.sep).join('/'),
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        );
      }
    }
  }
  visit(root);
  return hashes;
}

test('versioned calibration pack catches all named hard cases from contained deterministic evidence', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  const secondWorkspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], {
      cwd: TT_ROOT,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(generated.status, 0, generated.stderr);
    const regenerated = spawnSync(process.execPath, [GENERATOR, secondWorkspace], {
      cwd: TT_ROOT,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(regenerated.status, 0, regenerated.stderr);

    const manifest = JSON.parse(fs.readFileSync(path.join(CALIBRATION_DIR, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.contract_version, 1);
    assert.deepEqual(
      manifest.cases.map(({ id, oracle_id, expected_finding }) => [id, oracle_id, expected_finding]),
      EXPECTED,
    );

    for (const [id, oracleId, finding] of EXPECTED) {
      const fixture = path.join(workspace, `calibration-${id}`);
      const regeneratedFixture = path.join(secondWorkspace, `calibration-${id}`);
      assert.deepEqual(
        fixtureHashes(regeneratedFixture),
        fixtureHashes(fixture),
        `${id} calibration evidence must be byte-identical across independent generations`,
      );
      const metadata = JSON.parse(fs.readFileSync(path.join(fixture, 'calibration.json'), 'utf8'));
      assert.equal(metadata.schema_version, 1);
      assert.equal(metadata.contract_version, 1);
      assert.equal(metadata.case_id, id);
      assert.equal(metadata.oracle_id, oracleId);
      assert.equal(metadata.expected_result, 'FAIL');
      assert.equal(metadata.expected_finding, finding);
      assert.equal(metadata.production_state_access, false);
      assert.equal(metadata.runtime_root, 'torture-test/var');

      const context = JSON.parse(fs.readFileSync(path.join(fixture, 'evidence', 'context.json'), 'utf8'));
      assert.equal(context.contract_version, 1);
      assert.equal(context.oracle_id, oracleId);
      assert.equal(context.case.id, id);

      if (oracleId === 'O2') {
        assert.equal(metadata.mechanical_shape.target_ref_moved, false);
        assert.equal(metadata.mechanical_shape.completed_run, true);
        assert.equal(metadata.mechanical_shape.annotated_merge_event, true);
        assert.match(metadata.mechanical_shape.plausible_source_ref, /^refs\/heads\//);
      } else if (oracleId === 'O9') {
        assert.equal(metadata.mechanical_shape.replay_tree_matches_ledger, true);
        assert.ok(metadata.mechanical_shape.ledger_finished_at < metadata.mechanical_shape.suite_change_committed_at);
      } else {
        assert.equal(metadata.mechanical_shape.overlapping_runs, true);
        assert.notEqual(metadata.mechanical_shape.usage_owner_run_id, metadata.mechanical_shape.charged_run_id);
      }
    }

    const first = spawnSync(process.execPath, [RUNNER, workspace], { cwd: TT_ROOT, encoding: 'utf8', shell: false, timeout: 30_000 });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    for (const [id, , finding] of EXPECTED) {
      assert.match(first.stdout, new RegExp(`calibration ${id} caught ${finding}`));
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(secondWorkspace, { recursive: true, force: true });
  }
});
