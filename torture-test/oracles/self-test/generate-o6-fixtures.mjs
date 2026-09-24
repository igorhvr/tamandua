#!/usr/bin/env node
// generate-o6-fixtures.mjs — O6 calibration fixture generator.
//
// Writes one directory per fixture under a unique oracle-self-test.* workspace
// (beneath torture-test/var): a read-only sqlite database snapshot (native
// run_worktrees schema, see lib/o6-capture.mjs), the sidecar.json that
// references it plus the synthetic disk/git/branch inventories, and
// expectation.json. The o6.test.mjs file invokes the REAL oracles/O6
// executable against each sidecar and asserts result / exit code / findings /
// classification / exact-count discipline.
//
// Every fixture pins one O6 rule (spec 03 + STORM-HYGIENE read-only slice):
//   * corruption negatives (orphan row / dir / metadata, out-of-band deletion,
//     path-not-git, duplicate bindings, wrong origin, invalid rows, removed-
//     but-present, metadata mismatch);
//   * each cleanup-policy shape (keep retained-after-terminal is CORRECT;
//     remove_on_success/remove_on_terminal still-ready-after-terminal is a
//     POLICY characterization, reported separately from corruption; retained
//     branches are characterization too — native never deletes refs — never
//     O6_BRANCH_INCONSISTENCY);
//   * exact counts vs bounded samples (a capped 9-entry inventory sampled to
//     7 inline orphan dirs: the checker reports exactly the 7 observed and
//     NEVER derives totals from the capped array);
//   * known concrete findings preserved when another leg is missing;
//   * invalid/unknown input never becomes PASS: NOT_EVALUABLE for a terminal
//     keep row with disk+git legs down (informational findings never ride
//     NOT_EVALUABLE) and for a ready row whose origin git worktree-list
//     capture is capped/failed (reconciliation incomplete); ERROR for the
//     read-only loader's evidence_files refusals (missing file, hash
//     mismatch, symlink) and for prune.executed true;
//   * sidecar evidence_files coverage: present-and-valid raw captures cited
//     as response evidence (also exercised under TT_ORACLE_EVIDENCE_DIR
//     divergence in o6.test.mjs);
//   * the prune/age behavioral leg stays NOT_RUN with its clone-only probe
//     plan (prune.executed === false; native removal is NOT executed).
//
// The generator is a FIXTURE-ONLY writer: it creates fresh databases and
// synthetic inventories in its own workspace; it never touches original
// campaign data, never removes anything and never runs native prune.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { createNativeFixtureDatabase } from '../lib/o6-capture.mjs';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O6 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const NOW = '2026-08-01T12:00:00.000Z';
const ROOT = '/repo/worktrees';
const ORIGIN_REPO = '/repo/tt-poly';
const ORIGIN_COMMON = '/repo/tt-poly/.git';
const RUN_A = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN_C = 'run-cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function wtPath(tag) {
  return `${ROOT}/${tag}`;
}

function row(runId, opts = {}) {
  return {
    run_id: runId,
    worktree_origin_repository: opts.origin_repo ?? ORIGIN_REPO,
    worktree_origin_git_common_dir: opts.origin_common ?? ORIGIN_COMMON,
    worktree_path: opts.worktree_path ?? wtPath(`wt-${runId.slice(4, 8)}`),
    worktree_origin_ref: opts.origin_ref ?? 'main',
    worktree_origin_sha: opts.origin_sha ?? 'a'.repeat(40),
    original_branch: opts.original_branch ?? null,
    status: opts.status ?? 'ready',
    cleanup_policy: opts.policy ?? 'keep',
    created_at: opts.created_at ?? '2026-07-31T00:00:00.000Z',
    removed_at: opts.removed_at ?? null,
    error: opts.error ?? null,
  };
}

function run(runId, status, opts = {}) {
  return { id: runId, status, run_number: opts.run_number, workflow_id: opts.workflow_id ?? 'feature-dev-merge-worktree' };
}

function diskEntry(worktreePath, opts = {}) {
  return { path: worktreePath, kind: 'dir', git_worktree: opts.git_worktree ?? true };
}

function diskInventory(entries, opts = {}) {
  return {
    entries,
    exact_count: opts.exact_count ?? entries.length,
    capped: opts.capped ?? false,
    tool: { name: 'managed root readdir', exit_code: opts.exit ?? 0 },
  };
}

function gitOrigin(listRows = [], metadataRows = [], branchRows = [], opts = {}) {
  const inventory = (rows, exit = 0, exact = rows.length, capped = opts.capped ?? false) => ({
    rows,
    exact_count: exact,
    capped,
    tool: { name: 'git fixture', exit_code: exit },
  });
  return {
    origin_index: 0,
    worktree_list: inventory(listRows, opts.listExit ?? 0, opts.listExact ?? listRows.length, opts.listCapped ?? opts.capped ?? false),
    worktrees_metadata: inventory(metadataRows, opts.metadataExit ?? 0),
    branches: inventory(branchRows, opts.branchExit ?? 0, opts.branchExact ?? branchRows.length, opts.branchCapped ?? opts.capped ?? false),
  };
}

function gitListRow(worktreePath, opts = {}) {
  return {
    worktree_path: worktreePath,
    gitdir_path: opts.gitdir_path ?? `${ORIGIN_COMMON}/worktrees/${opts.name ?? path.basename(worktreePath)}`,
    branch: opts.branch ?? null,
    detached: opts.detached ?? true,
    locked: opts.locked ?? false,
    prunable: opts.prunable ?? false,
  };
}

function metadataRow(name, worktreePath, opts = {}) {
  return {
    gitdir_path: `${ORIGIN_COMMON}/worktrees/${name}/gitdir`,
    name,
    gitdir_target: opts.gitdir_target ?? `${worktreePath}/.git`,
    worktree_path: opts.worktree_path ?? worktreePath,
  };
}

function branchRow(fullRef) {
  return { full_ref: fullRef, object_sha: 'a'.repeat(40), type: 'commit' };
}

function prunePlan() {
  return {
    executed: false,
    refusal: 'read-only slice: native prune/removal is gated on independent coordinator review of the exact disposable root/DB/path set and code; not executed',
    plan: {
      clone_root: '/repo/var/prune-clones/o6-prune-probe',
      closed_scope: true,
      remap_note: 'the clone DB must remap run_worktrees.worktree_path and run contexts to the disposable clone root — a cloned DB still pointing at original worktrees is NOT isolation',
    },
  };
}

function sidecarBase(dbRel, extra = {}) {
  const sidecar = {
    schema_version: 1,
    sidecar_kind: 'post-batch-hygiene',
    oracle_id: 'O6',
    produced_at: NOW,
    producer: { name: 'o6-fixture-generator', version: '1' },
    campaign: {
      id: 'campaign-o6-calibration',
      run_ids: [RUN_A, RUN_B, RUN_C],
      window: { start_utc: '2026-07-31T00:00:00.000Z', end_utc: NOW },
      host: { platform: 'linux', scope_layer: 'systemd-user-scope', scope_pattern: null },
    },
    evidence_files: [],
    diagnostics: [],
    o6: {
      database: { path: dbRel, sha256: 'PENDING', schema: 'native-run_worktrees-v1' },
      roots: {
        worktree_root: ROOT,
        origins: [{
          repository: ORIGIN_REPO,
          git_common_dir: ORIGIN_COMMON,
          admitted_branch_roots: ['refs/heads/feature', 'refs/heads/fix'],
        }],
      },
      disk: diskInventory([]),
      git: { origins: [gitOrigin()] },
      prune: prunePlan(),
    },
  };
  if (extra.o6 !== undefined) {
    sidecar.o6 = { ...sidecar.o6, ...extra.o6 };
  }
  if (extra.evidence_files !== undefined) sidecar.evidence_files = extra.evidence_files;
  if (extra.diagnostics !== undefined) sidecar.diagnostics = extra.diagnostics;
  if (extra.campaign !== undefined) sidecar.campaign = extra.campaign;
  return sidecar;
}

// ── fixture cases ─────────────────────────────────────────────────────────

const CASES = [
  {
    name: 'o6-green-retained-keep',
    expected: 'PASS',
    infoFindings: ['O6_RETAINED_BY_POLICY', 'O6_PRUNE_LEG_NOT_RUN'],
    build() {
      const dbRel = 'db.sqlite';
      const worktrees = [row(RUN_A, { worktree_path: wtPath('wt-A') })];
      const runs = [run(RUN_A, 'completed')];
      const dbPath = path.join(workspace, 'o6-green-retained-keep', dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees, runs });
      const wt = wtPath('wt-A');
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-green-removed-clean',
    expected: 'PASS',
    infoFinding: 'O6_PRUNE_LEG_NOT_RUN',
    build() {
      const dir = path.join(workspace, 'o6-green-removed-clean');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { status: 'removed', removed_at: NOW })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-green-nonmerged-branch-keep',
    expected: 'PASS',
    infoFinding: 'O6_PRUNE_LEG_NOT_RUN',
    build() {
      const dir = path.join(workspace, 'o6-green-nonmerged-branch-keep');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-B');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_B, { worktree_path: wt, original_branch: 'feature/bug-xyz', status: 'ready', policy: 'keep' })],
        runs: [run(RUN_B, 'failed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-B', wt)],
            [branchRow('refs/heads/main'), branchRow('refs/heads/feature/bug-xyz')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-orphan-row',
    expected: 'FAIL',
    finding: 'O6_ORPHAN_ROW',
    build() {
      const dir = path.join(workspace, 'o6-orphan-row');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-X');
      createNativeFixtureDatabase(dbPath, {
        // run row deliberately absent for run-xxxxxxxx... (orphan row)
        worktrees: [row('run-xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx', { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-X', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-orphan-directory',
    expected: 'FAIL',
    finding: 'O6_ORPHAN_DIRECTORY',
    build() {
      const dir = path.join(workspace, 'o6-orphan-directory');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-Y');
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-Y', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-orphan-metadata-only',
    expected: 'FAIL',
    finding: 'O6_ORPHAN_METADATA',
    build() {
      const dir = path.join(workspace, 'o6-orphan-metadata-only');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-ZZ');
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin(
            [],
            [metadataRow('wt-ZZ', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-out-of-band-deletion',
    expected: 'FAIL',
    finding: 'O6_OUT_OF_BAND_DELETION',
    build() {
      const dir = path.join(workspace, 'o6-out-of-band-deletion');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]), // the path was deleted out-of-band
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-path-not-git-worktree',
    expected: 'FAIL',
    finding: 'O6_PATH_NOT_GIT_WORKTREE',
    build() {
      const dir = path.join(workspace, 'o6-path-not-git-worktree');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([{ path: wt, kind: 'dir', git_worktree: false }]), // dir present, NOT a git worktree
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-duplicate-binding',
    expected: 'FAIL',
    finding: 'O6_DUPLICATE_BINDING',
    build() {
      const dir = path.join(workspace, 'o6-duplicate-binding');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt }), row(RUN_C, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed'), run(RUN_C, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-wrong-origin',
    expected: 'FAIL',
    finding: 'O6_WRONG_ORIGIN',
    build() {
      const dir = path.join(workspace, 'o6-wrong-origin');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, origin_common: '/repo/elsewhere/.git', origin_repo: '/repo/elsewhere' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-invalid-policy',
    expected: 'FAIL',
    finding: 'O6_INVALID_ROW_DATA',
    build() {
      const dir = path.join(workspace, 'o6-invalid-policy');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, policy: 'always' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-invalid-status',
    expected: 'FAIL',
    finding: 'O6_INVALID_ROW_DATA',
    build() {
      const dir = path.join(workspace, 'o6-invalid-status');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, status: 'exploded' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    name: 'o6-removed-but-present',
    expected: 'FAIL',
    finding: 'O6_REMOVED_BUT_PRESENT',
    build() {
      const dir = path.join(workspace, 'o6-removed-but-present');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, status: 'removed', removed_at: NOW })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-metadata-mismatch',
    expected: 'FAIL',
    finding: 'O6_METADATA_MISMATCH',
    build() {
      const dir = path.join(workspace, 'o6-metadata-mismatch');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [], // .git/worktrees metadata missing for the listed worktree
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    // A completed run with a remove_on_terminal worktree still ready AND the
    // branch retained: native never deletes refs on worktree removal, so this
    // is the SAME auto-enforcement gap as the worktree-level policy
    // characterization — informational, never a corruption FAIL (the old
    // O6_BRANCH_INCONSISTENCY FAIL for this shape is gone; see the evaluator).
    name: 'o6-branch-retention-remove-on-char',
    expected: 'PASS',
    infoFindings: ['O6_POLICY_CHARACTERIZATION', 'O6_BRANCH_RETENTION_CHARACTERIZATION', 'O6_PRUNE_LEG_NOT_RUN'],
    build() {
      const dir = path.join(workspace, 'o6-branch-retention-remove-on-char');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, original_branch: 'feature/merged-x', policy: 'remove_on_terminal' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main'), branchRow('refs/heads/feature/merged-x')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-capped-exact-counts',
    expected: 'FAIL',
    finding: 'O6_ORPHAN_DIRECTORY',
    exactCountChecks: { orphanFindings: 7, observed: 7, exact: 9 },
    build() {
      const dir = path.join(workspace, 'o6-capped-exact-counts');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      // NINE orphan git worktrees exist under the managed root; the inventory
      // capture is CAPPED and sampled only SEVEN inline. The checker reports
      // exactly the seven it observed and never derives a total (9) from the
      // capped array.
      const allWts = Array.from({ length: 9 }, (_, index) => wtPath(`cap-${index + 1}`));
      const inline = allWts.slice(0, 7);
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory(inline.map((wt) => diskEntry(wt)), { exact_count: 9, capped: true }),
          git: { origins: [gitOrigin(
            inline.map((wt, index) => gitListRow(wt, { name: `cap-${index + 1}` })),
            inline.map((wt, index) => metadataRow(`cap-${index + 1}`, wt)),
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-preserve-finding-leg-missing',
    expected: 'FAIL',
    finding: 'O6_OUT_OF_BAND_DELETION',
    build() {
      const dir = path.join(workspace, 'o6-preserve-finding-leg-missing');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')], { listExit: 127 })] },
        },
      });
    },
  },
  {
    name: 'o6-policy-remove-on-terminal-char',
    expected: 'PASS',
    infoFindings: ['O6_POLICY_CHARACTERIZATION', 'O6_PRUNE_LEG_NOT_RUN'],
    build() {
      const dir = path.join(workspace, 'o6-policy-remove-on-terminal-char');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, policy: 'remove_on_terminal' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-policy-remove-on-success-char',
    expected: 'PASS',
    infoFindings: ['O6_POLICY_CHARACTERIZATION', 'O6_PRUNE_LEG_NOT_RUN'],
    build() {
      const dir = path.join(workspace, 'o6-policy-remove-on-success-char');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, policy: 'remove_on_success' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
      });
    },
  },
  {
    name: 'o6-input-git-leg-missing',
    expected: 'NOT_EVALUABLE',
    build() {
      const dir = path.join(workspace, 'o6-input-git-leg-missing');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, status: 'removed', removed_at: NOW })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [], { listExit: 127 })] },
        },
      });
    },
  },
  {
    name: 'o6-input-not-native-db',
    expected: 'NOT_EVALUABLE',
    build() {
      const dir = path.join(workspace, 'o6-input-not-native-db');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      // a non-native sqlite file (wrong schema) — invalid input never PASS.
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE junk (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO junk VALUES (?, ?)').run('x', 'y');
      db.close();
      fs.chmodSync(dbPath, 0o400);
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
      });
    },
  },
  {
    // Reviewer regression: DB snapshot with a terminal keep row while the
    // disk + git legs are down. Before the fix this returned ERROR (exit 2)
    // because the per-row O6_RETAINED_BY_POLICY informational finding could not
    // ride a NOT_EVALUABLE result; it must be NOT_EVALUABLE (exit 3) with zero
    // findings.
    name: 'o6-terminal-keep-leg-down-not-evaluable',
    expected: 'NOT_EVALUABLE',
    build() {
      const dir = path.join(workspace, 'o6-terminal-keep-leg-down-not-evaluable');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt, policy: 'keep' })],
        runs: [run(RUN_A, 'completed')],
      });
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([], { exit: 127 }),
          git: { origins: [gitOrigin([], [], [], { listExit: 127 })] },
        },
      });
    },
  },
  {
    // Reviewer regression: a ready row whose origin git worktree-list capture
    // is CAPPED (sampled) and does not include the row. Absence from a capped
    // sample is never proof git lost the worktree — the reconciliation is
    // incomplete and must be NOT_EVALUABLE, never PASS.
    name: 'o6-git-list-capped-ready-unresolved',
    expected: 'NOT_EVALUABLE',
    build() {
      const dir = path.join(workspace, 'o6-git-list-capped-ready-unresolved');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wtA = wtPath('wt-A');
      const wtB = wtPath('wt-B');
      const wtC = wtPath('wt-C');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wtA })],
        runs: [run(RUN_A, 'completed')],
      });
      // git list is capped: 5 total, 3 inline — none of them the ready row.
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wtA)]),
          git: { origins: [gitOrigin(
            [gitListRow(wtB, { name: 'wt-B' }), gitListRow(wtC, { name: 'wt-C' })],
            [metadataRow('wt-A', wtA)],
            [branchRow('refs/heads/main')],
            { listCapped: true, listExact: 5 },
          )] },
        },
      });
    },
  },
  {
    // Sidecar evidence_files coverage: PRESENT + valid raw captures. The raw
    // captures are hash-verified by the loader and cited as response evidence.
    name: 'o6-evidence-raw-capture-present',
    expected: 'PASS',
    infoFindings: ['O6_RETAINED_BY_POLICY', 'O6_PRUNE_LEG_NOT_RUN'],
    allowedExtra: ['o6-captures'],
    build() {
      const dir = path.join(workspace, 'o6-evidence-raw-capture-present');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      const wt = wtPath('wt-A');
      createNativeFixtureDatabase(dbPath, {
        worktrees: [row(RUN_A, { worktree_path: wt })],
        runs: [run(RUN_A, 'completed')],
      });
      const evidenceFiles = [];
      for (const name of ['worktree-list.txt', 'worktrees-metadata.txt', 'branches.txt']) {
        const rel = `o6-captures/origin-0/${name}`;
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `captured ${name} (fixture raw capture)\n`, { mode: 0o400, flag: 'wx' });
        evidenceFiles.push({ path: rel, sha256: sha256File(abs), kind: 'raw-git-capture', captured_at: NOW, tool: 'git', exit_code: 0 });
      }
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([diskEntry(wt)]),
          git: { origins: [gitOrigin(
            [gitListRow(wt)],
            [metadataRow('wt-A', wt)],
            [branchRow('refs/heads/main')],
          )] },
        },
        evidence_files: evidenceFiles,
      });
    },
  },
  {
    // Sidecar evidence_files coverage: a declared raw capture that is MISSING
    // on disk — the loader refuses it (invalid input never PASS) -> ERROR.
    name: 'o6-evidence-file-missing',
    expected: 'ERROR',
    build() {
      const dir = path.join(workspace, 'o6-evidence-file-missing');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      const fake = createHash('sha256').update('declared but never written').digest('hex');
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
        evidence_files: [{ path: 'o6-captures/origin-0/worktree-list.txt', sha256: fake, kind: 'raw-git-capture' }],
      });
    },
  },
  {
    // Sidecar evidence_files coverage: a declared raw capture whose sha256 does
    // not match the file on disk — the loader refuses it -> ERROR.
    name: 'o6-evidence-file-hash-mismatch',
    expected: 'ERROR',
    build() {
      const dir = path.join(workspace, 'o6-evidence-file-hash-mismatch');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      const rel = 'o6-captures/origin-0/worktree-list.txt';
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'actual capture content\n', { mode: 0o400, flag: 'wx' });
      const wrong = createHash('sha256').update('completely different bytes').digest('hex');
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
        evidence_files: [{ path: rel, sha256: wrong, kind: 'raw-git-capture' }],
      });
    },
  },
  {
    // Sidecar evidence_files coverage: a declared raw capture that is a
    // SYMLINK (escape attempt) — the loader refuses non-regular/non-contained
    // files -> ERROR.
    name: 'o6-evidence-file-symlink',
    expected: 'ERROR',
    build() {
      const dir = path.join(workspace, 'o6-evidence-file-symlink');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      const rel = 'o6-captures/origin-0/worktree-list.txt';
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(dbPath, abs); // symlink pointing at db.sqlite — rejected
      const fake = createHash('sha256').update('symlink content cannot be hashed').digest('hex');
      return sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
          disk: diskInventory([]),
          git: { origins: [gitOrigin([], [], [branchRow('refs/heads/main')])] },
        },
        evidence_files: [{ path: rel, sha256: fake, kind: 'raw-git-capture' }],
      });
    },
  },
  {
    name: 'o6-malformed-sidecar',
    expected: 'ERROR',
    build() {
      const dir = path.join(workspace, 'o6-malformed-sidecar');
      fs.mkdirSync(dir, { recursive: true });
      const dbRel = 'db.sqlite';
      const dbPath = path.join(dir, dbRel);
      createNativeFixtureDatabase(dbPath, { worktrees: [], runs: [run(RUN_A, 'completed')] });
      const sidecar = sidecarBase(dbRel, {
        o6: {
          database: { path: dbRel, sha256: sha256File(dbPath), schema: 'native-run_worktrees-v1' },
        },
      });
      sidecar.o6.prune.executed = true; // shape violation: this run must not execute prune
      return sidecar;
    },
  },
];

// ── writer ────────────────────────────────────────────────────────────────

for (const fixture of CASES) {
  const dir = path.join(workspace, fixture.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sidecar = fixture.build();
  const sidecarPath = path.join(dir, 'sidecar.json');
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  const expectation = {
    name: fixture.name,
    expected: fixture.expected,
    finding: fixture.finding ?? null,
    infoFindings: fixture.infoFindings ?? (fixture.infoFinding ? [fixture.infoFinding] : []),
    exactCountChecks: fixture.exactCountChecks ?? null,
    allowedExtra: fixture.allowedExtra ?? [],
    sidecar: sidecarPath,
  };
  fs.writeFileSync(path.join(dir, 'expectation.json'), `${JSON.stringify(expectation, null, 2)}\n`, { flag: 'wx' });
}
process.stdout.write(`generated ${CASES.length} O6 fixtures in ${workspace}\n`);
