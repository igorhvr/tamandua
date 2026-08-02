import fs from 'node:fs';
import { OracleRuntimeError, portableRelativePath, requireContainedPath } from './paths.mjs';

function openContainedParent(root, relative) {
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

export function writeEvidenceFile(invocation, relativePath, content, kind) {
  portableRelativePath(relativePath, 'evidence path');
  if (typeof kind !== 'string' || kind.length === 0) throw new OracleRuntimeError('evidence kind must be nonempty');
  const root = requireContainedPath(invocation.evidenceDir, invocation.evidenceDir, { kind: 'directory', label: 'TT_ORACLE_EVIDENCE_DIR' });
  let parentDescriptor;
  let descriptor;
  try {
    parentDescriptor = openContainedParent(root, relativePath);
    const name = relativePath.split('/').at(-1);
    descriptor = fs.openSync(`/proc/self/fd/${parentDescriptor}/${name}`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw new OracleRuntimeError(`exclusive evidence create failed for ${relativePath}: ${error.message}`, { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
  return { path: relativePath, kind };
}

export function writeEvidenceJson(invocation, relativePath, value, kind = 'json') {
  return writeEvidenceFile(invocation, relativePath, `${JSON.stringify(value, null, 2)}\n`, kind);
}
