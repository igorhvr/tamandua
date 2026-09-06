#!/usr/bin/env node
// tt-golden-bootstrap.mjs — deterministic idempotent golden bare bootstrap
//
// US-002 (E2.3). The provisioning stage needs var/fixtures/golden/<fixture>.git
// but the pipelined torture-test never builds it: goldens were only ever
// produced by manual build-golden.sh runs. This module is the single,
// fail-closed bootstrap for a golden bare:
//
//   * absent golden  -> run fixtures-src/<fixture>/build-golden.sh to create it
//                       (deterministic, byte-stable hashes), then verify the
//                       freshly-produced bare against its own recorded hash file;
//   * present golden -> verify it is a VALID bare git repo containing the exact
//                       refs its recorded hash file claims (seeds + baseline
//                       branch) AND whose recorded fixtures-src content hash
//                       (S57, R4a) still matches the CURRENT fixtures-src tree,
//                       and no-op if so (idempotent);
//   * --rebuild-invalid -> a PRESENT but invalid golden (missing/malformed hash
//                       ledger, ref mismatch, non-bare, or a FIXTURES_SRC record
//                       that no longer matches the fixture source — drift) is
//                       REBUILT from scratch with a loud per-asset note naming
//                       the defect instead of failing closed. A VALID golden is
//                       never rebuilt (no-op). Default (no flag) stays
//                       fail-closed, never silent;
//   * any failure    -> returns a precise TEST_INFRA reason (fail-closed). A
//                       healthy host must never hit these; a missing or malformed
//                       golden is NEVER a silent half-launch.
//
// S57 (R4a): the .hashes ledger (written by each fixtures-src/<fixture>/
// build-golden.sh, canonicalised by FIXTURE_META.hashFile) records a
// `FIXTURES_SRC` CONTENT hash over the fixture source tree the golden was
// built from (see hashFixtureSourceDir). Golden VALIDITY requires that record
// to match the current fixtures-src content — drift between the golden tree
// and its source invalidates the golden (fail-closed, naming the drifted
// fixture; rebuilt under --rebuild-invalid).
//
// This is a standalone, importable module AND a thin CLI. The controller's
// real-case launch path (US-004) imports `ensureGoldenBare` / `verifyGoldenBare`
// directly; self-tests invoke the CLI to exercise the fail-closed gate.
// Fixture builders invoke `--hash-fixtures-src-dir <dir>` so the recorded
// FIXTURES_SRC value is computed by the SAME canonical function the verifiers
// use (never a second shell implementation that could drift).
//
// Files only inside torture-test/.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const BIN_DIR = path.dirname(__filename);
export const TT_ROOT = path.resolve(BIN_DIR, '..');
export const DEFAULT_GOLDEN_DIR = path.join(TT_ROOT, 'var', 'fixtures', 'golden');
// Fixture SOURCE root: <TT_ROOT>/fixtures-src holds the seeded fixture trees
// (fixtures-src/<fixture>) that the golden bares are deterministically built
// from. S57 (R4a): golden validity now includes a fixtures-src CONTENT hash,
// so a drifted source invalidates its golden instead of passing silently.
export const DEFAULT_FIXTURES_SRC_DIR = path.join(TT_ROOT, 'fixtures-src');
// The ledger record key: every <name>.git.hashes ledger carries one
// `FIXTURES_SRC <sha256>` (tag-format builders) / `FIXTURES_SRC=<sha256>`
// (branch-format builders) line naming the source content the golden was
// built from. tt-verify-fixture-baselines special-cases this key BEFORE the
// generic ref resolution (the 64-hex sha256 is never a git ref).
export const FIXTURES_SRC_KEY = 'FIXTURES_SRC';

// ── Per-fixture build metadata ──────────────────────────────────────────
// `buildScript` is the fixture's deterministic golden builder; `bareName` is
// the bare directory it produces; `hashFile` is the byte-stable hash ledger it
// writes; `baselineBranch` is the named current branch a fresh clone lands on
// (main for every fixture, master for the tt-python@master variant) — real
// merge workflows need a real current branch as their merge target, never a
// detached HEAD.
export const FIXTURE_META = Object.freeze({
  'tt-go': Object.freeze({
    buildScript: 'fixtures-src/tt-go/build-golden.sh',
    bareName: 'tt-go.git',
    hashFile: 'tt-go.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-go',
  }),
  'tt-java': Object.freeze({
    buildScript: 'fixtures-src/tt-java/build-golden.sh',
    bareName: 'tt-java.git',
    hashFile: 'tt-java.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-java',
  }),
  'tt-poly': Object.freeze({
    buildScript: 'fixtures-src/tt-poly/build-golden.sh',
    bareName: 'tt-poly.git',
    hashFile: 'tt-poly.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-poly',
  }),
  'tt-poly-lite': Object.freeze({
    buildScript: 'fixtures-src/tt-poly-lite/build-golden.sh',
    bareName: 'tt-poly-lite.git',
    hashFile: 'tt-poly-lite.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-poly-lite',
  }),
  'tt-python': Object.freeze({
    buildScript: 'fixtures-src/tt-python/build-golden.sh',
    bareName: 'tt-python.git',
    hashFile: 'tt-python.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-python',
  }),
  'tt-python@master': Object.freeze({
    buildScript: 'fixtures-src/tt-python@master/build-golden.sh',
    bareName: 'tt-python@master.git',
    hashFile: '.build-hashes-tt-python-master',
    baselineBranch: 'master',
    // The master variant REUSES the shared tt-python source tree (its
    // builder sets FIXTURE_SRC=../tt-python) — so the fixtures-src content
    // hash is computed over fixtures-src/tt-python, never a phantom source.
    srcDir: 'tt-python',
  }),
  'tt-rust': Object.freeze({
    buildScript: 'fixtures-src/tt-rust/build-golden.sh',
    bareName: 'tt-rust.git',
    hashFile: 'tt-rust.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-rust',
  }),
  'tt-ts': Object.freeze({
    buildScript: 'fixtures-src/tt-ts/build-golden.sh',
    bareName: 'tt-ts.git',
    hashFile: 'tt-ts.git.hashes',
    baselineBranch: 'main',
    srcDir: 'tt-ts',
  }),
});

// All golden fixtures the bootstrap is willing to build/verify.
export const KNOWN_FIXTURES = Object.freeze(Object.keys(FIXTURE_META).sort());

// Strip tamandua test-isolation vars from any child process we spawn so that
// fixture builders (which run npm test / pytest / cargo test internally) do not
// trip the TEST ISOLATION GUARD when the bootstrap runs inside node:test.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  return env;
}

function refReason(category, message, extra = {}) {
  return { ok: false, reason: { category, message, ...extra } };
}

// Combine a command's stdout and stderr into a single diagnostic stream and
// return the last `n` lines (newest last). Never prefers one stream over the
// other: the old code preferred stderr over stdout (`stderr || stdout`), which
// dropped every line of stdout whenever stderr carried even one byte, hiding
// mvnw/build tails written to stdout (build-golden.sh captures `./mvnw ... 2>&1`,
// so its failure tail arrives on stdout while its progress banner may touch stderr).
export function failureTail(stdout, stderr, n) {
  const parts = [String(stdout ?? ''), String(stderr ?? '')].filter((s) => s.length > 0);
  return parts.join('\n').split(/\r?\n/).slice(-n);
}

function fixtureMetaOrReason(fixture, goldenDir) {
  if (typeof fixture !== 'string' || fixture === '') {
    return refReason('golden-fixture-unspecified', 'a --fixture name is required');
  }
  const meta = FIXTURE_META[fixture];
  if (meta === undefined) {
    return refReason('unknown-fixture', `no golden metadata for fixture '${fixture}'`, {
      fixture,
      known: KNOWN_FIXTURES,
    });
  }
  const buildScriptPath = path.join(TT_ROOT, meta.buildScript);
  if (!fs.existsSync(buildScriptPath)) {
    return refReason('golden-fixture-build-script-missing', `fixture build script missing`, {
      fixture,
      buildScript: buildScriptPath,
    });
  }
  const resolvedGoldenDir = goldenDir === undefined ? DEFAULT_GOLDEN_DIR : path.resolve(goldenDir);
  return {
    ok: true,
    fixture,
    goldenDir: resolvedGoldenDir,
    buildScriptPath,
    barePath: path.join(resolvedGoldenDir, meta.bareName),
    hashFilePath: path.join(resolvedGoldenDir, meta.hashFile),
    baselineBranch: meta.baselineBranch,
    // The fixture SOURCE tree the golden is built from (S57): a directory
    // NAME relative to <TT_ROOT>/fixtures-src so hermetic tool trees (a
    // scratch checkout holding bin/ + fixtures-src/) resolve it against
    // their own root.
    sourceDir: path.join(DEFAULT_FIXTURES_SRC_DIR, meta.srcDir),
  };
}

// ── Canonical fixtures-src content hash (S57) ──────────────────────────
// Basename/dirname exclusions: the fixture builders never commit these into
// the golden bare (every builder excludes build-golden.sh + operator-notes.
// local; generated junk names are excluded by the language-specific builders
// and are never tracked fixture content), so edits to them cannot drift the
// golden and must NOT invalidate it. The hash therefore covers exactly the
// file set a deterministic rebuild reproduces in the golden work tree.
const FIXTURES_SRC_EXCLUDED_FILES = new Set([
  'build-golden.sh', // the builder itself — editing it must not invalidate goldens
  'operator-notes.local', // provisioning-only reference (spec 02); never in the golden
  'package-lock.json', // generated per-install; never committed
  '.flaky_counter', // pytest-flaky counter junk
  '.git', // never part of fixture content (defensive)
]);
const FIXTURES_SRC_EXCLUDED_DIRS = new Set([
  '.venv',
  '.mypy_cache',
  '.pytest_cache',
  '__pycache__', // holds only the seeded synthetic junk-probe marker (provisioning ref, excluded by builders)
  'node_modules',
  'dist',
  'target',
  'b', // go build dir (tt-go builder excludes b/)
]);

/** Deterministic sha256 over the fixture source tree: for every included
 *  regular file (sorted by POSIX relative path) hash path + NUL + bytes
 *  (+ NUL); symlinks hash their link target string (rsync -a preserves
 *  symlinks, git stores the target as the blob). Byte-identical trees at
 *  any absolute location produce the same 64-hex digest, so a hermetic
 *  scratch source copy hashes identically to the real fixtures-src tree.
 *  Throws if the source dir is missing/unreadable. */
export function hashFixtureSourceDir(sourceDir) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot enumerate fixture source ${dir}: ${error.message}`);
    }
    for (const entry of entries) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (FIXTURES_SRC_EXCLUDED_FILES.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (FIXTURES_SRC_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relPath);
      }
      // Other entry types (sockets, devices) are ignored — none exist in
      // fixture content and none are reproducible by a builder.
    }
  };
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`fixture source dir does not exist: ${sourceDir}`);
  }
  walk(sourceDir, '');
  files.sort();
  const digest = createHash('sha256');
  for (const rel of files) {
    const full = path.join(sourceDir, rel);
    let content;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      content = fs.readlinkSync(full);
    } else {
      content = fs.readFileSync(full);
    }
    digest.update(rel);
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return digest.digest('hex');
}

// Parse a fixture hash ledger into { expected: Map<ref,hash>, baselineHash,
// fixturesSrcHash }. Two ledger formats exist across fixtures (space-delimited
// for the tag-based builders, key=value for the branch-based builders); both
// are normalised here. S57: the ledger ALSO carries one FIXTURES_SRC record
// (space or '=' separated) naming the sha256 of the fixtures-src content the
// golden was built from; unknown lines (comments, diagnostics) are ignored.
export function parseHashFile(content) {
  const expected = new Map();
  let baselineHash = null;
  let fixturesSrcHash = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    let m;
    if ((m = /^SEED\s+(\S+)\s+([0-9a-f]{40})$/.exec(line))) {
      expected.set(`refs/tags/seed/${m[1]}`, m[2]);
    } else if ((m = /^BRANCH\s+(\S+)\s+([0-9a-f]{40})$/.exec(line))) {
      expected.set(`refs/heads/${m[1]}`, m[2]);
    } else if ((m = /^BASELINE\s+([0-9a-f]{40})$/.exec(line))) {
      baselineHash = m[1];
    } else if ((m = /^seed\/(\S+)=([0-9a-f]{40})$/.exec(line))) {
      expected.set(`refs/heads/seed/${m[1]}`, m[2]);
    } else if ((m = /^baseline=([0-9a-f]{40})$/.exec(line))) {
      baselineHash = m[1];
    } else if ((m = /^FIXTURES_SRC[=\s]+([0-9a-f]{64})$/.exec(line))) {
      fixturesSrcHash = m[1];
    }
    // Other ledger lines (comments, diagnostics) are ignored.
  }
  return { expected, baselineHash, fixturesSrcHash };
}

function gitRevParse(barePath, ref, cwd) {
  const res = spawnSync('git', ['--git-dir', barePath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: cwd ?? TT_ROOT,
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? '').trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

function isBareRepo(barePath) {
  if (!fs.statSync(barePath, { throwIfNoEntry: false })?.isDirectory()) return false;
  const res = spawnSync('git', ['--git-dir', barePath, 'rev-parse', '--is-bare-repository'], {
    cwd: TT_ROOT,
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return res.status === 0 && String(res.stdout ?? '').trim() === 'true';
}

function verifyBareAgainstLedger({ fixture, barePath, hashFilePath, baselineBranch, sourceDir }) {
  if (!fs.existsSync(hashFilePath)) {
    return refReason('golden-hash-file-missing', 'golden present but its hash ledger is missing', {
      fixture, hashFile: hashFilePath, bare: barePath,
    });
  }
  let ledger;
  try {
    ledger = fs.readFileSync(hashFilePath, 'utf8');
  } catch (error) {
    return refReason('golden-hash-file-unreadable', 'could not read golden hash ledger', {
      fixture, hashFile: hashFilePath, error: error.message,
    });
  }
  const { expected, baselineHash, fixturesSrcHash } = parseHashFile(ledger);
  if (baselineHash === null || expected.size === 0) {
    return refReason('golden-hash-file-malformed', 'hash ledger has no baseline or no seed/ref entries', {
      fixture, hashFile: hashFilePath,
    });
  }

  if (!isBareRepo(barePath)) {
    return refReason('golden-not-bare-repo', 'path exists but is not a valid bare git repository', {
      fixture, bare: barePath,
    });
  }

  const verifiedRefs = [];
  for (const [ref, recordedHash] of expected) {
    const actual = gitRevParse(barePath, ref);
    if (actual === null) {
      return refReason('golden-ref-missing', `golden is missing an expected ref`, {
        fixture, ref, expected: recordedHash, bare: barePath,
      });
    }
    if (actual !== recordedHash) {
      return refReason('golden-ref-mismatch', `golden ref does not match recorded hash`, {
        fixture, ref, expected: recordedHash, actual, bare: barePath,
      });
    }
    verifiedRefs.push({ ref, hash: actual });
  }

  // Fixture baseline branch must be a real current branch pointing at the
  // recorded green baseline — real merge workflows need a non-detached HEAD.
  const baselineRef = `refs/heads/${baselineBranch}`;
  const baselineActual = gitRevParse(barePath, baselineRef);
  if (baselineActual === null) {
    return refReason('golden-baseline-branch-missing', `golden is missing its baseline branch`, {
      fixture, branch: baselineBranch, expected: baselineHash, bare: barePath,
    });
  }
  if (baselineActual !== baselineHash) {
    return refReason('golden-baseline-branch-mismatch', `baseline branch does not point at recorded baseline`, {
      fixture, branch: baselineBranch, expected: baselineHash, actual: baselineActual, bare: barePath,
    });
  }

  // S57 (R4a): the .hashes ledger must record the fixtures-src CONTENT hash
  // the golden was built from, and that record must match the CURRENT
  // fixtures-src tree. Drift between the golden tree and its source makes
  // the golden INVALID — fail-closed here (a --rebuild-invalid caller
  // rebuilds from the drifted source), always naming the drifted fixture.
  if (sourceDir === undefined) {
    return refReason('golden-fixtures-src-unresolved', 'fixture metadata carries no fixtures-src source dir', {
      fixture, hashFile: hashFilePath,
    });
  }
  if (!fs.existsSync(sourceDir)) {
    return refReason('golden-fixtures-src-missing', 'fixture source dir for this golden is missing', {
      fixture, source: sourceDir, hashFile: hashFilePath,
    });
  }
  let currentSourceHash;
  try {
    currentSourceHash = hashFixtureSourceDir(sourceDir);
  } catch (error) {
    return refReason('golden-fixtures-src-unreadable', 'could not hash the current fixture source', {
      fixture, source: sourceDir, error: error.message,
    });
  }
  if (fixturesSrcHash === null) {
    return refReason(
      'golden-fixtures-src-record-missing',
      'golden hash ledger records no fixtures-src content hash (pre-S57 ledger) — rebuild the golden to record FIXTURES_SRC',
      { fixture, source: sourceDir, hashFile: hashFilePath, current: currentSourceHash },
    );
  }
  if (fixturesSrcHash !== currentSourceHash) {
    return refReason(
      'golden-fixtures-src-drift',
      `golden was built from different fixtures-src content than the current tree (fixtures-src drift)`,
      {
        fixture,
        source: sourceDir,
        hashFile: hashFilePath,
        recorded: fixturesSrcHash,
        current: currentSourceHash,
      },
    );
  }

  return {
    ok: true,
    fixture,
    barePath,
    hashFilePath,
    baselineHash,
    baselineBranch,
    sourceDir,
    fixturesSrcHash: currentSourceHash,
    verifiedRefs,
  };
}

// Verify a PRESENT golden in place. Never rebuilds; fail-closed on any defect.
export function verifyGoldenBare({ fixture, goldenDir }) {
  const resolved = fixtureMetaOrReason(fixture, goldenDir);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.barePath)) {
    return refReason('golden-bare-missing', 'golden bare does not exist', {
      fixture, bare: resolved.barePath,
    });
  }
  return verifyBareAgainstLedger(resolved);
}

// Build a golden bare from its fixture source via build-golden.sh, then verify
// the freshly-produced result. Fail-closed on build failure or a bad result.
function buildGoldenBare({ fixture, barePath, hashFilePath, buildScriptPath, baselineBranch, sourceDir }) {
  const res = spawnSync('bash', [buildScriptPath], {
    cwd: TT_ROOT,
    env: { ...cleanEnv(), TORTURE_GOLDEN_DIR: path.dirname(barePath) },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30 * 60_000,
  });
  if (res.status !== 0) {
    return refReason('golden-build-failed', 'build-golden.sh exited non-zero', {
      fixture,
      buildScript: buildScriptPath,
      exit_code: res.status,
      signal: res.signal ?? null,
      tail: failureTail(res.stdout, res.stderr, 20),
    });
  }
  if (!fs.existsSync(barePath)) {
    return refReason('golden-bare-missing-after-build', 'build finished but no bare repo was produced', {
      fixture, buildScript: buildScriptPath, bare: barePath,
    });
  }
  const verified = verifyBareAgainstLedger({ fixture, barePath, hashFilePath, baselineBranch, sourceDir });
  if (!verified.ok) {
    return { ...verified, reason: { ...verified.reason, built: true, build_tail: failureTail(res.stdout, res.stderr, 8) } };
  }
  return { ...verified, built: true };
}

// Idempotent bootstrap gate.
//   absent golden        -> build it, verify, fail-closed if anything is wrong;
//   present golden       -> verify (idempotent no-op when valid, fail-closed when not);
//   force:true           -> rebuild from scratch regardless of current state;
//   rebuildInvalid:true  -> a PRESENT but invalid golden (verify failed) is rebuilt
//                           from scratch with a loud per-asset note naming the
//                           defect (`rebuiltInvalid:true` + `invalidReason` in the
//                           verdict) instead of failing closed. A VALID golden is
//                           NEVER rebuilt — healthy goldens stay a no-op even with
//                           the flag. Default (absent) keeps fail-closed behavior
//                           byte-identical to the no-flag path.
export function ensureGoldenBare({ fixture, goldenDir, force = false, rebuildInvalid = false }) {
  const resolved = fixtureMetaOrReason(fixture, goldenDir);
  if (!resolved.ok) return resolved;

  const present = fs.existsSync(resolved.barePath);
  if (present && !force) {
    const verified = verifyGoldenBare({ fixture, goldenDir: resolved.goldenDir });
    if (!verified.ok) {
      if (!rebuildInvalid) return verified; // fail-closed, never silently rebuild
      // --rebuild-invalid self-heal: the golden is present but stale/partial.
      // Rebuild from scratch and report the per-asset defect loudly — the note
      // and invalidReason are part of the verdict, never a silent rebuild.
      const defect = verified.reason;
      // S57 (R4a) drift rebuild: when the defect is fixtures-src drift (or any
      // stale-ledger shape), the recorded ledger is stale BY DEFINITION — the
      // builder would otherwise fail its deterministic re-run compare (fresh
      // source => fresh ref hashes AND a fresh FIXTURES_SRC record) instead of
      // recording the new state. Drop the stale ledger before rebuilding so the
      // builder takes its first-build branch; the post-build verify re-checks
      // the fresh record against the current source.
      fs.rmSync(resolved.hashFilePath, { force: true });
      const buildResult = buildGoldenBare(resolved);
      if (!buildResult.ok) return buildResult;
      return {
        ...buildResult,
        built: true,
        rebuiltInvalid: true,
        invalidReason: defect.category,
        invalidMessage: defect.message,
        note: `REBUILT-INVALID: golden '${fixture}' was present but invalid (defect: ${defect.category} — ${defect.message}); rebuilt from scratch`,
      };
    }
    return { ...verified, built: false };
  }

  // Absent, hash-missing-but-bare-present, or force: (re)build from scratch.
  const buildResult = buildGoldenBare(resolved);
  if (!buildResult.ok) return buildResult;
  return { ...buildResult, built: true, scavenged: present && !force };
}

// ── CLI entry ───────────────────────────────────────────────────────────
function usage() {
  const out = [
    `Usage: tt-golden-bootstrap --fixture <name> [options]`,
    ``,
    `Deterministic idempotent golden bare bootstrap (fail-closed).`,
    ``,
    `Options:`,
    `  --fixture <name>   Golden fixture to build/verify (e.g. tt-python).`,
    `  --golden-dir <dir> Override the golden output dir (default:`, `                     torture-test/var/fixtures/golden).`,
    `  --force            Rebuild the golden from scratch even if present.`,
    `  --rebuild-invalid  Rebuild a PRESENT but invalid golden from scratch (e.g.`,
    `                     missing/malformed hash ledger, ref mismatch, non-bare,`,
    `                     or fixtures-src drift: the FIXTURES_SRC record no longer`,
    `                     matches the current fixture source — S57) with a loud`,
    `                     per-asset note naming the defect; a VALID golden is`,
    `                     never rebuilt (no-op). Default: fail-closed.`,
    `  --hash-fixtures-src-dir <dir>`,
    `                     Compute and print the canonical sha256 content hash of`,
    `                     a fixture source dir (S57). Invoked by the fixture`,
    `                     builders so the ledger's FIXTURES_SRC record is`,
    `                     computed by the same function the verifiers use.`,
    `  --json             Emit the JSON verdict on stdout (default).`,
    `  --help, -h         Print this help and exit.`,
    ``,
    `Known fixtures: ${KNOWN_FIXTURES.join(', ')}.`,
    ``,
    `Exit codes: 0 = golden OK / hash printed; 1 = fail-closed TEST_INFRA defect; 2 = usage error.`,
  ];
  return out.join('\n');
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function runCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  // S57 builder helper mode: `--hash-fixtures-src-dir <dir>` prints the
  // canonical sha256 of the given fixture source dir (used by the fixture
  // build-golden.sh scripts to record FIXTURES_SRC). Standalone — never
  // requires --fixture.
  const hashArgIdx = argv.indexOf('--hash-fixtures-src-dir');
  if (hashArgIdx !== -1) {
    const dir = argv[hashArgIdx + 1];
    if (!dir || dir.startsWith('-')) {
      printJson({ ok: false, usage_error: '--hash-fixtures-src-dir requires a directory path', hint: usage().split('\n')[0] });
      return 2;
    }
    try {
      const hex = hashFixtureSourceDir(path.resolve(dir));
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`hash computed to an unexpected shape: ${hex}`);
      process.stdout.write(`${hex}\n`);
      return 0;
    } catch (error) {
      printJson({ ok: false, usage_error: `cannot hash fixture source dir '${dir}': ${error.message}`, hint: usage().split('\n')[0] });
      return 2;
    }
  }
  let fixture;
  let goldenDir;
  let force = false;
  let rebuildInvalid = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') {
      fixture = argv[++i];
    } else if (arg === '--golden-dir') {
      goldenDir = argv[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--rebuild-invalid') {
      rebuildInvalid = true;
    } else if (arg === '--json') {
      // default; accepted for explicitness
    } else {
      printJson({ ok: false, usage_error: `unknown option: ${arg}`, hint: usage().split('\n')[0] });
      return 2;
    }
  }
  if (fixture === undefined) {
    printJson({ ok: false, usage_error: '--fixture is required', hint: usage().split('\n')[0] });
    return 2;
  }
  const result = ensureGoldenBare({ fixture, goldenDir, force, rebuildInvalid });
  printJson(result);
  return result.ok ? 0 : 1;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
