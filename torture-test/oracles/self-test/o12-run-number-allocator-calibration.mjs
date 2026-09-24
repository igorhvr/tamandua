#!/usr/bin/env node

// o12-run-number-allocator-calibration.mjs — retained SQL-replica allocator
// replay (EXPLICITLY named calibration, Storm O12-close correction D).
//
// This is the honest SQL REPLICA of the MAX+1 run_number allocator: it copies
// the product's allocation statement (self-pinned against src/installer/run.ts)
// into a fabricated runs-only table. It is NOT the real-API observation of run
// creation/deletion and is kept strictly distinct from it: the REAL-API
// characterization lives in o12-run-number-probe.mjs (createA/createB via
// runWorkflow, exact owned run-B deletion via deleteWorkflow, createC) which
// this calibration can never replace. Retained only as an optional, explicitly
// named replay useful for pure allocator-statement checks.
//
// Isolation: private HOME/TAMANDUA_STATE_DIR/TAMANDUA_DB_PATH/TMPDIR +
// TAMANDUA_TEST_GUARD=1. The workspace is RETAINED and a receipt is published
// (no recursive filesystem disposal).
//
// Exit 0 + JSON result on success; nonzero exit on any deviation.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const RUN_TS = path.join(REPO_ROOT, 'src', 'installer', 'run.ts');

// The product's real run-row INSERT, byte-for-byte from src/installer/run.ts
// (both direct and worktree launch arms use this identical statement). The
// probe re-extracts it below and requires an exact match against the source
// literal so the replay tracks the shipped allocator.
const EXPECTED_ALLOCATOR_SQL = `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                         scheduling_status, scheduling_requested_at, notify_url,
                         parent_run_id, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs), ?, ?, 'running', ?, 0, 'pending_register', ?, ?, ?, ?, ?)`;

function extractAllocatorSql(source) {
  // Extract every run-row INSERT that carries the MAX+1 allocator subquery and
  // return the first; the probe below additionally requires that ALL such
  // arms normalize identically (direct + worktree launch arms are identical
  // today), so the replay cannot silently track a drifted subset.
  const arms = [];
  let cursor = 0;
  while (true) {
    const allocStart = source.indexOf('(SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs)', cursor);
    if (allocStart < 0) break;
    const snippetStart = source.lastIndexOf('INSERT INTO runs', allocStart);
    if (snippetStart < 0) return null;
    const snippetEnd = source.indexOf(').run(', allocStart);
    if (snippetEnd < 0) return null;
    // The template-literal close (` and trailing comma after the VALUES
    // closing paren) are not part of the SQL; strip them so the replay
    // literal compares against the pure statement.
    arms.push(source.slice(snippetStart, snippetEnd).trim().replace(/[`,]+$/, ''));
    cursor = snippetEnd + 1;
  }
  if (arms.length === 0) return null;
  const normalized = new Set(arms.map(normalizeSql));
  if (normalized.size !== 1) return null; // arms drifted apart — refuse to replay
  return arms[0];
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

const source = fs.readFileSync(RUN_TS, 'utf8');
const sourceSha = createHash('sha256').update(source).digest('hex');
const extracted = extractAllocatorSql(source);
if (extracted === null) {
  console.error('allocator INSERT not found in src/installer/run.ts');
  process.exit(2);
}
if (normalizeSql(extracted) !== normalizeSql(EXPECTED_ALLOCATOR_SQL)) {
  console.error('embedded allocator SQL drifted from src/installer/run.ts — refresh the probe literal');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o12-run-number-allocator-calibration.'));
const home = path.join(root, 'home');
const stateDir = path.join(root, 'state');
const tmp = path.join(root, 'tmp');
for (const dir of [home, stateDir, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
process.env.HOME = home;
process.env.TAMANDUA_STATE_DIR = stateDir;
process.env.TAMANDUA_DB_PATH = path.join(stateDir, 'tamandua.db');
process.env.TAMANDUA_TEST_GUARD = '1';
process.env.TMPDIR = tmp;
delete process.env.TAMANDUA_CONTROL_PORT;

const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
db.exec(`
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0, scheduling_status TEXT,
    scheduling_requested_at TEXT, notify_url TEXT, parent_run_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`);
const now = new Date().toISOString();
const insert = db.prepare(EXPECTED_ALLOCATOR_SQL);

function allocateRun(tag) {
  const id = `run-${tag}-${randomUUID()}`;
  // 9 bound parameters matching the real run.ts .run(...) argument order:
  // id, workflowId, taskTitle, contextJson, schedulingRequestedAt(now),
  // notifyUrl(null), parentRunId(null), created_at(now), updated_at(now).
  insert.run(id, 'wf', `task ${tag}`, '{}', now, null, null, now, now);
  return db.prepare('SELECT run_number FROM runs WHERE id = ?').get(id).run_number;
}

const numbers = [];
numbers.push({ tag: 'A', run_number: allocateRun('A') });
numbers.push({ tag: 'B', run_number: allocateRun('B') });

// Delete the highest-numbered row, then create another run.
const highest = [...numbers].sort((a, b) => b.run_number - a.run_number)[0];
db.prepare('DELETE FROM runs WHERE run_number = ?').run(highest.run_number);
const afterDelete = allocateRun('C');

// Live rows after the deletion + recreation: A plus C.
const liveRows = db.prepare('SELECT run_number FROM runs ORDER BY run_number').all().map((row) => row.run_number);
const reuseObserved = afterDelete === highest.run_number;
const uniqueLive = new Set(liveRows).size === liveRows.length;

db.close();

const identity = fs.lstatSync(root);
const workspaceReceipt = {
  kind: 'o12-run-number-allocator-calibration-workspace',
  root,
  ownership: { dev: identity.dev, ino: identity.ino },
  created_at: new Date().toISOString(),
  retained: 'retained intentionally; no recursive filesystem disposal',
};
fs.writeFileSync(path.join(root, 'probe-receipt.json'), `${JSON.stringify(workspaceReceipt, null, 2)}\n`, { flag: 'wx' });

const result = {
  probe: 'o12-run-number-allocator-calibration',
  calibration_kind: 'sql-replica',
  source_pinned: { file: 'src/installer/run.ts', sha256: sourceSha },
  allocation_policy: 'COALESCE(MAX(run_number),0)+1 (MAX+1) via INSERT subquery',
  observed: numbers,
  delete_recreate_reuse_observed: reuseObserved,
  live_rows_after: liveRows,
  live_rows_unique: uniqueLive,
  // SQL replica caveat: this replays the allocator statement against a
  // fabricated runs-only table; it is NOT the real-API observation (see
  // o12-run-number-probe.mjs). It is retained only as an optional, explicitly
  // named allocator-statement calibration.
  characterization: 'deleting the highest-numbered row then creating another run reuses max+1 (native allocator semantics)',
  workspace_receipt: workspaceReceipt,
};
console.log(JSON.stringify(result, null, 2));
if (!reuseObserved || !uniqueLive) process.exit(1);
process.exit(0);
