import fs from 'node:fs';
import path from 'node:path';
import { OracleRuntimeError, portableRelativePath, requireContainedPath } from './paths.mjs';
import { legacyCreateViaProcFdResolution } from './evidence-procfd-legacy.mjs';

// ──────────────────────────────────────────────────────────────────────────
// Portable exclusive-create for oracle evidence writes (MACP3 / US-001).
//
// The pre-US-001 implementation resolved the containing parent directory
// through the linux-only "proc fd namespace" (`proc/self/fd/<fd>/<part>`)
// after opening it with O_DIRECTORY. That namespace does not exist on Darwin,
// so on macOS every evidence write failed with "exclusive evidence create
// failed ...: ENOENT at the proc fd namespace path (proc/self/fd/...). This
// surfaced as the tier0
// INFRA_FAILURE (W0.0-fast, O3z) observed on the mac at a446deac
// (campaign-20260818T163719127Z-a61d3870 tier0).
//
// The portable strategy below tracks the parent directory by PATH
// (root joined with relative parts) instead of resolving through the proc fd
// namespace, while preserving every guarantee the old form gave:
//   - each parent is opened with O_RDONLY|O_DIRECTORY|O_NOFOLLOW,
//   - mkdir -p semantics (EEXIST tolerated) with mode 0o700,
//   - the final file is created with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW and
//     mode 0o600 — duplicates still fail with the 'exclusive evidence create
//     failed' OracleRuntimeError,
//   - containment beneath the campaign root is enforced by
//     requireContainedPath before any write.
//
// Injectable seam (Proof #1): _evidenceCreate accepts a procfdResolution
// override. The public API (writeEvidenceFile / writeEvidenceJson) always
// uses the portable path-tracked strategy (procfdResolution defaults to
// false) and never touches the proc fd namespace — this file contains no
// literal slash-proc text (lint-guarded in evidence-portability.test.mjs).
// Hermetic
// tests drive { procfdResolution: false } to force the non-proc-fd path to a
// successful exclusive create, and { procfdResolution: true } to select the
// preserved legacy strategy (see evidence-procfd-legacy.mjs, which
// reproduces the Darwin ENOENT defect hermetically via its own
// procAvailable override).
// ──────────────────────────────────────────────────────────────────────────

function openContainedParent(root, relative) {
  // Track the parent directory PATH (root + relative parts); never resolve
  // through the proc fd namespace.  Each parent is opened with
  // O_RDONLY|O_DIRECTORY|O_NOFOLLOW and mkdir -p semantics (EEXIST
  // tolerated), mirroring the pre-portability openat behavior so a symlinked
  // intermediate parent still fails the write.
  let cursor = root;
  for (const part of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    fs.closeSync(fs.openSync(cursor, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
  }
  return cursor;
}

function createViaPortablePath(root, relativePath, content, kind) {
  let descriptor;
  try {
    const parentPath = openContainedParent(root, relativePath);
    const name = relativePath.split('/').at(-1);
    const target = path.join(parentPath, name);
    descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw new OracleRuntimeError(`exclusive evidence create failed for ${relativePath}: ${error.message}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return { path: relativePath, kind };
}

/**
 * Injectable seam over the evidence exclusive-create.
 *
 * `procfdResolution` selects between the two create strategies so hermetic
 * tests can exercise either one deterministically:
 *   - false (default; the ONLY mode the public API uses): portable
 *     path-tracked strategy — Darwin-safe, no proc fd namespace dependency.
 *   - true: legacy resolution via the proc fd namespace (see
 *     evidence-procfd-legacy.mjs) — kept so tests can reproduce the
 *     pre-US-001 defect and prove the portable path does not depend on it.
 *
 * Internal/exported for tests only; writeEvidenceFile/writeEvidenceJson
 * signatures and behavior are unchanged.
 */
export function _evidenceCreate(invocation, relativePath, content, kind, { procfdResolution = false } = {}) {
  portableRelativePath(relativePath, 'evidence path');
  if (typeof kind !== 'string' || kind.length === 0) throw new OracleRuntimeError('evidence kind must be nonempty');
  const root = requireContainedPath(invocation.evidenceDir, invocation.evidenceDir, { kind: 'directory', label: 'TT_ORACLE_EVIDENCE_DIR' });
  if (procfdResolution) return legacyCreateViaProcFdResolution(root, relativePath, content, kind);
  return createViaPortablePath(root, relativePath, content, kind);
}

export function writeEvidenceFile(invocation, relativePath, content, kind) {
  return _evidenceCreate(invocation, relativePath, content, kind);
}

export function writeEvidenceJson(invocation, relativePath, value, kind = 'json') {
  return writeEvidenceFile(invocation, relativePath, `${JSON.stringify(value, null, 2)}\n`, kind);
}
