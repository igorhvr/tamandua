#!/usr/bin/env node
// tt-fixture-provision.mjs — fixture work-clone provisioning adapter
//
// US-003 (E2.3). The controller's real-case launch path passes
// `var/fixtures/work/<case-id>/<fixture>` as --worktree-origin-repository /
// --working-directory-for-harness, but NOTHING created that working clone —
// the E2.2 argv-recording proof never lstats the path, so the first genuine
// real launch went terminal TEST_INFRA_FAIL with ENOENT. This module is the
// standalone, fail-closed adapter that provisions a pristine working clone.
//
// Given a golden bare (verified via tt-golden-bootstrap), a case's work dir,
// and seed-or-baseline it:
//
//   (a) creates a FRESH clone of var/fixtures/golden/<fixture>.git into
//       var/fixtures/work/<case-id>/<fixture>;
//   (b) checks out the case's seed ref (seed/<ID> per the manifest `seed`
//       field) onto a real current NAMED branch (never detached HEAD, so
//       merge workflows have a real merge target), or the green baseline
//       onto the fixture's baseline branch when no seed is given;
//   (c) applies per-fixture working-state / junk preparation per spec 02
//       (see `armFixture`). For tt-python do-now this ensures a
//       pre-bootstrapped .venv (./bootstrap), an inert operator-notes.local
//       that is present + untracked + byte-identical to the fixture source,
//       and regenerated junk (__pycache__/, .pytest_cache/) present +
//       untracked.
//
// HOSTILE-FILENAME PROBE (E2.4 US-004): several fixtures (tt-python,
// tt-python@master, tt-poly, tt-poly-lite) carry a directory literally named
// `$(sentinel)` containing a canary check — spec 02's shell-quoting torture.
// It is COMMITTED in the golden tree and is delivered to every work clone via
// ordinary `git clone`/`git checkout` below (git treats the literal name
// `$(sentinel)` as a plain path — `spawnSync('git', ...)` never interpolates a
// shell variable). This is the SPEC'D probe, NOT an unexpanded-shell bug: an
// unquoted `$(` in a shell script would EXECUTE the name and the canary would
// fire. There is deliberately no shell quoting to fix here; the canary's
// survival through provisioning is regression-pinned by
// `self-tests/tier1-e24-sentinel-canary-survival.test.ts`.
//
//     ⚠  Preserve the literal `$(sentinel)` name (quote the whole argument when
//     embedding it in a shell command) so it is NOT run as a command
//     substitution — that is the point of the hostile-filename probe.
//
// A provision failure yields a precise TEST_INFRA reason (fail-closed) — on a
// healthy host it must never be reached.
//
// FIXTURE ALIASES (hostile-path probes, E3.A S14 US-010): a RESERVED alias
// fixture name — W1.X1's 'tt-ts café' (U+0020 space + U+00E9 é) — resolves to
// its canonical fixture through the FIXTURE_ALIASES registry below for every
// golden-bare / hash-ledger / fixture-source / arming lookup, while the WORK
// CLONE PATH keeps the authored name VERBATIM
// (var/fixtures/work/<case-id>/<fixture>) — the hostile characters in the
// clone path ARE the probe. The controller passes the manifest fixture name
// through unchanged, so this module is the single choke point: alias values
// are authored, never ad-hoc, and an UNLISTED non-canonical name still fails
// closed as unknown-fixture.
//
// This is a standalone importable module AND a thin CLI, mirroring
// tt-golden-bootstrap.mjs. US-004 imports `provisionWorkClone` from here and
// calls it as a mandatory stage before the real-case workflow launch builds
// `workflowRunArgs`.
//
// Files only inside torture-test/.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_META,
  TT_ROOT,
  DEFAULT_GOLDEN_DIR,
  ensureGoldenBare,
  parseHashFile,
} from './tt-golden-bootstrap.mjs';

const __filename = fileURLToPath(import.meta.url);
export const BIN_DIR = path.dirname(__filename);
export const DEFAULT_WORK_DIR = path.join(TT_ROOT, 'var', 'fixtures', 'work');
export const DEFAULT_ARMING_MODE = 'prebootstrapped';

// ── Fixture alias resolution (hostile-path aliases, E3.A S14) ───────────
// A RESERVED hostile-path alias (e.g. W1.X1's 'tt-ts café') is a fixture
// value that is deliberately not a canonical fixtures-src/ directory: the
// name itself carries the probe (a space + a non-ASCII char in the work
// clone path). The alias resolves to its canonical fixture for
// golden-bare / hash-ledger / fixture-source lookups while the work clone
// path keeps the AUTHORED name verbatim, so the harness working directory
// really contains the hostile characters. Alias values are authored, never
// ad-hoc: an UNLISTED non-canonical name still fails closed as
// unknown-fixture (the registry is the complete list).
export const FIXTURE_ALIASES = Object.freeze({
  'tt-ts café': 'tt-ts',
});

export function resolveFixtureAlias(fixture) {
  if (typeof fixture !== 'string' || fixture === '') {
    return { fixture, canonical: fixture, isAlias: false };
  }
  const canonical = FIXTURE_ALIASES[fixture];
  if (canonical === undefined) {
    return { fixture, canonical: fixture, isAlias: false };
  }
  return { fixture, canonical, isAlias: true };
}

// Strip tamandua test-isolation vars from any child process we spawn so that
// fixture arming (which runs ./bootstrap / pytest) does not trip the TEST
// ISOLATION GUARD when the adapter runs inside node:test.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  return env;
}

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
  return res;
}

function isBareRepoAt(barePath) {
  const res = git(TT_ROOT, ['--git-dir', barePath, 'rev-parse', '--is-bare-repository']);
  return res.status === 0 && String(res.stdout ?? '').trim() === 'true';
}

function refReason(category, message, extra = {}) {
  return { ok: false, reason: { category, message, ...extra } };
}

// ── Per-fixture arming ──────────────────────────────────────────────
// Spec 02 common requirement (ALL fixtures, E2.4 US-003): inert operator junk
// (operator-notes.local) is PLANTED at provisioning into the work clone as a
// present + UNTRACKED + byte-identical artifact; the committed golden tree must
// NOT contain it (every builder excludes it — US-002). This is the single,
// strict, fail-closed planting oracle shared by every fixture. Regenerated junk
// and bootstrap behaviour are fixture-specific (only tt-python has a
// bootstrap/junk arm; others get the operator-notes arm and a no-op junk arm,
// extended by US-007).
//
// `armFixture` applies working-state / junk preparation to a provisioned
// clone. `arming` is a per-scenario mode: 'prebootstrapped' (default; the
// do-now arming this story targets — bootstrap the venv so a setup-less
// workflow starts green) or 'raw' (no bootstrap; a full-chain workflow's own
// setup step discovers and runs it).

// Canonical inert operator-junk plant (E2.4 US-003): write the fixture source's
// operator-notes.local bytes into the clone and require the result to be (1)
// present, (2) byte-identical to the fixture source, and (3) UNTRACKED (never
// in the index). Fail-closed on any of the three — a tracked, missing, or
// divergent file is a provision defect, not a finding. Because every golden
// builder excludes operator-notes.local (and cloneAndCheckout always reclones
// fresh from the bare), a re-provision can never inherit a stale tracked copy;
// this oracle would still catch a regressed golden that reintroduces it.
function plantOperatorNotes(fixture, clonePath, fixtureSource) {
  // tt-python@master is the master-branch variant of tt-python: its builder
  // reuses ../tt-python as the source and carries no operator-notes.local of
  // its own, so fall back to the shared tt-python source as the canonical
  // byte-exact provisioning reference.
  let srcNotes = path.join(fixtureSource, 'operator-notes.local');
  if (fixture === 'tt-python@master' && !fs.existsSync(srcNotes)) {
    srcNotes = path.join(TT_ROOT, 'fixtures-src', 'tt-python', 'operator-notes.local');
  }
  if (!fs.existsSync(srcNotes)) {
    return refReason('fixture-operator-notes-missing', 'fixture source has no operator-notes.local to plant', {
      fixture, source: srcNotes,
    });
  }
  const canonical = fs.readFileSync(srcNotes);
  const dstNotes = path.join(clonePath, 'operator-notes.local');
  fs.writeFileSync(dstNotes, canonical);
  if (!fs.existsSync(dstNotes) || !fs.readFileSync(dstNotes).equals(canonical)) {
    return refReason('fixture-operator-notes-unverifiable', 'operator-notes.local is not present and byte-identical after planting', {
      fixture, clone: clonePath, source: srcNotes,
    });
  }
  // Must be UNTRACKED (never in the index). Fail-closed if the golden still
  // commits it or a stale tracked copy survives arm time.
  const ls = git(clonePath, ['ls-files', '--error-unmatch', 'operator-notes.local']);
  if (ls.status === 0) {
    return refReason('operator-notes-tracked', 'operator-notes.local is tracked after provisioning', {
      fixture, clone: clonePath,
    });
  }
  return { ok: true, fixture, operatorNotesPlanted: true, source: srcNotes };
}

function armTtPython(clonePath, arming, fixtureSource) {
  // 1. Inert operator junk: plant operator-notes.local (byte-identical to the
  //    fixture source) as an UNTRACKED file via the strict shared oracle.
  const plant = plantOperatorNotes('tt-python', clonePath, fixtureSource);
  if (!plant.ok) return plant;

  // 2. Pre-bootstrapped arming (do-now default): run ./bootstrap to create the
  //    venv so a setup-less workflow starts green. 'raw' skips the bootstrap
  //    (a full-chain workflow's own setup step discovers and runs it).
  if (arming === 'prebootstrapped') {
    const bootstrap = path.join(clonePath, 'bootstrap');
    if (!fs.existsSync(bootstrap)) {
      return refReason('fixture-bootstrap-missing', 'fixture has no ./bootstrap script', {
        fixture: 'tt-python', clone: clonePath,
      });
    }
    const boot = spawnSync('bash', [bootstrap], { cwd: clonePath, env: cleanEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
    if (boot.status !== 0) {
      return refReason('fixture-bootstrap-failed', './bootstrap exited non-zero', {
        fixture: 'tt-python', exit_code: boot.status, signal: boot.signal ?? null,
        tail: (boot.stderr || boot.stdout || '').toString().split(/\r?\n/).slice(-10),
      });
    }
    if (!fs.existsSync(path.join(clonePath, '.venv', 'bin', 'python'))) {
      return refReason('fixture-venv-absent', './bootstrap ran but produced no .venv', {
        fixture: 'tt-python', clone: clonePath,
      });
    }
    // Regenerate junk (__pycache__/, .pytest_cache/) by running one test
    // cycle. Tolerant of non-zero (a seeded/bug case is legitimately RED);
    // junk regeneration is the goal, not greenness.
    spawnSync(path.join(clonePath, '.venv', 'bin', 'python'), ['-m', 'pytest', '-q', '--no-header'], {
      cwd: clonePath, env: cleanEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000,
    });
  }

  // 3. Assert junk invariants: regenerated junk present + untracked. Only
  //    enforced in prebootstrapped mode, where the test cycle above regenerates
  //    the junk. In raw mode there is no venv/toolchain yet, so junk
  //    regeneration is deferred to the full-chain workflow's own setup step;
  //    we report junkVerified:false rather than hard-fail (a raw clone is not a
  //    provision defect).
  if (arming === 'prebootstrapped') {
  for (const junkRel of ['.pytest_cache', '__pycache__']) {
    const junkPath = path.join(clonePath, junkRel);
    if (!fs.existsSync(junkPath)) {
      return refReason('fixture-junk-absent', `regenerated junk missing after arming`, {
        fixture: 'tt-python', junk: junkRel, clone: clonePath,
      });
    }
    const lsJunk = git(clonePath, ['ls-files', '--error-unmatch', junkRel]);
    if (lsJunk.status === 0) {
      return refReason('fixture-junk-tracked', `regenerated junk is tracked (not untracked)`, {
        fixture: 'tt-python', junk: junkRel, clone: clonePath,
      });
    }
  }
  }

  if (arming !== 'prebootstrapped') {
    return {
      ok: true,
      fixture: 'tt-python',
      arming,
      venvBootstrapped: false,
      operatorNotesPlanted: true,
      junkVerified: false,
      note: 'raw mode: junk regeneration deferred to harness setup step',
    };
  }

  return { ok: true, fixture: 'tt-python', arming, venvBootstrapped: true, operatorNotesPlanted: true, junkVerified: true };
}

// Generic arm (all fixtures other than tt-python): plant inert
// operator-notes.local via the strict shared oracle (present + untracked +
// byte-identical, fail-closed on tracked/missing/mismatch). This is the
// E2.4 US-003 contract: EVERY fixture's work clone must carry it untracked +
// byte-exact. Fixture-specific junk/regeneration arms are stubbed here and
// extended by US-007 for non-tt-python fixtures.
function armGeneric(fixture, clonePath, fixtureSource) {
  const plant = plantOperatorNotes(fixture, clonePath, fixtureSource);
  if (!plant.ok) return plant;
  return { ok: true, fixture, arming: DEFAULT_ARMING_MODE, junkVerified: false, operatorNotesPlanted: true };
}

function armFixture(fixture, clonePath, arming) {
  const meta = FIXTURE_META[fixture];
  const fixtureSource = path.join(TT_ROOT, 'fixtures-src', fixture);
  if (!fs.existsSync(fixtureSource)) {
    return refReason('fixture-source-missing', 'fixture source dir is missing', { fixture, source: fixtureSource });
  }
  if (fixture === 'tt-python') {
    return armTtPython(clonePath, arming, fixtureSource);
  }
  return armGeneric(fixture, clonePath, fixtureSource);
}

// Resolve the seed id (e.g. 'BUG-P1') to the exact golden ref + commit. The
// golden hash ledger normalises both ref families (tags for tt-python family,
// branches for tt-ts etc.); we consult it first, then fall back to asking the
// bare directly.
function resolveSeed(barePath, hashFilePath, seed, baselineBranch) {
  let ledger;
  try {
    ledger = parseHashFile(fs.readFileSync(hashFilePath, 'utf8'));
  } catch (error) {
    return refReason('provision-hash-file-unreadable', 'could not read golden hash ledger', {
      bare: barePath, hashFile: hashFilePath, error: error.message,
    });
  }
  const tagRef = `refs/tags/seed/${seed}`;
  const headRef = `refs/heads/seed/${seed}`;
  if (ledger.expected.has(tagRef)) {
    return { ok: true, ref: tagRef, commit: ledger.expected.get(tagRef), kind: 'tag' };
  }
  if (ledger.expected.has(headRef)) {
    return { ok: true, ref: headRef, commit: ledger.expected.get(headRef), kind: 'branch' };
  }
  // Fallback: probe the bare directly (keeps adapter robust to ledger gaps).
  for (const [ref, kind] of [[tagRef, 'tag'], [headRef, 'branch']]) {
    const r = git(TT_ROOT, ['--git-dir', barePath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.status === 0 && /^[0-9a-f]{40}$/.test((r.stdout ?? '').trim())) {
      return { ok: true, ref, commit: r.stdout.trim(), kind };
    }
  }
  return refReason('seed-unknown', `seed '${seed}' not found in the golden`, {
    fixture: null, seed, bare: barePath,
  });
}

// Create a fresh, clean clone of the golden bare into the case's work dir and
// place it on a real named branch at the requested commit (seed or baseline).
function cloneAndCheckout({ fixture, barePath, workClonePath, target }) {
  fs.rmSync(workClonePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workClonePath), { recursive: true });

  const clone = git(TT_ROOT, ['clone', '--quiet', barePath, workClonePath]);
  if (clone.status !== 0) {
    return refReason('git-clone-failed', 'failed to clone the golden bare', {
      fixture, bare: barePath, clone: workClonePath,
      tail: (clone.stderr || '').toString().split(/\r?\n/).slice(-10),
    });
  }

  if (target.kind === 'branch') {
    // Seed lives on an existing branch in the golden: DWIM-checkout a local
    // named branch (seed/<id>), never detached.
    const co = git(workClonePath, ['checkout', '--quiet', `seed/${target.seed}`]);
    if (co.status !== 0) {
      return refReason('git-checkout-seed-failed', 'failed to checkout seed branch', {
        fixture, seed: target.seed, branch: `seed/${target.seed}`,
        tail: (co.stderr || '').toString().split(/\r?\n/).slice(-10),
      });
    }
    target.checkedOutRef = `refs/heads/seed/${target.seed}`;
    target.branch = `seed/${target.seed}`;
  } else if (target.kind === 'tag') {
    // Seed lives on a tag: create a NEW named branch at the seed commit so
    // HEAD is never detached.
    const branchName = `seed-${target.seed}`;
    const co = git(workClonePath, ['checkout', '--quiet', '-b', branchName, target.commit]);
    if (co.status !== 0) {
      return refReason('git-checkout-seed-failed', 'failed to create seed branch', {
        fixture, seed: target.seed, branch: branchName,
        tail: (co.stderr || '').toString().split(/\r?\n/).slice(-10),
      });
    }
    target.branch = branchName;
  } else {
    // Baseline (no seed): the clone's default branch is the fixture baseline.
    // Ensure HEAD is on the baseline branch and NOT detached.
    const head = git(workClonePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = String(head.stdout ?? '').trim();
    if (head.status !== 0 || current === 'HEAD') {
      return refReason('clone-detached-head', 'clone is on detached HEAD (no baseline branch)', {
        fixture, baselineBranch: target.baselineBranch, clone: workClonePath,
      });
    }
    if (current !== target.baselineBranch) {
      const co = git(workClonePath, ['checkout', '--quiet', target.baselineBranch]);
      if (co.status !== 0) {
        return refReason('git-checkout-baseline-failed', 'failed to checkout baseline branch', {
          fixture, branch: target.baselineBranch,
          tail: (co.stderr || '').toString().split(/\r?\n/).slice(-10),
        });
      }
      target.branch = target.baselineBranch;
    } else {
      target.branch = current;
    }
  }

  // Post-condition: HEAD must be on a non-detached named branch.
  const verify = git(workClonePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const finalBranch = String(verify.stdout ?? '').trim();
  if (verify.status !== 0 || finalBranch === 'HEAD') {
    return refReason('clone-detached-head', 'post-checkout HEAD is detached', {
      fixture, clone: workClonePath,
    });
  }
  target.finalBranch = finalBranch;
  return { ok: true, ...target, workClonePath };
}

// ── Core provisioning entrypoint ────────────────────────────────────
// Returns { ok:true, ... } or { ok:false, reason:{ category, message, ... } }.
export function provisionWorkClone({
  fixture,
  caseId,
  goldenDir = DEFAULT_GOLDEN_DIR,
  workDir = DEFAULT_WORK_DIR,
  seed = null,
  arming = DEFAULT_ARMING_MODE,
  force = false,
}) {
  if (typeof fixture !== 'string' || fixture === '') {
    return refReason('provision-fixture-unspecified', 'a --fixture name is required');
  }
  if (typeof caseId !== 'string' || caseId === '') {
    return refReason('provision-case-unspecified', 'a case id is required');
  }
  // Hostile-path alias resolution: 'tt-ts café' -> canonical 'tt-ts' for
  // golden/fixture-source lookups; the work clone path keeps the authored
  // name verbatim (see FIXTURE_ALIASES above).
  const alias = resolveFixtureAlias(fixture);
  const canonicalFixture = alias.canonical;
  const meta = FIXTURE_META[canonicalFixture];
  if (meta === undefined) {
    return refReason('unknown-fixture', `no golden metadata for fixture '${fixture}'`, {
      fixture, canonicalFixture, known: Object.keys(FIXTURE_META).sort(),
    });
  }

  // 1. Golden must exist and be valid (fail-closed). On a healthy host the
  //    goldens are already built; ensureGoldenBare rebuilds a missing one.
  const golden = ensureGoldenBare({ fixture: canonicalFixture, goldenDir });
  if (!golden.ok) return golden; // precise TEST_INFRA category already set
  const barePath = golden.barePath;
  const hashFilePath = golden.hashFilePath;
  if (!isBareRepoAt(barePath)) {
    return refReason('golden-not-bare-repo', 'verified golden is not a usable bare repo', {
      fixture, bare: barePath,
    });
  }

  // 2. Determine the checkout target: seed ref or green baseline.
  let target;
  if (seed !== null && seed !== undefined && seed !== '') {
    const resolved = resolveSeed(barePath, hashFilePath, seed, meta.baselineBranch);
    if (!resolved.ok) {
      return { ...resolved, reason: { ...resolved.reason, fixture, bare: barePath } };
    }
    target = { ...resolved, baselineBranch: meta.baselineBranch, seed };
  } else {
    // Baseline case — resolve the exact baseline commit from the ledger.
    let baselineHash;
    try {
      baselineHash = parseHashFile(fs.readFileSync(hashFilePath, 'utf8')).baselineHash;
    } catch (error) {
      return refReason('provision-hash-file-unreadable', 'could not read golden hash ledger for baseline', {
        fixture, hashFile: hashFilePath, error: error.message,
      });
    }
    if (typeof baselineHash !== 'string' || !/^[0-9a-f]{40}$/.test(baselineHash)) {
      return refReason('provision-baseline-missing', 'golden hash ledger has no baseline hash', {
        fixture, hashFile: hashFilePath,
      });
    }
    target = { kind: 'baseline', commit: baselineHash, baselineBranch: meta.baselineBranch };
  }

  // 3. Work clone path: var/fixtures/work/<case-id>/<fixture> — the AUTHORED
  //    fixture name verbatim, so an alias keeps its hostile path characters
  //    (space + non-ASCII) in the harness working directory.
  const workClonePath = path.join(workDir, caseId, fixture);

  // 4. Fresh clone + named-branch checkout.
  const cloneResult = cloneAndCheckout({ fixture, barePath, workClonePath, target });
  if (!cloneResult.ok) return cloneResult;

  // 5. Per-fixture arming (spec 02 junk / working-state prep) against the
  //    CANONICAL fixture source (fixtures-src/<canonical>); an alias has no
  //    fixtures-src/ directory of its own.
  const armed = armFixture(canonicalFixture, workClonePath, arming);
  if (!armed.ok) {
    return { ...armed, reason: { ...armed.reason, workClonePath } };
  }

  return {
    ok: true,
    fixture,
    canonicalFixture,
    fixtureAlias: alias.isAlias,
    caseId,
    workClonePath,
    goldenBare: barePath,
    target,
    arming: armed.arming,
    venvBootstrapped: armed.venvBootstrapped === true,
    operatorNotesPlanted: armed.operatorNotesPlanted === true,
    junkVerified: armed.junkVerified === true,
    force,
    prepared_at: new Date().toISOString(),
  };
}

// ── CLI entry ───────────────────────────────────────────────────────
function usage() {
  const out = [
    `Usage: tt-fixture-provision --fixture <name> --case-id <id> [options]`,
    ``,
    `Provision a pristine working clone from a golden bare (fail-closed).`,
    ``,
    `Options:`,
    `  --fixture <name>     Golden fixture (e.g. tt-python) or a reserved hostile-path alias`,
    `                       (e.g. 'tt-ts café' -> tt-ts; the work clone path keeps the authored`,
    `                       alias name verbatim).`,
    `  --case-id <id>       Case id; clone lands at <work-dir>/<case-id>/<fixture>.`,
    `  --seed <id>          Optional seed ref (e.g. BUG-P1 -> seed/BUG-P1).`,
    `                       Omit to land on the green baseline branch.`,
    `  --golden-dir <dir>   Override golden dir (default: torture-test/var/fixtures/golden).`,
    `  --work-dir <dir>     Override work dir (default: torture-test/var/fixtures/work).`,
    `  --arming <mode>      prebootstrapped (default) | raw.`,
    `  --force              Wipe any existing clone before provisioning.`,
    `  --json               Emit the JSON verdict on stdout (default).`,
    `  --help, -h           Print this help and exit.`,
    ``,
    `Known fixtures: ${Object.keys(FIXTURE_META).sort().join(', ')}.`,
    `Known aliases: ${Object.keys(FIXTURE_ALIASES).sort().join(', ')}.`,
    ``,
    `Exit codes: 0 = provisioned OK; 1 = fail-closed TEST_INFRA defect; 2 = usage error.`,
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
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') opts.fixture = argv[++i];
    else if (arg === '--case-id') opts.caseId = argv[++i];
    else if (arg === '--seed') opts.seed = argv[++i];
    else if (arg === '--golden-dir') opts.goldenDir = argv[++i];
    else if (arg === '--work-dir') opts.workDir = argv[++i];
    else if (arg === '--arming') opts.arming = argv[++i];
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') { /* default */ }
    else {
      printJson({ ok: false, usage_error: `unknown option: ${arg}`, hint: usage().split('\n')[0] });
      return 2;
    }
  }
  if (opts.fixture === undefined || opts.caseId === undefined) {
    printJson({
      ok: false,
      usage_error: '--fixture and --case-id are required',
      hint: usage().split('\n')[0],
    });
    return 2;
  }
  const result = provisionWorkClone(opts);
  printJson(result);
  return result.ok ? 0 : 1;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
