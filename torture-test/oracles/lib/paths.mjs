import fs from 'node:fs';
import path from 'node:path';

export class OracleRuntimeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OracleRuntimeError';
  }
}

export function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function portableRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)
      || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new OracleRuntimeError(`${label} must be a portable relative path`);
  }
  return value;
}

export function requireContainedPath(root, candidate, { kind = 'file', label = 'path' } = {}) {
  const realRoot = fs.realpathSync(root);
  const absolute = path.resolve(candidate);
  if (!pathIsWithin(realRoot, absolute)) throw new OracleRuntimeError(`${label} must be contained beneath the campaign root`);
  let details;
  let real;
  try {
    details = fs.lstatSync(absolute);
    real = fs.realpathSync(absolute);
  } catch (error) {
    throw new OracleRuntimeError(`${label} is missing or inaccessible`, { cause: error });
  }
  if (details.isSymbolicLink() || !pathIsWithin(realRoot, real) || real !== absolute) {
    throw new OracleRuntimeError(`${label} must be a contained non-symlink ${kind}`);
  }
  if (kind === 'file' && !details.isFile()) throw new OracleRuntimeError(`${label} must be a contained regular non-symlink file`);
  if (kind === 'directory' && !details.isDirectory()) throw new OracleRuntimeError(`${label} must be a contained non-symlink directory`);
  return real;
}

export function findCampaignRoot(contextPath) {
  const absolute = path.resolve(contextPath);
  const contextDetails = fs.lstatSync(absolute);
  if (!contextDetails.isFile() || contextDetails.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new OracleRuntimeError('context must be a regular non-symlink file');
  }
  let cursor = path.dirname(absolute);
  while (true) {
    const marker = path.join(cursor, 'state.json');
    if (fs.existsSync(marker)) {
      const details = fs.lstatSync(marker);
      if (!details.isFile() || details.isSymbolicLink() || fs.realpathSync(marker) !== marker) {
        throw new OracleRuntimeError('campaign state.json must be a regular non-symlink file');
      }
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new OracleRuntimeError('context is not beneath a campaign results directory containing state.json');
    cursor = parent;
  }
}

export function resolveEvidenceReference(campaignRoot, reference, label) {
  portableRelativePath(reference?.path, `${label}.path`);
  return requireContainedPath(campaignRoot, path.resolve(campaignRoot, reference.path), { kind: 'file', label });
}
