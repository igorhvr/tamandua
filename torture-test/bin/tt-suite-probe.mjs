#!/usr/bin/env node
// tt-suite-probe.mjs — S26 US-004: campaign-start suite-state probe for the
// contained real TT daemon's database.
//
// Counts rows in the contained `suite_results` ledger (the TSTX suite-results
// table the tamandua daemon appends to on every test execution). A FRESH
// real-campaign preflight must start from KNOWN-CLEAN contained suite state:
// ANY row — stale cross-campaign (attempt-1: a contained-real-daemon DB
// carrying 106 rows since 08-13 poisoned O10/O9) or accumulated
// intra-campaign — means the contained suite ledger is not clean, and the
// campaign must refuse to start (fail closed) with operator guidance on how
// to reset the contained real state. The resume path NEVER requires an empty
// suite (resume reconciles the persisted state from the previous attempt —
// MACP7's per-campaign minimum), so this probe is wired into tt-daemon-up
// `ensure-up --fresh` ONLY (see tt-daemon-up for the fresh-vs-resume
// threading; the scripted daemon already has MACP7 reset-state, the real
// contained daemon deliberately does NOT — the chosen design is refuse +
// documented operator reset seam, never an automatic destructive reset).
//
// Read-only: opens the DB with node:sqlite DatabaseSync({ readOnly: true })
// — the same pattern tt-schema-probe.mjs uses (node >= 22 guaranteed). A
// probe run NEVER writes: the DB bytes are untouched (the test battery pins
// this with sha256 before/after).
//
// Containment: the probed DB path must resolve STRICTLY inside
// torture-test/var (the contained TT root — never the operator's
// ~/.tamandua or any other home). A path outside var is REJECTED with a
// containment-violation before the DB is ever opened.
//
// Seams (test-only — let the battery build a fixture DB with/without
// suite_results rows in a temp dir under torture-test/var without touching
// the real contained DB):
//   TT_DAEMON_SUITE_PROBE_DB   override the DB path (default:
//                              ${TAMANDUA_STATE_DIR}/tamandua.db)
//
// Output contract (all on stdout, exit code on stderr-free status):
//   SUITE: ok + SUITE_ROWS: 0                        exit 0  (clean)
//   SUITE: fail + REASON: suite-state-not-clean
//           + SUITE_ROWS: N + DETAILS: ...           exit 1  (non-empty)
//   SUITE: fail + REASON: containment-violation
//           + DETAILS: ...                           exit 2
//   SUITE: fail + DETAILS: <other error>             exit 1  (unverifiable DB)
//
// tt-daemon-up consumes only the exit code (0 = clean, non-zero = suite-state
// failure) and the REASON/DETAILS/SUITE_ROWS lines (embedded in its
// fail-closed report).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// The contained root: <repo>/torture-test/var (repo root = ../../.. from
// this file's dir, exactly like tt-schema-probe.mjs's own TT_ROOT).
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

function main() {
  let dbPath = process.env.TT_DAEMON_SUITE_PROBE_DB;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    const stateDir = process.env.TAMANDUA_STATE_DIR;
    if (typeof stateDir === 'string' && stateDir.trim() !== '') {
      dbPath = path.join(stateDir, 'tamandua.db');
    } else {
      console.log('SUITE: fail');
      console.log('DETAILS: no DB path to probe — set TT_DAEMON_SUITE_PROBE_DB or TAMANDUA_STATE_DIR');
      return 1;
    }
  }
  dbPath = path.resolve(dbPath);

  // ── Containment guard: never probe a DB outside torture-test/var. ──
  let resolved;
  try {
    resolved = resolveExistingRealPath(dbPath);
  } catch (error) {
    console.log('SUITE: fail');
    console.log('DETAILS: cannot resolve database path: ' + error.message);
    return 1;
  }
  const varReal = fs.realpathSync(VAR_ROOT);
  if (resolved === null || !pathIsWithin(varReal, resolved)) {
    console.log('SUITE: fail');
    console.log('REASON: containment-violation');
    console.log(`DETAILS: database path ${dbPath} is outside the contained root ${VAR_ROOT} — refusing to probe an operator-owned DB`);
    return 2;
  }

  // ── Read-only suite-state probe (COUNT the suite_results ledger). ──
  let database;
  try {
    database = new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    console.log('SUITE: fail');
    console.log(`DETAILS: cannot open database ${dbPath} read-only: ${error.message}`);
    return 1;
  }
  try {
    const row = database.prepare('SELECT COUNT(*) AS cnt FROM suite_results').get();
    const count = row === null || row === undefined ? 0 : Number(row.cnt);
    if (count > 0) {
      // ── FAIL CLOSED: a FRESH campaign must start known-clean. ────────
      console.log('SUITE: fail');
      console.log('REASON: suite-state-not-clean');
      console.log(`SUITE_ROWS: ${count}`);
      console.log(`DETAILS: contained suite_results ledger holds ${count} row(s) — a FRESH campaign must start with an EMPTY contained suite ledger (S26: cross-campaign contamination). Reset the contained real state: (1) stop the contained daemon (torture-test/bin/tt-daemon-up stop), (2) remove the contained real state dir ${dbPath} (e.g. rm -rf the parent TAMANDUA_STATE_DIR under torture-test/var — never ~/.tamandua or the 33xx daemon), (3) re-run the campaign — the preflight re-provisions the home and the daemon start recreates a fresh DB.`);
      return 1;
    }
    console.log('SUITE: ok');
    console.log('SUITE_ROWS: 0');
    return 0;
  } catch (error) {
    // A missing suite_results table means the DB is unmigrated/anomalous —
    // unverifiable is never a silent pass (fail closed, like the schema
    // probe). In the wired ensure-up flow the daemon start migrates the DB
    // before this probe runs, so this only fires on a genuinely broken DB.
    console.log('SUITE: fail');
    console.log(`DETAILS: cannot count suite_results in ${dbPath}: ${error.message}`);
    return 1;
  } finally {
    database.close();
  }
}

process.exitCode = main();
