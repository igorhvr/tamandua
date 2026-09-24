// O7 self-test fixture builder (torture-test only; STORM-O7).
//
// Builds FRESH, OWNED calibration copies of an O7 evidence bundle beneath one
// mkdtemp root: a read-only SQLite DB snapshot plus byte-exact event streams
// plus the versioned host-owned sidecar. Original evidence is never mutated;
// these copies are deliberately synthesised (including corrupt/tampered
// negatives) so the O7 executable can be exercised against positive AND
// negative controls through its real CLI/exit contract.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const CAP = 20 * 1024 * 1024;
export const NOMINAL_EVENT = { ts: '2026-09-09T00:00:00.000Z', event: 'run.started', runId: 'run-x' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function iso(msOffset = 0) {
  return new Date(Date.now() + msOffset).toISOString();
}

function dbSecond(msOffset = 0) {
  return iso(msOffset).slice(0, 19).replace('T', ' ');
}

export function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

export function eventLine(event) {
  return line(event);
}

function writeFileStrict(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o444);
}

function buildSqlite(dbSpec, filePath) {
  // Build a REAL SQLite database file (never a raw-SQL text blob): the
  // calibration snapshots are actual databases the read-only oracle opens.
  // filePath always points into a FRESH mkdtemp-owned scenario dir, so the
  // path cannot pre-exist — no deletion/preclean is ever performed here.
  const { runs = [], steps = [] } = dbSpec ?? {};
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA journal_mode=OFF;');
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, workflow_id TEXT, run_number INTEGER, created_at TEXT, updated_at TEXT, tokens_spent INTEGER NOT NULL DEFAULT 0);');
    db.exec('CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, agent_id TEXT, step_index INTEGER DEFAULT 0, input_template TEXT DEFAULT "", expects TEXT DEFAULT "", status TEXT NOT NULL, type TEXT DEFAULT "single", auto_completed INTEGER NOT NULL DEFAULT 0, auto_complete_reason TEXT, claim_job_id TEXT, claim_updated_at TEXT, updated_at TEXT, retry_count INTEGER DEFAULT 0);');
    const runStmt = db.prepare('INSERT INTO runs (id,status,workflow_id,run_number,created_at,updated_at,tokens_spent) VALUES (?,?,?,?,?,?,0)');
    for (const run of runs) {
      runStmt.run(run.id, run.status, run.workflow_id ?? 'wf', run.run_number ?? 1, run.created_at ?? dbSecond(-60000), run.updated_at ?? dbSecond(0));
    }
    const stepStmt = db.prepare('INSERT INTO steps (id,run_id,step_id,agent_id,step_index,expects,status,type,auto_completed,auto_complete_reason,claim_job_id,claim_updated_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const step of steps) {
      stepStmt.run(step.id ?? randomUUID(), step.run_id, step.step_id, step.agent_id ?? 'w1', step.step_index ?? 0, step.expects ?? '', step.status, step.type ?? 'single', step.auto_completed ?? 0, step.auto_complete_reason ?? null, step.claim_job_id ?? null, step.claim_updated_at ?? null, step.updated_at ?? dbSecond(0));
    }
  } finally {
    db.close();
  }
  return fs.readFileSync(filePath);
}


/**
 * Compose one scenario bundle.
 *
 * @param {string} scenarioDir absolute dir for this scenario (created)
 * @param {object} spec
 *   - capture: {kind, producer, debug_events_env, launch_debug}
 *   - db: {runs, steps} | null (null => DB with no tables)
 *   - global: { live?: string[], archives?: {1?: string[], 2?: string[], 3?: string[]}, generation?: string }
 *   - perRun: { [runId]: string[] } ('' key => events/.jsonl)
 *   - probes: { off?: string[], on?: string[] }
 *   - scopeRuns: string[]
 *   - deletedRuns: array
 *   - manualLedger: array
 *   - syntheticStreams: array
 *   - product: {source_commit, source_tree}
 *   - tamper: 'hash'|'escape'|'symlink'|'writable-db'|'none'
 *   - eventsCapturedOffsetMs / dbCapturedOffsetMs (future offsets so
 *     'demonstrated missing' semantics hold deterministically)
 * @returns {{sidecarPath, evidenceDir, dir}}
 */
export function createScenario(scenarioDir, spec) {
  fs.mkdirSync(scenarioDir, { recursive: true });
  const eventsDir = path.join(scenarioDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const capture = spec.capture ?? {};
  const nowBase = Date.now();
  const eventsCapturedAt = iso(5000);
  const dbCapturedAt = iso(6000);
  const capturedAt = iso(6500);

  const dbSpec = spec.db;
  let dbBytes = null;
  if (dbSpec) {
    const dbPath = path.join(scenarioDir, 'db.sqlite');
    dbBytes = buildSqlite(dbSpec, dbPath);
    if (spec.tamper === 'writable-db') fs.chmodSync(dbPath, 0o666);
    else fs.chmodSync(dbPath, 0o444);
  }

  const members = [];
  const filesToWrite = [];

  const addStream = (rel, lines, role) => {
    const content = (lines ?? []).join('');
    const filePath = path.join(scenarioDir, rel);
    filesToWrite.push({ rel, content, filePath });
    members.push({ role, path: rel, sha256: sha256(Buffer.from(content, 'utf8')), size: Buffer.byteLength(content, 'utf8') });
  };

  if (spec.db) {
    members.push({ role: 'db-snapshot', path: 'db.sqlite', sha256: sha256(dbBytes), size: dbBytes.length });
  }
  const global = spec.global ?? {};
  if (global.live !== undefined) addStream('events/all.jsonl', global.live, 'global-live');
  for (const index of [1, 2, 3]) {
    if (global.archives && global.archives[index] !== undefined) {
      addStream(`events/all.jsonl.${index}`, global.archives[index], `global-archive:${index}`);
    }
  }
  if (global.generation !== undefined) {
    addStream('events/all.jsonl.generation', [`${global.generation}\n`], 'generation');
  }
  for (const [runId, linesArr] of Object.entries(spec.perRun ?? {})) {
    if (runId === '') addStream('events/.jsonl', linesArr, 'empty-run');
    else addStream(`events/${runId}.jsonl`, linesArr, 'per-run');
  }
  const probes = spec.probes ?? {};
  if (probes.off !== undefined) addStream('probes/debug-off.jsonl', probes.off, 'probe-debug-off');
  if (probes.on !== undefined) addStream('probes/debug-on.jsonl', probes.on, 'probe-debug-on');

  for (const file of filesToWrite) {
    fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
    fs.writeFileSync(file.filePath, file.content);
    fs.chmodSync(file.filePath, 0o444);
  }

  const product = spec.product ?? { source_commit: 'f'.repeat(40), source_tree: 'e'.repeat(40) };
  const sidecar = {
    schema_version: 1,
    oracle_id: 'O7',
    capture: {
      kind: capture.kind ?? 'batch',
      producer: capture.producer ?? 'o7-self-test',
      captured_at: capturedAt,
      events_captured_at: eventsCapturedAt,
      db_captured_at: dbCapturedAt,
      state_dir_identity: scenarioDir,
      generation_at_capture: global.generation !== undefined ? Number(global.generation) : null,
      debug_events_env: capture.debug_events_env ?? null,
      launch_intent: { debug_events: capture.launch_debug ?? null, declared_by: 'o7-self-test-host' },
    },
    product,
    scope_runs: spec.scopeRuns ?? [],
    members,
  };
  if (spec.deletedRuns) sidecar.deleted_runs = spec.deletedRuns;
  if (spec.manualLedger) sidecar.manual_ledger = spec.manualLedger;
  if (spec.syntheticStreams) sidecar.synthetic_streams = spec.syntheticStreams;
  if (spec.perRunCapture) sidecar.per_run_capture = spec.perRunCapture;

  const sidecarPath = path.join(scenarioDir, 'sidecar.json');
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  fs.chmodSync(sidecarPath, 0o444);

  if (spec.tamper === 'hash') {
    members[0].sha256 = '0'.repeat(64);
    fs.chmodSync(sidecarPath, 0o644);
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    fs.chmodSync(sidecarPath, 0o444);
  } else if (spec.tamper === 'escape') {
    // sidecar member path pointing outside the sidecar dir
    members.push({ role: 'extra-jsonl', path: '../outside.jsonl', sha256: '1'.repeat(64), size: 0 });
    fs.chmodSync(sidecarPath, 0o644);
    fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    fs.chmodSync(sidecarPath, 0o444);
  } else if (spec.tamper === 'symlink') {
    // Negative control: substitute one per-run member with a symlink to an
    // outside file. NEVER delete or replace an original in place: the
    // original file is RETAINED under an explicitly renamed owned name, and
    // the symlink occupies a freshly freed path (the original member name),
    // so every original/copy survives the tamper construction.
    const target = path.join(scenarioDir, '..', `outside-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(target, 'outside');
    const victimKey = Object.keys(spec.perRun ?? {})[0] ?? 'run-x';
    const victim = path.join(eventsDir, `${victimKey}.jsonl`);
    if (fs.existsSync(victim)) {
      const retained = path.join(eventsDir, `${victimKey}.jsonl.retained-original`);
      if (!fs.existsSync(retained)) {
        fs.renameSync(victim, retained);
        fs.chmodSync(retained, 0o444);
      }
      fs.symlinkSync(target, victim);
      fs.chmodSync(sidecarPath, 0o644);
      fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
      fs.chmodSync(sidecarPath, 0o444);
    }
  }

  const evidenceDir = path.join(scenarioDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.chmodSync(evidenceDir, 0o700);
  return { sidecarPath, evidenceDir, dir: scenarioDir };
}

export function nowIso() {
  return new Date().toISOString();
}
