// seed-root-copy.mjs — Storm O12-REPIN US-006.
//
// Re-run the aged validator (`torture-test/aged/phases.mjs validate`) on an
// OWNED copy of the retained immutable aged-state seed root so
// `tt-storm-aged validate` reports the schema-9..14 O12 pin as accepted, WITHOUT
// ever writing into the read-only /opt evidence root.
//
// Why a copy is required:
//   * the product TEST ISOLATION guard (src/lib/test-guard.ts
//     assertStatePathIsolation) refuses any getDb() whose path resolves under
//     the real user home's ~/.tamandua while TAMANDUA_TEST_GUARD=1. This
//     worktree lives at ~/.tamandua/worktrees/..., so a state dir INSIDE the
//     worktree is (string-prefix) real state to the guard and every
//     `mods.db.getDb()` in the validate phase is refused. The copy's state DB
//     is therefore materialized in a guard-safe owned directory OUTSIDE the
//     real-state prefix, while the seed-root copy itself lives under
//     torture-test/var/results/ as required.
//   * the retained root's manifest pins its ownership dev/ino, so a plain copy
//     cannot pass assertRootIdentity(). The copy rewrites ONLY the ownership +
//     snapshot/receipt references to the copy's own real path; every corpus
//     count and evidence file is copied verbatim.
//
// The retained /opt seed root is READ-ONLY evidence: this module captures its
// snapshot/sidecar sha256 + mtimes before and after and never writes into it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureOwnership, sha256FileStream, utcNow } from './seedcommon.mjs';
import { readPairMismatchBreakdown } from '../oracles/self-test/o12-seed-snapshot.mjs';
import {
  O12_PINNED_CONTENT_SHA256,
  O12_PINNED_PROVENANCE_COMMIT,
  O12_PINNED_ACCEPTANCE,
  buildValidationClassification,
} from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The retained immutable aged-state seed root (READ-ONLY evidence). */
export const DEFAULT_SOURCE_ROOT =
  '/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/'
  + 'storm-aged.2026-09-15T05-25-19-366Z.8f48ed54.nVrXyi';

export const SEED_SNAPSHOT_BASENAME = 'db-full-post-2026-09-15T07-22-31-764Z.sqlite';
export const SEED_SIDECAR_BASENAME = 'o12-reserved-baseline.json';
export const SEED_CENSUS_RECEIPT_BASENAME = 'census-full-post-2026-09-15T07-22-29-947Z.json';

/** The real-state prefix the product guard treats as production (mirror). */
export const REAL_STATE_DIR = path.join(os.userInfo().homedir, '.tamandua');

export function isUnderRealStatePrefix(candidate) {
  const normalized = path.resolve(candidate);
  return normalized === REAL_STATE_DIR || normalized.startsWith(REAL_STATE_DIR + path.sep);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function statIdentity(target) {
  const stat = fs.statSync(target);
  return {
    path: target,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    mode: stat.mode & 0o777,
  };
}

function copyFileInto(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

/**
 * Capture the read-only source identity used to prove the retained root is
 * untouched across the copy + validation run.
 */
export function captureRetainedSourceIdentity(sourceRoot) {
  const snapshotPath = path.join(sourceRoot, 'evidence', SEED_SNAPSHOT_BASENAME);
  const sidecarPath = path.join(sourceRoot, 'evidence', SEED_SIDECAR_BASENAME);
  return {
    root: sourceRoot,
    snapshot: { basename: SEED_SNAPSHOT_BASENAME, sha256: sha256FileStream(snapshotPath) },
    sidecar: { basename: SEED_SIDECAR_BASENAME, sha256: sha256FileStream(sidecarPath) },
    mtimes: {
      root: statIdentity(sourceRoot),
      evidence: statIdentity(path.join(sourceRoot, 'evidence')),
      snapshot: statIdentity(snapshotPath),
      sidecar: statIdentity(sidecarPath),
    },
  };
}

export function retainedSourceUnchanged(before, after) {
  return before.snapshot.sha256 === after.snapshot.sha256
    && before.sidecar.sha256 === after.sidecar.sha256
    && before.mtimes.root.mtime_ms === after.mtimes.root.mtime_ms
    && before.mtimes.evidence.mtime_ms === after.mtimes.evidence.mtime_ms
    && before.mtimes.snapshot.mtime_ms === after.mtimes.snapshot.mtime_ms
    && before.mtimes.sidecar.mtime_ms === after.mtimes.sidecar.mtime_ms;
}

/**
 * Allocate the guard-safe state directory that holds the validate phase's
 * `getDb()` connection. `preferredBase` is only honored when it is already
 * OUTSIDE the real-state prefix; otherwise a fresh owned dir under `os.tmpdir`
 * (or `fallbackBase` when that is outside the prefix too) is created and
 * retained.
 */
export function allocateGuardSafeStateDir({ preferredBase = null, fallbackBase = null } = {}) {
  const candidates = [preferredBase, fallbackBase, os.tmpdir(), '/tmp'].filter(Boolean);
  for (const base of candidates) {
    if (isUnderRealStatePrefix(base)) continue;
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, 'o12-repin-guard-state.'));
  }
  throw new Error(`no guard-safe state base outside ${REAL_STATE_DIR}`);
}

/**
 * Build the owned seed-root copy under `destRoot` from the retained root.
 *
 * Copies: manifest.json + state.json, the immutable DB snapshot, the
 * host-owned reserved-key sidecar, generation-report.json, the prior
 * seed-validation-report.json (retained for .pre-<ts> archival by the validate
 * phase), the census receipt, and `state/events/`. It rewrites ONLY the
 * manifest's ownership + snapshot/receipt paths (the copied root's real path)
 * and drops the stale `validation` block; all corpus counts are copied
 * verbatim. A copy of the immutable snapshot is placed at `stateDbPath`
 * (guard-safe) as the validate phase's live DB.
 */
export function buildOwnedSeedRootCopy({ sourceRoot, destRoot, stateDbPath }) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error(`source seed root does not exist: ${sourceRoot}`);
  }
  // NOTE: destRoot may legitimately live under the real-state prefix (the repo
  // var tree is under ~/.tamandua); only the live DB connection must be
  // guard-safe, and that lives in the caller-supplied guardStateDir.
  const before = captureRetainedSourceIdentity(sourceRoot);

  fs.mkdirSync(destRoot, { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(destRoot, 'state'), { recursive: true });

  // 1. campaign marker + manifest (rewritten below).
  copyFileInto(path.join(sourceRoot, 'state.json'), path.join(destRoot, 'state.json'));
  const manifestSrc = path.join(sourceRoot, 'manifest.json');
  const manifest = readJson(manifestSrc);

  // 2. immutable evidence.
  const snapshotCopy = copyFileInto(
    path.join(sourceRoot, 'evidence', SEED_SNAPSHOT_BASENAME),
    path.join(destRoot, 'evidence', SEED_SNAPSHOT_BASENAME),
  );
  fs.chmodSync(snapshotCopy, 0o444);
  const sidecarCopy = copyFileInto(
    path.join(sourceRoot, 'evidence', SEED_SIDECAR_BASENAME),
    path.join(destRoot, 'evidence', SEED_SIDECAR_BASENAME),
  );
  fs.chmodSync(sidecarCopy, 0o444);

  const generationSrc = path.join(sourceRoot, 'evidence', 'generation-report.json');
  if (fs.existsSync(generationSrc)) {
    copyFileInto(generationSrc, path.join(destRoot, 'evidence', 'generation-report.json'));
  }
  // Prior report is retained so the validate phase archives it as .pre-<ts>.
  const priorReportSrc = path.join(sourceRoot, 'evidence', 'seed-validation-report.json');
  if (fs.existsSync(priorReportSrc)) {
    copyFileInto(priorReportSrc, path.join(destRoot, 'evidence', 'seed-validation-report.json'));
  }

  // 3. census receipt the qualification builder reads.
  const receiptSrc = path.join(sourceRoot, 'receipts', SEED_CENSUS_RECEIPT_BASENAME);
  if (!fs.existsSync(receiptSrc)) {
    throw new Error(`census receipt missing from retained root: ${receiptSrc}`);
  }
  const receiptCopy = copyFileInto(receiptSrc, path.join(destRoot, 'receipts', SEED_CENSUS_RECEIPT_BASENAME));

  // 4. live event streams (O7 event-log-integrity needs state/events).
  const eventsSrc = path.join(sourceRoot, 'state', 'events');
  const eventsCopy = path.join(destRoot, 'state', 'events');
  if (fs.existsSync(eventsSrc)) {
    fs.cpSync(eventsSrc, eventsCopy, { recursive: true, dereference: false });
  }

  // 5. guard-safe live DB (copy of the immutable snapshot).
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  fs.copyFileSync(snapshotCopy, stateDbPath);
  fs.chmodSync(stateDbPath, 0o644);

  // 6. rewrite the manifest identity/references for the copy.
  const ownership = captureOwnership(destRoot);
  const rewritten = {
    ...manifest,
    ownership: { root: ownership.root, dev: ownership.dev, ino: ownership.ino },
    snapshot: {
      ...manifest.snapshot,
      db: { ...manifest.snapshot.db, file: snapshotCopy },
      reservedBaselineSidecar: { ...manifest.snapshot.reservedBaselineSidecar, file: sidecarCopy },
      censusReceipt: { ...manifest.snapshot.censusReceipt, file: receiptCopy },
      events: { ...manifest.snapshot.events, dir: eventsCopy },
    },
    // The validate phase writes the fresh report; a retained stale block would
    // reference the /opt root and is dropped rather than copied.
    validation: null,
  };
  fs.writeFileSync(path.join(destRoot, 'manifest.json'), `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');

  const provenance = {
    kind: 'o12-repin-seed-root-copy-provenance',
    generated_at_utc: utcNow(),
    source_root: sourceRoot,
    copy_root: destRoot,
    state_db_path: stateDbPath,
    retained_source: before,
    rewritten_manifest: {
      ownership: rewritten.ownership,
      'snapshot.db.file': snapshotCopy,
      'snapshot.reservedBaselineSidecar.file': sidecarCopy,
      'snapshot.censusReceipt.file': receiptCopy,
      'snapshot.events.dir': eventsCopy,
    },
    note: 'The immutable snapshot/sidecar are copied read-only (0o444) for the oracle; the live validate DB is a separate writable copy at state_db_path because the product isolation guard refuses a getDb() under the real-state prefix.',
  };
  const provenanceFile = path.join(destRoot, 'evidence', 'o12-repin-copy-provenance.json');
  fs.writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  return {
    destRoot,
    stateDbPath,
    snapshotCopy,
    sidecarCopy,
    eventsCopy,
    receiptCopy,
    provenanceFile,
    sourceBefore: before,
  };
}

/**
 * Run the real aged validate phase over the owned copy with a guard-safe live
 * DB. Returns the spawn result; the caller asserts the report.
 */
export function runAgedValidate({ repoRoot = REPO_ROOT, copyRoot, guardStateDir, timeoutMs = 1_800_000 }) {
  const entry = path.join(repoRoot, 'torture-test', 'aged', 'phases.mjs');
  if (!fs.existsSync(entry)) throw new Error(`aged phases entry missing: ${entry}`);
  const homeDir = path.join(guardStateDir, 'home');
  const tmpDir = path.join(guardStateDir, 'tmp');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TAMANDUA_TEST_GUARD: '1',
    TAMANDUA_STATE_DIR: guardStateDir,
    TAMANDUA_DB_PATH: path.join(guardStateDir, 'tamandua.db'),
    TAMANDUA_WORKTREE_ROOT: path.join(copyRoot, 'worktrees'),
    TAMANDUA_PI_BINARY: '/usr/bin/false',
    TAMANDUA_HERMES_BINARY: '/usr/bin/false',
    TAMANDUA_DSH_BINARY: '/usr/bin/false',
  };
  const startedAt = utcNow();
  const res = spawnSync(process.execPath, [entry, 'validate', '--root', copyRoot], {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const phaseOutDir = path.join(copyRoot, 'evidence');
  const stdoutFile = path.join(phaseOutDir, 'validate-phase.stdout.log');
  const stderrFile = path.join(phaseOutDir, 'validate-phase.stderr.log');
  fs.writeFileSync(stdoutFile, res.stdout ?? '', 'utf8');
  fs.writeFileSync(stderrFile, res.stderr ?? '', 'utf8');
  return {
    startedAt,
    finishedAt: utcNow(),
    exitCode: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    stdoutFile,
    stderrFile,
  };
}

/**
 * NPF-2 US-012: run the aged validator through the PUBLIC `tt-storm-aged
 * validate` entry point (not the bare phase module) with TAMANDUA_PRODUCT_DIST
 * pinned to the caller's dist, under guard=1 and /usr/bin/false harnesses.
 *
 * The `tt-storm-aged` driver renders the contained phase env itself
 * (buildPhaseEnv): HOME/STATE/DB/TMPDIR all fall under the copy root, which
 * lives outside the real-state prefix, so the product isolation guard passes.
 */
export function runAgedValidateCli({
  repoRoot = REPO_ROOT,
  copyRoot,
  productDist = null,
  timeoutMs = 1_800_000,
  envExtra = {},
} = {}) {
  const entry = path.join(repoRoot, 'torture-test', 'bin', 'tt-storm-aged');
  if (!fs.existsSync(entry)) throw new Error(`tt-storm-aged entry missing: ${entry}`);
  // The `tt-storm-aged` driver's buildPhaseEnv refuses to write the neutral pi
  // config under the operator's real home prefix; an owned copy under the gate
  // worktree (itself under the real home) therefore needs an explicit private
  // HOME outside it.  Allocate a unique owned scratch HOME and record it.
  const agedHomeDir = envExtra.TAMANDUA_AGED_HOME_DIR
    ? path.resolve(envExtra.TAMANDUA_AGED_HOME_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tt-aged-home-us012.'));
  const env = { ...process.env, ...envExtra };
  env.TAMANDUA_TEST_GUARD = '1';
  env.TAMANDUA_PRODUCT_DIST = productDist ?? path.join(repoRoot, 'dist');
  env.TAMANDUA_AGED_HOME_DIR = agedHomeDir;
  env.TAMANDUA_PI_BINARY = '/usr/bin/false';
  env.TAMANDUA_HERMES_BINARY = '/usr/bin/false';
  env.TAMANDUA_DSH_BINARY = '/usr/bin/false';
  const startedAt = utcNow();
  const res = spawnSync(process.execPath, [entry, 'validate', copyRoot], {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const phaseOutDir = path.join(copyRoot, 'evidence');
  fs.mkdirSync(phaseOutDir, { recursive: true });
  const stdoutFile = path.join(phaseOutDir, 'validate-phase.stdout.log');
  const stderrFile = path.join(phaseOutDir, 'validate-phase.stderr.log');
  fs.writeFileSync(stdoutFile, res.stdout ?? '', 'utf8');
  fs.writeFileSync(stderrFile, res.stderr ?? '', 'utf8');
  return {
    startedAt,
    finishedAt: utcNow(),
    exitCode: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    stdoutFile,
    stderrFile,
    homeDir: agedHomeDir,
    productDist: env.TAMANDUA_PRODUCT_DIST,
  };
}

/**
 * NPF-2 US-012: full pipeline over an OWNED copy of the retained seed root —
 * build the copy (live DB at `<copy>/state/tamandua.db`, guard-safe because the
 * copy lives under the gate worktree), run `tt-storm-aged validate` through the
 * public CLI, derive the fresh classification, and retain a summary.  The
 * retained /opt source is fingerprinted before/after and never written.
 */
export function runUs012AgedRevalidation({
  repoRoot = REPO_ROOT,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  destRoot,
  productDist = null,
  timeoutMs = 1_800_000,
  pairBreakdownFn = readPairMismatchBreakdown,
} = {}) {
  if (!destRoot) throw new Error('runUs012AgedRevalidation: destRoot is required');
  const stateDbPath = path.join(destRoot, 'state', 'tamandua.db');
  const build = buildOwnedSeedRootCopy({ sourceRoot, destRoot, stateDbPath });

  const validate = runAgedValidateCli({ repoRoot, copyRoot: destRoot, productDist, timeoutMs });

  const reportFile = path.join(destRoot, 'evidence', 'seed-validation-report.json');
  const report = fs.existsSync(reportFile) ? readJson(reportFile) : null;
  const dbIntegrityFile = findLatestDbIntegrity(destRoot);
  const dbIntegrity = dbIntegrityFile ? readJson(dbIntegrityFile) : null;

  const pairBreakdown = pairBreakdownFn(build.snapshotCopy);
  const classification = buildFreshClassification({
    copyRoot: destRoot,
    report,
    pairBreakdown,
    story: 'US-012',
    storyTitle:
      'Re-run tt-storm-aged validate on a copy of the retained seed and refresh readiness/qualification',
  });
  const classificationFile = path.join(destRoot, 'evidence', 'seed-validation-classification.json');
  fs.writeFileSync(classificationFile, `${JSON.stringify(classification, null, 2)}\n`, 'utf8');

  const after = captureRetainedSourceIdentity(sourceRoot);
  const validation = validateFreshReport({ report, dbIntegrity });

  const summary = {
    kind: 'us012-aged-revalidation',
    generated_at_utc: utcNow(),
    source_root: sourceRoot,
    copy_root: destRoot,
    state_db_path: stateDbPath,
    validate_phase: {
      entry: 'tt-storm-aged validate',
      exit_code: validate.exitCode,
      signal: validate.signal,
      stdout_file: validate.stdoutFile,
      stderr_file: validate.stderrFile,
      home_dir: validate.homeDir ?? null,
      product_dist: validate.productDist ?? null,
    },
    report_file: reportFile,
    report_exists: fs.existsSync(reportFile),
    o12_pin: report?.o12_pin ?? null,
    classification_file: classificationFile,
    db_integrity_file: dbIntegrityFile,
    leg_matrix: validation.matrix?.legs ?? null,
    overall: validation.matrix?.overall ?? null,
    schema: validation.matrix?.schema ?? null,
    acceptance: {
      ok: validation.ok,
      problems: validation.problems,
      expected_pin: {
        content_sha256: O12_PINNED_CONTENT_SHA256,
        provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
        acceptance: O12_PINNED_ACCEPTANCE,
      },
      retained_root_unchanged: retainedSourceUnchanged(build.sourceBefore, after),
      r1_evaluable: validation.matrix?.legs?.R1?.result === 'PASS',
    },
  };
  const summaryFile = path.join(destRoot, 'evidence', 'us012-aged-revalidation-summary.json');
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { ...summary, summaryFile, report, dbIntegrity, classification, validation };
}

/** Newest O12 db-integrity evidence emitted under the copy's evidence tree. */
export function findLatestDbIntegrity(copyRoot) {
  const base = path.join(copyRoot, 'evidence', 'o12', 'o12');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const file = path.join(base, dirs[i], 'o12-db-integrity.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Per-leg R1..R6 matrix + the schema observation from an emitted evidence JSON. */
export function extractLegMatrix(dbIntegrity) {
  if (!dbIntegrity) return null;
  const structural = (dbIntegrity.observations ?? []).find((o) => o.scope === 'structural') ?? {};
  const timestamps = (dbIntegrity.observations ?? []).find((o) => o.scope === 'timestamps') ?? {};
  const coverage = dbIntegrity.coverage ?? {};
  const legs = {};
  for (const [leg, record] of Object.entries(coverage)) {
    if (leg === 'R6') continue;
    legs[leg] = { result: record.result ?? null };
  }
  legs.R6 = { result: coverage.R6?.result ?? null, overall: coverage.R6?.overall ?? dbIntegrity.overall_result ?? null };
  return {
    legs,
    overall: dbIntegrity.overall_result ?? null,
    schema: {
      user_version: structural.schema_metadata?.user_version ?? null,
      supported_user_versions: structural.schema_metadata?.supported_user_versions ?? null,
      supported_user_version: structural.schema_metadata?.supported_user_version ?? null,
    },
    timestamp_shape: {
      steps_updated_at: timestamps.shape_histogram?.['steps.updated_at'] ?? null,
      runs_updated_at: timestamps.shape_histogram?.['runs.updated_at'] ?? null,
    },
    coverage,
  };
}

/**
 * Derive the fresh host classification ledger from the fresh report + emitted
 * O12 evidence. Thin delegate to the generic `buildValidationClassification`
 * in validate.mjs (the same classifier the `tt-storm-aged validate` phase uses
 * to write `seed-validation-classification.json`), so the retained-root copy
 * flow and the fresh-seed flow cannot drift. Reads the newest O12 db-integrity
 * evidence under `copyRoot` read-only; never fabricates a value.
 */
export function buildFreshClassification({
  copyRoot,
  report,
  pairBreakdown,
  story = 'US-006',
  storyTitle = 'Re-run aged validation on an owned seed-root copy; refresh readiness pointer and published qualification',
}) {
  const dbIntegrityFile = findLatestDbIntegrity(copyRoot);
  const dbIntegrity = dbIntegrityFile ? readJson(dbIntegrityFile) : null;
  return buildValidationClassification({
    seedRoot: copyRoot,
    report,
    dbIntegrity,
    pairBreakdown: pairBreakdown ?? null,
    story,
    storyTitle,
  });
}

/**
 * Validate the fresh aged report against the O12-REPIN acceptance contract:
 * o12_pin carries the accepted schema-9..14 CONTENT pin (content_sha256) with
 * the provenance commit, R1 EVALUABLE (PASS), overall FAIL only from
 * R3. Returns `{ ok, problems, matrix }`; never throws.
 */
export function validateFreshReport({ report, dbIntegrity }) {
  const problems = [];
  const matrix = extractLegMatrix(dbIntegrity);
  if (!report) return { ok: false, problems: ['report missing'], matrix: null };
  const pin = report.o12_pin ?? {};
  if (pin.content_sha256 !== O12_PINNED_CONTENT_SHA256) {
    problems.push(`o12_pin.content_sha256 ${pin.content_sha256} !== ${O12_PINNED_CONTENT_SHA256}`);
  }
  if (pin.provenance_commit !== O12_PINNED_PROVENANCE_COMMIT) {
    problems.push(`o12_pin.provenance_commit ${pin.provenance_commit} !== ${O12_PINNED_PROVENANCE_COMMIT}`);
  }
  if (pin.acceptance !== O12_PINNED_ACCEPTANCE) {
    problems.push(`o12_pin.acceptance ${pin.acceptance} !== ${O12_PINNED_ACCEPTANCE}`);
  }
  if (!dbIntegrity) {
    problems.push('O12 db-integrity evidence missing');
    return { ok: false, problems, matrix };
  }
  if (matrix.legs.R1?.result !== 'PASS') {
    problems.push(`R1 ${matrix.legs.R1?.result} !== PASS (R1 must be EVALUABLE on user_version 10)`);
  }
  if (matrix.legs.R3?.result !== 'FAIL') {
    problems.push(`R3 ${matrix.legs.R3?.result} !== FAIL (native TIME finding expected)`);
  }
  for (const leg of ['R2', 'R4', 'R5']) {
    if (matrix.legs[leg]?.result !== 'PASS') {
      problems.push(`${leg} ${matrix.legs[leg]?.result} !== PASS`);
    }
  }
  if (matrix.overall !== 'FAIL') {
    problems.push(`overall ${matrix.overall} !== FAIL (FAIL must come only from R3)`);
  }
  const failingLegs = Object.entries(matrix.legs)
    .filter(([leg, record]) => leg !== 'R6' && record.result === 'FAIL')
    .map(([leg]) => leg);
  if (failingLegs.length !== 1 || failingLegs[0] !== 'R3') {
    problems.push(`FAIL legs must be exactly [R3], got [${failingLegs.join(', ')}]`);
  }
  const o12Row = (report.routing?.rows ?? []).find((r) => r.oracle === 'O12');
  if (!o12Row) problems.push('routing matrix has no O12 row');
  else {
    if (o12Row.pinnedContentSha256 !== O12_PINNED_CONTENT_SHA256) {
      problems.push(`routing O12.pinnedContentSha256 ${o12Row.pinnedContentSha256} !== ${O12_PINNED_CONTENT_SHA256}`);
    }
    if (o12Row.pinnedProvenanceCommit !== O12_PINNED_PROVENANCE_COMMIT) {
      problems.push(`routing O12.pinnedProvenanceCommit ${o12Row.pinnedProvenanceCommit} !== ${O12_PINNED_PROVENANCE_COMMIT}`);
    }
    if (o12Row.acceptance !== O12_PINNED_ACCEPTANCE) {
      problems.push(`routing O12.acceptance ${o12Row.acceptance} !== ${O12_PINNED_ACCEPTANCE}`);
    }
  }
  return { ok: problems.length === 0, problems, matrix };
}

/**
 * Full US-006 pipeline: allocate the owned copy + guard-safe state dir, build
 * the copy, run the real validate phase, derive the fresh classification, and
 * write the retained summary. Returns everything the caller needs to publish
 * the qualification/pointer.
 */
export function runO12RepinSeedRootValidation({
  repoRoot = REPO_ROOT,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  destRoot,
  guardStateDir,
  guardStateBasePreferred = path.join(repoRoot, 'torture-test', 'var', 'results'),
  guardStateBaseFallback = '/home/kaladin/matchlock-work',
  pairBreakdownFn = readPairMismatchBreakdown,
} = {}) {
  if (!destRoot) {
    fs.mkdirSync(path.join(repoRoot, 'torture-test', 'var', 'results'), { recursive: true });
    destRoot = fs.mkdtempSync(
      path.join(repoRoot, 'torture-test', 'var', 'results', `o12-repin-seed-root-${timestamp()}.`),
    );
  }
  const resolvedGuardStateDir = guardStateDir
    ?? allocateGuardSafeStateDir({
      preferredBase: guardStateBasePreferred,
      fallbackBase: guardStateBaseFallback,
    });

  const build = buildOwnedSeedRootCopy({
    sourceRoot,
    destRoot,
    stateDbPath: path.join(resolvedGuardStateDir, 'tamandua.db'),
  });

  const validate = runAgedValidate({ repoRoot, copyRoot: destRoot, guardStateDir: resolvedGuardStateDir });

  const reportFile = path.join(destRoot, 'evidence', 'seed-validation-report.json');
  const report = fs.existsSync(reportFile) ? readJson(reportFile) : null;
  const dbIntegrityFile = findLatestDbIntegrity(destRoot);
  const dbIntegrity = dbIntegrityFile ? readJson(dbIntegrityFile) : null;

  const pairBreakdown = pairBreakdownFn(build.snapshotCopy);
  const classification = buildFreshClassification({ copyRoot: destRoot, report, pairBreakdown });
  const classificationFile = path.join(destRoot, 'evidence', 'seed-validation-classification.json');
  fs.writeFileSync(classificationFile, `${JSON.stringify(classification, null, 2)}\n`, 'utf8');

  const after = captureRetainedSourceIdentity(sourceRoot);
  const validation = validateFreshReport({ report, dbIntegrity });

  const summary = {
    kind: 'o12-repin-seed-root-validation',
    generated_at_utc: utcNow(),
    source_root: sourceRoot,
    copy_root: destRoot,
    guard_state_dir: resolvedGuardStateDir,
    state_db_path: build.stateDbPath,
    provenance_file: build.provenanceFile,
    validate_phase: {
      exit_code: validate.exitCode,
      signal: validate.signal,
      stdout_file: validate.stdoutFile,
      stderr_file: validate.stderrFile,
    },
    report_file: reportFile,
    report_exists: fs.existsSync(reportFile),
    o12_pin: report?.o12_pin ?? null,
    classification_file: classificationFile,
    db_integrity_file: dbIntegrityFile,
    leg_matrix: validation.matrix?.legs ?? null,
    overall: validation.matrix?.overall ?? null,
    schema: validation.matrix?.schema ?? null,
    acceptance: {
      ok: validation.ok,
      problems: validation.problems,
      expected_pin: { content_sha256: O12_PINNED_CONTENT_SHA256, provenance_commit: O12_PINNED_PROVENANCE_COMMIT, acceptance: O12_PINNED_ACCEPTANCE },
      retained_root_unchanged: retainedSourceUnchanged(build.sourceBefore, after),
      r1_evaluable: validation.matrix?.legs?.R1?.result === 'PASS',
    },
  };
  const summaryFile = path.join(destRoot, 'evidence', 'o12-repin-seed-root-summary.json');
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { ...summary, summaryFile, report, dbIntegrity, classification, validation };
}

// ── Thin CLI ─────────────────────────────────────────────────────────────
function usage() {
  return [
    'Usage: node torture-test/aged/seed-root-copy.mjs [--source-root <dir>] [--dest-root <dir>]',
    '         [--guard-state-dir <dir>]',
    '',
    'Builds an owned copy of the retained aged-state seed root, runs the aged',
    'validate phase against it with a guard-safe live DB, writes the fresh',
    'classification, and retains a summary.  Exit 0 iff the fresh report matches',
    'the O12-REPIN acceptance contract.',
  ].join('\n');
}

export function runCli(argv) {
  const flag = (name, def = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? def : argv[i + 1];
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const result = runO12RepinSeedRootValidation({
    sourceRoot: flag('--source-root', DEFAULT_SOURCE_ROOT),
    destRoot: flag('--dest-root', null),
    guardStateDir: flag('--guard-state-dir', null),
  });
  process.stdout.write(`${JSON.stringify({
    copy_root: result.copy_root,
    guard_state_dir: result.guard_state_dir,
    report_file: result.report_file,
    summary_file: result.summaryFile,
    o12_pin: result.o12_pin,
    leg_matrix: result.leg_matrix,
    overall: result.overall,
    acceptance_ok: result.acceptance.ok,
    acceptance_problems: result.acceptance.problems,
    retained_root_unchanged: result.acceptance.retained_root_unchanged,
  }, null, 2)}\n`);
  if (result.acceptance.ok && result.validate_phase.exit_code === 0) return 0;
  for (const p of result.acceptance.problems) process.stderr.write(`ACCEPTANCE PROBLEM: ${p}\n`);
  process.stderr.write(`validate phase exit code: ${result.validate_phase.exit_code}\n`);
  return 1;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
