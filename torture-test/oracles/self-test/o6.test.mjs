#!/usr/bin/env node
// o6.test.mjs — O6 worktree bookkeeping calibration (STORM-HYGIENE).
//
// One focused calibration suite for the O6 checker, run serially (node --test
// on this file alone). It drives the REAL oracles/O6 executable against the
// generated sidecars + native-schema sqlite snapshots (real exported
// implementation + wrapper parsing/exit codes) and asserts:
//   * corruption negatives: orphan row / directory / metadata, out-of-band
//     deletion, path-not-git, duplicate bindings, wrong origin, invalid rows,
//     removed-but-present, metadata mismatch;
//   * every cleanup-policy shape: default `keep` retained-after-terminal is
//     CORRECT (informational); remove_on_success / remove_on_terminal still
//     ready after terminal is a POLICY characterization (informational),
//     reported separately from corruption — and retained branches are the SAME
//     characterization (native never deletes refs), never a corruption FAIL;
//   * exact-count discipline: a capped 9-entry disk inventory sampled to 7
//     inline orphan dirs produces EXACTLY 7 O6_ORPHAN_DIRECTORY findings and
//     never a total derived from the capped array (observed 7, exact_count 9
//     recorded in the summary);
//   * known concrete findings are preserved when another leg is missing;
//   * invalid/unknown input never becomes PASS (NOT_EVALUABLE / ERROR),
//     including a capped/failed git worktree-list capture (row<->git
//     reconciliation incomplete -> NOT_EVALUABLE) and a terminal keep row with
//     disk+git legs down (NOT_EVALUABLE with ZERO findings — informational
//     characterizations only ever ride PASS);
//   * sidecar evidence_files coverage: present-and-valid raw captures (cited
//     as response evidence), missing file / hash mismatch / symlink (read-only
//     loader ERROR), and TT_ORACLE_EVIDENCE_DIR divergence safety (parent =>
//     relative citations, disjoint => omitted, never a broken reference);
//   * the prune/age behavioral leg is NOT_RUN (prune.executed false,
//     clone-only probe plan in evidence, no native removal executed);
//   * read-only proof: sidecar / expectation / DB snapshot hashes unchanged
//     after every wrapper run.
//
// A bounded isolated live proof creates a REAL git origin + REAL managed
// worktree under a fresh private retained workspace and reconciles it with
// the real capture module (lib/o6-capture.mjs) + the real checker — the
// positive control for native worktree creation on this slice. No removal /
// prune / deletion is ever executed. The REAL native run/worktree writer live
// leg (verification item 3 — product writers against a private
// HOME/STATE/DB/TMPDIR + owned origin + non-dispatching registration stub) is
// executed by native-writer-leg.mjs / native-writer-leg.test.mjs in this
// directory (serial gate run-o5-o6-native-writer.sh).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateOracleResponse } from '../lib/output.mjs';
import {
  captureBranches,
  captureGitWorktreesMetadata,
  captureGitWorktreeList,
  captureManagedRootListing,
  createNativeFixtureDatabase,
  readRunWorktreesSnapshot,
} from '../lib/o6-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const ORACLE = path.resolve(HERE, '..', 'O6');
const GENERATOR = path.join(HERE, 'generate-o6-fixtures.mjs');

const EXIT_BY_RESULT = { PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 };

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function invokeWrapper(sidecarPath, dir, env = {}) {
  const result = spawnSync(ORACLE, ['--contract-version', '1', '--sidecar', sidecarPath], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch (error) {
    assert.fail(`O6 emitted invalid JSON: ${result.stdout}\n${result.stderr}`);
  }
  return { response, status: result.status };
}

function freshWorkspace(label) {
  fs.mkdirSync(VAR_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(VAR_ROOT, `oracle-self-test.${label}.`));
}

function readEvidence(dir, response, filename) {
  const entry = response.evidence.find((item) => item.path.endsWith(filename));
  assert.ok(entry, `missing evidence ${filename} in ${JSON.stringify(response.evidence)}`);
  return JSON.parse(fs.readFileSync(path.join(dir, entry.path), 'utf8'));
}

test('O6 calibration over generated sidecars (wrapper exit codes, results, findings, counts, read-only)', () => {
  const workspace = freshWorkspace('o6');
  const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
  assert.equal(generated.status, 0, generated.stderr);
  const names = fs.readdirSync(workspace).filter((name) => name.startsWith('o6-')).sort();
  assert.ok(names.length >= 20, `expected >=20 O6 fixtures, got ${names.length}`);
  for (const name of names) {
    const dir = path.join(workspace, name);
    const expectation = JSON.parse(fs.readFileSync(path.join(dir, 'expectation.json'), 'utf8'));
    const sidecarPath = path.join(dir, 'sidecar.json');
    const dbPath = path.join(dir, 'db.sqlite');
    const hashesBefore = {
      sidecar: sha256File(sidecarPath),
      expectation: sha256File(path.join(dir, 'expectation.json')),
      db: fs.existsSync(dbPath) ? sha256File(dbPath) : null,
    };
    const { response, status } = invokeWrapper(sidecarPath, dir);
    const errors = validateOracleResponse(response, 'O6', status, dir);
    assert.deepEqual(errors, [], `${name}: ${errors.join('; ')}`);
    assert.equal(response.result, expectation.expected, `${name}: ${JSON.stringify(response)}`);
    assert.equal(status, EXIT_BY_RESULT[expectation.expected], `${name} exit code`);
    if (expectation.finding) {
      assert.ok(response.findings.some((finding) => finding.id === expectation.finding),
        `${name} omitted ${expectation.finding}: ${JSON.stringify(response.findings)}`);
    }
    if (expectation.infoFindings?.length > 0 && expectation.expected === 'PASS') {
      for (const infoId of expectation.infoFindings) {
        assert.ok(response.findings.some((finding) => finding.id === infoId && finding.non_failing === true),
          `${name} omitted informational ${infoId}`);
      }
    }
    if (expectation.expected === 'NOT_EVALUABLE') {
      assert.equal(response.findings.length, 0, `${name}: NOT_EVALUABLE must not carry findings`);
      assert.ok(response.classification?.ambiguous?.category, `${name} must carry an ambiguous classification`);
    }
    // exact-count discipline (capped array never becomes a total)
    if (expectation.exactCountChecks) {
      const orphanFindings = response.findings.filter((finding) => finding.id === 'O6_ORPHAN_DIRECTORY');
      assert.equal(orphanFindings.length, expectation.exactCountChecks.orphanFindings,
        `${name}: expected exactly ${expectation.exactCountChecks.orphanFindings} orphan-dir findings`);
      const summary = readEvidence(dir, response, 'o6-summary.json');
      assert.equal(summary.disk_leg.observed_orphan_dirs, expectation.exactCountChecks.observed,
        `${name}: observed orphan dirs must be the inline count, never the capped total`);
      assert.equal(summary.disk_leg.exact_count, expectation.exactCountChecks.exact,
        `${name}: exact_count must be recorded as captured`);
      assert.equal(summary.disk_leg.capped, true, `${name}: capped flag must be recorded`);
      assert.ok(response.findings.every((finding) => !finding.summary.includes('9') || finding.summary.includes('exact_count')),
        `${name}: no finding may derive a total from the capped array`);
    }
    // prune leg: the plan evidence exists and prune is never executed
    if (expectation.expected !== 'ERROR') {
      const plan = readEvidence(dir, response, 'o6-prune-probe-plan.json');
      assert.equal(plan.executed, false, `${name}: native prune must not be executed in this read-only slice`);
      assert.ok(plan.plan?.closed_scope === true, `${name}: prune probe plan must be clone-only closed-scope`);
      if (expectation.expected === 'PASS') {
        assert.ok(response.findings.some((finding) => finding.id === 'O6_PRUNE_LEG_NOT_RUN' && finding.non_failing === true),
          `${name} must record O6_PRUNE_LEG_NOT_RUN on PASS`);
      }
    }
    // read-only: inputs byte-identical; only oracle outputs added
    assert.equal(sha256File(sidecarPath), hashesBefore.sidecar, `${name} sidecar mutated`);
    assert.equal(sha256File(path.join(dir, 'expectation.json')), hashesBefore.expectation, `${name} expectation mutated`);
    if (hashesBefore.db !== null) {
      assert.equal(sha256File(dbPath), hashesBefore.db, `${name} database snapshot mutated`);
    }
    if (expectation.expected !== 'ERROR') {
      const allowedFiles = new Set(['sidecar.json', 'expectation.json', 'db.sqlite', 'o6-summary.json', 'o6-prune-probe-plan.json', ...(expectation.allowedExtra ?? [])]);
      const extraFiles = fs.readdirSync(dir).filter((file) => !allowedFiles.has(file));
      assert.deepEqual(extraFiles, [], `${name}: unexpected files created: ${extraFiles.join(', ')}`);
      const summary = readEvidence(dir, response, 'o6-summary.json');
      assert.equal(summary.oracle_id, 'O6');
      assert.equal(summary.result, expectation.expected);
    }
  }
  process.stdout.write(`O6 calibration PASS (${names.length} fixtures)\n`);
});

test('O6 evidence-dir divergence is safe (TT_ORACLE_EVIDENCE_DIR != sidecar dir)', () => {
  const workspace = freshWorkspace('o6evdir');
  const generated = spawnSync(process.execPath, [GENERATOR, workspace], { encoding: 'utf8', shell: false });
  assert.equal(generated.status, 0, generated.stderr);
  const fixtureName = 'o6-evidence-raw-capture-present';
  const fixtureDir = path.join(workspace, fixtureName);
  assert.ok(fs.existsSync(path.join(fixtureDir, 'sidecar.json')), `fixture ${fixtureName} missing`);
  const sidecarPath = path.join(fixtureDir, 'sidecar.json');
  const sidecarHash = sha256File(sidecarPath);
  const dbHash = sha256File(path.join(fixtureDir, 'db.sqlite'));

  // 1) Evidence dir = PARENT of the sidecar package (the documented controller
  // layout: campaign evidence dir contains the sidecar package). Raw captures
  // are then cited with paths relative to the evidence dir and resolve.
  const parentRun = invokeWrapper(sidecarPath, fixtureDir, { TT_ORACLE_EVIDENCE_DIR: workspace });
  const parentErrors = validateOracleResponse(parentRun.response, 'O6', parentRun.status, workspace);
  assert.deepEqual(parentErrors, [], `parent-evidence-dir: ${parentErrors.join('; ')}`);
  assert.equal(parentRun.response.result, 'PASS', JSON.stringify(parentRun.response));
  const rawCapture = parentRun.response.evidence.find((entry) => entry.path.includes('o6-captures/origin-0/worktree-list.txt'));
  assert.ok(rawCapture, `raw captures must be cited relative to the evidence dir: ${JSON.stringify(parentRun.response.evidence)}`);
  assert.ok(fs.existsSync(path.join(workspace, rawCapture.path)), `cited capture must resolve under the evidence dir: ${rawCapture.path}`);
  assert.ok(fs.existsSync(path.join(workspace, 'o6-summary.json')), 'summary evidence must be written under the evidence dir');

  // 2) Evidence dir DISJOINT from the sidecar package: raw captures cannot be
  // legally cited (they live outside the evidence dir) so they are omitted —
  // never a broken reference / ERROR — while the run still PASSes and its
  // summary lands in the evidence dir.
  const disjointDir = path.join(workspace, 'disjoint-evidence');
  fs.mkdirSync(disjointDir, { recursive: true });
  const disjointRun = invokeWrapper(sidecarPath, fixtureDir, { TT_ORACLE_EVIDENCE_DIR: disjointDir });
  const disjointErrors = validateOracleResponse(disjointRun.response, 'O6', disjointRun.status, disjointDir);
  assert.deepEqual(disjointErrors, [], `disjoint-evidence-dir: ${disjointErrors.join('; ')}`);
  assert.equal(disjointRun.response.result, 'PASS', JSON.stringify(disjointRun.response));
  assert.ok(disjointRun.response.evidence.every((entry) => !entry.path.includes('o6-captures/')),
    `raw captures outside the evidence dir must not be cited: ${JSON.stringify(disjointRun.response.evidence)}`);
  assert.ok(fs.existsSync(path.join(disjointDir, 'o6-summary.json')), 'summary must land in the disjoint evidence dir');

  // Read-only over inputs in both configurations.
  assert.equal(sha256File(sidecarPath), sidecarHash, 'sidecar mutated across evidence-dir runs');
  assert.equal(sha256File(path.join(fixtureDir, 'db.sqlite')), dbHash, 'DB snapshot mutated across evidence-dir runs');
  process.stdout.write('O6 evidence-dir divergence test PASS (parent + disjoint TT_ORACLE_EVIDENCE_DIR)\n');
});

test('O6 fixture DB writer is NEW-only (no pre-delete; existing bytes/inode preserved)', () => {
  const workspace = freshWorkspace('o6newonly');
  const target = path.join(workspace, 'db.sqlite');
  const sentinel = Buffer.from('SENTINEL-CONTENT-9876543210');
  fs.writeFileSync(target, sentinel);
  const hashBefore = sha256File(target);
  const statBefore = fs.statSync(target);
  const sentinelMode = statBefore.mode;

  // 1) existing regular FILE: refused with the bytes, inode and mode intact.
  assert.throws(() => createNativeFixtureDatabase(target, { worktrees: [], runs: [] }), /existing file/i);
  assert.equal(sha256File(target), hashBefore, 'existing file bytes must be preserved');
  assert.equal(fs.statSync(target).ino, statBefore.ino, 'existing file inode must be preserved');
  assert.equal(fs.statSync(target).mode, sentinelMode, 'existing file mode must be preserved');
  assert.deepEqual(fs.readdirSync(workspace), ['db.sqlite'], 'no partial/extra files may be created');

  // 2) existing DIRECTORY target: refused, directory intact.
  const dirTarget = path.join(workspace, 'adir');
  fs.mkdirSync(dirTarget);
  assert.throws(() => createNativeFixtureDatabase(dirTarget, {}), /existing directory/i);
  assert.ok(fs.statSync(dirTarget).isDirectory());

  // 3) existing SYMLINK target: refused, link and its referent intact.
  const linkTarget = path.join(workspace, 'alink.sqlite');
  fs.symlinkSync(target, linkTarget);
  assert.throws(() => createNativeFixtureDatabase(linkTarget, {}), /existing symlink/i);
  assert.ok(fs.lstatSync(linkTarget).isSymbolicLink());
  assert.equal(sha256File(target), hashBefore, 'symlink referent must stay untouched');

  // 4) missing parent directory: refused (fixtures need a freshly owned root).
  assert.throws(() => createNativeFixtureDatabase(path.join(workspace, 'no-parent', 'db.sqlite'), {}), /fixture-root directory/i);

  // 5) fresh NEW path in an owned root: creates cleanly, read-only afterwards.
  const freshDir = path.join(workspace, 'fresh');
  fs.mkdirSync(freshDir, { recursive: true });
  const fresh = path.join(freshDir, 'db.sqlite');
  createNativeFixtureDatabase(fresh, {
    worktrees: [{
      run_id: 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      worktree_origin_repository: '/r', worktree_origin_git_common_dir: '/r/.git',
      worktree_path: '/r/wt', status: 'ready', cleanup_policy: 'keep',
      created_at: new Date().toISOString(),
    }],
    runs: [{ id: 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completed' }],
  });
  const snapshot = readRunWorktreesSnapshot(fresh);
  assert.equal(snapshot.available, true, snapshot.reason);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].cleanup_policy, 'keep');
  process.stdout.write('O6 fixture DB writer NEW-only admission PASS (existing bytes/inode preserved; fresh exclusive reserve)\n');
});

test('O6 live proof: real git origin + real managed worktree reconciled clean (native capture, read-only)', () => {
  const workspace = freshWorkspace('o6live');
  const repoDir = path.join(workspace, 'origin');
  const rootDir = path.join(workspace, 'worktrees');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(rootDir, { recursive: true });

  const git = (args, cwd) => {
    const result = spawnSync('git', ['-C', cwd ?? repoDir, ...args], { encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'tt-fixture']);
  git(['config', 'user.email', 'tt-fixture@localhost']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'initial']);
  const originSha = git(['rev-parse', 'main']);
  const commonDir = git(['rev-parse', '--git-common-dir']);
  const commonAbs = path.isAbsolute(commonDir) ? commonDir : path.resolve(repoDir, commonDir);

  const runId = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runNumber = 1;
  const wt = path.join(rootDir, `tt-fixture-${'01234567'}-${runNumber}-${runId.slice(4, 12)}`);
  git(['worktree', 'add', '--detach', wt, 'main']);

  // Native-schema snapshot row for the run (fixture writer; real schema).
  const dbPath = path.join(workspace, 'db.sqlite');
  createNativeFixtureDatabase(dbPath, {
    worktrees: [{
      run_id: runId,
      worktree_origin_repository: repoDir,
      worktree_origin_git_common_dir: commonAbs,
      worktree_path: wt,
      worktree_origin_ref: 'main',
      worktree_origin_sha: originSha,
      original_branch: 'main',
      status: 'ready',
      cleanup_policy: 'keep',
      created_at: new Date().toISOString(),
    }],
    runs: [{ id: runId, run_number: runNumber, status: 'completed', workflow_id: 'feature-dev-merge-worktree' }],
  });

  // Real capture modules (read-only) feed the sidecar.
  const snapshot = readRunWorktreesSnapshot(dbPath);
  assert.equal(snapshot.available, true, snapshot.reason);
  const disk = {
    entries: captureManagedRootListing(rootDir).rows,
    exact_count: captureManagedRootListing(rootDir).exact_count,
    capped: false,
    tool: { name: 'managed root readdir', exit_code: captureManagedRootListing(rootDir).tool.exit_code },
  };
  const gitList = captureGitWorktreeList(repoDir);
  const metadata = captureGitWorktreesMetadata(commonAbs);
  const branches = captureBranches(repoDir);
  assert.equal(disk.tool.exit_code, 0);
  assert.equal(gitList.tool.exit_code, 0);
  assert.ok(gitList.rows.some((row) => row.worktree_path === wt), 'real worktree must be listed by git');
  assert.ok(metadata.rows.length >= 1, 'real worktree metadata must be captured');

  const sidecar = {
    schema_version: 1,
    sidecar_kind: 'post-batch-hygiene',
    oracle_id: 'O6',
    produced_at: new Date().toISOString(),
    producer: { name: 'o6-live-test', version: '1' },
    campaign: {
      id: 'campaign-o6-live', run_ids: [runId],
      window: { start_utc: new Date(Date.now() - 600_000).toISOString(), end_utc: new Date().toISOString() },
      host: { platform: process.platform, scope_layer: 'none', scope_pattern: null },
    },
    evidence_files: [], diagnostics: [],
    o6: {
      database: { path: 'db.sqlite', sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
      roots: {
        worktree_root: rootDir,
        origins: [{ repository: repoDir, git_common_dir: commonAbs, admitted_branch_roots: [] }],
      },
      disk,
      git: { origins: [{ origin_index: 0, worktree_list: gitList, worktrees_metadata: metadata, branches }] },
      prune: {
        executed: false,
        refusal: 'read-only slice: native prune/removal is not executed in this live proof',
        plan: { clone_root: path.join(workspace, 'prune-clone'), closed_scope: true, remap_note: 'clone must remap paths' },
      },
    },
  };
  const sidecarPath = path.join(workspace, 'sidecar.json');
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  const sidecarHash = sha256File(sidecarPath);
  const dbHash = sha256File(dbPath);
  const { response, status } = invokeWrapper(sidecarPath, workspace);
  const errors = validateOracleResponse(response, 'O6', status, workspace);
  assert.deepEqual(errors, []);
  assert.equal(response.result, 'PASS', `real worktree reconciliation must pass: ${JSON.stringify(response)}`);
  assert.ok(response.findings.some((finding) => finding.id === 'O6_RETAINED_BY_POLICY' && finding.non_failing === true));
  assert.ok(response.findings.some((finding) => finding.id === 'O6_PRUNE_LEG_NOT_RUN' && finding.non_failing === true));
  assert.equal(sha256File(sidecarPath), sidecarHash, 'sidecar mutated by the live run');
  assert.equal(sha256File(dbPath), dbHash, 'DB snapshot mutated by the live run');
  process.stdout.write('O6 live proof PASS (real git origin + managed worktree reconciled clean)\n');
});
