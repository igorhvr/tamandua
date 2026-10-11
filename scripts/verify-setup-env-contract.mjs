// Independent, commit-bound SETUP-ENV-CONTRACT verification — TRACKED SUCCESSOR
// of the frozen out-of-repo a0p instrument.
//
// Provenance: the predecessor is the frozen ops artifact
//   accept-wave1/setup-141/ops/verify-setup-env-contract.mjs
//   sha256 f0a5ca9912eb97fc9fc079a6c7b83f08dc049f460a0924da44557a786fad0e0f
// which pinned the setup module's static imports to exactly ["node:path"].
// Bead tamandua-48v consolidated the duplicated standard-image constant
// (matchlock-setup.ts now imports STANDARD_MATCHLOCK_IMAGE from
// ./matchlock/standard-image.js), so that frozen property intentionally
// changed. This successor performs the DELIBERATE bump: it keeps every one of
// the eight original behavioral assertions and the fixed/defect mode
// semantics byte-for-byte in spirit, and re-pins the import list to the
// consolidated shape:
//   ["node:path", "./matchlock/standard-image.js"]  (and no dynamic imports)
// It additionally verifies the canonical sibling module from the SAME
// candidate commit (worktree bytes == committed bytes; exported constant).
//
// The archived predecessor artifacts are EVIDENCE and are never modified;
// this tracked file is the living verifier. In-repo references to it:
// tests/matchlock-setup-standard-image-parity.test.ts and
// tests/setup-env-contract-verifier.test.ts (the latter exercises fixed-mode
// success, defect-mode semantics, unauthorized-import refusal, dirty-source
// refusal and identity refusal on isolated committed fixtures).
//
// The candidate sources are executed from SOURCE (this repo's canonical
// module location) via a narrow ESM resolver that maps exactly the one
// sibling specifier the setup module declares to its in-tree .ts file — never
// from stale dist output.
//
// Usage: node verify-setup-env-contract.mjs REPO FULL_COMMIT fixed|defect
// defect mode succeeds only when EXACTLY the two canonical contract assertions fail.
// fixed mode requires EVERY assertion to pass; defect-mode success is NOT acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [repo, expected, mode] = process.argv.slice(2);
assert.ok(repo && path.isAbsolute(repo), 'explicit absolute candidate repository required');
assert.match(expected ?? '', /^[0-9a-f]{40}$/, 'explicit full commit required');
assert.ok(mode === 'fixed' || mode === 'defect', 'mode must be fixed or defect');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', timeout: 10000, maxBuffer: 2_000_000,
}).trim();
assert.equal(git('rev-parse', 'HEAD'), expected, 'candidate identity mismatch');
const beforeStatus = git('status', '--porcelain=v1');
assert.equal(beforeStatus, '', 'candidate must be clean');
const relative = 'src/installer/matchlock-setup.ts';
const siblingRelative = 'src/installer/matchlock/standard-image.ts';
const source = readFileSync(path.join(repo, relative));
const committed = execFileSync('git', ['-C', repo, 'show', `${expected}:${relative}`], {
  timeout: 10000, maxBuffer: 2_000_000,
});
assert.deepEqual(source, committed, 'candidate source differs from committed bytes');
const siblingSource = readFileSync(path.join(repo, siblingRelative));
const siblingCommitted = execFileSync('git', ['-C', repo, 'show', `${expected}:${siblingRelative}`], {
  timeout: 10000, maxBuffer: 2_000_000,
});
assert.deepEqual(siblingSource, siblingCommitted, 'sibling source differs from committed bytes');

// ── The deliberately BUMPED import contract (tamandua-48v) ──────────────
// The setup module's static surface is exactly the node:path utilities plus
// the ONE consolidated sibling constant; anything else — a multiline
// import, a side-effect import, a re-export — is a contract break.
const importSpecifiers = [
  ...source
    .toString()
    .matchAll(/^import(?!\s*\()[^;]*?from\s+["']([^"']+)["'];|^import\s+["']([^"']+)["'];/gm),
].map((m) => m[1] ?? m[2]);
assert.deepEqual(
  importSpecifiers,
  ['node:path', './matchlock/standard-image.js'],
  'setup module static imports must be exactly node:path + the consolidated sibling',
);
assert.equal(/\bimport\s*\(/.test(source.toString()), false, 'pure module unexpectedly has dynamic imports');
assert.equal(
  /^export\s[^;]*\bfrom\s+["']/m.test(source.toString()),
  false,
  'setup module must not re-export from other modules',
);

// ── The consolidated sibling is verified from the SAME candidate commit ─
// Before evaluating it, pin its purity: the sibling must stay dependency
// free (no imports, no re-exports, no dynamic imports), so the loading
// boundary below only ever needs to map the one allowed specifier.
assert.equal(
  /^\s*(import|export)\b[^;]*\bfrom\b/m.test(siblingSource.toString()),
  false,
  'sibling standard-image module must have no imports/re-exports',
);
assert.equal(
  /^\s*import\s+["']/m.test(siblingSource.toString()),
  false,
  'sibling standard-image module must have no side-effect-only imports',
);
assert.equal(/\bimport\s*\(/.test(siblingSource.toString()), false, 'sibling must have no dynamic imports');
const setupUrl = pathToFileURL(path.join(repo, relative)).href;
const siblingUrl = pathToFileURL(path.join(repo, siblingRelative)).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (parent === ${JSON.stringify(setupUrl)}) {
    if (specifier === './matchlock/standard-image.js') {
      return nextResolve('./matchlock/standard-image.ts', context);
    }
    if (specifier === 'node:path') return nextResolve(specifier, context);
    throw new Error('unauthorized dependency edge from the setup module: ' + specifier);
  }
  if (parent === ${JSON.stringify(siblingUrl)}) {
    throw new Error('unauthorized dependency edge from the sibling module: ' + specifier);
  }
  return nextResolve(specifier, context);
}`));
const siblingModule = await import(pathToFileURL(path.join(repo, siblingRelative)).href);
assert.equal(
  siblingModule.STANDARD_MATCHLOCK_IMAGE,
  'igorhvr/tamandua',
  'the canonical sibling constant must be igorhvr/tamandua',
);

const m = await import(pathToFileURL(path.join(repo, relative)).href);
assert.equal(
  m.STANDARD_IMAGE_REFERENCE,
  siblingModule.STANDARD_MATCHLOCK_IMAGE,
  'the setup alias must BE the canonical sibling constant (consolidated, not duplicated)',
);
const installed = '/owned-fixture/bin/matchlock';
const selected = '/explicit-override/bin/matchlock';
let forbiddenEffects = 0;
function deps(env = {}) {
  return {
    env: { PATH: '/owned-fixture/bin', ...env },
    fs: { isExecutable: async candidate => candidate === installed },
    runCommand: () => { forbiddenEffects++; throw new Error('forbidden command effect'); },
  };
}
const results = [];
async function check(name, fn) {
  try { results.push({ name, status: 'PASS', observed: await fn() }); }
  catch (error) {
    if (error.code !== 'ERR_ASSERTION') throw error;
    results.push({ name, status: 'FAIL', actual: error.actual, expected: error.expected, message: error.message });
  }
}
const canonicalFailures = ['literal RPC override', 'literal pull timeout'];
await check(canonicalFailures[0], async () => {
  const result = await m.resolveExpectedDaemonBinary(deps({ TAMANDUA_MATCHLOCK_RPC_BIN: selected }), installed);
  assert.equal(result.path, selected);
  assert.equal(result.fromEnvOverride, true);
  assert.equal(result.shadowed, true);
  return result;
});
await check(canonicalFailures[1], () => {
  const result = m.pullTimeoutMs(deps({ TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: '12345' }));
  assert.equal(result, 12345);
  return result;
});
await check('typo-only RPC diagnostic control', async () => {
  const result = await m.resolveExpectedDaemonBinary(deps({ TANDAMUA_MATCHLOCK_RPC_BIN: selected }), installed);
  assert.equal(result.path, mode === 'defect' ? selected : installed);
  assert.equal(result.fromEnvOverride, mode === 'defect');
  return result;
});
await check('typo-only timeout diagnostic control', () => {
  const result = m.pullTimeoutMs(deps({ TANDAMUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: '12345' }));
  assert.equal(result, mode === 'defect' ? 12345 : 900000);
  return result;
});
await check('unset PATH and timeout defaults unchanged', async () => {
  const result = await m.resolveExpectedDaemonBinary(deps(), installed);
  assert.equal(result.path, installed);
  assert.equal(result.fromEnvOverride, false);
  assert.equal(m.pullTimeoutMs(deps()), 900000);
  return result;
});
await check('invalid and empty literal timeout values retain default', () => {
  const values = ['', '   ', 'not-a-number', '0', '-5', 'Infinity'];
  for (const value of values) {
    assert.equal(m.pullTimeoutMs(deps({ TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: value })), 900000, `invalid timeout ${JSON.stringify(value)}`);
  }
  return { cases: values.length };
});
await check('empty RPC and no PATH match retain bare fallback', async () => {
  const result = await m.resolveExpectedDaemonBinary(deps({ TAMANDUA_MATCHLOCK_RPC_BIN: '   ', PATH: '/empty-fixture/bin' }), installed);
  assert.equal(result.path, 'matchlock');
  assert.equal(result.fromEnvOverride, false);
  assert.equal(result.resolvedFromPath, false);
  return result;
});
await check('literal image override remains unchanged', () => {
  const result = m.effectiveImageReference(deps({ TAMANDUA_MATCHLOCK_IMAGE: 'fixture/image:custom' }));
  assert.deepEqual(result, { reference: 'fixture/image:custom', source: 'env' });
  return result;
});
assert.equal(forbiddenEffects, 0);
assert.deepEqual(readFileSync(path.join(repo, relative)), source);
assert.deepEqual(readFileSync(path.join(repo, siblingRelative)), siblingSource);
assert.equal(git('rev-parse', 'HEAD'), expected);
assert.equal(git('status', '--porcelain=v1'), beforeStatus);
assert.equal(results.length, 8, 'no vacuous acceptance');
const failures = results.filter(x => x.status === 'FAIL').map(x => x.name);
const matched = mode === 'fixed' ? failures.length === 0 : JSON.stringify(failures) === JSON.stringify(canonicalFailures);
console.log(JSON.stringify({
  head: expected, tree: git('rev-parse', 'HEAD^{tree}'), node: process.version,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  siblingSourceSha256: createHash('sha256').update(siblingSource).digest('hex'),
  mode, forbiddenEffects, results, passed: results.length - failures.length,
  failed: failures.length, expectedOutcomeMatched: matched,
  candidateAccepted: false,
  predecessor: 'accept-wave1/setup-141/ops/verify-setup-env-contract.mjs sha256 f0a5ca9912eb97fc9fc079a6c7b83f08dc049f460a0924da44557a786fad0e0f',
  note: 'tamandua-48v verifier bump: imports re-pinned to [node:path, ./matchlock/standard-image.js]; fixed-mode contract proof is necessary, not sufficient, for full candidate acceptance',
}, null, 2));
process.exitCode = matched ? 0 : 1;
