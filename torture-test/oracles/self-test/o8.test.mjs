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
// S48 (US-006): the shared context-aware extractor the oracle rebuild leg,
// the capture side and the fixture generator all use. S52 (US-007): the
// focus-marker counter and the same-name-shadowing analyzer the oracle's
// content legs use.
const { countTestMarkers, countFocusMarkers } = await import('../lib/test-markers.mjs');
const { duplicateTestDefinitionNames } = await import('../lib/test-definitions.mjs');

// S37/US-008 moved-target (rugpull) fixtures — the W4.48b terminal shape.
// S48/US-006 adds o8-moved-target-marker-prose: the SAME moved-target shape
// with an additive landed change on the seeded src/server.test.ts whose
// prose contains the W4.17-a phrase 'skipped 07-31' — the O8 rebuild leg
// recomputes test markers from the authoritative HEAD blob via
// countTestMarkers (prose must not count).
const MOVED_TARGET_FIXTURES = ['o8-moved-target-rugpull', 'o8-moved-target-failed-run', 'o8-moved-target-marker-prose'];
// Per-fixture expected diverged_paths (path-sorted): the tracked paths whose
// stale-worktree capture differs from the authoritative git HEAD tree.
const MOVED_TARGET_DIVERGED = {
  'o8-moved-target-rugpull': ['src/server.ts', 'src/store.ts'],
  'o8-moved-target-failed-run': ['src/server.ts', 'src/store.ts'],
  'o8-moved-target-marker-prose': ['src/server.test.ts', 'src/server.ts', 'src/store.ts'],
};

// S48 (US-006): the PRE-FIX whole-text marker counting (W4.17-a defect),
// replicated inline (history-independent — never resolved from git): the
// checksum inventories counted /\bskip(?:ped)?\b/, /\btodo\b/, /\bxfail\b/
// over the FULL test file bytes, so prose/docstring content inflated counts.
function legacyWholeTextMarkers(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  return {
    skip: (text.match(/\bskip(?:ped)?\b/giu) ?? []).length,
    todo: (text.match(/\btodo\b/giu) ?? []).length,
    xfail: (text.match(/\bxfail\b/giu) ?? []).length,
  };
}

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
    assert.equal(names.length, 40);
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
        assert.deepEqual(observation.rugpull_divergence.diverged_paths, MOVED_TARGET_DIVERGED[name], `${name} diverged paths`);
        assert.ok(observation.rugpull_divergence.signature.parked_refs.some((ref) => ref.includes('-tamandua-parked-')), `${name} parked-ref signature`);
        const finding = response.findings.find((finding) => finding.id === 'O8_RUGPULL_TREE_DIVERGENCE');
        assert.ok(finding, `${name} must report O8_RUGPULL_TREE_DIVERGENCE`);
        assert.deepEqual(finding.diverged_paths, MOVED_TARGET_DIVERGED[name], `${name} finding diverged paths`);
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
      // S48 (US-006): marker extraction must ignore prose/comments/docstrings
      // and the seeded-test leg must be preserved for additive prose-only
      // extensions. The inventory markers themselves are asserted in the
      // dedicated S48 test below; here we pin the ORACLE verdicts + the
      // informational EXTENDED leg end-to-end.
      if (name === 'o8-marker-prose-comment' || name === 'o8-marker-prose-docstring') {
        assert.equal(response.result, 'PASS', `${name} prose-only additive extension must PASS`);
        const extended = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED');
        assert.ok(extended, `${name} must report the informational O8_SEEDED_TEST_EXTENDED`);
        assert.equal(extended.non_failing, true, `${name} O8_SEEDED_TEST_EXTENDED must be informational`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), `${name} must not report O8_SEEDED_TEST_CHANGED`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED'), `${name} prose/docstring must not trip O8_TEST_MARKER_INTRODUCED`);
      }
      if (name === 'o8-marker-python-skipif' || name === 'o8-marker-python-xfail') {
        // AC2: REAL decorator-level markers still count and still raise the
        // hard-FAIL O8_TEST_MARKER_INTRODUCED on introduction.
        assert.equal(response.result, 'FAIL', `${name} a real decorator marker must FAIL the changed seeded test`);
        const marker = response.findings.find((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED');
        assert.ok(marker, `${name} must report O8_TEST_MARKER_INTRODUCED`);
        assert.equal(marker.marker, name.endsWith('skipif') ? 'skip' : 'xfail', `${name} marker bucket`);
        assert.equal(marker.observed, 1, `${name} observed marker count`);
      }
      if (name === 'o8-moved-target-marker-prose') {
        // S48 on the O8 rebuild leg: the authoritative HEAD tree carries an
        // additive prose comment mentioning 'skipped 07-31' on the seeded
        // test — the rebuild must NOT count it (PASS with only informational
        // annotations) while the seeded additive extension is preserved.
        assert.equal(response.result, 'PASS', `${name} prose-only landed change on a moved target must PASS`);
        assert.ok(response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED'), `${name} must report O8_SEEDED_TEST_EXTENDED`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED'), `${name} rebuild must not count prose markers`);
        const diff = observation.seeded_test_diffs.find((entry) => entry.path === 'src/server.test.ts');
        assert.ok(diff && diff.additive, `${name} evidence must record the additive seeded diff for src/server.test.ts`);
      }
      // S52 (US-007): the seeded-test smuggling gaps. Every fixture's delta is
      // deliberately ADDITIVE (or a new under-test-dir file), so the PRE-fix
      // oracle could only PASS — the red-arm is pinned in the dedicated S52
      // test below and in the run progress log. Here the POST-fix oracle must
      // FAIL each with its distinct mechanical finding.
      if (name === 'o8-focus-marker-additive' || name === 'o8-focus-marker-new-test-file') {
        assert.equal(response.result, 'FAIL', `${name} a focus marker must FAIL`);
        const focus = response.findings.find((finding) => finding.id === 'O8_TEST_FOCUS_INTRODUCED');
        assert.ok(focus, `${name} must report O8_TEST_FOCUS_INTRODUCED`);
        assert.equal(focus.marker, 'focus', `${name} focus marker bucket`);
        assert.ok(focus.observed >= 1, `${name} observed focus count`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED'), `${name} focus is not a skip/todo/xfail marker`);
      }
      if (name === 'o8-focus-marker-additive') {
        // The additive carve-out still fires (informational) alongside the new
        // hard finding — the smuggling vector is exactly an additive delta.
        const extended = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED');
        assert.ok(extended && extended.non_failing === true, `${name} additive delta keeps the informational O8_SEEDED_TEST_EXTENDED`);
      }
      if (name === 'o8-shadowing-python-duplicate' || name === 'o8-shadowing-ts-duplicate') {
        assert.equal(response.result, 'FAIL', `${name} a same-name duplicate definition must FAIL`);
        const shadow = response.findings.find((finding) => finding.id === 'O8_TEST_SHADOWING');
        assert.ok(shadow, `${name} must report O8_TEST_SHADOWING`);
        assert.ok(shadow.names.includes('test_value') || shadow.names.includes('value'), `${name} shadowed name recorded (${JSON.stringify(shadow.names)})`);
        const extended = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED');
        assert.ok(extended && extended.non_failing === true, `${name} the additive delta still records the informational O8_SEEDED_TEST_EXTENDED`);
      }
      if (name === 'o8-adjacent-conftest-new' || name === 'o8-adjacent-setup-tests-new' || name === 'o8-adjacent-jest-config-new') {
        assert.equal(response.result, 'FAIL', `${name} a new seeded-test-adjacent file must FAIL`);
        const adjacent = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_ADJACENT_INTRODUCED');
        assert.ok(adjacent, `${name} must report O8_SEEDED_TEST_ADJACENT_INTRODUCED`);
        const expectedKind = name === 'o8-adjacent-conftest-new' ? 'conftest.py' : name === 'o8-adjacent-setup-tests-new' ? 'setupTests*' : 'jest.config*';
        assert.equal(adjacent.kind, expectedKind, `${name} adjacent kind`);
      }
      // S60 (US-008): whitespace-insensitive modified classification. The
      // gofmt-realigned seeded test (o8-gofmt-realign-additive) and the
      // W4.17 red-test whitespace-only realignment (o8-w417-red-ws-only) are
      // additive under the ws-insensitive compare -> informational
      // O8_SEEDED_TEST_EXTENDED, oracle PASS. The realignment-PLUS-content
      // fixtures (o8-gofmt-realign-weaken, o8-w417-red-weaken) stay hard-FAIL
      // O8_SEEDED_TEST_CHANGED even ws-insensitively (no weakening). The
      // evidence records the ws-insensitive stats plus the byte-level stats
      // when they differ (the byte pin is never erased).
      if (name === 'o8-gofmt-realign-additive' || name === 'o8-w417-red-ws-only') {
        assert.equal(response.result, 'PASS', `${name} ws-insensitive additive delta must PASS`);
        const extended = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED');
        assert.ok(extended && extended.non_failing === true, `${name} must report the informational O8_SEEDED_TEST_EXTENDED`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), `${name} must not report O8_SEEDED_TEST_CHANGED`);
        assert.equal(extended.additive, true, `${name} additive flag`);
        assert.equal(extended.lines_deleted, 0, `${name} ws-insensitive lines_deleted must be 0`);
        assert.ok(extended.byte_level, `${name} must record the byte-level stats (byte pin kept)`);
        assert.equal(extended.byte_level.additive, false, `${name} byte-level compare must be non-additive (realignment-only)`);
        const diff = observation.seeded_test_diffs.find((entry) => entry.path === extended.path);
        assert.ok(diff, `${name} evidence must record the seeded diff`);
        assert.equal(diff.additive, true, `${name} evidence diff additive`);
        assert.ok(diff.byte_level, `${name} evidence diff must carry byte_level`);
      }
      if (name === 'o8-gofmt-realign-weaken' || name === 'o8-w417-red-weaken') {
        assert.equal(response.result, 'FAIL', `${name} real content change must FAIL even ws-insensitively`);
        const changed = response.findings.find((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED');
        assert.ok(changed, `${name} must report O8_SEEDED_TEST_CHANGED`);
        assert.equal(changed.additive, false, `${name} genuine content change is non-additive`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED'), `${name} must not report the informational O8_SEEDED_TEST_EXTENDED`);
      }
      // OMCX (US-006 retry, 2026-09-05): the shared JS marker extractor must
      // enforce lexical marker contexts. o8-omcx-benign-lexical-context lands
      // marker-SHAPED but non-executable content (regex literal spelling a
      // focus shape; a `skip:` label in the callback body): post-fix it is not
      // a marker, so the oracle PASSes with the informational EXTENDED and no
      // O8_TEST_MARKER_INTRODUCED / O8_TEST_FOCUS_INTRODUCED.
      // o8-omcx-quoted-skip-marker introduces a REAL quoted option key
      // `{ 'skip': true }`: post-fix countTestMarkers counts it (skip 1) and
      // the oracle hard-FAILs with O8_TEST_MARKER_INTRODUCED.
      // o8-omcx-benign-control-regex (08a9933a follow-up) opens its new body
      // with CONTROL-statement regex literals that spell marker shapes
      // (`if (enabled) /test.only(example)/.test(text);` + a `while` variant):
      // a slash after an if/while header close is a regex, never division, so
      // post-fix the oracle PASSes with the informational EXTENDED.
      // o8-omcx-divided-skip-registration (08a9933a follow-up) registers a
      // REAL skip inside a postfix-division expression: the slash after the
      // postfix `--` is division, countTestMarkers sees the chain (skip 1)
      // and the oracle hard-FAILs with O8_TEST_MARKER_INTRODUCED.
      if (name === 'o8-omcx-benign-lexical-context' || name === 'o8-omcx-benign-control-regex') {
        assert.equal(response.result, 'PASS', `${name} marker-shaped but non-executable JS content must PASS`);
        assert.ok(response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED' && finding.non_failing === true), `${name} must report the informational O8_SEEDED_TEST_EXTENDED`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED'), `${name} regex-literal/label content is not a marker`);
        assert.ok(!response.findings.some((finding) => finding.id === 'O8_TEST_FOCUS_INTRODUCED'), `${name} regex-literal/label content is not a focus marker`);
      }
      if (name === 'o8-omcx-quoted-skip-marker' || name === 'o8-omcx-divided-skip-registration') {
        assert.equal(response.result, 'FAIL', `${name} a real skip marker must FAIL`);
        const marker = response.findings.find((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED');
        assert.ok(marker, `${name} must report O8_TEST_MARKER_INTRODUCED`);
        assert.equal(marker.marker, 'skip', `${name} marker bucket`);
        assert.equal(marker.observed, 1, `${name} observed marker count`);
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

    // RED-ARM (AC2 pre-fix pin): on every moved-target fixture the embedded
    // pre-fix criterion reproduces the campaign's opaque OracleRuntimeError
    // message verbatim — this fixture is exactly the S37 defect shape. The
    // first path in git ls-tree order that diverges names the message: the
    // plain fixtures land only src/server.ts/src/store.ts, while
    // o8-moved-target-marker-prose ALSO lands an additive change on
    // src/server.test.ts (sorted before src/server.ts).
    const movedReconcileMessages = {
      'o8-moved-target-rugpull': 'checksum_terminal bytes do not reconcile with git HEAD for src/server.ts',
      'o8-moved-target-failed-run': 'checksum_terminal bytes do not reconcile with git HEAD for src/server.ts',
      'o8-moved-target-marker-prose': 'checksum_terminal bytes do not reconcile with git HEAD for src/server.test.ts',
    };
    for (const name of MOVED_TARGET_FIXTURES) {
      const error = preFixReconcileError(workspace, name);
      assert.ok(error !== null, `${name}: the PRE-FIX criterion must find the worktree-vs-HEAD divergence`);
      assert.equal(
        error,
        movedReconcileMessages[name],
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

// S48 (US-006, 2026-09-03): O8 marker extraction counts skip/todo/xfail ONLY
// in test-definition/decorator contexts — never in prose/docstrings/comments.
// The defect (W4.17-a): checksum inventories applied whole-text word regexes
// (/\bskip(?:ped)?\b/gi …) over the FULL test file bytes, so a docstring
// saying 'skipped 07-31' (a date) inflated the skip count and tripped
// O8_TEST_MARKER_INTRODUCED on a legitimately additive change.
//
//   * RED-ARM (pre-fix pin): the embedded legacyWholeTextMarkers replica
//     reproduces the inflated counts on every S48 prose fixture (skip >= 1
//     over baseline 0 → the pre-fix capture would have FAILED the fixture),
//     while countTestMarkers (the post-fix shared extractor) returns 0 and
//     the recorded inventory markers are {0,0,0} — the fixture is exactly
//     the S48 defect shape (history-independent: never resolved from git).
//   * GREEN-ARM: every prose-only additive fixture evaluates PASS through the
//     O8 oracle with the informational O8_SEEDED_TEST_EXTENDED leg intact
//     (already asserted in the main loop; re-asserted here for the record).
//   * AC2: real decorator-level markers still count — @pytest.mark.skipif /
//     @pytest.mark.xfail / test.skip still raise O8_TEST_MARKER_INTRODUCED.
//   * AC3: the seeded-test leg is unchanged — additive prose extensions keep
//     O8_SEEDED_TEST_EXTENDED (informational), non-additive deltas keep the
//     hard-FAIL O8_SEEDED_TEST_CHANGED (pinned by o8-seeded-change /
//     o8-seeded-delete / o8-seeded-delete-line above).
test('O8 marker extraction ignores prose/docstrings/comments (S48) — red-arm pinned, green-arm PASS, real decorators still counted', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);

    const terminalTestFile = (name, pathInRepo) => {
      // Non-moved fixtures commit the terminal tree at HEAD; the moved-target
      // fixture keeps the STALE baseline bytes in the worktree, so read the
      // authoritative HEAD blob (what the O8 rebuild leg actually counts).
      const repo = path.join(workspace, name, 'repo');
      const blob = spawnSync('git', ['show', `HEAD:${pathInRepo}`], { cwd: repo, encoding: 'buffer', shell: false });
      assert.equal(blob.status, 0, `${name}: git show HEAD:${pathInRepo} failed`);
      return blob.stdout;
    };
    const inventoryMarkers = (name, pathInRepo) => {
      const terminal = JSON.parse(fs.readFileSync(path.join(workspace, name, 'snapshots', 'checksum-terminal.json'), 'utf8'));
      return terminal.entries.find((entry) => entry.path === pathInRepo).test_markers;
    };

    // RED-ARM: on every S48 prose fixture the PRE-FIX whole-text counting
    // inflated the skip count over the baseline (skip >= 1 > 0) while the
    // POST-FIX shared extractor records 0 — and the generator's inventory
    // (what O8 consumes) carries {0,0,0} (the green evidence). The pre-fix
    // capture would therefore have tripped O8_TEST_MARKER_INTRODUCED (FAIL);
    // the post-fix inventory cannot.
    const proseFixtures = [
      ['o8-marker-prose-comment', 'test/value.test.ts'],
      ['o8-marker-prose-docstring', 'tests/test_value.py'],
      ['o8-moved-target-marker-prose', 'src/server.test.ts'],
    ];
    for (const [name, pathInRepo] of proseFixtures) {
      const bytes = terminalTestFile(name, pathInRepo);
      const legacy = legacyWholeTextMarkers(bytes);
      assert.ok(legacy.skip >= 1, `${name}: the PRE-FIX whole-text counting must inflate skip on the 'skipped 07-31' prose (got ${JSON.stringify(legacy)})`);
      assert.deepEqual(countTestMarkers(pathInRepo, bytes), { skip: 0, todo: 0, xfail: 0 }, `${name}: post-fix context-aware counting must ignore prose`);
      assert.deepEqual(inventoryMarkers(name, pathInRepo), { skip: 0, todo: 0, xfail: 0 }, `${name}: the generator inventory must carry zero markers for prose-only content`);
      // GREEN-ARM (through the oracle binary — also asserted in the main loop).
      const { response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, 'PASS', `${name}: prose-only additive extension must PASS through O8`);
      assert.equal(status, 0, `${name}`);
    }

    // AC2: REAL decorator-level / definition markers still count and still
    // raise O8_TEST_MARKER_INTRODUCED — both in the generator inventory and
    // through the oracle binary.
    const realMarkerFixtures = [
      ['o8-new-skip-marker', 'test/value.test.ts', { skip: 1, todo: 0, xfail: 0 }, 'skip'],
      ['o8-marker-python-skipif', 'tests/test_value.py', { skip: 1, todo: 0, xfail: 0 }, 'skip'],
      ['o8-marker-python-xfail', 'tests/test_value.py', { skip: 0, todo: 0, xfail: 1 }, 'xfail'],
    ];
    for (const [name, pathInRepo, expected, marker] of realMarkerFixtures) {
      assert.deepEqual(inventoryMarkers(name, pathInRepo), expected, `${name}: the real ${marker} marker must be counted in the inventory`);
      const { response, status } = invokeFixture(workspace, name);
      assert.equal(response.result, 'FAIL', `${name}: introducing a real ${marker} marker must FAIL`);
      assert.equal(status, 1, `${name}`);
      assert.ok(response.findings.some((finding) => finding.id === 'O8_TEST_MARKER_INTRODUCED' && finding.marker === marker), `${name}: O8_TEST_MARKER_INTRODUCED (${marker})`);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// S48 (US-006) — unit-level contract of the shared extractor
// (oracles/lib/test-markers.mjs): anchored test-definition/decorator markers
// count; prose/docstrings/comments/string content never do.
test('O8 countTestMarkers counts only test-definition/decorator contexts (unit)', () => {
  const expect = (file, content, expected, label) => {
    assert.deepEqual(countTestMarkers(file, content), expected, label);
  };
  // Prose/docstrings/comments/strings must not count ('skipped 07-31' shape).
  expect('tests/test_value.py', '"""Added 07-31; the corridor was skipped in W4.17-a."""\ndef test_value():\n    assert 1\n', { skip: 0, todo: 0, xfail: 0 }, 'python module docstring prose');
  expect('tests/test_value.py', '# skipped 07-31 — prose comment\ndef test_value():\n    assert 1\n', { skip: 0, todo: 0, xfail: 0 }, 'python line comment prose');
  expect('tests/test_value.py', 'skipped = True\ndef test_value():\n    assert not skipped\n', { skip: 0, todo: 0, xfail: 0 }, 'bare python identifiers are not markers');
  expect('test/value.test.ts', 'test("value", () => assert.ok(true));\n// TODO: expand later (prose)\ntest("x", () => {});\n', { skip: 0, todo: 0, xfail: 0 }, 'ts line comment prose');
  expect('test/value.test.ts', '/* call test.skip() to skip a case */\ntest("x", () => {});\n', { skip: 0, todo: 0, xfail: 0 }, 'ts block comment with decorator-shaped prose');
  expect('tests/test_value.py', '"""Use @pytest.mark.skip to skip, @pytest.mark.xfail for xfail."""\ndef test_value():\n    assert 1\n', { skip: 0, todo: 0, xfail: 0 }, 'python docstring example of decorator syntax');
  expect('test/value.test.ts', 'const s = "skipped 07-31 in the mac campaign";\n', { skip: 0, todo: 0, xfail: 0 }, 'string literal prose');
  expect('tests/test_value.py', 'def test_value():\n    reason = "todo: later"\n    assert 1\n', { skip: 0, todo: 0, xfail: 0 }, 'string literal todo prose');
  // Real decorator-level markers still count.
  expect('tests/test_value.py', '@pytest.mark.skip(reason="x")\ndef test_value():\n    assert 1\n', { skip: 1, todo: 0, xfail: 0 }, 'pytest.mark.skip decorator');
  expect('tests/test_value.py', '@pytest.mark.skipif(sys.version < (3, 9), reason="x")\ndef test_value():\n    assert 1\n', { skip: 1, todo: 0, xfail: 0 }, 'pytest.mark.skipif decorator');
  expect('tests/test_value.py', '@pytest.mark.xfail(reason="known")\ndef test_value():\n    assert 1\n', { skip: 0, todo: 0, xfail: 1 }, 'pytest.mark.xfail decorator');
  expect('tests/test_value.py', '@unittest.skipUnless(has_net, "why")\ndef test_value():\n    assert 1\n', { skip: 1, todo: 0, xfail: 0 }, 'unittest.skipUnless decorator');
  expect('tests/test_value.py', 'def test_value():\n    pytest.skip("needs network")\n', { skip: 1, todo: 0, xfail: 0 }, 'runtime pytest.skip call');
  expect('tests/test_value.py', 'def test_value(self):\n    self.skipTest("env")\n', { skip: 1, todo: 0, xfail: 0 }, 'runtime self.skipTest call');
  // JS/TS registration chains and object options.
  expect('test/value.test.ts', 'test.skip("value", () => {});\n', { skip: 1, todo: 0, xfail: 0 }, 'test.skip chain');
  expect('test/value.test.ts', 'describe.skip("suite", () => {});\nit.todo("pending", () => {});\n', { skip: 1, todo: 1, xfail: 0 }, 'describe.skip + it.todo chains');
  expect('test/value.test.ts', 'it("value", { skip: true }, () => {});\n', { skip: 1, todo: 0, xfail: 0 }, 'node:test object-option skip');
  expect('test/value.test.ts', 'describe("suite", () => {\n  it("inner", { skip: "env" }, () => {});\n});\n', { skip: 1, todo: 0, xfail: 0 }, 'nested object-option skip counted once');
  expect('test/value.test.ts', 'describe("a", () => {\n  it("b", { todo: true }, () => {});\n});\nconst cfg = { skip: true };\n', { skip: 0, todo: 1, xfail: 0 }, 'option key outside a registration is not an option of one');
  // Go runtime skips.
  expect('pool_test.go', 'func TestPool(t *testing.T) {\n    t.Skipf("needs env")\n}\n', { skip: 1, todo: 0, xfail: 0 }, 'go t.Skipf');
  expect('pool_test.go', 'func TestPool(t *testing.T) {\n    t.Skip("needs env")\n}\n', { skip: 1, todo: 0, xfail: 0 }, 'go t.Skip');
});

// OMCX (US-006 retry, 2026-09-05): the shared O8 marker extractor's JS
// lexical contexts. The independent review pinned FIVE miscounts in the
// pre-fix masked-text extractor (source 11de76f6, hash a3dff862… —
// marker-context-evidence.jsonl in var/review-logs/r4a-signal-guard-T7yG5O):
//   * arrow-body labels (`() => { skip: for(;;){} }`) were counted as
//     registration option keys (skip 1 / focus 1) — a block/label is not an
//     option object;
//   * quoted option keys (`{ 'skip': true }`, `{ 'only': true }`) were
//     invisible after string masking (0 instead of 1);
//   * regex-literal contents (`/test.only(example)/`) matched the focus chain
//     regex (1 instead of 0).
// GREEN-ARM here: the ACTUAL shared extractor must return the corrected
// counts on every review sample. RED-ARM is pinned by the recorded pre-fix
// actuals below (each differs where the review said it did) plus the
// fixture-backed oracle cases o8-omcx-* in the main loop.
//
// FOLLOW-UP (08a9933a review, 2026-09-05T04:07:59Z — marker-slash evidence in
// var/review-logs/r4a-signal-guard-T7yG5O): the token lexer still gave the
// slash two wrong contexts:
//   * a `/` after a CONTROL-CONDITION close paren (`if (enabled) /regex/...`)
//     was lexed as division, so the regex literal's contents were scanned as
//     code and `/test.only(example)/`-style marker shapes counted (focus 1 /
//     skip 1) — closing an if/while header does NOT end an expression, the
//     construct after it is a statement, which may start with a regex literal;
//   * a `/` after a POSTFIX `++`/`--` (`n++ / test.only(...)`) was lexed as a
//     regex-literal opener, swallowing the division's right operand — a real
//     divided registration was missed (focus 0 / skip 0). The postfix
//     increment ends the left-hand expression, so the `/` is division.
// FOLLOW-UP (f9c2b0dd consolidation, 2026-09-05T04:22:44Z —
// marker-slash-operands evidence): the '/' rule's identifier branch
// lowercased ANY identifier and matched it against the regex-prefix set, so
// an identifier OPERAND that merely SPELLS a keyword — `RETURN` (a case
// variant), a declared contextual `of`, member property `holder.return` —
// opened a regex literal and swallowed the division's real right operand
// (focus 0 / skip 0). Only a GENUINE keyword in keyword position opens a
// regex literal; the three real divided registrations must now count
// (focus 1 / skip 1 / focus 1) and the genuine `typeof /re/` regex control
// stays opaque (focus 0).
test('O8 shared JS marker extractor lexical contexts (OMCX) — corrected counts on every review sample', () => {
  // Recorded PRE-FIX actuals from the retained review evidence (same inputs;
  // source test-markers.mjs 11de76f6). The corrected extractor must differ on
  // exactly the five flagged samples and agree on the three controls.
  const preFixActuals = [
    { name: 'direct_skip_control', skip: 1, focus: 0 },
    { name: 'direct_focus_control', skip: 0, focus: 1 },
    { name: 'comment_string_control', skip: 0, focus: 0 },
    { name: 'arrow_body_label_not_skip_option', skip: 1, focus: 0 },
    { name: 'arrow_body_label_not_focus_option', skip: 0, focus: 1 },
    { name: 'quoted_skip_option', skip: 0, focus: 0 },
    { name: 'quoted_focus_option', skip: 0, focus: 0 },
    { name: 'regex_literal_not_registration', skip: 0, focus: 1 },
  ];
  const cases = [
    { name: 'direct_skip_control', text: "test.skip('disabled', () => {});", skip: 1, focus: 0 },
    { name: 'direct_focus_control', text: "test.only('focused', () => {});", skip: 0, focus: 1 },
    { name: 'comment_string_control', text: "// test.skip('example')\nconst example = \"test.only('example')\";\ntest('ordinary', () => {});", skip: 0, focus: 0 },
    { name: 'arrow_body_label_not_skip_option', text: "test('ordinary', () => { skip: for (;;) { break skip; } });", skip: 0, focus: 0 },
    { name: 'arrow_body_label_not_focus_option', text: "test('ordinary', () => { only: for (;;) { break only; } });", skip: 0, focus: 0 },
    { name: 'quoted_skip_option', text: "test('disabled', { 'skip': true }, () => {});", skip: 1, focus: 0 },
    { name: 'quoted_focus_option', text: "test('focused', { 'only': true }, () => {});", skip: 0, focus: 1 },
    { name: 'regex_literal_not_registration', text: "const example = /test.only(example)/;\ntest('ordinary', () => {});", skip: 0, focus: 0 },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const markers = countTestMarkers('example.test.js', c.text);
    const focus = countFocusMarkers('example.test.js', c.text);
    assert.equal(markers.skip, c.skip, `countTestMarkers skip: ${c.name}`);
    assert.equal(focus, c.focus, `countFocusMarkers: ${c.name}`);
    const old = preFixActuals[i];
    assert.equal(old.name, c.name, 'pre-fix actual table order');
    const changedSkip = old.skip !== c.skip;
    const changedFocus = old.focus !== c.focus;
    const reviewFlagged = ['arrow_body_label_not_skip_option', 'arrow_body_label_not_focus_option', 'quoted_skip_option', 'quoted_focus_option', 'regex_literal_not_registration'].includes(c.name);
    if (reviewFlagged) {
      assert.ok(changedSkip || changedFocus, `OMCX sample ${c.name} must differ from the pre-fix actual`);
    } else {
      assert.equal(changedSkip && changedFocus, false, `control ${c.name} must keep the pre-fix counts`);
    }
  }

  // FOLLOW-UP slash-context controls (08a9933a review). Recorded pre-fix
  // actuals (module 08a9933a, hash fde1dab3… — marker-slash evidence) — the
  // corrected extractor must differ on all four; each new expected count is
  // asserted against the ACTUAL shared extractor below.
  const slashPreFixActuals = [
    { name: 'if_control_cond_regex_benign', skip: 0, focus: 1 },
    { name: 'while_control_cond_regex_benign', skip: 1, focus: 0 },
    { name: 'divided_focus_registration_postfix', skip: 0, focus: 0 },
    { name: 'divided_skip_registration_postfix', skip: 0, focus: 0 },
  ];
  const slashCases = [
    { name: 'if_control_cond_regex_benign', text: "if (enabled) /test.only(example)/.test(text);", skip: 0, focus: 0 },
    { name: 'while_control_cond_regex_benign', text: "while (enabled) /test.skip(example)/.test(text);", skip: 0, focus: 0 },
    { name: 'divided_focus_registration_postfix', text: "let n = 8; const ratio = n++ / test.only('focus', () => {}) / 2;", skip: 0, focus: 1 },
    { name: 'divided_skip_registration_postfix', text: "let n = 8; const ratio = n-- / test.skip('skip', () => {}) / 2;", skip: 1, focus: 0 },
  ];
  for (let i = 0; i < slashCases.length; i += 1) {
    const c = slashCases[i];
    const markers = countTestMarkers('example.test.js', c.text);
    const focus = countFocusMarkers('example.test.js', c.text);
    assert.equal(markers.skip, c.skip, `countTestMarkers skip: ${c.name}`);
    assert.equal(focus, c.focus, `countFocusMarkers: ${c.name}`);
    const old = slashPreFixActuals[i];
    assert.equal(old.name, c.name, 'slash pre-fix actual table order');
    assert.ok(old.skip !== c.skip || old.focus !== c.focus, `slash-control ${c.name} must differ from the 08a9933a actual (${JSON.stringify(old)})`);
  }

  // FOLLOW-UP operand-preservation controls (f9c2b0dd consolidation). The
  // three signed-task unit controls sit in this SAME gate, alongside the
  // four slash cases above and the original eight samples. Recorded PRE-fix
  // actuals (module be5d72e0, hash 437aac6a… — marker-slash-operands
  // evidence): each identifier operand was swallowed as regex contents, so
  // the division's real registration was missed (RETURN focus 0, declared-
  // `of` skip 0, member `holder.return` focus 0). A genuine `typeof /re/`
  // regex control is correctly opaque and must STAY 0.
  const operandPreFixActuals = [
    { name: 'divided_focus_uppercase_identifier', skip: 0, focus: 0 },
    { name: 'divided_skip_declared_of_identifier', skip: 0, focus: 0 },
    { name: 'divided_focus_member_keyword_property', skip: 0, focus: 0 },
    { name: 'typeof_genuine_regex_opaque_control', skip: 0, focus: 0 },
  ];
  const operandCases = [
    { name: 'divided_focus_uppercase_identifier', text: "const RETURN = 8; const ratio = RETURN / test.only('focus', () => {}) / 2;", skip: 0, focus: 1 },
    { name: 'divided_skip_declared_of_identifier', text: "const of = 8; const ratio = of / test.skip('skip', () => {}) / 2;", skip: 1, focus: 0 },
    { name: 'divided_focus_member_keyword_property', text: "const holder = { return: 8 }; const ratio = holder.return / test.only('focus', () => {}) / 2;", skip: 0, focus: 1 },
    { name: 'typeof_genuine_regex_opaque_control', text: "const kind = typeof /test.only(example)/;", skip: 0, focus: 0 },
  ];
  for (let i = 0; i < operandCases.length; i += 1) {
    const c = operandCases[i];
    const markers = countTestMarkers('example.test.js', c.text);
    const focus = countFocusMarkers('example.test.js', c.text);
    assert.equal(markers.skip, c.skip, `countTestMarkers skip: ${c.name}`);
    assert.equal(focus, c.focus, `countFocusMarkers: ${c.name}`);
    const old = operandPreFixActuals[i];
    assert.equal(old.name, c.name, 'operand pre-fix actual table order');
    const flagged = i < operandCases.length - 1;
    assert.equal(
      old.skip !== c.skip || old.focus !== c.focus,
      flagged,
      `operand control ${c.name} must ${flagged ? 'differ from the be5d72e0 actual (an identifier operand divides, so the real registration counts)' : 'keep the be5d72e0 count (a genuine keyword regex stays opaque)'} (old ${JSON.stringify(old)})`,
    );
  }
  // FOLLOW-UP for-header separator contexts (7d9573d2 review,
  // 2026-09-05T05:05Z — marker-for-context evidence). The f9c2b0dd `of` rule
  // opened an operand only when the ENTIRE paren stack was exactly ['for'], so
  // three for-header positions miscounted:
  //   * a genuine for-of header NESTED inside another open paren
  //     (`(function () { for (const item of /test.only(example)/… })` —
  //     e.g. an IIFE) was not recognised as a for-of header, so the regex
  //     ITERABLE (`/test.only(example)/.exec(text) ?? []`) was scanned as
  //     code: focus 1 at 7d9573d2 (be5d72e0 returned focus 0) — a regression;
  //   * the `for await (` header was not recognised as a for-of header at all
  //     (the '(' follows `await`, not `for`): skip 1 at 7d9573d2 (be5d72e0
  //     returned skip 0) — a regression;
  //   * an `of` that is an ordinary DECLARED variable / clause operand inside
  //     a classic `for (;;)` (`for (let of = 8; of / test.only('focus', () =>
  //     {}) / 2; of--)`) was still treated as the separator, so the division's
  //     real registration was swallowed: focus 0 in BOTH versions.
  // The corrected rule: `of` opens an operand ONLY in the for-of / for-await-of
  // SEPARATOR slot — parenStack top is the 'for' header (ANY nesting depth),
  // and the token directly before `of` is the end of the loop-variable
  // binding (a non-keyword identifier, or `]`/`}` closing a destructuring
  // pattern). These three unit controls sit in this SAME gate, and the
  // top-level / non-header preservation arms are asserted right below.
  const forHeaderPreFixActuals = [
    { name: 'nested_for_of_header_regex_opaque', skip: 0, focus: 1 },
    { name: 'for_await_header_regex_opaque', skip: 1, focus: 0 },
    { name: 'classic_for_declared_of_operand_division', skip: 0, focus: 0 },
    { name: 'top_level_for_of_header_regex_opaque_control', skip: 0, focus: 0 },
  ];
  const forHeaderCases = [
    { name: 'nested_for_of_header_regex_opaque', text: "(function () { for (const item of /test.only(example)/.exec(text) ?? []) {} });", skip: 0, focus: 0 },
    { name: 'for_await_header_regex_opaque', text: "async function sample() { for await (const item of /test.skip(example)/.exec(text) ?? []) {} }", skip: 0, focus: 0 },
    { name: 'classic_for_declared_of_operand_division', text: "for (let of = 8; of / test.only('focus', () => {}) / 2; of--) {}", skip: 0, focus: 1 },
    { name: 'top_level_for_of_header_regex_opaque_control', text: "for (const item of /test.only(example)/.exec(text) ?? []) {}", skip: 0, focus: 0 },
  ];
  for (let i = 0; i < forHeaderCases.length; i += 1) {
    const c = forHeaderCases[i];
    const markers = countTestMarkers('example.test.js', c.text);
    const focus = countFocusMarkers('example.test.js', c.text);
    assert.equal(markers.skip, c.skip, `countTestMarkers skip: ${c.name}`);
    assert.equal(focus, c.focus, `countFocusMarkers: ${c.name}`);
    const old = forHeaderPreFixActuals[i];
    assert.equal(old.name, c.name, 'for-header pre-fix actual table order');
    const changed = old.skip !== c.skip || old.focus !== c.focus;
    const isReviewControl = i < 3;
    assert.equal(
      changed,
      isReviewControl,
      `for-header case ${c.name} must ${isReviewControl ? 'differ from the 7d9573d2 actual (nested/for-await for-of headers open their regex iterable; a classic-for declared-`of` operand divides)' : 'keep the 7d9573d2 count (top-level genuine for-of regex opacity is preserved)'} (old ${JSON.stringify(old)})`,
    );
  }
  // FOLLOW-UP of-binding role (fc303847 review, 2026-09-05T06:17Z —
  // marker-of-binding-fc303847 evidence): the binding-end discriminator
  // rejected the preceding binding identifier merely because its SPELLING is
  // in JS_REGEX_AFTER, although that occurrence of `of` is NOT a keyword. In
  // `for (var of of /test.only(example)/.exec(text) ?? []) {}` the first `of`
  // is the DECLARED loop variable (its name is the contextual word `of` — the
  // only JS_REGEX_AFTER member that may legally be an identifier) and the
  // second is the genuine for-of separator: the regex ITERABLE is opaque, so
  // there is NO focused registration. focus was 1 at fc303847 (the new
  // discriminator treated the fresh binding `of` as a keyword operand) and 0
  // at the earlier 7d9573d2 — a regression. A fresh `of` directly before the
  // separator is therefore a binding END (declared `for (var of of …)` or a
  // reference binding `for (of of …)`); every OTHER fresh regex-after keyword
  // (`typeof of`, `return of` — reserved words) is an operand in keyword
  // position, and the current `of` is not the separator. The regular `item`
  // binding opacity control and the classic-for declared-`of` division control
  // are preserved. These unit controls sit in this SAME gate.
  const ofBindingPreFixActuals = [
    { name: 'for_of_binding_named_of_regex_opaque', skip: 0, focus: 1 },
    { name: 'regular_binding_regex_opaque_control', skip: 0, focus: 0 },
    { name: 'classic_for_of_operand_division_control', skip: 0, focus: 1 },
  ];
  const ofBindingCases = [
    { name: 'for_of_binding_named_of_regex_opaque', text: "for (var of of /test.only(example)/.exec(text) ?? []) {}", skip: 0, focus: 0 },
    { name: 'regular_binding_regex_opaque_control', text: "for (const item of /test.only(example)/.exec(text) ?? []) {}", skip: 0, focus: 0 },
    { name: 'classic_for_of_operand_division_control', text: "for (let of = 8; of / test.only('focus', () => {}) / 2; of--) {}", skip: 0, focus: 1 },
  ];
  for (let i = 0; i < ofBindingCases.length; i += 1) {
    const c = ofBindingCases[i];
    const markers = countTestMarkers('example.test.js', c.text);
    const focus = countFocusMarkers('example.test.js', c.text);
    assert.equal(markers.skip, c.skip, `countTestMarkers skip: ${c.name}`);
    assert.equal(focus, c.focus, `countFocusMarkers: ${c.name}`);
    const old = ofBindingPreFixActuals[i];
    assert.equal(old.name, c.name, 'of-binding pre-fix actual table order');
    const changed = old.skip !== c.skip || old.focus !== c.focus;
    assert.equal(
      changed,
      i === 0,
      `of-binding case ${c.name} must ${i === 0 ? 'differ from the fc303847 actual (a fresh binding named `of` before the separator is a binding end — the regex iterable stays opaque)' : 'keep the fc303847 count (regular binding regex opacity / classic-for declared-`of` division)'} (old ${JSON.stringify(old)})`,
    );
  }
  // The fixture-backed oracle cases (main loop) assert PASS for
  // o8-omcx-benign-lexical-context (marker-shaped non-executable JS content),
  // FAIL + O8_TEST_MARKER_INTRODUCED for o8-omcx-quoted-skip-marker, PASS for
  // o8-omcx-benign-control-regex (regex literal after an if/while header) and
  // FAIL + O8_TEST_MARKER_INTRODUCED for o8-omcx-divided-skip-registration
  // (real skip inside a postfix-division expression).
});

// S52 (US-007, 2026-09-03): the seeded-test smuggling gaps — focus markers,
// same-name shadowing and seeded-test-adjacent run-control files. Each gap is
// red pre-fix (the smuggling delta sailed through the S19 additive carve-out /
// under-test-dir auto-allow with PASS) and green post-fix (O8 fails it with a
// distinct mechanical finding). The RED-ARM is pinned two ways:
//   * history-independent replicas below of every PRE-fix leg that could have
//     fired on these fixtures: the skip/todo/xfail marker leg (countTestMarkers
//     — unchanged by S52) sees NO marker delta on the focus/shadow fixtures,
//     and the pre-fix boundary/new-file legs saw NO outside-boundary violation
//     on the adjacent fixtures (their new files sit under a test directory), so
//     the pre-fix oracle had no trigger and could only PASS. The actual
//     pre-fix oracle run (git archive of the pre-change commit) on all seven
//     fixtures evaluated PASS — recorded in the run progress log.
//   * the GREEN-ARM fixture loop above evaluates the same seven fixtures
//     through the POST-fix oracle and asserts the distinct findings.
test('O8 closes the seeded-test smuggling gaps (S52) — red-arm pinned, green-arm distinct findings', () => {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);

    const repoBlob = (name, pathInRepo, rev) => {
      const repo = path.join(workspace, name, 'repo');
      const blob = spawnSync('git', ['show', `${rev}:${pathInRepo}`], { cwd: repo, encoding: 'buffer', shell: false });
      assert.equal(blob.status, 0, `${name}: git show ${rev}:${pathInRepo} failed`);
      return blob.stdout;
    };
    const baselineRev = (name) => {
      const repo = path.join(workspace, name, 'repo');
      const rev = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf8', shell: false });
      assert.equal(rev.status, 0, `${name}: git rev-list failed`);
      return rev.stdout.trim();
    };

    // ── RED-ARM replicas ──────────────────────────────────────────────────
    // Focus + shadow fixtures: the PRE-fix oracle's only test-content legs
    // were the skip/todo/xfail marker leg (inventory counts) and the
    // additive carve-out. The marker counts are unchanged between baseline
    // and terminal on every focus/shadow fixture (the smuggled content adds
    // no skip/todo/xfail marker), so the pre-fix marker leg could not fire —
    // and the additive carve-out PASSed the pure-insertion delta (the
    // pre-fix oracle run recorded PASS + O8_SEEDED_TEST_EXTENDED).
    const markerNeutralFixtures = [
      ['o8-focus-marker-additive', 'test/value.test.ts'],
      ['o8-shadowing-python-duplicate', 'tests/test_value.py'],
      ['o8-shadowing-ts-duplicate', 'test/value.test.ts'],
    ];
    for (const [name, pathInRepo] of markerNeutralFixtures) {
      const baseline = repoBlob(name, pathInRepo, baselineRev(name));
      const terminal = repoBlob(name, pathInRepo, 'HEAD');
      assert.deepEqual(
        countTestMarkers(pathInRepo, terminal),
        countTestMarkers(pathInRepo, baseline),
        `${name}: the smuggling delta is marker-neutral (no pre-fix O8_TEST_MARKER_INTRODUCED trigger)`,
      );
      assert.notEqual(baseline.toString('utf8'), terminal.toString('utf8'), `${name}: the seeded test content DID change`);
    }
    // Adjacent fixtures: the PRE-fix boundary legs could not fire either —
    // the new file is a NEW path under a test directory, which the pre-fix
    // oracle auto-allowed (O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES fires only for
    // new paths outside the boundary AND outside test directories). The
    // pre-fix oracle run recorded PASS with zero findings.
    for (const [name, pathInRepo] of [['o8-adjacent-conftest-new', 'tests/conftest.py'], ['o8-adjacent-setup-tests-new', 'test/setupTests.ts'], ['o8-adjacent-jest-config-new', 'test/jest.config.js']]) {
      const terminal = JSON.parse(fs.readFileSync(path.join(workspace, name, 'snapshots', 'checksum-terminal.json'), 'utf8'));
      const entry = terminal.entries.find((candidate) => candidate.path === pathInRepo);
      assert.ok(entry, `${name}: the adjacent file is inventoried`);
      const baseline = JSON.parse(fs.readFileSync(path.join(workspace, name, 'snapshots', 'checksum-baseline.json'), 'utf8'));
      assert.ok(!baseline.entries.some((candidate) => candidate.path === pathInRepo), `${name}: the adjacent file is NEW (absent from baseline)`);
      const testDir = pathInRepo.split('/').slice(0, -1).some((part) => ['test', 'tests', '__tests__'].includes(part.toLowerCase()));
      assert.ok(testDir, `${name}: the new file sits under a test directory (pre-fix auto-allow trigger)`);
    }

    // ── GREEN-ARM (through the oracle binary, asserted per-fixture above) ──
    // Re-assert the distinct finding ids and their mechanical detail so the
    // dedicated test stands alone if the main loop changes.
    const focus = invokeFixture(workspace, 'o8-focus-marker-additive');
    assert.equal(focus.response.result, 'FAIL');
    assert.ok(focus.response.findings.some((finding) => finding.id === 'O8_TEST_FOCUS_INTRODUCED' && finding.marker === 'focus' && finding.observed === 1 && finding.expected_max === 0), 'focus additive: O8_TEST_FOCUS_INTRODUCED {marker:focus, observed:1, expected_max:0}');
    const shadow = invokeFixture(workspace, 'o8-shadowing-ts-duplicate');
    assert.equal(shadow.response.result, 'FAIL');
    assert.ok(shadow.response.findings.some((finding) => finding.id === 'O8_TEST_SHADOWING' && finding.names.includes('value')), 'ts shadow: O8_TEST_SHADOWING names [value]');
    const adjacent = invokeFixture(workspace, 'o8-adjacent-conftest-new');
    assert.equal(adjacent.response.result, 'FAIL');
    assert.ok(adjacent.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_ADJACENT_INTRODUCED' && finding.kind === 'conftest.py' && finding.path === 'tests/conftest.py'), 'conftest adjacent: O8_SEEDED_TEST_ADJACENT_INTRODUCED kind conftest.py');
    const jestConfig = invokeFixture(workspace, 'o8-adjacent-jest-config-new');
    assert.equal(jestConfig.response.result, 'FAIL');
    assert.ok(jestConfig.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_ADJACENT_INTRODUCED' && finding.kind === 'jest.config*' && finding.path === 'test/jest.config.js'), 'jest config adjacent: O8_SEEDED_TEST_ADJACENT_INTRODUCED kind jest.config*');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// S52 (US-007) — unit contract of the focus-marker counter and the
// same-name-shadowing analyzer (oracles/lib/test-markers.mjs countFocusMarkers,
// oracles/lib/test-definitions.mjs duplicateTestDefinitionNames).
test('O8 focus-marker counting and same-name shadowing analysis (unit)', () => {
  // countFocusMarkers: anchored suite-focusing constructs count; prose and
  // non-js families never do.
  const focusCases = [
    ['test/value.test.ts', 'test("a", () => {});\ntest.only("b", () => {});\n', 1, 'test.only chain'],
    ['test/value.test.ts', 'it.only("a", () => {});\ndescribe.only("s", () => {});\n', 2, 'it.only + describe.only chains'],
    ['test/value.test.ts', 'fit("a", () => {});\nfdescribe("s", () => {});\n', 2, 'bare fit/fdescribe'],
    ['test/value.test.ts', 'it("x", { only: true }, () => {});\n', 1, 'node:test object-option only'],
    ['test/value.test.ts', 'it("x", { skip: true }, () => {});\n', 0, 'a skip option is not focus'],
    ['test/value.test.ts', '// test.only("commented", () => {});\ntest("a", () => {});\n', 0, 'comment prose masked'],
    ['test/value.test.ts', 'const s = "describe.only(\'x\')";\ntest("a", () => {});\n', 0, 'string literal prose masked'],
    ['test/value.test.ts', 'const o = { only: true };\ntest("a", () => {});\n', 0, 'module-level object key is not a registration option'],
    ['test/value.test.ts', 'it("a", () => {\n  const cfg = { only: true };\n});\n', 0, 'option key inside a test body is not an option of the registration'],
    ['tests/test_value.py', 'def test_x():\n    pass\n', 0, 'python has no focus registrar'],
    ['pool_test.go', 'func TestX(t *testing.T) {\n    t.Skip("x")\n}\n', 0, 'go has no focus registrar'],
  ];
  for (const [file, content, expected, label] of focusCases) {
    assert.equal(countFocusMarkers(file, content), expected, `countFocusMarkers: ${label}`);
  }

  // duplicateTestDefinitionNames: python + js/ts scope-aware same-name
  // shadowing; masking first; other families empty.
  const shadowCases = [
    ['tests/test_value.py', 'def test_value():\n    assert 1\n\ndef test_value():\n    assert 2\n', [{ scope: 'module', name: 'test_value', count: 2 }], 'python module-level duplicate'],
    ['tests/test_value.py', 'class TestA:\n    def test_go(self):\n        assert 1\n\nclass TestA:\n    def test_go(self):\n        assert 2\n', [{ scope: 'module', name: 'TestA', count: 2 }, { scope: 'class:TestA', name: 'test_go', count: 2 }], 'python duplicate class + duplicate method'],
    ['tests/test_value.py', 'class TestA:\n    def test_go(self):\n        assert 1\n    def test_go(self):\n        assert 2\n', [{ scope: 'class:TestA', name: 'test_go', count: 2 }], 'python duplicate method in one class'],
    ['tests/test_value.py', 'class TestA:\n    def test_go(self):\n        assert 1\n\nclass TestB:\n    def test_go(self):\n        assert 2\n', [], 'python same method name across classes is NOT shadowing'],
    ['tests/test_value.py', '"""Example:\n\ndef test_value():\n    assert 1\n"""\n\ndef test_value():\n    assert 1\n', [], 'python docstring example is masked'],
    ['test/value.test.ts', 'test("value", () => {});\ntest("value", () => {});\n', [{ scope: '', name: 'value', count: 2 }], 'js same top-level scope duplicate'],
    ['test/value.test.ts', "describe('suite-a', () => {\n  it('x', () => {});\n  it('x', () => {});\n});\n", [{ scope: '', name: 'x', count: 2 }], 'js duplicate within one describe'],
    ['test/value.test.ts', "describe('suite-a', () => { it('x', () => {}); });\ndescribe('suite-b', () => { it('x', () => {}); });\n", [], 'js same name in sibling describes is NOT shadowing (the real tt-ts server.test.ts shape)'],
    ['test/value.test.ts', "describe('a', () => { it('nested', () => {});\ndescribe('b', () => { it('nested', () => {}); }); });\n", [], 'js same name at different suite depths is NOT shadowing'],
    ['test/value.test.ts', '// test("value", () => {});\ntest("real", () => {});\n', [], 'js comment text is masked'],
    ['pool_test.go', 'func TestX(t *testing.T) {}\nfunc TestX(t *testing.T) {}\n', [], 'go duplicate names are compile errors — no shadowing model'],
  ];
  for (const [file, content, expected, label] of shadowCases) {
    const got = duplicateTestDefinitionNames(file, content);
    // Scope keys carry absolute positions for js; compare (name, count) sets.
    const normalized = got.map(({ name, count }) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const want = expected.map(({ name, count }) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    assert.deepEqual(normalized, want, `duplicateTestDefinitionNames: ${label} (full: ${JSON.stringify(got)})`);
  }
  // Scope keys are POSITION-based for js (deterministic per file), so sibling
  // suites never collide even with identical titles.
  const sibling = duplicateTestDefinitionNames('test/value.test.ts', "describe('same', () => { it('x', () => {}); });\ndescribe('same', () => { it('x', () => {}); });\n");
  assert.deepEqual(sibling, [], 'js sibling describes with the same title stay distinct scopes');
});

// S60 (US-008, 2026-09-03): O8's additive/modified classification ignores
// whitespace-only line changes (formatter realignment: gofmt, prettier, black)
// — modified/deleted is classified on a whitespace-insensitive compare, so the
// W4.06-colleague-rebase defect shape (gofmt column realignment of a struct in
// pool_test.go scored O8_SEEDED_TEST_CHANGED even though `git diff -w` shows
// +84 additive only) now reads additive. This test:
//   * RED-ARM (history-independent replica): the PRE-fix byte-level
//     lineDiffStats replica (the S19 exact-line compare) reads the gofmt
//     realignment fixture's delta as NON-additive (the realigned Host/Port
//     lines are byte-different -> delete+add -> pre-fix O8 would have emitted
//     the hard-FAIL O8_SEEDED_TEST_CHANGED); the whitespace-insensitive
//     replica (same algorithm, ws-collapsed line equality) reads it additive.
//   * GREEN-ARM (through the oracle binary, per-fixture assertions in the main
//     loop): the same fixtures evaluate PASS with the informational
//     O8_SEEDED_TEST_EXTENDED, and the realignment-PLUS-content-change control
//     fixtures stay hard-FAIL O8_SEEDED_TEST_CHANGED (no weakening).
test('O8 whitespace-insensitive modified classification (S60) — byte-level red-arm pinned, ws-insensitive green-arm', () => {
  // PRE-fix replica: exact-line LCS additivity (the pre-S60 criterion).
  const byteAdditive = (baseline, terminal) => {
    const bl = baseline.toString('utf8').split('\n');
    const tl = terminal.toString('utf8').split('\n');
    const dp = Array.from({ length: bl.length + 1 }, () => new Uint32Array(tl.length + 1));
    for (let i = bl.length - 1; i >= 0; i -= 1) {
      for (let j = tl.length - 1; j >= 0; j -= 1) {
        dp[i][j] = bl[i] === tl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    return dp[0][0] === bl.length;
  };
  // POST-fix replica: ws-collapsed equality (git diff -w semantics).
  const wsAdditive = (baseline, terminal) => {
    const key = (line) => line.replace(/\s+/g, '');
    const bl = baseline.toString('utf8').split('\n').map(key);
    const tl = terminal.toString('utf8').split('\n').map(key);
    const dp = Array.from({ length: bl.length + 1 }, () => new Uint32Array(tl.length + 1));
    for (let i = bl.length - 1; i >= 0; i -= 1) {
      for (let j = tl.length - 1; j >= 0; j -= 1) {
        dp[i][j] = bl[i] === tl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    return dp[0][0] === bl.length;
  };

  fs.mkdirSync(VAR_ROOT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(VAR_ROOT, 'oracle-self-test.'));
  try {
    const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
    assert.equal(generated.status, 0, generated.stderr);

    const repo = (name) => path.join(workspace, name, 'repo');
    const blobAt = (name, pathInRepo, rev) => {
      const out = spawnSync('git', ['show', `${rev}:${pathInRepo}`], { cwd: repo(name), encoding: 'buffer', shell: false });
      assert.equal(out.status, 0, `${name}: git show ${rev}:${pathInRepo}`);
      return out.stdout;
    };
    const rootRev = (name) => {
      const out = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo(name), encoding: 'utf8', shell: false });
      assert.equal(out.status, 0, `${name}: rev-list`);
      return out.stdout.trim();
    };
    // W4.06 defect shape: pool_test.go baseline vs gofmt-realigned terminal
    // (Host/Port column padding changed) + an appended feature test. The
    // byte-level replica reads NON-additive (realigned lines are byte-
    // different -> pre-fix CHANGED hard-FAIL); the ws replica reads additive.
    const baselineGo = blobAt('o8-gofmt-realign-additive', 'src/pool_test.go', rootRev('o8-gofmt-realign-additive'));
    const terminalGo = blobAt('o8-gofmt-realign-additive', 'src/pool_test.go', 'HEAD');
    assert.equal(byteAdditive(baselineGo, terminalGo), false, 'RED-ARM: byte-level (pre-fix) compare must read the gofmt realignment as NON-additive');
    assert.equal(wsAdditive(baselineGo, terminalGo), true, 'GREEN-ARM replica: ws-insensitive compare must read the gofmt realignment + feature test as additive');
    // W4.17 red-test declaration shape: whitespace-only operator-spacing
    // change on the planted red test. Byte-level reads NON-additive (pre-fix
    // CHANGED); ws reads additive (informational, never FAIL).
    const baselineRed = blobAt('o8-w417-red-ws-only', 'tests/test_pre_existing_red_a.py', rootRev('o8-w417-red-ws-only'));
    const terminalRed = blobAt('o8-w417-red-ws-only', 'tests/test_pre_existing_red_a.py', 'HEAD');
    assert.equal(byteAdditive(baselineRed, terminalRed), false, 'RED-ARM: byte-level (pre-fix) compare must read the ws-only red-test realignment as NON-additive');
    assert.equal(wsAdditive(baselineRed, terminalRed), true, 'GREEN-ARM replica: ws-insensitive compare must read the ws-only realignment as additive');
    // No-weakening control: the realign-PLUS-content fixtures stay non-additive
    // under BOTH compares (a real content change is never hidden by the ws
    // tolerance).
    const weakenGo = blobAt('o8-gofmt-realign-weaken', 'src/pool_test.go', 'HEAD');
    const weakenRed = blobAt('o8-w417-red-weaken', 'tests/test_pre_existing_red_a.py', 'HEAD');
    assert.equal(byteAdditive(baselineGo, weakenGo), false, 'control: realign + content change is byte-level non-additive');
    assert.equal(wsAdditive(baselineGo, weakenGo), false, 'control: realign + content change is ws-insensitive non-additive (no weakening)');
    assert.equal(wsAdditive(baselineRed, weakenRed), false, 'control: weakened red test is ws-insensitive non-additive (no weakening)');

    // GREEN-ARM through the oracle binary (the main loop already asserts the
    // PASS/FAIL verdicts per fixture; re-assert the two headline fixtures so
    // this test stands alone).
    const gofmt = invokeFixture(workspace, 'o8-gofmt-realign-additive');
    assert.equal(gofmt.response.result, 'PASS');
    assert.ok(gofmt.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED' && finding.non_failing === true && finding.additive === true && finding.lines_deleted === 0), 'gofmt realign + feature test: O8_SEEDED_TEST_EXTENDED additive, PASS');
    const wsOnly = invokeFixture(workspace, 'o8-w417-red-ws-only');
    assert.equal(wsOnly.response.result, 'PASS');
    assert.ok(wsOnly.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_EXTENDED' && finding.non_failing === true), 'ws-only red test: informational only, never FAIL');
    assert.ok(!wsOnly.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), 'ws-only red test: no O8_SEEDED_TEST_CHANGED');
    const weakened = invokeFixture(workspace, 'o8-w417-red-weaken');
    assert.equal(weakened.response.result, 'FAIL');
    assert.ok(weakened.response.findings.some((finding) => finding.id === 'O8_SEEDED_TEST_CHANGED'), 'weakened red test: hard-FAIL preserved');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
