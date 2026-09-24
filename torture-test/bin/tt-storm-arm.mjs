// tt-storm-arm.mjs — STORM-REAL US-009: the aged-state ADOPTION path for a
// prepared storm campaign.
//
// A REAL storm is launched against an AGED corpus (beads tamandua-6sy.6.6 /
// tamandua-6sy.6): a frozen, qualified seed root produced by the torture-owned
// `tt-storm-aged` generator (torture-test/aged/**). Arming installs that seed's
// state into the campaign's PRIVATE state root so the real product daemon
// opens the aged DB/events and adopts its managed-worktree rows.
//
// This module is the ONE adoption implementation. It is intentionally
// launch-free: it never starts a daemon, harness or model, and it never
// changes the campaign's mode/qualification — `arm` only installs state and
// records an arming receipt. The CLI (torture-test/bin/tt-storm arm aged-state)
// wires it to the operator surface; US-011 documents the path in
// torture-test/aged/docs/STORM-AGED-CONTRACT.md.
//
// Safety posture (mirrors the rest of the storm boundary):
//   * The seed root is READ-ONLY evidence. Adoption reads from it and NEVER
//     writes to it. Its owned identity (manifest ownership dev/ino) is verified
//     with the aged tooling's own `assertRootIdentity` BEFORE any campaign
//     write — a foreign or replaced root refuses with TT_SEED_ROOT_REFUSED and
//     leaves the campaign untouched (no partial install).
//   * The immutable DB snapshot's pinned sha256 (and every copied event file's
//     pinned sha256) is verified BEFORE any campaign write; a mismatch refuses
//     with TT_SEED_SNAPSHOT_INVALID.
//   * Writes go only to the campaign's already-admitted private exec context
//     (db_path / state_root), whose containment is proven by the caller
//     (tt-storm's requireContained) before adoption is invoked.
//   * The pre-adoption campaign DB is the freshly-provisioned product-schema
//     DB from prepare; it is REPLACED (not deleted) by the seed snapshot and
//     the persisted exec-identity receipt's db dev/ino is re-pinned to the
//     adopted file so later modes revalidate against the real installed DB.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { loadManifest, assertRootIdentity } from '../aged/manifest.mjs';
import { refusal } from './tt-storm-shared.mjs';

export const AGED_STATE_ARM_KIND = 'aged-state';
export const AGED_STATE_ARM_SCHEMA_VERSION = 1;
export const ARM_RECEIPTS_DIR = 'arming';
export const AGED_STATE_ARM_RECEIPT_NAME = 'aged-state.json';

export const TT_SEED_ROOT_REFUSED = 'TT_SEED_ROOT_REFUSED';
export const TT_SEED_SNAPSHOT_INVALID = 'TT_SEED_SNAPSHOT_INVALID';
export const TT_SEED_NOT_ARMABLE = 'TT_SEED_NOT_ARMABLE';
export const TT_ARM_DB_UNAVAILABLE = 'TT_ARM_DB_UNAVAILABLE';
export const TT_ARM_STATE_NOT_PREPARED = 'TT_ARM_STATE_NOT_PREPARED';

// The documented adoption path (US-011 publishes this verbatim in the
// STORM-AGED contract). Each entry names a source artifact under the owned seed
// root and the campaign state-root destination it is installed to.
export const AGED_STATE_ADOPTION_PATH = Object.freeze([
  Object.freeze({
    step: 'db',
    source: 'manifest.snapshot.db.file (immutable VACUUM INTO snapshot, sha256-pinned)',
    destination: 'campaign state.exec_identity.db_path (the campaign TAMANDUA_DB_PATH)',
    mode: 'replaces the freshly-prepared empty product-schema DB; made writable (0644) for the real daemon',
  }),
  Object.freeze({
    step: 'events',
    source: 'manifest.snapshot.events.dir (byte-exact event-stream copies, per-file sha256-pinned)',
    destination: 'campaign state.exec_identity.state_root/events/',
    mode: 'byte-exact copy of every event stream (per-run streams + all.jsonl and archives)',
  }),
  Object.freeze({
    step: 'run_worktrees',
    source: 'the adopted DB run_worktrees rows',
    destination: 'the campaign DB',
    mode: 'adopted with the DB copy; row count recorded in the arming receipt',
  }),
]);

export function agedStateArmReceiptPath(campaignDir) {
  return path.join(String(campaignDir), ARM_RECEIPTS_DIR, AGED_STATE_ARM_RECEIPT_NAME);
}

// SHA-256 of a file (streaming read) — the seed manifest pins snapshot/event
// hashes with this algorithm.
export function sha256File(filePath, { fsx = fs } = {}) {
  const h = crypto.createHash('sha256');
  h.update(fsx.readFileSync(filePath));
  return h.digest('hex');
}

function nowIsoDefault() {
  return new Date().toISOString();
}

// A pure descriptor of where a verified seed would be adopted. It performs no
// filesystem writes; it is the shape the receipt and the contract document.
export function planAgedStateAdoption({ seedRoot, manifest, execCtx, campaignDir }) {
  const snap = manifest?.snapshot?.db ?? null;
  const events = manifest?.snapshot?.events ?? null;
  const copied = Array.isArray(events?.copied) ? events.copied : [];
  return {
    seed_root: seedRoot ? path.resolve(String(seedRoot)) : null,
    seed_kind: manifest?.seed_kind ?? null,
    snapshot_file: snap?.file ?? null,
    snapshot_sha256: snap?.sha256 ?? null,
    snapshot_user_version: Number.isInteger(snap?.userVersion) ? snap.userVersion : null,
    events_dir: events?.dir ?? null,
    event_files: copied.map((c) => ({ name: c.name, sha256: c.sha256 ?? null })),
    db_destination: execCtx?.db_path ?? null,
    events_destination: execCtx?.state_root ? path.join(execCtx.state_root, 'events') : null,
    campaign_dir: campaignDir ? path.resolve(String(campaignDir)) : null,
    receipt_path: campaignDir ? agedStateArmReceiptPath(campaignDir) : null,
    adoption_path: AGED_STATE_ADOPTION_PATH,
  };
}

// Verify the seed root is the owned, qualified, hash-pinned corpus the arming
// contract admits. Reads only; throws (never writes) on any problem — the
// caller may therefore treat the throw as "campaign untouched".
//
// Refusal codes:
//   TT_SEED_ROOT_REFUSED      — missing root / unreadable or mismatched
//                               manifest / owned identity mismatch (foreign or
//                               replaced root)
//   TT_SEED_SNAPSHOT_INVALID  — absent snapshot/events, or a sha256 mismatch
//                               against the manifest pin
export function verifyAgedStateSeed({ seedRoot, fsx = fs, loadManifestFn = loadManifest, assertRootIdentityFn = assertRootIdentity } = {}) {
  if (typeof seedRoot !== 'string' || seedRoot.trim() === '') {
    throw refusal('arm aged-state requires an owned --seed-root <dir>', TT_SEED_NOT_ARMABLE);
  }
  const root = path.resolve(seedRoot);
  let st;
  try {
    st = fsx.statSync(root);
  } catch (err) {
    throw refusal(`seed root unreadable (${root}): ${err.message}`, TT_SEED_ROOT_REFUSED);
  }
  if (!st.isDirectory()) {
    throw refusal(`seed root is not a directory: ${root}`, TT_SEED_ROOT_REFUSED);
  }
  let manifest;
  try {
    manifest = loadManifestFn(root);
    assertRootIdentityFn(root, manifest);
  } catch (err) {
    throw refusal(`seed root identity refused (${root}): ${err.message}`, TT_SEED_ROOT_REFUSED);
  }
  const plan = planAgedStateAdoption({ seedRoot: root, manifest, execCtx: null, campaignDir: null });
  if (!plan.snapshot_file) {
    throw refusal(`seed root ${root} has no snapshot.db in its manifest — run tt-storm-aged census/snapshot first`, TT_SEED_SNAPSHOT_INVALID);
  }
  if (!plan.events_dir) {
    throw refusal(`seed root ${root} has no snapshot.events in its manifest — run tt-storm-aged census/snapshot first`, TT_SEED_SNAPSHOT_INVALID);
  }
  if (!fsx.existsSync(plan.snapshot_file)) {
    throw refusal(`seed snapshot file missing: ${plan.snapshot_file}`, TT_SEED_SNAPSHOT_INVALID);
  }
  const snapshotSha = sha256File(plan.snapshot_file, { fsx });
  if (plan.snapshot_sha256 && snapshotSha !== plan.snapshot_sha256) {
    throw refusal(
      `seed snapshot sha256 mismatch: manifest pins ${plan.snapshot_sha256}, file is ${snapshotSha} — the immutable snapshot was replaced`,
      TT_SEED_SNAPSHOT_INVALID,
    );
  }
  if (!fsx.existsSync(plan.events_dir)) {
    throw refusal(`seed snapshot events dir missing: ${plan.events_dir}`, TT_SEED_SNAPSHOT_INVALID);
  }
  const eventFiles = [];
  for (const entry of plan.event_files) {
    if (!entry.name || entry.name.includes('/') || entry.name.includes('..')) {
      throw refusal(`seed event entry has an unsafe name: ${JSON.stringify(entry.name)}`, TT_SEED_SNAPSHOT_INVALID);
    }
    const src = path.join(plan.events_dir, entry.name);
    if (!fsx.existsSync(src)) {
      throw refusal(`seed event stream missing: ${src}`, TT_SEED_SNAPSHOT_INVALID);
    }
    const sha = sha256File(src, { fsx });
    if (entry.sha256 && sha !== entry.sha256) {
      throw refusal(`seed event stream sha256 mismatch for ${entry.name}: pinned ${entry.sha256}, file is ${sha}`, TT_SEED_SNAPSHOT_INVALID);
    }
    eventFiles.push({ name: entry.name, path: src, sha256: sha });
  }
  return {
    seed_root: root,
    manifest,
    plan: { ...plan, snapshot_sha256: snapshotSha, event_files: eventFiles.map((e) => ({ name: e.name, sha256: e.sha256 })) },
    snapshot_sha256: snapshotSha,
    event_files: eventFiles,
  };
}

// Read adopted counts from the installed DB. A missing/unopenable DB refuses
// (TT_ARM_DB_UNAVAILABLE) — never a fabricated 0. Tables absent from an older
// schema are reported as null rather than guessed.
export function readAdoptedCounts({ dbPath, openDb = null, fsx = fs } = {}) {
  if (!dbPath || !fsx.existsSync(dbPath)) {
    throw refusal(`adopted DB missing at ${dbPath ?? '(null)'}`, TT_ARM_DB_UNAVAILABLE);
  }
  let db = null;
  let owned = false;
  if (typeof openDb === 'function') {
    db = openDb(dbPath);
    if (!db) throw refusal(`cannot open adopted DB ${dbPath}`, TT_ARM_DB_UNAVAILABLE);
  } else {
    let DatabaseSync;
    try {
      DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
    } catch (err) {
      throw refusal(`node:sqlite unavailable: ${err.message}`, TT_ARM_DB_UNAVAILABLE);
    }
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      owned = true;
    } catch (err) {
      throw refusal(`cannot open adopted DB ${dbPath}: ${err.message}`, TT_ARM_DB_UNAVAILABLE);
    }
  }
  try {
    let tables;
    try {
      tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    } catch (err) {
      throw refusal(`cannot enumerate adopted DB tables (${dbPath}): ${err.message}`, TT_ARM_DB_UNAVAILABLE);
    }
    const count = (table) => (tables.has(table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) : null);
    return {
      runs: count('runs'),
      steps: count('steps'),
      run_worktrees: count('run_worktrees'),
      tables_present: {
        runs: tables.has('runs'),
        steps: tables.has('steps'),
        run_worktrees: tables.has('run_worktrees'),
      },
    };
  } finally {
    if (owned && typeof db.close === 'function') db.close();
  }
}

// Build the arming receipt. Pure (no fs), so callers/tests can assert its
// exact shape before it is written.
export function buildAgedStateArmReceipt({ plan, verified, counts, at = null } = {}) {
  if (!plan) throw refusal('buildAgedStateArmReceipt requires a plan', TT_SEED_NOT_ARMABLE);
  if (!verified) throw refusal('buildAgedStateArmReceipt requires verified seed evidence', TT_SEED_NOT_ARMABLE);
  return {
    schema_version: AGED_STATE_ARM_SCHEMA_VERSION,
    kind: AGED_STATE_ARM_KIND,
    armed: true,
    launch_free: true,
    source_root: plan.seed_root,
    source_kind: plan.seed_kind,
    snapshot_sha256: verified.snapshot_sha256 ?? plan.snapshot_sha256 ?? null,
    snapshot_user_version: plan.snapshot_user_version,
    db_destination: plan.db_destination,
    events_destination: plan.events_destination,
    adopted_counts: {
      runs: counts?.runs ?? null,
      steps: counts?.steps ?? null,
      run_worktrees: counts?.run_worktrees ?? null,
      event_files: Array.isArray(verified.event_files) ? verified.event_files.length : 0,
    },
    adoption_path: AGED_STATE_ADOPTION_PATH,
    note: 'launch-free adoption: no daemon/harness/model was started; the campaign mode and qualification are unchanged',
    armed_at_utc: at ?? nowIsoDefault(),
  };
}

export function writeAgedStateArmReceipt({ campaignDir, receipt, fsx = fs }) {
  const file = agedStateArmReceiptPath(campaignDir);
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fsx.writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
  fsx.renameSync(tmp, file);
  return { file, receipt };
}

export function readAgedStateArmReceipt({ campaignDir, fsx = fs } = {}) {
  const file = agedStateArmReceiptPath(campaignDir);
  if (!fsx.existsSync(file)) return null;
  try {
    return JSON.parse(fsx.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Perform the adoption. The caller has already admitted containment and
// verified the seed (`verifyAgedStateSeed`); this function WRITES only to the
// campaign's private exec context and the campaign dir receipt.
//
// `state` (the persisted campaign state) is updated in place:
//   * state.exec_identity.ownership.db is re-pinned to the adopted DB file's
//     dev/ino so later modes revalidate against the real installed DB;
//   * state.arming.<kind> records the receipt summary.
// state.mode and state.qualification are deliberately NOT touched.
export function adoptAgedState({
  campaignDir,
  execCtx,
  state,
  seedRoot = null,
  manifest = null,
  plan = null,
  verified,
  fsx = fs,
  now = nowIsoDefault,
  openDb = null,
} = {}) {
  if (!verified) throw refusal('adoptAgedState requires verified seed evidence', TT_SEED_NOT_ARMABLE);
  // The verified evidence carries the seed-side plan (no exec destinations);
  // re-project it onto the campaign's admitted exec context so the DB/events
  // destinations are the campaign's own private paths.
  const adoptionPlan = plan ?? planAgedStateAdoption({
    seedRoot: verified.seed_root ?? seedRoot,
    manifest: verified.manifest ?? manifest,
    execCtx,
    campaignDir,
  });
  if (adoptionPlan.snapshot_sha256 == null && verified.snapshot_sha256) {
    adoptionPlan.snapshot_sha256 = verified.snapshot_sha256;
  }
  const dbDest = adoptionPlan.db_destination;
  const eventsDest = adoptionPlan.events_destination;
  if (!dbDest) throw refusal('adoption plan has no DB destination (campaign exec_identity.db_path missing)', TT_ARM_DB_UNAVAILABLE);
  if (!eventsDest) throw refusal('adoption plan has no events destination (campaign exec_identity.state_root missing)', TT_ARM_DB_UNAVAILABLE);
  if (state && state.mode && state.mode !== 'prepared') {
    throw refusal(
      `campaign is mode '${state.mode}', not 'prepared' — arming installs state into a prepared campaign; refusing to clobber a running/terminal DB`,
      TT_ARM_STATE_NOT_PREPARED,
    );
  }

  // 1) Adopt the immutable DB snapshot as the campaign DB. Stale SQLite
  //    sidecars of the campaign's own freshly-prepared empty DB are removed
  //    (the replacement snapshot must not be recovered from a foreign WAL).
  fsx.mkdirSync(path.dirname(dbDest), { recursive: true });
  for (const suffix of ['-wal', '-shm']) {
    const side = `${dbDest}${suffix}`;
    if (fsx.existsSync(side)) fsx.unlinkSync(side);
  }
  const staging = `${dbDest}.adopting.${process.pid}`;
  fsx.copyFileSync(adoptionPlan.snapshot_file, staging);
  fsx.chmodSync(staging, 0o644);
  fsx.renameSync(staging, dbDest);

  // 2) Copy every pinned event stream byte-exact into the campaign state
  //    events dir (per-run streams + all.jsonl/archives).
  fsx.mkdirSync(eventsDest, { recursive: true });
  for (const ev of verified.event_files) {
    fsx.copyFileSync(ev.path, path.join(eventsDest, ev.name));
  }

  // 3) Count what was actually adopted (read back from the installed DB).
  const counts = readAdoptedCounts({ dbPath: dbDest, openDb, fsx });

  // 4) Re-pin the persisted exec-identity receipt to the adopted DB.
  const dbStat = fsx.statSync(dbDest);
  const dbOwnership = { path: dbDest, dev: dbStat.dev, ino: dbStat.ino, capturedAt: now() };
  if (state?.exec_identity?.ownership) {
    state.exec_identity.ownership.db = dbOwnership;
  }
  const receipt = buildAgedStateArmReceipt({
    plan: { ...adoptionPlan, db_destination: dbDest },
    verified,
    counts,
    at: now(),
  });
  if (state) {
    state.arming = { ...(state.arming ?? {}), [AGED_STATE_ARM_KIND]: {
      receipt_path: adoptionPlan.receipt_path,
      source_root: adoptionPlan.seed_root,
      snapshot_sha256: receipt.snapshot_sha256,
      adopted_counts: receipt.adopted_counts,
      armed_at_utc: receipt.armed_at_utc,
    } };
  }
  const written = writeAgedStateArmReceipt({ campaignDir, receipt, fsx });
  return { receipt, receipt_path: written.file, db_ownership: dbOwnership, counts };
}