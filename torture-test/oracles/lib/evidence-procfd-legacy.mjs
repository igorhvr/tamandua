import fs from 'node:fs';
import { OracleRuntimeError } from './paths.mjs';

// ──────────────────────────────────────────────────────────────────────────
// LEGACY linux-only exclusive-create strategy (pre-US-001), retained as the
// { procfdResolution: true } arm of the _evidenceCreate seam in evidence.mjs
// so hermetic tests can reproduce the historical Darwin defect on any host.
//
// The original algorithm resolved the containing parent directory through
// /proc/self/fd/<fd>/<part>: it opened each parent RELATIVE TO an open
// directory descriptor (openat semantics) and created the final file at
// /proc/self/fd/<parentDescriptor>/<name>. On Darwin /proc does not exist,
// so every evidence write failed with:
//
//   exclusive evidence create failed for <rel>: ENOENT: no such file or
//   directory ... /proc/self/fd/<fd>/<rel>
//
// This module is intentionally test-only: the public API (evidence.mjs)
// always uses the portable path-tracked strategy and never imports /proc,
// so runtime behavior is identical on linux and Darwin.
//
// To simulate a /proc-less environment hermetically (no Mac required), pass
// { procAvailable: false } — resolution then fails up front with the exact
// ENOENT-class OracleRuntimeError the defect produced, independent of the
// host's actual /proc. Default auto-detects the host via fs.existsSync on
// '/proc/self/fd'.
// ──────────────────────────────────────────────────────────────────────────

function openContainedParentLegacy(root, relative) {
  let descriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const part of relative.split('/').slice(0, -1)) {
      const child = `/proc/self/fd/${descriptor}/${part}`;
      try {
        fs.mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const next = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function legacyCreateViaProcFdResolution(root, relativePath, content, kind, { procAvailable = fs.existsSync('/proc/self/fd') } = {}) {
  let parentDescriptor;
  let descriptor;
  try {
    if (!procAvailable) {
      // Reproduce the exact pre-portability failure on Darwin: the create
      // path resolves through /proc/self/fd, which does not exist.
      throw new Error(`ENOENT: no such file or directory, open '/proc/self/fd/0/${relativePath}'`);
    }
    parentDescriptor = openContainedParentLegacy(root, relativePath);
    const name = relativePath.split('/').at(-1);
    descriptor = fs.openSync(`/proc/self/fd/${parentDescriptor}/${name}`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    return { path: relativePath, kind };
  } catch (error) {
    throw new OracleRuntimeError(`exclusive evidence create failed for ${relativePath}: ${error.message}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}
