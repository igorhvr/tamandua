#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O2 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const RUN_ID = 'run-66666666-6666-4666-8666-666666666666';
const CHILD_RUN_ID = 'run-77777777-7777-4777-8777-777777777777';
const STARTED_AT = '2026-08-01T12:00:00.000Z';
const TERMINAL_AT = '2026-08-01T12:03:00.000Z';
const CAPTURED_AT = '2026-08-01T12:04:00.000Z';
const REFERENCE_KEYS = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];
const FIXTURES = [
  { name: 'o2-alternates-rejected', expected: 'ERROR', mutation: 'alternates' },
  { name: 'o2-green', expected: 'PASS' },
  { name: 'o2-ordinary-missing-row', expected: 'FAIL', omitSuiteRow: true, finding: 'O2_SUITE_EVIDENCE_MISSING' },
  { name: 'o2-ordinary-wrong-key', expected: 'FAIL', suiteKeyMutation: 'cmd', finding: 'O2_SUITE_EVIDENCE_MISSING' },
  { name: 'o2-default-concession', expected: 'PASS', mode: 'default-concession' },
  { name: 'o2-default-concession-no-reroute', expected: 'FAIL', mode: 'default-concession', omitReroute: true, finding: 'O2_CONCESSION_REROUTE_INVALID' },
  { name: 'o2-default-concession-laundered-red', expected: 'FAIL', mode: 'default-concession', exactRedRow: true, finding: 'O2_CONCESSION_EXACT_KEY_ROW' },
  { name: 'o2-off-mode', expected: 'PASS', mode: 'off' },
  { name: 'o2-off-mode-unbound', expected: 'FAIL', mode: 'off', unboundLaunch: true, finding: 'O2_OFF_MODE_LAUNCH_UNBOUND' },
  { name: 'o2-off-mode-no-override', expected: 'FAIL', mode: 'off', omitOverride: true, finding: 'O2_OFF_MODE_PROVENANCE_INVALID' },
  { name: 'o2-unattributed-transition', expected: 'FAIL', mutation: 'unattributed-transition', finding: 'O2_REF_TRANSITION_UNATTRIBUTED' },
  // S41 (US-004): the two-landing shape — TWO attributed merge runs, TWO
  // chained target transitions (base -> mid -> final), each landing owned by
  // an attributed run. O2 must accept the legal chain (PASS) while a broken
  // chain (the second landing does not start where the first ended) or an
  // unattributed second transition still fails.
  { name: 'o2-two-landing', expected: 'PASS', mutation: 'two-landing' },
  { name: 'o2-two-landing-broken-chain', expected: 'FAIL', mutation: 'two-landing', brokenChain: true, finding: 'O2_REF_EVENT_MISMATCH' },
  { name: 'o2-two-landing-unattributed', expected: 'FAIL', mutation: 'two-landing', omitSecondRun: true, finding: 'O2_REF_TRANSITION_UNATTRIBUTED' },
  // S20 (US-001): the capture parser archives message-less landing reflog
  // lines raw-only; the oracle must recover the transition from the raw line
  // (PASS) while a genuinely unparseable line still trips REF_TRANSITION_COUNT.
  { name: 'o2-message-less-landing', expected: 'PASS', mutation: 'message-less' },
  { name: 'o2-unparseable-reflog', expected: 'FAIL', mutation: 'unparseable-reflog', finding: 'O2_REF_TRANSITION_COUNT' },
  { name: 'o2-unknown-landing-run', expected: 'FAIL', unknownLanding: true, finding: 'O2_LANDING_RUN_UNKNOWN' },
  { name: 'o2-green-cross-run-noop', expected: 'PASS', crossRunNoop: true },
  { name: 'o2-green-noop-recovery', expected: 'PASS', recovery: true },
  { name: 'o2-landed-failed', expected: 'FAIL', runStatus: 'failed', finding: 'O2_LANDED_RUN_NOT_COMPLETED' },
  { name: 'o2-landed-canceled', expected: 'FAIL', runStatus: 'canceled', finding: 'O2_LANDED_RUN_NOT_COMPLETED' },
  { name: 'o2-noop-before-landing', expected: 'FAIL', recovery: true, noopBefore: true, finding: 'O2_INVALID_NOOP_RECOVERY' },
  { name: 'o2-tested-tree-mismatch', expected: 'FAIL', mutation: 'tested-tree', finding: 'O2_TESTED_TREE_MISMATCH' },
  { name: 'o2-commit-tree-mismatch', expected: 'FAIL', mutation: 'commit-tree', finding: 'O2_COMMIT_TREE_MISMATCH' },
  { name: 'o2-patch-missing', expected: 'FAIL', mutation: 'patch', finding: 'O2_PATCH_NOT_PRESENT' },
  { name: 'o2-phantom-merge', expected: 'FAIL', mutation: 'phantom', finding: 'O2_PHANTOM_MERGE' },
  { name: 'o2-reflog-window-bypass', expected: 'FAIL', mutation: 'reflog-window', finding: 'O2_REF_TRANSITION_COUNT' },
  { name: 'o2-source-is-target', expected: 'FAIL', mutation: 'source-target', finding: 'O2_SOURCE_REF_INVALID' },
  { name: 'o2-cross-run-duplicate', expected: 'FAIL', crossRun: true, finding: 'O2_DUPLICATE_LANDING' },
  { name: 'o2-duplicate-landing', expected: 'FAIL', mutation: 'duplicate', finding: 'O2_DUPLICATE_LANDING' },
  { name: 'o2-empty-landing', expected: 'FAIL', mutation: 'empty', finding: 'O2_EMPTY_LANDING' },
  { name: 'o2-foreign-sibling-row', expected: 'PASS', foreignSiblingRow: true },
  { name: 'o2-null-gate-key', expected: 'NOT_EVALUABLE', nullGateKey: true },
];

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    input: options.input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'O2 Fixture',
      GIT_AUTHOR_EMAIL: 'o2@example.invalid',
      GIT_COMMITTER_NAME: 'O2 Fixture',
      GIT_COMMITTER_EMAIL: 'o2@example.invalid',
      GIT_AUTHOR_DATE: '2026-08-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-01T12:00:00Z',
    },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeDeterministicGitArchive(repo, archive, cwd) {
  run('tar', [
    '--sort=name', '--format=gnu', '--mtime=2026-08-01T12:00:00Z',
    '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go=rX',
    '--exclude=./index', '--exclude=./logs',
    '-C', path.join(repo, '.git'), '-cf', archive, '.',
  ], cwd);
}

function reference(campaign, file, source, capturedAt = CAPTURED_AT) {
  return {
    path: path.relative(campaign, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    captured_at: capturedAt,
    source,
  };
}

function writeSnapshot(campaign, snapshots, name, value, capturedAt = CAPTURED_AT) {
  const file = path.join(snapshots, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  return reference(campaign, file, 'self-test-fixture', capturedAt);
}

function repositoryIdentity() {
  return { fixture_path: 'synthetic/repo', git_common_dir: 'synthetic/repo/.git', object_format: 'sha1' };
}

function event(fields) {
  return { archive: 'all.jsonl', line: fields.line, event: {
    ts: fields.ts,
    event: 'merge.landed',
    runId: fields.runId ?? RUN_ID,
    origin: 'synthetic-origin',
    branch: fields.branch,
    target: 'refs/heads/main',
    expectedTip: fields.expectedTip,
    mergedTree: fields.mergedTree,
    mergedCommit: fields.mergedCommit,
    noop: fields.noop,
  } };
}

function annotation(name, fields) {
  return { archive: 'all.jsonl', line: fields.line, event: {
    ts: fields.ts,
    event: name,
    runId: fields.runId ?? RUN_ID,
    workflowId: 'feature-dev-merge-worktree',
    stepId: 'finalize_merge',
    ...fields.values,
  } };
}

for (const fixture of FIXTURES) {
  const campaign = path.join(workspace, fixture.name);
  const snapshots = path.join(campaign, 'snapshots');
  const evidenceDir = path.join(campaign, 'evidence');
  const repo = path.join(campaign, 'repo-source');
  fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.mkdirSync(repo, { mode: 0o700 });
  fs.writeFileSync(path.join(campaign, 'state.json'), '{}\n', { flag: 'wx' });

  run('git', ['init', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'base'], repo);
  const base = run('git', ['rev-parse', 'HEAD'], repo);
  const baseTree = run('git', ['rev-parse', 'HEAD^{tree}'], repo);

  run('git', ['checkout', '-b', 'feature'], repo);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'wanted change\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'feature'], repo);
  const feature = run('git', ['rev-parse', 'HEAD'], repo);
  const featureTree = run('git', ['rev-parse', 'HEAD^{tree}'], repo);

  // S41 (US-004): the two-landing shape lands TWO feature states on main in
  // two chained merge commits. The feature branch gains a second commit
  // (featureTree2); landing 1 merges the first state (base -> midCommit),
  // landing 2 merges the second (midCommit -> finalCommit). Both update-refs
  // write target-reflog transitions so O2 sees a legal two-transition chain.
  const twoLanding = fixture.mutation === 'two-landing';
  let feature2 = null;
  let featureTree2 = null;
  let midCommit = null;
  let finalCommit = null;
  if (twoLanding) {
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'second change\n');
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', 'feature2'], repo);
    feature2 = run('git', ['rev-parse', 'HEAD'], repo);
    featureTree2 = run('git', ['rev-parse', 'HEAD^{tree}'], repo);
    // Each landing owns its own source branch: landing 1 merges the FIRST
    // feature state (branch feature, tree featureTree), landing 2 the SECOND
    // (branch feature2, tree featureTree2). Reset feature back to its first
    // commit so O2's source-tree check sees the attested per-landing tree.
    run('git', ['branch', 'feature2'], repo);
    run('git', ['checkout', '-q', 'feature2'], repo);
    run('git', ['branch', '-f', 'feature', feature], repo);
    midCommit = run('git', ['commit-tree', featureTree, '-p', base], repo, { input: 'land feature\n' });
    finalCommit = run('git', ['commit-tree', featureTree2, '-p', midCommit], repo, { input: 'land feature2\n' });
    run('git', ['update-ref', 'refs/heads/main', midCommit, base], repo);
    run('git', ['update-ref', 'refs/heads/main', finalCommit, midCommit], repo);
  }

  run('git', ['checkout', '-b', 'rogue', base], repo);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'different change\n');
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', 'rogue'], repo);
  const rogue = run('git', ['rev-parse', 'HEAD'], repo);

  run('git', ['checkout', '-b', 'empty', base], repo);
  const emptyCommit = run('git', ['commit-tree', baseTree, '-p', base], repo, { input: 'empty landing\n' });
  run('git', ['update-ref', 'refs/heads/empty', emptyCommit], repo);

  const phantom = fixture.mutation === 'phantom';
  const empty = fixture.mutation === 'empty';
  let mergedCommit = null;
  let targetCommit;
  if (twoLanding) {
    targetCommit = finalCommit;
  } else {
    const mergedParent = fixture.mutation === 'patch' ? rogue : base;
    mergedCommit = run('git', ['commit-tree', featureTree, '-p', mergedParent], repo, { input: 'land feature\n' });
    targetCommit = phantom ? base : empty ? emptyCommit : mergedCommit;
    run('git', ['update-ref', 'refs/heads/main', targetCommit, base], repo);
  }

  const wrongTree = baseTree;
  const eventTree = fixture.mutation === 'commit-tree' ? wrongTree : (empty ? baseTree : (phantom ? baseTree : featureTree));
  const eventCommit = phantom ? base : (empty ? emptyCommit : mergedCommit);
  const branch = fixture.mutation === 'source-target'
    ? 'refs/heads/main'
    : empty ? 'refs/heads/empty' : 'refs/heads/feature';
  const testedTree = fixture.mutation === 'tested-tree' ? baseTree : eventTree;
  const events = [];
  if (twoLanding) {
    events.push(event({
      line: 1,
      ts: '2026-08-01T12:02:00.000Z',
      branch: 'refs/heads/feature',
      expectedTip: base,
      mergedTree: featureTree,
      mergedCommit: midCommit,
      noop: false,
    }));
    events.push(event({
      line: 2,
      runId: CHILD_RUN_ID,
      ts: fixture.brokenChain ? '2026-08-01T12:02:00.500Z' : '2026-08-01T12:02:30.000Z',
      branch: 'refs/heads/feature2',
      expectedTip: fixture.brokenChain ? base : midCommit,
      mergedTree: featureTree2,
      mergedCommit: finalCommit,
      noop: false,
    }));
  } else {
    events.push(event({
      line: 1,
      ts: '2026-08-01T12:02:00.000Z',
      branch,
      expectedTip: base,
      mergedTree: eventTree,
      mergedCommit: eventCommit,
      noop: phantom,
    }));
  }
  const ORIGIN = 'synthetic-origin';
  const CMD_HASH = 'd'.repeat(64);
  if (fixture.mode === 'default-concession') {
    if (!fixture.omitReroute) {
      events.unshift(annotation('step.rerouted', {
        line: 10,
        ts: '2026-08-01T12:01:00.000Z',
        values: { detail: 'Rerouted to test (1/2). Consumer failure: FAILURE_CLASS: refused_permanent' },
      }));
    }
    events.push(annotation('merge.landed_without_suite_evidence', {
      line: 11,
      ts: '2026-08-01T12:02:01.000Z',
      values: { gateMode: 'default', origin: ORIGIN, treeHash: featureTree, cmdHash: CMD_HASH },
    }));
  }
  if (fixture.mode === 'off' && !fixture.omitOverride) {
    events.unshift(annotation('merge.gate_overridden', {
      line: 12,
      ts: '2026-08-01T12:01:00.000Z',
      values: { gateMode: 'off', origin: ORIGIN, treeHash: featureTree, cmdHash: CMD_HASH },
    }));
  }
  if (fixture.recovery || fixture.mutation === 'duplicate') {
    events.push(event({
      line: 2,
      ts: fixture.noopBefore ? '2026-08-01T12:01:59.000Z' : '2026-08-01T12:02:01.000Z',
      branch: 'refs/heads/feature',
      expectedTip: fixture.recovery ? mergedCommit : base,
      mergedTree: featureTree,
      mergedCommit,
      noop: fixture.recovery,
    }));
  }
  if (fixture.crossRun) {
    events.push(event({
      line: 2,
      runId: CHILD_RUN_ID,
      ts: '2026-08-01T12:02:01.000Z',
      branch: 'refs/heads/feature',
      expectedTip: base,
      mergedTree: featureTree,
      mergedCommit,
      noop: false,
    }));
  }
  if (fixture.crossRunNoop) {
    events.push(event({
      line: 2,
      runId: CHILD_RUN_ID,
      ts: '2026-08-01T12:02:01.000Z',
      branch: 'refs/heads/feature',
      expectedTip: mergedCommit,
      mergedTree: featureTree,
      mergedCommit,
      noop: true,
    }));
  }
  if (fixture.unknownLanding) {
    events.push(event({
      line: 13,
      runId: 'run-99999999-9999-4999-8999-999999999999',
      ts: '2026-08-01T12:02:02.000Z',
      branch: 'refs/heads/feature',
      expectedTip: mergedCommit,
      mergedTree: featureTree,
      mergedCommit,
      noop: true,
    }));
  }

  const databasePath = path.join(snapshots, 'database.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL);');
  database.exec(`CREATE TABLE suite_results (
    id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL,
    cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT,
    created_at TEXT NOT NULL
  );`);
  database.exec(`CREATE TABLE steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
    terminal_reroute_count INTEGER NOT NULL DEFAULT 0
  );`);
  database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(
    RUN_ID.slice(4), 'feature-dev-merge-worktree', fixture.runStatus ?? 'completed', JSON.stringify({ tested_tree: testedTree }),
  );
  database.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(
    'finalize-row', RUN_ID.slice(4), 'finalize_merge',
    fixture.mode === 'default-concession' && !fixture.omitReroute ? 1 : 0,
  );
  if (fixture.crossRun || fixture.crossRunNoop || twoLanding) {
    database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(
      CHILD_RUN_ID.slice(4), 'feature-dev-merge-worktree', 'completed', JSON.stringify({ tested_tree: twoLanding ? featureTree2 : testedTree }),
    );
  }
  if (twoLanding) {
    database.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(
      'finalize-row-2', CHILD_RUN_ID.slice(4), 'finalize_merge', 0,
    );
  }
  const ordinary = fixture.mode === undefined;
  if ((ordinary && !fixture.omitSuiteRow) || fixture.exactRedRow) {
    database.prepare(`INSERT INTO suite_results
      (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, run_id, step_id, created_at)
      VALUES (?, ?, ?, 'npm test', ?, 1000, ?, 'test', ?)`)
      .run(ORIGIN, featureTree, fixture.suiteKeyMutation === 'cmd' ? 'e'.repeat(64) : CMD_HASH,
        fixture.exactRedRow ? 1 : 0, RUN_ID.slice(4), '2026-08-01T12:01:30.000Z');
  }
  if (twoLanding) {
    // Landing 2's ordinary exact-gate row (tree featureTree2, same origin/key).
    database.prepare(`INSERT INTO suite_results
      (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, run_id, step_id, created_at)
      VALUES (?, ?, ?, 'npm test', ?, 1000, ?, 'test', ?)`)
      .run(ORIGIN, featureTree2, CMD_HASH, 0, CHILD_RUN_ID.slice(4), '2026-08-01T12:02:20.000Z');
  }
  if (fixture.foreignSiblingRow) {
    database.prepare(`INSERT INTO suite_results
      (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, run_id, step_id, created_at)
      VALUES (?, ?, ?, 'npm test', ?, 1000, ?, 'test', ?)`)
      .run('sibling-origin', 'e'.repeat(40), CMD_HASH, 0, 'run-sibling', '2026-08-01T12:01:30.000Z');
  }
  const suiteRows = database.prepare('SELECT * FROM suite_results ORDER BY id').all()
    .filter((row) => row.origin_repo === ORIGIN);
  database.close();
  fs.chmodSync(databasePath, 0o400);

  if (fixture.mutation === 'alternates') {
    fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), '/tmp/external-objects\n');
  }
  const gitTar = path.join(snapshots, 'repository.git.tar');
  writeDeterministicGitArchive(repo, gitTar, campaign);
  fs.chmodSync(gitTar, 0o400);

  const refsBefore = {
    schema_version: 1, phase: 'before', repository: repositoryIdentity(),
    target_ref: 'refs/heads/main', target_tip: base, for_each_ref: '',
  };
  const refsAfter = {
    schema_version: 1, phase: 'after', repository: repositoryIdentity(),
    target_ref: 'refs/heads/main', target_tip: targetCommit,
    for_each_ref: run('git', ['for-each-ref', '--sort=refname', '--format=%(objectname)%09%(objecttype)%09%(refname)%09%(upstream)'], repo),
  };
  const ordinaryReflog = [{
    old_oid: base, new_oid: targetCommit, actor: 'O2 Fixture <o2@example.invalid>',
    timestamp: 1785585720, timezone: '+0000', action: 'fixture landing',
    raw: `${base} ${targetCommit} O2 Fixture <o2@example.invalid> 1785585720 +0000\tfixture landing`,
  }];
  const reflogEntries = twoLanding ? [
    {
      old_oid: base, new_oid: midCommit, actor: 'O2 Fixture <o2@example.invalid>',
      timestamp: 1785585720, timezone: '+0000', action: 'fixture landing 1',
      raw: `${base} ${midCommit} O2 Fixture <o2@example.invalid> 1785585720 +0000\tfixture landing 1`,
    },
    {
      old_oid: midCommit, new_oid: finalCommit, actor: 'O2 Fixture <o2@example.invalid>',
      timestamp: 1785585750, timezone: '+0000', action: 'fixture landing 2',
      raw: `${midCommit} ${finalCommit} O2 Fixture <o2@example.invalid> 1785585750 +0000\tfixture landing 2`,
    },
  ] : phantom ? [] : fixture.mutation === 'reflog-window' ? [
    {
      ...ordinaryReflog[0], timestamp: 1785585540,
      raw: `${base} ${targetCommit} O2 Fixture <o2@example.invalid> 1785585540 +0000\tmatching outside capture`,
    },
    {
      ...ordinaryReflog[0], new_oid: feature, timestamp: 1785585720,
      raw: `${base} ${feature} O2 Fixture <o2@example.invalid> 1785585720 +0000\tunrelated inside capture`,
    },
  ] : fixture.mutation === 'unattributed-transition' ? [
    ordinaryReflog[0],
    {
      ...ordinaryReflog[0], old_oid: targetCommit, new_oid: feature, timestamp: 1785585750,
      raw: `${targetCommit} ${feature} O2 Fixture <o2@example.invalid> 1785585750 +0000\tunattributed update`,
    },
  ] : fixture.mutation === 'message-less' ? [
    // Message-less landing update-ref line: no \t<message> tail. The oracle
    // must recover old_oid/new_oid/actor/timestamp/timezone from the raw line.
    { raw: `${base} ${targetCommit} O2 Fixture <o2@example.invalid> 1785585720 +0000` },
  ] : fixture.mutation === 'unparseable-reflog' ? [
    { raw: 'this is not a reflog line at all' },
  ] : ordinaryReflog;

  const references = Object.fromEntries(REFERENCE_KEYS.map((key) => [key, null]));
  references.database_snapshot = reference(campaign, databasePath, 'sqlite-self-test');
  references.run_events = writeSnapshot(campaign, snapshots, 'run-events.json', {
    schema_version: 1, captured_at: CAPTURED_AT,
    run_ids: fixture.crossRun || fixture.crossRunNoop || twoLanding ? [RUN_ID, CHILD_RUN_ID] : [RUN_ID], rows: events,
  });
  references.launch_intent = writeSnapshot(campaign, snapshots, 'launch-intent.json', {
    schema_version: 1, captured_at: STARTED_AT,
    policy: { merge_gate: fixture.mode === 'off' && !fixture.unboundLaunch ? 'off' : null, fail_missing: null },
    argv: fixture.mode === 'off' && !fixture.unboundLaunch
      ? ['workflow', 'run', 'feature-dev-merge-worktree', '--context', 'merge_gate=off']
      : ['workflow', 'run', 'feature-dev-merge-worktree'],
    argv_sha256: 'a'.repeat(64),
    gate_key: fixture.nullGateKey ? null : { origin_repo: ORIGIN, cmd_hash: CMD_HASH },
  }, STARTED_AT);
  references.git_bundle = reference(campaign, gitTar, 'git-common-dir-tar');
  references.refs_before = writeSnapshot(campaign, snapshots, 'refs-before.json', refsBefore, STARTED_AT);
  references.refs_after = writeSnapshot(campaign, snapshots, 'refs-after.json', refsAfter);
  references.target_reflog = writeSnapshot(campaign, snapshots, 'target-reflog.json', {
    schema_version: 1, captured_at: CAPTURED_AT, repository: repositoryIdentity(),
    target_ref: 'refs/heads/main', entries: reflogEntries,
  });
  references.suite_ledger = writeSnapshot(campaign, snapshots, 'suite-ledger.json', {
    schema_version: 1, captured_at: CAPTURED_AT, rows: suiteRows,
  });
  references.suite_observations = writeSnapshot(campaign, snapshots, 'suite-observations.json', {
    schema_version: 1, captured_at: CAPTURED_AT, rows: [],
  });

  const attempt = {
    id: 'attempt-o2', kind: 'workflow', phase: 'terminal', execution_mode: 'scripted', run_id: RUN_ID,
    started_at: STARTED_AT, terminal_at: TERMINAL_AT, terminal_status: fixture.runStatus ?? 'completed', tokens_observed: 1,
    command_result: { exit_code: 0, signal: null }, steps_snapshot: null, straggler_capture: null,
  };
  const discoveredRuns = fixture.crossRun || fixture.crossRunNoop || (twoLanding && !fixture.omitSecondRun) ? [{
    ...attempt,
    id: 'attempt-o2-child',
    run_id: CHILD_RUN_ID,
    parent_run_id: RUN_ID,
  }] : [];
  const context = {
    contract_version: 1,
    oracle_id: 'O2',
    campaign: {
      id: `campaign-${fixture.name}`, created_at: STARTED_AT,
      manifest: { sha256: 'c'.repeat(64), case_count: 1, case_ids: [fixture.name] },
    },
    case: {
      id: fixture.name, wave: 4, workflow: 'feature-dev-merge-worktree', fixture: 'synthetic',
      harness: 'scripted-pi', class: 'verification', caps: { tokens: 100, wall_min: 10 },
      boundary_files: [], forbidden: [], chaos: null,
    },
    run_id: RUN_ID,
    attempts: [attempt],
    discovered_runs: discoveredRuns,
    o1_wave: { schema_version: 1, wave: 4, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  const contextPath = path.join(evidenceDir, 'context.json');
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(campaign, 'expectation.json'), `${JSON.stringify({ ...fixture, context: contextPath })}\n`, { flag: 'wx' });
  fs.rmSync(repo, { recursive: true, force: true });
}
