// O7 — evidence sidecar schema + loader (torture-test only; STORM-O7).
//
// O7 is a POST-BATCH oracle: it is not one of the nine campaign-gating hooks
// (O1/O2/O3z/O4/O8/O9/O10/O11/O16) and it does not grow the version-1
// mechanical-evidence key set. Instead it consumes a SEPARATE, explicitly
// versioned, HOST-OWNED post-batch sidecar (schema_version 1) that points at
// immutable captured evidence beneath one owned directory:
//
//   - the read-only TT database snapshot (never opened through getDb/migrate),
//   - byte-exact copies of the native events streams (global train segments,
//     per-run streams, the empty-runId events/.jsonl stream, the .generation
//     companion, and — for the rotation-loss gate — the debug-on/off emitter
//     probe streams),
//   - host-owned receipts/volume-plan artifacts (gate only) that record what
//     the host ACTUALLY did through real lifecycle APIs, written independently
//     of the streams under test.
//
// Every member is validated before any check runs: regular non-symlink file,
// realpath identity beneath the sidecar directory, exact SHA-256 and byte
// size match. Any substitution/escape/symlink/tamper makes O7 report ERROR —
// a rejected path is never followed, even for an error report.
//
// Optional top-level `per_run_capture` (object keyed by run id, '' allowed)
// lets a host DECLARE a bounded/partial per-run capture:
//   "<runId>": { kind: "partial", declared_prefix_lines: N }
// O7 then verifies the captured per-run prefix against the run's global-train
// slice prefix, records the declared bound as coverage, and evaluates
// run-scoped obligations on the full global slice — a partial capture is
// never silently treated as a full one.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const O7_SIDECAR_SCHEMA_VERSION = 1;

// Nominal native constants (src/installer/events.ts) — pinned here so O7's
// literal spec comparison can never silently drift from the product.
export const NATIVE_MAX_EVENTS_FILE_SIZE = 20 * 1024 * 1024;
export const NATIVE_MAX_ROTATED_EVENTS_FILES = 3;

export const MEMBER_ROLES = Object.freeze([
  'db-snapshot',
  'global-live',
  'global-archive:1',
  'global-archive:2',
  'global-archive:3',
  'per-run',
  'empty-run',
  'generation',
  'receipts',
  'volume-plan',
  'probe-debug-off',
  'probe-debug-on',
  'extra-jsonl',
]);

export class O7EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'O7EvidenceError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new O7EvidenceError(`${label} must be a nonempty string`);
  return value;
}

function portableRelative(value, label) {
  requireString(value, label);
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new O7EvidenceError(`${label} must be a portable relative path`);
  }
  return value;
}

function normalizeDebugEnv(value) {
  if (value === null || value === undefined) return { raw: null, enabled: null };
  const raw = String(value);
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === '0' || trimmed === 'false') return { raw, enabled: false };
  return { raw, enabled: true };
}

function validateRole(role, pathParts) {
  if (role === 'per-run') {
    // events/<runId>.jsonl
    const ok = pathParts.length === 2 && pathParts[0] === 'events'
      && pathParts[1].endsWith('.jsonl') && pathParts[1].length > '.jsonl'.length;
    if (!ok) throw new O7EvidenceError(`per-run member path must be events/<runId>.jsonl, got ${pathParts.join('/')}`);
    return { runId: pathParts[1].slice(0, -'.jsonl'.length) };
  }
  if (role === 'empty-run') {
    if (pathParts.length !== 2 || pathParts[0] !== 'events' || pathParts[1] !== '.jsonl') {
      throw new O7EvidenceError('empty-run member path must be events/.jsonl');
    }
    return {};
  }
  if (role === 'global-live') {
    if (pathParts.length !== 2 || pathParts[0] !== 'events' || pathParts[1] !== 'all.jsonl') {
      throw new O7EvidenceError('global-live member path must be events/all.jsonl');
    }
    return {};
  }
  if (role.startsWith('global-archive:')) {
    const index = Number(role.slice('global-archive:'.length));
    if (!Number.isInteger(index) || index < 1 || index > 3) throw new O7EvidenceError(`archive index out of range: ${role}`);
    if (pathParts.length !== 2 || pathParts[0] !== 'events' || pathParts[1] !== `all.jsonl.${index}`) {
      throw new O7EvidenceError(`global-archive:${index} member path must be events/all.jsonl.${index}`);
    }
    return { archiveIndex: index };
  }
  if (role === 'generation') {
    if (pathParts.length !== 2 || pathParts[0] !== 'events' || pathParts[1] !== 'all.jsonl.generation') {
      throw new O7EvidenceError('generation member path must be events/all.jsonl.generation');
    }
    return {};
  }
  if (role === 'db-snapshot') {
    return {};
  }
  if (role === 'receipts' || role === 'volume-plan' || role === 'probe-debug-off' || role === 'probe-debug-on' || role === 'extra-jsonl') {
    return {};
  }
  throw new O7EvidenceError(`unknown member role ${role}`);
}

function validateSidecarShape(raw) {
  if (!isObject(raw)) throw new O7EvidenceError('sidecar must be a JSON object');
  if (raw.schema_version !== O7_SIDECAR_SCHEMA_VERSION) {
    throw new O7EvidenceError(`unsupported sidecar schema_version ${raw.schema_version}; expected ${O7_SIDECAR_SCHEMA_VERSION}`);
  }
  if (raw.oracle_id !== 'O7') throw new O7EvidenceError('sidecar oracle_id must be O7');
  if (!isObject(raw.capture)) throw new O7EvidenceError('sidecar capture must be an object');
  const capture = raw.capture;
  if (capture.kind !== 'batch' && capture.kind !== 'rotation-gate') {
    throw new O7EvidenceError(`capture.kind must be batch or rotation-gate, got ${capture.kind}`);
  }
  if (!isIsoUtc(requireString(capture.captured_at, 'capture.captured_at'))) throw new O7EvidenceError('capture.captured_at must be UTC ISO-8601');
  if (!isIsoUtc(requireString(capture.events_captured_at, 'capture.events_captured_at'))) throw new O7EvidenceError('capture.events_captured_at must be UTC ISO-8601');
  if (!isIsoUtc(requireString(capture.db_captured_at, 'capture.db_captured_at'))) throw new O7EvidenceError('capture.db_captured_at must be UTC ISO-8601');
  requireString(capture.producer, 'capture.producer');
  requireString(capture.state_dir_identity, 'capture.state_dir_identity');
  if (capture.generation_at_capture !== null && capture.generation_at_capture !== undefined
      && (!Number.isSafeInteger(capture.generation_at_capture) || capture.generation_at_capture < 0)) {
    throw new O7EvidenceError('capture.generation_at_capture must be a non-negative integer or null');
  }
  if (capture.debug_events_env !== null && capture.debug_events_env !== undefined && typeof capture.debug_events_env !== 'string') {
    throw new O7EvidenceError('capture.debug_events_env must be a string or null');
  }
  if (!isObject(capture.launch_intent)) throw new O7EvidenceError('capture.launch_intent must be an object');
  if (!isObject(raw.product)) throw new O7EvidenceError('product must be an object');
  if (typeof raw.product.source_commit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.product.source_commit)) {
    throw new O7EvidenceError('product.source_commit must be a 40-hex git commit');
  }
  if (typeof raw.product.source_tree !== 'string' || !/^[0-9a-f]{40}$/.test(raw.product.source_tree)) {
    throw new O7EvidenceError('product.source_tree must be a 40-hex git tree');
  }
  if (raw.product.dist_events_sha256 !== null && raw.product.dist_events_sha256 !== undefined
      && (typeof raw.product.dist_events_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.product.dist_events_sha256))) {
    throw new O7EvidenceError('product.dist_events_sha256 must be 64-hex or null');
  }
  if (!Array.isArray(raw.scope_runs) || raw.scope_runs.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new O7EvidenceError('scope_runs must be an array of nonempty strings');
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new O7EvidenceError('members must be a nonempty array');
  }
  const seenPaths = new Set();
  const seenRoles = new Map();
  for (const member of raw.members) {
    if (!isObject(member)) throw new O7EvidenceError('member must be an object');
    const role = requireString(member.role, 'member.role');
    const memberPath = portableRelative(member.path, 'member.path');
    if (typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.sha256)) {
      throw new O7EvidenceError(`member ${memberPath} sha256 must be 64-hex`);
    }
    if (!Number.isSafeInteger(member.size) || member.size < 0) {
      throw new O7EvidenceError(`member ${memberPath} size must be a non-negative integer`);
    }
    if (seenPaths.has(memberPath)) throw new O7EvidenceError(`duplicate member path ${memberPath}`);
    seenPaths.add(memberPath);
    const roleMeta = validateRole(role, memberPath.split('/'));
    if (seenRoles.has(role) && role !== 'per-run' && role !== 'extra-jsonl') {
      throw new O7EvidenceError(`duplicate member role ${role}`);
    }
    if (role === 'per-run') {
      const runId = roleMeta.runId;
      const list = seenRoles.get('per-run') ?? new Map();
      if (list.has(runId)) throw new O7EvidenceError(`duplicate per-run member for ${runId}`);
      list.set(runId, member);
      seenRoles.set('per-run', list);
    } else {
      seenRoles.set(role, member);
    }
  }
  if (raw.deleted_runs !== undefined && !Array.isArray(raw.deleted_runs)) throw new O7EvidenceError('deleted_runs must be an array');
  if (raw.manual_ledger !== undefined && !Array.isArray(raw.manual_ledger)) throw new O7EvidenceError('manual_ledger must be an array');
  if (raw.expected_train !== undefined && raw.expected_train !== null && !isObject(raw.expected_train)) {
    throw new O7EvidenceError('expected_train must be an object or null');
  }
  // Optional per-run capture coverage declarations. A host that captured a
  // BOUNDED/PARTIAL per-run stream (e.g. a deliberate prefix) MUST declare it
  // here; an undeclared partial capture is a full-capture mismatch, never a
  // silent PASS. Omitted runs default to FULL capture.
  if (raw.per_run_capture !== undefined) {
    if (!isObject(raw.per_run_capture)) throw new O7EvidenceError('per_run_capture must be an object keyed by run id');
    for (const [runKey, declaration] of Object.entries(raw.per_run_capture)) {
      if (typeof runKey !== 'string') throw new O7EvidenceError('per_run_capture keys must be run id strings');
      if (!isObject(declaration) || declaration.kind !== 'partial'
          || !Number.isSafeInteger(declaration.declared_prefix_lines) || declaration.declared_prefix_lines <= 0) {
        throw new O7EvidenceError(`per_run_capture[${runKey}] must be {kind:'partial', declared_prefix_lines:<positive int>}`);
      }
    }
  }
  return raw;
}

function verifyMemberFile(sidecarDir, member) {
  const absolute = path.resolve(sidecarDir, member.path);
  const resolvedDir = fs.realpathSync(sidecarDir);
  const relative = path.relative(resolvedDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new O7EvidenceError(`member ${member.path} escapes the sidecar directory`);
  }
  let details;
  let real;
  try {
    details = fs.lstatSync(absolute);
    real = fs.realpathSync(absolute);
  } catch (error) {
    throw new O7EvidenceError(`member ${member.path} is missing or inaccessible`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new O7EvidenceError(`member ${member.path} must be a regular non-symlink file`);
  }
  if (real !== absolute) {
    // A symlinked intermediate directory would make realpath differ from the
    // resolved literal path — the member could point outside the owned root.
    throw new O7EvidenceError(`member ${member.path} resolves through a symlink (realpath ${real})`);
  }
  const roleOutsideEvents = !relative.startsWith('events');
  if (roleOutsideEvents && member.role !== 'db-snapshot' && member.role !== 'receipts'
      && member.role !== 'volume-plan' && member.role !== 'probe-debug-off' && member.role !== 'probe-debug-on') {
    throw new O7EvidenceError(`member ${member.path} sits outside the events tree`);
  }
  if (!roleOutsideEvents && (member.role === 'db-snapshot' || member.role === 'receipts' || member.role === 'volume-plan')) {
    throw new O7EvidenceError(`member ${member.path} must not sit inside the events tree for role ${member.role}`);
  }
  if (details.size !== member.size) {
    throw new O7EvidenceError(`member ${member.path} size mismatch: sidecar ${member.size}, file ${details.size}`);
  }
  const bytes = fs.readFileSync(absolute);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== member.sha256) {
    throw new O7EvidenceError(`member ${member.path} SHA-256 mismatch (evidence tampered or corrupt)`);
  }
  return { absolute, bytes, stat: details };
}

/**
 * Load and validate an O7 sidecar.
 *
 * @param {string} sidecarPath absolute path of the sidecar JSON file
 * @returns frozen object:
 *   { sidecarPath, sidecarDir, raw, members: Map<role, memberInfo>, perRun: Map<runId, memberInfo>,
 *     dbMember, generationMember, debugIntent: {raw, enabled}, captureKind }
 *
 * Throws O7EvidenceError on any validation failure (caller maps it to ERROR).
 */
export function loadO7Sidecar(sidecarPath) {
  const absolute = path.resolve(sidecarPath);
  let sidecarDetails;
  try {
    sidecarDetails = fs.lstatSync(absolute);
  } catch {
    throw new O7EvidenceError(`sidecar ${sidecarPath} is missing or inaccessible`);
  }
  if (sidecarDetails.isSymbolicLink() || !sidecarDetails.isFile()) {
    throw new O7EvidenceError('sidecar must be a regular non-symlink file');
  }
  const sidecarDir = path.dirname(absolute);
  const dirDetails = fs.lstatSync(sidecarDir);
  if (!dirDetails.isDirectory() || dirDetails.isSymbolicLink()) {
    throw new O7EvidenceError('sidecar directory must be a non-symlink directory');
  }
  const dirReal = fs.realpathSync(sidecarDir);
  if (dirReal !== sidecarDir) throw new O7EvidenceError('sidecar directory must not be reached through symlinks');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new O7EvidenceError(`malformed sidecar JSON: ${error.message}`);
  }
  validateSidecarShape(raw);

  const members = new Map();
  const perRun = new Map();
  for (const member of raw.members) {
    const info = verifyMemberFile(sidecarDir, member);
    const meta = { ...member, absolute: info.absolute, bytes: info.bytes, stat: info.stat };
    if (member.role === 'per-run') {
      perRun.set(meta.path.split('/').at(-1).slice(0, -'.jsonl'.length), meta);
    } else {
      members.set(member.role, meta);
    }
  }
  const dbMember = members.get('db-snapshot');
  const generationMember = members.get('generation');
  const debugEnv = normalizeDebugEnv(raw.capture?.debug_events_env ?? null);
  const launchDebug = normalizeDebugEnv(raw.capture?.launch_intent?.debug_events ?? null);

  const requiredRoles = ['db-snapshot'];
  const missingRequired = requiredRoles.filter((role) => !members.has(role));
  if (missingRequired.length > 0) {
    throw new O7EvidenceError(`required member role missing: ${missingRequired.join(', ')}`);
  }
  if (raw.capture?.kind === 'rotation-gate') {
    for (const role of ['receipts', 'volume-plan']) {
      if (!members.has(role)) throw new O7EvidenceError(`rotation-gate capture requires member role ${role}`);
    }
  }
  return Object.freeze({
    sidecarPath: absolute,
    sidecarDir,
    raw,
    members,
    perRun,
    dbMember,
    generationMember,
    debugIntent: debugEnv.enabled === null ? launchDebug : debugEnv,
    launchDebug,
    captureKind: raw.capture.kind,
  });
}
