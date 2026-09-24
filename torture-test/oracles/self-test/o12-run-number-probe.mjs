#!/usr/bin/env node

// o12-run-number-probe.mjs — REAL-API run_number allocation characterization
// (Storm O12-close correction D).
//
// Context (Storm O12, spec 03 O12 clause 2): "unique run_numbers among live
// rows (monotonicity across deletes is characterization — MAX+1 allocation can
// reuse after deleting the newest; record, decide policy)". Deleting the
// highest-numbered row and creating another MAY reuse max+1 — that is native
// behavior (src/installer/run.ts INSERT subquery
// `(SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs)`), NOT a defect, and
// O12 must never invent a global-monotonicity failure from a snapshot.
//
// This probe OBSERVES the real current run creation/deletion APIs in a fresh
// private state: createA → createB through the product's own runWorkflow
// (dist/installer/run.js), delete exactly the owned run B through the
// product's own deleteWorkflow (dist/installer/status.js), then createC —
// proving MAX+1 delete-recreate reuse and live-row uniqueness on the actual
// native writer, NOT on a fabricated SQL replica.
//
// Registration TRANSPORT testdouble: runWorkflow's post-persist daemon
// registration (ensureDaemonControlAvailable / registerRunWithDaemon /
// nudgeWithDaemon) is answered by a narrowly labeled NON-DISPATCHING stub
// HTTP control plane on a random loopback port. The stub accepts the health /
// register / nudge / terminate calls but never schedules any step, so zero
// agents, models, or system runs are spawned; the run row/step/event writers
// are the real native code. (Same testdouble posture as aged-state seeding.)
//
// Isolation: strict private HOME/TAMANDUA_STATE_DIR/TAMANDUA_DB_PATH/TMPDIR +
// TAMANDUA_TEST_GUARD=1 (guard keeps every path under the fresh private root),
// with parent Tamandua run/worker/step authority stripped from the probe
// environment (TAMANDUA_RUN_ID / TAMANDUA_WORKER_* / TAMANDUA_CONTROL_PORT) and
// candidate/stable-dist source match verified BEFORE any fixture allocation or
// product import/operation. No managed worktree is needed for this tiny
// do-now fixture. The workspace is RETAINED and a receipt (root identity/path)
// is published — no recursive filesystem disposal (Storm O12-close C).
//
// Positive exact owned-handle closure (Storm O12 probe-close): the probe
// closes the exact owned stub listener and the exact owned DB handle and
// observes each completing without error or timeout (closure.listener_close /
// closure.db_close). A close error or unknown timeout makes the probe
// NON-green — no swallowed close failure or generic PID/name kill ever
// masquerades as a closed receipt. Safe injected close error/timeout
// negatives are driven by O12_PROBE_INJECT_DB_CLOSE_ERROR /
// O12_PROBE_INJECT_LISTENER_CLOSE_TIMEOUT (test-only).
//
// Candidate/stable-dist source match is verified before any run is created:
// the repo candidate src/installer/run.ts must be byte-identical to the
// stable dist source and must carry the same allocator INSERT statement as
// dist/installer/run.js (normalized whitespace).
//
// Exit 0 + JSON result on success; nonzero exit on any deviation.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
// Host-portable default (STORM-SEED-QUALIFY US-010): the repo's OWN dist,
// resolved from this probe's location, so the candidate/stable source-match
// guard holds on any host; TAMANDUA_O12_PROBE_DIST overrides for an external
// pinned build.
const DIST_DIR = process.env.TAMANDUA_O12_PROBE_DIST ?? path.join(REPO_ROOT, 'dist');
const RUN_TS_CANDIDATE = path.join(REPO_ROOT, 'src', 'installer', 'run.ts');
const RUN_TS_STABLE = path.join(DIST_DIR, '..', 'src', 'installer', 'run.ts');
const RUN_JS_DIST = path.join(DIST_DIR, 'installer', 'run.js');
const WORKFLOW_ID = 'o12-run-number-probe';

// Safe injected-close negatives (test-only, Storm O12 probe-close): these are
// never set in a real gate run; o12.test.mjs spawns the probe with them to
// prove that an owned-listener close that never completes (unknown timeout) or
// an owned-DB close that throws makes the probe NON-green instead of
// publishing an unconditional closed receipt.
const INJECT_DB_CLOSE_ERROR = process.env.O12_PROBE_INJECT_DB_CLOSE_ERROR === '1';
const INJECT_LISTENER_CLOSE_TIMEOUT = process.env.O12_PROBE_INJECT_LISTENER_CLOSE_TIMEOUT === '1';
const CLOSE_TIMEOUT_MS = Number(process.env.O12_PROBE_CLOSE_TIMEOUT_MS ?? 10_000);

// Positive exact-owner close helper: the owned http.Server handle is closed and
// the callback must fire without error BEFORE the bounded timeout; an error or
// an unknown timeout rejects (the probe then reports closure NOT observed).
function closeOwnedListener(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof server?.close !== 'function') {
      reject(new Error('owned listener handle has no close() — cannot positively observe closure'));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`owned listener close did not complete within ${timeoutMs}ms (unknown outcome — NOT observed as closed)`));
    }, timeoutMs);
    const finish = (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    try {
      server.close(finish);
      // Release any pooled keep-alive connections held by the product's own
      // registration fetch calls so close() completes promptly in the happy
      // path (never a generic PID/name kill — exact owned handle only).
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function normalizeSql(sql) { return sql.replace(/\s+/g, ' ').trim(); }

// Extract every run-row INSERT carrying the MAX+1 allocator subquery; require
// all arms to normalize identically (direct + worktree arms are identical).
function extractAllocatorInserts(source) {
  const arms = [];
  let cursor = 0;
  while (true) {
    const allocStart = source.indexOf('(SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs)', cursor);
    if (allocStart < 0) break;
    const snippetStart = source.lastIndexOf('INSERT INTO runs', allocStart);
    if (snippetStart < 0) return null;
    const snippetEnd = source.indexOf(').run(', allocStart);
    if (snippetEnd < 0) return null;
    arms.push(source.slice(snippetStart, snippetEnd).trim().replace(/[`,]+$/, ''));
    cursor = snippetEnd + 1;
  }
  if (arms.length === 0) return null;
  const normalized = new Set(arms.map(normalizeSql));
  if (normalized.size !== 1) return null;
  return arms[0];
}

const candidateSource = fs.readFileSync(RUN_TS_CANDIDATE, 'utf8');
const stableSource = fs.readFileSync(RUN_TS_STABLE, 'utf8');
const distSource = fs.readFileSync(RUN_JS_DIST, 'utf8');
const sourceSha = sha256(candidateSource);
const stableSourceSha = sha256(stableSource);
const candidateAllocator = extractAllocatorInserts(candidateSource);
const distAllocator = extractAllocatorInserts(distSource);
const sourceMatchesDist = stableSourceSha === sourceSha
  && candidateAllocator !== null && distAllocator !== null
  && normalizeSql(candidateAllocator) === normalizeSql(distAllocator);
if (!sourceMatchesDist) {
  console.error('candidate src/installer/run.ts does not match the stable dist run.js allocator — refusing to characterize a drifted source');
  process.exit(2);
}

// Strip parent Tamandua run/worker/step authority BEFORE any fixture
// allocation or product operation (Storm O12 probe-close): the probe must not
// run under the dispatching run's identity or reach its control plane.
const PARENT_AUTHORITY_ENV = [
  'TAMANDUA_RUN_ID',
  'TAMANDUA_WORKER_PID',
  'TAMANDUA_WORKER_PGID',
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_CONTROL_PORT',
];
const authorityStripped = PARENT_AUTHORITY_ENV.filter((name) => Object.prototype.hasOwnProperty.call(process.env, name));
for (const name of PARENT_AUTHORITY_ENV) delete process.env[name];

// ── private fresh state ────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o12-run-number-real-api.'));
const home = path.join(root, 'home');
const state = path.join(root, 'state');
const tmp = path.join(root, 'tmp');
for (const dir of [home, state, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
process.env.HOME = home;
process.env.TAMANDUA_STATE_DIR = state;
process.env.TAMANDUA_DB_PATH = path.join(state, 'tamandua.db');
process.env.TAMANDUA_TEST_GUARD = '1';
process.env.TMPDIR = tmp;
delete process.env.TAMANDUA_CONTROL_PORT;

// Seed a minimal direct-mode workflow spec into the private state so the real
// runWorkflow can load it (identical shape to the native CLI tests).
const workflowDir = path.join(state, 'workflows', WORKFLOW_ID);
fs.mkdirSync(workflowDir, { recursive: true });
fs.writeFileSync(path.join(workflowDir, 'workflow.yml'), [
  `id: ${WORKFLOW_ID}`,
  'agents:',
  '  - id: dev',
  '    model: fake',
  '    workspace:',
  '      baseDir: .',
  'steps:',
  '  - id: implement',
  '    agent: dev',
  '    input: no-op calibration step (never dispatched)',
  '    expects: STATUS, CHANGES, TESTS',
  '',
].join('\n'), 'utf8');

// ── non-dispatching registration TRANSPORT stub ───────────────────────────
// Narrowly labeled testdouble: answers the control-plane health/register/
// nudge/terminate calls the real writers make, but never schedules anything.
let controlPort;
const stubServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, received: body ? JSON.parse(body) : {} }));
  });
});

async function startStub() {
  await new Promise((resolve, reject) => {
    stubServer.once('error', reject);
    stubServer.listen(0, '127.0.0.1', () => resolve());
  });
  controlPort = stubServer.address().port;
  process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
}
await startStub();

if (INJECT_LISTENER_CLOSE_TIMEOUT) {
  // Safe injected-unknown-outcome negative (test-only): the owned listener's
  // close never invokes its callback, so the bounded-timeout closure check must
  // report the close as NOT observed and make the probe non-green.
  stubServer.close = () => {};
}

let db;
let observed;
let deletionResult;
let liveRows;
let liveUnique;
let reuseObserved;
let bGone;
let failure = null;
const closure = {
  listener_close: { observed: false },
  db_close: { observed: false },
};
try {
  // Real product writers from the stable pinned dist.
  const { runWorkflow } = await import(path.join(DIST_DIR, 'installer', 'run.js'));
  const { deleteWorkflow } = await import(path.join(DIST_DIR, 'installer', 'status.js'));
  const { getDb } = await import(path.join(DIST_DIR, 'db.js'));
  db = getDb();
  if (INJECT_DB_CLOSE_ERROR) {
    // Safe injected-close-error negative (test-only): the owned DB handle's
    // close is made to throw so the probe must report closure NOT observed and
    // exit non-green — no swallowed close failure masquerades as closed.
    db.close = () => { throw new Error('injected owned-DB close failure (probe negative control)'); };
  }

  const harnessDir = path.join(root, 'harness');
  fs.mkdirSync(harnessDir, { mode: 0o700 });

  observed = [];
  const a = await runWorkflow({ workflowId: WORKFLOW_ID, taskTitle: 'createA', workingDirectoryForHarness: harnessDir });
  observed.push({ tag: 'A', run_id: a.runId, run_number: a.runNumber });
  const b = await runWorkflow({ workflowId: WORKFLOW_ID, taskTitle: 'createB', workingDirectoryForHarness: harnessDir });
  observed.push({ tag: 'B', run_id: b.runId, run_number: b.runNumber });

  // Delete exactly the owned run B through the native deletion API (force:
  // the run is still 'running' because the stub never dispatched it).
  deletionResult = await deleteWorkflow(b.runId, { force: true });
  if (!deletionResult.ok) throw new Error(`deleteWorkflow(B) did not report ok: ${JSON.stringify(deletionResult)}`);

  const c = await runWorkflow({ workflowId: WORKFLOW_ID, taskTitle: 'createC', workingDirectoryForHarness: harnessDir });
  observed.push({ tag: 'C', run_id: c.runId, run_number: c.runNumber });

  liveRows = db.prepare('SELECT run_number FROM runs ORDER BY run_number').all().map((row) => row.run_number);
  liveUnique = new Set(liveRows).size === liveRows.length;
  reuseObserved = c.runNumber === b.runNumber;
  bGone = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?').get(b.runId).n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM steps WHERE run_id = ?').get(b.runId).n === 0;

  if (!reuseObserved || !liveUnique || !bGone) {
    throw new Error(`real-API observation deviated: reuse=${reuseObserved} unique=${liveUnique} bGone=${bGone}`);
  }
} catch (error) {
  failure = error;
} finally {
  // POSITIVE exact owned-handle closure (Storm O12 probe-close): close the
  // exact stub listener and exact DB handle and observe each completing
  // without error/timeout. A close error or unknown timeout is recorded and
  // makes the probe non-green below — never a swallowed best-effort receipt.
  try {
    await closeOwnedListener(stubServer, CLOSE_TIMEOUT_MS);
    closure.listener_close.observed = true;
  } catch (error) {
    closure.listener_close.observed = false;
    closure.listener_close.error = String(error?.stack ?? error);
  }
  try {
    db?.close();
    closure.db_close.observed = true;
  } catch (error) {
    closure.db_close.observed = false;
    closure.db_close.error = String(error?.stack ?? error);
  }
}

const identity = fs.lstatSync(root);
const workspaceReceipt = {
  kind: 'o12-run-number-real-api-workspace',
  root,
  ownership: { dev: identity.dev, ino: identity.ino },
  control_port: controlPort,
  created_at: new Date().toISOString(),
  retained: 'retained intentionally; no recursive filesystem disposal (exact owned listener/server handles closed positively)',
};
fs.writeFileSync(path.join(root, 'probe-receipt.json'), `${JSON.stringify(workspaceReceipt, null, 2)}\n`, { flag: 'wx' });

const report = {
  probe: 'o12-run-number-real-api',
  real_api_observation: true,
  source_pinned: { file: 'src/installer/run.ts', sha256: sourceSha, stable_dist: RUN_TS_STABLE, source_matches_dist: sourceMatchesDist },
  product_dist: { dir: DIST_DIR },
  isolation: {
    home: home, state_dir: state, db_path: process.env.TAMANDUA_DB_PATH,
    tmpdir: tmp, test_guard: process.env.TAMANDUA_TEST_GUARD,
    parent_authority_stripped: authorityStripped,
  },
  allocation_policy: 'COALESCE(MAX(run_number),0)+1 (MAX+1) via INSERT subquery (src/installer/run.ts)',
  scenario: 'createA → createB → exact owned run-B deletion (deleteWorkflow, force) → createC',
  allocated_sequence: (observed ?? []).map((row) => row.run_number),
  observed,
  deletion: deletionResult ? { ok: deletionResult.ok, run_row_and_steps_removed: bGone } : null,
  delete_recreate_reuse_observed: reuseObserved,
  live_rows_after: liveRows,
  live_rows_unique: liveUnique,
  // Positive exact owned-handle closure observation (listener + DB). Both must
  // be observed closed for the probe to be green; an injected close error or
  // an unknown close timeout makes the probe non-green.
  closure,
  // MAX+1 allocation therefore cannot guarantee run_number monotonicity
  // across deletions: after deleting the newest row the allocator reuses its
  // number. O12 judges only uniqueness among present rows and records this
  // policy as characterization — never as a monotonicity failure.
  characterization: 'deleting the highest-numbered row then creating another run reuses max+1 (native allocator semantics)',
  workspace_receipt: workspaceReceipt,
  failure: failure ? String(failure?.stack ?? failure) : undefined,
};
console.log(JSON.stringify(report, null, 2));
const closureObserved = closure.listener_close.observed === true && closure.db_close.observed === true;
if (failure !== null || !closureObserved) process.exit(1);
process.exit(0);
