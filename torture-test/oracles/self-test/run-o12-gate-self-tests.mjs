#!/usr/bin/env node

// run-o12-gate-self-tests.mjs — Storm O12-REPIN US-003 runner.
//
// Builds nothing (run `npm run build` first), then runs each O12 self-test
// entry ALONE, each in its own process, under the explicit gate env
// (TAMANDUA_TEST_GUARD=1; TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY /
// TAMANDUA_DSH_BINARY = /usr/bin/false; the repo-built dist pinned for the
// native probes), and retains:
//
//   * per-entry full stdout/stderr logs and exit codes,
//   * a machine-readable `o12-gate-self-tests-summary.json`,
//   * a per-entry `results.tsv`,
//   * the per-fixture `o12-fixture-matrix.json` produced by
//     `o12-fixture-matrix.mjs`.
//
// The runner never disposes anything and never touches the real state: every
// child gets an explicit allow-list env with a private TMPDIR outside the
// product guard's real-state prefix (see o12-scratch.mjs).
//
// Exit 0 only when every entry exits 0 and the fixture matrix validates.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { summarizeRun, validateMatrix } from './o12-gate-report.mjs';
import { o12ChildEnv, safeProbeTmpdir } from './o12-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const RESULTS_ROOT = path.join(VAR_ROOT, 'results');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const FALSE_HARNESS = '/usr/bin/false';

const SELF_TEST_ENTRIES = [
  { name: 'o12.test.mjs', kind: 'test', args: ['--test', path.join(HERE, 'o12.test.mjs')] },
  { name: 'o12-schema-version.test.mjs', kind: 'test', args: ['--test', path.join(HERE, 'o12-schema-version.test.mjs')] },
  { name: 'o12-reserved-key-probe.mjs', kind: 'probe', args: [path.join(HERE, 'o12-reserved-key-probe.mjs')] },
  { name: 'o12-run-number-probe.mjs', kind: 'probe', args: [path.join(HERE, 'o12-run-number-probe.mjs')] },
  { name: 'o12-run-number-allocator-calibration.mjs', kind: 'probe', args: [path.join(HERE, 'o12-run-number-allocator-calibration.mjs')] },
];

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function gateEnv(tmpdir) {
  return {
    ...o12ChildEnv({ tmpdir }),
    TAMANDUA_PI_BINARY: FALSE_HARNESS,
    TAMANDUA_HERMES_BINARY: FALSE_HARNESS,
    TAMANDUA_DSH_BINARY: FALSE_HARNESS,
    TAMANDUA_O12_PROBE_DIST: DIST_DIR,
  };
}

function main() {
  const startedAt = new Date().toISOString();
  fs.mkdirSync(RESULTS_ROOT, { recursive: true });
  const resultsDir = fs.mkdtempSync(path.join(RESULTS_ROOT, `o12-gate-self-tests-${timestamp()}.`));
  const entries = [];

  for (const definition of SELF_TEST_ENTRIES) {
    const tmpdir = safeProbeTmpdir();
    const startedMs = Date.now();
    const result = spawnSync(process.execPath, definition.args, {
      cwd: REPO_ROOT, encoding: 'utf8', shell: false, timeout: 600_000,
      env: gateEnv(tmpdir),
    });
    const durationMs = Date.now() - startedMs;
    const stdoutPath = path.join(resultsDir, `${safeName(definition.name)}.stdout.log`);
    const stderrPath = path.join(resultsDir, `${safeName(definition.name)}.stderr.log`);
    fs.writeFileSync(stdoutPath, result.stdout ?? '');
    fs.writeFileSync(stderrPath, result.stderr ?? '');
    entries.push({
      name: definition.name,
      kind: definition.kind,
      argv: [process.execPath, ...definition.args],
      exit_code: result.status,
      signal: result.signal,
      duration_ms: durationMs,
      pass: result.status === 0,
      stdout_log: stdoutPath,
      stderr_log: stderrPath,
      private_tmpdir: tmpdir,
    });
  }

  // The generator entry owns its own retained oracle-self-test.* workspace and
  // prints it; running it here proves the standalone generator entry exits 0.
  const generatorTmpdir = safeProbeTmpdir();
  const generatorWorkspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  const generatorStartedMs = Date.now();
  const generator = spawnSync(process.execPath, [path.join(HERE, 'generate-o12-fixtures.mjs'), generatorWorkspace], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: false, timeout: 300_000,
    env: gateEnv(generatorTmpdir),
  });
  const generatorStdoutPath = path.join(resultsDir, 'generate-o12-fixtures.mjs.stdout.log');
  const generatorStderrPath = path.join(resultsDir, 'generate-o12-fixtures.mjs.stderr.log');
  fs.writeFileSync(generatorStdoutPath, generator.stdout ?? '');
  fs.writeFileSync(generatorStderrPath, generator.stderr ?? '');
  entries.push({
    name: 'generate-o12-fixtures.mjs',
    kind: 'generator',
    argv: [process.execPath, path.join(HERE, 'generate-o12-fixtures.mjs'), generatorWorkspace],
    exit_code: generator.status,
    signal: generator.signal,
    duration_ms: Date.now() - generatorStartedMs,
    pass: generator.status === 0,
    stdout_log: generatorStdoutPath,
    stderr_log: generatorStderrPath,
    private_tmpdir: generatorTmpdir,
    workspace: generatorWorkspace,
  });

  // The per-fixture matrix (its own retained workspace + the two allocator
  // probes for the eighth correction case).
  const matrixPath = path.join(resultsDir, 'o12-fixture-matrix.json');
  const matrixTmpdir = safeProbeTmpdir();
  const matrixStartMs = Date.now();
  const matrixRun = spawnSync(process.execPath, [
    path.join(HERE, 'o12-fixture-matrix.mjs'),
    '--base', VAR_ROOT,
    '--out', matrixPath,
  ], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: false, timeout: 600_000,
    env: gateEnv(matrixTmpdir),
  });
  fs.writeFileSync(path.join(resultsDir, 'o12-fixture-matrix.mjs.stdout.log'), matrixRun.stdout ?? '');
  fs.writeFileSync(path.join(resultsDir, 'o12-fixture-matrix.mjs.stderr.log'), matrixRun.stderr ?? '');
  entries.push({
    name: 'o12-fixture-matrix.mjs',
    kind: 'matrix',
    argv: [process.execPath, path.join(HERE, 'o12-fixture-matrix.mjs'), '--base', VAR_ROOT, '--out', matrixPath],
    exit_code: matrixRun.status,
    signal: matrixRun.signal,
    duration_ms: Date.now() - matrixStartMs,
    pass: matrixRun.status === 0,
    stdout_log: path.join(resultsDir, 'o12-fixture-matrix.mjs.stdout.log'),
    stderr_log: path.join(resultsDir, 'o12-fixture-matrix.mjs.stderr.log'),
    private_tmpdir: matrixTmpdir,
  });

  let matrix = null;
  let matrixValidation = { ok: false, problems: ['matrix file missing'] };
  if (fs.existsSync(matrixPath)) {
    matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
    matrixValidation = validateMatrix(matrix);
  }

  const summary = {
    kind: 'o12-gate-self-tests-summary',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    dist_dir: DIST_DIR,
    results_dir: resultsDir,
    results_root: RESULTS_ROOT,
    gate_env: {
      TAMANDUA_TEST_GUARD: '1',
      TAMANDUA_PI_BINARY: FALSE_HARNESS,
      TAMANDUA_HERMES_BINARY: FALSE_HARNESS,
      TAMANDUA_DSH_BINARY: FALSE_HARNESS,
      TAMANDUA_O12_PROBE_DIST: DIST_DIR,
      authority: 'explicit allow-list only; no ambient TAMANDUA_RUN_ID/worker/control-port forwarded',
    },
    entries,
    ...summarizeRun(entries),
    fixture_matrix: {
      path: matrixPath,
      expected_fixture_count: matrix?.expected_fixture_count ?? null,
      fixture_count: matrix?.fixture_count ?? null,
      all_match: matrix?.all_match ?? false,
      all_correction_cases_green: matrix?.all_correction_cases_green ?? false,
      snapshot_immutability_ok: Boolean(matrix?.entries?.every((entry) => entry.snapshot_unchanged === true)),
      correction_cases: matrix?.correction_cases ?? null,
      validation: matrixValidation,
    },
  };
  const matrixPass = matrixValidation.ok && matrixRun.status === 0;
  summary.matrix_pass = matrixPass;
  summary.overall_verdict = summary.verdict === 'PASS' && matrixPass ? 'PASS' : 'FAIL';

  const summaryPath = path.join(resultsDir, 'o12-gate-self-tests-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  const tsv = entries.map((entry) => `${entry.name}\t${entry.exit_code ?? 'null'}\t${entry.pass ? 'PASS' : 'FAIL'}`).join('\n');
  fs.writeFileSync(path.join(resultsDir, 'results.tsv'), `${tsv}\n`);

  process.stdout.write(`o12 gate self-tests: ${summary.passed}/${summary.total} entries exited 0 (verdict ${summary.verdict})\n`);
  process.stdout.write(`o12 fixture matrix: all_match=${Boolean(matrix?.all_match)} correction_cases_green=${Boolean(matrix?.all_correction_cases_green)} validation_ok=${matrixValidation.ok}\n`);
  process.stdout.write(`o12 gate self-test evidence retained: ${resultsDir}\n`);
  if (summary.overall_verdict !== 'PASS') {
    for (const entry of entries.filter((item) => !item.pass)) {
      process.stderr.write(`RED ENTRY: ${entry.name} exit=${entry.exit_code} signal=${entry.signal}\n`);
    }
    for (const problem of matrixValidation.problems) process.stderr.write(`MATRIX PROBLEM: ${problem}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
