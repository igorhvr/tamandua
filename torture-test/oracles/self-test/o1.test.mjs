#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O1');
const GENERATOR = path.join(HERE, 'generate-o1-fixtures.mjs');

function invokeContext(contextPath) {
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: '1',
    TT_ORACLE_ID: 'O1',
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  };
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', contextPath], {
    cwd: path.dirname(contextPath), env, encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { response: JSON.parse(result.stdout.trim()), status: result.status };
}

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  return { expectation, ...invokeContext(expectation.context) };
}

test('O1 accepts converged DB/event/workflow evidence and catches every targeted mutation', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o1-')).sort();
    assert.equal(names.length, 35);
    for (const name of names) {
      const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
      if (expectation.multiCase) continue; // covered by the dedicated multi-case test
      const { response, status } = invokeContext(expectation.context);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      assert.equal(status, expectation.expected === 'PASS' ? 0 : 1, name);
      if (expectation.finding) {
        assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      }
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.deepEqual(observation.runs.map((run) => run.run_id), [
        'run-11111111-1111-4111-8111-111111111111',
        'run-22222222-2222-4222-8222-222222222222',
      ]);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 judges each wave case against its own per-case production floor without cross-case duplicates', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const { expectation, response, status } = invokeFixture(workspace, 'o1-per-case-floors');
    assert.equal(status, 0);
    assert.equal(response.result, 'PASS');
    assert.equal(response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(response.findings));
    const observation = JSON.parse(fs.readFileSync(path.join(workspace, expectation.name, 'evidence', response.evidence[0].path), 'utf8'));
    assert.equal(observation.duration_floor_observations.length, 1);
    const floors = new Map(observation.duration_floor_observations[0].case_floors.map((row) => [row.case_id, row]));
    assert.equal(floors.get('o1-per-case-floors').duration_floor_ms, 300000);
    assert.equal(floors.get('wave-peer-1').duration_floor_ms, 180000);
    assert.equal(floors.get('wave-peer-2').duration_floor_ms, 180000);
    assert.equal(observation.duration_floor_observations[0].fast_run_count, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 suppresses the duration-floor rate finding below four eligible family runs and keeps it at four', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const tiny = invokeFixture(workspace, 'o1-fast-wave-tiny-sample');
    assert.equal(tiny.status, 0);
    assert.equal(tiny.response.result, 'PASS');
    assert.equal(tiny.response.findings.some((finding) => finding.id === 'O1_DURATION_FLOOR_RATE'), false, JSON.stringify(tiny.response.findings));
    const tinyObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-fast-wave-tiny-sample', 'evidence', tiny.response.evidence[0].path), 'utf8'));
    assert.equal(tinyObservation.duration_floor_observations.length, 1);
    assert.equal(tinyObservation.duration_floor_observations[0].run_count, 3);
    assert.equal(tinyObservation.duration_floor_observations[0].fast_run_count, 3);
    assert.equal(tinyObservation.duration_floor_observations[0].fast_rate, 1);

    const n4 = invokeFixture(workspace, 'o1-fast-wave-n4');
    assert.equal(n4.status, 1);
    assert.equal(n4.response.result, 'FAIL');
    const rate = n4.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(n4.response.findings));
    assert.equal(rate.run_count, 4);
    assert.equal(rate.fast_run_count, 4);
    assert.equal(rate.fast_rate, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 reports wave-family floor findings once via the last-manifest-order reporter and scopes run-citing findings to their owner', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const campaign = path.join(workspace, 'o1-wave-family-reporter');
    const expectation = JSON.parse(fs.readFileSync(path.join(campaign, 'expectation.json'), 'utf8'));
    const first = invokeContext(expectation.contexts.first);
    const last = invokeContext(expectation.contexts.last);

    // The FIRST case in campaign.manifest.case_ids is NOT the reporter
    // (deliberately alphabetically LAST, so manifest rank — not name sort —
    // decides): it carries no family finding, but it owns the duplicated wave
    // row for its own run, so the run-scoped duplicate finding fails it.
    assert.equal(first.status, 1);
    assert.equal(first.response.result, 'FAIL');
    assert.equal(first.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(first.response.findings));
    assert.ok(first.response.findings.some((finding) => finding.id === 'O1_WAVE_RUN_DUPLICATE'), JSON.stringify(first.response.findings));

    // The LAST case in manifest order is the wave-family reporter: it carries
    // the family finding and NOT the sibling's run-scoped duplicate.
    assert.equal(last.status, 1);
    assert.equal(last.response.result, 'FAIL');
    const rate = last.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(last.response.findings));
    assert.equal(rate.run_count, 5);
    assert.equal(rate.fast_run_count, 2);
    assert.equal(rate.fast_rate, 0.4);
    assert.equal(last.response.findings.some((finding) => finding.id === 'O1_WAVE_RUN_DUPLICATE'), false, JSON.stringify(last.response.findings));

    // Duration floor observations stay in the evidence of BOTH cases — only
    // the findings list is deduplicated.
    for (const [label, outcome] of [['first', first], ['last', last]]) {
      const evidenceDir = path.dirname(label === 'first' ? expectation.contexts.first : expectation.contexts.last);
      const observation = JSON.parse(fs.readFileSync(path.join(evidenceDir, outcome.response.evidence[0].path), 'utf8'));
      assert.equal(observation.duration_floor_observations.length, 1, label);
      assert.equal(observation.duration_floor_observations[0].run_count, 5, label);
      assert.equal(observation.duration_floor_observations[0].fast_run_count, 2, label);
      assert.equal(observation.duration_floor_observations[0].fast_rate, 0.4, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 evaluates the wave-family floor guard from the last manifest case when the wave grows sequentially', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const campaign = path.join(workspace, 'o1-wave-family-sequential');
    const expectation = JSON.parse(fs.readFileSync(path.join(campaign, 'expectation.json'), 'utf8'));
    const first = invokeContext(expectation.contexts.first);
    const last = invokeContext(expectation.contexts.last);

    // The first manifest case's O1 saw a one-sample wave (< MIN_FLOOR_RATE_SAMPLE):
    // the rate guard is suppressed there and the case stays PASS.
    assert.equal(first.status, 0);
    assert.equal(first.response.result, 'PASS');
    assert.equal(first.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(first.response.findings));
    const firstObservation = JSON.parse(fs.readFileSync(path.join(path.dirname(expectation.contexts.first), first.response.evidence[0].path), 'utf8'));
    assert.equal(firstObservation.duration_floor_observations.length, 1);
    assert.equal(firstObservation.duration_floor_observations[0].run_count, 1);
    assert.equal(firstObservation.duration_floor_observations[0].fast_run_count, 0);

    // The last manifest case's O1 saw the complete wave (5 runs, 3 fast):
    // O1_DURATION_FLOOR_RATE fires exactly once, from this case.
    assert.equal(last.status, 1);
    assert.equal(last.response.result, 'FAIL');
    const rates = last.response.findings.filter((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.equal(rates.length, 1, JSON.stringify(last.response.findings));
    assert.equal(rates[0].run_count, 5);
    assert.equal(rates[0].fast_run_count, 3);
    assert.equal(rates[0].fast_rate, 0.6);
    assert.deepEqual(rates[0].run_ids, [
      'run-wave-seq-peer-1', 'run-wave-seq-peer-2', 'run-wave-seq-peer-3',
    ]);
    const lastObservation = JSON.parse(fs.readFileSync(path.join(path.dirname(expectation.contexts.last), last.response.evidence[0].path), 'utf8'));
    assert.equal(lastObservation.duration_floor_observations.length, 1);
    assert.equal(lastObservation.duration_floor_observations[0].run_count, 5);
    assert.equal(lastObservation.duration_floor_observations[0].fast_run_count, 3);
    assert.equal(lastObservation.duration_floor_observations[0].fast_rate, 0.6);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// S43b (US-007): wave-reporter dedupe. The campaign-20260826T225744158Z
// shape — four do-now cells plus a LATER non-do-now cell (the true final wave
// case in manifest order) share the wave, and each case's o1_wave SNAPSHOT
// differs (concurrency-1 growth). The pre-fix per-snapshot reporter selection
// stamped the do-now family finding on TWO cases (W4.dsh-do-now +
// W4.dsh-fdmw, the latter not even do-now); the campaign-wide `wave_cases`
// membership pins the reporter to the true final wave case for EVERY
// evaluation, so the finding merges exactly once.
test('S43b: O1 merges wave-family findings into exactly one reporter — the true final wave case in manifest order — even when snapshots differ per evaluating case', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const campaign = path.join(workspace, 'o1-wave-reporter-dedupe');
    const expectation = JSON.parse(fs.readFileSync(path.join(campaign, 'expectation.json'), 'utf8'));
    const doNow4 = invokeContext(expectation.contexts.doNow4);
    const nonDoNow = invokeContext(expectation.contexts.nonDoNow);

    // The last do-now case is NOT the reporter: its snapshot already carries
    // the full do-now family (4 runs, 2 fast -> rate 0.5), but the reporter
    // is the true final wave case in manifest order (the non-do-now cell), so
    // the family finding is not stamped here — the case stays PASS.
    assert.equal(doNow4.status, 0);
    assert.equal(doNow4.response.result, 'PASS');
    assert.equal(doNow4.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(doNow4.response.findings));

    // The true final wave case (a NON-do-now cell, mirroring W4.dsh-fdmw) is
    // the ONLY reporter: it carries the do-now family finding exactly once.
    assert.equal(nonDoNow.status, 1);
    assert.equal(nonDoNow.response.result, 'FAIL');
    const rates = nonDoNow.response.findings.filter((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.equal(rates.length, 1, JSON.stringify(nonDoNow.response.findings));
    assert.equal(rates[0].workflow, 'do-now');
    assert.equal(rates[0].run_count, 4);
    assert.equal(rates[0].fast_run_count, 2);
    assert.equal(rates[0].fast_rate, 0.5);
    assert.deepEqual(rates[0].run_ids, ['run-wave-dedup-do-now-1', 'run-wave-dedup-do-now-2']);

    // Duration floor observations stay in the evidence of BOTH cases — only
    // the findings list is deduplicated. The do-now family row is present in
    // each case's observation set (campaign-wide data).
    for (const [label, outcome, contextPath] of [['doNow4', doNow4, expectation.contexts.doNow4], ['nonDoNow', nonDoNow, expectation.contexts.nonDoNow]]) {
      const evidenceDir = path.dirname(contextPath);
      const observation = JSON.parse(fs.readFileSync(path.join(evidenceDir, outcome.response.evidence[0].path), 'utf8'));
      const doNowRow = observation.duration_floor_observations.find((row) => row.workflow === 'do-now');
      assert.ok(doNowRow, `${label} must carry the do-now family observation`);
      assert.equal(doNowRow.run_count, 4, label);
      assert.equal(doNowRow.fast_run_count, 2, label);
      assert.equal(doNowRow.fast_rate, 0.5, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 clears campaign-8 wave-1 do-now durations at the recalibrated 30s floor and fires on a sub-30s run', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);

    // The four campaign #8 wave-1 do-now runs (W1.L1-python 53.257s,
    // W1.L1-ts 46.313s, W1.X1-ts 101.768s, W1.M1-python 88.759s) all finish
    // above the recalibrated 30000ms floor (US-006): the wave PASSes with no
    // O1_DURATION_FLOOR_* finding, fast_run_count 0 and fast_rate 0.
    const green = invokeFixture(workspace, 'o1-wave1-floor-30000');
    assert.equal(green.status, 0);
    assert.equal(green.response.result, 'PASS');
    assert.equal(green.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(green.response.findings));
    const greenObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-wave1-floor-30000', 'evidence', green.response.evidence[0].path), 'utf8'));
    assert.equal(greenObservation.duration_floor_observations.length, 1);
    assert.equal(greenObservation.duration_floor_observations[0].run_count, 4);
    assert.equal(greenObservation.duration_floor_observations[0].fast_run_count, 0);
    assert.equal(greenObservation.duration_floor_observations[0].fast_rate, 0);
    const greenFloors = new Map(greenObservation.duration_floor_observations[0].case_floors.map((row) => [row.case_id, row]));
    for (const caseId of ['o1-wave1-floor-30000', 'wave-peer-1', 'wave-peer-2']) {
      assert.equal(greenFloors.get(caseId).duration_floor_ms, 30000, `${caseId} floor`);
      assert.equal(greenFloors.get(caseId).source, 'production-median', `${caseId} source`);
    }

    // The same wave with wave-peer-2 (W1.M1-python slot) finishing at 25s
    // (< 30000ms): with 4 eligible runs (MIN_FLOOR_RATE_SAMPLE) the rate
    // guard fires — O1_DURATION_FLOOR_RATE with fast_run_count 1 and
    // fast_rate 0.25 (> MAX_FAST_RATE 0.2).
    const fast = invokeFixture(workspace, 'o1-wave1-floor-fast');
    assert.equal(fast.status, 1);
    assert.equal(fast.response.result, 'FAIL');
    const rate = fast.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(fast.response.findings));
    assert.equal(rate.run_count, 4);
    assert.equal(rate.fast_run_count, 1);
    assert.equal(rate.fast_rate, 0.25);
    assert.deepEqual(rate.run_ids, ['run-wave-peer-2']);
    const fastObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-wave1-floor-fast', 'evidence', fast.response.evidence[0].path), 'utf8'));
    assert.equal(fastObservation.duration_floor_observations.length, 1);
    assert.equal(fastObservation.duration_floor_observations[0].run_count, 4);
    assert.equal(fastObservation.duration_floor_observations[0].fast_run_count, 1);
    assert.equal(fastObservation.duration_floor_observations[0].fast_rate, 0.25);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('T2.2 US-002: O1 excludes scripted and stored-evidence 0-token runs from duration-floor findings', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);

    // (a) A mechanically-fast scripted wave (execution_mode='scripted' on
    // every run, caps.tokens=0) PASSes with zero O1_DURATION_FLOOR_*
    // findings; the observation row is still written (run_count 0).
    const scripted = invokeFixture(workspace, 'o1-scripted-fast-wave');
    assert.equal(scripted.status, 0);
    assert.equal(scripted.response.result, 'PASS');
    assert.equal(scripted.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(scripted.response.findings));
    const scriptedObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-scripted-fast-wave', 'evidence', scripted.response.evidence[0].path), 'utf8'));
    assert.equal(scriptedObservation.duration_floor_observations.length, 1);
    assert.equal(scriptedObservation.duration_floor_observations[0].run_count, 0);
    assert.equal(scriptedObservation.duration_floor_observations[0].fast_run_count, 0);
    assert.equal(scriptedObservation.duration_floor_observations[0].fast_rate, 0);

    // (b) STORED schema-1 shape: wave run rows WITHOUT execution_mode on a
    // caps.tokens === 0 case PASS via the case-level zero-token fallback.
    const stored = invokeFixture(workspace, 'o1-stored-scripted-fast-wave');
    assert.equal(stored.status, 0);
    assert.equal(stored.response.result, 'PASS');
    assert.equal(stored.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(stored.response.findings));
    const storedObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-stored-scripted-fast-wave', 'evidence', stored.response.evidence[0].path), 'utf8'));
    assert.equal(storedObservation.duration_floor_observations.length, 1);
    assert.equal(storedObservation.duration_floor_observations[0].run_count, 0);

    // (c) A mixed real+scripted family computes fast_rate on the REAL runs
    // only: 4 real eligible runs (1 fast -> 0.25 > MAX_FAST_RATE, so
    // O1_DURATION_FLOOR_RATE fires with real-only counts) and 4 fast scripted
    // peers excluded from both numerator and denominator.
    const mixed = invokeFixture(workspace, 'o1-mixed-real-scripted-family');
    assert.equal(mixed.status, 1);
    assert.equal(mixed.response.result, 'FAIL');
    const rate = mixed.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(rate, JSON.stringify(mixed.response.findings));
    assert.equal(rate.run_count, 4);
    assert.equal(rate.fast_run_count, 1);
    assert.equal(rate.fast_rate, 0.25);
    assert.deepEqual(rate.run_ids, ['run-wave-peer-2']);
    const mixedObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-mixed-real-scripted-family', 'evidence', mixed.response.evidence[0].path), 'utf8'));
    assert.equal(mixedObservation.duration_floor_observations.length, 1);
    assert.equal(mixedObservation.duration_floor_observations[0].run_count, 4);
    assert.equal(mixedObservation.duration_floor_observations[0].fast_run_count, 1);
    assert.equal(mixedObservation.duration_floor_observations[0].fast_rate, 0.25);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('S43a US-006: O1 duration-floor calibration — fast-honest flag + per-cell floors', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);

    // RED-ARM (pre-fix): the campaign W4.08-control 13%-under shape — an
    // HONEST run finishing 522s against the 600000ms family production-median
    // floor (green content oracles) is the only fast run in a 4-run family:
    // O1_DURATION_FLOOR_RATE fires citing the honest control run.
    const red = invokeFixture(workspace, 'o1-control-under-floor');
    assert.equal(red.status, 1);
    assert.equal(red.response.result, 'FAIL');
    const redRate = red.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(redRate, JSON.stringify(red.response.findings));
    assert.equal(redRate.run_count, 4);
    assert.equal(redRate.fast_run_count, 1);
    assert.equal(redRate.fast_rate, 0.25);
    assert.deepEqual(redRate.run_ids, ['run-11111111-1111-4111-8111-111111111111']);

    // GREEN-ARM (per-cell floor): the SAME shape with the per-cell floor
    // recalibrated to 480000ms — the per-cell floor is AUTHORITATIVE for the
    // control cell, the 522s honest run clears it, and the family PASSes.
    const perCell = invokeFixture(workspace, 'o1-control-per-cell-floor');
    assert.equal(perCell.status, 0);
    assert.equal(perCell.response.result, 'PASS');
    assert.equal(perCell.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(perCell.response.findings));
    const perCellObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-control-per-cell-floor', 'evidence', perCell.response.evidence[0].path), 'utf8'));
    const perCellFloors = new Map(perCellObservation.duration_floor_observations[0].case_floors.map((row) => [row.case_id, row]));
    assert.equal(perCellFloors.get('o1-control-per-cell-floor').duration_floor_ms, 480000);
    assert.equal(perCellObservation.duration_floor_observations[0].fast_run_count, 0);

    // GREEN-ARM (flag): a family whose runs are ALL declared
    // expected_fast_failure (the W4.37/W4.38-real/W4.47/W4.dsh-do-now shape)
    // PASSes — no run is floor-judgeable, the zero-run observation is written.
    const flagged = invokeFixture(workspace, 'o1-fast-honest-flagged');
    assert.equal(flagged.status, 0);
    assert.equal(flagged.response.result, 'PASS');
    assert.equal(flagged.response.findings.some((finding) => finding.id.startsWith('O1_DURATION_FLOOR')), false, JSON.stringify(flagged.response.findings));
    const flaggedObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-fast-honest-flagged', 'evidence', flagged.response.evidence[0].path), 'utf8'));
    assert.equal(flaggedObservation.duration_floor_observations.length, 1);
    assert.equal(flaggedObservation.duration_floor_observations[0].run_count, 0);
    assert.equal(flaggedObservation.duration_floor_observations[0].fast_run_count, 0);

    // GREEN-ARM (fail-closed): flagged fast runs are excluded from BOTH the
    // numerator and the denominator, but an UN-FLAGGED too-fast run still
    // FAILs the floor — the rate is computed on the un-flagged eligible only
    // and cites only the un-flagged run.
    const mixed = invokeFixture(workspace, 'o1-flagged-unflagged-mixed');
    assert.equal(mixed.status, 1);
    assert.equal(mixed.response.result, 'FAIL');
    const mixedRate = mixed.response.findings.find((finding) => finding.id === 'O1_DURATION_FLOOR_RATE');
    assert.ok(mixedRate, JSON.stringify(mixed.response.findings));
    assert.equal(mixedRate.run_count, 4);
    assert.equal(mixedRate.fast_run_count, 1);
    assert.equal(mixedRate.fast_rate, 0.25);
    assert.deepEqual(mixedRate.run_ids, ['run-wave-peer-1']);
    const mixedObservation = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-flagged-unflagged-mixed', 'evidence', mixed.response.evidence[0].path), 'utf8'));
    assert.equal(mixedObservation.duration_floor_observations[0].run_count, 4);
    assert.equal(mixedObservation.duration_floor_observations[0].fast_run_count, 1);
    assert.equal(mixedObservation.duration_floor_observations[0].fast_rate, 0.25);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('O1 applies DISP and marks a predeclared mechanically active Hermes straggler inconclusive', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    assert.equal(spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false }).status, 0);
    const { response, status } = invokeFixture(workspace, 'o1-healthy-straggler');
    assert.equal(status, 0);
    assert.equal(response.result, 'PASS');
    assert.deepEqual(response.classification, { ambiguous: { category: 'HEALTHY_STRAGGLER' } });
    const events = JSON.parse(fs.readFileSync(path.join(workspace, 'o1-healthy-straggler', 'snapshots', 'run-events.json'), 'utf8'));
    const tokenEvent = events.rows.find((row) => row.event.event === 'run.tokens.updated').event;
    assert.deepEqual(Object.keys(tokenEvent).sort(), [
      'event', 'runId', 'tokenDelta', 'tokensSpent', 'ts', 'workflowId',
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
