#!/usr/bin/env node
// tt-oracle-replay-invariants.test.mjs — E3.B US-011: honest-verdict invariant
// verification for the offline evidence replay.
//
// Pins, mechanically, the campaign-#7 delta-table contract so future oracle
// changes fail loudly when an honest verdict flips:
//   - only the scoped artifact classes (S5/S6/S7/S13/S19/S20/S21/S23) may
//     disappear or transition between a stored verdict and its replay;
//   - the named CNEV O1_TERMINAL_EVENT_MISSING failures and
//     O8_SEEDED_TEST_CHANGED failures survive unchanged (shape-aware since
//     US-005: a stored-PASS shape has nothing to preserve);
//   - every RUNAWAY case in the campaign report keeps at least one FAIL
//     verdict after the replay (so the RUNAWAY kind-finding stays visible;
//     cases with no replay rows are noted as skipped);
//   - the tool's --verify-invariants mode exits 1 on any violation.

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

const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function testRoot() {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(VAR_ROOT, 'tt-oracle-replay-invariants-test.'));
}

function row(overrides = {}) {
  return {
    caseId: 'C1',
    attempt: 'attempt-1',
    oracle: 'O1',
    before: 'FAIL',
    after: 'FAIL',
    delta: 'same',
    beforeFindingIds: [],
    findingIds: [],
    invokeError: null,
    ...overrides,
  };
}

// ── classification ──────────────────────────────────────────────────────────

test('isScopedDisappearing classifies only the scoped artifact findings', () => {
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L1-ts', oracle: 'O1', findingId: 'O1_DURATION_FLOOR_RATE' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.19-pause-drain', oracle: 'O1', findingId: 'O1_DURATION_FLOOR_MISSING' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.17a-marathon-natural', oracle: 'O11', findingId: 'O11_DONE_WITHOUT_EXPECTS_SUCCESS' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.17b-marathon-chaos', oracle: 'O11', findingId: 'O11_COMPLETED_FROM_RETRY_VERDICT' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.17a-marathon-natural', oracle: 'O8', findingId: 'O8_EXISTING_OUTSIDE_BOUNDARY' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.17b-marathon-chaos', oracle: 'O8', findingId: 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES' }), true);
  // S7 boundary findings are scoped ONLY on the W3.17a/b marathon cases.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.18-pause-no-drain', oracle: 'O8', findingId: 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES' }), false);
  // S13 foreign-row finding is scoped ONLY on W1.REPLAY-ts.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.REPLAY-ts', oracle: 'O9', findingId: 'O9_LEDGER_TREE_UNRESOLVED' }), true);
  // S21 (2026-08-24, US-005): the S21 ledger-scoping calibration scopes
  // O9_LEDGER_TREE_UNRESOLVED on O9 generally (stored false positives from
  // prior-attempt rows legitimately vanish) — so a non-W1.REPLAY-ts O9 case
  // is now scoped too, but only on O9.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.REPLAY-python', oracle: 'O9', findingId: 'O9_LEDGER_TREE_UNRESOLVED' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.REPLAY-python', oracle: 'O2', findingId: 'O9_LEDGER_TREE_UNRESOLVED' }), false);
  // S20 (2026-08-24, US-005): O2_REF_TRANSITION_COUNT is scoped on O2 only —
  // the S20 reflog-parser calibration made the stored false positive vanish.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O2', findingId: 'O2_REF_TRANSITION_COUNT' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W3.01-bfmw-pi-python', oracle: 'O2', findingId: 'O2_REF_TRANSITION_COUNT' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O9', findingId: 'O2_REF_TRANSITION_COUNT' }), false);
  // S19 (2026-08-24): O8_SEEDED_TEST_CHANGED is scoped ONLY when the replay's
  // findings carry the informational O8_SEEDED_TEST_EXTENDED on the same pair
  // (the seeded delta is provably additive, so the FAIL->PASS flip is legal).
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O8', findingId: 'O8_SEEDED_TEST_CHANGED', afterFindingIds: ['O8_SEEDED_TEST_EXTENDED'] }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O8', findingId: 'O8_SEEDED_TEST_CHANGED', afterFindingIds: ['O8_SEEDED_TEST_EXTENDED', 'O8_SEEDED_TEST_CHANGED'] }), true);
  // Without O8_SEEDED_TEST_EXTENDED in the replay (or on a non-O8 oracle) the
  // seeded finding is an honest verdict and must survive.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O8', findingId: 'O8_SEEDED_TEST_CHANGED' }), false);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O8', findingId: 'O8_SEEDED_TEST_CHANGED', afterFindingIds: ['O8_SEEDED_TEST_CHANGED'] }), false);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O1', findingId: 'O8_SEEDED_TEST_CHANGED', afterFindingIds: ['O8_SEEDED_TEST_EXTENDED'] }), false);
  // Honest findings are never scoped.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O1', findingId: 'O1_TERMINAL_EVENT_MISSING' }), false);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O8', findingId: 'O8_SEEDED_TEST_CHANGED', afterFindingIds: [] }), false);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W1.L3-ts', oracle: 'O1', findingId: 'ORACLE_RUNTIME_ERROR' }), false);
  // ORACLE_RUNTIME_ERROR is the stored shape of the S13 null-gate_key
  // degradation: scoped only on O2/O9/O10.
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O9', findingId: 'ORACLE_RUNTIME_ERROR' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O2', findingId: 'ORACLE_RUNTIME_ERROR' }), true);
  assert.equal(replay.isScopedDisappearing({ caseId: 'W2.22-non-main-bfmw', oracle: 'O10', findingId: 'ORACLE_RUNTIME_ERROR' }), true);
});

// ── honest-finding preservation + transition classes ─────────────────────────

test('verifyReplayInvariants accepts a replay where only scoped findings disappear', () => {
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L1-ts', 'W2.23a-expects-regex', 'W1.L2-python'],
    rows: [
      row({ caseId: 'W1.L1-ts', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O1_DURATION_FLOOR_RATE'] }),
      row({ caseId: 'W2.23a-expects-regex', oracle: 'O9', before: 'ERROR', after: 'NOT_EVALUABLE', delta: 'flip', beforeFindingIds: ['ORACLE_RUNTIME_ERROR'] }),
      row({ caseId: 'W1.L2-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_DURATION_FLOOR_RATE', 'O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('verifyReplayInvariants flags an honest finding that vanished', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [
      row({ caseId: 'W1.L3-python', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
    ],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /O1_TERMINAL_EVENT_MISSING vanished/);
  assert.ok(verification.checks.some((check) => check.label === 'honest-finding-preservation' && !check.ok));
});

test('verifyReplayInvariants flags unclassified verdict transitions', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [
      row({ before: 'PASS', after: 'FAIL', delta: 'flip' }),
      row({ caseId: 'C2', oracle: 'O3z', before: 'FAIL', after: 'ERROR', delta: 'flip', beforeFindingIds: ['O1_DURATION_FLOOR_RATE'] }),
      row({ caseId: 'C3', oracle: 'O3z', before: 'ERROR', after: 'NOT_EVALUABLE', delta: 'flip', beforeFindingIds: ['ORACLE_RUNTIME_ERROR'] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /PASS -> FAIL/);
  assert.match(joined, /FAIL -> ERROR/);
  assert.match(joined, /ERROR -> NOT_EVALUABLE flip on O3z/);
  const classes = verification.checks.find((check) => check.label === 'flip-transition-classes');
  assert.equal(classes.violations.length, 3);
});

test('verifyReplayInvariants flags a FAIL -> PASS flip with no recorded before findings', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [row({ before: 'FAIL', after: 'PASS', delta: 'flip' })],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /no recorded before findings/);
});

test('verifyReplayInvariants flags ERROR -> NOT_EVALUABLE outside the O2/O9/O10 scope', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [row({ oracle: 'O8', before: 'ERROR', after: 'NOT_EVALUABLE', delta: 'flip', beforeFindingIds: ['ORACLE_RUNTIME_ERROR'] })],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /scoped to O2\/O9\/O10/);
});

// ── S20/S21 calibration transitions + S23 floor-appearing flips (US-005) ─────

test('verifyReplayInvariants accepts S20/S21 calibration flips on O2/O9', () => {
  // S20 (reflog parser calibration): the stored O2_REF_TRANSITION_COUNT was a
  // false positive (message-less reflog lines counted 0 transitions); the
  // fixed parser recovers raw-only transitions, so the finding vanishes.
  // S21 (ledger scoping calibration): stored O9_LEDGER_TREE_UNRESOLVED rows
  // from prior campaign attempts legitimately vanish — FAIL -> PASS flip.
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W2.22-non-main-bfmw', 'W3.01-bfmw-pi-python'],
    pins: { cnev: [], o8Seeded: [] },
    rows: [
      row({ caseId: 'W2.22-non-main-bfmw', oracle: 'O2', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O2_LANDING_EVENT_MISSING', 'O2_REF_TRANSITION_COUNT'], findingIds: ['O2_LANDING_EVENT_MISSING', 'O2_REF_TRANSITION_UNATTRIBUTED'] }),
      row({ caseId: 'W2.22-non-main-bfmw', oracle: 'O9', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O9_LEDGER_TREE_UNRESOLVED'] }),
      row({ caseId: 'W3.01-bfmw-pi-python', oracle: 'O9', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O9_LEDGER_TREE_UNRESOLVED', 'O9_LEDGER_TREE_UNRESOLVED'] }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const classes = verification.checks.find((check) => check.label === 'flip-transition-classes');
  assert.equal(classes.violations.length, 0);
});

test('verifyReplayInvariants flags an O2/O9 finding vanishing on the WRONG oracle', () => {
  // The S20/S21 classes are oracle-scoped: O2_REF_TRANSITION_COUNT may vanish
  // only on O2 and O9_LEDGER_TREE_UNRESOLVED only on O9. A vanish on any other
  // oracle stays an honest-verdict violation.
  const verification = replay.verifyReplayInvariants({
    pins: { cnev: [], o8Seeded: [] },
    rows: [
      row({ caseId: 'W2.22-non-main-bfmw', oracle: 'O8', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O2_REF_TRANSITION_COUNT'] }),
      row({ caseId: 'W2.22-non-main-bfmw', oracle: 'O1', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O9_LEDGER_TREE_UNRESOLVED'] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /honest finding O2_REF_TRANSITION_COUNT vanished/);
  assert.match(joined, /honest finding O9_LEDGER_TREE_UNRESOLVED vanished/);
});

test('verifyReplayInvariants accepts an S23 PASS -> FAIL flip with only floor findings', () => {
  // S23 (SFX-B un-deadened guard): the stored wave-1 verdicts were PASS (dead
  // guard, no findings); the current O1 fires O1_DURATION_FLOOR_* on the
  // honest 46-102s wave-1 runs under the spec-era 120s floor. A PASS -> FAIL
  // flip is legal only when EVERY replayed finding is O1_DURATION_FLOOR_*.
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.M1-python', 'W1.L2-python'],
    pins: { cnev: [], o8Seeded: [] },
    rows: [
      row({ caseId: 'W1.M1-python', oracle: 'O1', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: ['O1_DURATION_FLOOR_RATE'] }),
      row({ caseId: 'W1.L2-python', oracle: 'O1', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: ['O1_DURATION_FLOOR_MISSING'] }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('verifyReplayInvariants flags an S23 PASS -> FAIL flip with a non-floor finding', () => {
  // A stored PASS may only flip to FAIL via the S23 floor-artifact class; a
  // non-floor finding appearing (e.g. O1_TERMINAL_EVENT_MISSING) is an honest
  // regression and must be flagged.
  const verification = replay.verifyReplayInvariants({
    pins: { cnev: [], o8Seeded: [] },
    rows: [
      row({ caseId: 'W1.M1-python', oracle: 'O1', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: ['O1_DURATION_FLOOR_RATE', 'O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L2-python', oracle: 'O1', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: [] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /PASS -> FAIL flip introduced non-floor finding/);
  const classes = verification.checks.find((check) => check.label === 'flip-transition-classes');
  assert.equal(classes.violations.length, 2);
});

test('verifyReplayInvariants accepts a CNEV pin on a stored-PASS shape (campaign #8)', () => {
  // Campaign #8 stored PASS (no O1_TERMINAL_EVENT_MISSING) for the CNEV
  // cases because the SFX-B un-deadened guard + S23 wave reporting changed
  // what O1 fires. The stored-PASS shape must stay PASS, or flip to FAIL only
  // via the S23 floor-artifact class — the pin is satisfied either way.
  // (W1.L3-ts excluded from the universe: its O8 pin is a separate concern.)
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L2-python', 'W1.L3-python'],
    rows: [
      row({ caseId: 'W1.L2-python', before: 'PASS', after: 'PASS' }),
      row({ caseId: 'W1.L3-python', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: ['O1_DURATION_FLOOR_MISSING'] }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('verifyReplayInvariants flags a CNEV stored-PASS shape flipping to FAIL with a non-floor finding', () => {
  // A stored PASS with no O1_TERMINAL_EVENT_MISSING may not flip to FAIL with
  // a non-floor finding — that is an honest verdict change.
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L2-python', 'W1.L3-python'],
    rows: [
      row({ caseId: 'W1.L2-python', before: 'PASS', after: 'FAIL', delta: 'flip', findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-python', before: 'PASS', after: 'PASS' }),
    ],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /CNEV pin violated/);
});

// ── named CNEV and O8 seeded pins ────────────────────────────────────────────

test('verifyReplayInvariants accepts the named CNEV and O8 seeded pins when satisfied', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [
      row({ caseId: 'W1.L2-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-ts', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      // S19 (2026-08-24): the four pinned O8 cases carry PROVABLY ADDITIVE
      // seeded-test deltas (verified by baseline-blob vs terminal-blob diff
      // over the campaign #7/#8 evidence), so each stored O8_SEEDED_TEST_CHANGED
      // now legitimately replays as the informational O8_SEEDED_TEST_EXTENDED
      // and the verdict flips FAIL -> PASS.
      row({ caseId: 'W1.L3-ts', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
      row({ caseId: 'W2.22-non-main-bfmw', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
      row({ caseId: 'W3.01-bfmw-pi-python', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
      row({ caseId: 'W3.02-bfmw-pi-ts', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
      // Campaign #7 stored a PASS O8 verdict for W3.03-bfmw-hermes-ts (no
      // seeded finding in its stdout.json): the pin enforces verdict
      // preservation — PASS must stay PASS.
      row({ caseId: 'W3.03-bfmw-hermes-ts', oracle: 'O8', before: 'PASS', after: 'PASS' }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
});

test('verifyReplayInvariants accepts an S19 O8 flip with the extended finding present', () => {
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L3-ts'],
    rows: [
      row({ caseId: 'W1.L3-ts', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-ts', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const classes = verification.checks.find((check) => check.label === 'flip-transition-classes');
  assert.equal(classes.violations.length, 0);
  const pins = verification.checks.find((check) => check.label === 'o8-seeded-pins');
  assert.equal(pins.violations.length, 0);
});

test('verifyReplayInvariants flags an O8 seeded pin flip without the extended finding', () => {
  // The pinned O8 case flipped FAIL -> PASS but the replayed findings do NOT
  // carry O8_SEEDED_TEST_EXTENDED — the S19 replacement never happened, so
  // the flip is not scoped: honest-finding-preservation, transition classes,
  // AND the o8-seeded pin all fire.
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L3-ts'],
    rows: [
      row({ caseId: 'W1.L3-ts', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-ts', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'], findingIds: [] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /honest finding O8_SEEDED_TEST_CHANGED vanished/);
  assert.match(joined, /FAIL -> PASS flip dropped non-scoped finding\(s\) O8_SEEDED_TEST_CHANGED/);
  assert.match(joined, /W1\.L3-ts\/attempt-1\/O8: O8 seeded pin violated/);
});

test('verifyReplayInvariants flags an O8 seeded pin whose stored verdict shape is wrong', () => {
  // A pinned O8 case must carry the stored FAIL + O8_SEEDED_TEST_CHANGED
  // shape for the S19 flip to be legitimate. A stored PASS verdict with no
  // seeded finding cannot flip to a PASS + O8_SEEDED_TEST_EXTENDED replay:
  // the flip-to-extended pin is violated (stored shape mismatch).
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: ['W1.L3-ts'],
    rows: [
      row({ caseId: 'W1.L3-ts', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-ts', oracle: 'O8', before: 'PASS', after: 'PASS', findingIds: ['O8_SEEDED_TEST_EXTENDED'] }),
    ],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /W1\.L3-ts\/attempt-1\/O8: O8 seeded pin violated \(stored PASS \[\] must replay PASS with O8_SEEDED_TEST_EXTENDED/);
});

test('verifyReplayInvariants flags a CNEV pin that flipped to PASS', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [
      row({ caseId: 'W1.L2-python', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-ts', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
    ],
  });
  assert.equal(verification.ok, false);
  assert.match(verification.violations.join('\n'), /W1\.L2-python\/attempt-1\/O1: CNEV pin violated/);
});

test('verifyReplayInvariants flags a missing pinned pair and an O8 seeded flip', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [
      row({ caseId: 'W1.L2-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      row({ caseId: 'W1.L3-python', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
      // W1.L3-ts/O1 pin pair absent entirely.
      row({ caseId: 'W3.01-bfmw-pi-python', oracle: 'O8', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O8_SEEDED_TEST_CHANGED'] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /W1\.L3-ts\/O1: pinned pair missing/);
  assert.match(joined, /W3\.01-bfmw-pi-python\/attempt-1\/O8: O8 seeded pin violated/);
});

test('campaign-#7 directories enforce every named pin strictly (missing pair = violation)', () => {
  const root = testRoot();
  try {
    const verification = replay.verifyReplayInvariants({
      rows: [row({ before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O1_DURATION_FLOOR_RATE'] })],
      campaignDir: path.join(root, 'campaign-20260813T123604986Z-anything'),
      campaignCaseIds: ['C1'],
    });
    assert.equal(verification.ok, false);
    const missing = verification.violations.filter((entry) => entry.includes('pinned pair missing'));
    assert.equal(missing.length, 8);
    const cnev = verification.checks.find((check) => check.label === 'cnev-pins');
    assert.deepEqual(cnev.skipped, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pinned case present in the campaign universe is enforced even without the campaign-#7 prefix', () => {
  const verification = replay.verifyReplayInvariants({
    rows: [row()],
    campaignDir: null,
    campaignCaseIds: ['W1.L2-python'],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /W1\.L2-python\/O1: pinned pair missing/);
  const cnev = verification.checks.find((check) => check.label === 'cnev-pins');
  assert.equal(cnev.violations.length, 1);
  assert.equal(cnev.skipped.length, 2);
  const o8 = verification.checks.find((check) => check.label === 'o8-seeded-pins');
  assert.equal(o8.violations.length, 0);
  assert.equal(o8.skipped.length, 5);
});

// ── RUNAWAY backing ──────────────────────────────────────────────────────────

function buildRunawayCampaign(root) {
  const campaign = path.join(root, 'campaign-runaway');
  fs.mkdirSync(campaign, { recursive: true });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');
  fs.writeFileSync(path.join(campaign, 'report.json'), `${JSON.stringify({
    version: 1,
    rows: [
      { id: 'RC1', outcome: 'PRODUCT_FAIL', findings: [{ type: 'RUNAWAY', cap: 'wall_min', run_id: 'run-1' }] },
      { id: 'RC2', outcome: 'PRODUCT_FAIL', findings: [{ type: 'RUNAWAY', cap: 'wall_min', run_id: 'run-2' }] },
      { id: 'RC3', outcome: 'PRODUCT_FAIL', findings: [{ type: 'ORACLE_FAIL', run_id: 'run-3' }] },
    ],
  }, null, 2)}\n`);
  return campaign;
}

test('readRunawayCases extracts the RUNAWAY case ids from the campaign report', () => {
  const root = testRoot();
  try {
    const campaign = buildRunawayCampaign(root);
    assert.deepEqual(replay.readRunawayCases(campaign), { present: true, cases: ['RC1', 'RC2'] });
    assert.deepEqual(replay.readRunawayCases(path.join(root, 'missing')), { present: false, cases: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyReplayInvariants requires every RUNAWAY case to keep a FAIL backing', () => {
  const root = testRoot();
  try {
    const campaign = buildRunawayCampaign(root);
    const good = replay.verifyReplayInvariants({
      campaignCaseIds: ['RC1', 'RC2'],
      rows: [
        row({ caseId: 'RC1', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
        row({ caseId: 'RC2', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
        row({ caseId: 'RC2', oracle: 'O9', before: 'ERROR', after: 'NOT_EVALUABLE', delta: 'flip', beforeFindingIds: ['ORACLE_RUNTIME_ERROR'] }),
      ],
      campaignDir: campaign,
    });
    assert.equal(good.ok, true, JSON.stringify(good.violations));
    assert.deepEqual(good.runawayCases, ['RC1', 'RC2']);

    const bad = replay.verifyReplayInvariants({
      campaignCaseIds: ['RC1', 'RC2'],
      rows: [
        row({ caseId: 'RC1', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['O1_DURATION_FLOOR_RATE'] }),
        row({ caseId: 'RC2', oracle: 'O9', before: 'ERROR', after: 'NOT_EVALUABLE', delta: 'flip', beforeFindingIds: ['ORACLE_RUNTIME_ERROR'] }),
      ],
      campaignDir: campaign,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.violations.join('\n'), /RC1: RUNAWAY case lost every FAIL verdict/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyReplayInvariants skips the RUNAWAY check when the campaign has no report.json', () => {
  const verification = replay.verifyReplayInvariants({ campaignCaseIds: ['C1'], rows: [row()], campaignDir: null });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const check = verification.checks.find((entry) => entry.label === 'runaway-backing');
  assert.equal(check.ok, true);
  assert.match(check.skipped, /no campaign report.json/);
});

test('verifyReplayInvariants skips a RUNAWAY case with no replay rows (W3.19, US-005)', () => {
  // W3.19-pause-drain died with TEST_INFRA_FAIL (probe action failed) before
  // any oracle evidence was captured — the campaign holds no replay pairs for
  // it, so there is nothing to mask: the RUNAWAY finding lives in the campaign
  // report and is untouched by the replay. The check notes it as skipped
  // instead of flagging a phantom FAIL-backing loss.
  const root = testRoot();
  try {
    const campaign = buildRunawayCampaign(root);
    const verification = replay.verifyReplayInvariants({
      campaignCaseIds: ['RC1', 'RC2', 'RC3'],
      rows: [
        row({ caseId: 'RC1', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['O1_TERMINAL_EVENT_MISSING'], findingIds: ['O1_TERMINAL_EVENT_MISSING'] }),
        // RC2 is a RUNAWAY case with NO replay rows at all.
      ],
      campaignDir: campaign,
    });
    // RC1 keeps FAIL backing; RC2 has no rows -> skipped, not a violation.
    assert.equal(verification.ok, true, JSON.stringify(verification.violations));
    const check = verification.checks.find((entry) => entry.label === 'runaway-backing');
    assert.equal(check.ok, true);
    assert.ok(check.skipped.some((entry) => entry.includes('RC2') && entry.includes('no replay rows')));
    assert.deepEqual(check.runawayCases, ['RC1', 'RC2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unparsable campaign report.json is an invariant violation', () => {
  const root = testRoot();
  try {
    const campaign = path.join(root, 'campaign-bad-report');
    fs.mkdirSync(campaign, { recursive: true });
    fs.writeFileSync(path.join(campaign, 'report.json'), '{not json');
    const verification = replay.verifyReplayInvariants({ campaignCaseIds: ['C1'], rows: [row()], campaignDir: campaign });
    assert.equal(verification.ok, false);
    assert.match(verification.violations.join('\n'), /report.json is not parsable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderInvariantReport renders the check statuses', () => {
  const verification = replay.verifyReplayInvariants({ rows: [row()], campaignDir: null, pins: { cnev: [], o8Seeded: [] } });
  const report = replay.renderInvariantReport(verification);
  assert.match(report, /\[OK\] honest-finding-preservation/);
  assert.match(report, /\[OK\] flip-transition-classes/);
  assert.match(report, /\[OK\] cnev-pins/);
  assert.match(report, /\[OK\] o8-seeded-pins/);
  assert.match(report, /runaway-backing/);
  assert.match(report, /invariants: OK/);
});

// ── end-to-end: --verify-invariants fails loudly on an honest flip ───────────

// Minimal single-pair campaign: honest O3z evidence (zero tokens) replayed
// against a stored FAIL verdict carrying a NON-scoped finding. The replay
// flips FAIL -> PASS, which must fail the invariant verification with exit 1.
function buildHonestFlipCampaign(root) {
  const campaign = path.join(root, 'campaign-honest-flip');
  fs.mkdirSync(campaign, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n');
  const caseId = 'C1';
  const snapshots = path.join(campaign, 'snapshots', caseId, 'attempt-1');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  const reference = (file) => ({
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(file)),
    captured_at: CAPTURED_AT,
    source: 'synthetic-invariant-fixture',
  });
  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, tokens_spent INTEGER NOT NULL);
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER NOT NULL);
    INSERT INTO tamandua_stats VALUES (1, 0);
  `);
  database.close();
  fs.chmodSync(databasePath, 0o400);
  const systemTokens = {
    schema_version: 1, captured_at: CAPTURED_AT, table_present: true,
    rows: [{ system_tokens_spent: 0 }], value: 0,
  };
  const writeSnapshot = (name, value) => {
    const file = path.join(snapshots, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
    return file;
  };
  const references = {
    ...Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null])),
    database_snapshot: reference(databasePath),
    system_tokens_before: reference(writeSnapshot('system-tokens-before.json', systemTokens)),
    system_tokens_after: reference(writeSnapshot('system-tokens-after.json', systemTokens)),
  };
  const oracleDir = path.join(campaign, 'evidence', caseId, 'attempt-1', 'oracles', 'O3z');
  fs.mkdirSync(oracleDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(oracleDir, 'context.json'), `${JSON.stringify({
    contract_version: 1,
    oracle_id: 'O3z',
    campaign: { id: 'campaign-20260813T123604986Z-honest-flip', created_at: CAPTURED_AT, manifest: { sha256: 'a'.repeat(64), case_count: 1, case_ids: ['C1'] } },
    case: {
      id: caseId, wave: 1, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic',
      harness: 'scripted-pi', class: 'verification',
      caps: { tokens: 100, wall_min: 10 }, boundary_files: [], forbidden: [], chaos: null,
    },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 1, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(oracleDir, 'stdout.json'), `${JSON.stringify({
    contract_version: 1, oracle_id: 'O3z',
    result: 'FAIL', started_at: CAPTURED_AT, finished_at: CAPTURED_AT,
    findings: [{ id: 'O3Z_SYSTEM_TOKENS_NONZERO', summary: 'stale stored verdict (replayed evidence is honest)' }],
    evidence: [],
  }, null, 2)}\n`);
  return campaign;
}

test('--verify-invariants exits 1 when an honest FAIL -> PASS flip occurs', () => {
  const root = testRoot();
  try {
    const campaign = buildHonestFlipCampaign(root);
    const jsonPath = path.join(root, 'replay.json');
    const result = spawnSync(process.execPath, [REPLAY_TOOL, '--campaign', campaign, '--workspace-root', path.join(root, 'ws'), '--verify-invariants', '--json', jsonPath], {
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /invariant report/);
    assert.match(result.stdout, /\[VIOLATION\] honest-finding-preservation/);
    assert.match(result.stdout, /\[VIOLATION\] flip-transition-classes/);
    assert.match(result.stderr, /invariant violation: C1\/attempt-1\/O3z: honest finding O3Z_SYSTEM_TOKENS_NONZERO vanished/);
    assert.match(result.stderr, /E3.B invariant verification FAILED/);

    const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(payload.invariants.ok, false);
    assert.deepEqual(payload.rows.map((entry) => [entry.caseId, entry.oracle, entry.before, entry.after, entry.delta, entry.beforeFindingIds]), [
      ['C1', 'O3z', 'FAIL', 'PASS', 'flip', ['O3Z_SYSTEM_TOKENS_NONZERO']],
    ]);
    assert.equal(payload.summary.flips, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--verify-invariants exits 0 when every pinned invariant holds', () => {
  const root = testRoot();
  try {
    const campaign = buildHonestFlipCampaign(root);
    // Replace the stored verdict with a scoped S5 finding so the FAIL -> PASS
    // flip is inside the allowed artifact classes.
    const stored = path.join(campaign, 'evidence', 'C1', 'attempt-1', 'oracles', 'O3z', 'stdout.json');
    fs.writeFileSync(stored, `${JSON.stringify({
      contract_version: 1, oracle_id: 'O3z',
      result: 'FAIL', started_at: CAPTURED_AT, finished_at: CAPTURED_AT,
      findings: [{ id: 'O1_DURATION_FLOOR_RATE', summary: 'scoped S5 artifact (stored stale)' }],
      evidence: [],
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [REPLAY_TOOL, '--campaign', campaign, '--workspace-root', path.join(root, 'ws'), '--verify-invariants'], {
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /\[OK\] honest-finding-preservation/);
    assert.match(result.stdout, /\[OK\] flip-transition-classes/);
    assert.match(result.stdout, /\[OK\] cnev-pins \(3 pin\(s\) skipped/);
    assert.match(result.stdout, /\[OK\] o8-seeded-pins \(5 pin\(s\) skipped/);
    assert.match(result.stdout, /invariants: OK/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── T2.2 US-003: preval campaign replay pin (O1 scripted exclusion) ─────────
//
// The tier2 preval campaign (campaign-20260825T233741033Z-577fa359-279b-4829-
// afe5-0367e535ba71) stored six O1_DURATION_FLOOR_RATE FAILs on scripted
// (0-token) wave-4 bug-fix-merge-worktree cells. US-002 excluded scripted runs
// from O1's duration-floor evaluation, so replaying the stored evidence with
// the fixed oracle flips EXACTLY those six FAILs to PASS (S5 scoped class)
// while every other verdict and finding is unchanged — including W4.23's
// honest LOCAL_SCENARIO_EVIDENCE_FAILED (a separate class repaired in US-004)
// and W4.39-a's absence (TEST_INFRA_FAIL, no oracle evidence captured).
//
// The pin has two layers:
//   1. a unit pin on verifyReplayInvariants over the exact preval delta rows
//      (always runs — no campaign files needed), and
//   2. an end-to-end pin that replays the REAL campaign with --verify-invariants
//      and asserts the exact 85-pair delta (skips when the read-only campaign
//      evidence is not present under torture-test/var/results — campaign
//      evidence is never committed to the repo).

const PREVAL_CAMPAIGN_NAME = 'campaign-20260825T233741033Z-577fa359-279b-4829-afe5-0367e535ba71';
const PREVAL_FLOOR_CELLS = [
  'W4.40-malformed-trailer', 'W4.40-oversized-stdout', 'W4.40-trailer-absent',
  'W4.41-all-tiers-fail', 'W4.41-login-shell-tier', 'W4.46-provider-error-rounds',
];

function prevalFloorFlipRow(caseId) {
  return row({
    caseId,
    oracle: 'O1',
    before: 'FAIL',
    after: 'PASS',
    delta: 'flip',
    beforeFindingIds: ['O1_DURATION_FLOOR_RATE'],
    findingIds: [],
  });
}

test('verifyReplayInvariants accepts the exact preval delta (six S5 O1 floor flips, zero other deltas)', () => {
  // The GREEN replay delta of the preval campaign: six S5 O1_DURATION_FLOOR_RATE
  // FAIL -> PASS flips on the scripted cells; W4.23's three honest
  // LOCAL_SCENARIO_EVIDENCE_FAILED FAILs survive unchanged; every other pair
  // is PASS -> PASS. The invariant verifier must accept it outright (ok: true,
  // zero violations) — this pins that the S5 class covers EXACTLY these flips
  // and that no honest verdict changed.
  const verification = replay.verifyReplayInvariants({
    campaignCaseIds: [...PREVAL_FLOOR_CELLS, 'W4.23-daemon-cross-runtime-restart', 'W4.04c-keyline-laundering', 'W4.40-delayed-trailer'],
    rows: [
      ...PREVAL_FLOOR_CELLS.map(prevalFloorFlipRow),
      row({ caseId: 'W4.23-daemon-cross-runtime-restart', oracle: 'O1', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'], findingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'] }),
      row({ caseId: 'W4.23-daemon-cross-runtime-restart', oracle: 'O11', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'], findingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'] }),
      row({ caseId: 'W4.23-daemon-cross-runtime-restart', oracle: 'O3z', before: 'FAIL', after: 'FAIL', beforeFindingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'], findingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'] }),
      row({ caseId: 'W4.04c-keyline-laundering', before: 'PASS', after: 'PASS' }),
      row({ caseId: 'W4.04c-keyline-laundering', oracle: 'O11', before: 'PASS', after: 'PASS' }),
      row({ caseId: 'W4.40-delayed-trailer', before: 'PASS', after: 'PASS' }),
      row({ caseId: 'W4.40-delayed-trailer', oracle: 'O9', before: 'PASS', after: 'PASS' }),
    ],
  });
  assert.equal(verification.ok, true, JSON.stringify(verification.violations));
  const classes = verification.checks.find((check) => check.label === 'flip-transition-classes');
  assert.equal(classes.violations.length, 0);
  const preservation = verification.checks.find((check) => check.label === 'honest-finding-preservation');
  assert.equal(preservation.violations.length, 0);
});

test('verifyReplayInvariants rejects an honest W4.23 LOCAL_SCENARIO_EVIDENCE_FAILED flip (zero other deltas is enforced)', () => {
  // Negative control for the preval pin: if the replay ever cleared W4.23's
  // honest O1 finding (US-004 repairs it later, so until then it MUST survive),
  // the delta would no longer be "six floor flips, zero other deltas" and the
  // invariant verifier must fail loudly.
  const verification = replay.verifyReplayInvariants({
    // Empty case universe: no campaign-seven pins apply, so the ONLY
    // violations are the vanished honest W4.23 findings.
    campaignCaseIds: [],
    rows: [
      ...PREVAL_FLOOR_CELLS.map(prevalFloorFlipRow),
      row({ caseId: 'W4.23-daemon-cross-runtime-restart', before: 'FAIL', after: 'PASS', delta: 'flip', beforeFindingIds: ['LOCAL_SCENARIO_EVIDENCE_FAILED', 'LOCAL_SCENARIO_EVIDENCE_FAILED'] }),
    ],
  });
  assert.equal(verification.ok, false);
  const joined = verification.violations.join('\n');
  assert.match(joined, /honest finding LOCAL_SCENARIO_EVIDENCE_FAILED vanished/);
  assert.match(joined, /FAIL -> PASS flip dropped non-scoped finding/);
});

function resolvePrevalCampaign() {
  if (process.env.TT_PREVAL_CAMPAIGN_DIR !== undefined && process.env.TT_PREVAL_CAMPAIGN_DIR.length > 0) {
    return path.resolve(process.env.TT_PREVAL_CAMPAIGN_DIR);
  }
  return path.join(VAR_ROOT, 'results', PREVAL_CAMPAIGN_NAME);
}

const PREVAL_CAMPAIGN = resolvePrevalCampaign();
const PREVAL_CAMPAIGN_PRESENT = fs.existsSync(path.join(PREVAL_CAMPAIGN, 'state.json'));

test('preval campaign replay pin: exactly six S5 O1 floor flips, zero other deltas, exit 0 under --verify-invariants', {
  skip: PREVAL_CAMPAIGN_PRESENT ? false : `preval campaign evidence not present (${PREVAL_CAMPAIGN}) — replay pin not applicable; copy it into torture-test/var/results/ or set TT_PREVAL_CAMPAIGN_DIR`,
}, () => {
  const campaign = PREVAL_CAMPAIGN;
  const root = testRoot();
  try {
    const digestBefore = replay.computeCampaignDigest(campaign);
    const jsonPath = path.join(root, 'preval-replay.json');
    const result = spawnSync(process.execPath, [REPLAY_TOOL, '--campaign', campaign, '--workspace-root', path.join(root, 'ws'), '--verify-invariants', '--json', jsonPath], {
      encoding: 'utf8',
      shell: false,
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /invariants: OK/);

    const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // Exact delta contract: 85 pairs, six FAIL -> PASS flips, 79 unchanged.
    assert.equal(payload.summary.pairs, 85, JSON.stringify(payload.summary));
    assert.equal(payload.summary.flips, 6, JSON.stringify(payload.summary));
    assert.equal(payload.summary.unchanged, 79, JSON.stringify(payload.summary));
    assert.equal(payload.summary.invoke_failures, 0, JSON.stringify(payload.summary));
    assert.equal(payload.summary.source_campaign_unchanged, true, JSON.stringify(payload.summary));

    // Every flip is one of the six scripted cells: O1 FAIL -> PASS carrying
    // ONLY the stored O1_DURATION_FLOOR_RATE (S5 scoped), replaying PASS with
    // no findings.
    const flips = payload.rows.filter((entry) => entry.delta === 'flip');
    assert.equal(flips.length, 6);
    for (const flip of flips) {
      assert.ok(PREVAL_FLOOR_CELLS.includes(flip.caseId), `unexpected flip case ${flip.caseId}`);
      assert.equal(flip.oracle, 'O1');
      assert.equal(flip.before, 'FAIL');
      assert.equal(flip.after, 'PASS');
      assert.deepEqual(flip.beforeFindingIds, ['O1_DURATION_FLOOR_RATE']);
      assert.deepEqual(flip.findingIds, []);
    }
    assert.deepEqual(flips.map((flip) => flip.caseId).sort(), [...PREVAL_FLOOR_CELLS].sort());

    // Every other row is unchanged: zero other deltas.
    const same = payload.rows.filter((entry) => entry.delta === 'same');
    assert.equal(same.length, 79);

    // W4.23's honest LOCAL_SCENARIO_EVIDENCE_FAILED survives on O1/O11/O3z
    // (repaired separately in US-004 — until then it must remain).
    const w423 = payload.rows.filter((entry) => entry.caseId === 'W4.23-daemon-cross-runtime-restart');
    assert.deepEqual(w423.map((entry) => [entry.oracle, entry.before, entry.after]), [
      ['O1', 'FAIL', 'FAIL'], ['O11', 'FAIL', 'FAIL'], ['O3z', 'FAIL', 'FAIL'],
    ]);
    assert.ok(w423.every((entry) => entry.findingIds.includes('LOCAL_SCENARIO_EVIDENCE_FAILED')));

    // W4.39-a (TEST_INFRA_FAIL) captured no oracle evidence: no replay rows.
    assert.ok(!payload.rows.some((entry) => entry.caseId === 'W4.39-a-union-honest'));

    // Invariants hold: S5 scoped flips only.
    assert.equal(payload.invariants.ok, true, JSON.stringify(payload.invariants.violations));

    // Source campaign byte-identical before/after the replay (the tool's own
    // digest check already enforces this; re-verify independently).
    assert.deepEqual(replay.computeCampaignDigest(campaign), digestBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
