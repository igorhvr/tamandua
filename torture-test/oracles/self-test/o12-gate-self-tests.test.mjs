#!/usr/bin/env node

// o12-gate-self-tests.test.mjs — focused test for the O12-REPIN gate self-test
// report machinery (Storm O12-REPIN US-003).
//
// It unit-tests the pure report shaping/validation in o12-gate-report.mjs and,
// when a retained run exists, validates the newest
// `o12-gate-self-tests-summary.json` (override the results dir with
// TAMANDUA_O12_GATE_RESULTS=<dir>). It never spawns the oracle and never writes
// into torture-test/var.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EXIT_BY_RESULT,
  O12_CORRECTION_CASES,
  buildCorrectionCases,
  summarizeRun,
  validateMatrix,
} from './o12-gate-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const RESULTS_ROOT = path.join(TT_ROOT, 'var', 'results');

function fixtureEntry(name, expected) {
  return {
    name,
    expected,
    observed: expected,
    exit_code: EXIT_BY_RESULT[expected],
    exit_expected: EXIT_BY_RESULT[expected],
    match: true,
    snapshot_unchanged: true,
    evidence_files_added: expected === 'ERROR' ? [] : ['o12-db-integrity.json'],
  };
}

function greenMatrix() {
  const entries = [
    fixtureEntry('o12-green', 'PASS'),
    fixtureEntry('o12-orphan', 'FAIL'),
    fixtureEntry('o12-schema-version-unsupported', 'ERROR'),
    ...O12_CORRECTION_CASES.filter((entry) => entry.kind === 'fixture')
      .map((entry) => fixtureEntry(entry.fixture, 'PASS')),
  ];
  const probeResults = {
    'o12-run-number-probe.mjs': {
      exit_code: 0,
      report_probe: 'o12-run-number-real-api',
      delete_recreate_reuse_observed: true,
      live_rows_unique: true,
    },
    'o12-run-number-allocator-calibration.mjs': {
      exit_code: 0,
      report_probe: 'o12-run-number-allocator-calibration',
      delete_recreate_reuse_observed: true,
      live_rows_unique: true,
      calibration_kind: 'sql-replica',
    },
  };
  const correctionCases = buildCorrectionCases(entries, probeResults);
  return {
    kind: 'o12-fixture-matrix',
    expected_fixture_count: entries.length,
    fixture_count: entries.length,
    entries,
    all_match: true,
    correction_cases: correctionCases,
    all_correction_cases_green: correctionCases.every((entry) => entry.match === true),
  };
}

test('summarizeRun counts red entries and sets the verdict honestly', () => {
  const allGreen = summarizeRun([
    { name: 'a.mjs', exit_code: 0 },
    { name: 'b.mjs', exit_code: 0 },
  ]);
  assert.deepEqual(allGreen, {
    total: 2, passed: 2, failed: 0, red_file_count: 0, red_files: [], verdict: 'PASS',
  });
  const oneRed = summarizeRun([
    { name: 'a.mjs', exit_code: 0 },
    { name: 'b.mjs', exit_code: 1 },
  ]);
  assert.equal(oneRed.verdict, 'FAIL');
  assert.deepEqual(oneRed.red_files, ['b.mjs']);
  assert.equal(oneRed.passed, 1);
  assert.equal(oneRed.failed, 1);
});

test('buildCorrectionCases surfaces all eight O12-CLOSE correction cases green', () => {
  const cases = buildCorrectionCases(
    O12_CORRECTION_CASES.filter((entry) => entry.kind === 'fixture').map((entry) => fixtureEntry(entry.fixture, 'PASS')),
    {
      'o12-run-number-probe.mjs': { exit_code: 0, delete_recreate_reuse_observed: true, live_rows_unique: true },
      'o12-run-number-allocator-calibration.mjs': { exit_code: 0, delete_recreate_reuse_observed: true, live_rows_unique: true },
    },
  );
  assert.equal(cases.length, 8);
  assert.deepEqual(cases.map((entry) => entry.case_id), O12_CORRECTION_CASES.map((entry) => entry.case_id));
  assert.ok(cases.every((entry) => entry.match === true), JSON.stringify(cases.filter((c) => !c.match)));
});

test('validateMatrix accepts a green matrix and rejects drift', () => {
  const matrix = greenMatrix();
  const green = validateMatrix(matrix);
  assert.equal(green.ok, true, green.problems.join('; '));

  const wrongFixture = greenMatrix();
  wrongFixture.entries[0].observed = 'FAIL';
  wrongFixture.entries[0].exit_code = EXIT_BY_RESULT.FAIL;
  wrongFixture.entries[0].match = false;
  assert.equal(validateMatrix(wrongFixture).ok, false);

  const wrongExit = greenMatrix();
  wrongExit.entries[0].exit_code = 2;
  assert.equal(validateMatrix(wrongExit).ok, false);

  const mutatedSnapshot = greenMatrix();
  mutatedSnapshot.entries[0].snapshot_unchanged = false;
  assert.equal(validateMatrix(mutatedSnapshot).ok, false);

  const missingCase = greenMatrix();
  missingCase.correction_cases = missingCase.correction_cases.slice(0, 7);
  const missing = validateMatrix(missingCase);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.includes('run-number-allocator-characterization')));

  const redCase = greenMatrix();
  redCase.correction_cases[0].observed = 'FAIL';
  redCase.correction_cases[0].match = false;
  assert.equal(validateMatrix(redCase).ok, false);

  assert.equal(validateMatrix(null).ok, false);
});

test('retained O12 gate self-test run (when present) is a green, honest report', () => {
  const explicit = process.env.TAMANDUA_O12_GATE_RESULTS;
  let resultsDir = explicit ? path.resolve(explicit) : null;
  if (!resultsDir && fs.existsSync(RESULTS_ROOT)) {
    const candidates = fs.readdirSync(RESULTS_ROOT)
      .filter((name) => name.startsWith('o12-gate-self-tests-'))
      .map((name) => path.join(RESULTS_ROOT, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'o12-gate-self-tests-summary.json')))
      .sort();
    resultsDir = candidates.at(-1) ?? null;
  }
  if (!resultsDir) {
    // The runner is the producer; this assertion is skipped only when no run
    // has been retained on this host. The pure-function tests above still run.
    process.stderr.write('no retained O12 gate self-test run found; skipping retained-report assertions\n');
    return;
  }
  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, 'o12-gate-self-tests-summary.json'), 'utf8'));
  assert.equal(summary.kind, 'o12-gate-self-tests-summary');
  assert.equal(summary.verdict, 'PASS', JSON.stringify(summary.red_files));
  assert.ok(summary.entries.every((entry) => entry.exit_code === 0),
    JSON.stringify(summary.entries.filter((entry) => entry.exit_code !== 0)));
  assert.equal(summary.matrix_pass, true);
  assert.equal(summary.overall_verdict, 'PASS');
  const matrixPath = path.join(resultsDir, 'o12-fixture-matrix.json');
  assert.ok(fs.existsSync(matrixPath), `matrix missing: ${matrixPath}`);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const validation = validateMatrix(matrix);
  assert.equal(validation.ok, true, validation.problems.join('; '));
  assert.equal(matrix.entries.length, matrix.expected_fixture_count);
  for (const definition of O12_CORRECTION_CASES) {
    assert.ok(matrix.correction_cases.some((entry) => entry.case_id === definition.case_id),
      `retained matrix must surface correction case ${definition.case_id}`);
  }
});
