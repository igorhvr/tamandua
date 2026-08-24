#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, '../..');
const VAR_ROOT = path.join(TT_ROOT, 'var');
const workspace = path.resolve(process.argv[2] ?? '');
if (workspace === VAR_ROOT || !workspace.startsWith(`${VAR_ROOT}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(workspace, 'state.json'), '{}\n', { flag: 'wx' });
const snapshots = path.join(workspace, 'snapshots');
fs.mkdirSync(snapshots);
const capturedAt = '2026-08-01T12:00:00.000Z';
const keys = [
  'database_snapshot', 'run_events', 'workflow_status', 'launch_intent', 'git_bundle',
  'refs_before', 'refs_after', 'target_reflog', 'checksum_baseline', 'checksum_terminal',
  'suite_ledger', 'suite_observations', 'token_deltas', 'round_usage',
  'system_tokens_before', 'system_tokens_after', 'submit_rejections',
  'expects_validations', 'dispatch_renderings', 'probe_evidence', 'chaos_log',
];
const references = Object.fromEntries(keys.map((key) => [key, null]));
for (const key of ['database_snapshot', 'run_events', 'workflow_status']) {
  const content = `${JSON.stringify({ fixture: true, key })}\n`;
  const snapshot = path.join(snapshots, `${key}.json`);
  fs.writeFileSync(snapshot, content, { mode: 0o400, flag: 'wx' });
  references[key] = {
    path: `snapshots/${key}.json`,
    sha256: createHash('sha256').update(content).digest('hex'),
    captured_at: capturedAt,
    source: 'self-test-fixture',
  };
}
const runtimeUrl = new URL('../lib/index.mjs', import.meta.url).href;
for (const [name, result] of [['pass', 'PASS'], ['fail', 'FAIL'], ['not-evaluable', 'NOT_EVALUABLE'], ['false-positive', 'PASS'], ['missed-violation', 'FAIL']]) {
  const evidenceDir = path.join(workspace, 'evidence', name);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const context = {
    contract_version: 1,
    oracle_id: 'O1',
    campaign: { id: `campaign-${name}`, created_at: capturedAt, manifest: { sha256: 'a'.repeat(64), case_count: 1, case_ids: [`CASE-${name}`] } },
    case: { id: `CASE-${name}`, wave: 0, workflow: 'local', fixture: 'synthetic', harness: 'local', class: 'verification', caps: { tokens: 0, wall_min: 1 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 0, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  fs.writeFileSync(path.join(evidenceDir, 'context.json'), `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  const source = `#!/usr/bin/env node\nimport { oracleMain, writeEvidenceJson } from ${JSON.stringify(runtimeUrl)};\nawait oracleMain(async invocation => {\n  const evidence = [writeEvidenceJson(invocation, 'observation.json', {synthetic:true}, 'filesystem')];\n  return {result:${JSON.stringify(result)},findings:${result === 'FAIL' ? "[{id:'SYNTHETIC_VIOLATION',summary:'synthetic mechanical violation'}]" : '[]'},evidence};\n});\n`;
  const oracle = path.join(workspace, `oracle-${name}`);
  fs.writeFileSync(oracle, source, { mode: 0o700, flag: 'wx' });
}

// US-001 (adopted S19 policy): informational, NON-FAILING findings on PASS.
// oracle-pass-informational emits a PASS carrying a non_failing finding through
// the real runtime (oracleMain) — the harness must accept it (the new relaxed
// output-contract rule). oracle-pass-failing-finding emits a PASS carrying an
// UNMARKED finding — the harness must reject it (false-positive rejection stays
// intact). The latter is a raw script rather than oracleMain so the runtime's
// internal validation does not mask the response as ERROR: the harness's own
// validateOracleResponse is what must catch the failing finding.
const informationalOracleSource = `#!/usr/bin/env node\nimport { oracleMain, writeEvidenceJson } from ${JSON.stringify(runtimeUrl)};\nawait oracleMain(async invocation => {\n  const evidence = [writeEvidenceJson(invocation, 'observation.json', {synthetic:true}, 'filesystem')];\n  return {result:'PASS',findings:[{id:'O8_SEEDED_TEST_EXTENDED',summary:'informational: strictly additive seeded-test extension',non_failing:true,diff:{lines_added:3,lines_deleted:0}}],evidence};\n});\n`;
const failingFindingOracleSource = `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({contract_version:1,oracle_id:'O1',result:'PASS',started_at:'2026-08-01T12:00:00.000Z',finished_at:'2026-08-01T12:00:01.000Z',findings:[{id:'UNMARKED_FINDING',summary:'failing finding without the non_failing stamp'}],evidence:[]}) + '\\n');\nprocess.exit(0);\n`;
for (const [name, source] of [
  ['pass-informational', informationalOracleSource],
  ['pass-failing-finding', failingFindingOracleSource],
]) {
  const evidenceDir = path.join(workspace, 'evidence', name);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const context = {
    contract_version: 1,
    oracle_id: 'O1',
    campaign: { id: `campaign-${name}`, created_at: capturedAt, manifest: { sha256: 'a'.repeat(64), case_count: 1, case_ids: [`CASE-${name}`] } },
    case: { id: `CASE-${name}`, wave: 0, workflow: 'local', fixture: 'synthetic', harness: 'local', class: 'verification', caps: { tokens: 0, wall_min: 1 }, boundary_files: [], forbidden: [], chaos: null },
    run_id: null,
    attempts: [],
    discovered_runs: [],
    o1_wave: { schema_version: 1, wave: 0, duration_floors: [], runs: [] },
    mechanical_evidence: { schema_version: 1, references },
  };
  fs.writeFileSync(path.join(evidenceDir, 'context.json'), `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  const oracle = path.join(workspace, `oracle-${name}`);
  fs.writeFileSync(oracle, source, { mode: 0o700, flag: 'wx' });
}
