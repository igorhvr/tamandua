// tt-storm-seed-validation.mjs — STORM-REAL US-010: the seed-validation
// ARMING rule for a prepared, aged-state-armed storm campaign.
//
// Context (beads tamandua-6sy.6.6 STORM-REAL / tamandua-6sy.6 STORM): once
// `tt-storm arm aged-state` has installed an owned seed's state into the
// campaign's private state root, the campaign must run the seed tooling's
// validation routing matrix + O12 against the INSTALLED state before the real
// storm is approved. Igor's 2026-09-23 rule governs how those rows gate the
// campaign:
//
//   * a FAIL row of seed-integrity class (referential breakage, orphaned rows,
//     unreadable events) BLOCKS the campaign;
//   * policy-class product findings (e.g. the O12 timestamp legs) are recorded
//     with counts and do NOT block;
//   * NOT_RUN / NOT_EVALUABLE rows are carried into the campaign, never
//     treated as failures.
//
// This module is the ONE classification/gate implementation. Everything here
// is pure except `writeSeedValidationArmReceipt` and the optional
// `runAdoptedSeedValidation` integration (which reads the installed DB + seed
// evidence and writes only under the campaign dir). It never starts a daemon,
// harness or model, and it never writes to the read-only seed root.
//
// The rule text below is the single shared constant used by the arming output,
// the arming receipt and (US-011) the STORM-AGED contract documentation.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { refusal } from './tt-storm-shared.mjs';

// SHA-256 of a file (streaming read). Used to tie the validation to the
// exact installed DB bytes that `arm aged-state` adopted.
export function sha256File(filePath, { fsx = fs } = {}) {
  const h = crypto.createHash('sha256');
  h.update(fsx.readFileSync(filePath));
  return h.digest('hex');
}

export const SEED_VALIDATION_ARM_KIND = 'seed-validation';
export const SEED_VALIDATION_ARM_SCHEMA_VERSION = 1;
export const ARM_RECEIPTS_DIR = 'arming';
export const SEED_VALIDATION_ARM_RECEIPT_NAME = 'seed-validation.json';

// Refusal vocabulary. `arm seed-validation` exits 3 when a refusal is a gate
// refusal (not prepared / no aged-state adoption / blocked / DB mismatch) and
// 4 for usage errors.
export const TT_SEED_VALIDATION_NOT_ARMED = 'TT_SEED_VALIDATION_NOT_ARMED';
export const TT_SEED_VALIDATION_DB_MISMATCH = 'TT_SEED_VALIDATION_DB_MISMATCH';
export const TT_SEED_VALIDATION_BLOCKED = 'TT_SEED_VALIDATION_BLOCKED';
export const TT_SEED_VALIDATION_MATRIX_INVALID = 'TT_SEED_VALIDATION_MATRIX_INVALID';

// ── The verbatim arming rule (single shared constant) ──────────────────
//
// Igor 2026-09-23 authorized the REAL storm and fixed the seed-validation
// gate semantics. This exact string is emitted in the arming output, recorded
// verbatim in the arming receipt, and quoted verbatim as a spec clarification
// in torture-test/aged/docs/STORM-AGED-CONTRACT.md (US-011).
export const SEED_VALIDATION_ARMING_RULE =
  'Seed-validation arming rule (Igor 2026-09-23, verbatim): the gate blocks ONLY on FAIL rows of seed-integrity class (referential breakage, orphaned rows, unreadable events); NOT_RUN/NOT_EVALUABLE rows are carried into the campaign; policy-class product findings (e.g. O12 timestamp legs) are recorded with counts and do not block.';

// ── Classification vocabulary ──────────────────────────────────────────

export const CLASS_SEED_INTEGRITY = 'seed-integrity';
export const CLASS_POLICY = 'policy-class';
export const CLASS_NOT_RUN = 'not_run';
export const CLASS_NOT_EVALUABLE = 'not_evaluable';

// Oracles whose FAIL is a corpus/seed-integrity failure and therefore blocks.
// O12 is classified by failing LEG (below), not as a whole.
export const SEED_INTEGRITY_ORACLES = Object.freeze(['O1', 'O4', 'O6', 'O7']);

// O12 legs that are structural/seed-integrity obligations. R3
// (timestamp-uniformity) is a PRODUCT policy finding: an O12 row whose ONLY
// failing legs are R3 is policy-class and never blocks. R6 is the overall
// aggregate and is excluded from leg classification.
export const O12_SEED_INTEGRITY_LEGS = Object.freeze(['R1', 'R2', 'R4', 'R5']);
export const O12_POLICY_LEGS = Object.freeze(['R3']);
export const O12_AGGREGATE_LEG = 'R6';

// Oracles that judge real agent behavior and are inapplicable to a synthetic
// zero-token corpus. Their rows arrive NOT_RUN and are carried.
export const NOT_RUN_ORACLES = Object.freeze(['O2', 'O3z', 'O8', 'O9', 'O10', 'O11', 'O16']);
// O5 (host process/port census) needs the campaign recorder layer and arrives
// NOT_EVALUABLE; it is carried.

export function seedValidationArmReceiptPath(campaignDir) {
  return path.join(String(campaignDir), ARM_RECEIPTS_DIR, SEED_VALIDATION_ARM_RECEIPT_NAME);
}

function normStatus(row) {
  return String(row?.status ?? '').trim().toUpperCase();
}

// Derive the O12 failing legs from an explicit `o12Legs` map, a row-level
// `o12_failing_legs` array, or O12 evidence coverage. Returns null when no leg
// detail exists (the caller then falls back to whole-oracle classification).
export function o12FailingLegsFrom({ row = null, o12Legs = null } = {}) {
  if (Array.isArray(row?.o12_failing_legs)) return row.o12_failing_legs.map((l) => String(l).toUpperCase());
  if (o12Legs && typeof o12Legs === 'object') {
    const out = [];
    for (const [leg, record] of Object.entries(o12Legs)) {
      if (String(leg).toUpperCase() === O12_AGGREGATE_LEG) continue;
      const result = typeof record === 'string' ? record : record?.result;
      if (String(result ?? '').toUpperCase() === 'FAIL') out.push(String(leg).toUpperCase());
    }
    return out;
  }
  const coverage = row?.coverage ?? row?.evidence?.coverage ?? row?.evidence?.dbIntegrity?.coverage ?? null;
  if (coverage && typeof coverage === 'object') {
    const out = [];
    for (const [leg, record] of Object.entries(coverage)) {
      if (String(leg).toUpperCase() === O12_AGGREGATE_LEG) continue;
      if (String(record?.result ?? '').toUpperCase() === 'FAIL') out.push(String(leg).toUpperCase());
    }
    return out;
  }
  return null;
}

// Classify ONE validation matrix row. Pure. Fail-closed: an unknown oracle /
// leg that FAILs is treated as seed-integrity (it blocks) rather than silently
// ignored.
export function classifyValidationRow(row, { o12Legs = null } = {}) {
  const oracle = String(row?.oracle ?? '').trim();
  const leg = row?.leg ?? null;
  const status = normStatus(row);
  const findings = Array.isArray(row?.findings) ? row.findings : [];
  const id = row?.id ?? row?.leg ?? null;

  let klass;
  let blocking = false;
  let detail = null;

  if (status === 'NOT_RUN') {
    klass = CLASS_NOT_RUN;
  } else if (status === 'NOT_EVALUABLE' || status === 'ERROR') {
    // A leg that could not be executed is CARRIED, never fabricated into a
    // failure (Igor's rule: NOT_RUN/NOT_EVALUABLE are carried).
    klass = CLASS_NOT_EVALUABLE;
  } else if (oracle === 'O12') {
    const failing = o12FailingLegsFrom({ row, o12Legs });
    const policyOnly = Array.isArray(failing) && failing.length > 0
      && failing.every((l) => O12_POLICY_LEGS.includes(l));
    klass = policyOnly ? CLASS_POLICY : CLASS_SEED_INTEGRITY;
    blocking = status === 'FAIL' && klass === CLASS_SEED_INTEGRITY;
    detail = {
      failing_legs: failing,
      seed_integrity_legs: Array.isArray(failing) ? failing.filter((l) => O12_SEED_INTEGRITY_LEGS.includes(l)) : null,
      policy_legs: Array.isArray(failing) ? failing.filter((l) => O12_POLICY_LEGS.includes(l)) : null,
    };
  } else {
    klass = CLASS_SEED_INTEGRITY;
    blocking = status === 'FAIL';
  }

  return {
    oracle,
    leg,
    id,
    status,
    class: klass,
    blocking,
    findings,
    counts: row?.counts ?? null,
    detail,
  };
}

// Build the full classification ledger for a routing matrix. Pure: it performs
// no I/O and never mutates its input rows.
export function buildSeedValidationClassification({ rows = [], o12Legs = null, rule = SEED_VALIDATION_ARMING_RULE } = {}) {
  if (!Array.isArray(rows)) {
    throw refusal(`seed-validation classification requires a matrix rows array (got ${typeof rows})`, TT_SEED_VALIDATION_MATRIX_INVALID);
  }
  const classified = rows.map((row) => classifyValidationRow(row, { o12Legs }));
  const tally = {
    seed_integrity: { pass: 0, fail: 0, blocking: 0 },
    policy_class: { pass: 0, fail: 0, findings: 0 },
    not_run: 0,
    not_evaluable: 0,
  };
  for (const row of classified) {
    if (row.class === CLASS_SEED_INTEGRITY) {
      if (row.status === 'FAIL') { tally.seed_integrity.fail += 1; if (row.blocking) tally.seed_integrity.blocking += 1; }
      else tally.seed_integrity.pass += 1;
    } else if (row.class === CLASS_POLICY) {
      if (row.status === 'FAIL') { tally.policy_class.fail += 1; tally.policy_class.findings += row.findings.length; }
      else tally.policy_class.pass += 1;
    } else if (row.class === CLASS_NOT_RUN) {
      tally.not_run += 1;
    } else if (row.class === CLASS_NOT_EVALUABLE) {
      tally.not_evaluable += 1;
    }
  }
  const blocking = classified.filter((r) => r.blocking);
  const carried = classified.filter((r) => r.class === CLASS_NOT_RUN || r.class === CLASS_NOT_EVALUABLE);
  const policyFindings = classified.filter((r) => r.class === CLASS_POLICY && r.status === 'FAIL');
  const matrixTally = { PASS: 0, FAIL: 0, NOT_RUN: 0, NOT_EVALUABLE: 0 };
  for (const row of classified) {
    if (matrixTally[row.status] !== undefined) matrixTally[row.status] += 1;
  }
  return {
    schema_version: SEED_VALIDATION_ARM_SCHEMA_VERSION,
    kind: 'aged-seed-validation-classification',
    rule,
    gate: 'seed-integrity-only',
    rows: classified,
    tally,
    matrix_tally: matrixTally,
    blocking,
    carried,
    policy_findings: policyFindings,
    blocked: blocking.length > 0,
  };
}

// Evaluate the gate: the campaign is blocked iff a seed-integrity FAIL row
// exists. Policy findings are counted (never blocking) and not-run /
// not-evaluable rows are carried.
export function evaluateSeedValidationGate(classification) {
  if (!classification || !Array.isArray(classification.rows)) {
    throw refusal('evaluateSeedValidationGate requires a classification with rows', TT_SEED_VALIDATION_MATRIX_INVALID);
  }
  const blocking = classification.blocking ?? [];
  return {
    blocked: blocking.length > 0,
    blocking,
    blocked_oracles: blocking.map((r) => r.oracle).filter((v, i, a) => a.indexOf(v) === i),
    carried_count: classification.carried?.length ?? 0,
    policy_findings: classification.policy_findings ?? [],
    policy_finding_count: classification.policy_findings?.reduce((n, r) => n + (r.findings?.length ?? 0), 0) ?? 0,
    rule: classification.rule,
  };
}

// Build the arming receipt. Pure (no fs). The verbatim rule and the full
// routing matrix are recorded so the gate decision is auditable.
export function buildSeedValidationArmReceipt({
  campaignDir,
  sourceRoot = null,
  installedDbPath = null,
  installedDbSha256 = null,
  snapshotSha256 = null,
  classification,
  o12 = null,
  at = null,
} = {}) {
  if (!classification || !Array.isArray(classification.rows)) {
    throw refusal('buildSeedValidationArmReceipt requires a classification', TT_SEED_VALIDATION_MATRIX_INVALID);
  }
  const gate = evaluateSeedValidationGate(classification);
  return {
    schema_version: SEED_VALIDATION_ARM_SCHEMA_VERSION,
    kind: SEED_VALIDATION_ARM_KIND,
    armed: true,
    launch_free: true,
    rule: SEED_VALIDATION_ARMING_RULE,
    source_root: sourceRoot ? path.resolve(String(sourceRoot)) : null,
    installed_db_path: installedDbPath ? path.resolve(String(installedDbPath)) : null,
    installed_db_sha256: installedDbSha256,
    snapshot_sha256: snapshotSha256,
    campaign_dir: campaignDir ? path.resolve(String(campaignDir)) : null,
    receipt_path: campaignDir ? seedValidationArmReceiptPath(campaignDir) : null,
    gate: {
      blocked: gate.blocked,
      blocking_oracles: gate.blocked_oracles,
      policy_finding_count: gate.policy_finding_count,
      carried_count: gate.carried_count,
    },
    tally: classification.tally,
    matrix_tally: classification.matrix_tally,
    classification: {
      rows: classification.rows,
      blocking: classification.blocking,
      carried: classification.carried,
      policy_findings: classification.policy_findings,
    },
    o12: o12 ? { result: o12.result ?? null, failing_legs: o12.failing_legs ?? null, evidence_dir: o12.evidence_dir ?? null } : null,
    note: 'seed-validation arming is launch-free: no daemon/harness/model was started; the campaign mode and qualification are unchanged',
    armed_at_utc: at ?? new Date().toISOString(),
  };
}

export function writeSeedValidationArmReceipt({ campaignDir, receipt, fsx = fs }) {
  const file = seedValidationArmReceiptPath(campaignDir);
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fsx.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  fsx.renameSync(tmp, file);
  return { file, receipt };
}

export function readSeedValidationArmReceipt({ campaignDir, fsx = fs } = {}) {
  const file = seedValidationArmReceiptPath(campaignDir);
  if (!fsx.existsSync(file)) return null;
  try {
    return JSON.parse(fsx.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Integration: run the seed tooling's routing matrix + O12 over the
//    INSTALLED (adopted) campaign state. ────────────────────────────────

function defaultOpenReadOnly(dbPath) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

// Extract the R1..R6 leg results from an O12 db-integrity evidence object.
export function o12LegsFromDbIntegrity(dbIntegrity) {
  const coverage = dbIntegrity?.coverage ?? null;
  if (!coverage || typeof coverage !== 'object') return null;
  const legs = {};
  for (const [leg, record] of Object.entries(coverage)) {
    legs[leg] = record?.result ?? null;
  }
  return legs;
}

// Run the real pinned O12 oracle over the INSTALLED DB using the seed root's
// baseline sidecar. Writes only under the campaign's arming dir. Returns
// { result, failing_legs, legs, evidence_dir } or null when it cannot run
// (the caller records a carried NOT_EVALUABLE row).
async function runRealO12({ sourceRoot, campaignDir, installedDbPath, repoRoot }) {
  if (!sourceRoot || !installedDbPath) return null;
  const { runO12Validation, materializePinnedOracle, O12_PINNED_CONTENT_SHA256, O12_PIN_IDENTITY } = await import('../aged/validate.mjs');
  const { loadManifest } = await import('../aged/manifest.mjs');
  const manifest = loadManifest(sourceRoot);
  const baselineFile = manifest?.snapshot?.reservedBaselineSidecar?.file
    ?? path.join(sourceRoot, 'evidence', 'o12-reserved-baseline.json');
  if (!fs.existsSync(baselineFile)) return null;
  const contextRoot = path.join(campaignDir, ARM_RECEIPTS_DIR, 'seed-validation-context');
  fs.mkdirSync(contextRoot, { recursive: true });
  // The O12 oracle requires a contained, read-only, non-symlink snapshot.
  // Prefer the seed's own immutable snapshot (the installed DB was verified
  // byte-equal to it before validation); fall back to the installed DB.
  const immutableSource = manifest?.snapshot?.db?.file && fs.existsSync(manifest.snapshot.db.file)
    ? manifest.snapshot.db.file
    : installedDbPath;
  const contextSnapshot = path.join(contextRoot, 'snapshot-readonly.sqlite');
  fs.copyFileSync(immutableSource, contextSnapshot);
  fs.chmodSync(contextSnapshot, 0o444);
  const importDest = path.join(contextRoot, 'imports', `o12-${O12_PIN_IDENTITY}`);
  if (!fs.existsSync(path.join(importDest, 'torture-test', 'oracles', 'O12'))) {
    materializePinnedOracle({ gitRepo: repoRoot, destDir: importDest, contentSha256: O12_PINNED_CONTENT_SHA256 });
  }
  const evidence = await runO12Validation({
    // The oracle context/state marker is written under the campaign's writable
    // arming dir — NEVER into the read-only seed root.
    seedRoot: contextRoot,
    evidenceDir: path.join(contextRoot, 'evidence'),
    importedOracleDir: importDest,
    snapshot: contextSnapshot,
    baselineFile,
  });
  const stdoutJson = evidence?.stdoutJson ?? null;
  const diFile = path.join(evidence.evidenceDir, 'o12-db-integrity.json');
  const dbIntegrity = fs.existsSync(diFile) ? JSON.parse(fs.readFileSync(diFile, 'utf-8')) : null;
  const legs = o12LegsFromDbIntegrity(dbIntegrity);
  const failing = legs
    ? Object.entries(legs).filter(([leg, r]) => leg !== O12_AGGREGATE_LEG && String(r).toUpperCase() === 'FAIL').map(([leg]) => leg)
    : null;
  const rawResult = stdoutJson?.result ?? (dbIntegrity?.overall_result ?? 'NOT_EVALUABLE');
  return {
    // A runtime ERROR (e.g. an unsupported schema version) means the oracle
    // could not evaluate the snapshot: carry it as NOT_EVALUABLE, never a
    // fabricated FAIL. The raw oracle result is retained for forensics.
    result: rawResult === 'ERROR' ? 'NOT_EVALUABLE' : rawResult,
    raw_result: rawResult,
    legs,
    failing_legs: failing,
    findings: stdoutJson?.findings ?? [],
    evidence_dir: evidence?.evidenceDir ?? null,
  };
}

// Run seed validation over the INSTALLED state. All I/O is read-only over the
// campaign DB/events and the seed root; the only writes are O12 evidence under
// the campaign arming dir. Tests inject `matrix`/`o12Legs` or the
// `buildValidationMatrixFn`/`runO12Fn` seams to stay hermetic.
export async function runAdoptedSeedValidation({
  campaignDir,
  execCtx,
  sourceRoot = null,
  repoRoot = null,
  matrix = null,
  o12Legs = null,
  skipO12 = false,
  fsx = fs,
  openDb = null,
  buildValidationMatrixFn = null,
  runO12Fn = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!campaignDir) throw refusal('runAdoptedSeedValidation requires campaignDir', TT_SEED_VALIDATION_NOT_ARMED);
  const installedDbPath = execCtx?.db_path ?? null;
  if (!installedDbPath || !fsx.existsSync(installedDbPath)) {
    throw refusal(`installed campaign DB missing at ${installedDbPath ?? '(null)'} — arm aged-state first`, TT_SEED_VALIDATION_NOT_ARMED);
  }

  let rows;
  if (matrix && Array.isArray(matrix.rows)) {
    rows = matrix.rows;
  } else {
    let db = null;
    let owned = false;
    try {
      if (typeof openDb === 'function') {
        db = openDb(installedDbPath);
        if (!db) throw refusal(`cannot open installed DB ${installedDbPath}`, TT_SEED_VALIDATION_NOT_ARMED);
      } else {
        db = defaultOpenReadOnly(installedDbPath);
        owned = true;
      }
      const builder = buildValidationMatrixFn
        ?? (await import('../aged/validate.mjs')).buildValidationMatrix;
      const built = builder({
        db,
        stateDir: execCtx.state_root,
        worktreesRoot: execCtx.state_root,
        zeroTokenEvidence: { note: 'seed-validation arming over the installed adopted state' },
      });
      rows = built?.rows ?? [];
    } finally {
      if (owned && typeof db?.close === 'function') db.close();
    }
  }

  let o12 = null;
  if (!skipO12 && o12Legs && typeof o12Legs === 'object') {
    o12 = {
      result: Object.entries(o12Legs).some(([leg, r]) => leg !== O12_AGGREGATE_LEG && String(r).toUpperCase() === 'FAIL') ? 'FAIL' : 'PASS',
      legs: o12Legs,
      failing_legs: Object.entries(o12Legs).filter(([leg, r]) => leg !== O12_AGGREGATE_LEG && String(r).toUpperCase() === 'FAIL').map(([leg]) => leg),
      evidence_dir: null,
    };
  } else if (!skipO12) {
    try {
      o12 = runO12Fn
        ? await runO12Fn({ sourceRoot, campaignDir, installedDbPath, repoRoot })
        : await runRealO12({ sourceRoot, campaignDir, installedDbPath, repoRoot });
    } catch (err) {
      o12 = { result: 'NOT_EVALUABLE', legs: null, failing_legs: null, error: String(err?.message ?? err), evidence_dir: null };
    }
  }

  // Attach the O12 result as a matrix row. When the provided matrix already
  // carries an O12 row (an offline replay), that row is authoritative and used
  // as-is; otherwise the computed leg is appended. When O12 did not run
  // (skip/no leg detail) the appended row is carried as NOT_EVALUABLE — never
  // fabricated.
  const hasO12Row = rows.some((r) => r?.oracle === 'O12');
  if (!hasO12Row) {
    const o12Row = {
      oracle: 'O12',
      leg: 'db-integrity',
      status: o12?.result ?? 'NOT_EVALUABLE',
      findings: o12?.findings ?? (o12?.error ? [o12.error] : []),
      o12_failing_legs: o12?.failing_legs ?? null,
      leg_results: o12?.legs ?? null,
      evidence: o12?.evidence_dir ? { evidenceDir: o12.evidence_dir } : null,
    };
    rows = [...rows, o12Row];
  }

  const classification = buildSeedValidationClassification({ rows, o12Legs: o12?.legs ?? null });
  return { classification, matrix: { rows }, o12, installedDbPath, at: now() };
}