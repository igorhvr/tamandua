#!/usr/bin/env node
// o6-capture.mjs — read-only metadata capture for the O6 worktree
// bookkeeping census (STORM-HYGIENE recorder side; evaluator = lib/o6.mjs).
//
// Everything here is READ-ONLY over the explicitly admitted roots: the
// database snapshot file, the managed worktree root listing, `git worktree
// list --porcelain`, the per-worktree .git/worktrees metadata files and the
// refs/heads inventory of each admitted origin repository. No removal, prune,
// delete, reset or rewrite is ever performed — native prune/removal is an
// explicit SEPARATE behavioral leg (sidecar prune.executed === false; the O6
// evaluator records it NOT_RUN with the clone-only probe plan).
//
// Native-schema constants: the fixture/self-test writer creates NEW database
// files with the exact run_worktrees DDL the product migrates (src/db.ts) so
// the checker is exercised over the REAL native schema; the writer is a
// fixture-only helper and is never pointed at original campaign data. The
// writer is NEW-ONLY: it never pre-deletes and never opens over an existing
// file/directory/symlink (exclusive O_EXCL reservation inside the caller's
// freshly owned fixture root) — see createNativeFixtureDatabase below.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const NATIVE_RUN_WORKTREES_DDL = `
  CREATE TABLE IF NOT EXISTS run_worktrees (
    run_id TEXT PRIMARY KEY,
    worktree_origin_repository TEXT NOT NULL,
    worktree_origin_git_common_dir TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    worktree_origin_ref TEXT,
    worktree_origin_sha TEXT,
    original_branch TEXT,
    status TEXT NOT NULL DEFAULT 'creating',
    cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
    created_at TEXT NOT NULL,
    removed_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_worktrees_status ON run_worktrees(status);
`;

export const NATIVE_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    run_number INTEGER NOT NULL,
    workflow_id TEXT NOT NULL,
    task TEXT,
    status TEXT NOT NULL,
    context TEXT,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    scheduling_status TEXT,
    scheduling_requested_at TEXT,
    notify_url TEXT,
    parent_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function runGit(repo, args) {
  let result;
  try {
    result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  } catch {
    return { status: 127, stdout: '', stderr: 'git spawn failed' };
  }
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function nowIso() {
  return new Date().toISOString();
}

function inventory(toolName, exitCode, rows, spans = null) {
  return {
    rows,
    exact_count: rows.length,
    capped: false,
    tool: { name: toolName, exit_code: exitCode },
    spans: spans ?? [{ start: nowIso(), end: nowIso() }],
  };
}

/**
 * readGitWorktreeGitDirFile(worktreePath): read the single `<worktree>/.git`
 * file ("gitdir: <common>/worktrees/<name>") and return the target path, or
 * null when absent/unreadable/not a gitfile. Bounded single-file read.
 */
export function readGitWorktreeGitDirFile(worktreePath) {
  try {
    const gitFilePath = path.join(worktreePath, '.git');
    const details = fs.lstatSync(gitFilePath);
    if (!details.isFile() || details.isSymbolicLink()) return null;
    const content = fs.readFileSync(gitFilePath, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match === null) return null;
    const target = match[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
  } catch {
    return null;
  }
}

/**
 * captureGitWorktreeList(originRepo): `git worktree list --porcelain` parse.
 * rows: { worktree_path, head, branch|null, detached, locked, prunable,
 *         gitdir_path (resolved .git file target when readable) }.
 */
export function captureGitWorktreeList(originRepo) {
  const result = runGit(originRepo, ['worktree', 'list', '--porcelain']);
  const rows = [];
  if (result.status === 0) {
    let current = null;
    for (const line of String(result.stdout).split('\n')) {
      if (line.trim() === '') {
        if (current !== null) rows.push(current);
        current = null;
        continue;
      }
      if (current === null) current = { branch: null, detached: false, locked: false, prunable: false };
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') {
        current.worktree_path = value;
        current.gitdir_path = readGitWorktreeGitDirFile(value);
      } else if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'detached') current.detached = true;
      else if (key === 'locked') current.locked = true;
      else if (key === 'prunable') current.prunable = true;
    }
    if (current !== null) rows.push(current);
  }
  return inventory('git worktree list --porcelain', result.status, rows);
}

/**
 * captureGitWorktreesMetadata(gitCommonDir): enumerate `<common>/worktrees/*`
 * metadata entries. rows: { gitdir_path, name, gitdir_target, worktree_path }.
 */
export function captureGitWorktreesMetadata(gitCommonDir) {
  const worktreesDir = path.join(gitCommonDir, 'worktrees');
  const rows = [];
  let status = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    status = 1;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const gitdirPath = path.join(worktreesDir, entry.name, 'gitdir');
    try {
      const details = fs.lstatSync(gitdirPath);
      if (!details.isFile() || details.isSymbolicLink()) continue;
      const gitdirTarget = fs.readFileSync(gitdirPath, 'utf8').trim();
      const worktreeDotGit = path.isAbsolute(gitdirTarget) ? gitdirTarget : path.resolve(worktreesDir, gitdirTarget);
      // <worktree>/.git file content equals worktrees/<name>/gitdir content.
      const worktreePath = worktreeDotGit.endsWith(`${path.sep}.git`) ? path.dirname(worktreeDotGit) : null;
      rows.push({ gitdir_path: gitdirPath, name: entry.name, gitdir_target: worktreeDotGit, worktree_path: worktreePath });
    } catch {
      // malformed/unreadable metadata entry — recorded by omission + status 1
      status = 1;
    }
  }
  return inventory('git .git/worktrees metadata read', status, rows);
}

/**
 * captureBranches(originRepo): refs/heads inventory. rows:
 * { full_ref, object_sha, type } (type 'commit' etc.). Never traverses
 * outside the admitted origin.
 */
export function captureBranches(originRepo) {
  const result = runGit(originRepo, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)', 'refs/heads']);
  const rows = [];
  if (result.status === 0) {
    for (const line of String(result.stdout).split('\n')) {
      if (line.trim() === '') continue;
      const [fullRef, objectSha, objectType] = line.split('\t');
      if (typeof fullRef === 'string' && fullRef.length > 0) {
        rows.push({ full_ref: fullRef, object_sha: objectSha ?? '', type: objectType ?? '' });
      }
    }
  }
  return inventory('git for-each-ref refs/heads', result.status, rows);
}

/**
 * captureManagedRootListing(worktreeRoot): level-1 listing of the managed
 * worktree root. rows: { path, kind, git_worktree } — git_worktree true when
 * the entry is a directory holding a real `.git` gitfile. Tool exit 1 when
 * the root is unreadable (recorded; never guessed).
 */
export function captureManagedRootListing(worktreeRoot) {
  const rows = [];
  let status = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
  } catch {
    status = 1;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(worktreeRoot, entry.name);
    const kind = entry.isDirectory() ? 'dir' : (entry.isSymbolicLink() ? 'symlink' : 'file');
    let gitWorktree = false;
    if (kind === 'dir') {
      gitWorktree = readGitWorktreeGitDirFile(fullPath) !== null;
    }
    rows.push({ path: fullPath, kind: kind === 'symlink' ? 'symlink-dir' : kind, git_worktree: gitWorktree });
  }
  return inventory('managed root readdir', status, rows);
}

/**
 * readRunWorktreesSnapshot(dbPath): read-only open of a native snapshot and
 * SELECT of run_worktrees + runs(id,status). Returns
 * { available, rows?, runs?, reason? }. Never opens writable.
 */
export function readRunWorktreesSnapshot(dbPath) {
  try {
    const details = fs.statSync(dbPath);
    if ((details.mode & 0o222) !== 0) {
      return { available: false, reason: 'database snapshot is writable; read-only mechanical evidence is required' };
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(run_worktrees)').all().map((column) => column.name);
      const runsColumns = db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
      if (!['run_id', 'worktree_path', 'worktree_origin_repository', 'worktree_origin_git_common_dir', 'status', 'cleanup_policy'].every((col) => columns.includes(col))) {
        return { available: false, reason: 'snapshot lacks the native run_worktrees columns' };
      }
      if (!runsColumns.includes('id') || !runsColumns.includes('status')) {
        return { available: false, reason: 'snapshot lacks the native runs id/status columns' };
      }
      const rows = db.prepare('SELECT * FROM run_worktrees ORDER BY created_at').all();
      const runs = new Map(db.prepare('SELECT id, status FROM runs').all().map((row) => [row.id, row]));
      return { available: true, rows, runs };
    } finally {
      db.close();
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * createNativeFixtureDatabase(dbPath, { worktrees, runs }): FIXTURE-ONLY
 * writer — creates a NEW database file with the native run_worktrees DDL and
 * a runs table (the exact columns the native snapshot carries), then inserts
 * the given rows and chmods the file read-only. Never pointed at original
 * campaign data; used by self-tests and fixture generators to exercise the O6
 * checker over the real native schema.
 *
 * NEW-ONLY admission (strengthened after the root capture probe,
 * o5-o6-root-capture-probe-20260909): the writer NEVER pre-deletes and NEVER
 * opens over an existing path. It refuses (throws, touching nothing) when the
 * target already exists as a file, directory or symlink, and it exclusively
 * reserves a fresh regular file (O_EXCL) inside the caller's freshly owned
 * fixture root before sqlite touches it — an existing caller-supplied file's
 * bytes, inode and hash are preserved untouched. A source comment is not the
 * boundary: every caller must hand over a fresh path inside a root it owns.
 */
export function createNativeFixtureDatabase(dbPath, { worktrees = [], runs = [] } = {}) {
  // NEW-only admission: reject an existing file/directory/symlink BEFORE any
  // write. The path must not exist at all (lstat ENOENT).
  let existing;
  try {
    existing = fs.lstatSync(dbPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`createNativeFixtureDatabase cannot admit ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (existing !== undefined) {
    const kind = existing.isSymbolicLink() ? 'symlink' : (existing.isDirectory() ? 'directory' : 'file');
    throw new Error(`createNativeFixtureDatabase refuses an existing ${kind} at ${dbPath}: fixtures are NEW-only and must never pre-delete or overwrite a caller-supplied path`);
  }
  // The parent must be an existing directory the caller owns (fresh fixture
  // root); the writer never fabricates or cleans it recursively.
  const parent = path.dirname(dbPath);
  let parentStat;
  try {
    parentStat = fs.statSync(parent);
  } catch (error) {
    throw new Error(`createNativeFixtureDatabase requires an existing fixture-root directory ${parent}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`createNativeFixtureDatabase requires an existing fixture-root directory at ${parent}, found a non-directory`);
  }
  // Exclusively reserve a fresh regular file (O_EXCL) so sqlite only ever
  // opens a path this call just created — race-free and never over a sentinel.
  let fd;
  try {
    fd = fs.openSync(dbPath, 'wx', 0o600);
  } catch (error) {
    throw new Error(`createNativeFixtureDatabase could not exclusively reserve a fresh file at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  fs.closeSync(fd);
  const db = new DatabaseSync(dbPath);
  db.exec(NATIVE_RUN_WORKTREES_DDL);
  db.exec(NATIVE_RUNS_DDL);
  const insertWorktree = db.prepare(`INSERT INTO run_worktrees
    (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path,
     worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy,
     created_at, removed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of worktrees) {
    insertWorktree.run(
      row.run_id, row.worktree_origin_repository, row.worktree_origin_git_common_dir, row.worktree_path,
      row.worktree_origin_ref ?? null, row.worktree_origin_sha ?? null, row.original_branch ?? null,
      row.status ?? 'ready', row.cleanup_policy ?? 'keep',
      row.created_at ?? new Date().toISOString(), row.removed_at ?? null, row.error ?? null,
    );
  }
  const insertRun = db.prepare('INSERT INTO runs (id, run_number, workflow_id, status, tokens_spent, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
  for (const row of runs) {
    const now = new Date().toISOString();
    insertRun.run(row.id, row.run_number ?? 1, row.workflow_id ?? 'feature-dev-merge-worktree', row.status, row.created_at ?? now, row.updated_at ?? now);
  }
  db.close();
  fs.chmodSync(dbPath, 0o400);
  return dbPath;
}
