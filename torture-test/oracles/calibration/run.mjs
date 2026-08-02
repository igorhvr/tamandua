#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const workspace = path.resolve(process.argv[2] ?? '');

if (workspace === VAR_ROOT || !workspace.startsWith(`${VAR_ROOT}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('calibration workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
for (const item of manifest.cases) {
  const fixture = path.join(workspace, `calibration-${item.id}`);
  const contextPath = path.join(fixture, 'evidence', 'context.json');
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture, 'calibration.json'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  if (metadata.schema_version !== manifest.schema_version || metadata.contract_version !== manifest.contract_version) {
    throw new Error(`calibration metadata version mismatch for ${item.id}`);
  }

  const oracle = path.join(HERE, '..', item.oracle_id);
  const result = spawnSync(oracle, ['--contract-version', String(manifest.contract_version), '--context', contextPath], {
    cwd: path.dirname(contextPath),
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: path.join(workspace, 'no-production-home'),
      TT_ORACLE_CONTRACT_VERSION: String(manifest.contract_version),
      TT_ORACLE_ID: item.oracle_id,
      TT_ORACLE_CONTEXT: contextPath,
      TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
      TT_CASE_ID: item.id,
      TT_CAMPAIGN_ID: context.campaign.id,
      TT_RUN_ID: context.run_id,
    },
  });
  if (result.error) throw result.error;
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`${item.oracle_id} emitted invalid JSON for ${item.id}: ${result.stdout}\n${result.stderr}`);
  }
  if (result.status !== 1 || response.result !== item.expected_result) {
    throw new Error(`${item.id} expected FAIL/1, got ${response.result}/${result.status}: ${JSON.stringify(response)}`);
  }
  if (!response.findings?.some((finding) => finding.id === item.expected_finding)) {
    throw new Error(`${item.id} omitted ${item.expected_finding}: ${JSON.stringify(response.findings)}`);
  }
  process.stdout.write(`calibration ${item.id} caught ${item.expected_finding}\n`);
}
