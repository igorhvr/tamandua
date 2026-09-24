#!/usr/bin/env node
// hygiene-sidecar.mjs — post-batch hygiene sidecar v1 loader/validator
// (O5 process/port + O6 worktree bookkeeping).
//
// The version-1 oracle context (contract_version 1, see CONTRACT.md) is a
// PER-CASE shape: its mechanical_evidence.references carry the fixed gating
// evidence-key set, which has no slot for host process inventories, listener
// censuses, managed-worktree disk/git metadata, or a run_worktrees snapshot
// beyond the per-case database copy. The post-batch oracles (O5, O6) run
// CAMPAIGN-WIDE at W6, so this module defines the NARROW, EXPLICITLY VERSIONED
// companion input they consume instead of silently broadening the v1 context:
// the **post-batch hygiene sidecar** (schema_version 1, sidecar_kind
// 'post-batch-hygiene'). v1 context and its global evidence-key set are left
// byte-identical; the sidecar is a sibling contract owned by torture-test
// (full statement in torture-test/oracles/POST-BATCH-CONTRACT.md).
//
// The sidecar is the capture contract's OUTPUT and the checker's INPUT:
//   * every structured row the evaluator needs is INLINE (admissions,
//     observation rows, per-inventory exact counts and capped flags);
//   * every raw captured artifact (lsof output, git worktree list, read-only
//     DB snapshot, ...) is referenced from evidence_files with a portable
//     relative path + sha256 so the checker can integrity-verify its inputs
//     and cite them as response evidence (read-only; never created here);
//   * the independent census denominator (admitted campaign scope, exact
//     counts, tool exit codes, sampler spans) travels WITH the rows, so a
//     checker can tell "nothing observed because nothing was there" from
//     "nothing observed because the tool failed / the span is missing" — the
//     O5 spec rule that absent tools / EPERM / missing sampler spans /
//     malformed inventories are never proof of process death or port release.
//
// No credentials, no agent prose, no live state is ever read here. The loader
// is read-only: it parses the sidecar file, validates the schema, verifies
// referenced evidence-file hashes when requested, and returns a frozen
// invocation. Referenced files must be contained beneath the sidecar's own
// directory (portable relative paths, regular non-symlink files).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OracleRuntimeError, pathIsWithin, portableRelativePath } from './paths.mjs';

export const HYGIENE_SIDECAR_SCHEMA_VERSION = 1;
export const HYGIENE_SIDECAR_KIND = 'post-batch-hygiene';
export const SUPPORTED_ORACLE_IDS = Object.freeze(['O5', 'O6']);
export const SCOPE_LAYERS = Object.freeze(['systemd-user-scope', 'none', 'unavailable']);
export const ADMISSION_KINDS = Object.freeze(['run-worker', 'daemon', 'listener', 'toolchain']);
export const EXPECTED_DISPOSITIONS = Object.freeze(['gone', 'alive_current']);
export const LAYER_NAMES = Object.freeze(['scope', 'pgid-ancestry', 'path-fd', 'start-window']);
export const COVERAGE_VALUES = Object.freeze(['available', 'partial', 'unavailable', 'not_applicable']);
export const WORKTREE_STATUSES = Object.freeze(['creating', 'ready', 'removing', 'removed', 'error', 'cleanup_failed']);
export const CLEANUP_POLICIES = Object.freeze(['keep', 'remove_on_success', 'remove_on_terminal']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUtcTimestamp(value) {
  return typeof value === 'string' && value.endsWith('Z')
    && !Number.isNaN(new Date(value).valueOf())
    && new Date(value).toISOString() === value;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPortableRelative(value) {
  if (!isNonemptyString(value) || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isAbsPath(value) {
  return isNonemptyString(value) && path.isAbsolute(value);
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// ── helpers shared by every hygiene checker ─────────────────────────────

export function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OracleRuntimeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function nonemptyString(value, label) {
  if (!isNonemptyString(value)) throw new OracleRuntimeError(`${label} must be a nonempty string`);
  return value;
}

export function objectValue(value, label) {
  if (!isObject(value)) throw new OracleRuntimeError(`${label} must be a JSON object`);
  return value;
}

export function arrayValue(value, label) {
  if (!Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an array`);
  return value;
}

export function utcTimestamp(value, label) {
  if (!isUtcTimestamp(value)) throw new OracleRuntimeError(`${label} must be a UTC ISO-8601 timestamp`);
  return value;
}

export function canonicalRunId(value, label = 'run ID') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OracleRuntimeError(`${label} must be nonempty`);
  }
  return value.startsWith('run-') ? value : `run-${value}`;
}

// ── row-shape validators (observation inventories) ──────────────────────

function validateInventory(inventory, label, validateRow) {
  objectValue(inventory, label);
  arrayValue(inventory.rows, `${label}.rows`);
  inventory.rows.forEach((row, index) => validateRow(row, `${label}.rows[${index}]`));
  nonnegativeInteger(inventory.exact_count, `${label}.exact_count`);
  if (inventory.exact_count < inventory.rows.length) {
    throw new OracleRuntimeError(`${label}.exact_count (${inventory.exact_count}) must be >= the number of inline rows (${inventory.rows.length})`);
  }
  if (typeof inventory.capped !== 'boolean') throw new OracleRuntimeError(`${label}.capped must be a boolean`);
  if (inventory.capped === false && inventory.exact_count !== inventory.rows.length) {
    throw new OracleRuntimeError(`${label} is not capped, so exact_count must equal the inline row count`);
  }
  objectValue(inventory.tool, `${label}.tool`);
  nonemptyString(inventory.tool.name, `${label}.tool.name`);
  if (!Number.isInteger(inventory.tool.exit_code)) {
    throw new OracleRuntimeError(`${label}.tool.exit_code must be an integer`);
  }
  if (!Array.isArray(inventory.spans)) throw new OracleRuntimeError(`${label}.spans must be an array`);
  inventory.spans.forEach((span, index) => {
    objectValue(span, `${label}.spans[${index}]`);
    utcTimestamp(span.start, `${label}.spans[${index}].start`);
    utcTimestamp(span.end, `${label}.spans[${index}].end`);
    if (span.end < span.start) throw new OracleRuntimeError(`${label}.spans[${index}].end must not precede start`);
  });
  return inventory;
}

function validateProcessRow(row, label) {
  objectValue(row, label);
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw new OracleRuntimeError(`${label}.pid must be a positive integer`);
  if (row.pgid !== null && (!Number.isSafeInteger(row.pgid) || row.pgid <= 0)) throw new OracleRuntimeError(`${label}.pgid must be null or a positive integer`);
  if (row.ppid !== null && (!Number.isSafeInteger(row.ppid) || row.ppid <= 0)) throw new OracleRuntimeError(`${label}.ppid must be null or a positive integer`);
  if (row.state !== null && (typeof row.state !== 'string' || row.state.length === 0)) throw new OracleRuntimeError(`${label}.state must be null or nonempty`);
  for (const key of ['start_identity', 'cgroup', 'cwd', 'cmdline']) {
    if (row[key] !== null && typeof row[key] !== 'string') throw new OracleRuntimeError(`${label}.${key} must be null or a string`);
  }
  utcTimestamp(row.ts, `${label}.ts`);
  return row;
}

function validateScopeMemberRow(row, label) {
  objectValue(row, label);
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw new OracleRuntimeError(`${label}.pid must be a positive integer`);
  if (row.pgid !== null && (!Number.isSafeInteger(row.pgid) || row.pgid <= 0)) throw new OracleRuntimeError(`${label}.pgid must be null or a positive integer`);
  if (row.start_identity !== null && typeof row.start_identity !== 'string') throw new OracleRuntimeError(`${label}.start_identity must be null or a string`);
  nonemptyString(row.cgroup, `${label}.cgroup`);
  utcTimestamp(row.ts, `${label}.ts`);
  return row;
}

function validateListenerRow(row, label) {
  objectValue(row, label);
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw new OracleRuntimeError(`${label}.pid must be a positive integer`);
  if (row.pgid !== null && (!Number.isSafeInteger(row.pgid) || row.pgid <= 0)) throw new OracleRuntimeError(`${label}.pgid must be null or a positive integer`);
  if (row.start_identity !== null && typeof row.start_identity !== 'string') throw new OracleRuntimeError(`${label}.start_identity must be null or a string`);
  nonemptyString(row.protocol, `${label}.protocol`);
  nonemptyString(row.local_address, `${label}.local_address`);
  if (!Number.isSafeInteger(row.local_port) || row.local_port <= 0) throw new OracleRuntimeError(`${label}.local_port must be a positive integer`);
  utcTimestamp(row.ts, `${label}.ts`);
  return row;
}

function validateToolchainRow(row, label) {
  objectValue(row, label);
  nonemptyString(row.toolchain, `${label}.toolchain`);
  if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw new OracleRuntimeError(`${label}.pid must be a positive integer`);
  if (row.start_identity !== null && typeof row.start_identity !== 'string') throw new OracleRuntimeError(`${label}.start_identity must be null or a string`);
  if (row.state !== null && typeof row.state !== 'string') throw new OracleRuntimeError(`${label}.state must be null or a string`);
  utcTimestamp(row.ts, `${label}.ts`);
  return row;
}

// ── sidecar schema (v1) ─────────────────────────────────────────────────

function validateCommon(sidecar) {
  if (sidecar.schema_version !== HYGIENE_SIDECAR_SCHEMA_VERSION) {
    throw new OracleRuntimeError(`sidecar schema_version must be ${HYGIENE_SIDECAR_SCHEMA_VERSION}`);
  }
  if (sidecar.sidecar_kind !== HYGIENE_SIDECAR_KIND) {
    throw new OracleRuntimeError(`sidecar_kind must be ${HYGIENE_SIDECAR_KIND}`);
  }
  if (!SUPPORTED_ORACLE_IDS.includes(sidecar.oracle_id)) {
    throw new OracleRuntimeError(`sidecar oracle_id must be one of ${SUPPORTED_ORACLE_IDS.join(', ')}`);
  }
  utcTimestamp(sidecar.produced_at, 'sidecar.produced_at');
  objectValue(sidecar.producer, 'sidecar.producer');
  nonemptyString(sidecar.producer.name, 'sidecar.producer.name');
  nonemptyString(sidecar.producer.version, 'sidecar.producer.version');
  objectValue(sidecar.campaign, 'sidecar.campaign');
  nonemptyString(sidecar.campaign.id, 'sidecar.campaign.id');
  arrayValue(sidecar.campaign.run_ids, 'sidecar.campaign.run_ids');
  const runIdSet = new Set();
  sidecar.campaign.run_ids.forEach((runId, index) => {
    const canonical = canonicalRunId(runId, `sidecar.campaign.run_ids[${index}]`);
    if (runIdSet.has(canonical)) throw new OracleRuntimeError(`sidecar.campaign.run_ids[${index}] duplicates ${canonical}`);
    runIdSet.add(canonical);
  });
  objectValue(sidecar.campaign.window, 'sidecar.campaign.window');
  utcTimestamp(sidecar.campaign.window.start_utc, 'sidecar.campaign.window.start_utc');
  utcTimestamp(sidecar.campaign.window.end_utc, 'sidecar.campaign.window.end_utc');
  if (sidecar.campaign.window.end_utc < sidecar.campaign.window.start_utc) {
    throw new OracleRuntimeError('sidecar.campaign.window.end_utc must not precede start_utc');
  }
  objectValue(sidecar.campaign.host, 'sidecar.campaign.host');
  nonemptyString(sidecar.campaign.host.platform, 'sidecar.campaign.host.platform');
  if (!SCOPE_LAYERS.includes(sidecar.campaign.host.scope_layer)) {
    throw new OracleRuntimeError(`sidecar.campaign.host.scope_layer must be one of ${SCOPE_LAYERS.join(', ')}`);
  }
  if (sidecar.campaign.host.scope_pattern !== null && typeof sidecar.campaign.host.scope_pattern !== 'string') {
    throw new OracleRuntimeError('sidecar.campaign.host.scope_pattern must be null or a string');
  }
  arrayValue(sidecar.evidence_files, 'sidecar.evidence_files');
  for (const [index, file] of sidecar.evidence_files.entries()) {
    objectValue(file, `sidecar.evidence_files[${index}]`);
    if (!isPortableRelative(file.path)) throw new OracleRuntimeError(`sidecar.evidence_files[${index}].path must be a portable relative path`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new OracleRuntimeError(`sidecar.evidence_files[${index}].sha256 must be lowercase sha256`);
    nonemptyString(file.kind, `sidecar.evidence_files[${index}].kind`);
    if (file.captured_at !== null && !isUtcTimestamp(file.captured_at)) {
      throw new OracleRuntimeError(`sidecar.evidence_files[${index}].captured_at must be null or UTC`);
    }
    if (file.tool !== null && typeof file.tool !== 'string') {
      throw new OracleRuntimeError(`sidecar.evidence_files[${index}].tool must be null or a string`);
    }
    if (file.exit_code !== null && !Number.isInteger(file.exit_code)) {
      throw new OracleRuntimeError(`sidecar.evidence_files[${index}].exit_code must be null or an integer`);
    }
  }
  arrayValue(sidecar.diagnostics, 'sidecar.diagnostics');
  sidecar.diagnostics.forEach((line, index) => nonemptyString(line, `sidecar.diagnostics[${index}]`));
}

function validateCoverage(coverage) {
  objectValue(coverage, 'sidecar.o5.coverage');
  for (const layer of LAYER_NAMES) {
    const entry = coverage[layer];
    objectValue(entry, `sidecar.o5.coverage.${layer}`);
    if (!COVERAGE_VALUES.includes(entry.status)) {
      throw new OracleRuntimeError(`sidecar.o5.coverage.${layer}.status must be one of ${COVERAGE_VALUES.join(', ')}`);
    }
    if (entry.note !== null && typeof entry.note !== 'string') {
      throw new OracleRuntimeError(`sidecar.o5.coverage.${layer}.note must be null or a string`);
    }
  }
  return coverage;
}

function validateAdmission(admission, index, campaignRunIds) {
  objectValue(admission, `sidecar.o5.admissions[${index}]`);
  nonemptyString(admission.id, `sidecar.o5.admissions[${index}].id`);
  if (!ADMISSION_KINDS.includes(admission.kind)) {
    throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].kind must be one of ${ADMISSION_KINDS.join(', ')}`);
  }
  if (admission.run_id !== null) {
    const runId = canonicalRunId(admission.run_id, `sidecar.o5.admissions[${index}].run_id`);
    if (!campaignRunIds.has(runId)) {
      throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].run_id is not admitted by sidecar.campaign.run_ids`);
    }
    admission.run_id = runId;
  }
  if (!EXPECTED_DISPOSITIONS.includes(admission.expect)) {
    throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].expect must be one of ${EXPECTED_DISPOSITIONS.join(', ')}`);
  }
  for (const key of ['start_identity', 'cwd_prefix', 'cmdline_prefix', 'toolchain']) {
    if (admission[key] !== null && typeof admission[key] !== 'string') {
      throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].${key} must be null or a string`);
    }
  }
  for (const key of ['pid', 'pgid']) {
    if (admission[key] !== null && (!Number.isSafeInteger(admission[key]) || admission[key] <= 0)) {
      throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].${key} must be null or a positive integer`);
    }
  }
  if (admission.pid === null && admission.pgid === null) {
    throw new OracleRuntimeError(`sidecar.o5.admissions[${index}] must carry a numeric pid or pgid anchor (the checker never certifies death without a recorded identity anchor)`);
  }
  arrayValue(admission.required_layers, `sidecar.o5.admissions[${index}].required_layers`);
  for (const layer of admission.required_layers) {
    if (!LAYER_NAMES.includes(layer)) {
      throw new OracleRuntimeError(`sidecar.o5.admissions[${index}].required_layers contains unknown layer ${layer}`);
    }
  }
  if (admission.listen_specs !== null) {
    arrayValue(admission.listen_specs, `sidecar.o5.admissions[${index}].listen_specs`);
    for (const [specIndex, spec] of admission.listen_specs.entries()) {
      objectValue(spec, `sidecar.o5.admissions[${index}].listen_specs[${specIndex}]`);
      nonemptyString(spec.protocol, `...listen_specs[${specIndex}].protocol`);
      nonemptyString(spec.address, `...listen_specs[${specIndex}].address`);
      if (!Number.isSafeInteger(spec.port) || spec.port <= 0) {
        throw new OracleRuntimeError(`...listen_specs[${specIndex}].port must be a positive integer`);
      }
    }
  }
  return admission;
}

function validateScope(scope) {
  objectValue(scope, 'sidecar.o5.scope');
  if (scope.cgroup_pattern !== null && typeof scope.cgroup_pattern !== 'string') {
    throw new OracleRuntimeError('sidecar.o5.scope.cgroup_pattern must be null or a string');
  }
  arrayValue(scope.contained_paths, 'sidecar.o5.scope.contained_paths');
  scope.contained_paths.forEach((entry, index) => isAbsPath(entry) || (() => { throw new OracleRuntimeError(`sidecar.o5.scope.contained_paths[${index}] must be absolute`); })());
  arrayValue(scope.host_admitted_paths, 'sidecar.o5.scope.host_admitted_paths');
  scope.host_admitted_paths.forEach((entry, index) => {
    objectValue(entry, `sidecar.o5.scope.host_admitted_paths[${index}]`);
    isAbsPath(entry.path) || (() => { throw new OracleRuntimeError(`sidecar.o5.scope.host_admitted_paths[${index}].path must be absolute`); })();
    nonemptyString(entry.owner, `sidecar.o5.scope.host_admitted_paths[${index}].owner`);
    if (typeof entry.admitted !== 'boolean') throw new OracleRuntimeError(`sidecar.o5.scope.host_admitted_paths[${index}].admitted must be boolean`);
  });
  arrayValue(scope.daemon_restarts, 'sidecar.o5.scope.daemon_restarts');
  scope.daemon_restarts.forEach((entry, index) => {
    objectValue(entry, `sidecar.o5.scope.daemon_restarts[${index}]`);
    nonemptyString(entry.instance, `sidecar.o5.scope.daemon_restarts[${index}].instance`);
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) throw new OracleRuntimeError(`sidecar.o5.scope.daemon_restarts[${index}].pid must be positive`);
    if (!Number.isSafeInteger(entry.pgid) || entry.pgid <= 0) throw new OracleRuntimeError(`sidecar.o5.scope.daemon_restarts[${index}].pgid must be positive`);
    if (entry.start_identity !== null && typeof entry.start_identity !== 'string') {
      throw new OracleRuntimeError(`sidecar.o5.scope.daemon_restarts[${index}].start_identity must be null or a string`);
    }
    if (typeof entry.scope_membership_observed !== 'boolean') {
      throw new OracleRuntimeError(`sidecar.o5.scope.daemon_restarts[${index}].scope_membership_observed must be a boolean`);
    }
    utcTimestamp(entry.started_at, `sidecar.o5.scope.daemon_restarts[${index}].started_at`);
  });
  return scope;
}

export function validateO5Section(section, campaignRunIds) {
  objectValue(section, 'sidecar.o5');
  validateScope(section.scope);
  arrayValue(section.admissions, 'sidecar.o5.admissions');
  const runIds = new Set(campaignRunIds ?? []);
  for (const [index, admission] of section.admissions.entries()) {
    validateAdmission(admission, index, runIds);
  }
  // Duplicate ADMISSION ids are judged by the O5 evaluator as a content-level
  // inventory finding (O5_INVENTORY_DUPLICATE_ADMISSION), not a shape error:
  // the loader only enforces schema shape; the checker owns content judgment.
  validateCoverage(section.coverage);
  objectValue(section.observations, 'sidecar.o5.observations');
  validateInventory(section.observations.scope_members, 'sidecar.o5.observations.scope_members', validateScopeMemberRow);
  validateInventory(section.observations.processes, 'sidecar.o5.observations.processes', validateProcessRow);
  validateInventory(section.observations.listeners, 'sidecar.o5.observations.listeners', validateListenerRow);
  validateInventory(section.observations.shared_toolchain, 'sidecar.o5.observations.shared_toolchain', validateToolchainRow);
  objectValue(section.census, 'sidecar.o5.census');
  if (typeof section.census.complete !== 'boolean') throw new OracleRuntimeError('sidecar.o5.census.complete must be a boolean');
  arrayValue(section.census.notes, 'sidecar.o5.census.notes');
  section.census.notes.forEach((note, index) => nonemptyString(note, `sidecar.o5.census.notes[${index}]`));
  return section;
}

export function validateO6Section(section) {
  objectValue(section, 'sidecar.o6');
  objectValue(section.database, 'sidecar.o6.database');
  if (!isPortableRelative(section.database.path)) throw new OracleRuntimeError('sidecar.o6.database.path must be a portable relative path');
  if (!/^[a-f0-9]{64}$/.test(section.database.sha256)) throw new OracleRuntimeError('sidecar.o6.database.sha256 must be lowercase sha256');
  nonemptyString(section.database.schema, 'sidecar.o6.database.schema');
  objectValue(section.roots, 'sidecar.o6.roots');
  if (!isAbsPath(section.roots.worktree_root)) throw new OracleRuntimeError('sidecar.o6.roots.worktree_root must be absolute');
  arrayValue(section.roots.origins, 'sidecar.o6.roots.origins');
  for (const [index, origin] of section.roots.origins.entries()) {
    objectValue(origin, `sidecar.o6.roots.origins[${index}]`);
    if (!isAbsPath(origin.repository)) throw new OracleRuntimeError(`sidecar.o6.roots.origins[${index}].repository must be absolute`);
    if (!isAbsPath(origin.git_common_dir)) throw new OracleRuntimeError(`sidecar.o6.roots.origins[${index}].git_common_dir must be absolute`);
    arrayValue(origin.admitted_branch_roots, `sidecar.o6.roots.origins[${index}].admitted_branch_roots`);
    for (const root of origin.admitted_branch_roots) {
      if (typeof root !== 'string' || root.length === 0) {
        throw new OracleRuntimeError(`sidecar.o6.roots.origins[${index}].admitted_branch_roots entries must be nonempty strings`);
      }
    }
  }
  objectValue(section.disk, 'sidecar.o6.disk');
  arrayValue(section.disk.entries, 'sidecar.o6.disk.entries');
  for (const [index, entry] of section.disk.entries.entries()) {
    objectValue(entry, `sidecar.o6.disk.entries[${index}]`);
    if (!isAbsPath(entry.path)) throw new OracleRuntimeError(`sidecar.o6.disk.entries[${index}].path must be absolute`);
    nonemptyString(entry.kind, `sidecar.o6.disk.entries[${index}].kind`);
    if (typeof entry.git_worktree !== 'boolean') throw new OracleRuntimeError(`sidecar.o6.disk.entries[${index}].git_worktree must be a boolean`);
  }
  nonnegativeInteger(section.disk.exact_count, 'sidecar.o6.disk.exact_count');
  if (section.disk.exact_count < section.disk.entries.length) {
    throw new OracleRuntimeError('sidecar.o6.disk.exact_count must be >= inline entry count');
  }
  if (typeof section.disk.capped !== 'boolean') throw new OracleRuntimeError('sidecar.o6.disk.capped must be a boolean');
  if (!section.disk.capped && section.disk.exact_count !== section.disk.entries.length) {
    throw new OracleRuntimeError('sidecar.o6.disk is not capped, so exact_count must equal inline entry count');
  }
  objectValue(section.disk.tool, 'sidecar.o6.disk.tool');
  nonemptyString(section.disk.tool.name, 'sidecar.o6.disk.tool.name');
  if (!Number.isInteger(section.disk.tool.exit_code)) throw new OracleRuntimeError('sidecar.o6.disk.tool.exit_code must be an integer');
  objectValue(section.git, 'sidecar.o6.git');
  arrayValue(section.git.origins, 'sidecar.o6.git.origins');
  for (const [index, gitOrigin] of section.git.origins.entries()) {
    objectValue(gitOrigin, `sidecar.o6.git.origins[${index}]`);
    if (!Number.isSafeInteger(gitOrigin.origin_index) || gitOrigin.origin_index < 0 || gitOrigin.origin_index >= section.roots.origins.length) {
      throw new OracleRuntimeError(`sidecar.o6.git.origins[${index}].origin_index out of range`);
    }
    const list = gitOrigin.worktree_list;
    objectValue(list, `sidecar.o6.git.origins[${index}].worktree_list`);
    arrayValue(list.rows, `...worktree_list.rows`);
    for (const [rowIndex, row] of list.rows.entries()) {
      objectValue(row, `...worktree_list.rows[${rowIndex}]`);
      if (!isAbsPath(row.worktree_path)) throw new OracleRuntimeError(`...worktree_list.rows[${rowIndex}].worktree_path must be absolute`);
      if (row.gitdir_path !== null && typeof row.gitdir_path !== 'string') throw new OracleRuntimeError(`...worktree_list.rows[${rowIndex}].gitdir_path must be null or a string`);
      if (row.branch !== null && typeof row.branch !== 'string') throw new OracleRuntimeError(`...worktree_list.rows[${rowIndex}].branch must be null or a string`);
    }
    nonnegativeInteger(list.exact_count, `...worktree_list.exact_count`);
    if (list.exact_count < list.rows.length) throw new OracleRuntimeError('...worktree_list.exact_count must be >= inline rows');
    if (typeof list.capped !== 'boolean') throw new OracleRuntimeError(`...worktree_list.capped must be a boolean`);
    if (!list.capped && list.exact_count !== list.rows.length) throw new OracleRuntimeError('...worktree_list is not capped, so exact_count must equal inline rows');
    objectValue(list.tool, `...worktree_list.tool`);
    if (!Number.isInteger(list.tool.exit_code)) throw new OracleRuntimeError('...worktree_list.tool.exit_code must be an integer');
    const metadata = gitOrigin.worktrees_metadata;
    objectValue(metadata, `...worktrees_metadata`);
    arrayValue(metadata.rows, `...worktrees_metadata.rows`);
    for (const [rowIndex, row] of metadata.rows.entries()) {
      objectValue(row, `...worktrees_metadata.rows[${rowIndex}]`);
      if (!isAbsPath(row.gitdir_path)) throw new OracleRuntimeError(`...worktrees_metadata.rows[${rowIndex}].gitdir_path must be absolute`);
      nonemptyString(row.name, `...worktrees_metadata.rows[${rowIndex}].name`);
      if (row.gitdir_target !== null && typeof row.gitdir_target !== 'string') {
        throw new OracleRuntimeError(`...worktrees_metadata.rows[${rowIndex}].gitdir_target must be null or a string`);
      }
      if (row.worktree_path !== null && !isAbsPath(row.worktree_path)) {
        throw new OracleRuntimeError(`...worktrees_metadata.rows[${rowIndex}].worktree_path must be null or absolute`);
      }
    }
    const branches = gitOrigin.branches;
    objectValue(branches, `...branches`);
    arrayValue(branches.rows, `...branches.rows`);
    for (const [rowIndex, row] of branches.rows.entries()) {
      objectValue(row, `...branches.rows[${rowIndex}]`);
      nonemptyString(row.full_ref, `...branches.rows[${rowIndex}].full_ref`);
      nonemptyString(row.type, `...branches.rows[${rowIndex}].type`);
    }
    nonnegativeInteger(branches.exact_count, `...branches.exact_count`);
    if (branches.exact_count < branches.rows.length) throw new OracleRuntimeError('...branches.exact_count must be >= inline rows');
  }
  objectValue(section.prune, 'sidecar.o6.prune');
  if (typeof section.prune.executed !== 'boolean') throw new OracleRuntimeError('sidecar.o6.prune.executed must be a boolean');
  objectValue(section.prune.plan, 'sidecar.o6.prune.plan');
  nonemptyString(section.prune.plan.clone_root, 'sidecar.o6.prune.plan.clone_root');
  if (typeof section.prune.plan.closed_scope !== 'boolean') throw new OracleRuntimeError('sidecar.o6.prune.plan.closed_scope must be a boolean');
  nonemptyString(section.prune.refusal, 'sidecar.o6.prune.refusal');
  if (section.prune.executed !== false) {
    throw new OracleRuntimeError('sidecar.o6.prune.executed must be false in this read-only run (removal gated on independent coordinator review)');
  }
  return section;
}

export function validateSidecarShape(sidecar) {
  objectValue(sidecar, 'sidecar');
  validateCommon(sidecar);
  if (sidecar.oracle_id === 'O5') validateO5Section(sidecar.o5, sidecar.campaign.run_ids);
  else validateO6Section(sidecar.o6);
  return sidecar;
}

// ── loader ───────────────────────────────────────────────────────────────

function verifyFile(rootDir, file) {
  const absolute = path.resolve(rootDir, file.path);
  if (!pathIsWithin(rootDir, absolute)) {
    throw new OracleRuntimeError(`sidecar evidence file ${file.path} must be contained beneath the sidecar directory`);
  }
  let details;
  let real;
  try {
    details = fs.lstatSync(absolute);
    real = fs.realpathSync(absolute);
  } catch (error) {
    throw new OracleRuntimeError(`sidecar evidence file ${file.path} is missing or inaccessible`, { cause: error });
  }
  if (details.isSymbolicLink() || !pathIsWithin(rootDir, real) || real !== absolute || !details.isFile()) {
    throw new OracleRuntimeError(`sidecar evidence file ${file.path} must be a contained regular non-symlink file`);
  }
  const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual !== file.sha256) {
    throw new OracleRuntimeError(`sidecar evidence file ${file.path} sha256 mismatch`);
  }
  return absolute;
}

/**
 * loadHygieneSidecar(sidecarPath, { verifyEvidence = true })
 *
 * Read + schema-validate the post-batch hygiene sidecar (v1) at sidecarPath and
 * (by default) hash-verify every referenced evidence file. Returns a frozen
 * invocation: { sidecarPath, sidecarRoot, sidecar, evidenceAbs: Map<path, abs> }.
 * Read-only: no file is created or modified. Errors are OracleRuntimeError so
 * the wrapper maps them to result ERROR.
 */
export function loadHygieneSidecar(sidecarPathInput, options = {}) {
  const { verifyEvidence = true } = options;
  if (typeof sidecarPathInput !== 'string' || !path.isAbsolute(sidecarPathInput)) {
    throw new OracleRuntimeError('sidecar path must be absolute');
  }
  const sidecarPath = path.resolve(sidecarPathInput);
  let details;
  try {
    details = fs.lstatSync(sidecarPath);
  } catch (error) {
    throw new OracleRuntimeError(`sidecar file is missing: ${sidecarPathInput}`, { cause: error });
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new OracleRuntimeError('sidecar must be a regular non-symlink file');
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (error) {
    throw new OracleRuntimeError(`sidecar JSON parse failed: ${error.message}`, { cause: error });
  }
  validateSidecarShape(sidecar);
  const sidecarRoot = path.dirname(sidecarPath);
  const evidenceAbs = new Map();
  if (verifyEvidence) {
    for (const file of sidecar.evidence_files) {
      evidenceAbs.set(file.path, verifyFile(sidecarRoot, file));
    }
  }
  return Object.freeze({
    sidecarPath,
    sidecarRoot,
    sidecar,
    evidenceAbs: Object.freeze(evidenceAbs),
  });
}

export { portableRelativePath };
