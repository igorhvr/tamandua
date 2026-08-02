#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { validateOracleResponse } from '../lib/output.mjs';

function fail(message) {
  process.stderr.write(`SELF-TEST ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--oracle', '--context', '--expected'].includes(key) || value === undefined) fail('usage: harness.mjs --oracle PATH --context PATH --expected PASS|FAIL');
    values[key.slice(2)] = value;
  }
  if (Object.keys(values).length !== 3 || !['PASS', 'FAIL'].includes(values.expected)) fail('expected result must be PASS or FAIL');
  return values;
}

const values = parseArgs();
const oracle = path.resolve(values.oracle);
const contextPath = path.resolve(values.context);
let context;
try {
  const details = fs.lstatSync(oracle);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o111) === 0) fail('oracle must be an executable regular non-symlink file');
  const contextDetails = fs.lstatSync(contextPath);
  if (!contextDetails.isFile() || contextDetails.isSymbolicLink()) fail('context must be a regular non-symlink file');
  context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
} catch (error) {
  fail(`cannot load self-test fixture: ${error.message}`);
}
const evidenceDir = path.dirname(contextPath);
const env = {
  ...process.env,
  TT_ORACLE_CONTRACT_VERSION: '1',
  TT_ORACLE_ID: context.oracle_id,
  TT_ORACLE_CONTEXT: contextPath,
  TT_ORACLE_EVIDENCE_DIR: evidenceDir,
  TT_CASE_ID: context.case.id,
  TT_CAMPAIGN_ID: context.campaign.id,
};
if (context.run_id !== null) env.TT_RUN_ID = context.run_id;
else delete env.TT_RUN_ID;
const startedAt = performance.now();
const result = spawnSync(oracle, ['--contract-version', '1', '--context', contextPath], {
  cwd: evidenceDir,
  env,
  encoding: 'utf8',
  shell: false,
  timeout: 10_000,
  maxBuffer: 8 * 1024 * 1024,
});
const elapsedMs = Math.ceil(performance.now() - startedAt);
if (result.error !== undefined) fail(`oracle execution failed: ${result.error.message}`);
if (result.signal !== null) fail(`oracle terminated by signal ${result.signal}`);
let response;
try {
  const trimmed = result.stdout.trim();
  response = JSON.parse(trimmed);
} catch (error) {
  fail(`oracle stdout is not exactly one JSON object: ${error.message}`);
}
const errors = validateOracleResponse(response, context.oracle_id, result.status, evidenceDir);
if (errors.length > 0) fail(errors.join('; '));
if (response.result !== values.expected) fail(`expected ${values.expected}, observed ${response.result}`);
if (elapsedMs >= 10_000) fail(`oracle exceeded standalone 10-second limit (${elapsedMs}ms)`);
process.stdout.write(`expected ${values.expected} accepted for ${path.basename(oracle)} (${elapsedMs}ms)\n`);
