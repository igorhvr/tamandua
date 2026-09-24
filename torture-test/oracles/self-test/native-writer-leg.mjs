#!/usr/bin/env node
// native-writer-leg.mjs — REAL native run/worktree writer live leg
// (STORM-HYGIENE-CAPTURE verification-item-3).
//
// run47's contract declared the bounded NATIVE-writer proof NOT_RUN because no
// compiled product dist was present. /opt/tamandua/dist (the stable matched
// product build) IS present now, so this leg closes that gap: it lets the REAL
// native run/worktree writers create a fixture run and managed worktree(s) in
// a NEW, strictly private HOME/STATE/DB/TMPDIR against a tiny OWNED origin git
// repository, then captures O5/O6 evidence through the CORRECTED actual
// recorders (lib/o5-capture.mjs, lib/o6-capture.mjs) and drives their ACTUAL
// executable wrappers (oracles/O5, oracles/O6) with the real post-batch sidecar
// contract.
//
// Authorized boundaries (this is TORTURE-only test tooling; no product source
// is changed):
//   * Native binaries/source/probe APIs are TEST INPUTS ONLY.
//   * A product build is permitted as a TEST PREREQUISITE; it is never a
//     reason to replace the actual writers with manual native-schema INSERTs.
//     The run row, run_number allocation, run_worktrees row, managed worktree
//     and terminal status transition below all come from the REAL native
//     writers in /opt/tamandua/dist (run.js runWorkflow / worktree-manager.js
//     createRunWorktree / status.js forceFailRun), verified to match the
//     candidate source APIs BEFORE any effect.
//   * Registration TRANSPORT testdouble (same posture as the O12 run-number
//     probe): a clearly labeled NON-DISPATCHING stub HTTP control plane on a
//     RANDOM loopback port answers the health/register/nudge/terminate calls
//     the native writers make, but never schedules any step — zero agents,
//     zero models, zero system runs. No provider credentials, no default
//     ports, no live run/worker/reporting authority.
//   * NO actual prune, worktree removal, ref deletion or recursive cleanup is
//     executed or planned here; all created repos/worktrees/DBs are RETAINED
//     (prune/age remains a documented NOT_RUN leg for coordinator review).
//   * Exact native keep/terminal/cleanup-policy semantics are CHARACTERIZED
//     (default cleanup_policy 'keep' from createRunWorktree; retained-after-
//     terminal is the current native contract; forceFailRun does NOT remove
//     the worktree) — never changed, never called corrupt.
//   * Every spawned child is synchronous and reaped by the parent; the only
//     owned handles are the stub listener and the DB handle, both closed
//     EXACTLY and positively observed (closure recorded; non-green otherwise).
//
// Exit 0 + JSON report on success; non-zero on any deviation.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateOracleResponse } from '../lib/output.mjs';
import { NATIVE_RUN_WORKTREES_DDL } from '../lib/o6-capture.mjs';
import {
  captureBranches,
  captureGitWorktreesMetadata,
  captureGitWorktreeList,
  captureManagedRootListing,
  readRunWorktreesSnapshot,
} from '../lib/o6-capture.mjs';
import { snapshotOwnedListeners, snapshotOwnedProcesses } from '../lib/o5-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const O5_ORACLE = path.resolve(HERE, '..', 'O5');
const O6_ORACLE = path.resolve(HERE, '..', 'O6');
const DIST_DIR = process.env.TAMANDUA_NATIVE_DIST ?? '/opt/tamandua/dist';
const STABLE_SRC = process.env.TAMANDUA_NATIVE_SRC ?? '/opt/tamandua/src';
const WORKFLOW_ID = 'native-writer-leg';
const LEG_ROOT_PARENT = process.env.TAMANDUA_NATIVE_LEG_ROOT ?? os.tmpdir(); // retained evidence parent (round evidence root when set)
const HEAD_PIN = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function runGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  return result.stdout.trim();
}

// Extract every run_worktrees INSERT column list from a source text and return
// the normalized column-list signature (identical across candidate/stage/run).
function extractRunWorktreesInsertColumns(source) {
  const columns = new Set();
  let cursor = 0;
  while (true) {
    const start = source.indexOf('INSERT INTO run_worktrees', cursor);
    if (start < 0) break;
    const open = source.indexOf('(', start);
    const close = source.indexOf(')', open);
    if (open < 0 || close < 0) return null;
    const list = source.slice(open + 1, close).split(',').map((s) => s.trim().replace(/`/g, ''));
    for (const column of list) columns.add(column);
    cursor = close + 1;
  }
  if (columns.size === 0) return null;
  return [...columns].sort().join(',');
}

// Extract the run_worktrees CREATE TABLE column names from a source text.
function extractRunWorktreesDdlColumns(source) {
  const start = source.indexOf('CREATE TABLE IF NOT EXISTS run_worktrees');
  if (start < 0) return null;
  const open = source.indexOf('(', start);
  const close = source.indexOf(')', open);
  const body = source.slice(open + 1, close);
  const columns = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('--')) continue;
    const match = /^([a-z_]+)\s/.exec(line);
    if (match === null) continue;
    columns.push(match[1]);
  }
  return columns.sort().join(',');
}

// ── candidate/source API match, verified BEFORE any effect ────────────────
const candidateWt = fs.readFileSync(path.join(REPO_ROOT, 'src', 'installer', 'worktree-manager.ts'), 'utf8');
const stableWtSrc = fs.readFileSync(path.join(STABLE_SRC, 'installer', 'worktree-manager.ts'), 'utf8');
const distWt = fs.readFileSync(path.join(DIST_DIR, 'installer', 'worktree-manager.js'), 'utf8');
const candidateDb = fs.readFileSync(path.join(REPO_ROOT, 'src', 'db.ts'), 'utf8');
const stableDb = fs.readFileSync(path.join(STABLE_SRC, 'db.ts'), 'utf8');
const distDb = fs.readFileSync(path.join(DIST_DIR, 'db.js'), 'utf8');

const apiMatch = {
  run_worktrees_insert_columns: {
    candidate: extractRunWorktreesInsertColumns(candidateWt),
    stable_src: extractRunWorktreesInsertColumns(stableWtSrc),
    dist: extractRunWorktreesInsertColumns(distWt),
  },
  run_worktrees_ddl_columns: {
    candidate_db: extractRunWorktreesDdlColumns(candidateDb),
    stable_src_db: extractRunWorktreesDdlColumns(stableDb),
    dist_db: extractRunWorktreesDdlColumns(distDb),
    torture_oracle_ddl: extractRunWorktreesDdlColumns(NATIVE_RUN_WORKTREES_DDL),
  },
  dist_hashes: {
    'dist/db.js': sha256File(path.join(DIST_DIR, 'db.js')),
    'dist/installer/run.js': sha256File(path.join(DIST_DIR, 'installer', 'run.js')),
    'dist/installer/status.js': sha256File(path.join(DIST_DIR, 'installer', 'status.js')),
    'dist/installer/worktree-manager.js': sha256File(path.join(DIST_DIR, 'installer', 'worktree-manager.js')),
  },
  dist_product_source_head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: STABLE_SRC, encoding: 'utf8' }).stdout.trim() || null,
};
const insertMatch = apiMatch.run_worktrees_insert_columns.candidate === apiMatch.run_worktrees_insert_columns.stable_src
  && apiMatch.run_worktrees_insert_columns.candidate === apiMatch.run_worktrees_insert_columns.dist
  && apiMatch.run_worktrees_insert_columns.candidate !== null;
const ddlColumnSet = new Set([
  apiMatch.run_worktrees_ddl_columns.candidate_db,
  apiMatch.run_worktrees_ddl_columns.stable_src_db,
  apiMatch.run_worktrees_ddl_columns.dist_db,
  apiMatch.run_worktrees_ddl_columns.torture_oracle_ddl,
]);
const ddlMatch = !ddlColumnSet.has(null) && ddlColumnSet.size === 1;
if (!insertMatch || !ddlMatch) {
  console.error('candidate/stable/dist worktree-manager + run_worktrees DDL do not match — refusing to characterize a drifted source');
  process.exit(2);
}

// Strip parent Tamandua run/worker authority BEFORE any fixture allocation or
// product import (no inherited live run/worker/reporting authority).
for (const name of ['TAMANDUA_RUN_ID', 'TAMANDUA_WORKER_PID', 'TAMANDUA_WORKER_PGID', 'TAMANDUA_WORKER_JOB_ID', 'TAMANDUA_CONTROL_PORT']) {
  delete process.env[name];
}

// ── NEW strictly private, retained HOME/STATE/DB/TMPDIR ───────────────────
fs.mkdirSync(LEG_ROOT_PARENT, { recursive: true });
const root = fs.mkdtempSync(path.join(LEG_ROOT_PARENT, 'native-writer-leg.'));
const home = path.join(root, 'home');
const state = path.join(root, 'state');
const tmp = path.join(root, 'tmp');
const wtRoot = path.join(root, 'worktrees');
const evidenceDir = path.join(root, 'evidence');
for (const dir of [home, state, tmp, wtRoot, evidenceDir]) fs.mkdirSync(dir, { mode: 0o700 });
process.env.HOME = home;
process.env.TAMANDUA_STATE_DIR = state;
process.env.TAMANDUA_DB_PATH = path.join(state, 'tamandua.db');
process.env.TAMANDUA_WORKTREE_ROOT = wtRoot;
process.env.TAMANDUA_TEST_GUARD = '1';
process.env.TMPDIR = tmp;
delete process.env.TT_ORACLE_EVIDENCE_DIR;

// ── tiny OWNED origin git repository (never /opt/tamandua or a worktree) ──
const origin = path.join(root, 'leg-origin');
fs.mkdirSync(origin);
runGit(origin, ['init', '-q', '-b', 'main']);
runGit(origin, ['config', 'user.name', 'native-writer-leg']);
runGit(origin, ['config', 'user.email', 'native-writer-leg@localhost']);
runGit(origin, ['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(origin, 'README.md'), 'native-writer-leg owned origin fixture\n');
runGit(origin, ['add', 'README.md']);
runGit(origin, ['commit', '-q', '-m', 'initial']);
runGit(origin, ['branch', 'feature/leg-retained']); // retained-ref evidence
const originHeadSha = runGit(origin, ['rev-parse', 'main']);
const originCommonRaw = runGit(origin, ['rev-parse', '--git-common-dir']);
const originCommon = path.isAbsolute(originCommonRaw) ? originCommonRaw : path.resolve(origin, originCommonRaw);

// ── minimal worktree-mode workflow spec in the PRIVATE state catalog ─────
const workflowDir = path.join(state, 'workflows', WORKFLOW_ID);
fs.mkdirSync(workflowDir, { recursive: true });
fs.writeFileSync(path.join(workflowDir, 'workflow.yml'), [
  `id: ${WORKFLOW_ID}`,
  'name: Native Writer Leg',
  'version: 1',
  'description: minimal worktree fixture run for the native-writer live leg (never dispatched)',
  'run:',
  '  workspace: worktree',
  'agents:',
  '  - id: dev',
  '    model: fake',
  '    workspace:',
  '      baseDir: .',
  'steps:',
  '  - id: noop',
  '    agent: dev',
  '    input: no-op calibration step (never dispatched)',
  '    expects: STATUS, CHANGES, TESTS',
  '',
].join('\n'), 'utf8');

// ── NON-DISPATCHING registration TRANSPORT stub (random loopback port) ────
// Clearly labeled testdouble: answers the control-plane health/register/
// nudge/terminate calls the native writers make but NEVER schedules anything.
let stubPort;
const stubServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    // Guarded decode: a non-JSON (or malformed/oversized) body must produce a
    // 4xx error RESPONSE, never an uncaught throw inside the handler (which
    // would crash the whole probe mid-leg).
    let received = {};
    if (body.length > 0) {
      try {
        received = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'non-JSON body', path: req.url }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, received }));
  });
});
const closeOwnedListener = (server, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`owned stub listener close did not complete within ${timeoutMs}ms (unknown outcome)`)), timeoutMs);
  const finish = (err) => { clearTimeout(timer); if (err) reject(err); else resolve(); };
  try {
    server.close(finish);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  } catch (err) {
    clearTimeout(timer);
    reject(err);
  }
});

function closeOwnedDb(db) {
  try { db.close(); return { observed: true }; } catch (error) { return { observed: false, error: String(error?.stack ?? error) }; }
}

// pollUntil: bounded deterministic wait for an expected state, instead of a
// fixed sleep. Polls `predicate` every intervalMs until it returns a truthy
// value (that value is returned) or the timeout elapses (throws with the last
// observation). Used wherever the probe previously slept a fixed settle() for
// async native bookkeeping or listener release to catch up.
async function pollUntil(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'expected state' }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}: expected state not reached within ${timeoutMs}ms (last observation: ${JSON.stringify(last)})`);
}

// dbSnapshotCopy: checkpoint the open native DB (journal_mode=WAL) into the
// main db.sqlite file, then copy it read-only (0400) to the sidecar dir. The
// probe is the ONLY DB writer here (no daemon/dispatch), so a checkpoint +
// immediate copy is a faithful snapshot.
function dbSnapshotCopy(databaseHandle, destinationPath) {
  databaseHandle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(process.env.TAMANDUA_DB_PATH, destinationPath);
  fs.chmodSync(destinationPath, 0o400);
}

// wrapper helper: drive the ACTUAL oracle executable against a sidecar dir.
function invokeWrapper(oraclePath, sidecarPath, dir) {
  const result = spawnSync(process.execPath, [oraclePath, '--contract-version', '1', '--sidecar', sidecarPath], {
    cwd: dir,
    env: { ...process.env },
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  const response = JSON.parse(result.stdout.trim());
  const errors = validateOracleResponse(response, path.basename(oraclePath), result.status, dir);
  if (errors.length > 0) throw new Error(`${path.basename(oraclePath)} response invalid: ${errors.join('; ')}`);
  return { response, status: result.status };
}

const closure = { listener_close: { observed: false }, db_close: { observed: false } };
let closedStubInTry = false;
const report = {
  probe: 'native-writer-leg',
  kind: 'real-native-run-worktree-writer-proof',
  head_pin: HEAD_PIN,
  repo_root: REPO_ROOT,
  product_dist: DIST_DIR,
  product_stable_src: STABLE_SRC,
  api_match: apiMatch,
  api_match_result: { insert_columns_match: insertMatch, ddl_columns_match: ddlMatch },
  isolation: {
    root, home, state_dir: state, db_path: process.env.TAMANDUA_DB_PATH,
    worktree_root: wtRoot, tmpdir: tmp, test_guard: process.env.TAMANDUA_TEST_GUARD,
  },
  events: [],
};
let failure = null;
let db = null;
try {
  await new Promise((resolve, reject) => {
    stubServer.once('error', reject);
    stubServer.listen(0, '127.0.0.1', () => resolve());
  });
  stubPort = stubServer.address().port;
  process.env.TAMANDUA_CONTROL_PORT = String(stubPort);
  report.events.push({ event: 'control_stub_listening', port: stubPort });

  // Real native writers from the stable matched dist.
  const { runWorkflow } = await import(path.join(DIST_DIR, 'installer', 'run.js'));
  const { forceFailRun } = await import(path.join(DIST_DIR, 'installer', 'status.js'));
  const { getDb } = await import(path.join(DIST_DIR, 'db.js'));
  db = getDb();

  // REAL run/worktree writer: create the fixture run + managed worktree.
  const created = await runWorkflow({
    workflowId: WORKFLOW_ID,
    taskTitle: 'native-writer-leg fixture run (real native writer)',
    worktreeOriginRepository: origin,
  });
  report.events.push({ event: 'run_created', run_id: created.runId, run_number: created.runNumber, status: created.status, daemon_warning: created.daemonWarning ?? null });
  const runId = created.runId;
  const runRow = db.prepare('SELECT id, run_number, workflow_id, status, scheduling_status, created_at, updated_at FROM runs WHERE id = ?').get(runId);
  const wtRows = db.prepare('SELECT * FROM run_worktrees ORDER BY created_at').all();
  const stepRows = db.prepare('SELECT count(*) AS n FROM steps WHERE run_id = ?').get(runId).n;
  const wt = wtRows[0];
  if (wt === undefined || runRow === undefined) throw new Error('native writer created no run/run_worktrees row');
  report.writer_created = { run_row: runRow, run_worktrees_rows: wtRows, step_rows: stepRows };
  const managedSubRoot = path.dirname(wt.worktree_path);
  report.managed_subroot = managedSubRoot;

  // O6 capture 1 — PRE-terminal (run 'running' as the real writer left it).
  {
    const sidecarDir = path.join(evidenceDir, 'o6-pre-terminal');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const dbCopy = path.join(sidecarDir, 'db.sqlite');
    dbSnapshotCopy(db, dbCopy);
    const snapshot = readRunWorktreesSnapshot(dbCopy);
    if (!snapshot.available) throw new Error(`readRunWorktreesSnapshot pre-terminal unavailable: ${snapshot.reason}`);
    const disk = captureManagedRootListing(managedSubRoot);
    const gitList = captureGitWorktreeList(origin);
    const metadata = captureGitWorktreesMetadata(originCommon);
    const branches = captureBranches(origin);
    for (const [name, text] of [
      ['worktree-list.txt', spawnSync('git', ['-C', origin, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout],
      ['worktrees-metadata.txt', JSON.stringify(metadata.rows, null, 2)],
      ['branches.txt', spawnSync('git', ['-C', origin, 'for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)', 'refs/heads'], { encoding: 'utf8' }).stdout],
    ]) {
      const rel = `o6-captures/origin-0/${name}`;
      const abs = path.join(sidecarDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, { flag: 'wx' });
    }
    const evidenceFiles = ['worktree-list.txt', 'worktrees-metadata.txt', 'branches.txt'].map((name) => {
      const rel = `o6-captures/origin-0/${name}`;
      return { path: rel, sha256: sha256File(path.join(sidecarDir, rel)), kind: 'raw-git-capture', captured_at: new Date().toISOString(), tool: 'git', exit_code: 0 };
    });
    const sidecar = {
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O6',
      produced_at: new Date().toISOString(),
      producer: { name: 'native-writer-leg', version: '1' },
      campaign: {
        id: 'campaign-native-writer-leg-pre', run_ids: [`run-${runId}`],
        window: { start_utc: new Date(Date.parse(runRow.created_at) - 1000).toISOString(), end_utc: new Date().toISOString() },
        host: { platform: process.platform, scope_layer: 'none', scope_pattern: null },
      },
      evidence_files: evidenceFiles,
      diagnostics: [],
      o6: {
        database: { path: 'db.sqlite', sha256: sha256File(dbCopy), schema: 'native-run_worktrees-v1' },
        roots: {
          worktree_root: managedSubRoot,
          origins: [{ repository: origin, git_common_dir: originCommon, admitted_branch_roots: ['refs/heads/feature', 'refs/heads/fix'] }],
        },
        disk: { entries: disk.rows, exact_count: disk.exact_count, capped: disk.capped, tool: disk.tool },
        git: { origins: [{ origin_index: 0, worktree_list: gitList, worktrees_metadata: metadata, branches }] },
        prune: {
          executed: false,
          refusal: 'native-writer-leg: no prune/worktree removal is authorized in this stage; prune/age is a documented NOT_RUN leg for independent coordinator review of the exact disposable root/DB/path set and code',
          plan: { clone_root: path.join(root, 'prune-clone'), closed_scope: true, remap_note: 'the future prune probe must remap the disposable root/worktree paths inside a wholly independent fresh clone — never original live worktree paths' },
        },
      },
    };
    const sidecarPath = path.join(sidecarDir, 'sidecar.json');
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    const outcome = invokeWrapper(O6_ORACLE, sidecarPath, sidecarDir);
    if (outcome.response.result !== 'PASS' || outcome.status !== 0) throw new Error(`O6 pre-terminal wrapper not PASS: ${JSON.stringify(outcome.response)}`);
    report.events.push({ event: 'o6_pre_terminal', result: 'PASS', run_status: 'running', findings: outcome.response.findings.map((f) => f.id) });
  }

  // REAL native terminal writer: force-fail the run (keeps the worktree).
  const ff = await forceFailRun(runId, 'native-writer-leg terminal characterization (kept worktree)');
  if (!ff.ok) throw new Error(`forceFailRun not ok: ${JSON.stringify(ff)}`);
  // Deterministic wait for the native terminal transition (replaces a fixed
  // settle sleep): poll until the run row is failed (scheduling_status
  // cleared) AND the run_worktrees row is the expected retained ready/keep row
  // — exactly the state the O6 POST-terminal snapshot must capture.
  const terminal = await pollUntil(() => {
    const runRow = db.prepare('SELECT id, status, scheduling_status FROM runs WHERE id = ?').get(runId);
    if (runRow === undefined || runRow.status !== 'failed') return null;
    const wtRows = db.prepare('SELECT run_id, status, cleanup_policy, removed_at FROM run_worktrees').all();
    if (wtRows.length !== 1 || wtRows[0].cleanup_policy !== 'keep' || wtRows[0].status !== 'ready' || wtRows[0].removed_at !== null) return null;
    return { run_row: runRow, run_worktrees_rows: wtRows };
  }, { timeoutMs: 5000, intervalMs: 25, label: 'native terminal-keep state (run failed; ready keep worktree retained)' });
  report.terminal = { force_fail: ff, run_row: terminal.run_row, run_worktrees_rows: terminal.run_worktrees_rows };
  // Characterize: native default cleanup_policy is 'keep'; forceFailRun marks the
  // run failed but does NOT remove/alter the ready worktree (retained-after-
  // terminal is the current native contract; the DB column DEFAULT is
  // remove_on_success but createRunWorktree explicitly writes 'keep'). The
  // poll above pins exactly that state before any snapshot is taken.

  // O6 capture 2 — POST-terminal (run failed + ready keep => O6_RETAINED_BY_POLICY).
  {
    const sidecarDir = path.join(evidenceDir, 'o6-post-terminal');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const dbCopy = path.join(sidecarDir, 'db.sqlite');
    dbSnapshotCopy(db, dbCopy);
    const snapshot = readRunWorktreesSnapshot(dbCopy);
    if (!snapshot.available) throw new Error(`readRunWorktreesSnapshot post-terminal unavailable: ${snapshot.reason}`);
    const disk = captureManagedRootListing(managedSubRoot);
    const gitList = captureGitWorktreeList(origin);
    const metadata = captureGitWorktreesMetadata(originCommon);
    const branches = captureBranches(origin);
    const sidecar = {
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O6',
      produced_at: new Date().toISOString(),
      producer: { name: 'native-writer-leg', version: '1' },
      campaign: {
        id: 'campaign-native-writer-leg-post', run_ids: [`run-${runId}`],
        window: { start_utc: new Date(Date.parse(runRow.created_at) - 1000).toISOString(), end_utc: new Date().toISOString() },
        host: { platform: process.platform, scope_layer: 'none', scope_pattern: null },
      },
      evidence_files: [],
      diagnostics: [],
      o6: {
        database: { path: 'db.sqlite', sha256: sha256File(dbCopy), schema: 'native-run_worktrees-v1' },
        roots: {
          worktree_root: managedSubRoot,
          origins: [{ repository: origin, git_common_dir: originCommon, admitted_branch_roots: ['refs/heads/feature', 'refs/heads/fix'] }],
        },
        disk: { entries: disk.rows, exact_count: disk.exact_count, capped: disk.capped, tool: disk.tool },
        git: { origins: [{ origin_index: 0, worktree_list: gitList, worktrees_metadata: metadata, branches }] },
        prune: {
          executed: false,
          refusal: 'native-writer-leg: no prune/worktree removal is authorized in this stage; prune/age is a documented NOT_RUN leg',
          plan: { clone_root: path.join(root, 'prune-clone'), closed_scope: true, remap_note: 'the future prune probe must remap the disposable root/worktree paths inside a wholly independent fresh clone' },
        },
      },
    };
    const sidecarPath = path.join(sidecarDir, 'sidecar.json');
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    const outcome = invokeWrapper(O6_ORACLE, sidecarPath, sidecarDir);
    if (outcome.response.result !== 'PASS' || outcome.status !== 0) throw new Error(`O6 post-terminal wrapper not PASS: ${JSON.stringify(outcome.response)}`);
    const ids = outcome.response.findings.map((f) => f.id);
    if (!ids.includes('O6_RETAINED_BY_POLICY') || !ids.includes('O6_PRUNE_LEG_NOT_RUN')) {
      throw new Error(`O6 post-terminal missing characterization findings: ${JSON.stringify(ids)}`);
    }
    report.events.push({ event: 'o6_post_terminal', result: 'PASS', run_status: 'failed', findings: ids });
  }

  // O5 leg: the stub listener (exact owned handle) observed by the CORRECTED
  // recorder alive (FAIL) then released exactly (PASS) through the real O5.
  {
    const selfPid = process.pid;
    const liveListeners = snapshotOwnedListeners([stubPort]);
    if (liveListeners.tool.exit_code !== 0 || liveListeners.rows.length !== 1) {
      throw new Error(`O5 recorder must observe the owned stub listener alive: ${JSON.stringify(liveListeners)}`);
    }
    const window = { start_utc: new Date(Date.now() - 60_000).toISOString(), end_utc: new Date().toISOString() };
    const o5Sidecar = (listeners) => ({
      schema_version: 1, sidecar_kind: 'post-batch-hygiene', oracle_id: 'O5',
      produced_at: new Date().toISOString(),
      producer: { name: 'native-writer-leg', version: '1' },
      campaign: {
        id: 'campaign-native-writer-leg', run_ids: [`run-${runId}`], window,
        host: { platform: process.platform, scope_layer: 'none', scope_pattern: null },
      },
      evidence_files: [], diagnostics: [],
      o5: {
        scope: {
          contained_paths: [origin, managedSubRoot], host_admitted_paths: [],
          cgroup_pattern: null,
          daemon_restarts: [],
        },
        admissions: [{
          id: 'registration-stub', kind: 'listener', run_id: null, pid: selfPid, pgid: null,
          start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: null,
          expect: 'gone', required_layers: ['pgid-ancestry', 'path-fd', 'start-window'],
          listen_specs: [{ protocol: 'tcp', address: '127.0.0.1', port: stubPort }],
        }],
        coverage: {
          scope: { status: 'not_applicable', note: 'no scope layer on this host profile; layer 1 not applicable' },
          'pgid-ancestry': { status: 'available', note: null },
          'path-fd': { status: 'available', note: null },
          'start-window': { status: 'available', note: null },
        },
        observations: {
          scope_members: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
          processes: snapshotOwnedProcesses([]),
          listeners,
          shared_toolchain: { rows: [], exact_count: 0, capped: false, tool: { name: 'n/a', exit_code: 0 }, spans: [] },
        },
        census: { complete: true, notes: [] },
      },
    });
    const aliveDir = path.join(evidenceDir, 'o5-stub-alive');
    fs.mkdirSync(aliveDir, { recursive: true });
    const alivePath = path.join(aliveDir, 'sidecar.json');
    fs.writeFileSync(alivePath, `${JSON.stringify(o5Sidecar(liveListeners), null, 2)}\n`);
    const aliveOutcome = invokeWrapper(O5_ORACLE, alivePath, aliveDir);
    if (aliveOutcome.response.result !== 'FAIL' || !aliveOutcome.response.findings.some((f) => f.id === 'O5_LEFTOVER_LISTENER')) {
      throw new Error(`O5 alive stub listener must FAIL with O5_LEFTOVER_LISTENER: ${JSON.stringify(aliveOutcome.response)}`);
    }
    report.events.push({ event: 'o5_stub_alive', result: 'FAIL', finding: 'O5_LEFTOVER_LISTENER' });

    // EXACT owned-handle release: close the stub listener, positively observe
    // the close, then verify the CORRECTED recorder sees the port released and
    // the real O5 wrapper certifies clean.
    await closeOwnedListener(stubServer);
    closure.listener_close.observed = true;
    closedStubInTry = true;
    report.events.push({ event: 'control_stub_closed', port: stubPort });
    // Deterministic wait for the OS to actually release the port (replaces a
    // fixed settle sleep): poll the CORRECTED recorder until it observes the
    // port released (clean no-match normalized to exit_code 0, zero rows),
    // bounded — no blind race window under load.
    const releasedListeners = await pollUntil(() => {
      const census = snapshotOwnedListeners([stubPort]);
      return census.tool.exit_code === 0 && census.rows.length === 0 ? census : null;
    }, { timeoutMs: 5000, intervalMs: 50, label: `port ${stubPort} released (recorder clean census)` });
    const releasedDir = path.join(evidenceDir, 'o5-stub-released');
    fs.mkdirSync(releasedDir, { recursive: true });
    const releasedPath = path.join(releasedDir, 'sidecar.json');
    fs.writeFileSync(releasedPath, `${JSON.stringify(o5Sidecar(releasedListeners), null, 2)}\n`);
    const releasedOutcome = invokeWrapper(O5_ORACLE, releasedPath, releasedDir);
    if (releasedOutcome.response.result !== 'PASS' || releasedOutcome.status !== 0) {
      throw new Error(`O5 released stub listener must certify clean PASS: ${JSON.stringify(releasedOutcome.response)}`);
    }
    report.events.push({ event: 'o5_stub_released', result: 'PASS' });
  }
} catch (error) {
  failure = error;
} finally {
  // POSITIVE exact owned-handle closure (listener + DB), observed. If the stub
  // was already closed and observed inside the try, no second close is needed.
  if (!closedStubInTry && typeof stubServer?.close === 'function') {
    try {
      await closeOwnedListener(stubServer);
      closure.listener_close.observed = true;
    } catch (error) {
      closure.listener_close.observed = false;
      closure.listener_close.error = String(error?.stack ?? error);
    }
  }
  if (db !== null) closure.db_close = closeOwnedDb(db);
}

// ── workspace receipt (retained; no recursive disposal) ───────────────────
const identity = fs.lstatSync(root);
const workspaceReceipt = {
  kind: 'native-writer-leg-workspace',
  root,
  ownership: { dev: identity.dev, ino: identity.ino },
  origin_repository: origin,
  managed_worktree_subroot: report.managed_subroot ?? null,
  control_port: stubPort ?? null,
  created_at: new Date().toISOString(),
  retained: 'retained intentionally — repos/worktrees/DBs are never removed by this stage (exact owned listener/server/DB handles closed positively)',
};
fs.writeFileSync(path.join(root, 'leg-receipt.json'), `${JSON.stringify(workspaceReceipt, null, 2)}\n`, { flag: 'wx' });
report.workspace_receipt = workspaceReceipt;
report.closure = closure;
report.failure = failure ? String(failure?.stack ?? failure) : undefined;

console.log(JSON.stringify(report, null, 2));
const closureObserved = closure.listener_close.observed === true && closure.db_close.observed === true;
if (failure !== null || !closureObserved) process.exit(1);
process.exit(0);
