import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { OracleRuntimeError } from './paths.mjs';

export function openEvidenceDatabase(invocation, key = 'database_snapshot') {
  const evidencePath = invocation.evidencePaths?.[key];
  if (typeof evidencePath !== 'string') {
    throw new OracleRuntimeError(`${key} is not a controller-provided evidence reference; database fallbacks are forbidden`);
  }
  const details = fs.statSync(evidencePath);
  if ((details.mode & 0o222) !== 0) {
    throw new OracleRuntimeError(`${key} snapshot is writable; oracle SQLite inputs must be read-only`);
  }
  return new DatabaseSync(evidencePath, { readOnly: true });
}
