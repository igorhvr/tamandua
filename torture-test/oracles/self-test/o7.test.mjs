#!/usr/bin/env node
// O7 calibration self-test (torture-test only; STORM-O7).
//
// Drives the real O7 executable against FRESH OWNED calibration copies and
// asserts the version-1 output/exit contract plus each obligation's positive
// AND negative controls. Mutates ONLY separately owned calibration copies —
// never original evidence. Runs standalone: node --test o7.test.mjs
//
// Timing model: every fixture event timestamp is BASE + seq SECONDS, and
// every DB updated_at is expressed with SQLite second granularity at or
// before the second of the terminal event it accompanies — mirroring the
// native emitter order (DB update first, event ms afterwards, same second
// or later), so the chronology legs see realistic ordering.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

import { createScenario, line, eventLine } from './o7-fixtures.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const O7 = path.join(HERE, '..', 'O7');

const BASE = '2026-09-09T12:00:00.000Z';
const BASE_MS = Date.parse(BASE);

function ev(event, runId, extra = {}, seqSec = 0) {
  return { ts: new Date(BASE_MS + seqSec * 1000).toISOString(), event, runId, ...extra };
}

function dbSec(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Absolute wall-clock time (UTC) in SQLite format, offset seconds from the REAL
// current time rather than BASE. Needed by the leg1 snapshot-boundary case: the
// fixture's capture.events_captured_at is real `now + 5s` (see o7-fixtures.mjs),
// so a DB terminal transition meant to post-date that capture must be derived
// from wall-clock now too. The original source branch (aasylum STORM-O7
// 8f7f87bb) hardcoded '2026-09-10 12:00:00', which was a suite time-bomb: once
// the wall clock passed that instant the boundary case flipped FAIL instead of
// NOT_EVALUABLE (found by the torture-union gate, US-004).
function dbWall(offsetSeconds) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function runO7(sidecarPath, evidenceDir) {
  const result = spawnSync(process.execPath, [O7, '--sidecar', sidecarPath, '--evidence-dir', evidenceDir], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `O7 spawn failed: ${result.error?.message}`);
  let response = null;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch {
    assert.fail(`O7 stdout is not one JSON object: ${result.stdout.slice(0, 500)}`);
  }
  return { status: result.status, response };
}

function patchMembers(sc, extraFiles) {
  const sidecar = JSON.parse(fs.readFileSync(sc.sidecarPath, 'utf8'));
  for (const [rel, role] of extraFiles) {
    const p = path.join(sc.dir, rel);
    fs.chmodSync(p, 0o644);
    const bytes = fs.readFileSync(p);
    sidecar.members.push({ role, path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    fs.chmodSync(p, 0o444);
  }
  fs.chmodSync(sc.sidecarPath, 0o644);
  fs.writeFileSync(sc.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  fs.chmodSync(sc.sidecarPath, 0o444);
}

const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.o7-calib.'));
const scenarios = path.join(workspace, 'scenarios');
// This module-level calibration workspace is shared by every test in the file;
// remove it once they all finish. Without this, `node --test` running this file
// concurrently with harness.test.mjs makes harness's "no leaked
// oracle-self-test.* workspace" assertion fail on o7's persistent directory
// (port F-002 follow-on: the watchdog fix let run.sh reach that assertion).
after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});
function scenario(name, spec) {
  return createScenario(path.join(scenarios, name), spec);
}

test('O7 leg1 positives: completed / failed / canceled / force_failed / deleted binding', () => {
  const cases = [
    { terminal: 'completed', terminalEvent: 'run.completed', sec: 6 },
    { terminal: 'failed', terminalEvent: 'run.failed', sec: 6 },
    { terminal: 'failed', terminalEvent: 'run.force_failed', sec: 6 },
    { terminal: 'canceled', terminalEvent: 'run.canceled', sec: 6 },
  ];
  cases.forEach((item, idx) => {
    const runId = `run-p${idx}`;
    const lines = [
      eventLine(ev('run.started', runId, { workflowId: 'wf' }, 0)),
      eventLine(ev('step.running', runId, { stepId: 's1', agentId: 'w1' }, 1)),
      eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-1' }, 2)),
      eventLine(ev('step.done', runId, { stepId: 's1' }, 3)),
      eventLine(ev(item.terminalEvent, runId, { workflowId: 'wf' }, item.sec)),
    ];
    const sc = scenario(`leg1-positive-${idx}`, {
      db: {
        runs: [{ id: runId, status: item.terminal, updated_at: dbSec(item.sec - 1) }],
        steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(3) }],
      },
      global: { live: lines },
      perRun: { [runId]: lines },
      scopeRuns: [runId],
    });
    const { status, response } = runO7(sc.sidecarPath, sc.evidenceDir);
    assert.equal(status, 0, `${item.terminal}/${item.terminalEvent}: ${JSON.stringify(response.findings)}`);
    assert.equal(response.result, 'PASS');
  });

  // deleted-run positive: no DB row; host receipt + run.deleted in both copies.
  const runId = 'run-del1';
  const lines = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('run.deleted', runId, {}, 5)),
  ];
  const sc = scenario('leg1-deleted-positive', {
    db: { runs: [], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
    deletedRuns: [{ run_id: runId, receipt_ts: new Date(BASE_MS + 5000).toISOString(), detail: 'host deleted run' }],
  });
  const { status, response } = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(status, 0, JSON.stringify(response.findings));
  assert.equal(response.result, 'PASS');

  // delete-after-terminal positive (the native deleteWorkflow cleanup path):
  // the run reaches a terminal state first (run.completed stays in the
  // append-only per-run stream) and is deleted later (run.deleted appended,
  // DB row removed, host deleted-run receipt). The pair
  // {run.completed, run.deleted} is the deletion OVERLAY, not a duplicate
  // terminal — PASS, and the overlay must be reported as an informational
  // note so the exemption is auditable.
  {
    const runDelTerm = 'run-del-term';
    const delTermLines = [
      eventLine(ev('run.started', runDelTerm, {}, 0)),
      eventLine(ev('run.completed', runDelTerm, {}, 5)),
      eventLine(ev('run.deleted', runDelTerm, {}, 6)),
    ];
    const scTerm = scenario('leg1-deleted-after-terminal-positive', {
      db: { runs: [], steps: [] },
      global: { live: delTermLines },
      perRun: { [runDelTerm]: delTermLines },
      scopeRuns: [runDelTerm],
      deletedRuns: [{ run_id: runDelTerm, receipt_ts: new Date(BASE_MS + 6000).toISOString(), detail: 'host deleted completed run' }],
    });
    const outTerm = runO7(scTerm.sidecarPath, scTerm.evidenceDir);
    assert.equal(outTerm.response.result, 'PASS', JSON.stringify(outTerm.response.findings));
    assert.ok(outTerm.response.findings.some((f) => f.id === 'O7_DELETION_OVERLAY'), `delete-after-terminal overlay not recognized: ${JSON.stringify(outTerm.response.findings)}`);
  }
});

test('O7 leg1 negatives: missing / status-mismatch / duplicate / boundary', () => {
  const runId = 'run-n1';
  // missing terminal, demonstrated (DB terminal at sec5 <= capture)
  let lines = [eventLine(ev('run.started', runId, {}, 0))];
  let sc = scenario('leg1-missing-terminal', {
    db: { runs: [{ id: runId, status: 'completed', updated_at: dbSec(5) }], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_TERMINAL_EVENT_MISSING'), JSON.stringify(out.response.findings));

  // status mismatch: DB failed but only run.completed present.
  lines = [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('run.completed', runId, {}, 6))];
  sc = scenario('leg1-status-mismatch', {
    db: { runs: [{ id: runId, status: 'failed', updated_at: dbSec(5) }], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL');
  assert.ok(out.response.findings.some((f) => f.id === 'O7_TERMINAL_STATUS_MISMATCH'), JSON.stringify(out.response.findings));

  // duplicate terminal with no resume marker between.
  lines = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('run.completed', runId, {}, 6)),
    eventLine(ev('run.completed', runId, {}, 7)),
  ];
  sc = scenario('leg1-duplicate-terminal', {
    db: { runs: [{ id: runId, status: 'completed', updated_at: dbSec(5) }], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL');
  assert.ok(out.response.findings.some((f) => f.id === 'O7_DUPLICATE_TERMINAL_EVENT'), JSON.stringify(out.response.findings));

  // boundary: DB terminal after events capture -> NOT_EVALUABLE, never PASS.
  lines = [eventLine(ev('run.started', runId, {}, 0))];
  sc = scenario('leg1-boundary', {
    db: { runs: [{ id: runId, status: 'completed', updated_at: dbWall(3600) }], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'NOT_EVALUABLE');
  assert.equal(out.status, 3);

  // receipt-less deletion stays red: run.completed then run.deleted with the
  // DB row STILL present and no host deleted-run receipt — no deletion-overlay
  // exemption applies, so the duplicate terminal is a finding.
  lines = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('run.completed', runId, {}, 6)),
    eventLine(ev('run.deleted', runId, {}, 7)),
  ];
  sc = scenario('leg1-deleted-no-receipt', {
    db: { runs: [{ id: runId, status: 'completed', updated_at: dbSec(5) }], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_DUPLICATE_TERMINAL_EVENT'), JSON.stringify(out.response.findings));

  // deletion-overlay chronology is still enforced: even WITH a covering
  // receipt, a run.deleted whose ts precedes the lifecycle terminal it
  // follows in stream order (impossible under native append order) is an
  // anomaly, never a green overlay.
  const runDelChrono = 'run-del-chrono';
  const chronoLines = [
    eventLine(ev('run.started', runDelChrono, {}, 0)),
    eventLine(ev('run.completed', runDelChrono, {}, 7)),
    eventLine(ev('run.deleted', runDelChrono, {}, 6)),
  ];
  sc = scenario('leg1-deleted-overlay-chronology', {
    db: { runs: [], steps: [] },
    global: { live: chronoLines },
    perRun: { [runDelChrono]: chronoLines },
    scopeRuns: [runDelChrono],
    deletedRuns: [{ run_id: runDelChrono, receipt_ts: new Date(BASE_MS + 6000).toISOString(), detail: 'host deleted completed run' }],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_TERMINAL_CHRONOLOGY'), JSON.stringify(out.response.findings));
});

test('O7 leg2: claim/attempt epochs, auto-complete exception, identity negatives', () => {
  const runId = 'run-c';
  const dbRun = { id: runId, status: 'completed', updated_at: dbSec(4) };

  // realistic native step lifecycle: step.running (claim) ->
  // dispatch.render.validated (dispatched:true, stepRowId + claimId of the
  // attempt) -> step.done -> step.expects.validated outcome accepted (the
  // coalesced tail of the same native `step complete` call).
  const lifecycleOf = (stepId, rowId, claimId, doneAt, startAt = 1) => [
    eventLine(ev('step.running', runId, { stepId }, startAt)),
    eventLine(ev('dispatch.render.validated', runId, { stepId, stepRowId: rowId, dispatched: true, claimId }, startAt + 1)),
    eventLine(ev('step.done', runId, { stepId }, doneAt)),
    eventLine(ev('step.expects.validated', runId, { stepId, stepRowId: rowId, outcome: 'accepted', transitionAction: 'done', claimId }, doneAt + 1)),
  ];

  // positive: full realistic native claim -> done (accepted validation
  // coalesced into one completion).
  let sc = scenario('leg2-positive', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(3) }] },
    global: { live: [eventLine(ev('run.started', runId, {}, 0)), ...lifecycleOf('s1', 'row1', 'job-1', 3), eventLine(ev('run.completed', runId, {}, 5))] },
    perRun: { [runId]: [eventLine(ev('run.started', runId, {}, 0)), ...lifecycleOf('s1', 'row1', 'job-1', 3), eventLine(ev('run.completed', runId, {}, 5))] },
    scopeRuns: [runId],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction A): step.running + dispatch, then
  // step.retry, then step.done WITHOUT a new claim — the prior claim must
  // not authorize a completion across a retry.
  sc = scenario('leg2-retry-without-new-claim', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(4) }] },
    global: { live: [eventLine(ev('run.started', runId, {}, 0)), ...lifecycleOf('s1', 'row1', 'job-1', 3).slice(0, 2), eventLine(ev('step.retry', runId, { stepId: 's1' }, 4)), eventLine(ev('step.done', runId, { stepId: 's1' }, 5)), eventLine(ev('run.completed', runId, {}, 6))] },
    perRun: { [runId]: [eventLine(ev('run.started', runId, {}, 0)), ...lifecycleOf('s1', 'row1', 'job-1', 3).slice(0, 2), eventLine(ev('step.retry', runId, { stepId: 's1' }, 4)), eventLine(ev('step.done', runId, { stepId: 's1' }, 5)), eventLine(ev('run.completed', runId, {}, 6))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction A): dispatch.render.validated carries a
  // stepRowId that is no step row of this run.
  sc = scenario('leg2-foreign-step-row', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(3) }] },
    global: { live: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'foreign-row', dispatched: true, claimId: 'job-1' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('run.completed', runId, {}, 5))] },
    perRun: { [runId]: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'foreign-row', dispatched: true, claimId: 'job-1' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('run.completed', runId, {}, 5))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ROW_IDENTITY'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction A): dispatch.render.validated carries a
  // foreign claimId although the DB row pins claim job job-1 (single claim).
  sc = scenario('leg2-foreign-claim', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(3) }] },
    global: { live: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'foreign-job' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('run.completed', runId, {}, 5))] },
    perRun: { [runId]: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'foreign-job' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('run.completed', runId, {}, 5))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_CLAIM_IDENTITY'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction A): TWO step.done events at different
  // timestamps for one step, no retry/new claim between — duplicate.
  sc = scenario('leg2-duplicate-completion', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(4) }] },
    global: { live: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-1' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('step.done', runId, { stepId: 's1' }, 4)), eventLine(ev('run.completed', runId, {}, 5))] },
    perRun: { [runId]: [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('step.running', runId, { stepId: 's1' }, 1)), eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-1' }, 2)), eventLine(ev('step.done', runId, { stepId: 's1' }, 3)), eventLine(ev('step.done', runId, { stepId: 's1' }, 4)), eventLine(ev('run.completed', runId, {}, 5))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_DUPLICATE_COMPLETION'), JSON.stringify(out.response.findings));

  // negative: step.done with no claim marker / no auto-completion.
  const linesN = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.done', runId, { stepId: 's1' }, 3)),
    eventLine(ev('run.completed', runId, {}, 5)),
  ];
  sc = scenario('leg2-claimless-done', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', auto_completed: 0, updated_at: dbSec(3) }] },
    global: { live: linesN },
    perRun: { [runId]: linesN },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'));

  // negative: claim marker AFTER step.done.
  const linesA = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.done', runId, { stepId: 's1' }, 3)),
    eventLine(ev('step.running', runId, { stepId: 's1' }, 4)),
    eventLine(ev('run.completed', runId, {}, 5)),
  ];
  sc = scenario('leg2-claim-after-done', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', updated_at: dbSec(3) }] },
    global: { live: linesA },
    perRun: { [runId]: linesA },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'));

  // auto-complete positive: DB flag + step.auto_completed + step.done, no claim.
  const linesAc = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.auto_completed', runId, { stepId: 's2', condition: 'skip_flag', reason: 'condition_unset:skip_flag' }, 3)),
    eventLine(ev('step.done', runId, { stepId: 's2' }, 4)),
    eventLine(ev('run.completed', runId, {}, 5)),
  ];
  const acRow = { id: 'row2', run_id: runId, step_id: 's2', status: 'done', type: 'conditional', auto_completed: 1, auto_complete_reason: 'condition_unset:skip_flag', updated_at: dbSec(4) };
  sc = scenario('leg2-autocomplete-positive', {
    db: { runs: [dbRun], steps: [acRow] },
    global: { live: linesAc },
    perRun: { [runId]: linesAc },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // auto-complete single-side: DB flag missing but event marker present.
  sc = scenario('leg2-autocomplete-singleside-db', {
    db: { runs: [dbRun], steps: [{ ...acRow, auto_completed: 0, auto_complete_reason: null }] },
    global: { live: linesAc },
    perRun: { [runId]: linesAc },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_AUTOCOMPLETE_SINGLE_SIDE'));

  // auto-complete event-side missing: DB says auto but no step.auto_completed.
  const linesAe = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.done', runId, { stepId: 's2' }, 4)),
    eventLine(ev('run.completed', runId, {}, 5)),
  ];
  sc = scenario('leg2-autocomplete-eventside-missing', {
    db: { runs: [dbRun], steps: [acRow] },
    global: { live: linesAe },
    perRun: { [runId]: linesAe },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_AUTOCOMPLETE_SINGLE_SIDE'), JSON.stringify(out.response.findings));

  // auto-complete reason contradiction: the row was auto-completed for one
  // condition but the event claims another.
  const linesAc2 = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.auto_completed', runId, { stepId: 's2', condition: 'other_flag', reason: 'condition_unset:other_flag' }, 3)),
    eventLine(ev('step.done', runId, { stepId: 's2' }, 4)),
    eventLine(ev('run.completed', runId, {}, 5)),
  ];
  sc = scenario('leg2-autocomplete-reason-mismatch', {
    db: { runs: [dbRun], steps: [acRow] },
    global: { live: linesAc2 },
    perRun: { [runId]: linesAc2 },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ROW_IDENTITY'), JSON.stringify(out.response.findings));

  // cross-run: a claim in run X cannot justify a completion in run Y.
  const runB = 'run-c-b';
  const linesB = [
    eventLine(ev('run.started', runB, {}, 0)),
    eventLine(ev('step.done', runB, { stepId: 's1' }, 3)),
    eventLine(ev('run.completed', runB, {}, 5)),
  ];
  sc = scenario('leg2-cross-run', {
    db: { runs: [{ id: runB, status: 'completed', updated_at: dbSec(4) }], steps: [{ id: 'rowB', run_id: runB, step_id: 's1', status: 'done', updated_at: dbSec(3) }] },
    global: { live: linesB },
    perRun: { [runB]: linesB },
    scopeRuns: [runB],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'));

  // cross-row: a claim for step s2 (row row2) cannot justify a completion
  // of step s1 (row row1) — each step row needs its own claim.
  const runCr = 'run-cr';
  const linesCr = [
    eventLine(ev('run.started', runCr, {}, 0)),
    eventLine(ev('step.running', runCr, { stepId: 's2' }, 1)),
    eventLine(ev('dispatch.render.validated', runCr, { stepId: 's2', stepRowId: 'row2', dispatched: true, claimId: 'job-2' }, 2)),
    eventLine(ev('step.done', runCr, { stepId: 's1' }, 3)),
    eventLine(ev('run.completed', runCr, {}, 5)),
  ];
  sc = scenario('leg2-cross-row', {
    db: {
      runs: [{ id: runCr, status: 'completed', updated_at: dbSec(4) }],
      steps: [
        { id: 'row1', run_id: runCr, step_id: 's1', status: 'done', updated_at: dbSec(3) },
        { id: 'row2', run_id: runCr, step_id: 's2', status: 'done', claim_job_id: 'job-2', updated_at: dbSec(3) },
      ],
    },
    global: { live: linesCr },
    perRun: { [runCr]: linesCr },
    scopeRuns: [runCr],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'), JSON.stringify(out.response.findings));

  // retry corridor positive: claim(A) -> retry -> claim(B) -> done is
  // legitimate; the final DB claim identity (job-2) matches attempt B.
  const linesR = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.running', runId, { stepId: 's1' }, 1)),
    eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-1' }, 2)),
    eventLine(ev('step.retry', runId, { stepId: 's1' }, 3)),
    eventLine(ev('step.running', runId, { stepId: 's1' }, 4)),
    eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-2' }, 5)),
    eventLine(ev('step.done', runId, { stepId: 's1' }, 6)),
    eventLine(ev('run.completed', runId, {}, 7)),
  ];
  sc = scenario('leg2-retry-positive', {
    db: { runs: [dbRun], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-2', updated_at: dbSec(6) }] },
    global: { live: linesR },
    perRun: { [runId]: linesR },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // loop/story positive: a loop row is claimed per story (running +
  // dispatch per story) and completes exactly once with step.done.
  const loopRun = 'run-loop';
  const loopLines = [
    eventLine(ev('run.started', loopRun, {}, 0)),
    eventLine(ev('step.running', loopRun, { stepId: 'loop1', agentId: 'w1' }, 1)),
    eventLine(ev('dispatch.render.validated', loopRun, { stepId: 'loop1', stepRowId: 'rowL', dispatched: true, claimId: 'job-L1' }, 2)),
    eventLine(ev('story.started', loopRun, { stepId: 'loop1', storyId: 'st-1' }, 3)),
    eventLine(ev('story.done', loopRun, { stepId: 'loop1', storyId: 'st-1' }, 4)),
    eventLine(ev('step.running', loopRun, { stepId: 'loop1', agentId: 'w1' }, 5)),
    eventLine(ev('dispatch.render.validated', loopRun, { stepId: 'loop1', stepRowId: 'rowL', dispatched: true, claimId: 'job-L2' }, 6)),
    eventLine(ev('story.started', loopRun, { stepId: 'loop1', storyId: 'st-2' }, 7)),
    eventLine(ev('story.done', loopRun, { stepId: 'loop1', storyId: 'st-2' }, 8)),
    eventLine(ev('step.done', loopRun, { stepId: 'loop1' }, 9)),
    eventLine(ev('run.completed', loopRun, {}, 10)),
  ];
  sc = scenario('leg2-loop-positive', {
    db: { runs: [{ id: loopRun, status: 'completed', updated_at: dbSec(9) }], steps: [{ id: 'rowL', run_id: loopRun, step_id: 'loop1', status: 'done', type: 'loop', claim_job_id: 'job-L2', updated_at: dbSec(9) }] },
    global: { live: loopLines },
    perRun: { [loopRun]: loopLines },
    scopeRuns: [loopRun],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // claim-less step.failed.
  const linesF = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.failed', runId, { stepId: 's1' }, 3)),
    eventLine(ev('run.failed', runId, {}, 5)),
  ];
  sc = scenario('leg2-claimless-failed', {
    db: { runs: [{ id: runId, status: 'failed', updated_at: dbSec(4) }], steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'failed', updated_at: dbSec(3) }] },
    global: { live: linesF },
    perRun: { [runId]: linesF },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COMPLETION_WITHOUT_CLAIM'));
});

test('O7 leg3: empty-runId ledger, attribution, orphan, copy, malformed', () => {
  const runId = 'run-a';
  const dbRun = { id: runId, status: 'completed', updated_at: dbSec(4) };
  const runStarted = eventLine(ev('run.started', runId, {}, 0));
  const runCompleted = eventLine(ev('run.completed', runId, {}, 5));
  const emptyMerge = eventLine(ev('merge.landed', '', { origin: '/o', target: 'refs/heads/main', noop: false }, 6));

  // empty-runId event with NO host ledger -> FAIL.
  let sc = scenario('leg3-empty-unledgered', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, runCompleted, emptyMerge] },
    perRun: { [runId]: [runStarted, runCompleted], '': [emptyMerge] },
    scopeRuns: [runId],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_EMPTY_RUN_ID_EVENT'));

  // host-predeclared manual-operation ledger entry matching identity -> PASS.
  sc = scenario('leg3-ledger-exempt', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, runCompleted, emptyMerge] },
    perRun: { [runId]: [runStarted, runCompleted], '': [emptyMerge] },
    scopeRuns: [runId],
    manualLedger: [{ entry_id: 'm1', event: 'merge.landed', identity: { origin: '/o', target: 'refs/heads/main', noop: false } }],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // ledger type mismatch: ledger expects merge.landed but actual is a
  // merge.target_moved -> unledgered empty-runId event is a finding.
  const moved = eventLine(ev('merge.target_moved', '', { origin: '/o', actualTip: 'x' }, 6));
  sc = scenario('leg3-ledger-type-mismatch', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, runCompleted, moved] },
    perRun: { [runId]: [runStarted, runCompleted], '': [moved] },
    scopeRuns: [runId],
    manualLedger: [{ entry_id: 'm2', event: 'merge.landed', identity: { origin: '/o' } }],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_EMPTY_RUN_ID_EVENT'));

  // cross-stream attribution: an event carrying another run's id inside a
  // per-run stream.
  const runB = 'run-a-b';
  const runBLines = [eventLine(ev('run.started', runB, {}, 0)), eventLine(ev('step.running', runB, { stepId: 's1' }, 1)), eventLine(ev('run.completed', runB, {}, 5))];
  sc = scenario('leg3-wrong-stream', {
    db: { runs: [{ id: runB, status: 'completed', updated_at: dbSec(4) }], steps: [{ id: 'rowB', run_id: runB, step_id: 's1', status: 'done' }] },
    global: { live: [runBLines[0], eventLine(ev('run.started', runId, {}, 0)), runBLines[1], runBLines[2]] },
    perRun: { [runB]: [eventLine(ev('run.started', runId, {}, 0)), ...runBLines] },
    scopeRuns: [runB],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ATTRIBUTION_MISMATCH'), JSON.stringify(out.response.findings));

  // orphan run stream: a per-run file naming a run with no DB row/receipt.
  sc = scenario('leg3-orphan-stream', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, runCompleted] },
    perRun: { [runId]: [runStarted, runCompleted], 'run-orphan': [eventLine(ev('run.started', 'run-orphan', {}, 0))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ORPHAN_RUN_STREAM'), JSON.stringify(out.response.findings));

  // per-run line absent from the global train -> copy mismatch.
  sc = scenario('leg3-copy-mismatch', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted] },
    perRun: { [runId]: [runStarted, runCompleted] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));

  // malformed JSONL line.
  sc = scenario('leg3-malformed', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, 'this is not json\n'] },
    perRun: { [runId]: [runStarted] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_MALFORMED_LINE'), JSON.stringify(out.response.findings));

  // truncated final line (valid JSON but no trailing newline — native emitter
  // always terminates with "\n").
  const partial = '{"ts":"2026-09-09T12:00:05.000Z","event":"run.completed","runId":"run-a"}';
  sc = scenario('leg3-truncated', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [runStarted, `${partial}\n`] },
    perRun: { [runId]: [runStarted, partial] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_TRUNCATED_FINAL_LINE'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction B): the global train carries an extra
  // known-run event missing from the captured per-run stream. One-direction
  // subsequence containment would pass this; the two-way correspondence must
  // fail it.
  const runG = 'run-g';
  const gExtraLines = [
    eventLine(ev('run.started', runG, {}, 0)),
    eventLine(ev('step.running', runG, { stepId: 's1' }, 1)),
    eventLine(ev('step.retry', runG, { stepId: 's1' }, 2)),
    eventLine(ev('step.done', runG, { stepId: 's1' }, 3)),
    eventLine(ev('run.completed', runG, {}, 5)),
  ];
  sc = scenario('leg3-global-extra-event', {
    db: { runs: [{ id: runG, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: gExtraLines },
    perRun: { [runG]: [gExtraLines[0], gExtraLines[1], gExtraLines[3], gExtraLines[4]] },
    scopeRuns: [runG],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction B): duplicate run member in the global
  // train (across a segment boundary) that the per-run stream does not carry.
  const runD = 'run-d';
  const runDLines = [
    eventLine(ev('run.started', runD, {}, 0)),
    eventLine(ev('run.completed', runD, {}, 5)),
  ];
  sc = scenario('leg3-global-duplicate-member', {
    db: { runs: [{ id: runD, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: [runDLines[0], runDLines[1], runDLines[1]] },
    perRun: { [runD]: runDLines },
    scopeRuns: [runD],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));

  // ROOT NEGATIVE (close correction B): reordered run member across a
  // segment boundary (per-run order differs from the global slice order).
  const runO = 'run-o';
  const o1 = eventLine(ev('run.started', runO, {}, 0));
  const o2 = eventLine(ev('step.running', runO, { stepId: 's1' }, 1));
  const o3 = eventLine(ev('step.done', runO, { stepId: 's1' }, 2));
  const o4 = eventLine(ev('run.completed', runO, {}, 5));
  sc = scenario('leg3-reordered-member', {
    db: { runs: [{ id: runO, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: [o1, o2, o3, o4] },
    perRun: { [runO]: [o1, o3, o2, o4] },
    scopeRuns: [runO],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));

  // Declared PARTIAL per-run capture whose prefix matches its global slice
  // prefix: PASS with the declared bound recorded as coverage — never a
  // silent full-capture PASS.
  const runP = 'run-p';
  const pLines = [
    eventLine(ev('run.started', runP, {}, 0)),
    eventLine(ev('run.completed', runP, {}, 5)),
  ];
  sc = scenario('leg3-partial-declared-positive', {
    db: { runs: [{ id: runP, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: pLines },
    perRun: { [runP]: [pLines[0]] },
    scopeRuns: [runP],
    perRunCapture: { [runP]: { kind: 'partial', declared_prefix_lines: 1 } },
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));
  const partialArtifact = JSON.parse(fs.readFileSync(path.join(sc.evidenceDir, 'o7-event-integrity.json'), 'utf8'));
  assert.ok(partialArtifact.informational.some((f) => f.id === 'O7_PARTIAL_PER_RUN_COVERAGE'), JSON.stringify(partialArtifact.informational));

  // Declared PARTIAL capture whose prefix does NOT match the global slice
  // prefix -> FAIL within the declared window.
  sc = scenario('leg3-partial-declared-mismatch', {
    db: { runs: [{ id: runP, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: pLines },
    perRun: { [runP]: [eventLine(ev('run.started', runP, {}, 9))] },
    scopeRuns: [runP],
    perRunCapture: { [runP]: { kind: 'partial', declared_prefix_lines: 1 } },
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));

  // A capture that exceeds its declared partial bound -> FAIL.
  sc = scenario('leg3-partial-exceeds-bound', {
    db: { runs: [{ id: runP, status: 'completed', updated_at: dbSec(4) }], steps: [] },
    global: { live: pLines },
    perRun: { [runP]: pLines },
    scopeRuns: [runP],
    perRunCapture: { [runP]: { kind: 'partial', declared_prefix_lines: 1 } },
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_COPY_MISMATCH'), JSON.stringify(out.response.findings));
});

test('O7 leg4: HUSH debug-off regression + debug-on control + real-emitter probes', () => {
  const runId = 'run-h';
  const dbRun = { id: runId, status: 'completed', updated_at: dbSec(4) };
  const clean = [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('run.completed', runId, {}, 5))];
  const noisy = [...clean, eventLine(ev('run.nudged', runId, {}, 6)), eventLine(ev('agent.nudged', runId, {}, 7)), eventLine(ev('agent.nudge.skipped', runId, {}, 8))];

  // debug-off + noise -> FAIL.
  let sc = scenario('leg4-noise-debugoff', {
    db: { runs: [dbRun], steps: [] },
    global: { live: noisy },
    perRun: { [runId]: noisy },
    scopeRuns: [runId],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_HUSH_NOISE_REGRESSION'));

  // debug-off clean -> PASS.
  sc = scenario('leg4-clean-debugoff', {
    db: { runs: [dbRun], steps: [] },
    global: { live: clean },
    perRun: { [runId]: clean },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // debug-on + noise -> PASS (recorded as the debug control, never a
  // normal-mode regression). HUSH counts are LOGICAL: the same 3 noise lines
  // physically exist in the global train AND the per-run copy, so the
  // artifact must report 3 distinct raw events (not 6 physical copies).
  sc = scenario('leg4-noise-debugon', {
    capture: { debug_events_env: '1', launch_debug: '1' },
    db: { runs: [dbRun], steps: [] },
    global: { live: noisy },
    perRun: { [runId]: noisy },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));
  const leg4Artifact = JSON.parse(fs.readFileSync(path.join(sc.evidenceDir, 'o7-event-integrity.json'), 'utf8'));
  assert.equal(leg4Artifact.counts.hush_total, 3, `hush_total double-counts physical copies: ${JSON.stringify(leg4Artifact.counts.hush)}`);
  assert.equal(leg4Artifact.counts.hush_physical_copies, 6, `physical-copy accounting wrong: ${JSON.stringify(leg4Artifact.counts)}`);
  assert.deepEqual(leg4Artifact.counts.hush, { 'run.nudged': 1, 'agent.nudged': 1, 'agent.nudge.skipped': 1 });

  // probes: debug-off probe clean + debug-on probe noisy -> PASS.
  sc = scenario('leg4-probes-positive', {
    db: { runs: [dbRun], steps: [] },
    global: { live: clean },
    perRun: { [runId]: clean },
    probes: { off: [eventLine(ev('run.started', 'probe-run', {}, 0))], on: [eventLine(ev('run.nudged', 'probe-run', {}, 0))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // debug-off probe polluted with a HUSH event -> FAIL.
  sc = scenario('leg4-probes-negative', {
    db: { runs: [dbRun], steps: [] },
    global: { live: clean },
    perRun: { [runId]: clean },
    probes: { off: [eventLine(ev('agent.nudged', 'probe-run', {}, 0))], on: [eventLine(ev('run.nudged', 'probe-run', {}, 0))] },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_HUSH_PROBE'), JSON.stringify(out.response.findings));
});

test('O7 leg5: rotation structure/bounds + generation consistency + oversize', () => {
  const runId = 'run-rot';
  const dbRun = { id: runId, status: 'completed', updated_at: dbSec(4) };
  const runLines = [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('run.completed', runId, {}, 5))];
  // Archive filler events belong to a host-declared SYNTHETIC volume run so
  // the scoped run's per-run stream keeps exact two-way correspondence with
  // its own global-train slice (rotation structure is what is under test).
  const volRun = 'run-vol-rot';
  const archiveLine = (tag, s) => eventLine(ev('o7.gate.volume', volRun, { detail: tag, burst: 'rot', seq: s }, s));

  // positive: generation 3 with archives .1/.2/.3 and a live file.
  let sc = scenario('leg5-structure-positive', {
    db: { runs: [dbRun], steps: [] },
    global: { live: runLines, archives: { 1: [archiveLine('a1', 1)], 2: [archiveLine('a2', 2)], 3: [archiveLine('a3', 3)] }, generation: 3 },
    perRun: { [runId]: runLines },
    scopeRuns: [runId],
    syntheticStreams: [volRun],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));

  // generation mismatch: generation 3 but no archives captured.
  sc = scenario('leg5-generation-mismatch', {
    db: { runs: [dbRun], steps: [] },
    global: { live: runLines, generation: 3 },
    perRun: { [runId]: runLines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ROTATION_GENERATION_MISMATCH'));

  // oversize live file: exceeds the native cap by more than its final event.
  const hugePad = 'x'.repeat(20 * 1024 * 1024 + 2048);
  const bigLine = eventLine(ev('run.started', runId, { pad: hugePad }, 1));
  const tailLine = eventLine(ev('run.completed', runId, {}, 2));
  sc = scenario('leg5-oversize', {
    db: { runs: [dbRun], steps: [] },
    global: { live: [bigLine, tailLine] },
    perRun: { [runId]: runLines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'FAIL', JSON.stringify(out.response.findings));
  assert.ok(out.response.findings.some((f) => f.id === 'O7_ROTATION_OVERSIZE'), JSON.stringify(out.response.findings));
});

test('O7 gate: full reconstruction PASS (3 rotations + tail) and negatives', () => {
  const runId = 'run-gate';
  const runLines = [
    eventLine(ev('run.started', runId, {}, 0)),
    eventLine(ev('step.running', runId, { stepId: 's1' }, 1)),
    eventLine(ev('dispatch.render.validated', runId, { stepId: 's1', stepRowId: 'row1', dispatched: true, claimId: 'job-1' }, 2)),
    eventLine(ev('step.done', runId, { stepId: 's1' }, 3)),
    eventLine(ev('run.completed', runId, {}, 9)),
  ];
  const volumeRun = 'run-o7-volume';
  const volumeLines = [];
  for (let seq = 0; seq < 8; seq += 1) {
    volumeLines.push(eventLine(ev('o7.gate.volume', volumeRun, { workflowId: 'wf', stepId: 'vol', burst: 'b1', seq }, 100 + seq)));
  }
  const receipts = [
    { ts: new Date(BASE_MS + 1000).toISOString(), kind: 'launch', run_id: runId },
    { ts: new Date(BASE_MS + 2000).toISOString(), kind: 'claim', run_id: runId, step_id: 's1', agent_id: 'w1' },
    { ts: new Date(BASE_MS + 3000).toISOString(), kind: 'complete', run_id: runId, step_id: 's1', status: 'done' },
  ];
  const volumePlan = { schema_version: 1, bursts: [{ burst_id: 'b1', event: 'o7.gate.volume', run_id: volumeRun, workflow_id: 'wf', step_id: 'vol', seq_start: 0, seq_end: 8 }] };

  // Coherent train: archive3 (oldest) -> archive2 -> archive1 -> live. Every
  // volume seq appears exactly once across the retained train; both per-run
  // streams are byte-faithful ordered subsequences of the global train.
  const gateSpec = {
    name: 'gate-pass',
    runLines,
    volumeLines,
    archives: { 3: [runLines[0]], 2: [volumeLines[0], volumeLines[1]], 1: [volumeLines[2], volumeLines[3], volumeLines[4], volumeLines[5]] },
    globalLive: [volumeLines[6], volumeLines[7], runLines[1], runLines[2], runLines[3], runLines[4]],
    generation: 3,
  };
  const makeGate = (name, archives, globalLive, generation) => createScenario(path.join(scenarios, name), {
    capture: { kind: 'rotation-gate', producer: 'o7-gate-test', debug_events_env: null, launch_debug: null },
    db: {
      runs: [{ id: runId, status: 'completed', updated_at: dbSec(9) }],
      steps: [{ id: 'row1', run_id: runId, step_id: 's1', status: 'done', claim_job_id: 'job-1', updated_at: dbSec(3) }],
    },
    global: { live: globalLive, archives, generation },
    perRun: { [runId]: runLines, [volumeRun]: volumeLines },
    probes: { off: [eventLine(ev('run.started', 'probe-run', {}, 0))], on: [eventLine(ev('agent.nudged', 'probe-run', {}, 0))] },
    scopeRuns: [runId],
    syntheticStreams: [volumeRun],
  });

  // PASS gate
  const sc = makeGate('gate-pass', gateSpec.archives, gateSpec.globalLive, 3);
  fs.writeFileSync(path.join(sc.dir, 'receipts.jsonl'), receipts.map((r) => line(r)).join(''));
  fs.writeFileSync(path.join(sc.dir, 'volume-plan.json'), `${JSON.stringify(volumePlan, null, 2)}\n`);
  patchMembers(sc, [['receipts.jsonl', 'receipts'], ['volume-plan.json', 'volume-plan']]);
  const out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'PASS', JSON.stringify(out.response.findings));
  const artifact = JSON.parse(fs.readFileSync(path.join(sc.evidenceDir, 'o7-event-integrity.json'), 'utf8'));
  const leg5 = artifact.coverage.find((c) => c.obligation === 'leg5');
  assert.equal(leg5.result, 'PASS');
  assert.equal(leg5.gate.expected_volume, 8);
  assert.equal(leg5.gate.observed_volume, 8);

  // Negative: an injected (archive-injected) unplanned volume event.
  const injectedArchives = { 3: [runLines[0]], 2: [volumeLines[0], volumeLines[1]], 1: [volumeLines[2], volumeLines[3], volumeLines[4], volumeLines[5], eventLine(ev('o7.gate.volume', volumeRun, { workflowId: 'wf', stepId: 'vol', burst: 'b2', seq: 99 }, 200))] };
  const sc2 = makeGate('gate-injected-segment', injectedArchives, gateSpec.globalLive, 3);
  fs.writeFileSync(path.join(sc2.dir, 'receipts.jsonl'), receipts.map((r) => line(r)).join(''));
  fs.writeFileSync(path.join(sc2.dir, 'volume-plan.json'), `${JSON.stringify(volumePlan, null, 2)}\n`);
  patchMembers(sc2, [['receipts.jsonl', 'receipts'], ['volume-plan.json', 'volume-plan']]);
  const out2 = runO7(sc2.sidecarPath, sc2.evidenceDir);
  assert.equal(out2.response.result, 'FAIL', JSON.stringify(out2.response.findings));
  assert.ok(out2.response.findings.some((f) => f.id === 'O7_VOLUME_UNPLANNED'), JSON.stringify(out2.response.findings));

  // Negative: an expected volume seq lost across rotation (missing member).
  const lostArchives = { 3: [runLines[0]], 2: [volumeLines[0], volumeLines[1]], 1: [volumeLines[2], volumeLines[4], volumeLines[5]] }; // seq3 dropped
  const sc3 = makeGate('gate-lost-segment', lostArchives, gateSpec.globalLive, 3);
  fs.writeFileSync(path.join(sc3.dir, 'receipts.jsonl'), receipts.map((r) => line(r)).join(''));
  fs.writeFileSync(path.join(sc3.dir, 'volume-plan.json'), `${JSON.stringify(volumePlan, null, 2)}\n`);
  patchMembers(sc3, [['receipts.jsonl', 'receipts'], ['volume-plan.json', 'volume-plan']]);
  const out3 = runO7(sc3.sidecarPath, sc3.evidenceDir);
  assert.equal(out3.response.result, 'FAIL', JSON.stringify(out3.response.findings));
  assert.ok(out3.response.findings.some((f) => f.id === 'O7_VOLUME_MISSING'), JSON.stringify(out3.response.findings));
});

test('O7 evidence integrity: tampered hash / escape / symlink / writable db / 4th archive fail closed', () => {
  const runId = 'run-sec';
  const lines = [eventLine(ev('run.started', runId, {}, 0)), eventLine(ev('run.completed', runId, {}, 5))];
  const dbRun = { id: runId, status: 'completed', updated_at: dbSec(4) };

  let sc = scenario('sec-tampered-hash', {
    tamper: 'hash',
    db: { runs: [dbRun], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  let out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'ERROR');
  assert.equal(out.status, 2);

  sc = scenario('sec-escape', {
    tamper: 'escape',
    db: { runs: [dbRun], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'ERROR');

  sc = scenario('sec-writable-db', {
    tamper: 'writable-db',
    db: { runs: [dbRun], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'ERROR');

  sc = scenario('sec-symlink', {
    tamper: 'symlink',
    db: { runs: [dbRun], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'ERROR');

  // A 4th archive cannot be captured without tripping the retention schema —
  // O7 fails closed (never silently accepts >3 archives).
  sc = scenario('sec-fourth-archive', {
    db: { runs: [dbRun], steps: [] },
    global: { live: lines },
    perRun: { [runId]: lines },
    scopeRuns: [runId],
  });
  const sidecar = JSON.parse(fs.readFileSync(sc.sidecarPath, 'utf8'));
  fs.writeFileSync(path.join(sc.dir, 'events/all.jsonl.4'), lines.join(''));
  const bytes = fs.readFileSync(path.join(sc.dir, 'events/all.jsonl.4'));
  sidecar.members.push({ role: 'global-archive:4', path: 'events/all.jsonl.4', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  fs.chmodSync(sc.sidecarPath, 0o644);
  fs.writeFileSync(sc.sidecarPath, `${JSON.stringify(sidecar)}\n`);
  fs.chmodSync(sc.sidecarPath, 0o444);
  out = runO7(sc.sidecarPath, sc.evidenceDir);
  assert.equal(out.response.result, 'ERROR');
});
