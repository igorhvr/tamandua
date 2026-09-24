#!/usr/bin/env node

// o12-fixture-matrix.mjs — retained per-fixture expected/observed report for
// the O12-REPIN gate (Storm O12-REPIN US-003, calibration/acceptance half of
// requirement 2).
//
// Generates the schema 9..14 O12 fixture set into an owned, retained
// `oracle-self-test.*` workspace, invokes the REAL committed O12 executable
// once per fixture through the shared stdout/exit contract, and writes
// `o12-fixture-matrix.json` mapping every generated fixture name to its
// expected result, observed result and exit code. The eight executable
// O12-CLOSE correction cases are surfaced explicitly (the seven named fixtures
// plus the run-number allocator characterization, whose real-API and SQL-replica
// probes are run here too).
//
// Immutability discipline: each fixture's immutable snapshot SHA-256 is taken
// before and after the invocation and recorded; ERROR fixtures must write no
// evidence. Nothing is ever disposed: the workspace is retained and receipted.
//
// Usage:
//   node o12-fixture-matrix.mjs [--base <dir>] [--workspace <dir>] [--out <file>]
//
// Exit 0 only when every fixture expected == observed AND all eight correction
// cases are green; nonzero otherwise (the matrix is still written for review).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  EXIT_BY_RESULT,
  buildCorrectionCases,
  validateMatrix,
} from './o12-gate-report.mjs';
import { o12ChildEnv, safeProbeTmpdir } from './o12-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(TT_ROOT, '..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O12');
const GENERATOR = path.join(HERE, 'generate-o12-fixtures.mjs');
const PROBE_REAL_API = path.join(HERE, 'o12-run-number-probe.mjs');
const PROBE_CALIBRATION = path.join(HERE, 'o12-run-number-allocator-calibration.mjs');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

function parseArgs(argv) {
  const args = { base: VAR_ROOT, workspace: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') args.base = path.resolve(argv[++index]);
    else if (argument === '--workspace') args.workspace = path.resolve(argv[++index]);
    else if (argument === '--out') args.out = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return args;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Invoke the real O12 executable for one fixture. Mirrors o12.test.mjs. */
function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const evidenceDir = path.dirname(expectation.context);
  const snapshotPath = path.join(workspace, name, 'snapshots', 'database.sqlite');
  const snapshotBefore = sha256File(snapshotPath);
  const snapshotFilesBefore = fs.readdirSync(path.dirname(snapshotPath)).sort();
  const evidenceFilesBefore = fs.readdirSync(evidenceDir).sort();
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: evidenceDir,
    env: {
      ...o12ChildEnv({ tmpdir: workspace }),
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O12',
      TT_ORACLE_CONTEXT: expectation.context, TT_ORACLE_EVIDENCE_DIR: evidenceDir,
      TT_CASE_ID: context.case.id, TT_CAMPAIGN_ID: context.campaign.id,
    },
    encoding: 'utf8', shell: false, timeout: 30_000,
  });
  if (result.error) throw new Error(`${name}: oracle spawn failed: ${result.error.message}`);
  if (result.signal) throw new Error(`${name}: oracle terminated by signal ${result.signal}`);
  const response = JSON.parse(result.stdout.trim());
  const snapshotAfter = sha256File(snapshotPath);
  const snapshotFilesAfter = fs.readdirSync(path.dirname(snapshotPath)).sort();
  const evidenceFilesAfter = fs.readdirSync(evidenceDir).sort();
  return {
    name,
    expected: expectation.expected,
    observed: response.result,
    exit_code: result.status,
    exit_expected: EXIT_BY_RESULT[expectation.expected],
    match: response.result === expectation.expected && result.status === EXIT_BY_RESULT[expectation.expected],
    schema_user_version: expectation.schema?.user_version ?? null,
    snapshot_sha256_before: snapshotBefore,
    snapshot_sha256_after: snapshotAfter,
    snapshot_unchanged: snapshotBefore === snapshotAfter
      && JSON.stringify(snapshotFilesBefore) === JSON.stringify(snapshotFilesAfter),
    evidence_files_added: evidenceFilesAfter.filter((file) => !evidenceFilesBefore.includes(file)),
  };
}

/** Run a native allocator probe alone (guard env, false harnesses, safe TMPDIR). */
function runProbe(probePath) {
  const tmpdir = safeProbeTmpdir();
  const result = spawnSync(process.execPath, [probePath], {
    encoding: 'utf8', shell: false, timeout: 120_000,
    env: {
      ...o12ChildEnv({ tmpdir }),
      TAMANDUA_O12_PROBE_DIST: DIST_DIR,
    },
  });
  let report = null;
  try {
    report = result.stdout ? JSON.parse(result.stdout.trim()) : null;
  } catch {
    report = null;
  }
  return {
    name: path.basename(probePath),
    exit_code: result.status,
    signal: result.signal,
    report_probe: report?.probe ?? null,
    delete_recreate_reuse_observed: report?.delete_recreate_reuse_observed ?? null,
    live_rows_unique: report?.live_rows_unique ?? null,
    calibration_kind: report?.calibration_kind ?? null,
    workspace_receipt_root: report?.workspace_receipt?.root ?? null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.base, { recursive: true });
  const workspace = args.workspace ?? fs.mkdtempSync(path.join(args.base, 'oracle-self-test.'));
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  const outPath = args.out ?? path.join(workspace, 'o12-fixture-matrix.json');

  const generated = spawnSync(process.execPath, [GENERATOR, workspace], {
    encoding: 'utf8', shell: false, timeout: 120_000,
    env: o12ChildEnv({ tmpdir: workspace }),
  });
  if (generated.status !== 0) {
    process.stderr.write(`fixture generator failed (exit ${generated.status}):\n${generated.stderr}`);
    process.exit(2);
  }
  const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o12-')).sort();
  const generationReceiptPath = path.join(workspace, 'generation-receipt.json');
  const generationReceipt = fs.existsSync(generationReceiptPath)
    ? JSON.parse(fs.readFileSync(generationReceiptPath, 'utf8'))
    : null;

  const entries = [];
  for (const name of names) entries.push(invokeFixture(workspace, name));

  const probeResults = {};
  for (const probePath of [PROBE_REAL_API, PROBE_CALIBRATION]) {
    const record = runProbe(probePath);
    probeResults[record.name] = record;
  }
  const correctionCases = buildCorrectionCases(entries, probeResults);

  const matrix = {
    kind: 'o12-fixture-matrix',
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    oracle: ORACLE,
    workspace,
    generation_receipt: generationReceipt,
    expected_fixture_count: generationReceipt?.fixture_count ?? names.length,
    fixture_count: entries.length,
    entries,
    all_match: entries.every((entry) => entry.match === true),
    correction_cases: correctionCases,
    all_correction_cases_green: correctionCases.every((entry) => entry.match === true),
    probe_results: probeResults,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(matrix, null, 2)}\n`);

  const validation = validateMatrix(matrix);
  process.stdout.write(`o12 fixture matrix: ${entries.length} fixtures, all_match=${matrix.all_match}, correction_cases_green=${matrix.all_correction_cases_green}\n`);
  process.stdout.write(`o12 fixture matrix written: ${outPath}\n`);
  process.stdout.write(`o12 fixture workspace retained: ${workspace}\n`);
  if (!validation.ok) {
    for (const problem of validation.problems) process.stderr.write(`MATRIX PROBLEM: ${problem}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
