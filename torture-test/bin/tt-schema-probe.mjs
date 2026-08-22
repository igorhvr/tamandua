#!/usr/bin/env node
// tt-schema-probe.mjs — S15 US-002: schema-handshake parity probe for the
// contained TT daemon's database.
//
// Verifies that the contained DB satisfies the SQL surface tt-controller's
// status queries depend on (the exact SELECT column lists from
// src/installer/status.ts: the runs SELECT carries worker_lost_count and
// ceiling_expiry_count; the steps harvest SELECT carries step_id, agent_id,
// step_index, status, type, current_story_id, retry_count, abandoned_count,
// reroute_count, claim_pid, claim_updated_at, updated_at). A missing table
// or column is a PARITY FAILURE: an unmigrated persisted DB (campaign #8
// attempt-2: the contained daemon was restarted on the current dist but the
// DB itself was unmigrated -> tt-controller's first status poll crashed on
// "no such column: ceiling_expiry_count" and killed the whole campaign
// controller) must never be reused.
//
// Read-only: opens the DB with node:sqlite DatabaseSync({ readOnly: true })
// — the same pattern tt-controller's localDatabaseTokenEvidence uses (node
// >= 22 guaranteed). A probe run NEVER writes: the DB bytes are untouched
// (the test battery pins this with sha256 before/after).
//
// Containment: the probed DB path must resolve STRICTLY inside
// torture-test/var (the contained TT root — never the operator's
// ~/.tamandua or any other home). A path outside var is REJECTED with a
// containment-violation before the DB is ever opened.
//
// Seams (test-only — let the battery build a stale-schema fixture DB in a
// temp dir under torture-test/var without touching the real contained DB):
//   TT_DAEMON_SCHEMA_PROBE_DB            override the DB path (default:
//                                        ${TAMANDUA_STATE_DIR}/tamandua.db)
//   TT_DAEMON_SCHEMA_PROBE_COLUMNS_FILE  override the required-columns JSON
//                                        ({ "<table>": ["col", ...], ... };
//                                        default: the exact tt-controller
//                                        status SELECT surface below)
//
// Output contract (all on stdout, exit code on stderr-free status):
//   SCHEMA: ok                                                  exit 0
//   SCHEMA: fail + DETAILS: missing table: <t>                 exit 1
//   SCHEMA: fail + DETAILS: missing column: <t>.<c>            exit 1
//   SCHEMA: fail + REASON: containment-violation + DETAILS     exit 2
//   SCHEMA: fail + DETAILS: <other error>                      exit 1
//
// tt-daemon-up consumes only the exit code (0 = parity OK, non-zero =
// schema-parity failure) and the DETAILS lines (embedded in its fail-closed
// report).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// The exact SELECT surface tt-controller's status queries depend on
// (src/installer/status.ts). A missing table or column is a parity failure.
const DEFAULT_REQUIRED_COLUMNS = {
  runs: [
    'id', 'run_number', 'workflow_id', 'task', 'status', 'context',
    'created_at', 'updated_at', 'tokens_spent', 'worker_lost_count',
    'ceiling_expiry_count',
  ],
  steps: [
    'step_id', 'agent_id', 'step_index', 'status', 'type', 'current_story_id',
    'retry_count', 'abandoned_count', 'reroute_count', 'claim_pid',
    'claim_updated_at', 'updated_at',
  ],
};

// The contained root: <repo>/torture-test/var (repo root = ../../.. from
// this file's dir, exactly like tt-daemon-up's own TT_REPO_ROOT).
const HERE = path.dirname(fileURLToPath(import.meta.url)); // torture-test/bin
const TT_DIR = path.dirname(HERE);                         // torture-test/
const TT_ROOT = path.dirname(TT_DIR);                      // repo root
const VAR_ROOT = path.join(TT_ROOT, 'torture-test', 'var');

// pathIsWithin: candidate resolves strictly inside root (root itself
// rejected) — mirrors tt-containment.mjs's containment semantics.
function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// resolveExistingRealPath: resolve `candidate` to a real path WITHOUT
// requiring it to exist — walk up to the nearest existing ancestor, use its
// realpath, and re-append the missing tail segments. (The DB path may not
// exist yet on a fresh checkout; the containment verdict must still be
// about where the path WILL live, never about an operator-owned file.)
function resolveExistingRealPath(candidate) {
  let current = candidate;
  const tail = [];
  for (;;) {
    let real;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`cannot resolve ${current}: ${error.message}`);
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    return path.join(real, ...tail);
  }
}

// identifierOk: PRAGMA table_info takes the table name as raw SQL — the
// required-columns map is either our own constant or a test seam file, but
// fail closed on anything that is not a plain SQL identifier anyway.
function identifierOk(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function main() {
  let dbPath = process.env.TT_DAEMON_SCHEMA_PROBE_DB;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    const stateDir = process.env.TAMANDUA_STATE_DIR;
    if (typeof stateDir === 'string' && stateDir.trim() !== '') {
      dbPath = path.join(stateDir, 'tamandua.db');
    } else {
      console.log('SCHEMA: fail');
      console.log('DETAILS: no DB path to probe — set TT_DAEMON_SCHEMA_PROBE_DB or TAMANDUA_STATE_DIR');
      return 1;
    }
  }
  dbPath = path.resolve(dbPath);

  // ── Containment guard: never probe a DB outside torture-test/var. ──
  let resolved;
  try {
    resolved = resolveExistingRealPath(dbPath);
  } catch (error) {
    console.log('SCHEMA: fail');
    console.log('DETAILS: cannot resolve database path: ' + error.message);
    return 1;
  }
  const varReal = fs.realpathSync(VAR_ROOT);
  if (resolved === null || !pathIsWithin(varReal, resolved)) {
    console.log('SCHEMA: fail');
    console.log('REASON: containment-violation');
    console.log(`DETAILS: database path ${dbPath} is outside the contained root ${VAR_ROOT} — refusing to probe an operator-owned DB`);
    return 2;
  }

  // ── Required-columns seam (test-only override of the SELECT surface). ──
  let required = DEFAULT_REQUIRED_COLUMNS;
  const columnsFile = process.env.TT_DAEMON_SCHEMA_PROBE_COLUMNS_FILE;
  if (typeof columnsFile === 'string' && columnsFile.trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(columnsFile, 'utf8'));
    } catch (error) {
      console.log('SCHEMA: fail');
      console.log(`DETAILS: cannot read required-columns file ${columnsFile}: ${error.message}`);
      return 1;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.log('SCHEMA: fail');
      console.log(`DETAILS: required-columns file ${columnsFile} must be a JSON object of { "<table>": ["col", ...] }`);
      return 1;
    }
    required = parsed;
  }
  for (const table of Object.keys(required)) {
    if (!identifierOk(table)) {
      console.log('SCHEMA: fail');
      console.log(`DETAILS: required-columns file names an invalid table identifier: ${table}`);
      return 1;
    }
  }

  // ── Read-only schema probe (PRAGMA table_info per required table). ──
  let database;
  try {
    database = new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    console.log('SCHEMA: fail');
    console.log(`DETAILS: cannot open database ${dbPath} read-only: ${error.message}`);
    return 1;
  }
  try {
    const tables = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    );
    const missing = [];
    for (const [table, columns] of Object.entries(required)) {
      if (!tables.has(table)) {
        missing.push(`missing table: ${table}`);
        continue;
      }
      const present = new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
      for (const column of columns) {
        if (!present.has(column)) missing.push(`missing column: ${table}.${column}`);
      }
    }
    if (missing.length > 0) {
      console.log('SCHEMA: fail');
      for (const item of missing) console.log(`DETAILS: ${item}`);
      return 1;
    }
    console.log('SCHEMA: ok');
    return 0;
  } finally {
    database.close();
  }
}

process.exitCode = main();
