#!/usr/bin/env node
// tt-storm-real-gate-battery.mjs — STORM-REAL-PROFILE US-017 gate battery.
//
// US-016 published the REAL profile design and its focused self-tests. US-017
// runs the WHOLE gate battery (build/typecheck, the frozen 49-file storm
// self-test chain under the shared vaivm gate lock with the guard env and the
// harness binaries pinned to /usr/bin/false, the tier-2 consistency suite, the
// focused REAL self-tests, and a SCRIPTED_REHEARSAL prepare regression) and
// records the observed result in the published contract.
//
// This module is the ONE buildable+validatable battery document:
//   * buildStormRealGateBattery(...) is PURE: it shapes the already-collected
//     evidence (the chain summary, the focused self-test totals, the build and
//     typecheck verdicts, the scripted prepare regression) into a document and
//     classifies every chain red against the DOCUMENTED, pre-existing
//     host-environment deviation set. A red that is NOT documented makes the
//     battery FAIL — it can never be waved away as "environment".
//   * validateStormRealGateBattery(...) is PURE and fail-closed: a green
//     verdict with an undeclared red, a wrong lock/guard env, a chain that did
//     not cover all 49 files, a red focused test or a missing/red scripted
//     prepare regression are all refused.
//   * gateResultsForContract(battery) projects the battery into the contract's
//     `gate_results` section (plus a `gate_battery` pointer), and
//     validateGateResults(...) validates that projection inside the contract.
//
// The CLI collects the evidence and writes the standalone battery artifact and
// the contract `--gate-results` JSON. It performs no arming, no approval and
// no launch.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const GATE_BATTERY_KIND = 'storm-real-profile-gate-battery';
export const GATE_BATTERY_SCHEMA_VERSION = 1;

// The published standalone battery artifact (a host path OUTSIDE the repo, so
// writing it never dirties the worktree).
export const GATE_BATTERY_PATH = '/home/kaladin/matchlock-work/storm-real-profile-gate-battery.json';

// The shared gate lock the WHOLE 49-file chain is held under.
export const CHAIN_LOCK_PATH = '/home/kaladin/matchlock-work/vaivm-gate.lock';
// The exact frozen chain selection contract.
export const CHAIN_SELECTION = 'torture-test/self-tests/storm-chain-files.mjs';
export const CHAIN_EXPECTED_FILES = 49;
// The exact guard/harness env every chain child runs under.
export const CHAIN_HARNESS_GUARD_ENV =
  'TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false';
const FALSE_HARNESS = '/usr/bin/false';

// The SCRIPTED_REHEARSAL prepare regression the story requires: prove the
// zero-token path still prepares exactly as before with a REAL-profile module
// set present.
export const SCRIPTED_PREPARE_REGRESSION_COMMAND =
  'TT_VAR=<scratch outside ~/.tamandua> node torture-test/bin/tt-storm prepare --profile SCRIPTED_REHEARSAL --fixture tt-poly';
export const SCRIPTED_PREPARE_REGRESSION_PROFILE = 'SCRIPTED_REHEARSAL';

// The DOCUMENTED, pre-existing host-environment red set. Every one of these is
// reproduced on the integration base commit in this sandbox and is NOT a
// product regression. This list is the ONLY set a green battery may tolerate;
// any other red is a `new_red` and fails the battery.
export const DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATIONS = Object.freeze([
  {
    file: 'torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts',
    reason:
      'the recorder child cannot create the product schema (TT_PRODUCT_DB_UNAVAILABLE) in this host sandbox; the same red reproduces on the base commit',
  },
  {
    file: 'torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts',
    reason: 'daemon-control scripted start cannot verify a fresh private daemon (foreign port contention) in this sandbox; pre-existing',
  },
  {
    file: 'torture-test/self-tests/tier2-storm-rehearsal-park-e2e.test.ts',
    reason: 'daemon-booting e2e (E1 + P2) cannot start its contained daemon in this sandbox; pre-existing',
  },
  {
    file: 'torture-test/self-tests/tier2-storm-rehearsal-rugpull-e2e.test.ts',
    reason: 'daemon-booting e2e (E1) cannot start its contained daemon in this sandbox; pre-existing',
  },
  {
    file: 'torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts',
    reason: 'daemon-booting e2e (E1) cannot start its contained daemon in this sandbox; pre-existing',
  },
]);

export const DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES = Object.freeze(
  DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATIONS.map((d) => d.file),
);

// The focused self-tests whose green result the battery must record: the
// tier-2 rehearsal consistency suite plus every REAL behavior/negative
// self-test (the list is imported by the caller from the contract module so it
// cannot drift; this file keeps only the battery mechanics).
export function documentedDeviationForFile(file) {
  const rel = String(file ?? '').replace(/^\.\//, '');
  return DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATIONS.find((d) => d.file === rel) ?? null;
}

/**
 * Classify the observed chain red files against the documented environment
 * deviation set. Returns the documented files (with their reasons), the NEW
 * reds (a product regression — the battery must fail) and any declared-but-not
 * observed documentation entries.
 */
export function classifyChainRedFiles(redFiles) {
  const observed = [];
  for (const entry of Array.isArray(redFiles) ? redFiles : []) {
    const file = typeof entry === 'string' ? entry : entry?.file;
    if (file && !observed.includes(file)) observed.push(file);
  }
  const documented = [];
  const newReds = [];
  for (const file of observed) {
    const dev = documentedDeviationForFile(file);
    if (dev) documented.push({ file, reason: dev.reason });
    else newReds.push(file);
  }
  const notObserved = DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES.filter((f) => !observed.includes(f));
  return { observed, documented, new_reds: newReds, documented_not_observed: notObserved };
}

function emptyGate(command) {
  return { command, verdict: 'NOT_RUN', note: 'not supplied to the battery builder' };
}

function normalizeGate(gate, command) {
  if (!gate || typeof gate !== 'object') return emptyGate(command);
  // Preserve any gate-specific evidence (e.g. the TEST_CMD lane verdicts) and
  // only fill the shared fields.
  return {
    ...gate,
    command: typeof gate.command === 'string' && gate.command ? gate.command : command,
    verdict: typeof gate.verdict === 'string' && gate.verdict ? gate.verdict : 'NOT_RUN',
    note: typeof gate.note === 'string' ? gate.note : null,
  };
}

function normalizeFocused(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    file: typeof r?.file === 'string' ? r.file : null,
    verdict: typeof r?.verdict === 'string' ? r.verdict : 'NOT_RUN',
    tests: Number.isFinite(r?.tests) ? r.tests : null,
    pass: Number.isFinite(r?.pass) ? r.pass : null,
    fail: Number.isFinite(r?.fail) ? r.fail : null,
    skipped: Number.isFinite(r?.skipped) ? r.skipped : null,
  }));
}

function chainVerdictFor(observedFiles, classification, redCount) {
  if (observedFiles !== CHAIN_EXPECTED_FILES) return 'INCOMPLETE';
  if (classification.new_reds.length > 0) return 'FAIL';
  if (redCount === 0) return 'PASS';
  return 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS';
}

// The chain battery is green only when every non-chain gate passed and the
// chain covered the contract with no new red. A missing chain is NOT_RUN, not
// a silent pass.
function overallVerdictFor({ build, typecheck, focused, scripted, chain }) {
  const gatePass = (g) => g?.verdict === 'PASS';
  const focusedPass = focused.length > 0 && focused.every((f) => f.verdict === 'PASS');
  const failed =
    !gatePass(build) || !gatePass(typecheck) || !focusedPass || !gatePass(scripted) ||
    chain.verdict === 'FAIL' || chain.verdict === 'INCOMPLETE';
  if (failed) return 'FAIL';
  if (chain.verdict === 'NOT_RUN') return 'NOT_RUN';
  if (chain.verdict === 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS') return 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS';
  return 'PASS';
}

/**
 * Build the battery document from already-collected evidence. PURE.
 */
export function buildStormRealGateBattery({
  source,
  recordedAtUtc = null,
  evidenceDir = null,
  chainSummary = null,
  focusedSelfTests = [],
  build = null,
  typecheck = null,
  testCmd = null,
  scriptedPrepareRegression = null,
} = {}) {
  if (!source || typeof source !== 'object') throw new Error('buildStormRealGateBattery requires a source provenance object');
  const buildGate = normalizeGate(build, 'npm run build');
  const typecheckGate = normalizeGate(typecheck, 'npm run build (tsc --noEmit typecheck leg)');
  const focused = normalizeFocused(focusedSelfTests);
  const scripted = normalizeGate(scriptedPrepareRegression, SCRIPTED_PREPARE_REGRESSION_COMMAND);

  const redFiles = Array.isArray(chainSummary?.red_files)
    ? chainSummary.red_files.map((r) => (typeof r === 'string' ? r : r?.file)).filter(Boolean)
    : [];
  const classification = classifyChainRedFiles(redFiles);
  const observedFiles = Number.isFinite(chainSummary?.file_count_observed) ? chainSummary.file_count_observed : null;
  const chain = {
    command:
      chainSummary == null
        ? 'STORM_CHAIN_EVID=<dir> bash torture-test/self-tests/storm-chain-wrapper.sh (frozen 49-file chain under flock --exclusive ' +
          CHAIN_LOCK_PATH +
          ')'
        : `STORM_CHAIN_EVID=${evidenceDir ?? '<dir>'} bash torture-test/self-tests/storm-chain-wrapper.sh (frozen 49-file chain under flock --exclusive ${CHAIN_LOCK_PATH}, ${CHAIN_HARNESS_GUARD_ENV})`,
    verdict: chainSummary == null ? 'NOT_RUN' : chainVerdictFor(observedFiles, classification, redFiles.length),
    evidence_dir: evidenceDir ?? chainSummary?.evidence_dir ?? null,
    head: chainSummary?.head ?? null,
    selection: CHAIN_SELECTION,
    files_expected: CHAIN_EXPECTED_FILES,
    files_observed: observedFiles,
    lock: chainSummary?.lock
      ? { path: chainSummary.lock.path ?? null, held_seconds: chainSummary.lock.held_seconds ?? null, untouched: chainSummary.lock.untouched ?? null }
      : null,
    harness_guard_env: chainSummary?.harness_guard_env ?? null,
    totals: chainSummary?.totals ?? null,
    red_files: redFiles,
    environment_deviations: classification.documented.map((d) => `${d.file}: ${d.reason}`),
    new_reds: classification.new_reds,
    note:
      chainSummary == null
        ? 'no chain summary was supplied; the 49-file chain was not observed by this battery document'
        : 'every red is a documented pre-existing host-environment deviation; the set is compared against the base-commit reproduction',
  };

  const overall = {
    verdict: overallVerdictFor({ build: buildGate, typecheck: typecheckGate, focused, scripted, chain }),
    new_reds: [...classification.new_reds],
    note:
      'PASS requires build+typecheck+focused-self-tests+scripted-prepare-regression green and a 49/49 chain whose only reds are documented host-environment deviations',
  };

  return {
    kind: GATE_BATTERY_KIND,
    schema_version: GATE_BATTERY_SCHEMA_VERSION,
    recorded_at_utc: recordedAtUtc,
    source: {
      branch: source.branch ?? null,
      commit: source.commit ?? null,
      tree: source.tree ?? null,
      tree_dirty: source.tree_dirty ?? null,
    },
    gates: {
      build: buildGate,
      typecheck: typecheckGate,
      test_cmd: normalizeGate(testCmd, 'tamandua-test --repo <repo> --run <run> --step <step> -- npm test'),
      storm_chain: chain,
      focused_self_tests: focused,
      scripted_prepare_regression: scripted,
    },
    chain_classification: {
      observed: classification.observed,
      documented: classification.documented,
      new_reds: classification.new_reds,
      documented_not_observed: classification.documented_not_observed,
    },
    overall,
  };
}

const HEX40 = /^[0-9a-f]{40}$/;

function sameStringSet(a, b) {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Fail-closed validator for a battery document. PURE.
 */
export function validateStormRealGateBattery(battery) {
  const issues = [];
  if (!battery || typeof battery !== 'object') return { ok: false, issues: ['battery is not an object'] };
  if (battery.kind !== GATE_BATTERY_KIND) issues.push(`battery.kind ${JSON.stringify(battery.kind)} != ${GATE_BATTERY_KIND}`);
  if (battery.schema_version !== GATE_BATTERY_SCHEMA_VERSION) issues.push(`battery.schema_version != ${GATE_BATTERY_SCHEMA_VERSION}`);

  const s = battery.source;
  if (!s || typeof s !== 'object') {
    issues.push('battery.source missing/invalid');
  } else {
    if (!HEX40.test(String(s.commit ?? ''))) issues.push('battery.source.commit must be a 40-hex git commit');
    if (!HEX40.test(String(s.tree ?? ''))) issues.push('battery.source.tree must be a 40-hex git tree');
  }

  const g = battery.gates;
  if (!g || typeof g !== 'object') {
    issues.push('battery.gates missing/invalid');
    return { ok: issues.length === 0, issues };
  }
  for (const key of ['build', 'typecheck', 'storm_chain', 'focused_self_tests', 'scripted_prepare_regression']) {
    if (!(key in g)) issues.push(`battery.gates is missing ${key}`);
  }

  const chain = g.storm_chain;
  if (!chain || typeof chain !== 'object') {
    issues.push('battery.gates.storm_chain missing/invalid');
    return { ok: issues.length === 0, issues };
  }
  if (!Array.isArray(chain.red_files)) issues.push('battery.gates.storm_chain.red_files must be an array');
  if (!Array.isArray(chain.new_reds)) issues.push('battery.gates.storm_chain.new_reds must be an array');
  if (chain.files_expected !== CHAIN_EXPECTED_FILES) issues.push(`battery.gates.storm_chain.files_expected must be ${CHAIN_EXPECTED_FILES}`);

  // The documented deviation set is a fixed contract: the battery may not
  // declare a different set.
  const declared = (battery.chain_classification?.documented ?? []).map((d) => d.file);
  if (!sameStringSet(declared, DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES)) {
    issues.push('battery.chain_classification.documented must be exactly the documented host-environment deviation set');
  }

  const overall = battery.overall?.verdict;
  if (!['PASS', 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS', 'FAIL', 'NOT_RUN'].includes(overall)) {
    issues.push(`battery.overall.verdict ${JSON.stringify(overall)} is not a known verdict`);
  }

  const focusedPass = Array.isArray(g.focused_self_tests) && g.focused_self_tests.length > 0 && g.focused_self_tests.every((f) => f.verdict === 'PASS');

  if (overall === 'PASS' || overall === 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS') {
    if (g.build?.verdict !== 'PASS') issues.push('a green battery requires build PASS');
    if (g.typecheck?.verdict !== 'PASS') issues.push('a green battery requires typecheck PASS');
    if (!focusedPass) issues.push('a green battery requires every focused self-test PASS');
    if (g.scripted_prepare_regression?.verdict !== 'PASS') issues.push('a green battery requires the SCRIPTED_REHEARSAL prepare regression PASS');
    if (chain.files_observed !== CHAIN_EXPECTED_FILES) issues.push('a green battery requires the chain to observe all 49 files');
    if (chain.lock?.path !== CHAIN_LOCK_PATH) issues.push(`a green battery requires the chain lock ${CHAIN_LOCK_PATH}`);
    if (chain.harness_guard_env !== CHAIN_HARNESS_GUARD_ENV) issues.push('a green battery requires the frozen guard/harness env');
    if ((chain.new_reds ?? []).length > 0) issues.push('a green battery may not carry a new red');
    const undeclared = (chain.red_files ?? []).filter((f) => !DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES.includes(f));
    if (undeclared.length > 0) issues.push(`a green battery may not carry an undeclared red: ${undeclared.join(', ')}`);
    if (chain.verdict === 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS' && (chain.red_files ?? []).length === 0) {
      issues.push('a PASS_WITH_DOCUMENTED_ENV_DEVIATIONS chain must carry at least one documented red');
    }
    if (chain.verdict === 'PASS' && (chain.red_files ?? []).length !== 0) {
      issues.push('a PASS chain must carry no red files');
    }
  }

  if (overall === 'FAIL' && (chain.new_reds ?? []).length === 0 && g.build?.verdict !== 'FAIL' && g.typecheck?.verdict !== 'FAIL' && focusedPass && g.scripted_prepare_regression?.verdict === 'PASS') {
    const chainFails = chain.verdict === 'FAIL' || chain.verdict === 'INCOMPLETE';
    if (!chainFails) issues.push('a FAIL battery must name a failed gate or a new red');
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Project a validated battery into the contract's `gate_results` section. PURE.
 * `batteryPath`/`batterySha256` point at the retained standalone artifact so a
 * reader can recover the full evidence.
 */
export function gateResultsForContract(battery, { batteryPath = GATE_BATTERY_PATH, batterySha256 = null } = {}) {
  const g = battery?.gates ?? {};
  const chain = g.storm_chain ?? {};
  return {
    build: g.build,
    typecheck: g.typecheck,
    test_cmd: g.test_cmd,
    storm_chain: {
      command: chain.command,
      verdict: chain.verdict,
      evidence_dir: chain.evidence_dir,
      head: chain.head,
      selection: chain.selection,
      files_expected: chain.files_expected,
      files_observed: chain.files_observed,
      lock: chain.lock,
      harness_guard_env: chain.harness_guard_env,
      totals: chain.totals,
      red_files: chain.red_files,
      environment_deviations: chain.environment_deviations,
      new_reds: chain.new_reds,
      note: chain.note,
    },
    focused_self_tests: g.focused_self_tests,
    scripted_prepare_regression: g.scripted_prepare_regression,
    gate_battery: {
      kind: battery.kind,
      schema_version: battery.schema_version,
      path: batteryPath,
      sha256: batterySha256,
      overall_verdict: battery.overall?.verdict ?? null,
      new_reds: battery.overall?.new_reds ?? [],
    },
    overall: battery.overall,
  };
}

/**
 * Fail-closed validator for the contract's `gate_results` projection. PURE.
 */
export function validateGateResults(gateResults) {
  const issues = [];
  if (!gateResults || typeof gateResults !== 'object') return { ok: false, issues: ['gate_results is not an object'] };
  for (const key of ['build', 'typecheck', 'test_cmd', 'storm_chain', 'focused_self_tests', 'scripted_prepare_regression', 'gate_battery', 'overall']) {
    if (!(key in gateResults)) issues.push(`gate_results is missing ${key}`);
  }
  const chain = gateResults.storm_chain;
  if (chain && typeof chain === 'object') {
    if (chain.files_expected !== CHAIN_EXPECTED_FILES) issues.push(`gate_results.storm_chain.files_expected must be ${CHAIN_EXPECTED_FILES}`);
    const reds = Array.isArray(chain.red_files) ? chain.red_files : null;
    if (!reds) issues.push('gate_results.storm_chain.red_files must be an array');
    else {
      const undeclared = reds.filter((f) => !DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES.includes(f));
      if (undeclared.length > 0) issues.push(`gate_results.storm_chain carries an undeclared red: ${undeclared.join(', ')}`);
    }
    if (!Array.isArray(chain.new_reds) || chain.new_reds.length > 0) issues.push('gate_results.storm_chain.new_reds must be empty');
    if (chain.lock?.path !== CHAIN_LOCK_PATH) issues.push(`gate_results.storm_chain.lock.path must be ${CHAIN_LOCK_PATH}`);
    if (chain.harness_guard_env !== CHAIN_HARNESS_GUARD_ENV) issues.push('gate_results.storm_chain.harness_guard_env must be the frozen guard/harness env');
  } else {
    issues.push('gate_results.storm_chain missing/invalid');
  }
  if (!Array.isArray(gateResults.focused_self_tests) || gateResults.focused_self_tests.length === 0) {
    issues.push('gate_results.focused_self_tests must list the observed focused tests');
  } else if (!gateResults.focused_self_tests.every((f) => f.verdict === 'PASS')) {
    issues.push('gate_results.focused_self_tests must all be PASS');
  }
  if (gateResults.scripted_prepare_regression?.verdict !== 'PASS') {
    issues.push('gate_results.scripted_prepare_regression must be PASS');
  }
  if (!['PASS', 'PASS_WITH_DOCUMENTED_ENV_DEVIATIONS'].includes(gateResults.overall?.verdict)) {
    issues.push(`gate_results.overall.verdict must be a green verdict (got ${JSON.stringify(gateResults.overall?.verdict)})`);
  }
  return { ok: issues.length === 0, issues };
}

// ─────────────────────────────────────────────────────────────────────
// Evidence collection + CLI.
// ─────────────────────────────────────────────────────────────────────

/** Parse node:test totals from a `node --test` log. PURE. */
export function parseNodeTestTotals(text) {
  const out = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(?:[^A-Za-z0-9#\s]\s*)?#?\s*(tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Run one `node --test <file>` and record its verdict. */
export function runFocusedSelfTest(rel, { repoRoot = process.cwd(), env = process.env, timeoutMs = 30 * 60 * 1000 } = {}) {
  const childEnv = { ...env, TAMANDUA_TEST_GUARD: '1', TAMANDUA_PI_BINARY: FALSE_HARNESS, TAMANDUA_HERMES_BINARY: FALSE_HARNESS, TAMANDUA_DSH_BINARY: FALSE_HARNESS };
  const res = spawnSync(process.execPath, ['--test', rel], { cwd: repoRoot, env: childEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const totals = parseNodeTestTotals(output);
  return {
    file: rel,
    verdict: res.status === 0 ? 'PASS' : 'FAIL',
    tests: totals.tests,
    pass: totals.pass,
    fail: totals.fail,
    skipped: totals.skipped,
    exit_code: res.status,
  };
}

export function gitProvenance(repoRoot, { runner = null } = {}) {
  const run = runner ?? ((args) => {
    try {
      return {
        ok: true,
        stdout: execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      };
    } catch (err) {
      return { ok: false, stdout: '', error: err?.message ?? String(err) };
    }
  });
  const head = run(['rev-parse', 'HEAD']);
  const tree = run(['rev-parse', 'HEAD^{tree}']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  const commit = head.ok ? String(head.stdout).trim() : null;
  const treeSha = tree.ok ? String(tree.stdout).trim() : null;
  const porcelain = status.ok ? String(status.stdout).trimEnd() : null;
  return {
    branch: branch.ok ? String(branch.stdout).trim() : null,
    commit: HEX40.test(commit ?? '') ? commit : null,
    tree: HEX40.test(treeSha ?? '') ? treeSha : null,
    tree_dirty: porcelain === null ? null : porcelain !== '',
  };
}

function readJsonIfPresent(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(outPath, value) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(outPath, body);
  return { file: outPath, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

// CLI:
//   node torture-test/bin/tt-storm-real-gate-battery.mjs \
//     --repo <dir> --chain-summary <json> --focused-results <json> \
//     --scripted-regression <json> --build-verdict PASS --typecheck-verdict PASS \
//     [--test-cmd <json>] [--evidence-dir <dir>] [--out <battery.json>] \
//     [--contract-gate-results <gate-results.json>]
export function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') opts.repo = next();
    else if (a === '--chain-summary') opts.chainSummary = next();
    else if (a === '--focused-results') opts.focusedResults = next();
    else if (a === '--scripted-regression') opts.scriptedRegression = next();
    else if (a === '--build-verdict') opts.buildVerdict = next();
    else if (a === '--typecheck-verdict') opts.typecheckVerdict = next();
    else if (a === '--test-cmd') opts.testCmd = next();
    else if (a === '--evidence-dir') opts.evidenceDir = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--contract-gate-results') opts.contractGateResults = next();
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: tt-storm-real-gate-battery [--repo <dir>] [--chain-summary <json>] [--focused-results <json>] ' +
          '[--scripted-regression <json>] [--build-verdict V] [--typecheck-verdict V] [--test-cmd <json>] ' +
          '[--evidence-dir <dir>] [--out <battery.json>] [--contract-gate-results <json>]\n',
      );
      return 0;
    }
  }
  const repoRoot = path.resolve(opts.repo ?? process.cwd());
  const source = gitProvenance(repoRoot);
  if (!source.commit || !source.tree) {
    process.stderr.write(`cannot resolve git provenance in ${repoRoot}\n`);
    return 1;
  }
  const battery = buildStormRealGateBattery({
    source,
    recordedAtUtc: new Date().toISOString(),
    evidenceDir: opts.evidenceDir ?? null,
    chainSummary: readJsonIfPresent(opts.chainSummary),
    focusedSelfTests: readJsonIfPresent(opts.focusedResults) ?? [],
    build: { command: 'npm run build', verdict: opts.buildVerdict ?? 'NOT_RUN' },
    typecheck: { command: 'npm run build (tsc --noEmit typecheck leg)', verdict: opts.typecheckVerdict ?? 'NOT_RUN' },
    testCmd: readJsonIfPresent(opts.testCmd),
    scriptedPrepareRegression: readJsonIfPresent(opts.scriptedRegression),
  });
  const verdict = validateStormRealGateBattery(battery);
  if (!verdict.ok) {
    process.stderr.write(`gate battery INVALID:\n${verdict.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }
  const written = writeJson(opts.out ?? GATE_BATTERY_PATH, battery);
  process.stdout.write(`Storm-real-profile gate battery: ${written.file}\n`);
  process.stdout.write(`  sha256: ${written.sha256}\n`);
  process.stdout.write(`  overall: ${battery.overall.verdict} new_reds=${battery.overall.new_reds.length}\n`);
  if (opts.contractGateResults) {
    const gateResults = gateResultsForContract(battery, { batteryPath: written.file, batterySha256: written.sha256 });
    const writtenGates = writeJson(opts.contractGateResults, gateResults);
    process.stdout.write(`  contract gate_results: ${writtenGates.file}\n`);
  }
  return battery.overall.verdict === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}