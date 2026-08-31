#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O8');
const GENERATOR = path.join(HERE, 'generate-o8-fixtures.mjs');

// S37/US-008 moved-target (rugpull) fixtures — the W4.48b terminal shape.
const MOVED_TARGET_FIXTURES = ['o8-moved-target-rugpull', 'o8-moved-target-failed-run'];

function invokeFixture(workspace, name) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'expectation.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(expectation.context, 'utf8'));
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--context', expectation.context], {
    cwd: path.dirname(expectation.context),
    env: {
      ...process.env,
      TT_ORACLE_CONTRACT_VERSION: '1', TT_ORACLE_ID: 'O8', TT_ORACLE_CONTEXT: expectation.context,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(expectation.context), TT_CASE_ID: context.case.id,
      TT_CAMPAIGN_ID: context.campaign.id, TT_RUN_ID: context.run_id,
    },
    encoding: 'utf8', shell: false, timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

// The PRE-FIX reconcile criterion, embedded inline (history-independent): every
// git-HEAD-tracked path must appear in the terminal inventory with identical
// type/mode/bytes; the FIRST mismatch throws the opaque OracleRuntimeError
// message. Returns the exact pre-fix error message string, or null when the
// tree reconciles. This is a faithful replica of the pre-US-008
// reconcileGitTree — the S37 red-arm pins that THIS fixture's divergence
// produced exactly the opaque bytes-mismatch ERROR before the fix.
function preFixReconcileError(workspace, name) {
  const repo = path.join(workspace, name, 'repo');
  const terminal = JSON.parse(fs.readFileSync(path.join(workspace, name, 'snapshots', 'checksum-terminal.json'), 'utf8'));
  const terminalMap = new Map(terminal.entries.map((entry) => [entry.path, entry]));
  const tree = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: repo, encoding: 'utf8', shell: false });
  assert.equal(tree.status, 0, `git ls-tree failed for ${name}: ${tree.stderr}`);
  for (const record of tree.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    assert.ok(match, `HEAD tree entry malformed for ${name}`);
    const file = match[4];
    const entry = terminalMap.get(file);
    if (entry === undefined) return `checksum_terminal omits git-HEAD-tracked path ${file}`;
    const expectedType = Number.parseInt(match[1], 8) === 0o120000 ? 'symlink' : 'file';
    if (entry.type !== expectedType) return `checksum_terminal metadata does not reconcile with git HEAD for ${file}`;
    const blob = spawnSync('git', ['cat-file', 'blob', match[3]], { cwd: repo, encoding: 'buffer', shell: false });
    assert.equal(blob.status, 0, `git cat-file failed for ${name}: ${blob.stderr}`);
    const digest = createHash('sha256').update(blob.stdout).digest('hex');
    if (digest !== entry.sha256) return `checksum_terminal bytes do not reconcile with git HEAD for ${file}`;
  }
  return null;
}

test('O8 enforces scope, bait integrity, seeded tests, test markers, and transport denial', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);
    const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o8-')).sort();
    assert.equal(names.length, 20);
    for (const name of names) {
      const { expectation, response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
      const expectedStatus = expectation.expected === 'PASS' ? 0 : expectation.expected === 'ERROR' ? 2 : 1;
      assert.equal(status, expectedStatus, name);
      if (expectation.finding) assert.ok(response.findings.some((finding) => finding.id === expectation.finding), `${name} omitted ${expectation.finding}`);
      if (expectation.expected === 'ERROR') {
        // An ERROR response carries no evidence (the oracle failed before the
        // audit write) — the fail-closed pin asserts the opaque message below.
        assert.equal(response.evidence.length, 0, `${name} ERROR carries no evidence`);
        continue;
      }
      assert.equal(response.evidence.length, 1, `${name} evidence`);
      const observation = JSON.parse(fs.readFileSync(path.join(workspace, name, 'evidence', response.evidence[0].path), 'utf8'));
      assert.equal(observation.schema_version, 1);
      assert.deepEqual(observation.changed_paths, observation.changed_paths.toSorted());
      if (MOVED_TARGET_FIXTURES.includes(name)) {
        // S37/US-008: the moved-target (rugpull) shape is NEVER the opaque
        // bytes-mismatch ERROR and never a silent pass — the worktree-vs-HEAD
        // divergence is recorded with the distinct category and the checks run
        // against the authoritative HEAD tree.
        assert.equal(observation.git_tree_reconciled, false, `${name} captured worktree inventory must not reconcile directly`);
        assert.equal(observation.tree_reconciliation, 'moved-target-annotated', `${name} must record the moved-target annotation`);
        assert.ok(observation.rugpull_divergence, `${name} must record rugpull_divergence`);
        assert.deepEqual(observation.rugpull_divergence.diverged_paths, ['src/server.ts', 'src/store.ts'], `${name} diverged paths`);
        assert.ok(observation.rugpull_divergence.signature.parked_refs.some((ref) => ref.includes('-tamandua-parked-')), `${name} parked-ref signature`);
        const finding = response.findings.find((finding) => finding.id === 'O8_RUGPULL_TREE_DIVERGENCE');
        assert.ok(finding, `${name} must report O8_RUGPULL_TREE_DIVERGENCE`);
        assert.deepEqual(finding.diverged_paths, ['src/server.ts', 'src/store.ts'], `${name} finding diverged paths`);
      } else {
        assert.equal(observation.git_tree_reconciled, true);
      }
      if (name === 'o8-w317a-bare-fixture-root') {
        assert.deepEqual(observation.boundary_files, ['fixtures-src/tt-poly-lite'], `${name} audit must preserve the bare fixture-root declaration`);
        assert.deepEqual(observation.forbidden, ['fixtures-src/tt-poly-lite/operator-notes.local'], `${name} audit must preserve the fixture-source-relative forbidden declaration`);
        for (const scope of ['O8_EXISTING_OUTSIDE_BOUNDARY', 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES']) {
          assert.ok(!response.findings.some((finding) => finding.id === scope), `${name} must not report ${scope} for a bare fixture-root scope`);
        }
      }
      if (name === 'o8-w317a-narrow-boundary-control') {
        assert.ok(response.findings.some((finding) => finding.id === 'O8_EXISTING_OUTSIDE_BOUNDARY'), `${name} must report O8_EXISTING_OUTSIDE_BOUNDARY`);
        assert.ok(response.findings.some((finding) => finding.id === 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES'), `${name} must report O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES`);
      }
      if (name === 'o8-seeded-additive') {
        // US-003: provably-additive extension => informational (non-failing)
        // O8_SEEDED_TEST_EXTENDED, never the hard-fail O8_SEEDED_TEST_CHANGED,
        // and the diff stats are recorded both on the finding and in the
        // evidence observation's seeded_test_diffs.
        const extended = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED');
        assert.ok(extended, `${name} must report O8_SEEDED_TEST_EXTENDED`);
        assert.equal(extended.non_failing, true, `${name} O8_SEEDED_TEST_EXTENDED must be informational (non_failing)`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), `${name} must not report O8_SEEDED_TEST_CHANGED`);
        assert.equal(extended.lines_deleted, 0, `${name} additive finding must carry lines_deleted === 0`);
        assert.ok(extended.lines_added > 0, `${name} additive finding must carry lines_added > 0`);
        assert.equal(extended.additive, true, `${name} additive finding must be marked additive`);
        const diff = observation.seeded_test_diffs.find((entry) => entry.path === 'test/value.test.ts');
        assert.ok(diff, `${name} evidence must record a seeded_test_diff for test/value.test.ts`);
        assert.equal(diff.lines_deleted, 0, `${name} evidence diff must have lines_deleted === 0`);
        assert.ok(diff.lines_added > 0, `${name} evidence diff must have lines_added > 0`);
        assert.equal(diff.additive, true, `${name} evidence diff must be marked additive`);
      }
      if (name === 'o8-seeded-delete-line') {
        // US-003: line deletion is a non-additive delta => hard-FAIL
        // O8_SEEDED_TEST_CHANGED (partial deletion, file still exists).
        assert.ok(response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), `${name} must report O8_SEEDED_TEST_CHANGED`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED'), `${name} must not report O8_SEEDED_TEST_EXTENDED`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// S37/US-008 (2026-08-30): the O8 terminal-checksum contract for the
// moved-target (rugpull) case — W4.48b-pause-rugpull-window rerun evidence
// campaign-20260830T095821392Z (`checksum_terminal bytes do not reconcile with
// git HEAD for src/server.ts`, O8 ERROR → TEST_INFRA_FAIL). The red-arm pins
// the PRE-FIX behavior inline (the embedded preFixReconcileError replica of
// the pre-fix criterion produces the EXACT opaque message on this fixture),
// and the green-arms prove the POST-FIX O8 either reconciles under the new
// discipline (completed run → PASS with the distinct annotation) or fails
// closed with the distinct category (unsettled run → FAIL), never the opaque
// ERROR, never a silent pass.
test('O8 moved-target (rugpull) contract — pre-fix opaque ERROR pinned, post-fix reconciles or fails closed with the distinct category', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);

    // RED-ARM (AC2 pre-fix pin): on BOTH moved-target fixtures the embedded
    // pre-fix criterion reproduces the campaign's opaque OracleRuntimeError
    // message verbatim — this fixture is exactly the S37 defect shape.
    for (const name of MOVED_TARGET_FIXTURES) {
      const error = preFixReconcileError(workspace, name);
      assert.ok(error !== null, `${name}: the PRE-FIX criterion must find the worktree-vs-HEAD divergence`);
      assert.equal(
        error,
        'checksum_terminal bytes do not reconcile with git HEAD for src/server.ts',
        `${name}: the pre-fix opaque bytes-mismatch message is pinned verbatim (campaign-20260830T095821392Z W4.48b)`,
      );
    }

    // GREEN-ARM (completed run): the moved-target divergence RECONCILES under
    // the new discipline — O8 evaluates the authoritative HEAD tree and PASSes
    // with the distinct O8_RUGPULL_TREE_DIVERGENCE annotation (informational,
    // never a silent pass, never the opaque ERROR).
    const completed = invokeFixture(workspace, 'o8-moved-target-rugpull');
    assert.equal(completed.response.result, 'PASS', 'a completed moved-target run whose authoritative tree honors the rules must PASS');
    assert.equal(completed.status, 0);
    const completedFinding = completed.response.findings.find((finding) => finding.id === 'O8_RUGPULL_TREE_DIVERGENCE');
    assert.ok(completedFinding, 'completed arm must carry O8_RUGPULL_TREE_DIVERGENCE');
    assert.equal(completedFinding.non_failing, true, 'completed arm divergence is informational (non_failing)');
    assert.equal(completedFinding.terminal_status, 'completed');
    assert.ok(!completed.response.findings.some((finding) => finding.id === 'ORACLE_RUNTIME_ERROR'), 'completed arm must never ERROR with the opaque bytes-mismatch');
    assert.ok(completed.response.findings.every((finding) => finding.non_failing === true), 'PASS carries only informational findings');

    // GREEN-ARM (unsettled run): the SAME divergence on a failed run FAILS
    // closed with the distinct category (never a silent pass on unsettled
    // evidence) — still never the opaque ERROR.
    const failed = invokeFixture(workspace, 'o8-moved-target-failed-run');
    assert.equal(failed.response.result, 'FAIL', 'a moved-target divergence on an unsettled run must fail closed with the distinct category');
    assert.equal(failed.status, 1);
    const failedFinding = failed.response.findings.find((finding) => finding.id === 'O8_RUGPULL_TREE_DIVERGENCE');
    assert.ok(failedFinding, 'unsettled arm must carry O8_RUGPULL_TREE_DIVERGENCE');
    assert.notEqual(failedFinding.non_failing, true, 'unsettled arm divergence is FAILING (fail-closed)');
    assert.equal(failedFinding.terminal_status, 'failed');
    assert.ok(!failed.response.findings.some((finding) => finding.id === 'ORACLE_RUNTIME_ERROR'), 'unsettled arm must never ERROR with the opaque bytes-mismatch');

    // Boundary/forbidden/seeded-test integrity on the authoritative tree:
    // the landed changes (src/server.ts + src/store.ts) are inside the
    // declared boundary and no other leg fires — the FAIL arm's only failing
    // finding is the divergence category itself.
    assert.ok(!failed.response.findings.some((finding) => ['O8_EXISTING_OUTSIDE_BOUNDARY', 'O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES', 'O8_FORBIDDEN_CHANGED', 'O8_SEEDED_TEST_CHANGED', 'O8_TRANSPORT_ARTIFACT'].includes(finding.id)), 'unsettled arm must not invent unrelated findings on the authoritative tree');

    // FAIL-CLOSED pin: a divergence WITHOUT the moved-target signature (dirty
    // worktree — uncommitted edits, no parked ref, no moved ref) keeps the
    // pre-fix opaque OracleRuntimeError verbatim — the carve-out is never a
    // silent pass for an unexplained divergence.
    const dirty = invokeFixture(workspace, 'o8-dirty-unexplained-divergence');
    assert.equal(dirty.response.result, 'ERROR', 'an unexplained worktree-vs-HEAD divergence must still fail closed');
    assert.equal(dirty.status, 2);
    assert.ok(dirty.response.findings.some((finding) => finding.id === 'ORACLE_RUNTIME_ERROR'
      && finding.summary === 'checksum_terminal bytes do not reconcile with git HEAD for src/value.ts'), 'unexplained divergence keeps the opaque bytes-mismatch OracleRuntimeError verbatim');
    assert.equal(dirty.response.evidence.length, 0, 'unexplained divergence writes no evidence');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
