// tt-contention-slice-shared.mjs — shared roots, canonical selection, and
// pure helpers for the tt-contention-slice CLI (STORM-I US-001..US-003).
//
// The interim W3/W4 contention slice is prepared from the CURRENT case
// catalogs by copying four canonical rows byte-identical into a controller
// input manifest, and later observed by a strictly read-only sampler. This
// module owns the pieces the subcommands share: checkout-relative roots, the
// pinned canonical roster, containment/path-validation primitives (mirroring
// tt-schema-probe.mjs and tt-containment.mjs), byte-preserving line reading,
// and the strictly read-only observation primitives (campaign state reading,
// run-id normalization, read-only DB sampling).
//
// Suite-only: this module never launches a campaign, never touches the
// operator's HOME, and never mutates anything outside torture-test/var.
// macOS/BSD-portable: only Node built-ins are used for paths/hashes/JSON.
//
// Review corrections (2026-09-05, STORM-I US-001 acceptance follow-up):
//   1. Catalog line numbers are PROVENANCE, not a fixed lookup contract: each
//      selected id is DISCOVERED exactly once by scanning the whole catalog,
//      the full unchanged source row is copied, and the actual line is
//      recorded. An unrelated inserted row never requires a tool-source edit.
//   2. VAR_ROOT itself is validated against this checkout's real torture-test
//      directory BEFORE any write in BOTH auto and explicit output modes; a
//      symlinked or escaped var root is rejected. All validators are pure and
//      parameterized so tests exercise them against fresh fixture mirrors.
//   3. Child processes preserve isolation-guard propagation (no forced
//      TAMANDUA_TEST_GUARD=0, no NODE_TEST_CONTEXT stripping) and receive
//      isolated, contained HOME/state paths instead.
//   4. There is no inherited selection environment variable: the real CLI's
//      four-case roster is fixed. Hermetic tests use pure helper injection or
//      an explicit --catalog-root fixture mirror (never an env bypass).
//   5. Preparation hashes the SAME byte snapshots used for selection (each
//      catalog is read once, in memory) and re-checks those bytes plus the
//      source commit/cleanliness AFTER validation; detected drift is recorded
//      and rejects the pinned result (artifacts retained). Missing, escaped,
//      or unreadable required task sources fail preparation — a successful
//      pinned preparation never carries null task hashes.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// ── Checkout-relative roots ────────────────────────────────────────
// <repo>/torture-test/bin/tt-contention-slice-shared.mjs
const HERE = path.dirname(fileURLToPath(import.meta.url)); // torture-test/bin
export const TT_DIR = path.dirname(HERE);                  // torture-test/
export const REPO_ROOT = path.dirname(TT_DIR);             // repo root
export const VAR_ROOT = path.join(TT_DIR, 'var');
export const CASES_ROOT = path.join(TT_DIR, 'cases');
export const CONTROLLER_PATH = path.join(TT_DIR, 'bin', 'tt-controller');

// The manifest/provenance file names inside a fresh preparation directory,
// and the sample/observer file names inside a fresh observation directory.
export const MANIFEST_NAME = 'manifest.jsonl';
export const PROVENANCE_NAME = 'provenance.json';
export const SAMPLES_NAME = 'samples.jsonl';
export const OBSERVER_NAME = 'observer.json';
export const SUMMARY_JSON_NAME = 'summary.json';
export const SUMMARY_TXT_NAME = 'summary.txt';

// The controller launch argv pinned by STORM-I US-001 for the real slice.
// Recorded in provenance and printed legibly, never executed by this tool.
export const CONTROLLER_CONCURRENCY = 4;
export const CONTROLLER_STAGGER = '10s';

// Default between-sample delay for the observer (operator cadence; tests use
// --once or a fast --interval-ms/--window-ms).
export const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;

// ── Canonical interim roster (STORM-I) ─────────────────────────────
// Copy these complete current rows, IN THIS ORDER, from the named catalogs.
// `catalog` is relative to the catalog root (torture-test/ for the operator;
// a fixture mirror for hermetic tests). There is NO pinned line: each id is
// required exactly once somewhere in its catalog; the actual line is recorded
// as provenance by `prepare`.
export const CANONICAL_SELECTION = Object.freeze([
  { id: 'W3.03-bfmw-hermes-ts', catalog: 'cases/tier1.jsonl' },
  { id: 'W4.06-colleague-rebase', catalog: 'cases/tier2.jsonl' },
  { id: 'W4.09-pi-kill-harness', catalog: 'cases/tier2.jsonl' },
  { id: 'W4.dsh-bfmw', catalog: 'cases/tier2.jsonl' },
]);

// The controller's own contained case-id pattern (tt-controller --case).
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Run/step status vocabulary (mirrors the product + tt-schema-probe).
// A run row is TERMINAL once its status leaves this set; anything else that
// is present is observed as active/non-terminal.
export const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed', 'canceled']);
// Step states that count as claimed/active work (claimed = agent owns it;
// running = agent is executing it).
export const ACTIVE_STEP_STATUSES = Object.freeze(['claimed', 'running']);

// ── Small primitives ───────────────────────────────────────────────

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function utcTimestamp() {
  return new Date().toISOString();
}

// pathIsWithin: `candidate` resolves inside `root` (root itself rejected) —
// mirrors tt-containment.mjs's containment semantics.
export function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// resolveExistingRealPath: resolve `candidate` to a real path WITHOUT
// requiring it to exist — walk up to the nearest existing ancestor, use its
// realpath, and re-append the missing tail segments. Returns null when no
// existing ancestor exists at all. (Destination paths under var/ may not
// exist yet; the containment verdict must still be about where the path WILL
// live, never about an operator-owned file.)
export function resolveExistingRealPath(candidate) {
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

// A labeled refusal error carrying the machine-parseable category in `code`.
export function refusal(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Reject raw path-traversal destinations: a '..' segment anywhere in the
// (backslash-normalized) path string is refused outright, even when lexical
// resolution would collapse back inside the root — a supplied path must be a
// plain, direct path the operator can see.
export function assertNoTraversal(candidate, label = 'path') {
  const portable = String(candidate).replaceAll('\\', '/');
  if (portable.split('/').includes('..')) {
    throw refusal(
      `${label} is a path-traversal path (contains a '..' segment): ${candidate}`,
      'TT_TRAVERSAL',
    );
  }
}

// Split a Buffer into its line CONTENTS as Buffers, byte-preserving: each
// returned Buffer is one source line without its line terminator ('\n', or
// '\r\n' when present). Trailing-newline handling means a final line without
// EOL is still returned. JSONL catalogs are LF-terminated; the CRLF case is
// handled defensively for portability.
export function splitLineBuffers(data) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) continue;
    let end = index;
    if (end > start && data[end - 1] === 0x0d) end -= 1; // strip CR of a CRLF pair
    lines.push(data.subarray(start, end));
    start = index + 1;
  }
  if (start < data.length) lines.push(data.subarray(start));
  return lines;
}

// Read a text file into its line CONTENTS as Buffers (see splitLineBuffers).
export function readLineBuffers(absPath) {
  return splitLineBuffers(fs.readFileSync(absPath));
}

// ── Run-id normalization (controller representation) ───────────────
// The controller persists run ids as `run-<uuid>` and stores them in the
// contained DB either with or without the `run-` prefix. Every stored id is
// normalized the way tt-controller's normalizedStoredRunId does before it is
// matched or reported.

export function normalizedRunId(value) {
  if (typeof value !== 'string') return null;
  const match = /^run-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  return match === null ? null : `run-${match[1].toLowerCase()}`;
}

export function normalizedStoredRunId(value) {
  const external = normalizedRunId(value);
  if (external !== null) return external;
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }
  return `run-${value.toLowerCase()}`;
}

// ── Containment helpers ────────────────────────────────────────────

// Resolve a root-relative path (`catalog`/`task` references) to an absolute
// path and assert it stays strictly inside `rootAbs`. The candidate must be a
// relative path with no traversal; every EXISTING prefix must resolve
// (realpath) strictly inside the real root, so a symlink escape is refused
// before the file is ever opened. Returns the absolute path.
export function resolveContainedUnder(candidate, rootAbs, label = 'path') {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  assertNoTraversal(candidate, label);
  const portable = candidate.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) {
    throw refusal(`${label} must be relative to the contained root: ${candidate}`, 'TT_ESCAPE');
  }
  const rootReal = fs.realpathSync(rootAbs);
  const resolved = path.resolve(rootAbs, portable);
  const real = resolveExistingRealPath(resolved) ?? resolved;
  if (!pathIsWithin(rootReal, real)) {
    throw refusal(`${label} escapes the contained root ${rootAbs}: ${candidate}`, 'TT_ESCAPE');
  }
  return resolved;
}

// Validate the var root for THIS checkout before any write (both auto and
// explicit output modes). The var root must physically live at
// <real torture-test>/var and must never be reached through a symlink:
// a symlinked or escaped var root could redirect every subsequent write
// (auto allocations, explicit --out) outside the checkout.
//
// Pure and parameterized so hermetic tests can exercise it against fresh
// fixture mirrors; the CLI always passes this checkout's real VAR_ROOT/TT_DIR.
export function assertVarRootContained({ varRoot = VAR_ROOT, ttDir = TT_DIR } = {}) {
  if (typeof varRoot !== 'string' || varRoot.length === 0 || typeof ttDir !== 'string' || ttDir.length === 0) {
    throw new Error('assertVarRootContained requires non-empty varRoot and ttDir');
  }
  const ttReal = fs.realpathSync(ttDir);
  const expectedReal = path.join(ttReal, 'var');
  if (fs.existsSync(varRoot)) {
    const details = fs.lstatSync(varRoot);
    if (details.isSymbolicLink()) {
      throw refusal(
        `refusing a symlinked var root (never follow a symlinked runtime root): ${varRoot}`,
        'TT_SYMLINK',
      );
    }
    if (!details.isDirectory()) {
      throw refusal(`refusing a var root that is not a directory: ${varRoot}`, 'TT_ESCAPE');
    }
  }
  const real = resolveExistingRealPath(varRoot);
  if (real === null) {
    throw refusal(`cannot resolve the var root ${varRoot} against any existing ancestor`, 'TT_ESCAPE');
  }
  if (real !== expectedReal) {
    throw refusal(
      `refusing a var root outside this checkout's torture-test/var: ${varRoot} resolves to ${real} (expected ${expectedReal})`,
      'TT_ESCAPE',
    );
  }
  return real;
}

// Validate the checkout var root and create it when a fresh checkout lacks it
// (mirrors tt-controller's own var bootstrap). Called only from prepare /
// sample output allocation — help/usage stays entirely side-effect free.
export function ensureVarRoot({ varRoot = VAR_ROOT, ttDir = TT_DIR } = {}) {
  assertVarRootContained({ varRoot, ttDir });
  if (fs.existsSync(varRoot)) return;
  try {
    fs.mkdirSync(varRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// Fresh unique destination directory: <varRoot>/<prefix><ts>-<rand>/.
// mkdir is exclusive and never recursive; on the astronomically unlikely
// EEXIST a new random suffix is tried. Never deletes anything.
export function allocFreshOutDir({ varRoot = VAR_ROOT, prefix = 'contention-slice-' } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stamp = utcTimestamp().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    const candidate = path.join(varRoot, `${prefix}${stamp}-${rand}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`cannot allocate a fresh unique destination under ${varRoot}`);
}

// Validate an EXPLICIT output destination (prepare/sample --out). Every check
// runs BEFORE any mkdir so a refusal leaves nothing behind. Refusals carry a
// clear message and a machine-parseable code. The var root must already be
// validated (assertVarRootContained) before this is called.
export function resolveExplicitOutDir(rawOut, { varRoot = VAR_ROOT } = {}) {
  if (typeof rawOut !== 'string' || rawOut.length === 0) {
    throw new Error('--out requires a destination directory path');
  }
  const varReal = fs.realpathSync(varRoot);
  const candidate = path.resolve(process.cwd(), rawOut);
  assertNoTraversal(rawOut, 'output destination');
  // Lexical containment: the resolved destination must sit strictly inside
  // the var root (never var itself, never outside it).
  if (!pathIsWithin(varReal, candidate) || candidate === varRoot) {
    throw refusal(
      `refusing output destination outside torture-test/var: ${rawOut} (resolves to ${candidate})`,
      'TT_ESCAPE',
    );
  }
  // Existing-prefix walk: every EXISTING component of the destination must be
  // a plain directory whose realpath stays strictly inside the real var root
  // — an existing destination symlink or an ancestor symlink that could
  // redirect the write elsewhere (a symlink escape) is refused, never
  // silently followed.
  const relative = path.relative(varRoot, candidate);
  let current = varRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let details;
    try {
      details = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break; // nothing further exists below here
      throw new Error(`cannot inspect destination ancestor ${current}: ${error.message}`);
    }
    if (details.isSymbolicLink()) {
      throw refusal(
        `refusing output destination through an existing symlink (never silently follow a destination symlink): ${current}`,
        'TT_SYMLINK',
      );
    }
    let real;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      throw refusal(
        `refusing output destination: cannot resolve ${current}: ${error.message}`,
        'TT_SYMLINK',
      );
    }
    if (!pathIsWithin(varReal, real)) {
      throw refusal(
        `refusing output destination that escapes torture-test/var via ${current} (resolves to ${real})`,
        'TT_ESCAPE',
      );
    }
  }
  // Never overwrite/reuse: the destination itself must not exist (dir, file,
  // or symlink — including a dangling symlink whose lstat succeeds).
  try {
    fs.lstatSync(candidate);
    throw refusal(
      `refusing output destination that already exists (never overwrite or reuse a preparation/result directory): ${candidate}`,
      'TT_EXISTS',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(candidate);
  const parentDetails = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentDetails === undefined || !parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw refusal(
      `refusing output destination: parent directory does not exist or is not a plain directory: ${parent}`,
      'TT_ESCAPE',
    );
  }
  return candidate;
}

// Validate an EXPLICIT INPUT path (prep dir, campaign dir, campaign DB) that
// sample/summarize open read-only. The path must sit strictly inside the real
// var root, must not traverse an existing symlink segment (a symlink escape),
// and must not contain a raw '..' segment.
//
// Every EXISTING component is checked (plain, non-symlink, realpath inside
// var). Absence semantics:
//   - kind 'dir': the final directory must exist (a missing prep/campaign dir
//     is an operator error);
//   - kind 'file' with allowMissing: any missing tail below var (the campaign
//     home may not be provisioned yet) is allowed — absence is EVIDENCE
//     (UNKNOWN), never a zero, and the DB is never created; when the final
//     component DOES exist it must be a plain regular file.
export function resolveContainedInput(raw, {
  label = 'path',
  varRoot = VAR_ROOT,
  kind = 'auto', // 'dir' | 'file' | 'auto'
  allowMissing = false,
} = {}) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const varReal = fs.realpathSync(varRoot);
  const candidate = path.resolve(process.cwd(), raw);
  assertNoTraversal(raw, label);
  const relative = path.relative(varReal, candidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw refusal(
      `${label} is outside the contained root torture-test/var: ${raw} (resolves to ${candidate})`,
      'TT_ESCAPE',
    );
  }
  let current = varReal;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const isFinal = index === segments.length - 1;
    current = path.join(current, segments[index]);
    let details;
    try {
      details = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (kind === 'file' && allowMissing) return candidate; // missing DB is evidence
        throw new Error(`${label} does not exist: ${candidate}`);
      }
      throw new Error(`cannot inspect ${label} component ${current}: ${error.message}`);
    }
    if (details.isSymbolicLink()) {
      throw refusal(
        `${label} traverses an existing symlink (symlink escape refused): ${current}`,
        'TT_SYMLINK',
      );
    }
    const real = fs.realpathSync(current);
    if (!pathIsWithin(varReal, real)) {
      throw refusal(
        `${label} escapes torture-test/var via ${current} (resolves to ${real})`,
        'TT_ESCAPE',
      );
    }
    if (isFinal) {
      if (kind === 'dir' && !details.isDirectory()) {
        throw refusal(`${label} is not a directory: ${candidate}`, 'TT_ESCAPE');
      }
      if (kind === 'file' && !details.isFile()) {
        throw refusal(`${label} is not a regular file: ${candidate}`, 'TT_ESCAPE');
      }
    } else if (!details.isDirectory()) {
      throw new Error(`${label} component is not a directory: ${current}`);
    }
  }
  return candidate;
}

// ── Selection loading (canonical, fixed; pure injection for tests) ──

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Parse + shape-validate one selection entry: { id, catalog } with id
// matching the controller's contained case-id pattern. Throws a clear error
// for a malformed entry. (`line` is accepted and ignored: legacy provenance
// entries carry it, but lines are discovered, never pinned.)
function normalizeEntry(entry, index) {
  const where = `selection entry ${index + 1}`;
  if (!isPlainObject(entry)) throw new Error(`${where} must be an object { id, catalog }`);
  if (typeof entry.id !== 'string' || !CASE_ID_PATTERN.test(entry.id)) {
    throw new Error(`${where} has an invalid id: ${JSON.stringify(entry.id)}`);
  }
  if (typeof entry.catalog !== 'string' || entry.catalog.length === 0) {
    throw new Error(`${where} has an invalid catalog: ${JSON.stringify(entry.catalog)}`);
  }
  return { id: entry.id, catalog: entry.catalog };
}

// Load + validate a request selection. The real CLI always passes the fixed
// canonical roster (CANONICAL_SELECTION); tests may inject an explicit array
// to exercise request-level duplicates/invalid shapes through the pure helper.
// Request-level duplicate ids are a hard error — each selected id must be
// required exactly once.
export function loadSelection(entries = CANONICAL_SELECTION) {
  if (!Array.isArray(entries)) throw new Error('selection must be an array of { id, catalog } entries');
  const normalized = entries.map(normalizeEntry);
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.id)) {
      throw new Error(`duplicate selected id in request: ${entry.id} (each selected id must be required exactly once)`);
    }
    seen.add(entry.id);
  }
  return normalized;
}

// ── Catalog snapshots + row discovery (byte-preserving) ────────────

// A catalog "snapshot" is the single in-memory Buffer a catalog file was read
// into during selection. Every provenance hash (catalog, row, manifest) is
// derived from these same bytes, and the drift re-check re-hashes the file on
// disk against the snapshot afterwards — a source change between the reads
// can never label old rows as a new clean pinned commit.
export function snapshotCatalogFiles(selection, { catalogRoot = TT_DIR } = {}) {
  const byPath = new Map();
  for (const entry of selection) {
    const catalogAbs = resolveContainedUnder(entry.catalog, catalogRoot, `catalog ${entry.catalog}`);
    if (!byPath.has(catalogAbs)) {
      let details;
      try {
        details = fs.lstatSync(catalogAbs, { throwIfNoEntry: false });
      } catch (error) {
        throw new Error(`cannot stat catalog ${entry.catalog}: ${error.message}`);
      }
      if (details === undefined) throw new Error(`catalog does not exist: ${entry.catalog}`);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error(`catalog is not a regular file: ${entry.catalog}`);
      }
      const bytes = fs.readFileSync(catalogAbs);
      byPath.set(catalogAbs, {
        catalog: entry.catalog,
        catalogAbs,
        bytes,
        sha256: sha256(bytes),
        lines: splitLineBuffers(bytes),
      });
    }
  }
  return byPath;
}

// Discover each selected id exactly once inside the catalog byte snapshots.
// Returns, in selection order, rows carrying the id, the TT-relative catalog
// path, the DISCOVERED 1-based line, the byte-exact source row (a subarray of
// the snapshot), and the parsed record. A missing id or an id occurring more
// than once is a hard error; nothing is written by this function.
//
// `catalogRoot` is the base each entry.catalog is relative to: torture-test/
// for the operator, an explicit fixture mirror for hermetic tests. It MUST
// match the root snapshotCatalogFiles used so the snapshot keys line up.
export function discoverSelectionRows(selection, snapshots, { catalogRoot = TT_DIR } = {}) {
  for (const entry of selection) {
    const catalogAbs = resolveContainedUnder(entry.catalog, catalogRoot, `catalog ${entry.catalog}`);
    const snapshot = snapshots.get(catalogAbs);
    if (snapshot === undefined) throw new Error(`catalog snapshot missing for ${entry.catalog}`);
    const hits = [];
    snapshot.lines.forEach((lineBytes, index) => {
      const lineText = lineBytes.toString('utf8');
      if (lineText.trim() === '') return;
      let record;
      try {
        record = JSON.parse(lineText);
      } catch {
        return; // not a case row; ignored by the manifest loader too
      }
      if (record !== null && typeof record === 'object' && record.id === entry.id) {
        hits.push({ line: index + 1, rowBytes: lineBytes, record });
      }
    });
    if (hits.length === 0) {
      throw new Error(`selected id ${entry.id} is MISSING from ${toPosix(path.relative(TT_DIR, catalogAbs))}`);
    }
    if (hits.length > 1) {
      throw new Error(`selected id ${entry.id} occurs ${hits.length} times in ${toPosix(path.relative(TT_DIR, catalogAbs))} (must appear exactly once)`);
    }
  }
  return selection.map((entry) => {
    const catalogAbs = resolveContainedUnder(entry.catalog, catalogRoot, `catalog ${entry.catalog}`);
    const snapshot = snapshots.get(catalogAbs);
    const hits = [];
    snapshot.lines.forEach((lineBytes, index) => {
      const lineText = lineBytes.toString('utf8');
      if (lineText.trim() === '') return;
      let record;
      try {
        record = JSON.parse(lineText);
      } catch {
        return;
      }
      if (record !== null && typeof record === 'object' && record.id === entry.id) {
        hits.push({ line: index + 1, rowBytes: lineBytes, record });
      }
    });
    return {
      id: entry.id,
      catalog: toPosix(path.relative(TT_DIR, catalogAbs)),
      catalogAbs,
      line: hits[0].line,
      rowBytes: hits[0].rowBytes,
      record: hits[0].record,
    };
  });
}

// Hash a case record's `task` reference (torture-test-relative) for
// provenance. REQUIRED flavor for preparation: a missing/escaped/unreadable/
// non-regular task source (or a record without a task reference) throws — a
// successful pinned preparation never carries null task hashes.
export function requireTaskFileHash(record, { ttDir = TT_DIR } = {}) {
  const task = record?.task;
  if (typeof task !== 'string' || task.length === 0) {
    throw new Error(`record ${record?.id ?? '(unknown)'} carries no task reference; a pinned preparation requires a hashable task source`);
  }
  const abs = resolveContainedUnder(task, ttDir, `task path ${task}`);
  let details;
  try {
    details = fs.lstatSync(abs, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`cannot stat required task source ${task}: ${error.message}`);
  }
  if (details === undefined) {
    throw new Error(`required task source does not exist: ${task}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`required task source is not a regular file: ${task}`);
  }
  const bytes = fs.readFileSync(abs);
  return {
    task,
    task_sha256: sha256(bytes),
    task_bytes: bytes.length,
    task_error: null,
  };
}

// Drift re-check: re-read each snapshot's catalog file from disk and compare
// its sha256 against the snapshot bytes used for selection. Returns the list
// of drifted catalogs ({ catalog, expected, actual }). Read errors count as
// drift (a catalog that became unreadable mid-preparation cannot be pinned).
export function checkCatalogDrift(snapshots) {
  const drifted = [];
  for (const snapshot of snapshots.values()) {
    let actual = null;
    let error = null;
    try {
      actual = sha256(fs.readFileSync(snapshot.catalogAbs));
    } catch (readError) {
      error = readError.message;
    }
    if (error !== null || actual !== snapshot.sha256) {
      drifted.push({
        catalog: snapshot.catalog,
        expected_sha256: snapshot.sha256,
        actual_sha256: actual,
        error,
      });
    }
  }
  return drifted;
}

// ── Spawn environment for child processes (controller --validate-only) ─
// The controller is invoked read-only and contained. Guard propagation is
// PRESERVED: this function never forces TAMANDUA_TEST_GUARD=0 and never
// strips NODE_TEST_CONTEXT (the node:test auto-armed isolation guard stays
// armed in the child, exactly as the isolation contract requires). The caller
// supplies isolated, contained HOME/state paths via `isolated` (a directory
// created under the invocation's own output dir) so the child can never see
// the operator's real HOME/TAMANDUA_STATE_DIR. Never mutates the caller's
// environment.
export function childSpawnEnv(env = process.env, { isolated = null } = {}) {
  const child = { ...env };
  if (isolated !== null) {
    child.HOME = isolated;
    child.TT_HOME = isolated;
    child.TAMANDUA_STATE_DIR = path.join(isolated, '.tamandua');
    child.TAMANDUA_DB_PATH = path.join(isolated, '.tamandua', 'tamandua.db');
  }
  return child;
}

// ── Observer scheduling (pure, testable without real time) ─────────
// Delay until the next due sample (startedMs + sampleIndex * intervalMs),
// CAPPED so the observer never sleeps past an explicit observation-window
// boundary (startedMs + windowMs): a bounded window must not overshoot through
// a whole interval sleep (a 1s window with a 15s cadence sleeps ~1s, not 15s).
// windowMs === null means unbounded (pure interval cadence). Returns 0 when no
// delay remains. Pure: no timers, no signals, no I/O — the timer contract is
// unit-testable with synthetic timestamps.
export function sampleDelayMs({ startedMs, nowMs, sampleIndex, intervalMs, windowMs }) {
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || !Number.isSafeInteger(sampleIndex)) {
    throw new Error('sampleDelayMs requires finite startedMs/nowMs and an integer sampleIndex');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`sampleDelayMs requires a positive integer intervalMs, got: ${intervalMs}`);
  }
  if (windowMs !== null && (!Number.isSafeInteger(windowMs) || windowMs <= 0)) {
    throw new Error(`sampleDelayMs requires a positive integer windowMs or null, got: ${windowMs}`);
  }
  const due = startedMs + sampleIndex * intervalMs;
  const intervalDelay = Math.max(0, due - nowMs);
  if (windowMs === null) return intervalDelay;
  const windowRemaining = windowMs - (nowMs - startedMs);
  if (windowRemaining <= 0) return 0;
  return Math.min(intervalDelay, windowRemaining);
}

// ── Read-only evidence readers (campaign state + contained DB) ──────
// These helpers NEVER write: no DB creation/migration, no state mutation, no
// listener binding, no workflow/control command execution. Every read failure
// is surfaced as UNKNOWN/missing evidence — never as zero active work.

export function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Read + parse a campaign state.json. Returns { ok, state, error } — a
// missing/unreadable/corrupt file is an evidence failure (ok:false, error
// message), never a throw.
export function readCampaignState(statePath) {
  try {
    const details = fs.lstatSync(statePath, { throwIfNoEntry: false });
    if (details === undefined) return { ok: false, state: null, error: `campaign state file does not exist: ${statePath}` };
    if (!details.isFile() || details.isSymbolicLink()) {
      return { ok: false, state: null, error: `campaign state file is not a contained regular file: ${statePath}` };
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!isPlainRecord(state)) return { ok: false, state: null, error: 'campaign state is not a JSON object' };
    if (!Array.isArray(state.cases)) return { ok: false, state: null, error: 'campaign state carries no cases array' };
    return { ok: true, state, error: null };
  } catch (error) {
    return { ok: false, state: null, error: `cannot read campaign state ${statePath}: ${error.message}` };
  }
}

// Map a case record from campaign state (all attempts, including explicitly
// recorded replacement attempts). Returns null when the case id is absent
// from state.cases.
export function campaignCaseRecord(state, caseId) {
  for (const candidate of state.cases) {
    if (isPlainRecord(candidate) && candidate.id === caseId) return candidate;
  }
  return null;
}

// Gather the normalized run ids recorded across a case record's attempts
// (attempt.run_id), plus per-attempt detail. Attempts whose run_id is set to
// a non-run value or whose identification errored (run_id_error) carry no run
// id and are reported so a case with no scoped run is never silently treated
// as complete. Per-attempt detail distinguishes an INVALID recorded run id
// (present but not a run-<uuid> / <uuid>) from a MISSING one (not yet
// acquired); the caller decides how each surfaces as unknown coverage.
export function attemptsOfCase(caseRecord) {
  const attempts = [];
  const runIds = [];
  const seen = new Set();
  const list = Array.isArray(caseRecord?.attempts) ? caseRecord.attempts : [];
  for (const attempt of list) {
    if (!isPlainRecord(attempt)) continue;
    const runId = normalizedStoredRunId(attempt.run_id);
    const rawRunIdPresent = typeof attempt.run_id === 'string' && attempt.run_id.length > 0;
    const detail = {
      attempt_id: typeof attempt.id === 'string' ? attempt.id : null,
      phase: typeof attempt.phase === 'string' ? attempt.phase : null,
      outcome: attempt.outcome ?? null,
      terminal: attempt.phase === 'terminal' || attempt.outcome !== undefined,
      run_id: runId,
      run_id_error: attempt.run_id_error !== undefined && attempt.run_id_error !== null,
      run_id_raw: rawRunIdPresent ? attempt.run_id : null,
      run_id_invalid: rawRunIdPresent && runId === null,
    };
    attempts.push(detail);
    if (runId !== null && !seen.has(runId)) {
      seen.add(runId);
      runIds.push(runId);
    }
  }
  return { attempts, runIds };
}

// Open the campaign DB READ-ONLY and observe the exact scoped run ids. Each
// run row is matched in both stored spellings (run-<uuid> and bare <uuid>),
// and step rows in claimed/running states are counted per run. A missing DB
// file or any open/read failure is captured as evidence (db.error), with
// every scoped run reported UNKNOWN — never as zero active work. Returns
// { db: {path_present, opened, snapshot, error}, runs: {runId: {...}} }.
export function readScopedDbSnapshot(dbPath, runIds) {
  const result = {
    db: {
      path_present: fs.existsSync(dbPath),
      opened: false,
      snapshot: null,
      error: null,
    },
    runs: {},
  };
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    result.db.opened = true;
  } catch (error) {
    result.db.error = `cannot open the campaign DB read-only (${dbPath}): ${error.message}`;
    return result;
  }
  try {
    // node:sqlite opens lazily: a corrupt file (not a SQLite database) or a
    // schema-mismatched DB only fails on first read. Probe the header/tables
    // explicitly so a corrupt/mismatched DB surfaces as a DB-level evidence
    // error (every scoped run then UNKNOWN) instead of a silent empty read.
    let tables = [];
    try {
      tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name);
    } catch (error) {
      result.db.opened = false;
      result.db.error = `campaign DB is not readable as SQLite (${dbPath}): ${error.message}`;
      return result;
    }
    const missingTables = ['runs', 'steps'].filter((table) => !tables.includes(table));
    if (missingTables.length > 0) {
      result.db.opened = false;
      result.db.error = `campaign DB schema mismatch (${dbPath}): missing table(s) ${missingTables.join(', ')}`;
      return result;
    }
    // One read-only snapshot where practical: a deferred read transaction
    // keeps runs + steps reads consistent. A DB that refuses transactions
    // (locking mode edge) falls back to plain sequential reads on the same
    // single connection.
    let inTransaction = false;
    try {
      database.exec('BEGIN');
      inTransaction = true;
      result.db.snapshot = 'transaction';
    } catch {
      result.db.snapshot = 'plain';
    }
    try {
      for (const runId of runIds) {
        result.runs[runId] = observeScopedRun(database, runId);
      }
    } finally {
      if (inTransaction) {
        try {
          database.exec('COMMIT');
        } catch {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Best effort; the per-run observations above are already captured.
          }
        }
      }
    }
  } catch (error) {
    result.db.error = `campaign DB read failed: ${error.message}`;
  } finally {
    try {
      database.close();
    } catch {
      // Best effort; evidence is already captured.
    }
  }
  return result;
}

function observeScopedRun(database, runId) {
  const stored = runId.startsWith('run-') ? runId.slice(4) : runId;
  const observation = { present: false, status: null, terminal: false, claimed_steps: 0, running_steps: 0, error: null };
  try {
    const runRows = database.prepare(
      'SELECT id, status FROM runs WHERE id = ? OR id = ? LIMIT 2',
    ).all(runId, stored);
    if (runRows.length === 0) {
      observation.missing = true;
    } else {
      const row = runRows[0];
      observation.present = true;
      observation.status = typeof row.status === 'string' ? row.status : null;
      observation.terminal = TERMINAL_RUN_STATUSES.includes(observation.status);
    }
    const stepRows = database.prepare(
      `SELECT status, COUNT(*) AS n FROM steps
       WHERE (run_id = ? OR run_id = ?) AND status IN ('claimed', 'running')
       GROUP BY status`,
    ).all(runId, stored);
    for (const step of stepRows) {
      const count = Number(step.n ?? 0);
      if (step.status === 'claimed') observation.claimed_steps = count;
      if (step.status === 'running') observation.running_steps = count;
    }
  } catch (error) {
    observation.error = error.message;
  }
  return observation;
}

// Assemble a single timestamped sample for the selected cases. Pure read-only
// composition of campaign state + scoped DB observations; never writes.
//
// Semantics (STORM-I US-002 honesty rules):
//   - only run ids recorded on the SELECTED cases' attempts are scoped; a
//     decoy/unrelated run in the DB is never queried or counted;
//   - a missing run row, an unreadable DB, or a corrupt/missing campaign state
//     is UNKNOWN evidence (surfaced in db/state errors and unknown lists),
//     never evidence of zero active work or completion;
//   - an ACTIVE attempt (in flight, not terminal, not 'pending') whose run id
//     could not be identified — run_id_error recorded, an invalid run id, or
//     an id not yet acquired — is UNKNOWN coverage for its running case (added
//     to unknown_cases, plus an observation error when the controller recorded
//     run_id_error); a genuinely not-started pending case or terminal NOT_RUN
//     stays clean;
//   - the campaign DB is opened strictly read-only; nothing is created,
//     migrated, bound, or executed.
export function composeSample({
  sampleIndex,
  sampledAt,
  selectedCaseIds,
  campaignDir,
  dbPath,
  prep,
}) {
  const observationErrors = [];
  const missingCaseRecords = [];
  const cases = [];
  const allRunIds = [];

  const statePath = path.join(campaignDir, 'state.json');
  const read = readCampaignState(statePath);
  const campaign = { dir: campaignDir, state_present: read.ok, state_error: read.error, manifest_case_ids: null };
  if (!read.ok) {
    if (read.error !== null) observationErrors.push(read.error);
  } else {
    campaign.manifest_case_ids = Array.isArray(read.state.manifest?.case_ids)
      ? read.state.manifest.case_ids.filter((id) => typeof id === 'string')
      : null;
    if (campaign.manifest_case_ids !== null) {
      for (const caseId of selectedCaseIds) {
        if (!campaign.manifest_case_ids.includes(caseId)) {
          observationErrors.push(`campaign manifest does not include selected case ${caseId}`);
        }
      }
    }
    for (const caseId of selectedCaseIds) {
      const caseRecord = campaignCaseRecord(read.state, caseId);
      if (caseRecord === null) {
        missingCaseRecords.push(caseId);
        observationErrors.push(`selected case ${caseId} is absent from the campaign state`);
        cases.push({
          case_id: caseId,
          present_in_state: false,
          phase: null,
          terminal: false,
          outcome: null,
          attempt_count: 0,
          attempts: [],
          run_ids: [],
          errors: ['case absent from campaign state'],
        });
        continue;
      }
      const { attempts, runIds } = attemptsOfCase(caseRecord);
      for (const runId of runIds) {
        if (!allRunIds.includes(runId)) allRunIds.push(runId);
      }
      cases.push({
        case_id: caseId,
        present_in_state: true,
        phase: typeof caseRecord.phase === 'string' ? caseRecord.phase : null,
        terminal: caseRecord.phase === 'terminal',
        outcome: caseRecord.outcome ?? null,
        attempt_count: attempts.length,
        attempts,
        run_ids: runIds,
        errors: [],
      });
    }
  }

  // DB observation only over the exact scoped run ids (state-derived). A
  // decoy/unrelated run in the DB is never queried or counted.
  const db = { path_present: fs.existsSync(dbPath), opened: false, snapshot: null, error: null };
  let observed = { runs: {} };
  if (allRunIds.length > 0) {
    observed = readScopedDbSnapshot(dbPath, allRunIds);
    db.path_present = observed.db.path_present;
    db.opened = observed.db.opened;
    db.snapshot = observed.db.snapshot;
    db.error = observed.db.error;
    if (observed.db.error !== null) observationErrors.push(observed.db.error);
  }

  // Attach case ownership to each scoped run id and fold in DB observations.
  const runIndex = {};
  for (const caseEntry of cases) {
    for (const runId of caseEntry.run_ids) {
      runIndex[runId] ??= { case_ids: [], present: false, missing: false, status: null, terminal: false, claimed_steps: 0, running_steps: 0, error: null };
      if (!runIndex[runId].case_ids.includes(caseEntry.case_id)) runIndex[runId].case_ids.push(caseEntry.case_id);
    }
  }
  for (const [runId, entry] of Object.entries(runIndex)) {
    const seen = observed.runs[runId];
    if (seen === undefined || db.error !== null) {
      // DB unavailable or this scoped run was never observed: UNKNOWN.
      entry.missing = true;
      entry.error = db.error ?? 'database unavailable';
      continue;
    }
    entry.present = seen.present;
    entry.missing = seen.missing ?? false;
    entry.status = seen.status;
    entry.terminal = seen.terminal;
    entry.claimed_steps = seen.claimed_steps;
    entry.running_steps = seen.running_steps;
    entry.error = seen.error;
    if (seen.error !== null) observationErrors.push(`run ${runId} read error: ${seen.error}`);
  }

  let claimedRunCount = 0;
  let claimedStepCount = 0;
  let activeRunCount = 0;
  const unknownRuns = [];
  for (const [runId, entry] of Object.entries(runIndex)) {
    const steps = entry.claimed_steps + entry.running_steps;
    if (steps > 0) {
      claimedRunCount += 1;
      claimedStepCount += steps;
    }
    if (entry.present && !entry.terminal && entry.error === null) activeRunCount += 1;
    if (!entry.present || entry.error !== null) unknownRuns.push(runId);
  }

  // active cases = selected cases whose case record phase is 'running' (the
  // controller's own campaign-activity truth) AND that have at least one
  // scoped run that is present and non-terminal (observed). A non-terminal
  // case whose run rows are all missing/unknown is UNKNOWN (unknown_cases),
  // never zero.
  let activeCases = 0;
  const unknownCases = [];
  for (const caseEntry of cases) {
    if (!caseEntry.present_in_state) {
      unknownCases.push({ case_id: caseEntry.case_id, reason: 'absent from campaign state' });
      continue;
    }
    const runEntries = caseEntry.run_ids.map((runId) => runIndex[runId]);
    const observedActive = runEntries.some((entry) => entry.present && !entry.terminal && entry.error === null);
    const anyUnknown = runEntries.some((entry) => !entry.present || entry.error !== null);
    // In-flight attempts whose run id could not be identified: NOT terminal,
    // NOT a genuinely not-started 'pending' attempt, and carrying no scoped run
    // id (run_id_error recorded, an invalid run id, or an id not yet acquired).
    const unidentifiedActiveAttempts = caseEntry.phase === 'running'
      ? caseEntry.attempts.filter(
        (attempt) => attempt.terminal === false
          && attempt.phase !== 'pending'
          && attempt.run_id === null,
      )
      : [];
    if (caseEntry.phase === 'running' && observedActive) {
      activeCases += 1;
    } else if (caseEntry.phase !== 'terminal' && !observedActive
      && (anyUnknown || unidentifiedActiveAttempts.length > 0)) {
      // Non-terminal case with no observed active run: either its run rows are
      // missing/unknown, or — for a case the campaign says is RUNNING — an
      // in-flight attempt whose run id could not be identified (run_id_error,
      // an invalid run id, or an id not yet acquired) makes the case's current
      // activity UNKNOWN. A genuinely not-started pending case (phase
      // 'pending', no in-flight attempt) or a terminal NOT_RUN stays clean.
      const reasons = [];
      if (anyUnknown) reasons.push('run rows missing/unknown');
      for (const attempt of unidentifiedActiveAttempts) {
        if (attempt.run_id_error) {
          reasons.push(`active attempt ${attempt.attempt_id ?? '(unknown)'} carries run_id_error and no scoped run id`);
          observationErrors.push(
            `case ${caseEntry.case_id}: active attempt ${attempt.attempt_id ?? '(unknown)'} has run_id_error and no scoped run id; its activity is UNKNOWN`,
          );
        } else if (attempt.run_id_invalid) {
          reasons.push(`active attempt ${attempt.attempt_id ?? '(unknown)'} records an invalid run id ${attempt.run_id_raw ?? ''}`);
        } else {
          reasons.push(`active attempt ${attempt.attempt_id ?? '(unknown)'} has not yet acquired a scoped run id`);
        }
      }
      unknownCases.push({ case_id: caseEntry.case_id, reason: reasons.join('; ') });
    }
  }

  const runs = {};
  for (const [runId, entry] of Object.entries(runIndex)) {
    runs[runId] = {
      case_ids: entry.case_ids,
      present: entry.present,
      missing: entry.missing,
      status: entry.status,
      terminal: entry.terminal,
      claimed_steps: entry.claimed_steps,
      running_steps: entry.running_steps,
      error: entry.error,
    };
  }

  const terminalCases = cases.filter((caseEntry) => caseEntry.terminal).length;
  const aggregates = {
    selected_case_count: selectedCaseIds.length,
    case_records_found: cases.filter((c) => c.present_in_state).length,
    terminal_cases: terminalCases,
    active_cases: activeCases,
    active_runs: activeRunCount,
    claimed_run_count: claimedRunCount,
    claimed_step_count: claimedStepCount,
    unknown_run_ids: unknownRuns,
    unknown_cases: unknownCases,
    missing_case_records: missingCaseRecords,
    observation_errors: [...new Set(observationErrors)],
  };

  return {
    sample_index: sampleIndex,
    sampled_at: sampledAt,
    selected_case_ids: [...selectedCaseIds],
    prep: prep ?? null,
    campaign: {
      dir: campaignDir,
      state_present: campaign.state_present,
      state_error: campaign.state_error,
      manifest_case_ids: campaign.manifest_case_ids,
    },
    db: { path_present: db.path_present, opened: db.opened, snapshot: db.snapshot, error: db.error },
    cases,
    runs,
    aggregates,
    all_selected_cases_terminal: cases.length > 0 && cases.every((caseEntry) => caseEntry.terminal),
  };
}

// ── Summary core (STORM-I US-003) ─────────────────────────────────
// Consumes the persisted US-002 sample evidence (samples.jsonl +
// observer.json) plus the US-001 provenance/selection and reports the
// CONFIGURED case concurrency separately from the OBSERVED claimed-step
// peak, the actual per-case executed/NOT_RUN/terminal counts, and the
// coverage gaps (missed intervals, a late observer start, trailing/
// unobserved windows) — honestly. A peak below 3, UNKNOWN run/case
// observations, corrupt/missing evidence, or an observer that started after
// the campaign was already terminal all forbid an unqualified passed-storm
// claim, and the report says so explicitly. A decoy/unrelated run id (one
// not recorded on any SELECTED case's attempts in that sample) never
// contributes to any observed count. Everything here is pure (no I/O): the
// CLI parses the files and writes the report; hermetic tests feed toy
// sample sets directly.

// Parse persisted samples.jsonl evidence into valid sample records + an
// explicit corrupt-line list. A line that is not JSON or not a well-formed
// sample record is corrupt evidence — never silently dropped.
export function parseSamplesEvidence(text) {
  const samples = [];
  const corruptLines = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const lineNumber = index + 1;
    if (lineText.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(lineText);
    } catch (error) {
      corruptLines.push({
        line: lineNumber,
        raw: lineText.length > 160 ? `${lineText.slice(0, 160)}...` : lineText,
        error: `sample line ${lineNumber} is not valid JSON: ${error.message}`,
      });
      continue;
    }
    if (!isPlainRecord(record)) {
      corruptLines.push({
        line: lineNumber,
        raw: String(lineText).slice(0, 160),
        error: `sample line ${lineNumber} is not a JSON object`,
      });
      continue;
    }
    const structural = [];
    if (typeof record.sample_index !== 'number' || !Number.isSafeInteger(record.sample_index) || record.sample_index < 0) {
      structural.push('sample_index is missing or not a non-negative integer');
    }
    if (typeof record.sampled_at !== 'string' || Number.isNaN(Date.parse(record.sampled_at))) {
      structural.push('sampled_at is missing or not a parseable timestamp');
    }
    if (!isPlainRecord(record.aggregates)) structural.push('aggregates is missing or not an object');
    if (structural.length > 0) {
      corruptLines.push({
        line: lineNumber,
        raw: String(lineText).slice(0, 160),
        error: `sample line ${lineNumber} is not a well-formed sample record: ${structural.join('; ')}`,
      });
      continue;
    }
    samples.push(record);
  }
  return { samples, corruptLines };
}

// Recompute a single sample's scoped observation from its OWN run/case data
// (decoy-proof): only run ids recorded on a SELECTED case's attempts in that
// sample are counted. Mirrors composeSample's honesty semantics so a summary
// never trusts an inflated/forged aggregate blindly.
export function scopedObservationOfSample(sample, selectedCaseIds) {
  const selected = new Set(selectedCaseIds);
  const result = {
    claimed_run_count: 0,
    claimed_step_count: 0,
    active_case_count: 0,
    terminal_case_count: 0,
    decoy_run_ids: [],
  };
  // Scoping authority: run ids on the selected cases' attempt lists.
  const scoped = new Set();
  const caseEntries = Array.isArray(sample.cases) ? sample.cases : [];
  for (const caseEntry of caseEntries) {
    if (!isPlainRecord(caseEntry) || typeof caseEntry.case_id !== 'string') continue;
    if (!selected.has(caseEntry.case_id)) continue;
    const runIds = Array.isArray(caseEntry.run_ids) ? caseEntry.run_ids : [];
    for (const rawId of runIds) {
      const normalized = normalizedStoredRunId(rawId);
      if (normalized !== null) scoped.add(normalized);
    }
  }
  const runEntries = new Map();
  const runs = isPlainRecord(sample.runs) ? sample.runs : {};
  for (const [rawKey, entry] of Object.entries(runs)) {
    if (!isPlainRecord(entry)) continue;
    const normalized = normalizedStoredRunId(rawKey);
    const key = normalized !== null ? normalized : rawKey;
    if (!scoped.has(key)) {
      // An unrelated/decoy run: it may carry claimed steps but must never
      // contribute to any count or the observed peak.
      const steps = (Number(entry.claimed_steps) || 0) + (Number(entry.running_steps) || 0);
      if (steps > 0) result.decoy_run_ids.push(key);
      continue;
    }
    runEntries.set(key, entry);
  }
  let claimedSteps = 0;
  let claimedRuns = 0;
  for (const entry of runEntries.values()) {
    const steps = (Number(entry.claimed_steps) || 0) + (Number(entry.running_steps) || 0);
    if (steps > 0) {
      claimedSteps += steps;
      claimedRuns += 1;
    }
  }
  result.claimed_step_count = claimedSteps;
  result.claimed_run_count = claimedRuns;
  for (const caseEntry of caseEntries) {
    if (!isPlainRecord(caseEntry) || typeof caseEntry.case_id !== 'string') continue;
    if (!selected.has(caseEntry.case_id)) continue;
    if (caseEntry.phase === 'terminal') result.terminal_case_count += 1;
    if (caseEntry.phase !== 'running') continue;
    const runIds = Array.isArray(caseEntry.run_ids) ? caseEntry.run_ids : [];
    const observedActive = runIds.some((rawId) => {
      const normalized = normalizedStoredRunId(rawId);
      if (normalized === null) return false;
      const entry = runEntries.get(normalized);
      if (entry === undefined) return false;
      return entry.present === true
        && entry.terminal !== true
        && (entry.error === null || entry.error === undefined);
    });
    if (observedActive) result.active_case_count += 1;
  }
  return result;
}

// The full summary algorithm. Pure and deterministic over the given evidence;
// returns the summary object (JSON-serializable) that the CLI writes to
// summary.json and renders into summary.txt. Honesty is mechanical:
//   - observed_peak_below_three / evidence_insufficient / storm_claim_supported
//     with an explicit reasons list;
//   - corrupt/missing/UNKNOWN evidence is reported, never silently dropped;
//   - a decoy run id never contributes to the peak.
export function buildContentionSummary({
  selectedCaseIds = [],
  configured = null,
  observer = null,
  observerReadIssue = null,
  samples = [],
  corruptLines = [],
  samplesFileMissing = false,
  prepManifestSha256 = null,
  generatedAt = null,
} = {}) {
  const selected = [...selectedCaseIds];

  // ── Configured side (from the recorded provenance/controller argv) ──
  const config = configured === null || typeof configured !== 'object' || Array.isArray(configured)
    ? {}
    : configured;
  const configuredConcurrency = Number.isFinite(config.concurrency) && config.concurrency !== null
    ? Number(config.concurrency)
    : null;
  const configuredStagger = typeof config.stagger === 'string' ? config.stagger : null;
  const configuredArgv = Array.isArray(config.argv)
    ? config.argv.filter((arg) => typeof arg === 'string')
    : null;
  const configuredSource = typeof config.source === 'string' ? config.source : 'provenance';

  // ── Parse-time evidence state ──
  const evidenceErrors = []; // unique observation-error strings across samples
  const unknownRunSampleIndices = [];
  const unknownCaseSampleIndices = [];
  const sampleErrorRecords = [];
  const dataMismatches = [];
  const decoyExclusions = [];
  const prepBindingMismatches = [];
  const nonMonotonicIndices = [];
  const intervalMs = (observer !== null && observer !== undefined
    && Number.isFinite(observer.interval_ms) && observer.interval_ms !== null)
    ? Number(observer.interval_ms)
    : DEFAULT_SAMPLE_INTERVAL_MS;

  let peakClaimedRun = 0;
  let peakClaimedStep = 0;
  let peakSampleIndex = null;
  let anyActiveOverlap = false;
  let lateStartFlag = observer !== null && observer !== undefined && observer.first_sample_all_terminal === true;

  // Per-case history across samples (last present record wins for terminal
  // classification; any-present/running history keeps executed honest).
  const caseHistory = new Map(); // case_id -> { present, running, last, lastIndex, lastAt }
  for (const caseId of selected) {
    caseHistory.set(caseId, { present: false, running: false, last: null, lastIndex: null, lastAt: null });
  }

  for (const sample of samples) {
    const sampleIndex = sample.sample_index;
    const perSample = scopedObservationOfSample(sample, selected);
    if (perSample.claimed_step_count > peakClaimedStep) {
      peakClaimedStep = perSample.claimed_step_count;
      peakSampleIndex = sampleIndex;
    }
    peakClaimedRun = Math.max(peakClaimedRun, perSample.claimed_run_count);
    if (perSample.claimed_step_count > 0 || perSample.claimed_run_count > 0 || perSample.active_case_count > 0) {
      anyActiveOverlap = true;
    }
    for (const decoy of perSample.decoy_run_ids) {
      decoyExclusions.push({ sample_index: sampleIndex, run_id: decoy });
    }
    // Aggregate cross-checks: never silently trust an inflated aggregate.
    const aggregate = isPlainRecord(sample.aggregates) ? sample.aggregates : {};
    if (Number.isFinite(aggregate.claimed_step_count) && Number(aggregate.claimed_step_count) !== perSample.claimed_step_count) {
      dataMismatches.push({
        sample_index: sampleIndex,
        field: 'claimed_step_count',
        aggregate_value: Number(aggregate.claimed_step_count),
        recomputed_value: perSample.claimed_step_count,
      });
    }
    if (Number.isFinite(aggregate.claimed_run_count) && Number(aggregate.claimed_run_count) !== perSample.claimed_run_count) {
      dataMismatches.push({
        sample_index: sampleIndex,
        field: 'claimed_run_count',
        aggregate_value: Number(aggregate.claimed_run_count),
        recomputed_value: perSample.claimed_run_count,
      });
    }
    if (Number.isFinite(aggregate.active_cases) && Number(aggregate.active_cases) !== perSample.active_case_count) {
      dataMismatches.push({
        sample_index: sampleIndex,
        field: 'active_cases',
        aggregate_value: Number(aggregate.active_cases),
        recomputed_value: perSample.active_case_count,
      });
    }
    const aggregateErrors = Array.isArray(aggregate.observation_errors) ? aggregate.observation_errors : [];
    for (const message of aggregateErrors) {
      if (typeof message === 'string' && message.length > 0 && !evidenceErrors.includes(message)) {
        evidenceErrors.push(message);
      }
    }
    if (Array.isArray(aggregate.unknown_run_ids) && aggregate.unknown_run_ids.length > 0) {
      unknownRunSampleIndices.push(sampleIndex);
    }
    if (Array.isArray(aggregate.unknown_cases) && aggregate.unknown_cases.length > 0) {
      unknownCaseSampleIndices.push(sampleIndex);
    }
    if (typeof sample.error === 'string' && sample.error.length > 0) {
      sampleErrorRecords.push({ sample_index: sampleIndex, error: sample.error });
    }
    if (prepManifestSha256 !== null && isPlainRecord(sample.prep)
        && typeof sample.prep.manifest_sha256 === 'string'
        && sample.prep.manifest_sha256 !== prepManifestSha256) {
      prepBindingMismatches.push({
        sample_index: sampleIndex,
        sample_manifest_sha256: sample.prep.manifest_sha256,
        prepared_manifest_sha256: prepManifestSha256,
      });
    }
    // Per-case history from this sample's case records.
    const caseEntries = Array.isArray(sample.cases) ? sample.cases : [];
    for (const caseEntry of caseEntries) {
      if (!isPlainRecord(caseEntry) || typeof caseEntry.case_id !== 'string') continue;
      if (!caseHistory.has(caseEntry.case_id)) continue;
      const history = caseHistory.get(caseEntry.case_id);
      if (caseEntry.present_in_state === true) {
        history.present = true;
        if (caseEntry.phase === 'running') history.running = true;
        history.last = caseEntry;
        history.lastIndex = sampleIndex;
        history.lastAt = sample.sampled_at;
      } else if (history.last === null) {
        // Absent-from-state records count only when nothing better exists.
        history.last = caseEntry;
        history.lastIndex = sampleIndex;
        history.lastAt = sample.sampled_at;
      }
    }
  }
  // Detect non-monotonic sample order AFTER collecting real peakSampleIndex.
  {
    let previousIndex = -1;
    for (const sample of samples) {
      if (sample.sample_index < previousIndex) nonMonotonicIndices.push(sample.sample_index);
      previousIndex = sample.sample_index;
    }
  }

  if (samples.length > 0) {
    const first = samples[0];
    if (first.all_selected_cases_terminal === true) lateStartFlag = true;
  }

  // ── Per-case classification ──
  const perCase = {};
  let executedCases = 0;
  let notRunCases = 0;
  let terminalCases = 0;
  let runningAtLast = 0;
  let pendingAtLast = 0;
  let unobservedCases = 0;
  let absentCases = 0;
  for (const caseId of selected) {
    const history = caseHistory.get(caseId);
    const entry = history?.last ?? null;
    const record = {
      case_id: caseId,
      observed: history !== undefined && history.last !== null,
      present_in_campaign_state: history?.present === true,
      absent_from_campaign_state: false,
      executed: false,
      not_run: false,
      terminal: false,
      final_phase: null,
      final_outcome: null,
      attempts: 0,
      last_observed_sample_index: history?.lastIndex ?? null,
      last_observed_at: history?.lastAt ?? null,
      note: null,
    };
    if (entry !== null && history?.present === false) {
      record.absent_from_campaign_state = true;
      record.note = 'absent from the campaign state in every observation';
    }
    if (entry !== null && history?.present === true) {
      const outcome = entry.outcome ?? null;
      const attempts = Array.isArray(entry.attempts)
        ? entry.attempts.length
        : (Number.isFinite(entry.attempt_count) ? Number(entry.attempt_count) : 0);
      const phase = typeof entry.phase === 'string' ? entry.phase : null;
      record.final_phase = phase;
      record.final_outcome = outcome;
      record.attempts = attempts;
      record.terminal = phase === 'terminal' || entry.terminal === true;
      const notRun = outcome === 'NOT_RUN';
      record.not_run = notRun;
      record.executed = !notRun
        && (attempts > 0 || history.running === true || (record.terminal && outcome !== null && outcome !== 'NOT_RUN'));
      if (record.terminal && !notRun && attempts === 0 && outcome === null && history.running === false) {
        record.note = 'terminal without a recorded outcome or attempts in the last observation';
      }
    }
    if (record.terminal && record.not_run) notRunCases += 1;
    if (record.executed) executedCases += 1;
    if (record.terminal) terminalCases += 1;
    if (record.final_phase === 'running') runningAtLast += 1;
    if (record.final_phase === 'pending') pendingAtLast += 1;
    if (record.absent_from_campaign_state) absentCases += 1;
    if (!record.observed) unobservedCases += 1;
    perCase[caseId] = record;
  }

  // ── Coverage gaps ──
  const missedIntervals = [];
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const from = samples[index];
    const to = samples[index + 1];
    const fromMs = Date.parse(from.sampled_at);
    const toMs = Date.parse(to.sampled_at);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) continue;
    const gapMs = toMs - fromMs;
    const toleranceMs = Math.max(intervalMs * 1.5, intervalMs + 500);
    if (gapMs > toleranceMs) {
      missedIntervals.push({
        from_sample_index: from.sample_index,
        to_sample_index: to.sample_index,
        from_at: from.sampled_at,
        to_at: to.sampled_at,
        gap_ms: gapMs,
        expected_cadence_ms: intervalMs,
      });
    }
  }
  const observerObj = observer !== null && observer !== undefined && typeof observer === 'object' && !Array.isArray(observer)
    ? observer
    : null;
  const stopReason = observerObj !== null && typeof observerObj.stop_reason === 'string' ? observerObj.stop_reason : null;
  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const lastSampleAllTerminal = lastSample?.all_selected_cases_terminal === true;
  const trailingUnobserved = !lastSampleAllTerminal && (stopReason !== 'all-cases-terminal');
  const trailingReason = !lastSampleAllTerminal
    ? (stopReason !== null
      ? `observation ended (stop_reason ${stopReason}) before the selected cases were observed terminal`
      : 'the last sample was not all-terminal and no observer stop_reason is recorded')
    : null;

  const firstSampleAt = samples.length > 0 ? samples[0].sampled_at : null;
  const lastSampleAt = lastSample !== null ? lastSample.sampled_at : null;

  // ── Honesty ──
  const reasons = [];
  const observedPeakBelowThree = peakClaimedStep < 3;
  if (observedPeakBelowThree) {
    reasons.push(`observed claimed-step peak (${peakClaimedStep}) is below 3`);
  }
  if (samplesFileMissing) reasons.push('samples.jsonl is missing');
  if (samples.length === 0) reasons.push('zero valid sample records were read');
  if (corruptLines.length > 0) {
    reasons.push(`${corruptLines.length} sample line(s) are corrupt or unreadable`);
  }
  if (!anyActiveOverlap) reasons.push('the observation window did not overlap any active campaign work');
  if (lateStartFlag) reasons.push('the observer started after the campaign was already terminal (first sample all-terminal)');
  if (unknownRunSampleIndices.length > 0) {
    reasons.push(`UNKNOWN run observations recorded in ${unknownRunSampleIndices.length} sample(s)`);
  }
  if (unknownCaseSampleIndices.length > 0) {
    reasons.push(`UNKNOWN case observations recorded in ${unknownCaseSampleIndices.length} sample(s)`);
  }
  if (evidenceErrors.length > 0) reasons.push(`${evidenceErrors.length} unique observation error(s) recorded across samples`);
  if (sampleErrorRecords.length > 0) reasons.push(`${sampleErrorRecords.length} sample(s) recorded observer composition errors`);
  if (dataMismatches.length > 0) reasons.push(`${dataMismatches.length} sample(s) disagree between recorded aggregates and recomputed scoped counts`);
  if (decoyExclusions.length > 0) reasons.push(`${decoyExclusions.length} decoy/unrelated run id(s) were excluded from the observed counts`);
  if (prepBindingMismatches.length > 0) reasons.push(`${prepBindingMismatches.length} sample(s) do not bind to the prepared manifest (manifest_sha256 mismatch)`);
  if (observerReadIssue !== null) reasons.push('observer metadata (observer.json) is missing or unreadable');
  if (observerObj !== null && typeof observerObj.error === 'string' && observerObj.error.length > 0) {
    reasons.push('the observer recorded an error during observation');
  }
  if (configuredConcurrency === null) reasons.push('the configured case concurrency could not be read from the recorded controller argv/provenance');

  const evidenceInsufficient = reasons.length > 0;
  const stormClaimSupported = !observedPeakBelowThree && !evidenceInsufficient;

  const qualifiers = [];
  if (executedCases < selected.length) {
    qualifiers.push(`only ${executedCases} of ${selected.length} selected cases executed (${notRunCases} NOT_RUN, ${unobservedCases} unobserved)`);
  } else if (terminalCases < selected.length) {
    qualifiers.push(`${terminalCases} of ${selected.length} selected cases terminal at the last observation`);
  }
  const verdict = stormClaimSupported
    ? `OBSERVED CONTENTION SUPPORTED: claimed-step peak ${peakClaimedStep} (>= 3) with sufficient evidence${qualifiers.length > 0 ? ` (${qualifiers.join('; ')})` : ''}.`
    : `NO UNQUALIFIED PASSED-STORM CLAIM: ${reasons.join('; ')}`;

  const honesty = {
    observed_peak_below_three: observedPeakBelowThree,
    evidence_insufficient: evidenceInsufficient,
    reasons,
    storm_claim_supported: stormClaimSupported,
    qualifiers,
    verdict,
  };

  return {
    tool: 'tt-contention-slice',
    subcommand: 'summarize',
    story: 'STORM-I US-003',
    generated_at: generatedAt ?? utcTimestamp(),
    selected_case_ids: [...selected],
    configured: {
      concurrency: configuredConcurrency,
      stagger: configuredStagger,
      argv: configuredArgv,
      source: configuredSource,
    },
    observed: {
      samples_file_present: !samplesFileMissing,
      valid_sample_count: samples.length,
      corrupt_line_count: corruptLines.length,
      first_sample_at: firstSampleAt,
      last_sample_at: lastSampleAt,
      claimed_run_peak: peakClaimedRun,
      claimed_step_peak: peakClaimedStep,
      peak_sample_index: peakSampleIndex,
      overlapped_active_work: anyActiveOverlap,
      late_observer_start: lateStartFlag,
      last_sample_all_terminal: lastSampleAllTerminal,
    },
    per_case: perCase,
    counts: {
      selected_cases: selected.length,
      executed_cases: executedCases,
      not_run_cases: notRunCases,
      terminal_cases: terminalCases,
      running_at_last_observation: runningAtLast,
      pending_at_last_observation: pendingAtLast,
      absent_from_campaign_state_cases: absentCases,
      unobserved_cases: unobservedCases,
    },
    coverage: {
      interval_ms: intervalMs,
      missed_intervals: missedIntervals,
      late_observer_start: lateStartFlag,
      trailing_unobserved: trailingUnobserved,
      trailing_reason: trailingReason,
      observer_started_at: observerObj !== null && typeof observerObj.started_at === 'string' ? observerObj.started_at : null,
      observer_finished_at: observerObj !== null && typeof observerObj.finished_at === 'string' ? observerObj.finished_at : null,
      observer_stop_reason: stopReason,
    },
    evidence: {
      clean: evidenceErrors.length === 0
        && corruptLines.length === 0
        && samplesFileMissing === false
        && samples.length > 0
        && unknownRunSampleIndices.length === 0
        && unknownCaseSampleIndices.length === 0
        && sampleErrorRecords.length === 0
        && dataMismatches.length === 0
        && decoyExclusions.length === 0
        && prepBindingMismatches.length === 0
        && observerReadIssue === null
        && (observerObj === null || typeof observerObj.error !== 'string' || observerObj.error.length === 0),
      observation_errors: [...evidenceErrors],
      corrupt_lines: corruptLines,
      unknown_run_sample_indices: unknownRunSampleIndices,
      unknown_case_sample_indices: unknownCaseSampleIndices,
      sample_error_records: sampleErrorRecords,
      data_mismatches: dataMismatches,
      decoy_run_ids_excluded: decoyExclusions,
      prep_binding_mismatches: prepBindingMismatches,
      non_monotonic_sample_indices: nonMonotonicIndices,
      observer_metadata_present: observerReadIssue === null && observerObj !== null,
      observer_read_issue: observerReadIssue,
    },
    honesty,
  };
}

// Human-readable rendering of a summary object (written to summary.txt and
// printed to stdout by the summarize subcommand).
export function renderSummaryText(summary) {
  const line = '─'.repeat(64);
  const configured = summary.configured ?? {};
  const observed = summary.observed ?? {};
  const counts = summary.counts ?? {};
  const coverage = summary.coverage ?? {};
  const evidence = summary.evidence ?? {};
  const honesty = summary.honesty ?? {};
  const perCase = summary.per_case ?? {};
  const out = [];
  out.push('Contention-slice observation summary');
  out.push(line);
  out.push(`Selected cases (${counts.selected_cases ?? summary.selected_case_ids?.length ?? 0}): ${(summary.selected_case_ids ?? []).join(', ')}`);
  out.push('');
  out.push('Configured (recorded controller argv / provenance):');
  out.push(`  case concurrency: ${configured.concurrency ?? 'unknown'}`);
  out.push(`  stagger: ${configured.stagger ?? 'unknown'}`);
  if (Array.isArray(configured.argv) && configured.argv.length > 0) {
    out.push(`  controller argv: ${configured.argv.join(' ')}`);
  }
  out.push('');
  out.push('Observed (from persisted samples, scoped to the selected runs only):');
  out.push(`  valid samples: ${observed.valid_sample_count ?? 0}; corrupt lines: ${observed.corrupt_line_count ?? 0}`);
  out.push(`  window: ${observed.first_sample_at ?? '(no samples)'} → ${observed.last_sample_at ?? '(no samples)'}`);
  out.push(`  observed claimed-step peak: ${observed.claimed_step_peak ?? 0}${observed.peak_sample_index !== null && observed.peak_sample_index !== undefined ? ` (sample #${observed.peak_sample_index})` : ''}`);
  out.push(`  observed claimed-run peak: ${observed.claimed_run_peak ?? 0}`);
  out.push(`  overlapped active campaign work: ${observed.overlapped_active_work === true ? 'yes' : 'no'}`);
  out.push(`  late observer start (first sample already terminal): ${observed.late_observer_start === true ? 'yes' : 'no'}`);
  out.push('');
  out.push('Per-case (as of the last observation):');
  for (const caseId of summary.selected_case_ids ?? []) {
    const record = perCase[caseId];
    if (record === undefined) {
      out.push(`  ${caseId}: unobserved`);
      continue;
    }
    const parts = [];
    if (record.absent_from_campaign_state === true) parts.push('absent from campaign state');
    if (record.not_run === true) parts.push('NOT_RUN');
    else if (record.executed === true) parts.push('executed');
    else if (record.present_in_campaign_state === true) parts.push('not executed');
    else parts.push('unobserved');
    if (record.terminal === true) parts.push('terminal');
    else if (record.final_phase === 'running') parts.push('still running at last observation');
    else if (record.final_phase === 'pending') parts.push('pending at last observation');
    if (record.final_outcome !== null && record.final_outcome !== undefined) parts.push(`outcome=${record.final_outcome}`);
    if (record.attempts !== null && record.attempts !== undefined && record.attempts > 0) parts.push(`attempts=${record.attempts}`);
    if (record.note !== null) parts.push(`(${record.note})`);
    out.push(`  ${caseId}: ${parts.join(', ')}`);
  }
  out.push('');
  out.push('Counts:');
  out.push(`  executed: ${counts.executed_cases ?? 0} of ${counts.selected_cases ?? 0}; NOT_RUN: ${counts.not_run_cases ?? 0}; terminal at last observation: ${counts.terminal_cases ?? 0}`);
  out.push(`  running at last observation: ${counts.running_at_last_observation ?? 0}; pending: ${counts.pending_at_last_observation ?? 0}; unobserved: ${counts.unobserved_cases ?? 0}`);
  if ((counts.absent_from_campaign_state_cases ?? 0) > 0) {
    out.push(`  absent from the campaign state: ${counts.absent_from_campaign_state_cases}`);
  }
  out.push('');
  out.push('Coverage gaps:');
  out.push(`  cadence: ${coverage.interval_ms ?? DEFAULT_SAMPLE_INTERVAL_MS}ms; missed intervals: ${(coverage.missed_intervals ?? []).length}`);
  for (const missed of coverage.missed_intervals ?? []) {
    out.push(`    sample #${missed.from_sample_index} → #${missed.to_sample_index}: ${missed.gap_ms}ms gap (cadence ${missed.expected_cadence_ms}ms)`);
  }
  out.push(`  late observer start: ${coverage.late_observer_start === true ? 'yes' : 'no'}`);
  out.push(`  trailing unobserved window: ${coverage.trailing_unobserved === true ? 'yes' : 'no'}${coverage.trailing_reason !== null && coverage.trailing_reason !== undefined ? ` (${coverage.trailing_reason})` : ''}`);
  if (coverage.observer_stop_reason !== null && coverage.observer_stop_reason !== undefined) {
    out.push(`  observer stop reason: ${coverage.observer_stop_reason}`);
  }
  out.push('');
  out.push('Evidence:');
  out.push(`  clean: ${evidence.clean === true ? 'yes' : 'no'}`);
  if ((evidence.observation_errors ?? []).length > 0) {
    out.push('  observation errors:');
    for (const message of evidence.observation_errors) out.push(`    - ${message}`);
  }
  if ((evidence.corrupt_lines ?? []).length > 0) {
    out.push(`  corrupt/missing evidence (${evidence.corrupt_lines.length}):`);
    for (const corrupt of evidence.corrupt_lines) out.push(`    line ${corrupt.line}: ${corrupt.error}`);
  }
  if ((evidence.unknown_run_sample_indices ?? []).length > 0) {
    out.push(`  UNKNOWN run observations in samples: ${evidence.unknown_run_sample_indices.join(', ')}`);
  }
  if ((evidence.unknown_case_sample_indices ?? []).length > 0) {
    out.push(`  UNKNOWN case observations in samples: ${evidence.unknown_case_sample_indices.join(', ')}`);
  }
  if ((evidence.decoy_run_ids_excluded ?? []).length > 0) {
    out.push(`  decoy/unrelated runs excluded from counts: ${evidence.decoy_run_ids_excluded.length}`);
  }
  if ((evidence.data_mismatches ?? []).length > 0) {
    out.push(`  aggregate/recomputed count mismatches: ${evidence.data_mismatches.length}`);
  }
  if (evidence.observer_read_issue !== null && evidence.observer_read_issue !== undefined) {
    out.push(`  observer metadata: ${evidence.observer_read_issue}`);
  }
  out.push('');
  out.push(`Honesty verdict: ${honesty.verdict ?? 'unknown'}`);
  return `${out.join('\n')}\n`;
}

// ── Prepare-core (pure/parameterized; the CLI is a thin wrapper) ────
// The full `prepare` algorithm lives here so hermetic tests can exercise
// fixture catalog mirrors through PURE helper injection (a catalogRoot
// parameter) without any operator-accessible substitution option on the real
// CLI. The real CLI always calls runPrepare with the default catalogRoot
// (this checkout's CURRENT catalogs), so the real prepare path always means
// current canonical row bytes certified by this checkout's own git pin.

// git rev-parse HEAD + tracked-tree cleanliness for provenance. Read-only git
// invocations against the checkout; a dirty tracked tree is RECORDED (and
// never presented as a pinned clean candidate), not hidden. Failure to
// resolve a commit is a hard error — provenance cannot pin a source without
// one.
export function sourceGitInfo() {
  const run = (args) => spawnSync('git', args, {
    cwd: TT_DIR,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rev = run(['rev-parse', 'HEAD']);
  if (rev.error !== undefined || rev.status !== 0) {
    throw new Error(`cannot resolve source commit (git rev-parse HEAD failed): ${rev.error?.message ?? rev.stderr?.trim() ?? `exit ${rev.status}`}`);
  }
  const commit = String(rev.stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`source commit is not a full sha256 hex id: ${commit}`);
  }
  const status = run(['status', '--porcelain']);
  if (status.error !== undefined || status.status !== 0) {
    throw new Error(`cannot determine tracked-tree cleanliness (git status --porcelain failed): ${status.error?.message ?? status.stderr?.trim() ?? `exit ${status.status}`}`);
  }
  const porcelain = String(status.stdout ?? '').trimEnd();
  const clean = porcelain === '';
  return {
    commit,
    tracked_tree_clean: clean,
    tracked_tree_porcelain: porcelain,
    pinned_clean_candidate: clean,
  };
}

// Drift re-check for REQUIRED task sources: re-read each task file and compare
// its sha256 against the hash recorded at selection time. A task source that
// changed (or became unreadable) mid-preparation is drift. Returns the list
// of drifted entries ({ task, expected_sha256, actual_sha256, error }).
export function checkTaskDrift(taskHashes, { ttDir = TT_DIR } = {}) {
  const drifted = [];
  for (const taskHash of taskHashes) {
    if (taskHash === null || typeof taskHash !== 'object') continue;
    let actual = null;
    let error = null;
    try {
      const abs = resolveContainedUnder(taskHash.task, ttDir, `task path ${taskHash.task}`);
      actual = sha256(fs.readFileSync(abs));
    } catch (readError) {
      error = readError.message;
    }
    if (error !== null || actual !== taskHash.task_sha256) {
      drifted.push({
        task: taskHash.task,
        expected_sha256: taskHash.task_sha256,
        actual_sha256: actual,
        error,
      });
    }
  }
  return drifted;
}

// Decide the preparation's pin state from the two git snapshots and the
// content drift re-checks. Pure so tests can pin every branch:
//   - contentDrift: catalog or required-task bytes changed, the commit moved,
//     or the tracked tree worsened (clean -> dirty) mid-preparation. A
//     content-drifted result is REJECTED (artifacts retained).
//   - pinnedCleanCandidate: true only when the tree was clean BOTH before and
//     after AND no content drift. A preparation that began on a dirty tree is
//     never upgraded to pinned-clean just because the checkout became clean
//     later.
export function decideSourcePinState({ sourceBefore, sourceAfter, catalogDrift = [], taskDrift = [] }) {
  const commitMoved = sourceAfter.commit !== sourceBefore.commit;
  const treeWorsened = sourceBefore.tracked_tree_clean && !sourceAfter.tracked_tree_clean;
  const contentDrift = catalogDrift.length > 0 || taskDrift.length > 0 || commitMoved || treeWorsened;
  const cleanBefore = sourceBefore.tracked_tree_clean === true;
  const cleanAfter = sourceAfter.tracked_tree_clean === true;
  const pinnedCleanCandidate = cleanBefore && cleanAfter && !contentDrift;
  const driftEvidence = contentDrift
    ? {
        catalogs: catalogDrift,
        tasks: taskDrift,
        commit_before: sourceBefore.commit,
        commit_after: sourceAfter.commit,
        tree_clean_before: cleanBefore,
        tree_clean_after: cleanAfter,
      }
    : null;
  return {
    contentDrift,
    pinnedCleanCandidate,
    driftEvidence,
    unpinned_reason: pinnedCleanCandidate
      ? null
      : contentDrift
        ? 'source content drift detected during preparation'
        : 'tracked tree was not clean when preparation began',
  };
}

function shellQuoteArg(arg) {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(arg)) return arg;
  return `'${String(arg).replaceAll("'", "'\\''")}'`;
}

// The controller launch argv the operator is meant to run (pinned by the
// story; provenance records it and prepare prints it legibly).
export function controllerLaunchArgv(manifestPath) {
  return [
    CONTROLLER_PATH,
    '--manifest', manifestPath,
    '--concurrency', String(CONTROLLER_CONCURRENCY),
    '--stagger', CONTROLLER_STAGGER,
  ];
}

// Validate an explicit catalog-root mirror (test-only, pure): must resolve to
// a plain directory strictly inside this checkout's torture-test/ (realpath),
// with no traversal and no symlink-escaped prefix. The operator CLI never
// exposes this — the default is this checkout's CASES_ROOT (current catalogs).
function assertContainedCatalogRoot(catalogRoot, { ttDir = TT_DIR } = {}) {
  const candidate = path.resolve(process.cwd(), catalogRoot);
  assertNoTraversal(catalogRoot, 'catalog root');
  const ttReal = fs.realpathSync(ttDir);
  const real = resolveExistingRealPath(candidate);
  if (real === null || !pathIsWithin(ttReal, real)) {
    throw refusal(
      `refusing a catalog root outside this checkout's torture-test/: ${catalogRoot} (resolves to ${real ?? candidate})`,
      'TT_ESCAPE',
    );
  }
  const relative = path.relative(ttReal, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw refusal(
      `refusing a catalog root outside this checkout's torture-test/: ${catalogRoot} (resolves to ${candidate})`,
      'TT_ESCAPE',
    );
  }
  let current = ttReal;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let details;
    try {
      details = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw new Error(`cannot inspect catalog root component ${current}: ${error.message}`);
    }
    if (details.isSymbolicLink()) {
      throw refusal(`refusing a catalog root through an existing symlink: ${current}`, 'TT_SYMLINK');
    }
    const componentReal = fs.realpathSync(current);
    if (!pathIsWithin(ttReal, componentReal)) {
      throw refusal(
        `refusing a catalog root that escapes torture-test/ via ${current} (resolves to ${componentReal})`,
        'TT_ESCAPE',
      );
    }
  }
  const details = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`catalog root must name an existing directory: ${candidate}`);
  }
  return candidate;
}

// ── runPrepare: the complete prepare algorithm (US-001 core) ────────
// Reads the four canonical rows from CURRENT catalogs (or a contained fixture
// mirror passed purely by tests), writes a fresh unique preparation dir under
// torture-test/var, records provenance with every hash derived from the same
// byte snapshots used for selection, and hands the manifest to the real
// controller --validate-only. Source pinning happens BEFORE the first source
// read; catalogs AND required task bytes are re-checked after validation; a
// content-drifted or validation-failed result returns 1 with artifacts
// retained; a preparation that began on a dirty tree is never upgraded to
// pinned-clean. Returns the process exit code. Throws only for hard errors
// (missing/duplicate ids, refusals, unreadable sources) which leave nothing
// behind.
export function runPrepare({
  outArg = null,
  catalogRoot = TT_DIR,
  env = process.env,
  onStdout = (text) => process.stdout.write(text),
  onStderr = (text) => process.stderr.write(text),
} = {}) {
  const resolvedCatalogRoot = assertContainedCatalogRoot(catalogRoot);
  const selection = loadSelection(); // fixed four-case roster, always
  // 1. PIN the source FIRST — before any catalog/task byte is read, so a
  //    source change can never label old rows with a new clean commit.
  const sourceBefore = sourceGitInfo();
  // 2. Snapshot every catalog once; discover each id exactly once inside that
  //    snapshot; hash required task sources (missing/escaped/unreadable task
  //    sources throw here and leave NOTHING behind).
  const snapshots = snapshotCatalogFiles(selection, { catalogRoot: resolvedCatalogRoot });
  const rows = discoverSelectionRows(selection, snapshots, { catalogRoot: resolvedCatalogRoot });
  const tasks = rows.map((row) => requireTaskFileHash(row.record));
  // 3. Validate the var root itself (auto AND explicit modes) and resolve the
  //    destination; every check runs before any mkdir.
  ensureVarRoot();
  const explicitOut = outArg !== null ? resolveExplicitOutDir(outArg, { varRoot: VAR_ROOT }) : null;
  const outDir = explicitOut !== null ? explicitOut : allocFreshOutDir({ varRoot: VAR_ROOT, prefix: 'contention-slice-' });
  const createdHere = explicitOut === null;
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  try {
    if (explicitOut !== null) fs.mkdirSync(explicitOut, { mode: 0o700 });
    // Manifest rows are the SAME byte snapshots used for selection.
    const manifestBuffer = Buffer.concat(rows.map((row) => Buffer.concat([row.rowBytes, Buffer.from('\n')])));
    fs.writeFileSync(manifestPath, manifestBuffer, { mode: 0o600 });
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifestHash = sha256(manifestBytes);

    // Controller --validate-only hand-off (contained + read-only; never a
    // launch). Guard propagation preserved; the child gets isolated contained
    // HOME/state paths.
    const isolatedEnvDir = path.join(outDir, '.validate-env');
    fs.mkdirSync(isolatedEnvDir, { mode: 0o700 });
    const validationArgv = [CONTROLLER_PATH, '--manifest', manifestPath, '--validate-only'];
    const spawned = spawnSync(process.execPath, validationArgv, {
      cwd: TT_DIR,
      env: childSpawnEnv(env, { isolated: isolatedEnvDir }),
      encoding: 'utf8',
      shell: false,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    try {
      fs.rmSync(isolatedEnvDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover contained env dir under the output dir is
      // harmless and never blocks the outcome.
    }
    const validation = {
      executable: CONTROLLER_PATH,
      cwd: TT_DIR,
      argv: validationArgv,
      ok: spawned.error === undefined && spawned.status === 0,
      exit_code: spawned.error !== undefined ? null : spawned.status,
      error: spawned.error !== undefined ? spawned.error.message : null,
      stdout: String(spawned.stdout ?? '').slice(0, 4000),
      stderr: String(spawned.stderr ?? '').slice(0, 4000),
    };

    // 4. Post-validation drift re-check: re-hash the exact catalog byte
    //    snapshots AND the required task bytes used for selection, then
    //    re-read the source commit/tree state. Content drift is recorded and
    //    rejects the pinned result (artifacts retained); a dirty-at-start
    //    tree is never upgraded to pinned-clean.
    const catalogDrift = checkCatalogDrift(snapshots);
    const taskDrift = checkTaskDrift(tasks);
    const sourceAfter = sourceGitInfo();
    const pinState = decideSourcePinState({ sourceBefore, sourceAfter, catalogDrift, taskDrift });

    // Provenance (written once, after validation + drift checks, so it
    // reflects the outcome). All hashes derive from the selection snapshot.
    const catalogs = new Map();
    for (const row of rows) {
      if (!catalogs.has(row.catalog)) {
        const snapshot = [...snapshots.values()].find((s) => s.catalogAbs === row.catalogAbs);
        catalogs.set(row.catalog, {
          sha256: snapshot?.sha256 ?? sha256(fs.readFileSync(row.catalogAbs)),
          bytes: snapshot?.bytes.length ?? 0,
        });
      }
    }
    const rowMeta = rows.map((row, index) => ({
      id: row.id,
      catalog: row.catalog,
      line: row.line,
      sha256: sha256(row.rowBytes),
      bytes: row.rowBytes.length,
      task: tasks[index].task,
      task_sha256: tasks[index].task_sha256,
      task_bytes: tasks[index].task_bytes,
      task_error: tasks[index].task_error,
    }));
    const launchArgv = controllerLaunchArgv(manifestPath);
    const provenance = {
      tool: 'tt-contention-slice',
      subcommand: 'prepare',
      story: 'STORM-I US-001',
      generated_at: utcTimestamp(),
      selection: rows.map((row) => ({ id: row.id, catalog: row.catalog, line: row.line })),
      catalog_root: toPosix(path.relative(TT_DIR, resolvedCatalogRoot)) === ''
        ? 'torture-test/'
        : toPosix(path.relative(TT_DIR, resolvedCatalogRoot)),
      catalogs: Object.fromEntries(
        [...catalogs.entries()].map(([rel, hash]) => [
          rel,
          { tt_relative_path: rel, sha256: hash.sha256, bytes: hash.bytes },
        ]),
      ),
      rows: rowMeta,
      manifest: {
        file: MANIFEST_NAME,
        path: manifestPath,
        tt_relative_path: toPosix(path.relative(TT_DIR, manifestPath)),
        sha256: manifestHash,
        bytes: manifestBytes.length,
        rows: rows.length,
      },
      source: {
        commit: sourceAfter.commit,
        tracked_tree_clean: sourceAfter.tracked_tree_clean,
        tracked_tree_porcelain: sourceAfter.tracked_tree_porcelain,
        pinned_clean_candidate: pinState.pinnedCleanCandidate,
        unpinned_reason: pinState.unpinned_reason,
      },
      source_drift: pinState.driftEvidence,
      controller: {
        executable: CONTROLLER_PATH,
        cwd: TT_DIR,
        concurrency: CONTROLLER_CONCURRENCY,
        stagger: CONTROLLER_STAGGER,
        argv: launchArgv,
        command: launchArgv.map(shellQuoteArg).join(' '),
      },
      validation,
    };
    fs.writeFileSync(path.join(outDir, PROVENANCE_NAME), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });

    if (!validation.ok) {
      onStderr(`tt-contention-slice: manifest validation FAILED (exit ${validation.exit_code}); failure artifacts retained in ${outDir}\n`);
      if (validation.stderr.trim() !== '') onStderr(`${validation.stderr.trim()}\n`);
      return 1;
    }
    if (pinState.contentDrift) {
      onStderr('tt-contention-slice: SOURCE DRIFT DETECTED during preparation (catalog or task bytes, or the source commit/tree changed mid-run); the result is NOT a pinned clean candidate. Failure artifacts retained in '
        + `${outDir}\n`);
      return 1;
    }

    const line = '─'.repeat(60);
    const pinNote = pinState.pinnedCleanCandidate
      ? ', tracked tree clean'
      : `, ${pinState.unpinned_reason ?? 'tracked tree not clean'} — NOT a pinned clean candidate`;
    onStdout('Contention-slice manifest prepared.\n');
    onStdout(`Source: ${rows.length} case row(s) copied byte-identical from ${provenance.catalog_root} (commit ${sourceAfter.commit.slice(0, 12)}${pinNote}).\n`);
    onStdout(`Prepared manifest: ${manifestPath}\n`);
    onStdout(`Provenance: ${path.join(outDir, PROVENANCE_NAME)}\n`);
    onStdout('\nController launch argv (recorded in provenance; NOT executed by this tool):\n');
    onStdout(`${line}\n`);
    onStdout(`  cd ${shellQuoteArg(TT_DIR)}\n`);
    onStdout(`  ${provenance.controller.command}\n`);
    onStdout(`${line}\n`);
    return 0;
  } catch (error) {
    // Unexpected failure AFTER directory creation: remove only the fresh
    // auto-generated directory this invocation created (never a previous
    // result, never an explicit --out), then rethrow. Validation failures and
    // drift rejections are handled above and RETAIN artifacts.
    if (createdHere) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the original error is what matters.
      }
    }
    throw error;
  }
}
