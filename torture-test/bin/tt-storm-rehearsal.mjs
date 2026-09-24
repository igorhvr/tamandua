// tt-storm-rehearsal.mjs — STORM-REHEARSAL PREPARE + RUN layer (US-001/US-002).
//
// The rehearsal gate's PREPARE phase must allocate and fully provision every
// fresh-owned input the real zero-model SCRIPTED_REHEARSAL will consume,
// derived from the ACTUAL current bundled workflows/rosters, so a coordinator
// can later review ONE coherent source-pinned descriptor and authorize an
// exact executable campaign. This module is the input/profile/behavior
// BUILDER for that prepare phase AND the RUN-layer wiring that connects a
// prepared campaign to the real production storm engine and transports
// (US-002):
//
//   * seeds the private installed catalog (the installed root a storm daemon
//     would actually run, e.g. <var>/home/.tamandua/workflows) from the
//     ACTUAL bundled catalog (workflows/) so roster/harness/timer numbers are
//     derived from CURRENT registrations, never a historical hardcoded count
//     (spec 09 wave-5 corrected-timer contract; the active cap is DERIVED);
//   * allocates the campaign's fresh OWNED input roots under the gitignored
//     torture-test/var (a per-campaign rehearsal input area + a per-campaign
//     worktree root), capturing realpath + dev/ino AT allocation and
//     persisting identity receipts (mirroring the persistableExecIdentity /
//     revalidate conventions in tt-storm-real.mjs);
//   * provisions an owned TINY git origin + sibling clones (colleague/park —
//     the existing --colleague-repo/--park-repo option vocabulary) with a
//     broken-tests branch, entirely local, no network, no credentials;
//   * provisions per-run task files for EVERY roster entry (Round A S1-S10
//     incl. S7 broken-tests quarantine context + S9/S10 queue entries; Round
//     B B1-B5 incl. B4 red-bait and B5 do-now), each naming the ACTUAL
//     bundled workflow id + harness from tt-storm-roster.mjs and declaring the
//     exact expected scripted operations/outputs;
//   * assembles the source-pinned machine-readable descriptor (campaign id +
//     dir, source commit/tree + tree_dirty, complete gate-file sha256 set,
//     catalog identity, frozen runtime/binary pins, resource plan, per-run
//     input manifest, and the exact authorized rehearse command).
//
// US-002 (RUN layer — the same file, one module per gate concern):
//   * run-mode opts overlay from the prepared campaign state
//     (rehearsalRunOptsFromState) so the engine's real round drivers consume
//     the ACTUAL prepared task files, fixture identity, worktree root and
//     daemon kind — the prepared campaign, never a CLI re-derivation;
//   * the ONE private daemon lifecycle through the sanctioned daemon-control
//     wrapper (daemonControlArgv / makeRehearsalDaemonControl /
//     ensureRehearsalDaemon / stopRehearsalDaemon / makeRehearsalDaemonCleanupHandler):
//     per-campaign env script (renderRehearsalDaemonEnvScript) with
//     independently bind0-allocated dashboard/MCP/control ports (refuses
//     production 3334/3338/3339), guard=1, frozen probe-enabled scripted
//     runtimes, credentials absent; start/stop/restart/status are dispatched
//     through ctx.proc.daemonControl and every start is recorded with the
//     daemon-control provenance evidence (pid + process-start identity +
//     ports) into campaign state so cleanup demands positive shutdown
//     evidence of the exact recorded daemon (never a stale/name pid);
//   * the N4 single-flight arm prelude (armSingleFlightPrelude +
//     singleFlightKeyOf / buildSingleFlightWaiterArgv / parseSingleFlightResult
//     / classifySingleFlightLeg): N identical origin/tree/wrapped-command
//     waiters through the tamandua-test shim, exactly one execution + all
//     waiters observing the same recorded result, with genuinely-owned
//     dead-owner + reclaim kept DISTINCT from release-on-stop — every side
//     effect (intent before every launch, results, kills) recorded; outcomes
//     are classified from real marker/ledger evidence, never fabricated.
//
// SIDE-EFFECT DISCIPLINE (STORM-REAL / incident-44 posture): plan/prepare
// stays launch-free — NO daemon, NO harness, NO chaos process is ever started
// here. The only effects are (a) contained writes under the gitignored
// torture-test/var, (b) the recursive catalog seed copy (bundled -> installed,
// a pure contained copy, never a disposal), and (c) local git subprocesses
// creating the owned fixture repos. No rm/rmdir/unlink/recursive deletion,
// no reset/clean/prune/gc/worktree removal, no fixed-scratch preclean and no
// stale PID/name kills ever happen in this module; every artifact is
// retained. All fs/git/clock access goes through injected adapters so the
// in-process self-test can exercise provisioning with zero product effects.
//
// This module is purely torture-owned; it never touches src/, native/, e2e/,
// product workflows/catalog/personas or a live install.

import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';

import {
  REPO_ROOT,
  refusal,
  sha256,
} from './tt-contention-slice-shared.mjs';
import { REAL_FS } from './tt-storm-roster.mjs';
import {
  REAL,
  SCRIPTED_REHEARSAL,
  SCRIPTED_REHEARSAL_LABEL,
  daemonKindForProfile,
  labelForProfile,
  parseProfile,
} from './tt-storm-profile.mjs';
import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
  STORM_WORKFLOW_IDS,
} from './tt-storm-roster.mjs';
// STORM-REAL US-008: the capacity-scaled lite roster + reduced chaos plan. The
// rehearsal builder provisions task files and records descriptor roster
// identity for the ACTIVE scale (full by default, unchanged).
import {
  parseScale,
  rosterWorkflowIds,
} from './tt-storm-scale.mjs';
// STORM-REAL US-002: the real harness binary resolver/pinner. A REAL campaign
// resolves the OPERATOR'S real pi/hermes/dsh binaries (env override, else
// PATH) and records absolute path + --version + sha256 pins; an unresolvable
// roster harness refuses prepare with TT_UNRESOLVED_BINARY before any effect.
import {
  HARNESS_BINARY_ENV,
  harnessNamesForRoster,
  resolveRosterHarnessPins,
} from './tt-storm-harness-pins.mjs';
// US-004 (STORM-REHEARSAL-FIX4): the SCRIPTED_REHEARSAL hold/phase schedule is
// derived from the ENGINE's authoritative real ROUND_B_PHASES table (same
// order, same action objects) and its phase-predicate target semantics, so the
// derived schedule can never drift from the real chaos contract. The engine
// statically imports this module (`assertLaunchOriginContained`), so this is an
// intentional ESM cycle: it is safe because every engine binding referenced
// here is used only INSIDE function bodies (never at module top level), so the
// live bindings are initialized by the time any exported function runs.
import {
  ROUND_B_PHASES,
  phaseTargetRosterIds,
  phaseWaitTargetRosterIds,
} from './tt-storm-engine.mjs';
// The daemon-provenance verifier reuses the tt-storm-real containment verdict
// (pathIsWithin) so the rehearsal's cwd check has ONE convention with the rest
// of the contained exec-context machinery.
import { pathIsWithin } from './tt-storm-real.mjs';
// US-002: the product's single source of truth for keys the run/harness
// provides without any step producing them. The feed-forward completeness
// pass must never synthesize these (doing so would change the six established
// SCRIPTED_REHEARSAL workflows' outputs); importing the product module keeps
// the torture code from drifting from src/installer/workflow-contract.ts.
import {
  AUTO_CONTEXT_KEYS,
  CALLER_PROVIDED,
  HARNESS_SEEDED_CONTEXT_KEYS,
} from '../../dist/installer/workflow-contract.js';

// ─────────────────────────────────────────────────────────────────────
// Identity constants (the descriptor's fixed identities; the executable
// contents are derived from the ACTUAL roster/catalog at prepare time).
// ─────────────────────────────────────────────────────────────────────
export const REHEARSAL_PROFILE = SCRIPTED_REHEARSAL;
export const DESCRIPTOR_NAME = 'descriptor.json';
export const REHEARSAL_INPUTS_REL = 'rehearsal'; // <var>/rehearsal/<campaignId>
export const WORKTREE_ROOT_REL = 'worktrees';    // <var>/worktrees/<campaignId>
export const DEFAULT_COORDINATOR_APPROVAL_FILE = '/root/matchlock-work/storm-real-safety-approval.json';
export const REHEARSAL_LABEL = SCRIPTED_REHEARSAL_LABEL;
export const FIXTURE_BROKEN_BRANCH = 'broken-tests';
export const FIXTURE_MAIN_BRANCH = 'main';

// ─────────────────────────────────────────────────────────────────────
// Tiny owned fixture layout. This fixture is a deliberately SMALL monorepo
// used to make the zero-model machinery gate practical; the descriptor and
// every task file label it infrastructure rehearsal — never a full tt-poly
// storm. Real full-storm later runs vaivm-only with genuine aged tt-poly and
// approved caps.
// ─────────────────────────────────────────────────────────────────────
export const FIXTURE_FILES = Object.freeze({
  'README.md': `# storm-rehearsal tiny fixture\n\nInfrastructure rehearsal fixture owned by a tt-storm prepare run.\nThis is a tiny explicitly-owned git repository for the zero-model SCRIPTED_REHEARSAL\nmachinery gate — labelled infrastructure rehearsal, NOT the full tt-poly storm.\n`,
  'go/workerpool/pool.go': 'package workerpool\n\n// Pool is a tiny worker pool used as the Round A/B go-lane edit target.\ntype Pool struct{ size int }\n\nfunc New(size int) *Pool { return &Pool{size: size} }\n',
  'java/ledger/Ledger.java': 'package ledger;\n\n/** Tiny ledger ledger used as the java-lane edit target. */\npublic class Ledger {\n  private long balance = 0;\n  public void credit(long n) { this.balance += n; }\n  public long balance() { return this.balance; }\n}\n',
  'python/scheduler/scheduler.py': '"""Tiny scheduler used as the python-lane edit target."""\n\nclass Scheduler:\n    def __init__(self):\n        self.queue = []\n\n    def submit(self, task):\n        self.queue.append(task)\n',
  'rust/bugfix/src/lib.rs': '//! Tiny rust bug area used as the rust-lane (POLY-BUG-R) edit target.\n\n/// Returns the length of the string plus one (the seeded bug: off-by-one).\npub fn buggy_len(s: &str) -> usize {\n    s.len() + 1\n}\n',
  'ts/src/store.ts': '// Tiny TS store used as the ts/store.ts overlap edit target (S5/S9 pair).\nexport interface Store<T> { get(k: string): T | undefined; set(k: string, v: T): void; }\nexport class MemStore<T> implements Store<T> {\n  private m = new Map<string, T>();\n  get(k: string): T | undefined { return this.m.get(k); }\n  set(k: string, v: T): void { this.m.set(k, v); }\n}\n',
  'docs/cc1.md': '# Colleague commit target (unrelated)\n\nThis file is the unrelated colleague-commit (cc1) target for the Round B chaos schedule.\n',
  'docs/consistency.md': '# Docs+code consistency area\n\nEdit target for the do-review-do-verify (S8) lane.\n',
});

// broken-tests-branch-only files (S7 quarantine lane).
export const FIXTURE_BROKEN_FILES = Object.freeze({
  'tests/broken_test.py': '"""Broken test present ONLY on the broken-tests branch (S7 quarantine bait)."""\n\ndef test_always_fails():\n    assert False, "seeded broken test for the quarantine lane"\n',
});

// Per-roster edit target file inside the tiny fixture (keyed by roster id;
// the roster ids themselves come from tt-storm-roster.mjs — never renamed
// substitute workflows are used as roster entries).
export const ROSTER_EDIT_FILE = Object.freeze({
  S1: 'go/workerpool/pool.go',
  S2: 'java/ledger/Ledger.java',
  S3: 'python/scheduler/scheduler.py',
  S4: 'rust/bugfix/src/lib.rs',
  S5: 'ts/src/store.ts',
  S6: 'README.md',
  S7: 'tests/broken_test.py',
  S8: 'docs/consistency.md',
  S9: 'ts/src/store.ts',
  S10: 'README.md',
  B1: 'go/workerpool/pool.go',
  B2: 'java/ledger/Ledger.java',
  B3: 'rust/bugfix/src/lib.rs',
  B4: 'rust/bugfix/src/lib.rs',
  B5: 'README.md',
  // STORM-REAL US-008: the capacity-scaled tt-poly-lite pilot roster
  // (fdmw ts, bfmw python, quarantine broken-tests, do-now).
  L1: 'ts/src/store.ts',
  L2: 'python/scheduler/scheduler.py',
  L3: 'tests/broken_test.py',
  L4: 'README.md',
  L1b: 'ts/src/store.ts',
  L2b: 'python/scheduler/scheduler.py',
  L3b: 'tests/broken_test.py',
  L4b: 'README.md',
});

// Expected scripted shape per ACTUAL bundled workflow family (the workflow
// keys are the exact ids from tt-storm-roster.mjs / the bundled catalog).
export const WORKFLOW_EXPECTED = Object.freeze({
  'feature-dev-merge-worktree':
    'real step sequence of the bundled feature-dev-merge-worktree (planner/setup/developer/verifier and friends then finalize_merge): a feature branch is created from main, the story edit is made+tested in the owned worktree, and finalize_merge squash-merges it onto main',
  'bug-fix-merge-worktree':
    'real step sequence of the bundled bug-fix-merge-worktree (fix/verify then finalize_merge): the seeded bug in the owned fix area is fixed in the worktree, the verifier confirms, and finalize_merge lands the fix onto main',
  'security-audit-merge-worktree':
    'real step sequence of the bundled security-audit-merge-worktree: audit findings are addressed in the owned worktree and finalize_merge lands the audit result onto main',
  'quarantine-broken-tests-merge-worktree':
    'real step sequence of the bundled quarantine-broken-tests-merge-worktree ON THE broken-tests lane (launch --context branch=broken-tests): the seeded broken test is quarantined/restored in isolation so the lane lands without breaking main',
  'do-review-do-verify':
    'real do → review → do-verify cycle of the bundled do-review-do-verify: the docs+code consistency task is performed and the run completes',
  'do-now':
    'real single-step trivial completion of the bundled do-now (queue-drain / agitator canary)',
});

// ─────────────────────────────────────────────────────────────────────
// Gate-file list + computeGateHashes — the source-pinned boundary set the
// coordinator approval pins. Kept in ONE place (this module) so prepare's
// descriptor and the CLI's approve/rehearse validator always agree.
// ─────────────────────────────────────────────────────────────────────
export const GATE_HASH_FILES = Object.freeze([
  'torture-test/bin/tt-storm-real.mjs',
  'torture-test/bin/tt-storm-shared.mjs',
  'torture-test/bin/tt-storm-engine.mjs',
  'torture-test/bin/tt-storm-roster.mjs',
  'torture-test/bin/tt-storm-rehearsal.mjs',
  'torture-test/bin/tt-storm',
  // US-011: the SCRIPTED_REHEARSAL hold primitive lives in the scripted
  // runtimes — the campaign-controlled `<runId>.confirmed` / `.release`
  // checkpoint and the fail-closed runtime timeout are what actually keep the
  // roster runs ACTIVE for the Round-A window and the Round-B chaos phases.
  // The fresh approval must pin the code that produces those holds (and the
  // real chaos recovery), not just the engine that orchestrates them.
  'torture-test/scripted-runtimes/runtime-shared.mjs',
  'torture-test/scripted-runtimes/runtime-pi.mjs',
  'torture-test/scripted-runtimes/runtime-hermes.mjs',
  'torture-test/self-tests/tier2-storm-real-calibration.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-gate.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts',
  // US-011: the focused FIX-4 behavior self-tests for the new hold/window/
  // Round-B machinery (US-001..US-010). Pinning them means an approval covers
  // the exact evidence that proves red-bait distinctness, the campaign hold
  // primitive, the derived hold/phase schedule, the S1 simultaneity window,
  // the Round-A/Round-B hold release, chaos honesty and the SF-9 pending
  // candidate. Deliberately EXCLUDED: the consistency suite and any test that
  // mutates shared state or merely asserts the gate set itself.
  'torture-test/self-tests/tier2-storm-rehearsal-redbait-projection.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-runtime.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-behaviors.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-schedule.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-release.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-rounda-release.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-chaos-honesty.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-pending-candidate.test.ts',
  // FIX-5 (US-007): the focused behavior self-tests for the SF-11 hold-wiring
  // fix, the SF-10 one-shot hold, and the Round-B live-target matrix, plus the
  // two contained-private-daemon E2E proofs (one real held run; B-stopdel
  // chaos firing on the live B5 and producing relaunchOf lineage). Pinning
  // these means a fresh fix5 approval covers the exact code paths — the
  // engine's derived-hold predicate winning under the real wrapper, the
  // run-lifecycle one-shot rule in the scripted runtimes, and the real
  // stop/delete/relaunch recovery — that attempt 5 found under-evidenced.
  // Deliberately EXCLUDED (as for fix-4): the shared-state consistency suite
  // and this gate-coverage test itself.
  'torture-test/self-tests/tier2-storm-rehearsal-hold-wiring.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-oneshot.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts',
  'torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts',
  // STORM-REAL (US-014): the REAL campaign profile boundary. Every
  // profile/pins/spend/scale/arming/unattended module added by US-001..US-012
  // is pinned here together with the focused behavior/negative self-tests
  // that prove its safety rules — profile selection, real-harness binary
  // resolution + pins and the missing-harness refusal, profile-bound
  // coordinator approval, the real daemon env/contract, spend accounting and
  // the required cap, the report headline spend/roster, the lite roster, the
  // aged-state adoption, the seed-validation arming rule, the unattended
  // round budget/detached launch, and the boundary negative battery. A
  // changed REAL boundary therefore forces fresh coordinator review. The
  // shared-state consistency suite and this gate-coverage test itself stay
  // deliberately EXCLUDED (see the coverage test).
  'torture-test/bin/tt-storm-profile.mjs',
  'torture-test/bin/tt-storm-harness-pins.mjs',
  'torture-test/bin/tt-storm-spend.mjs',
  'torture-test/bin/tt-storm-scale.mjs',
  'torture-test/bin/tt-storm-arm.mjs',
  'torture-test/bin/tt-storm-seed-validation.mjs',
  'torture-test/bin/tt-storm-unattended.mjs',
  'torture-test/self-tests/tier2-storm-real-profile.test.ts',
  'torture-test/self-tests/tier2-storm-real-harness-pins.test.ts',
  'torture-test/self-tests/tier2-storm-real-profile-approval.test.ts',
  'torture-test/self-tests/tier2-storm-real-daemon-env.test.ts',
  'torture-test/self-tests/tier2-storm-real-spend-accounting.test.ts',
  'torture-test/self-tests/tier2-storm-real-spend-cap.test.ts',
  'torture-test/self-tests/tier2-storm-real-report-spend.test.ts',
  'torture-test/self-tests/tier2-storm-real-lite-roster.test.ts',
  'torture-test/self-tests/tier2-storm-real-arm-aged-state.test.ts',
  'torture-test/self-tests/tier2-storm-real-seed-validation-arm.test.ts',
  'torture-test/self-tests/tier2-storm-real-storm-aged-contract.test.ts',
  'torture-test/self-tests/tier2-storm-real-unattended.test.ts',
  'torture-test/self-tests/tier2-storm-real-boundary-negative.test.ts',
]);

// The COMPLETE gate set is the approval's pinning contract: a listed gate
// file that cannot be read is a broken tested boundary — the approval can
// never silently pin a SUBSET because a file vanished (a null hash was
// previously filtered out of the expected set, letting an old approval stay
// authoritative after the tested surface shrank). computeGateHashes therefore
// REFUSES on an unreadable listed file instead of dropping it.
export function computeGateHashes({ fsx = fs, repoRoot = REPO_ROOT } = {}) {
  const hashes = {};
  for (const rel of GATE_HASH_FILES) {
    const abs = path.join(repoRoot, rel);
    let bytes;
    try {
      bytes = fsx.readFileSync(abs);
    } catch (err) {
      throw refusal(
        `gate file unreadable — the tested boundary is incomplete and cannot be pinned: ${rel} (${err?.message ?? String(err)})`,
        'TT_GATE_FILE_MISSING',
      );
    }
    hashes[rel] = sha256(bytes);
  }
  return hashes;
}

// ─────────────────────────────────────────────────────────────────────
// Path containment (canonical; refuses lexical + symlink escapes under the
// var root). Mirrors the assertCampaignDestContained posture.
// ─────────────────────────────────────────────────────────────────────
export function pathIsWithinStatic(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOrNearest(p, fsx) {
  let cur = path.resolve(String(p));
  for (;;) {
    try {
      return fsx.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

function requireUnderVarRoot(varRoot, candidate, label) {
  if (!varRoot || !path.isAbsolute(varRoot)) {
    throw refusal(`rehearsal prepare requires an absolute varRoot (got ${JSON.stringify(varRoot)})`, 'TT_EXEC_ESCAPE');
  }
  const abs = path.resolve(String(candidate));
  if (!pathIsWithinStatic(varRoot, abs)) {
    throw refusal(`${label} escapes the contained var root ${varRoot}: ${abs}`, 'TT_EXEC_ESCAPE');
  }
  return abs;
}

// Canonicalize a path for containment: realpath when it exists, else the
// realpath of its nearest existing ancestor with the missing tail re-appended
// (mirrors tt-storm-real safeRealpath). The tail is NEVER dropped: a
// lexically-nested path whose REAL destination is foreign must still be
// refused (root defect #3 convention). Returns null when no ancestor resolves.
function realpathForContainment(p, fsx) {
  try {
    return fsx.realpathSync(String(p));
  } catch {
    let cur = path.resolve(String(p));
    const tail = [];
    for (;;) {
      try {
        const real = fsx.realpathSync(cur);
        return tail.length ? path.join(real, ...tail) : real;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

// The campaign-owned roots a launch's worktree origin MUST be contained by.
// `ownedRoots` (explicit) wins; `execCtx` may carry the tt-storm-real exec
// identity's `var_root` and/or `repos_root`. Returns absolute, de-duplicated
// roots (canonicalization happens in assertLaunchOriginContained).
export function ownedRootsForLaunchOrigin({ ownedRoots = null, execCtx = null } = {}) {
  const roots = [];
  if (Array.isArray(ownedRoots)) {
    for (const r of ownedRoots) if (r) roots.push(path.resolve(String(r)));
  }
  if (execCtx && typeof execCtx === 'object') {
    if (execCtx.var_root) roots.push(path.resolve(String(execCtx.var_root)));
    if (execCtx.repos_root) roots.push(path.resolve(String(execCtx.repos_root)));
  }
  return [...new Set(roots)];
}

// US-006 (SF-2 containment, fail closed): the ONE verdict for a launch's
// RESOLVED worktree origin. Realpaths BOTH the origin and every owned root
// (nearest-existing-ancestor + tail) and applies the existing pathIsWithin
// convention, so a lexically-nested symlink to a foreign repository is
// refused. Returns the matched root on success; throws TT_ORIGIN_ESCAPE when
// the origin is outside every owned root OR when no owned root was supplied
// (a launch that cannot PROVE containment must not spawn). It never mutates
// state and never spawns anything.
export function assertLaunchOriginContained({
  ownedRoots = null,
  execCtx = null,
  originRepository,
  fs: fsx = REAL_FS,
  label = 'launch',
} = {}) {
  if (!originRepository) {
    throw refusal(`${label}: no resolved worktree origin to contain — refusing (SF-2 containment)`, 'TT_ORIGIN_ESCAPE');
  }
  const roots = ownedRootsForLaunchOrigin({ ownedRoots, execCtx });
  const originAbs = path.resolve(String(originRepository));
  const originReal = realpathForContainment(originAbs, fsx) ?? originAbs;
  if (roots.length === 0) {
    throw refusal(
      `${label}: no campaign-owned root supplied — cannot prove worktree origin ${originReal} is contained (SF-2 containment)`,
      'TT_ORIGIN_ESCAPE',
    );
  }
  for (const root of roots) {
    const rootReal = realpathForContainment(root, fsx) ?? root;
    if (pathIsWithin(rootReal, originReal)) {
      return { ok: true, origin: originAbs, originRealpath: originReal, root, rootRealpath: rootReal };
    }
  }
  throw refusal(
    `${label}: resolved worktree origin ${originReal} escapes the campaign-owned roots [${roots.join(', ')}] — refusing the launch (SF-2 containment)`,
    'TT_ORIGIN_ESCAPE',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Catalog seeding — copy the ACTUAL bundled catalog trees (workflows/*) into
// the private installed catalog root a storm daemon runs. The copy is
// contained, additive and non-destructive (per-file overwrite of identical
// content only; never any deletion). Every workflow.yml source is hashed and
// recorded with its installed twin so derivation provenance is reproducible.
// ─────────────────────────────────────────────────────────────────────
export function seedCatalogFromBundled({ fs: fsx = REAL_FS, bundledRoot, installedRoot, clock = null }) {
  if (!bundledRoot || !installedRoot) {
    throw refusal('seedCatalogFromBundled requires bundledRoot + installedRoot', 'TT_USAGE');
  }
  const bAbs = path.resolve(String(bundledRoot));
  const iAbs = path.resolve(String(installedRoot));
  let entries;
  try {
    entries = fsx.readdirSync(bAbs);
  } catch (err) {
    throw refusal(`bundled catalog root unreadable: ${bAbs} (${err.message})`, 'TT_CATALOG');
  }
  try {
    fsx.mkdirSync(iAbs, { recursive: true });
  } catch (err) {
    throw refusal(`cannot create installed catalog root ${iAbs}: ${err.message}`, 'TT_CATALOG');
  }
  const seeded = [];
  const perWorkflow = {};
  const copyTree = (from, to) => {
    fsx.mkdirSync(to, { recursive: true });
    for (const name of fsx.readdirSync(from)) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      let st;
      let isLink = false;
      try { st = fsx.statSync(src); } catch { continue; }
      try { isLink = fsx.lstatSync(src)?.isSymbolicLink?.() === true; } catch { isLink = false; }
      if (isLink) {
        try { fsx.symlinkSync(fsx.readlinkSync(src), dst); } catch { /* existing symlink stays */ }
        continue;
      }
      if (st.isDirectory()) {
        copyTree(src, dst);
      } else if (st.isFile()) {
        let content;
        try { content = fsx.readFileSync(src); } catch { continue; }
        fsx.writeFileSync(dst, content);
      }
    }
  };
  for (const name of entries) {
    const srcRoot = path.join(bAbs, name);
    let st;
    try { st = fsx.statSync(srcRoot); } catch { continue; }
    if (!st.isDirectory()) continue; // only workflow catalog dirs are seeded
    copyTree(srcRoot, path.join(iAbs, name));
    seeded.push(name);
    const wfYml = path.join(srcRoot, 'workflow.yml');
    let yml = null;
    try { yml = fsx.readFileSync(wfYml); } catch { yml = null; }
    const entry = {
      sourcePath: wfYml,
      sourceSha256: typeof yml === 'string' || Buffer.isBuffer(yml) ? sha256(String(yml)) : null,
      installedPath: path.join(iAbs, name, 'workflow.yml'),
      installedSha256: null,
    };
    if (entry.sourceSha256 !== null) {
      try {
        const inst = fsx.readFileSync(path.join(iAbs, name, 'workflow.yml'));
        entry.installedSha256 = sha256(String(inst));
      } catch { entry.installedSha256 = null; }
    }
    perWorkflow[name] = entry;
  }
  if (seeded.length === 0) {
    throw refusal(`bundled catalog root ${bAbs} contains no workflow directories to seed`, 'TT_CATALOG');
  }
  return {
    installedRoot: iAbs,
    sourceRoot: bAbs,
    kind: 'installed',
    seeded: seeded.slice().sort(),
    perWorkflow,
    copiedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Fresh owned input roots — per-campaign area under <var>/rehearsal and a
// per-campaign worktree root under <var>/worktrees. Realpath + dev/ino are
// captured AT ALLOCATION and returned as identity receipts (the
// persistableExecIdentity convention); later real modes revalidate against
// them, so a replaced/reused root can never be blessed.
// ─────────────────────────────────────────────────────────────────────
export function allocateRehearsalInputRoots({ fs: fsx = REAL_FS, varRoot, campaignId, clock = null }) {
  if (!campaignId || !/^[A-Za-z0-9._-]+$/.test(String(campaignId))) {
    throw refusal(`allocateRehearsalInputRoots: campaignId must be a safe slug (got ${JSON.stringify(campaignId)})`, 'TT_USAGE');
  }
  const vAbs = path.resolve(String(varRoot));
  if (!path.isAbsolute(vAbs)) throw refusal('varRoot must be absolute', 'TT_EXEC_ESCAPE');
  const base = requireUnderVarRoot(vAbs, path.join(vAbs, REHEARSAL_INPUTS_REL, campaignId), 'rehearsal input root');
  const tasksRoot = path.join(base, 'tasks');
  const reposRoot = path.join(base, 'repos');
  const worktreeRoot = requireUnderVarRoot(vAbs, path.join(vAbs, WORKTREE_ROOT_REL, campaignId), 'rehearsal worktree root');
  for (const dir of [base, tasksRoot, reposRoot, worktreeRoot]) {
    try {
      fsx.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw refusal(`cannot allocate owned rehearsal input root ${dir}: ${err.message}`, 'TT_EXEC_ESCAPE');
    }
  }
  const capture = (key, p) => {
    const real = realpathOrNearest(p, fsx) ?? p;
    let dev = null;
    let ino = null;
    try {
      const st = fsx.statSync(real);
      dev = st.dev;
      ino = st.ino;
    } catch { /* keep null */ }
    return { key, path: real, realpath: real, dev, ino, capturedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString() };
  };
  const receipts = {
    root: capture('root', base),
    tasks: capture('tasks', tasksRoot),
    repos: capture('repos', reposRoot),
    worktree: capture('worktree', worktreeRoot),
  };
  return {
    root: base,
    tasksRoot,
    reposRoot,
    worktreeRoot,
    receipts,
    allocatedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Owned tiny git fixture — origin + sibling clones + broken-tests branch.
// `git` is the injected git adapter ({ run(repoDir, args, opts) }); every
// child git spawn is a LOCAL operation (no network, no credentials). The
// child env is pinned hermetic (GIT_CONFIG_GLOBAL=/dev/null, no system
// config) and layered over an explicit base env when supplied.
// ─────────────────────────────────────────────────────────────────────
export function gitFixtureEnv(base = {}) {
  return {
    ...(base ?? {}),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'torture-storm rehearsal',
    GIT_AUTHOR_EMAIL: 'torture-storm-rehearsal@tetradactyla.org',
    GIT_COMMITTER_NAME: 'torture-storm rehearsal',
    GIT_COMMITTER_EMAIL: 'torture-storm-rehearsal@tetradactyla.org',
    LC_ALL: 'C.UTF-8',
  };
}

async function gitRun(git, cwd, args, env) {
  const res = await git.run(cwd, args, { env });
  if (res?.exitCode !== 0) {
    throw refusal(
      `fixture git ${args[0] ?? ''} failed in ${cwd} (exit ${res?.exitCode}): ${String(res?.stderr ?? '').trim().slice(0, 400)}`,
      'TT_FIXTURE_GIT',
    );
  }
  return res;
}

function writeFixtureTree(fsx, root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fsx.mkdirSync(path.dirname(abs), { recursive: true });
    fsx.writeFileSync(abs, content);
  }
}

export async function provisionOwnedGitFixture({
  fs: fsx = REAL_FS,
  git,
  clock = null,
  reposRoot,
  env = {},
}) {
  if (!reposRoot) throw refusal('provisionOwnedGitFixture requires reposRoot', 'TT_USAGE');
  if (typeof git?.run !== 'function') {
    throw refusal('provisionOwnedGitFixture requires a git adapter (ctx.git) — no real-harness fallback exists', 'TT_USAGE');
  }
  const gEnv = gitFixtureEnv(env);
  const originRepo = path.join(reposRoot, 'origin');
  const colleagueRepo = path.join(reposRoot, 'colleague');
  const parkRepo = path.join(reposRoot, 'park');
  for (const dir of [originRepo, colleagueRepo, parkRepo]) {
    fsx.mkdirSync(path.dirname(dir), { recursive: true });
  }

  // 1) origin: init on main, initial fixture tree commit.
  fsx.mkdirSync(originRepo, { recursive: true });
  await gitRun(git, originRepo, ['init', '-b', FIXTURE_MAIN_BRANCH], gEnv);
  // SF-14 (US-002): the owned origin is a NON-BARE checkout with the merge
  // target branch (main) checked out — the B-park dirtiness target. Configuring
  // receive.denyCurrentBranch=ignore lets a fast-forward colleague-commit push
  // advance refs/heads/main WITHOUT touching the origin working tree/index, so
  // the checkout stays available for the park action while the ref still moves
  // under a live run (the rugpull observation).
  await gitRun(git, originRepo, ['config', 'receive.denyCurrentBranch', 'ignore'], gEnv);
  writeFixtureTree(fsx, originRepo, FIXTURE_FILES);
  await gitRun(git, originRepo, ['add', '-A'], gEnv);
  await gitRun(git, originRepo, ['commit', '-m', 'rehearsal fixture: tiny owned origin main'], gEnv);
  const mainHead = String((await gitRun(git, originRepo, ['rev-parse', 'HEAD'], gEnv)).stdout ?? '').trim();

  // 2) broken-tests branch (S7 quarantine lane bait): only on the branch.
  await gitRun(git, originRepo, ['checkout', '-b', FIXTURE_BROKEN_BRANCH], gEnv);
  writeFixtureTree(fsx, originRepo, FIXTURE_BROKEN_FILES);
  await gitRun(git, originRepo, ['add', '-A'], gEnv);
  await gitRun(git, originRepo, ['commit', '-m', 'rehearsal fixture: seeded broken test on broken-tests'], gEnv);
  const brokenTestsHead = String((await gitRun(git, originRepo, ['rev-parse', 'HEAD'], gEnv)).stdout ?? '').trim();
  await gitRun(git, originRepo, ['checkout', FIXTURE_MAIN_BRANCH], gEnv);

  // 3) sibling clones (colleague / park vocabulary of --colleague-repo/
  //    --park-repo). Both track the origin as their `origin` remote so the
  //    Round B chaos operators (colleague-commit / dirty-tree) act on real
  //    sibling clones of the same origin.
  for (const dir of [colleagueRepo, parkRepo]) {
    await gitRun(git, reposRoot, ['clone', originRepo, dir], gEnv);
  }

  const capture = (key, p) => {
    const real = realpathOrNearest(p, fsx) ?? p;
    let dev = null;
    let ino = null;
    try {
      const st = fsx.statSync(real);
      dev = st.dev;
      ino = st.ino;
    } catch { /* keep null */ }
    return { key, path: real, realpath: real, dev, ino, capturedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString() };
  };

  const verifyHead = async (label, dir) => {
    const res = await gitRun(git, dir, ['rev-parse', 'HEAD'], gEnv);
    return { label, dir, head: String(res.stdout ?? '').trim() };
  };
  const originHead = await verifyHead('origin', originRepo);
  const colleagueHead = await verifyHead('colleague', colleagueRepo);
  const parkHead = await verifyHead('park', parkRepo);

  return {
    originRepo,
    colleagueRepo,
    parkRepo,
    mainBranch: FIXTURE_MAIN_BRANCH,
    brokenTestsBranch: FIXTURE_BROKEN_BRANCH,
    mainHead,
    brokenTestsHead,
    heads: { origin: originHead.head, colleague: colleagueHead.head, park: parkHead.head, brokenTests: brokenTestsHead },
    files: {
      cc1: 'docs/cc1.md',
      cc2: ROSTER_EDIT_FILE.B3,
      brokenTests: 'tests/broken_test.py',
      readme: 'README.md',
    },
    receipts: {
      origin: capture('origin', originRepo),
      colleague: capture('colleague', colleagueRepo),
      park: capture('park', parkRepo),
    },
    createdAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-run task files. Every roster entry from the ACTUAL ROUND_A_ROSTER /
// ROUND_B_ROSTER gets `<run>.task.md` whose content names the ACTUAL bundled
// workflow id + harness assignment, the orchestrator-owned origin repo, the
// launch context (S7: branch=broken-tests; B4: red-bait; B5: do-now), and the
// exact expected scripted operations/outputs for that roster entry.
// ─────────────────────────────────────────────────────────────────────
export function renderTaskFile(entry) {
  const workflowExpected = WORKFLOW_EXPECTED[entry.workflow]
    ?? `real step sequence of the bundled ${entry.workflow} workflow (its actual workflow.yml shape)`;
  const contextLine = entry.context && entry.context.length > 0
    ? entry.context.map((kv) => `--context ${kv}`).join(' ')
    : 'none';
  const lines = [];
  lines.push(`# STORM SCRIPTED REHEARSAL TASK — roster ${entry.rosterId} (${entry.run})`);
  lines.push('');
  lines.push(`ROSTER_ID: ${entry.rosterId}`);
  lines.push(`ROUND: ${entry.round}`);
  lines.push(`RUN: ${entry.run}`);
  lines.push(`WORKFLOW: ${entry.workflow}`);
  lines.push(`HARNESS: ${entry.harness}`);
  lines.push(`QUEUED: ${entry.queued ? 'true' : 'false'}`);
  lines.push(`RED_BAIT: ${entry.redBait ? 'true' : 'false'}`);
  lines.push(`DO_NOW: ${entry.workflow === 'do-now' ? 'true' : 'false'}`);
  lines.push(`TARGET_BRANCH: ${entry.targetBranch ?? 'main'}`);
  lines.push(`LAUNCH_CONTEXT: ${contextLine}`);
  lines.push(`ORIGIN_REPO: ${entry.originRepo ?? ''}`);
  lines.push(`TASK_AREA: ${entry.taskArea ?? ''}`);
  if (entry.editFile) lines.push(`EDIT_TARGET: ${entry.editFile}`);
  lines.push(`SEED_REF: ${entry.seedRef ?? 'seed/storm'}`);
  lines.push(`REHEARSAL_LABEL: ${REHEARSAL_LABEL}`);
  lines.push('');
  lines.push('## Objective');
  lines.push(entry.objective ?? `Work the ${entry.taskArea ?? 'assigned'} task area in the orchestrator-owned tiny origin repo as the ${entry.harness} roster entry of the ${entry.workflow} workflow.`);
  lines.push('');
  lines.push('## Expected scripted operations');
  lines.push('- Run the ' + workflowExpected + '.');
  lines.push(`- Operate against the orchestrator-owned origin ${entry.originRepo ?? '<origin>'} (tiny infrastructure fixture) with the launch context above.`);
  if (entry.workflow === 'do-now') {
    lines.push('- Complete the trivial do-now change immediately (queue-drain / agitator canary).');
  } else if (entry.redBait) {
    lines.push('- Reproduce the seeded bug area; the scripted fix is DELIBERATELY left red for the union-red bait (B4) — the run is expected to stay red, never to fabricate a green pass.');
  } else if (entry.workflow === 'quarantine-broken-tests-merge-worktree') {
    lines.push('- On the broken-tests lane, isolate the seeded broken test so the quarantine lane can land without breaking main.');
  } else {
    lines.push(`- Make the ${entry.editFile ? 'required edit to ' + entry.editFile : 'required edit'} in a fresh branch from main and land it through the workflow's real step sequence.`);
  }
  lines.push('');
  lines.push('## Expected scripted output');
  lines.push(`- ${entry.expectedOutput ?? 'a truthful terminal run outcome recorded through the real native scheduler/step/merge APIs (zero-model: tokens exactly zero)'}.`);
  if (entry.redBait) {
    lines.push('- The outcome is expected RED (union-red bait); a green completion for this entry is a rehearsal failure, not a pass.');
  }
  if (entry.queued) {
    lines.push('- Queue admission decision is observed from the real scheduler snapshot (admit or queue) and recorded truthfully — never assumed.');
  }
  return lines.join('\n') + '\n';
}

export function provisionTaskFiles({
  fs: fsx = REAL_FS,
  clock = null,
  tasksRoot,
  fixture,
  roster = null,
  seedRef = 'seed/storm',
}) {
  const rosterA = roster?.A ?? ROUND_A_ROSTER;
  const rosterB = roster?.B ?? ROUND_B_ROSTER;
  fsx.mkdirSync(tasksRoot, { recursive: true });
  const manifest = {};
  const taskFiles = {};
  const emit = (r) => {
    const editFile = ROSTER_EDIT_FILE[r.id] ?? null;
    // STORM-REAL US-008: the target branch is derived from the launch context
    // (`branch=broken-tests`), so the lite quarantine entry lands on
    // broken-tests exactly like the full S7 one — never a hardcoded roster id.
    const isBrokenTestsLane = (r.context ?? []).includes('branch=broken-tests');
    const entry = {
      round: r.round,
      rosterId: r.id,
      run: r.run,
      workflow: r.workflow,
      harness: r.harness,
      queued: r.queued ?? false,
      redBait: r.red_bait ?? false,
      taskArea: r.taskArea ?? null,
      context: r.context ?? [],
      targetBranch: isBrokenTestsLane ? FIXTURE_BROKEN_BRANCH : FIXTURE_MAIN_BRANCH,
      originRepo: fixture?.originRepo ?? null,
      editFile,
      seedRef,
      objective: buildObjective(r, editFile),
    };
    if (entry.redBait) {
      entry.expectedOutput = 'the B4 bug-fix run stays RED (union-red bait) with its red evidence retained — a truthful failed outcome';
    } else if (r.workflow === 'do-now') {
      entry.expectedOutput = 'the do-now run completes immediately with the trivial change landed';
    } else if (isBrokenTestsLane) {
      entry.expectedOutput = 'the quarantine lane completes on broken-tests with the seeded broken test isolated and main intact';
    } else {
      entry.expectedOutput = `the ${r.run} run completes through the real ${r.workflow} step sequence and (merge-family) lands its change on main`;
    }
    const content = renderTaskFile(entry);
    const file = path.join(tasksRoot, `${r.run}.task.md`);
    fsx.writeFileSync(file, content);
    taskFiles[r.id] = file;
    manifest[r.run] = { rosterId: r.id, round: r.round, file, workflow: r.workflow, harness: r.harness, queued: entry.queued, redBait: entry.redBait, targetBranch: entry.targetBranch, context: entry.context, taskArea: entry.taskArea };
  };
  for (const r of rosterA) emit(r);
  for (const r of rosterB) emit(r);
  return {
    tasksRoot,
    taskFiles,
    manifest,
    provisionedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString(),
  };
}

function buildObjective(r, editFile) {
  if ((r.context ?? []).includes('branch=broken-tests')) {
    return 'Quarantine-broken-tests lane: the tiny origin repo carries a seeded broken test on the broken-tests branch; the run must isolate that breakage so the lane lands safely.';
  }
  if (r.red_bait === true) {
    return 'Union-red bait: reproduce the seeded rust bug area and leave the fix RED — this run deliberately must not go green.';
  }
  if (r.workflow === 'do-now') {
    return 'Trivial do-now change (queue-drain / agitator canary): make the smallest meaningful edit to the fixture and complete.';
  }
  const area = editFile ? ` in ${editFile}` : '';
  return `Work the "${r.taskArea ?? 'assigned task area'}"${area} of the orchestrator-owned tiny origin repo and land it through the real ${r.workflow} step sequence.`;
}

// ─────────────────────────────────────────────────────────────────────
// US-001 (fix-2, finding S5): per-campaign scripted-runtime behaviors +
// state dir.
//
// The frozen zero-model scripted pi/hermes runtimes read
// TAMANDUA_SCRIPTED_BEHAVIORS (a JSON behaviors file) and
// TAMANDUA_SCRIPTED_STATE (a private state dir). Attempt 2 (run #59) never
// materialized either: runtime-pi.mjs:59 / runtime-hermes.mjs:60 derived
// stateDir='' and runtime-shared.mjs:289 mkdirSync('') threw ENOENT, so every
// work round exited 1 in <1s with no output and each run hit
// run.instant_fail_loop with 0 steps claimed.
//
// These builders derive the contract from the ACTUAL installed/bundled
// workflow.yml files (every step agent, every `expects` literal + regex) so a
// prepared campaign can claim and complete steps with zero models. The
// behaviors are keyed by the FULL '<workflowId>_<agent>' key
// (behaviorForInvocation prefers it) and every entry is { output, tokens: 0 }.
// Materialization is launch-free: it only writes under the OWNED rehearsal
// input root (behaviors file) and the private exec-identity state root (state
// dir) — never into campaignDir, never any deletion, no src/ edit.
// ─────────────────────────────────────────────────────────────────────

export const TT_SCRIPTED_BEHAVIOR = 'TT_SCRIPTED_BEHAVIOR';

// Unescape a YAML double-quoted scalar: \\, \n, \t, \r, \". The storm
// workflows encode inline expects as e.g.
//   "STATUS: done\nregex:^BRANCH:\\s*\\S+"
// so the runtime reparses `\n` as a line break and `\\s` as a regex escape.
export function unescapeYamlDoubleQuoted(value) {
  let v = String(value);
  if (v.startsWith('"')) v = v.slice(1);
  if (v.endsWith('"')) v = v.slice(0, -1);
  let out = '';
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = v[i + 1];
    if (next === undefined) { out += '\\'; break; }
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    if (next === '"') { out += '"'; i += 1; continue; }
    if (next === '\\') { out += '\\'; i += 1; continue; }
    // Unknown escape — keep both characters verbatim (permissive).
    out += `\\${next}`; i += 1;
  }
  return out;
}

// True when a YAML double-quoted scalar that started on this line has its
// closing unescaped `"` on the same line. Used to decide whether an
// `expects: "..."` value is an inline one-liner or a folded multi-line scalar.
function yamlDoubleQuotedIsClosed(value) {
  const v = String(value);
  if (!v.startsWith('"')) return false;
  for (let i = 1; i < v.length; i += 1) {
    if (v[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && v[j] === '\\'; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

// Fold a YAML multi-line double-quoted scalar, mirroring the YAML flow-scalar
// folding rule: a single line break folds to a space, a blank line to a
// newline, and the closing quote's line's leading indentation is stripped.
// `lines` are the raw physical lines WITHOUT the outer quotes; the caller
// passes the opening-line remainder followed by the continuation lines.
export function foldYamlDoubleQuotedMultiline(lines) {
  let out = '';
  let first = true;
  for (const rawLine of lines) {
    const line = String(rawLine).trim();
    if (first) { out = line; first = false; continue; }
    if (line === '') { out += '\n'; continue; }
    if (out.endsWith('\n')) out += line;
    else out += ' ' + line;
  }
  return out;
}

// Parse the `steps:` block of a workflow.yml into
// [{ id, agent, expects, input, type, loop, condition, inputMentionsStoriesJson }].
// Line-oriented and block-scalar aware: an `expects: |` body is collected at
// its own indentation, an `input: |` body is captured for placeholder
// completeness analysis but the body's step-like text is never mistaken for a
// step's agent, and an inline double-quoted expects is unescaped (including a
// YAML multi-line double-quoted scalar, e.g. `feature-dev-github-pr`'s `pr`
// step whose `PR:` regex sits on the folded continuation line).
//
// US-001 (STORM-REHEARSAL-FIX3): every step additionally carries
//   * type: 'step' by default, or the literal `type:` (loop/conditional);
//   * loop: the parsed `loop:` mapping ({ over, completion, fresh_session,
//     verify_each, verify_step }) or null when the step has no loop block;
//   * condition: the literal `condition:` gate or null;
//   * inputMentionsStoriesJson: true when the step's own skipped `input: |`
//     body references STORIES_JSON, so the story-loop producer can be derived
//     from the real graph instead of hardcoded workflow ids.
// The existing id/agent/expects fields and block-scalar/inline-quoted expects
// behavior stay byte-compatible.
export function parseWorkflowSteps(yamlText) {
  const lines = String(yamlText).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^steps:\s*$/.test(lines[i])) i += 1;
  i += 1;
  const steps = [];
  const stepRe = /^ {2}- id:\s*(\S+)\s*$/;
  const keyRe = /^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
  let current = null;
  const flush = () => { if (current) { steps.push(current); current = null; } };
  while (i < lines.length) {
    const line = lines[i];
    const stepM = stepRe.exec(line);
    if (stepM) {
      flush();
      current = {
        id: stepM[1],
        agent: null,
        expects: null,
        input: null,
        type: 'step',
        loop: null,
        condition: null,
        inputMentionsStoriesJson: false,
      };
      i += 1;
      continue;
    }
    if (current) {
      // A top-level key ends the steps section.
      if (line.trim() !== '' && /^\S/.test(line)) { flush(); break; }
      const keyM = keyRe.exec(line);
      if (keyM) {
        const key = keyM[1];
        const value = keyM[2];
        if (key === 'agent') {
          current.agent = value.trim().replace(/^["']|["']$/g, '');
          i += 1;
          continue;
        }
        if (key === 'type') {
          const t = value.trim().replace(/^["']|["']$/g, '');
          if (t !== '') current.type = t;
          i += 1;
          continue;
        }
        if (key === 'condition') {
          current.condition = value.trim().replace(/^["']|["']$/g, '') || null;
          i += 1;
          continue;
        }
        // A `loop:` block is a 6-space mapping immediately under the step.
        // Collect only the keys the product's loop pipeline consumes; unknown
        // nested keys are ignored so the parser stays forward-compatible.
        if (key === 'loop' && value.trim() === '') {
          i += 1;
          const loop = {};
          while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '') { i += 1; continue; }
            const indent = l.length - l.trimStart().length;
            if (indent <= 4) break;
            const loopM = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(l);
            if (loopM) {
              const loopKey = loopM[1];
              const loopVal = loopM[2].trim().replace(/^["']|["']$/g, '');
              if (loopKey === 'fresh_session' || loopKey === 'verify_each') {
                if (loopVal === 'true') loop[loopKey] = true;
                else if (loopVal === 'false') loop[loopKey] = false;
                else if (loopVal !== '') loop[loopKey] = loopVal;
              } else if (loopKey === 'over' || loopKey === 'completion' || loopKey === 'verify_step') {
                if (loopVal !== '') loop[loopKey] = loopVal;
              }
            }
            i += 1;
          }
          current.loop = Object.keys(loop).length > 0 ? loop : null;
          continue;
        }
        if (key === 'input' && /^[|>]/.test(value.trim())) {
          i += 1;
          const body = [];
          while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '') { body.push(''); i += 1; continue; }
            const indent = l.length - l.trimStart().length;
            if (indent <= 4) break;
            body.push(l);
            i += 1;
          }
          // The producer of a story loop is the step whose input instructs the
          // agent to emit STORIES_JSON. Detect it from the real body text.
          if (body.some((l) => /STORIES_JSON/.test(l))) current.inputMentionsStoriesJson = true;
          // US-002: keep the raw input template so feed-forward completeness
          // can derive every {{placeholder}} from the parsed steps.
          current.input = body.join('\n');
          continue;
        }
        if (key === 'input') {
          // Inline input (no block scalar): keep the text for placeholder
          // analysis; it must never contribute an `agent:` step value because
          // the agent key branch above already consumed the real `agent:` line.
          current.input = value.trim();
          i += 1;
          continue;
        }
        if (key === 'expects') {
          const v = value.trim();
          if (/^[|>]/.test(v)) {
            i += 1;
            const body = [];
            let baseIndent = null;
            while (i < lines.length) {
              const l = lines[i];
              if (l.trim() === '') { body.push(''); i += 1; continue; }
              const indent = l.length - l.trimStart().length;
              if (indent <= 4) break;
              if (baseIndent === null) baseIndent = indent;
              body.push(l.slice(Math.min(baseIndent, indent)));
              i += 1;
            }
            while (body.length > 0 && body[body.length - 1] === '') body.pop();
            current.expects = body.join('\n');
            continue;
          }
          if (v.startsWith('"')) {
            // Inline one-liner vs. a folded multi-line double-quoted scalar
            // (e.g. feature-dev-github-pr's `pr` step, whose `PR:` regex sits
            // on the continuation line after a blank line). Consume physical
            // lines until the closing quote, then fold + unescape.
            let acc = v;
            i += 1;
            while (!yamlDoubleQuotedIsClosed(acc) && i < lines.length) {
              acc += '\n' + lines[i];
              i += 1;
            }
            if (/\n/.test(acc)) {
              const parts = acc.replace(/^"/, '').replace(/"\s*$/, '').split('\n');
              current.expects = unescapeYamlDoubleQuoted(`"${foldYamlDoubleQuotedMultiline(parts)}"`);
            } else {
              current.expects = unescapeYamlDoubleQuoted(acc);
            }
            continue;
          }
          current.expects = v;
          i += 1;
          continue;
        }
      }
    }
    i += 1;
  }
  flush();
  return steps;
}

// US-001 (STORM-REHEARSAL-FIX3): derive the story-loop graph for ONE workflow
// from its parsed steps. Pure, side-effect free, no hardcoded workflow ids.
//
// The story-loop is the step with type 'loop' and loop.over === 'stories'. Its
// producer is the step (before the loop, possibly with an intermediate setup
// step between them) whose OWN `input:` body mentions STORIES_JSON. Returns:
//   * producers:   array of producer step objects (exactly one for the bundled
//                  loop-over-stories workflows; [] when there is no loop);
//   * loopStep:    the story-loop step object, or null;
//   * bodyAgent:   the loop-body agent id (developer/fixer), or null;
//   * verifyStep:  the verified verify step's AGENT id (verifier), or null;
//   * verifyStepId: the loop.verify_step step id (verify), or null;
//   * verifyAgent: alias of verifyStep (the resolved verify agent), or null.
export function deriveStoryLoopProducers(steps) {
  const list = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : [];
  const loopStep = list.find((s) => s.type === 'loop' && s.loop && s.loop.over === 'stories') ?? null;
  if (!loopStep) {
    return {
      producers: [],
      loopStep: null,
      bodyAgent: null,
      verifyStep: null,
      verifyStepId: null,
      verifyAgent: null,
    };
  }
  const producers = list
    .slice(0, list.indexOf(loopStep))
    .filter((s) => s.inputMentionsStoriesJson === true);
  const bodyAgent = typeof loopStep.agent === 'string' && loopStep.agent !== '' ? loopStep.agent : null;
  const verifyStepId = typeof loopStep.loop?.verify_step === 'string' && loopStep.loop.verify_step !== ''
    ? loopStep.loop.verify_step
    : null;
  const verifyStepObj = verifyStepId ? list.find((s) => s.id === verifyStepId) ?? null : null;
  const verifyAgent = verifyStepObj && typeof verifyStepObj.agent === 'string' && verifyStepObj.agent !== ''
    ? verifyStepObj.agent
    : null;
  return {
    producers,
    loopStep,
    bodyAgent,
    verifyStep: verifyAgent,
    verifyStepId,
    verifyAgent,
  };
}

// Split one expects block into literal (substring) and regex requirements,
// mirroring validateExpects (src/installer/step-ops.ts): lines prefixed with
// `regex:` are patterns, every other non-empty line is an exact substring.
export function parseExpectsChecks(expectsText) {
  const literals = [];
  const regexes = [];
  for (const rawLine of String(expectsText ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('regex:')) regexes.push(line.slice('regex:'.length));
    else literals.push(line);
  }
  return { literals, regexes };
}

// Sample output lines covering every KEY the STORM_WORKFLOW_IDS expects
// reference. Order matters: `STATUS: done` is first so the normal-success
// variant is chosen whenever a regex accepts it, and `REBASED: false` is
// preferred over the retry alternation in the merge-family expects.
const SCRIPTED_OUTPUT_CANDIDATES = Object.freeze([
  'STATUS: done',
  'REBASED: false',
  'MERGE_COMMIT: 0000000',
  'MERGED_INTO: main',
  'MERGED_TREE: {{gitTree}}',
  // SF-15 (US-004): the feature branch is RUN-SCOPED. A single shared branch
  // name meant a squash merge left target.tree == shared-branch.tree, so every
  // later run (and every concurrently-held B1..B4 run) saw its merge branch
  // already at the target tip and the product landed a noop:true /
  // "already-coherent" merge. The `{{input.RUN_ID}}` placeholder is resolved by
  // the scripted runtime from the claimed run id (bare uuid), so each run's
  // merge branch is distinct and provably ahead of the target.
  'BRANCH: storm-scripted-fixture-{{input.RUN_ID}}',
  'REPO: {{cwd}}',
  'BUILD_CMD: true',
  'TEST_CMD: true',
  'CHANGES: scripted rehearsal fixture change',
  'TESTED_TREE: {{gitTree}}',
  'VERIFIED: scripted rehearsal verification passed',
  'VERDICT: HONEST',
  'VERDICT: ACCEPT',
  'SEVERITY: high',
  'AFFECTED_AREA: go/workerpool/pool.go',
  'REPRODUCTION: the owned fixture reproduces the seeded bug deterministically',
  'PROBLEM_STATEMENT: the seeded fixture bug is deterministic',
  'ROOT_CAUSE: the fixture carries a stale scripted value',
  'FIX_APPROACH: update the stale fixture value in place',
  'REGRESSION_TEST: scripted rehearsal regression check',
  'CANNOT_REPRODUCE: scripted rehearsal has no live reproduction; deterministic fixture path used',
  'REPRO_EVIDENCE: scripted rehearsal deterministic reproduction',
  'VULNERABILITY_COUNT: 0',
  'FINDINGS: no real vulnerabilities in the tiny owned fixture',
  'FIX_PLAN: scripted rehearsal fix plan for the tiny owned fixture',
  'CRITICAL_COUNT: 0',
  'HIGH_COUNT: 0',
  'DISABLED: 0',
  'SUMMARY: scripted rehearsal quarantine summary',
  'REPORT: scripted rehearsal report',
  'FEEDBACK: scripted rehearsal feedback',
  'ISSUES: none',
  'DETAILS: scripted rehearsal details',
  'STATUS: retry',
]);

// First candidate line that satisfies one expects regex source (m flag, no g).
// Returns null when nothing matches so the caller can fail closed.
export function scriptedLineForRegex(regexSource, candidates = SCRIPTED_OUTPUT_CANDIDATES) {
  let re;
  try {
    re = new RegExp(String(regexSource), 'm');
  } catch (err) {
    throw refusal(`invalid expects regex ${JSON.stringify(regexSource)}: ${err?.message ?? String(err)}`, TT_SCRIPTED_BEHAVIOR);
  }
  for (const line of candidates) {
    re.lastIndex = 0;
    if (re.test(line)) return line;
  }
  return null;
}

// ── US-002: deterministic regex-line synthesizer ──────────────────────
// Fallback used ONLY when no SCRIPTED_OUTPUT_CANDIDATES line matches an
// expects regex. Mirrors the proven synthesis in
// tests/workflow-graph-simulation.test.ts so the generated behaviors cover
// every bundled workflow's expects without a hand-maintained candidate list:
//   * key-position alternation `^(KEY1|KEY2):` → pick the first KEY;
//   * URL value pattern → a synthetic github pull URL;
//   * REBASED with a `false` alternative → false (never claim a rebase);
//   * value-position alternation `(a|b|c)` → pick the first (closed enum);
//   * `\d+` → a digit; any other value → a non-space `scripted-<key>` token.
// It never emits a STATUS line unless the regex itself is a STATUS pattern.
export function synthesizeScriptedRegexLine(regexSource) {
  const regexBody = String(regexSource).replace(/^regex:/, '');
  let key = null;
  let valuePattern = '';
  const altKeyMatch = regexBody.match(/^\^?\(([A-Z_|]+)\):(.*)/);
  if (altKeyMatch) {
    key = altKeyMatch[1].split('|')[0].trim();
    valuePattern = altKeyMatch[2];
  } else {
    const keyMatch = regexBody.match(/^\^?([A-Z_]+):(.*)/);
    if (!keyMatch) return 'synthetic: scripted-value';
    key = keyMatch[1];
    valuePattern = keyMatch[2];
  }
  if (/:\/\//.test(valuePattern)) {
    return `${key}: https://github.com/scripted-org/scripted-repo/pull/1`;
  }
  if (key === 'REBASED' && /\bfalse\b/.test(valuePattern)) {
    return `${key}: false`;
  }
  const altMatch = valuePattern.match(/\(([^)]+)\)/);
  if (altMatch) {
    const firstAlt = altMatch[1].split('|')[0].trim();
    return `${key}: ${firstAlt}`;
  }
  if (/\\d\+/.test(valuePattern)) {
    return `${key}: 0`;
  }
  return `${key}: scripted-${key.toLowerCase()}`;
}

// US-002: `RESERVED_CONTEXT_KEYS` mirrors the private set in
// src/installer/step-ops.ts (not exported there). These are agent-unwritable
// structural keys seeded/written by the run pipeline, so the feed-forward
// completeness pass never synthesizes them.
const RESERVED_CONTEXT_KEYS = new Set([
  'repo',
  'working_directory_for_harness',
  'task',
  'run_id',
  'workspace_mode',
  'worktree_path',
  'worktree_origin_repository',
  'worktree_origin_ref',
  'worktree_origin_sha',
  'original_branch',
  'merge_gate',
  'fail_missing',
  'test_cmd_raw',
  'test_cmd_review_required',
  'test_cmd_review_candidate',
  'test_cmd_review_established',
  'test_cmd_rewriter_step',
]);

// Keys the run/harness (or the caller) provides without any step producing
// them. Kept as ONE predicate so buildRehearsalScriptedBehaviors and the
// completeness self-test agree.
export function isRunProvidedContextKey(key, workflowId = null) {
  const k = String(key ?? '').toLowerCase();
  if (AUTO_CONTEXT_KEYS.has(k)) return true;
  if (HARNESS_SEEDED_CONTEXT_KEYS.has(k)) return true;
  if (RESERVED_CONTEXT_KEYS.has(k)) return true;
  if (workflowId && Array.isArray(CALLER_PROVIDED[workflowId]) && CALLER_PROVIDED[workflowId].includes(k)) return true;
  return false;
}

// Collect every {{placeholder}} referenced by a template, lowercased.
export function collectPlaceholders(template) {
  const keys = new Set();
  String(template ?? '').replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_m, key) => {
    keys.add(String(key).toLowerCase());
    return '';
  });
  return keys;
}

// The output keys a step's generated behavior will actually contain: literal
// `KEY:` lines plus the KEY of the candidate/synthesized line chosen for each
// expects regex (alternation-aware). For a key-position alternation
// (`^(KEY1|KEY2):`) ALL branches count as produced keys, mirroring the
// product's either/or normalization in step-ops (the absent branch is
// normalized to "" rather than triggering a MISS), so feed-forward never
// synthesizes the other branch. Used for feed-forward gap detection.
export function generatedOutputKeys(expectsText) {
  const keys = new Set();
  const checks = parseExpectsChecks(expectsText);
  for (const literal of checks.literals) {
    const m = /^([A-Z_]+):/.exec(literal);
    if (m) keys.add(m[1].toLowerCase());
  }
  for (const source of checks.regexes) {
    const altKey = /^\^?\(([A-Z_|]+)\):/.exec(String(source).replace(/^regex:/, ''));
    if (altKey) for (const k of altKey[1].split('|')) keys.add(k.trim().toLowerCase());
    const line = scriptedLineForRegex(source) ?? synthesizeScriptedRegexLine(source);
    const m = /^([A-Z_]+):/.exec(line);
    if (m) keys.add(m[1].toLowerCase());
  }
  return keys;
}

// Build one agent's step-complete output: every literal requirement plus one
// matching sample line per regex requirement. A regex with no candidate match
// falls back to the deterministic synthesizer (never throws for a well-formed
// KEY: regex).
export function buildScriptedOutputForChecks(checks, { candidates = SCRIPTED_OUTPUT_CANDIDATES } = {}) {
  const lines = [];
  const push = (line) => { if (line && !lines.includes(line)) lines.push(line); };
  for (const literal of checks?.literals ?? []) push(literal);
  for (const source of checks?.regexes ?? []) {
    const line = scriptedLineForRegex(source, candidates) ?? synthesizeScriptedRegexLine(source);
    push(line);
  }
  if (lines.length === 0) push('STATUS: done');
  return lines.join('\n');
}

// The real tamandua merge-branch invocation the merger behavior runs, mirroring
// torture-test/scenarios/w4.39a/behaviors.json. The origin worktree/index is
// read-only; the only origin-ref mutation is through tamandua merge-branch.
export const MERGER_MERGE_BRANCH_COMMAND = [
  `EXPECT_TIP="$(git -C '{{input.WORKTREE_ORIGIN_REPOSITORY}}' rev-parse 'refs/heads/{{input.ORIGINAL_BRANCH}}')"`,
  `MESSAGE_FILE="$(mktemp)"`,
  `printf 'fix: scripted rehearsal merge\\n\\nCo-Authored-By: Tamandua <tamandua@tetradactyla.org>\\n' > "$MESSAGE_FILE"`,
  `tamandua merge-branch --origin '{{input.WORKTREE_ORIGIN_REPOSITORY}}' --branch '{{input.BRANCH}}' --into '{{input.ORIGINAL_BRANCH}}' --expect-tip "$EXPECT_TIP" --message "$(cat "$MESSAGE_FILE")"`,
  `MERGE_EXIT=$?`,
  `rm -f "$MESSAGE_FILE"`,
  `exit $MERGE_EXIT`,
].join('; ');

// Ensure a merger output carries the truthful merged-branch attestation keys
// (STATUS: done + REBASED: false + MERGED_*), independent of which expects
// regex the generic builder happened to satisfy.
export function withMergerOutputKeys(output) {
  const lines = String(output ?? '').split('\n').filter((l) => l.trim() !== '');
  for (const line of ['STATUS: done', 'REBASED: false', 'MERGE_COMMIT: 0000000', 'MERGED_INTO: main', 'MERGED_TREE: {{gitTree}}']) {
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.join('\n');
}

// ── US-007 (SF-2 completion): the feature branch the merger must find ──
// SF-2's launch-origin containment was only half the fix: the merger's real
// `tamandua merge-branch --branch {{input.BRANCH}}` requires
// refs/heads/<BRANCH> to already exist in the owned origin, but no scripted
// behavior ever created it (only the real setup agent would `git checkout -b`).
// The scripted loop-body/feature agent of a merge-family workflow therefore
// creates the branch AND commits a real change in the harness cwd (the managed
// worktree) before reporting. This exercises the real merge path end-to-end
// (branch → commit → squash merge) instead of masking it with a non-mutating
// canned merger. The command only ever touches the harness cwd (never HOME or
// this repository). It is fail-closed (the branch must actually be checked
// out) and idempotent: a retry re-checks out the existing run-scoped branch
// and appends a fresh change so the commit always has content.

// The branch name comes from the rendered step input (`BRANCH:` from the
// upstream producer); `substitute` refuses at runtime if the key is absent.
// The build-time gate below proves the feature step's own input references
// `{{branch}}`, so a merge-family behavior can never be emitted without a
// resolvable BRANCH.
//
// The repo-local `user.name`/`user.email` are part of the fixture setup: the
// daemon env is hermetic (`env -i` + the rendered env script exports no git
// identity), and the merger's squash commit is created by
// `runPlumbingMerge -> git commit-tree`, which reads the repository config. A
// repo-local identity (written into the owned origin's shared config by this
// command, never `--global`) lets the real merge path complete.
// US-004 (SF-15): the branch name is run-scoped (the producer's BRANCH carries
// the run uuid) and the committed file is run-scoped too. This makes EVERY
// run's merge branch strictly ahead of the current target tip -- a shared
// branch + shared file meant B1's squash merge left target.tree ==
// branch.tree, so B2..B4 merged no-ops (noop:true / "already-coherent") and
// concurrent B runs raced the same ref. A per-run file also keeps the four
// concurrent B branches conflict-free when they all merge into main.
export const FEATURE_BRANCH_COMMIT_COMMAND = [
  `BRANCH='{{input.BRANCH}}'`,
  `git config user.name 'Storm Rehearsal'`,
  `git config user.email 'storm-rehearsal@localhost'`,
  `git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"`,
  `[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || { echo "storm: feature branch $BRANCH was not checked out" >&2; exit 3; }`,
  `mkdir -p .storm-rehearsal`,
  `FILE=".storm-rehearsal/$(printf '%s' "$BRANCH" | tr '/' '_').txt"`,
  `printf 'scripted rehearsal change %s\\n' "$(date +%s%N)" >> "$FILE"`,
  `git add "$FILE"`,
  `git -c user.name='Storm Rehearsal' -c user.email='storm-rehearsal@localhost' commit -m 'chore: scripted rehearsal change'`,
].join('; ');

// ── NPF-2 (STORM-REHEARSAL-FIX10, US-001): real suite-ledger evidence ──
// The product's finalize_merge ledger gate refuses the first landing unless a
// matching TSTX suite execution exists for the exact tested tree:
//   "Ledger gate refused finalize_merge: no matching TSTX suite execution
//    exists / LEDGER_EVIDENCE: missing"
// The REAL tester clears that gate by executing the shim-wrapped TEST_CMD
// verbatim (see agents/shared/.../tester AGENTS.md: "Run the test suite with
// EXACTLY the command given in {{test_cmd}} ... may be wrapped in a caching
// shim (tamandua-test ...)"), which records a real green suite_results row via
// the product's public seam. The scripted rehearsal's tester/verifier step
// previously only printed TESTED_TREE, so every merge run paid a spurious
// first-attempt reroute (NPF-2). This command makes the scripted step do what
// the real tester does.
//
// It is intentionally the UNRESOLVED step-input placeholder: the product
// renders the claim-time input's `TEST_CMD:` value (the shim-wrapped command)
// into it, so the only mechanism that records evidence is invoking the shim.
// Nothing here (or anywhere else) writes a suite_results row directly.
export const TESTER_SUITE_EVIDENCE_COMMAND = '{{input.TEST_CMD}}';

// A step "names the branch" when its own input template interpolates the
// `{{branch}}` context key (the producer's BRANCH output). Graph-derived only.
function stepNamesBranch(step) {
  return collectPlaceholders(step?.input ?? '').has('branch');
}

// Derive the agent whose scripted behavior must create the feature branch:
// the story-loop body agent (developer/fixer) when the workflow has a loop,
// otherwise the first branch-naming, non-setup, non-merger step after the
// environment-setup step (quarantine's `quarantiner`, bug-fix's `fixer`).
// Returns the owning step or null. A null result is a BUILD-TIME refusal at
// the call site (fail closed), never a runtime `{{input.BRANCH}}` failure.
export function deriveFeatureCommitAgent(steps) {
  const list = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : [];
  const loop = deriveStoryLoopProducers(list);
  if (loop.bodyAgent) {
    return list.find((s) => s.agent === loop.bodyAgent && stepNamesBranch(s)) ?? null;
  }
  const setupIdx = list.findIndex((s) => s.id === 'setup' || /checkout\s+-b/.test(String(s?.input ?? '')));
  for (let i = setupIdx >= 0 ? setupIdx + 1 : 0; i < list.length; i += 1) {
    const step = list[i];
    if (!step.agent || step.agent === 'merger') continue;
    if (stepNamesBranch(step)) return step;
  }
  return null;
}

// NPF-2 (US-001): derive the agent that must record REAL suite-ledger evidence
// for the run's tested tree. That is the agent of the step whose OWN `expects`
// attests a TESTED_TREE (the tester in feature-dev/security-audit-merge, the
// verifier in bug-fix/quarantine-broken-tests-merge). Graph-derived only: no
// workflow/agent id is hardcoded, so a catalog reshuffle moves the evidence
// command with the step. Returns the agent id, or null when the graph has no
// TESTED_TREE step (non-merge workflows, do-now, do-review-do-verify).
export function deriveTestedTreeAgent(steps) {
  const list = Array.isArray(steps) ? steps.filter((s) => s && typeof s === 'object') : [];
  for (const step of list) {
    const checks = parseExpectsChecks(step.expects ?? '');
    const mentionsTestedTree = [...checks.regexes, ...checks.literals]
      .some((entry) => /\bTESTED_TREE\b/.test(String(entry)));
    if (!mentionsTestedTree) continue;
    return typeof step.agent === 'string' && step.agent !== '' ? step.agent : null;
  }
  return null;
}

// ── US-003 (STORM-REHEARSAL-FIX3, SF-1): the generated story plan ─────
// Step-ops requires a literal `STORIES_JSON: [...]` block on a story
// producer's output whenever a downstream step is `type: loop, over: stories`
// (parseAndInsertStories plus the no-STORIES_JSON guard in completeStep).
// Without it the producer is re-pended and exhausts retries. The block must
// satisfy the product's two-phase validation: a JSON array of stories, each
// with non-empty id/title/description and a non-empty acceptanceCriteria
// array; ids unique and matching ^[A-Z]+-\d+$; at most 20 stories. One
// deterministic two-story plan is used for every workflow — the loop drains
// it, and the validator pins the shape.
export const SCRIPTED_STORY_COUNT = 2;

export function scriptedStories() {
  return Array.from({ length: SCRIPTED_STORY_COUNT }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `US-${n}`,
      title: `Scripted rehearsal story ${n}`,
      description: `Deliver scripted rehearsal story ${n} inside the owned fixture.`,
      acceptanceCriteria: [
        `The story ${n} change is applied in the owned fixture`,
        `Tests for story ${n} pass`,
        'Typecheck passes',
      ],
    };
  });
}

// The JSON text that follows the `STORIES_JSON: ` prefix, on ONE physical
// line. parseAndInsertStories stops collecting at the next `^[A-Z_]+:\s`
// line, so the plan must never be split across lines.
export function scriptedStoriesJson() {
  return JSON.stringify(scriptedStories());
}

export function scriptedStoriesJsonLine() {
  return `STORIES_JSON: ${scriptedStoriesJson()}`;
}

// Append exactly ONE STORIES_JSON line to a producer's generated output, as
// the LAST line, so the parser's `^[A-Z_]+:\s` truncation rule cannot cut off
// the FIX_PLAN/BUILD_CMD/BRANCH keys that precede it. Idempotent: any
// pre-existing STORIES_JSON line is removed first.
export function appendScriptedStoriesJson(output) {
  const lines = String(output ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('STORIES_JSON:'));
  lines.push(scriptedStoriesJsonLine());
  return lines.join('\n');
}

// US-002: feed-forward completeness. Walk the workflow graph in step order
// and, for every {{placeholder}} a LATER step references that the run context
// does not provide and that no step before the consumer produces, attach one
// `KEY: scripted-<key>` line to the earliest step. This mirrors how real
// agents feed context forward and keeps the step-ops MISS check from dead-
// locking on an unresolved template. Keys the run/harness seeds
// (AUTO_CONTEXT_KEYS + HARNESS_SEEDED_CONTEXT_KEYS + RESERVED_CONTEXT_KEYS +
// CALLER_PROVIDED for the workflow) are never synthesized, which keeps the six
// established SCRIPTED_REHEARSAL workflows' outputs byte-identical.
// Pure: derived only from the parsed steps (no hardcoded workflow ids/keys).
export function deriveFeedForwardKeys(steps, workflowId = null) {
  const list = Array.isArray(steps) ? steps : [];
  const inputs = list.map((s) => collectPlaceholders(s?.input ?? ''));
  const produced = list.map((s) => generatedOutputKeys(s?.expects ?? ''));
  const emitted = new Set();
  const feedForward = list.map(() => new Set());
  for (let i = 0; i < list.length; i += 1) {
    for (const key of produced[i]) emitted.add(key);
    for (let j = i + 1; j < list.length; j += 1) {
      for (const key of inputs[j]) {
        if (emitted.has(key)) continue;
        if (isRunProvidedContextKey(key, workflowId)) continue;
        // If a step between i and the consumer produces the key, the producer
        // covers it and no feed-forward is needed.
        let covered = false;
        for (let k = i + 1; k < j; k += 1) {
          if (produced[k].has(key)) { covered = true; break; }
        }
        if (covered) continue;
        feedForward[i].add(key);
        emitted.add(key);
      }
    }
  }
  return feedForward;
}

// ── US-003 (STORM-REHEARSAL-FIX4): campaign-controlled mid-flight hold ──
// Every storm roster run must stay ACTIVE (step claimed, worker alive) until
// the engine releases it, so the concurrency window and Round B chaos phases
// observe LIVE targets (requirement 1a). The generated behaviors attach ONE
// designated hold-bearing agent per workflow:
//   * merge-family (id ends with '-merge-worktree') -> the `merger`. The
//     scripted runtime applies the hold BEFORE a behavior's commands, so the
//     real `tamandua merge-branch` runs only after release — that is the
//     pre-merge landing window the kill/park/rugpull/cc2 chaos needs.
//   * non-merge (do-review-do-verify, do-now) -> the FIRST step agent from
//     parseWorkflowSteps().
//
// The runtime's applyHold owns the fail-closed bound: it never blocks past
// behavior.hold.timeoutMs and writes a `<runId>.missed` marker on expiry, so
// a stuck engine can never leave a run held forever. US-004 derives the exact
// value from the SCRIPTED_REHEARSAL hold schedule and passes it in via
// `holdTimeoutMs`; until then HOLD_TIMEOUT_MS is the safe fallback and matches
// both the runtime's DEFAULT_HOLD_TIMEOUT_MS and the schedule's own default
// holdTimeoutMs (1_800_000).
export const HOLD_ID = 'storm-midflight';
export const HOLD_TIMEOUT_MS = 1_800_000;

// A bounded positive hold timeout: a non-positive/non-finite override (a future
// derived schedule bug) can never disable the runtime's fail-closed bound.
export function boundedHoldTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : HOLD_TIMEOUT_MS;
}

// ─────────────────────────────────────────────────────────────────────
// US-004 (STORM-REHEARSAL-FIX4) — deriveScriptedHoldSchedule
//
// The REAL storm paces Round B off a 5400s+ clock (B-cc1 at 15min through
// B-bounce at 150min). Zero-model SCRIPTED_REHEARSAL runs finish in seconds,
// so every live-target chaos phase resolved `run_terminal` before it was due
// (attempt-4 SF-8): the stop/delete/relaunch lineage was never exercised.
//
// On the tiny fixture the campaign instead HOLDS every roster run at a
// mid-flight checkpoint (US-002/US-003) and DERIVES the Round B offsets from
// that hold schedule, so a chaos phase fires while its target is live and the
// target is released only after the last phase that structurally depends on
// it. The derived schedule is a pure projection of the engine's real
// ROUND_B_PHASES (same ids, labels and action objects, verbatim) — only the
// offsets and the wait predicate change (kind:'hold', marker:'hold-confirmed',
// targets = the real predicate's targets). What the REAL storm measures is
// untouched: this is only consumed when a campaign records
// `state.rehearsal.hold_schedule` (rehearsalPrepare).
//
// `release_targets` for a phase is the set of roster ids for which THIS phase
// is the LAST derived phase that structurally depends on them (its
// waitFor.targets OR its action target). Releasing any earlier would make a
// later predicate unsatisfiable (e.g. `other-four-mid-flight` needs B1-B4
// live through B-stopdel; `rugpull-recovered` needs B1-B4 live through
// B-bounce). Default outcome: B1..B4 release after B-bounce; B5 (the only
// stop/delete/relaunch target) after B-stopdel. The engine's US-008 release
// path also fails closed — a derived phase recorded missed/not_run releases
// its targets, and the runtime's bounded hold timeout is the final backstop.
// ─────────────────────────────────────────────────────────────────────

export const SCRIPTED_HOLD_SCHEDULE_DEFAULTS = Object.freeze({
  phaseStepMs: 20_000,
  startOffsetMs: 30_000,
  holdTimeoutMs: HOLD_TIMEOUT_MS,
});

// The Round A roster ids the eight-concurrent-window observation releases
// (all S1..S10; S9/S10 are admitted/released separately). Derived from the
// roster so it can never disagree with the launch plan.
export const SCRIPTED_ROUND_A_RELEASE_TARGETS = Object.freeze(
  ROUND_A_ROSTER.map((r) => r.id),
);

function positiveMsOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeMsOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The structural dependency set of a real Round B phase: its wait predicate's
// declared targets (phaseWaitTargetRosterIds semantics) UNION its action
// targets. Used to decide each target's LAST dependent phase.
function scriptedPhaseDependencySet(ph) {
  const deps = new Set(phaseWaitTargetRosterIds(ph));
  for (const rid of phaseTargetRosterIds(ph.action)) deps.add(rid);
  return deps;
}

// Pure SCRIPTED_REHEARSAL hold/phase schedule. Never mutates the real table.
// STORM-REAL US-008: `phases` defaults to the authoritative full ROUND_B_PHASES
// table (unchanged) and may be the reduced lite plan; `roundAReleaseTargets`
// defaults to the full S1..S8 release set and may be the lite four.
export function deriveScriptedHoldSchedule({
  phaseStepMs = SCRIPTED_HOLD_SCHEDULE_DEFAULTS.phaseStepMs,
  startOffsetMs = SCRIPTED_HOLD_SCHEDULE_DEFAULTS.startOffsetMs,
  holdTimeoutMs = SCRIPTED_HOLD_SCHEDULE_DEFAULTS.holdTimeoutMs,
  phases: phasesInput = null,
  roundAReleaseTargets = null,
} = {}) {
  const stepMs = positiveMsOr(phaseStepMs, SCRIPTED_HOLD_SCHEDULE_DEFAULTS.phaseStepMs);
  const startMs = nonNegativeMsOr(startOffsetMs, SCRIPTED_HOLD_SCHEDULE_DEFAULTS.startOffsetMs);
  const holdMs = boundedHoldTimeoutMs(holdTimeoutMs);
  const sourcePhases = Array.isArray(phasesInput) && phasesInput.length > 0 ? phasesInput : ROUND_B_PHASES;
  const releaseTargets = Array.isArray(roundAReleaseTargets) && roundAReleaseTargets.length > 0
    ? roundAReleaseTargets
    : SCRIPTED_ROUND_A_RELEASE_TARGETS;

  const dependencySets = sourcePhases.map((ph) => scriptedPhaseDependencySet(ph));
  // Last derived phase index that structurally depends on each roster id.
  const lastDependentIndex = new Map();
  dependencySets.forEach((deps, idx) => {
    for (const rid of deps) lastDependentIndex.set(rid, idx);
  });

  const phases = sourcePhases.map((ph, idx) => ({
    id: ph.id,
    label: ph.label,
    earliest_offset_ms: startMs + idx * stepMs,
    real_earliest_offset_ms: ph.earliestOffsetMs,
    waitFor: {
      kind: 'hold',
      marker: 'hold-confirmed',
      // The predicate observes the SAME runs the real predicate depends on, so
      // a phase fires only while its live held targets are still parked.
      targets: phaseWaitTargetRosterIds(ph),
    },
    // Copied verbatim from the real table (same object contents; the derived
    // schedule must never invent a different chaos action).
    action: ph.action,
    release_targets: [...dependencySets[idx]]
      .filter((rid) => lastDependentIndex.get(rid) === idx)
      .sort(),
  }));

  return {
    profile: REHEARSAL_PROFILE,
    hold_id: HOLD_ID,
    hold_timeout_ms: holdMs,
    round_a: {
      release_trigger: 'eight_concurrent_window',
      sample_interval_ms: 15_000,
      window_deadline_ms: 2_400_000,
      release_targets: [...releaseTargets],
    },
    round_b: {
      start_offset_ms: startMs,
      phase_step_ms: stepMs,
      phases,
    },
  };
}

// Convenience accessor (US-008 consumes the derived phase list): the Round B
// phase projection of deriveScriptedHoldSchedule().
export function scriptedRoundBPhases(opts = {}) {
  return deriveScriptedHoldSchedule(opts).round_b.phases;
}

// Build the complete behaviors document for STORM_WORKFLOW_IDS from the
// ACTUAL workflow.yml texts. Top level is { agents, heartbeatTokens,
// defaultTokens }; every agent is keyed '<workflowId>_<agent>' with
// { output, tokens: 0 } (merge-family mergers additionally carry the real
// merge-branch command + includeCommandOutput; the designated hold agent
// carries hold: { id: HOLD_ID, timeoutMs }; NPF-2: the TESTED_TREE-producing
// agent of a merge-family workflow additionally runs the shim-wrapped
// TEST_CMD so the product's finalize_merge ledger gate lands on the first
// attempt).
export function buildRehearsalScriptedBehaviors({
  workflowTexts,
  workflowIds = STORM_WORKFLOW_IDS,
  holdTimeoutMs = HOLD_TIMEOUT_MS,
  suiteEvidence = true,
} = {}) {
  const resolvedHoldTimeoutMs = boundedHoldTimeoutMs(holdTimeoutMs);
  if (!workflowTexts || typeof workflowTexts !== 'object') {
    throw refusal('buildRehearsalScriptedBehaviors requires a workflowTexts map of workflowId -> workflow.yml text', 'TT_USAGE');
  }
  const agents = {};
  const agentKeys = [];
  for (const wf of workflowIds) {
    const yamlText = workflowTexts[wf];
    if (typeof yamlText !== 'string' || yamlText.trim() === '') {
      throw refusal(`buildRehearsalScriptedBehaviors: no workflow.yml text supplied for ${wf}`, 'TT_CATALOG');
    }
    const steps = parseWorkflowSteps(yamlText);
    if (steps.length === 0) {
      throw refusal(`buildRehearsalScriptedBehaviors: no steps parsed from ${wf}/workflow.yml`, 'TT_CATALOG');
    }
    // US-003: derive the story-loop graph so the producer's output carries a
    // STORIES_JSON plan and the loop body / loop verify agent each carry one
    // behavior entry per emitted story. Graph-derived only (no workflow ids).
    const storyLoop = deriveStoryLoopProducers(steps);
    const producerAgents = new Set(
      storyLoop.producers.map((p) => p.agent).filter((a) => typeof a === 'string' && a !== ''),
    );
    const storyLoopAgents = new Set(
      [storyLoop.bodyAgent, storyLoop.verifyAgent].filter((a) => typeof a === 'string' && a !== ''),
    );
    // NPF-2 (US-001): the graph agent whose expects attest TESTED_TREE. Only
    // merge-family workflows consume this (do-now / do-review-do-verify have no
    // merge gate), and it is derived from the parsed steps, never hardcoded.
    const testedTreeAgent = deriveTestedTreeAgent(steps);
    // US-007 (SF-2 completion): a merge-family workflow's real merger runs
    // `tamandua merge-branch --branch {{input.BRANCH}}`, which requires
    // refs/heads/<BRANCH> to already exist in the owned origin. Refuse at BUILD
    // time (fail closed) when the graph has no branch-naming feature agent,
    // rather than emit a behavior whose `{{input.BRANCH}}` would fail at runtime.
    const isMergeFamily = String(wf).endsWith('-merge-worktree');
    let featureCommitAgent = null;
    if (isMergeFamily) {
      const featureStep = deriveFeatureCommitAgent(steps);
      if (!featureStep || !featureStep.agent) {
        throw refusal(
          `buildRehearsalScriptedBehaviors: merge-family workflow ${wf} has no branch-naming feature agent; refusing to emit a merger whose BRANCH can never exist`,
          'TT_CATALOG',
        );
      }
      featureCommitAgent = featureStep.agent;
    }
    // US-003: exactly one designated hold-bearing agent per workflow (the
    // merger for merge-family, the first step agent otherwise). The hold makes
    // the run stay ACTIVE until the engine releases it.
    const holdAgent = isMergeFamily ? 'merger' : (steps[0]?.agent ?? null);
    if (!holdAgent) {
      throw refusal(`buildRehearsalScriptedBehaviors: workflow ${wf} has no first step agent to hold`, 'TT_CATALOG');
    }
    const feedForward = deriveFeedForwardKeys(steps, wf);
    const feedForwardByAgent = {};
    for (let idx = 0; idx < steps.length; idx += 1) {
      const agentId = steps[idx].agent;
      if (!agentId) continue;
      for (const key of feedForward[idx]) (feedForwardByAgent[agentId] ??= new Set()).add(key);
    }
    const byAgent = {};
    for (const step of steps) {
      if (!step.agent) continue;
      (byAgent[step.agent] ??= []).push(step.expects ?? '');
    }
    for (const [agent, expectsList] of Object.entries(byAgent)) {
      const literals = new Set();
      const regexes = new Set();
      for (const expectsText of expectsList) {
        const checks = parseExpectsChecks(expectsText);
        for (const l of checks.literals) literals.add(l);
        for (const r of checks.regexes) regexes.add(r);
      }
      let output = buildScriptedOutputForChecks({ literals: [...literals], regexes: [...regexes] });
      const ff = feedForwardByAgent[agent];
      if (ff && ff.size > 0) {
        const outLines = output.split('\n');
        const haveKeys = new Set();
        for (const line of outLines) {
          const m = /^([A-Z_]+):/.exec(line);
          if (m) haveKeys.add(m[1].toLowerCase());
        }
        for (const key of [...ff].sort()) {
          if (haveKeys.has(key)) continue;
          outLines.push(`${key.toUpperCase()}: scripted-${key}`);
        }
        output = outLines.join('\n');
      }
      // US-003 (SF-1): story producers emit exactly one STORIES_JSON plan, as
      // the last line. Only producers (steps whose own input mentions
      // STORIES_JSON and that precede a loop-over-stories) get the block.
      if (producerAgents.has(agent)) {
        output = appendScriptedStoriesJson(output);
      }
      // US-003: a loop body agent (developer/fixer) and the loop's verify
      // agent (verifier) are invoked once per story, each in a fresh session.
      // Emit an ARRAY of one valid behavior per emitted story; the runtime
      // consumes one entry per invocation and repeats the last, so retries and
      // extra invocations always get an output that satisfies the step's
      // expects (each entry is the agent's full merged output).
      let behavior;
      if (storyLoopAgents.has(agent)) {
        behavior = Array.from({ length: SCRIPTED_STORY_COUNT }, () => ({ output, tokens: 0 }));
      } else {
        behavior = { output, tokens: 0 };
      }
      // US-007: the loop-body/feature agent of a merge-family workflow creates
      // the run's feature branch and commits a real change in the harness cwd
      // (the managed worktree), so the merger's real merge-branch finds it.
      // Additive: the canned output is unchanged so every existing expects still
      // passes. Arrays (loop-body agents) get the command on every entry.
      if (isMergeFamily && agent === featureCommitAgent) {
        const entries = Array.isArray(behavior) ? behavior : [behavior];
        for (const entry of entries) {
          entry.commands = [...(entry.commands ?? []), FEATURE_BRANCH_COMMIT_COMMAND];
        }
      }
      if (agent === 'merger' && isMergeFamily) {
        behavior.output = withMergerOutputKeys(output);
        behavior.includeCommandOutput = true;
        behavior.commands = [MERGER_MERGE_BRANCH_COMMAND];
      }
      // NPF-2 (US-001): attach the shim-backed suite-evidence command to the
      // TESTED_TREE-producing agent of a merge-family workflow. Additive: the
      // canned output/hold/commands are preserved. Running the rendered
      // `{{input.TEST_CMD}}` (the product's own shim wrapper) is the ONLY
      // mechanism that records a real suite_results row; no ledger row is ever
      // fabricated here. `suiteEvidence:false` is the negative configuration
      // (the gate must still refuse the first attempt, as today). Arrays (a
      // per-story TESTED_TREE agent) get the command on every entry.
      if (isMergeFamily && suiteEvidence && testedTreeAgent && agent === testedTreeAgent) {
        const evidenceEntries = Array.isArray(behavior) ? behavior : [behavior];
        for (const entry of evidenceEntries) {
          entry.commands = [...(entry.commands ?? []), TESTER_SUITE_EVIDENCE_COMMAND];
        }
      }
      // US-003: attach the campaign-controlled hold to the ONE designated
      // agent, AFTER every output/commands assignment so nothing overwrites it.
      // An array behavior (a loop body as first step agent) carries the hold on
      // every element so each per-story invocation parks identically.
      if (agent === holdAgent) {
        const holdEntries = Array.isArray(behavior) ? behavior : [behavior];
        for (const entry of holdEntries) {
          entry.hold = { id: HOLD_ID, timeoutMs: resolvedHoldTimeoutMs };
        }
      }
      const key = `${wf}_${agent}`;
      agents[key] = behavior;
      agentKeys.push(key);
    }
  }
  return { agents, heartbeatTokens: 0, defaultTokens: 0 };
}

// Materialize the per-campaign scripted-runtime contract: write the behaviors
// JSON under the OWNED rehearsal input root and create the private scripted
// state dir under the exec-identity state root. Returns the record persisted
// into state.rehearsal.scripted_runtime and mirror the same object into
// descriptor.json. Launch-free (fs writes only; nothing is deleted).
export function materializeRehearsalScriptedRuntime({
  fs: fsx = REAL_FS,
  inputRoot,
  stateRoot,
  campaignId,
  workflowTexts,
  workflowIds = STORM_WORKFLOW_IDS,
  holdTimeoutMs = HOLD_TIMEOUT_MS,
  suiteEvidence = true,
} = {}) {
  if (!inputRoot || !path.isAbsolute(String(inputRoot))) {
    throw refusal('materializeRehearsalScriptedRuntime requires an absolute inputRoot', 'TT_USAGE');
  }
  if (!stateRoot || !path.isAbsolute(String(stateRoot))) {
    throw refusal('materializeRehearsalScriptedRuntime requires an absolute stateRoot (the exec-identity state root)', 'TT_USAGE');
  }
  if (!campaignId || !/^[A-Za-z0-9._-]+$/.test(String(campaignId))) {
    throw refusal(`materializeRehearsalScriptedRuntime: campaignId must be a safe slug (got ${JSON.stringify(campaignId)})`, 'TT_USAGE');
  }
  const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts, workflowIds, holdTimeoutMs, suiteEvidence });
  const scriptedRoot = path.join(path.resolve(String(inputRoot)), 'scripted');
  fsx.mkdirSync(scriptedRoot, { recursive: true });
  const behaviorsFile = path.join(scriptedRoot, 'behaviors.json');
  const bytes = JSON.stringify(behaviors, null, 2) + '\n';
  fsx.writeFileSync(behaviorsFile, bytes);
  const stateDir = path.join(path.resolve(String(stateRoot)), 'scripted-state', String(campaignId));
  fsx.mkdirSync(stateDir, { recursive: true });
  const agentKeys = Object.keys(behaviors.agents).sort();
  return {
    behaviors_file: behaviorsFile,
    behaviors_sha256: sha256(bytes),
    state_dir: stateDir,
    agents: agentKeys.length,
    agent_keys: agentKeys,
    workflows: [...workflowIds].sort(),
  };
}

// Read the ACTUAL workflow.yml texts for `workflowIds` from the ordered
// candidate roots (installed catalog first, bundled fallback), failing closed
// when a listed workflow cannot be read.
export function readRehearsalWorkflowTexts({ fs: fsx = REAL_FS, roots = [], workflowIds = STORM_WORKFLOW_IDS } = {}) {
  const texts = {};
  for (const wf of workflowIds) {
    let text = null;
    for (const root of roots) {
      if (!root) continue;
      try {
        const raw = fsx.readFileSync(path.join(String(root), wf, 'workflow.yml'));
        if (typeof raw === 'string' && raw.length > 0) { text = raw; break; }
        if (raw != null && String(raw).length > 0) { text = String(raw); break; }
      } catch { /* try the next candidate root */ }
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw refusal(`cannot read workflow.yml for ${wf} from any candidate catalog root (${roots.filter(Boolean).join(', ') || 'none'})`, 'TT_CATALOG');
    }
    texts[wf] = text;
  }
  return texts;
}

// ─────────────────────────────────────────────────────────────────────
// provisionRehearsalInputs — the engine-facing orchestrator for the US-001
// prepare phase. Every step is recorded in ops.jsonl (intent + outcome) and
// returns the full input/profile/descriptor bundle the engine persists into
// campaign state + descriptor.json.
// ─────────────────────────────────────────────────────────────────────
export async function provisionRehearsalInputs({ ctx, campaignId, campaignDir, ops, holdSchedule = null, profile = undefined, realHarnessPins = null, spendCap = null, scale = undefined, roster = null }) {
  const fsx = ctx.fs ?? REAL_FS;
  const clock = ctx.clock;
  const varRoot = ctx.varRoot;
  const nowUtc = () => (clock?.nowUtc ? clock.nowUtc() : new Date().toISOString());
  // STORM-REAL US-008: the campaign SCALE selects which roster (and therefore
  // which task files / descriptor counts / harness set) is provisioned. The
  // default is the full roster, so an unscaled prepare is unchanged.
  const campaignScale = parseScale(scale);
  const rosterA = roster?.A ?? ROUND_A_ROSTER;
  const rosterB = roster?.B ?? ROUND_B_ROSTER;
  // STORM-REAL US-001: the campaign profile is validated/selected FIRST. The
  // derived hold/phase schedule and the per-campaign scripted-runtime contract
  // are SCRIPTED_REHEARSAL-only; a REAL campaign keeps the engine's
  // authoritative ROUND_B_PHASES table and real harnesses.
  const campaignProfile = parseProfile(profile);
  const isScriptedRehearsal = campaignProfile === SCRIPTED_REHEARSAL;
  // US-004: the derived hold/phase schedule is computed ONCE by the engine
  // (stormPrepare) and threaded in here so descriptor.json and the behaviors
  // file's hold timeout cannot drift from state.rehearsal.hold_schedule. A
  // direct caller without one still gets the honest default schedule.
  const schedule = isScriptedRehearsal ? (holdSchedule ?? deriveScriptedHoldSchedule()) : null;

  const bundledRoot = ctx.opts?.bundledCatalogRoot ?? ctx.opts?.bundledWorkflowsRoot;
  const installedRoot = ctx.opts?.installedCatalogRoot;
  if (!bundledRoot) throw refusal('rehearsal prepare requires a bundled catalog root (repo workflows/)', 'TT_USAGE');
  if (!installedRoot) throw refusal('rehearsal prepare requires an installed catalog root (private .tamandua/workflows)', 'TT_USAGE');

  // 1) Seed the private installed catalog from the ACTUAL bundled catalog.
  ops.record('rehearsal.seed_catalog.intent', { bundledRoot, installedRoot });
  const catalogSeed = seedCatalogFromBundled({ fs: fsx, bundledRoot, installedRoot, clock });
  ops.record('rehearsal.seed_catalog.outcome', { seeded: catalogSeed.seeded.length, installedRoot });

  // 2) Allocate the fresh owned input roots + worktree root (dev/ino captured
  //    at allocation; receipts revalidated by later modes).
  ops.record('rehearsal.alloc_roots.intent', { campaignId });
  const inputRoots = allocateRehearsalInputRoots({ fs: fsx, varRoot, campaignId, clock });
  ops.record('rehearsal.alloc_roots.outcome', { root: inputRoots.root, worktreeRoot: inputRoots.worktreeRoot });

  // 3) Owned tiny git origin + sibling clones (colleague/park).
  ops.record('rehearsal.fixture_git.intent', { reposRoot: inputRoots.reposRoot });
  const fixture = await provisionOwnedGitFixture({
    fs: fsx,
    git: ctx.git,
    clock,
    reposRoot: inputRoots.reposRoot,
    env: ctx.opts?.gitEnv ?? {},
  });
  ops.record('rehearsal.fixture_git.outcome', {
    originRepo: fixture.originRepo,
    colleagueRepo: fixture.colleagueRepo,
    parkRepo: fixture.parkRepo,
    mainHead: fixture.mainHead,
    brokenTestsHead: fixture.brokenTestsHead,
  });

  // 4) Per-run task files for EVERY roster entry (Round A S1-S10, Round B
  //    B1-B5) with exact expected scripted operations/outputs.
  ops.record('rehearsal.task_files.intent', { tasksRoot: inputRoots.tasksRoot });
  const taskProvision = provisionTaskFiles({
    fs: fsx,
    clock,
    tasksRoot: inputRoots.tasksRoot,
    fixture,
    roster: { A: rosterA, B: rosterB },
    seedRef: ctx.opts?.seedRef ?? 'seed/storm',
  });
  ops.record('rehearsal.task_files.outcome', { files: Object.keys(taskProvision.taskFiles).length, manifest: taskProvision.manifest });

  // 4b) US-001 (fix-2, S5): materialize the per-campaign scripted-runtime
  //     contract. The frozen zero-model runtimes derive their state dir from
  //     TAMANDUA_SCRIPTED_STATE and look up their step-complete behavior in
  //     TAMANDUA_SCRIPTED_BEHAVIORS; without both, every work round crashed
  //     with ENOENT before claiming a step. The behaviors file lives under the
  //     OWNED rehearsal input root and the state dir under the persisted
  //     exec-identity state root — never inside campaignDir. SCRIPTED_REHEARSAL
  //     ONLY: a REAL campaign runs the operator's real harnesses and carries
  //     no frozen scripted-runtime contract.
  let scriptedRuntime = null;
  if (isScriptedRehearsal) {
    ops.record('rehearsal.scripted_runtime.intent', { workflowIds: [...STORM_WORKFLOW_IDS] });
    const scriptedStateRoot = ctx.opts?.execIdentity?.state_root ?? inputRoots.root;
    const workflowTexts = readRehearsalWorkflowTexts({
      fs: fsx,
      roots: [catalogSeed.installedRoot, catalogSeed.sourceRoot, installedRoot, bundledRoot],
      workflowIds: STORM_WORKFLOW_IDS,
    });
    scriptedRuntime = materializeRehearsalScriptedRuntime({
      fs: fsx,
      inputRoot: inputRoots.root,
      stateRoot: scriptedStateRoot,
      campaignId,
      workflowTexts,
      holdTimeoutMs: schedule.hold_timeout_ms,
    });
    ops.record('rehearsal.scripted_runtime.outcome', {
      behaviors_file: scriptedRuntime.behaviors_file,
      behaviors_sha256: scriptedRuntime.behaviors_sha256,
      state_dir: scriptedRuntime.state_dir,
      agents: scriptedRuntime.agents,
    });
  }

  // 5) Identity bundle: fixtureIdentity in the engine's existing vocabulary
  //    plus the per-run input manifest, pins and resource plan.
  //    SF-15 (US-006): the PARK target is the owned non-bare ORIGIN checkout
  //    (main checked out, the merge target B1..B4 share), so the park action
  //    dirties a repo a live run actually merges into. The sibling
  //    `repos/park` clone stays provisioned for read-only compatibility
  //    (resource_plan.fixture.park / inputs.fixture.parkRepo) but is no
  //    longer the park action's repo.
  const fixtureIdentity = {
    originRepo: fixture.originRepo,
    colleagueRepo: fixture.colleagueRepo,
    parkRepo: fixture.originRepo,
    cc1File: fixture.files.cc1,
    cc2File: fixture.files.cc2,
    seedRef: ctx.opts?.seedRef ?? 'seed/storm',
  };
  // STORM-REAL US-002: a REAL campaign pins the OPERATOR'S real harness
  // binaries (already resolved by stormPrepare BEFORE any effect, so a missing
  // roster harness refuses before initCampaign). A direct caller that did not
  // pre-resolve still gets an honest resolution here. SCRIPTED_REHEARSAL keeps
  // the frozen scripted-runtime pins unchanged.
  const runtimePins = isScriptedRehearsal
    ? runtimePinsFor(ctx, fsx)
    : await realRuntimePinsFor({ ctx, fsx, harnessPins: realHarnessPins, resolvedAt: nowUtc(), roster: { A: rosterA, B: rosterB } });
  const resourcePlan = {
    fixture: { origin: fixture.originRepo, colleague: fixture.colleagueRepo, park: fixture.parkRepo, worktreeRoot: inputRoots.worktreeRoot, tasksRoot: inputRoots.tasksRoot },
    daemon: {
      wrapper: runtimePins.binaries.daemonControl?.path ?? 'daemon-control',
      // zero-model SCRIPTED_REHEARSAL daemon (frozen scripted runtimes) or the
      // REAL contained product daemon from this tree (daemon-control real).
      kind: daemonKindForProfile(campaignProfile),
      profile: campaignProfile,
      ports: { dashboard: 'bind0-allocated-at-rehearsal', mcp: 'bind0-allocated-at-rehearsal', control: 'bind0-allocated-at-rehearsal' },
      note: 'ONE private daemon via the sanctioned daemon-control wrapper under the private roots; every listener port is independently bind0-allocated at rehearsal time and recorded then — never fixed production 3334/3338/3339 and never operator state',
    },
    listeners: ['dashboard', 'mcp', 'control'],
  };
  const approvalFile = ctx.opts?.coordinatorApprovalFile ?? DEFAULT_COORDINATOR_APPROVAL_FILE;
  const gateHashes = ctx.opts?.gateHashes ?? computeGateHashes({ fsx });
  const sourcePins = ctx.opts?.sourcePins ?? { commit: ctx.opts?.sourceCommit ?? null, tree: ctx.opts?.sourceTree ?? null, tree_dirty: ctx.opts?.sourceTreeDirty ?? null };
  const descriptor = {
    schema_version: 1,
    kind: 'tt-storm-rehearsal-descriptor',
    profile: campaignProfile,
    label: labelForProfile(campaignProfile),
    campaign: { id: campaignId, dir: campaignDir },
    source: sourcePins,
    gate_hashes: gateHashes,
    catalog_identity: {
      kind: catalogSeed.kind,
      installed_root: catalogSeed.installedRoot,
      seeded_from: { kind: 'bundled', root: catalogSeed.sourceRoot, workflows: catalogSeed.seeded },
      per_workflow: catalogSeed.perWorkflow,
    },
    roster: {
      scale: campaignScale,
      roster_id: campaignScale,
      round_a: rosterA.length,
      round_b: rosterB.length,
      workflow_ids: rosterWorkflowIds({ A: rosterA, B: rosterB }),
    },
    input_manifest: {
      task_files: taskProvision.manifest,
      edit_targets: ROSTER_EDIT_FILE,
      fixture_files: fixture.files,
    },
    runtime_pins: runtimePins,
    resource_plan: resourcePlan,
    // STORM-REAL US-006: the REQUIRED hard spend cap for a REAL campaign
    // ({ tokens, scope }), resolved before any effect by stormPrepare. A
    // SCRIPTED_REHEARSAL descriptor carries null (unaffected). This is the
    // persisted identity the observation loop enforces; it is never re-derived
    // from a CLI flag at run time.
    spend_cap: spendCap ?? null,
    authorized_rehearse: {
      profile: campaignProfile,
      approval_file: approvalFile,
      entrypoint: ctx.opts?.rehearseCommandCli ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'tt-storm'),
      rounds: [
        `rehearse --campaign ${campaignDir} --round A --approval-file ${approvalFile}`,
        `rehearse --campaign ${campaignDir} --round B --approval-file ${approvalFile}`,
      ],
      note: 'exact invocations after the coordinator-owned approval file matches campaign id + current source commit/tree + the COMPLETE gate hash set above; the approval file is read-only and owned by the coordinator',
    },
    provisioned_at: nowUtc(),
  };
  // US-001 (fix-2, S5): the per-campaign scripted-runtime contract recorded in
  // the descriptor (and mirrored into state.rehearsal.scripted_runtime).
  // SCRIPTED_REHEARSAL-only — a REAL descriptor carries no scripted_runtime.
  if (scriptedRuntime) descriptor.scripted_runtime = scriptedRuntime;
  // US-004: the derived SCRIPTED_REHEARSAL hold/phase schedule (the Round B
  // offsets derive from the hold schedule, not the 5400s real-storm clock).
  // SCRIPTED_REHEARSAL-only — a REAL descriptor carries no hold_schedule.
  if (schedule) descriptor.hold_schedule = schedule;

  return {
    campaignId,
    campaignDir,
    catalogSeed,
    inputRoots,
    fixture,
    fixtureIdentity,
    taskFiles: taskProvision.taskFiles,
    taskManifest: taskProvision.manifest,
    runtimePins,
    resourcePlan,
    spendCap: spendCap ?? null,
    scriptedRuntime,
    // US-004: the same derived schedule object the descriptor persisted, so
    // stormPrepare can record it in state without recomputing (never drifts).
    // null for REAL (no derived schedule).
    holdSchedule: schedule,
    descriptor,
  };
}

function binaryPinsFor(ctx, fsx) {
  const binaries = ctx.opts?.binaries ?? ctx.opts?.execCtx?.binaries ?? {};
  const pin = (p) => {
    if (!p) return { path: null, present: false, sha256: null };
    let present = false;
    try { present = fsx.existsSync(p) && fsx.statSync(p).isFile(); } catch { present = false; }
    let hash = null;
    if (present) {
      try { hash = sha256(String(fsx.readFileSync(p))); } catch { hash = null; }
    }
    return { path: p, present, sha256: hash };
  };
  const pinBinary = (key) => pin(binaries[key] ?? null);
  return {
    tamandua: pinBinary('tamandua'),
    tamanduaTest: pinBinary('tamanduaTest'),
    daemonControl: pinBinary('daemonControl'),
    ttChaos: pinBinary('ttChaos'),
    git: pinBinary('git'),
  };
}

function runtimePinsFor(ctx, fsx) {
  const pin = (p) => {
    if (!p) return { path: null, present: false, sha256: null };
    let present = false;
    try { present = fsx.existsSync(p) && fsx.statSync(p).isFile(); } catch { present = false; }
    let hash = null;
    if (present) {
      try { hash = sha256(String(fsx.readFileSync(p))); } catch { hash = null; }
    }
    return { path: p, present, sha256: hash };
  };
  const scriptedPi = ctx.opts?.scriptedRuntimes?.pi ?? null;
  const scriptedHermes = ctx.opts?.scriptedRuntimes?.hermes ?? null;
  return {
    binaries: binaryPinsFor(ctx, fsx),
    scripted_runtimes: {
      pi: pin(scriptedPi),
      hermes: pin(scriptedHermes),
      probe_enabled: true,
      note: 'frozen zero-model scripted pi/Hermes identities answer the launch-time harness probe (TAMANDUA_HARNESS_PROBE: skill-path); credentials absent; no real-harness fallback (private child env is an explicit minimum allowlist and never inherits provider credentials / real harness binaries)',
    },
  };
}

// STORM-REAL US-002: the REAL runtime pins. The exec-context binary pins are
// recorded as before, and the resolved real harness binaries are pinned as a
// `harnesses` map (absolute path + --version output + sha256 + provenance).
// There is deliberately NO `scripted_runtimes` block: a REAL campaign runs the
// operator's harnesses, never the frozen zero-model rehearsal runtime.
//
// `harnessPins` is the pre-resolved pin map from stormPrepare (resolved before
// initCampaign so a missing harness leaves no campaign dir). When absent (a
// direct caller), the roster harnesses are resolved here with the same
// injected env/runner seams.
async function realRuntimePinsFor({ ctx, fsx, harnessPins = null, resolvedAt = null, roster = null }) {
  const rosterA = roster?.A ?? ROUND_A_ROSTER;
  const rosterB = roster?.B ?? ROUND_B_ROSTER;
  const rosterHarnesses = harnessNamesForRoster([...rosterA, ...rosterB]);
  const pins = harnessPins ?? await resolveRosterHarnessPins(rosterHarnesses, {
    env: ctx.opts?.harnessEnv ?? process.env,
    fs: ctx.opts?.harnessFs,
    pathEnv: ctx.opts?.harnessPath,
    runner: ctx.opts?.harnessVersionRunner,
  });
  return {
    binaries: binaryPinsFor(ctx, fsx),
    harnesses: pins,
    harness_resolution: {
      profile: REAL,
      roster_harnesses: Object.keys(pins),
      resolved_at: resolvedAt,
      note: 'real harness binaries resolved at prepare from TAMANDUA_PI_BINARY/TAMANDUA_HERMES_BINARY/TAMANDUA_DSH_BINARY (absolute override) else PATH; absolute path + --version + sha256 pinned; credentials/config never read or copied',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// US-002 RUN LAYER — connecting a prepared campaign to the real storm
// engine + transports (daemon lifecycle, run-mode opts, single-flight arm).
// ─────────────────────────────────────────────────────────────────────

// Production listener ports that must NEVER be used by the private rehearsal
// daemon (spec 01 / STORM-REAL root review #1: production is 33xx).
export const PRODUCTION_PORTS = Object.freeze([3334, 3338, 3339]);
// The daemon kind for the zero-model SCRIPTED_REHEARSAL (frozen scripted
// pi/Hermes runtimes, no credentials, no real-harness fallback).
export const REHEARSAL_DAEMON_KIND = 'scripted';
// Rehearsal pounding cadence + latency bound (spec 09 Round B table).
export const REHEARSAL_POUND_INTERVAL_MS = 30_000;
export const REHEARSAL_POUND_LATENCY_BOUND_MS = 2_000;
// Default MCP tool names pounded each round (real streamable-HTTP reads).
// These MUST be the product's REGISTERED tool names (src/server/mcp-server.ts
// MCP_TOOL_RUNS_LIST / MCP_TOOL_RUN_STATUS). The attempt-2 campaign pounded
// the unregistered short names 'runs.list' / 'run.status', so even after the
// SSE parse fix every call would have been an RPC 'unknown tool' error.
export const REHEARSAL_MCP_TOOLS = Object.freeze(['tamandua.runs.list', 'tamandua.run.status']);
// Read-only default arguments for the pounding tools. `tamandua.run.status`
// requires a non-empty `query`, so a bare tools/call would be a genuine RPC
// error; the engine derives a recorded run id at pound time (see
// defaultPoundingMcpArgs in tt-storm-engine.mjs) unless a campaign overrides
// these via pounding.mcpToolArgs.
export const REHEARSAL_MCP_TOOL_ARGS = Object.freeze({
  'tamandua.runs.list': Object.freeze({ limit: 10 }),
});
// State key under which the single-flight prelude evidence is recorded.
export const SINGLEFLIGHT_STATE_KEY = 'single_flight';
// Failure codes (machine-parseable).
export const TT_REHEARSAL_DAEMON = 'TT_REHEARSAL_DAEMON';
export const TT_DAEMON_NOT_EVIDENCED = 'TT_DAEMON_NOT_EVIDENCED';
// S1 (run #56 verify): the RUNNING daemon's daemon-control provenance did not
// match the campaign's recorded bind0 allocation / private containment — the
// rehearsal refuses BEFORE its first launch (fail-closed).
export const TT_DAEMON_PROVENANCE = 'TT_DAEMON_PROVENANCE';
export const TT_SINGLEFLIGHT_CFG = 'TT_SINGLEFLIGHT_CFG';
export const TT_SINGLEFLIGHT_TREE_MISMATCH = 'TT_SINGLEFLIGHT_TREE_MISMATCH';
export const TT_SINGLEFLIGHT_NOT_OWNED = 'TT_SINGLEFLIGHT_NOT_OWNED';

// ─────────────────────────────────────────────────────────────────────
// daemon-control canonical argv + env script rendering.
// ─────────────────────────────────────────────────────────────────────

// Canonical daemon-control invocation (`daemon-control <kind> <op>`) — the
// ONE argv shape the rehearsal run layer issues; the operator wrapper does
// its own recorded process-start identity gating (E3.C.1 US-004), so the
// orchestrator never signals a pid directly here.
export function daemonControlArgv(kind, op) {
  if (kind !== 'scripted' && kind !== 'real') {
    return { ok: false, argv: null, reason: `daemon-control kind must be scripted|real (got ${JSON.stringify(kind)})` };
  }
  const ops = new Set(['start', 'stop', 'restart', 'status']);
  if (!ops.has(op)) {
    return { ok: false, argv: null, reason: `daemon-control op must be one of ${[...ops].join('|')} (got ${JSON.stringify(op)})` };
  }
  return { ok: true, argv: ['daemon-control', kind, op] };
}

// Validate one listener port for the private daemon: an integer in the
// ephemeral/registered range, distinct across the set, and NEVER a production
// port. bind0 allocation produces real free ports in the ephemeral range; the
// check is belt-and-suspenders so a bad allocator can never steer the daemon
// onto production 3334/3338/3339 or an operator listener.
export function assertSafeListenerPort(port, { used = [], label = 'listener port' } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw refusal(`rehearsal ${label} must be a free port integer in 1024..65535 (got ${JSON.stringify(port)})`, 'TT_USAGE');
  }
  if (PRODUCTION_PORTS.includes(n)) {
    throw refusal(`rehearsal ${label} may never be a production port ${n} (3334/3338/3339)`, TT_REHEARSAL_DAEMON);
  }
  if (used.includes(n)) {
    throw refusal(`rehearsal ${label} ${n} collides with another allocated listener port`, 'TT_USAGE');
  }
  return n;
}

// Real bind0 allocator (127.0.0.1 only — contained, no remote bind): bind a
// throwaway server to port 0, read the OS-assigned port, close. Returns the
// port or null on failure. The actual listener is then opened by the private
// daemon on the same 127.0.0.1 interface.
export async function realBindZeroAllocator() {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(null));
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      srv.close(() => resolve(port));
    });
  });
}

// Allocate dashboard/MCP/control ports with an injectable bind0 allocator.
// `allocate` is called once per listener until it yields a distinct safe
// port. Returns the frozen allocation + the endpoint URLs the read-path
// pounding and MCP reads use.
export async function allocRehearsalListenerPorts({ allocate = null, clock = null } = {}) {
  const alloc = typeof allocate === 'function' ? allocate : realBindZeroAllocator;
  const used = [];
  const take = async (label) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const port = await alloc(label, attempt);
      if (port === null || port === undefined) continue;
      const safe = assertSafeListenerPort(port, { used, label });
      if (safe === port) {
        used.push(port);
        return port;
      }
    }
    throw refusal(`cannot bind0-allocate a distinct safe ${label} after 12 attempts`, 'TT_USAGE');
  };
  const dashboard = await take('dashboard');
  const mcp = await take('mcp');
  const control = await take('control');
  return {
    dashboard,
    mcp,
    control,
    dashboardUrl: `http://127.0.0.1:${dashboard}/`,
    mcpUrl: `http://127.0.0.1:${mcp}/mcp`,
    controlUrl: `http://127.0.0.1:${control}/`,
    allocatedAt: clock?.nowUtc ? clock.nowUtc() : new Date().toISOString(),
  };
}

// The per-campaign daemon env script basename. materializeRehearsalDaemon
// writes it into campaignDir; ensureRehearsalDaemon re-reads it from there for
// the pre-launch env-contract verification (S5/S8).
export const REHEARSAL_DAEMON_ENV_NAME = 'daemon.env.sh';

// The COMPLETE per-campaign scripted-runtime contract the frozen zero-model
// runtimes (and the daemon's frozen harness binaries) consume. Derived from the
// ACTUAL `process.env.X` reads in torture-test/scripted-runtimes/*.mjs (the
// daemon-env self-test extracts them mechanically and proves coverage):
//   * TAMANDUA_SCRIPTED_BEHAVIORS / TAMANDUA_SCRIPTED_STATE — read by
//     runtime-pi.mjs / runtime-hermes.mjs (behaviors JSON + state dir);
//   * HERMES_HOME — read by runtime-hermes.mjs;
//   * TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY — the daemon's frozen
//     scripted harness binaries the runtimes are exec'd through.
// TAMANDUA_WORKER_JOB_ID is intentionally NOT emitted here: the daemon/worker
// supplies it per round (runtime-pi.mjs:303, runtime-hermes.mjs:372).
// DSH_HOME is likewise NOT emitted: runtime-dsh.mjs reads it to place its fake
// session log, and it is a user/worker-provided dsh variable (the product's
// cleanChildEnv whitelists DSH_HOME and passes it through unmodified; the union
// runtime degrades gracefully — no session log — when it is unset).
export const REHEARSAL_SCRIPTED_RUNTIME_ENV_VARS = Object.freeze([
  'TAMANDUA_SCRIPTED_BEHAVIORS',
  'TAMANDUA_SCRIPTED_STATE',
  'HERMES_HOME',
  'TAMANDUA_PI_BINARY',
  'TAMANDUA_HERMES_BINARY',
]);
// Vars the campaign daemon/worker supplies (or the frozen runtimes default)
// rather than the durable env script. TAMANDUA_SCRIPTED_HOLD_DIR /
// TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS are OPTIONAL campaign-controlled overrides
// for the STORM US-002 mid-flight hold: resolveHoldDir() defaults the hold root
// to `<TAMANDUA_SCRIPTED_STATE>/holds`, so the engine works without them and
// they are only set when a distinct hold root/timeout is wanted. DSH_HOME is
// supplied by the dsh worker env when present (never baked into the durable
// campaign env, which pins a private HOME); runtime-dsh.mjs tolerates its
// absence by degrading token attribution to null.
export const REHEARSAL_DAEMON_PROVIDED_ENV_VARS = Object.freeze([
  'TAMANDUA_WORKER_JOB_ID',
  'TAMANDUA_SCRIPTED_HOLD_DIR',
  'TAMANDUA_SCRIPTED_HOLD_TIMEOUT_MS',
  'DSH_HOME',
]);

// US-002 (NPF-2): the contained rehearsal daemon env is rendered under `env -i`,
// so PATH starts empty and does not include <repo>/bin. The shim-wrapped
// TEST_CMD (US-001 suite-evidence command) invokes the BARE `tamandua-test`,
// which the scripted runtime's bash can only resolve when <repo>/bin is on
// PATH. Every renderer of the daemon env folds this list into `pathExtra`.
export function rehearsalDaemonPathExtra(repoRoot) {
  if (!repoRoot) {
    throw refusal('rehearsalDaemonPathExtra requires a repo root', 'TT_USAGE');
  }
  return [path.join(repoRoot, 'bin')];
}

// Render the per-campaign daemon env script (bash) that daemon-control
// applies under `env -i` for kind=scripted (mirrors tt-env-scripted.sh's
// KEY=VALUE `print` contract). The script pins: private HOME/STATE/TMPDIR,
// independently bind0-allocated listener ports, guard=1, the frozen
// scripted pi/Hermes runtime binaries, AND (US-002 fix-2, S5/S8) the complete
// scripted-runtime contract — TAMANDUA_SCRIPTED_BEHAVIORS,
// TAMANDUA_SCRIPTED_STATE and the DERIVED TAMANDUA_MAX_ACTIVE_TIMERS. Those
// three are OPTIONAL so a synthetic caller (gate H8) renders byte-for-byte
// semantics when they are omitted. Production ports are refused here too (the
// wrapper additionally refuses them). Credentials are never referenced.
// US-003 (SF-14) adds the OPTIONAL `gitHermetic` flag: when true the script
// also exports GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1 so the
// contained daemon has no git identity available unless a helper injects one.
export function renderRehearsalDaemonEnvScript({ home, stateDir, tmpDir, dbPath = null, ports, piBinary, hermesBinary, nodeBinDir = null, pathExtra = [], repoRoot = null, ttRoot = null, scriptedBehaviors = null, scriptedStateDir = null, maxActiveTimers = null, gitHermetic = false }) {
  if (!home || !stateDir || !tmpDir) {
    throw refusal('renderRehearsalDaemonEnvScript requires home/stateDir/tmpDir', 'TT_USAGE');
  }
  const dash = assertSafeListenerPort(ports?.dashboard, { label: 'dashboard port' });
  const mcp = assertSafeListenerPort(ports?.mcp, { label: 'mcp port' });
  const ctrl = assertSafeListenerPort(ports?.control, { label: 'control port' });
  if (!piBinary || !hermesBinary) {
    throw refusal('renderRehearsalDaemonEnvScript requires the frozen piBinary/hermesBinary absolute paths', 'TT_USAGE');
  }
  if (maxActiveTimers !== null && maxActiveTimers !== undefined) {
    const capInt = Number(maxActiveTimers);
    if (!Number.isInteger(capInt) || capInt <= 0) {
      throw refusal(`renderRehearsalDaemonEnvScript: maxActiveTimers must be a positive integer (got ${JSON.stringify(maxActiveTimers)})`, 'TT_USAGE');
    }
  }
  const emitCap = maxActiveTimers !== null && maxActiveTimers !== undefined;
  const lines = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# Generated by the tt-storm rehearsal RUN layer (US-002): per-campaign');
  lines.push('# private daemon env for daemon-control kind=scripted. Read-only by the');
  lines.push('# wrapper via `env -i bash <this> print`; never sourced into the caller.');
  if (repoRoot) lines.push(`export TT_REPO_ROOT=${shellQuote(repoRoot)}`);
  if (ttRoot) lines.push(`export TT_ROOT=${shellQuote(ttRoot)}`);
  lines.push(`export HOME=${shellQuote(home)}`);
  lines.push(`export TAMANDUA_STATE_DIR=${shellQuote(stateDir)}`);
  // S1 (run #56): the daemon and the launched product client must resolve the
  // EXACT same campaign DB, so the rendered script pins TAMANDUA_DB_PATH too.
  // Omitted when dbPath is null (backwards compatible with synthetic callers).
  if (dbPath) lines.push(`export TAMANDUA_DB_PATH=${shellQuote(dbPath)}`);
  lines.push(`export TAMANDUA_DASHBOARD_PORT=${dash}`);
  lines.push(`export TAMANDUA_MCP_PORT=${mcp}`);
  lines.push(`export TAMANDUA_CONTROL_PORT=${ctrl}`);
  lines.push(`export HERMES_HOME=${shellQuote(stateDir)}/.hermes`);
  lines.push('export TAMANDUA_TEST_GUARD=1');
  // SF-14 (US-003): an OPTIONAL hermetic git posture for the daemon/worker
  // env. When set, git resolves NO global or system config (GIT_CONFIG_GLOBAL
  // =/dev/null, GIT_CONFIG_NOSYSTEM=1) so a campaign git write can only
  // succeed because the tt-chaos helper supplies the fixture-scoped identity
  // in the write's child env (US-001) — never because the host happens to have
  // an ambient global identity. Opt-in: the default rendering (gate H8 and the
  // real campaign materializer) is byte-identical to before.
  if (gitHermetic) {
    lines.push('export GIT_CONFIG_GLOBAL=/dev/null');
    lines.push('export GIT_CONFIG_NOSYSTEM=1');
  }
  lines.push(`export TAMANDUA_PI_BINARY=${shellQuote(piBinary)}`);
  lines.push(`export TAMANDUA_HERMES_BINARY=${shellQuote(hermesBinary)}`);
  // US-002 (fix-2, S5/S8): the optional per-campaign scripted-runtime contract.
  // Omitted entirely when not supplied (gate H8 renders without them).
  if (scriptedBehaviors) lines.push(`export TAMANDUA_SCRIPTED_BEHAVIORS=${shellQuote(scriptedBehaviors)}`);
  if (scriptedStateDir) lines.push(`export TAMANDUA_SCRIPTED_STATE=${shellQuote(scriptedStateDir)}`);
  if (emitCap) lines.push(`export TAMANDUA_MAX_ACTIVE_TIMERS=${Number(maxActiveTimers)}`);
  if (nodeBinDir) lines.push(`export TT_NODE_BIN_DIR=${shellQuote(nodeBinDir)}`);
  const pathSegs = [nodeBinDir, ...pathExtra].filter(Boolean);
  if (pathSegs.length > 0) {
    lines.push(`export PATH=${pathSegs.map(shellQuote).join(':')}:"$PATH"`);
  }
  const vars = [
    'TT_REPO_ROOT', 'TT_ROOT', 'HOME', 'TAMANDUA_STATE_DIR', 'TAMANDUA_DB_PATH',
    'TAMANDUA_DASHBOARD_PORT', 'TAMANDUA_MCP_PORT', 'TAMANDUA_CONTROL_PORT',
    'HERMES_HOME', 'TAMANDUA_TEST_GUARD', 'TAMANDUA_PI_BINARY',
    'TAMANDUA_HERMES_BINARY', 'TT_NODE_BIN_DIR', 'PATH',
  ];
  if (scriptedBehaviors) vars.push('TAMANDUA_SCRIPTED_BEHAVIORS');
  if (scriptedStateDir) vars.push('TAMANDUA_SCRIPTED_STATE');
  if (emitCap) vars.push('TAMANDUA_MAX_ACTIVE_TIMERS');
  if (gitHermetic) vars.push('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM');
  lines.push('if [ "${1:-}" = "print" ]; then');
  lines.push(`  for v in ${vars.join(' ')}; do`);
  lines.push('    printf \'%s=%s\\n\' "$v" "$(eval "printf \'%s\' \"\\$$v\"")"');
  lines.push('  done');
  lines.push('fi');
  return lines.join('\n') + '\n';
}

function shellQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// The per-campaign REAL daemon env script basename. materializeRehearsalDaemon
// writes it into campaignDir for a REAL campaign; ensureRehearsalDaemon
// re-reads it from there for the pre-launch env-contract verification. A
// DISTINCT name from the scripted REHEARSAL_DAEMON_ENV_NAME so a REAL campaign
// can never silently launch under a stale scripted env (and vice versa).
export const REAL_DAEMON_ENV_NAME = 'daemon.env.real.sh';

// Render the per-campaign REAL daemon env script (bash) that daemon-control
// applies under `env -i` for kind=real (STORM-REAL US-004). It mirrors the
// scripted renderer's private-root/port discipline but expresses the REAL
// postures:
//   * private HOME/TAMANDUA_STATE_DIR/TAMANDUA_DB_PATH/TMPDIR under the
//     campaign's owned exec roots (never the operator HOME/state);
//   * the independently bind0-allocated campaign listener ports (never the
//     fixed production 3334/3338/3339);
//   * the DERIVED plan timer cap (TAMANDUA_MAX_ACTIVE_TIMERS);
//   * the resolved REAL pi/hermes/dsh harness binaries (TAMANDUA_<HARNESS>_
//     BINARY) from the campaign's prepare-time pins;
//   * TAMANDUA_TEST_GUARD deliberately ABSENT: the contained real daemon runs
//     under the campaign's own private roots and the product test guard's
//     ~/.tamandua prefix check would otherwise flag a worktree-relative state
//     dir (the real rounds run with the guard unset, per STORM-REAL US-004);
//   * NO scripted-runtime contract (TAMANDUA_SCRIPTED_BEHAVIORS/STATE) — a
//     REAL campaign runs the operator's harnesses, not the frozen zero-model
//     runtimes.
// Credentials are never referenced here: daemon-control's real operator-home
// seam surfaces the enumerated API keys at spawn composition time.
export function renderRealDaemonEnvScript({ home, stateDir, tmpDir, dbPath = null, ports, harnessBinaries = null, nodeBinDir = null, pathExtra = [], repoRoot = null, ttRoot = null, maxActiveTimers = null }) {
  if (!home || !stateDir || !tmpDir) {
    throw refusal('renderRealDaemonEnvScript requires home/stateDir/tmpDir', 'TT_USAGE');
  }
  const dash = assertSafeListenerPort(ports?.dashboard, { label: 'dashboard port' });
  const mcp = assertSafeListenerPort(ports?.mcp, { label: 'mcp port' });
  const ctrl = assertSafeListenerPort(ports?.control, { label: 'control port' });
  if (maxActiveTimers !== null && maxActiveTimers !== undefined) {
    const capInt = Number(maxActiveTimers);
    if (!Number.isInteger(capInt) || capInt <= 0) {
      throw refusal(`renderRealDaemonEnvScript: maxActiveTimers must be a positive integer (got ${JSON.stringify(maxActiveTimers)})`, 'TT_USAGE');
    }
  }
  const emitCap = maxActiveTimers !== null && maxActiveTimers !== undefined;
  // The resolved real harness binaries: EXACTLY the campaign's prepare-time
  // roster pins, mapped through the product's env vocabulary. Each must be an
  // absolute path; the script exports one TAMANDUA_<HARNESS>_BINARY per
  // resolved harness (pi/hermes/dsh). An empty/absent pin set is refused — a
  // REAL daemon with no resolvable harness is not a real storm.
  const harnessEnv = [];
  for (const [harness, p] of Object.entries(harnessBinaries ?? {})) {
    const envVar = HARNESS_BINARY_ENV[harness];
    if (!envVar) {
      throw refusal(`renderRealDaemonEnvScript: unknown harness ${JSON.stringify(harness)} (expected one of ${Object.keys(HARNESS_BINARY_ENV).join(', ')})`, 'TT_USAGE');
    }
    if (typeof p !== 'string' || p.trim() === '') {
      throw refusal(`renderRealDaemonEnvScript: harness ${harness} has no resolved binary path`, 'TT_USAGE');
    }
    if (!path.isAbsolute(p)) {
      throw refusal(`renderRealDaemonEnvScript: harness ${harness} binary must be an absolute path (got ${JSON.stringify(p)})`, 'TT_USAGE');
    }
    harnessEnv.push([envVar, p]);
  }
  if (harnessEnv.length === 0) {
    throw refusal('renderRealDaemonEnvScript requires the resolved real harness binaries (at least one roster harness)', 'TT_USAGE');
  }
  const lines = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# Generated by the tt-storm REAL RUN layer (STORM-REAL US-004): per-campaign');
  lines.push('# private daemon env for daemon-control kind=real. Read-only by the wrapper');
  lines.push('# via `env -i bash <this> print`; never sourced into the caller.');
  if (repoRoot) lines.push(`export TT_REPO_ROOT=${shellQuote(repoRoot)}`);
  if (ttRoot) lines.push(`export TT_ROOT=${shellQuote(ttRoot)}`);
  lines.push(`export HOME=${shellQuote(home)}`);
  lines.push(`export TAMANDUA_STATE_DIR=${shellQuote(stateDir)}`);
  if (dbPath) lines.push(`export TAMANDUA_DB_PATH=${shellQuote(dbPath)}`);
  lines.push(`export TMPDIR=${shellQuote(tmpDir)}`);
  lines.push(`export TAMANDUA_DASHBOARD_PORT=${dash}`);
  lines.push(`export TAMANDUA_MCP_PORT=${mcp}`);
  lines.push(`export TAMANDUA_CONTROL_PORT=${ctrl}`);
  lines.push(`export HERMES_HOME=${shellQuote(stateDir)}/.hermes`);
  // TAMANDUA_TEST_GUARD is intentionally NOT exported: the contained real
  // daemon runs under the campaign's own private roots (STORM-REAL US-004).
  for (const [envVar, p] of harnessEnv) lines.push(`export ${envVar}=${shellQuote(p)}`);
  if (emitCap) lines.push(`export TAMANDUA_MAX_ACTIVE_TIMERS=${Number(maxActiveTimers)}`);
  if (nodeBinDir) lines.push(`export TT_NODE_BIN_DIR=${shellQuote(nodeBinDir)}`);
  const pathSegs = [nodeBinDir, ...pathExtra].filter(Boolean);
  if (pathSegs.length > 0) {
    lines.push(`export PATH=${pathSegs.map(shellQuote).join(':')}:"$PATH"`);
  }
  const vars = [
    'TT_REPO_ROOT', 'TT_ROOT', 'HOME', 'TAMANDUA_STATE_DIR', 'TAMANDUA_DB_PATH',
    'TMPDIR',
    'TAMANDUA_DASHBOARD_PORT', 'TAMANDUA_MCP_PORT', 'TAMANDUA_CONTROL_PORT',
    'HERMES_HOME', ...harnessEnv.map(([envVar]) => envVar),
    'TT_NODE_BIN_DIR', 'PATH',
  ];
  if (emitCap) vars.push('TAMANDUA_MAX_ACTIVE_TIMERS');
  lines.push('if [ "${1:-}" = "print" ]; then');
  lines.push(`  for v in ${vars.join(' ')}; do`);
  lines.push('    printf \'%s=%s\\n\' "$v" "$(eval "printf \'%s\' \"\\$$v\"")"');
  lines.push('  done');
  lines.push('fi');
  return lines.join('\n') + '\n';
}

// Undo the shell quoting shellQuote emits (single-quoted, with `'\''` escapes);
// also tolerates double-quoted or bare values. Pure.
function unquoteShellValue(raw) {
  const v = String(raw).trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

// Parse the `export KEY=VALUE` contract of a rendered daemon.env.sh back into a
// plain map (shell quoting removed). Pure; never executes the script.
// Non-export lines, comments and the `print` block are ignored.
export function parseRehearsalDaemonEnvScript(text) {
  const vars = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    vars[m[1]] = unquoteShellValue(m[2]);
  }
  return vars;
}

// verifyRehearsalDaemonEnvContract (US-002 fix-2, S5/S8; STORM-REAL US-004):
// the pre-launch provenance check for the per-campaign daemon env contract.
// Attempt 2 (run #59) proved the daemon's recorded ports/cwd could match while
// the env script still omitted TAMANDUA_SCRIPTED_BEHAVIORS /
// TAMANDUA_SCRIPTED_STATE (every work round crashed `mkdir ''`) and the DERIVED
// cap (the daemon logged its default maxActiveTimers=50 vs the campaign's 52).
// This verifier reads the script (from envScriptText or
// <campaignDir>/<profile env script>) and FAILS CLOSED with
// TT_DAEMON_PROVENANCE + a non-empty reason when any recorded value is missing,
// empty, outside the private roots, or disagrees with campaign state. The
// contract is PROFILE-bound (US-004): SCRIPTED_REHEARSAL keeps its frozen
// scripted-runtime/guard contract byte-identically, while REAL requires the
// resolved roster harness binaries, no forced TAMANDUA_TEST_GUARD, plus the
// same cap/ports checks.
export function verifyRehearsalDaemonEnvContract({ envScriptText = undefined, daemonPorts = null, privateStateDir = null, activeCap = null, campaignDir = null, fsx = null, profile = undefined, realHarnessPins = null } = {}) {
  const deny = (reason) => ({ ok: false, code: TT_DAEMON_PROVENANCE, reason });
  // STORM-REAL US-004: the contract is PROFILE-bound. REAL selects the real
  // env script and the real prerequisites (every resolved roster harness
  // binary, no forced guard); SCRIPTED_REHEARSAL keeps the frozen scripted-
  // runtime contract unchanged. The default (no profile supplied) is the
  // scripted rehearsal so every existing caller keeps its exact behaviour.
  const real = profile === REAL;
  const envScriptName = real ? REAL_DAEMON_ENV_NAME : REHEARSAL_DAEMON_ENV_NAME;

  let text = typeof envScriptText === 'string' && envScriptText.trim() !== '' ? envScriptText : null;
  if (text === null) {
    if (typeof campaignDir !== 'string' || campaignDir.trim() === '') {
      return deny('campaign daemon env script text/location is absent — the scripted-runtime env contract cannot be verified; refusing before any launch');
    }
    if (!fsx || typeof fsx.readFileSync !== 'function') {
      return deny('campaign daemon env script cannot be read (no fs adapter) — the scripted-runtime env contract cannot be verified; refusing before any launch');
    }
    const scriptPath = path.join(String(campaignDir), envScriptName);
    try {
      text = String(fsx.readFileSync(scriptPath));
    } catch (err) {
      return deny(`campaign daemon env script is missing/unreadable: ${scriptPath} (${err?.message ?? String(err)}) — refusing before any launch`);
    }
    if (text.trim() === '') return deny(`campaign daemon env script is empty: ${scriptPath} — refusing before any launch`);
  }
  const vars = parseRehearsalDaemonEnvScript(text);

  if (real) {
    // 1) REAL: TAMANDUA_TEST_GUARD must NOT be forced. The contained real
    // daemon runs under the campaign's own private roots (which can live under
    // an operator ~/.tamandua worktree), so guard=1 would make the product's
    // ~/.tamandua prefix check reject a legitimate campaign state dir.
    if (String(vars.TAMANDUA_TEST_GUARD ?? '') === '1') {
      return deny('REAL daemon env script forces TAMANDUA_TEST_GUARD=1 — the real contained daemon must run with the product test guard unset (STORM-REAL US-004); refusing before any launch');
    }
  } else {
    // 1) Scripted behaviors: present, non-empty, absolute, existing.
    const behaviors = vars.TAMANDUA_SCRIPTED_BEHAVIORS;
    if (typeof behaviors !== 'string' || behaviors.trim() === '') {
      return deny('daemon env script is missing/empty TAMANDUA_SCRIPTED_BEHAVIORS — the frozen scripted runtime would fast-fail with no scripted behavior; refusing before any launch');
    }
    if (!path.isAbsolute(behaviors)) {
      return deny(`TAMANDUA_SCRIPTED_BEHAVIORS must be an absolute path (got ${JSON.stringify(behaviors)}) — refusing before any launch`);
    }
    if (!fsx || typeof fsx.existsSync !== 'function' || !fsx.existsSync(behaviors)) {
      return deny(`TAMANDUA_SCRIPTED_BEHAVIORS file does not exist: ${behaviors} — refusing before any launch`);
    }

    // 2) Scripted state dir: present, non-empty, contained under the private root.
    const scriptedState = vars.TAMANDUA_SCRIPTED_STATE;
    if (typeof scriptedState !== 'string' || scriptedState.trim() === '') {
      return deny("daemon env script is missing/empty TAMANDUA_SCRIPTED_STATE — the frozen scripted runtime would mkdir('') and crash; refusing before any launch");
    }
    if (typeof privateStateDir !== 'string' || privateStateDir.trim() === '') {
      return deny('campaign state.exec_identity.state_root is absent — the scripted state dir containment cannot be verified; refusing before any launch');
    }
    const realRoot = realpathOrNearestReal(privateStateDir, fsx);
    const realState = realpathOrNearestReal(scriptedState, fsx);
    if (!pathIsWithin(realRoot, realState)) {
      return deny(`TAMANDUA_SCRIPTED_STATE ${realState} is outside the campaign private state root ${realRoot} — refusing before any launch`);
    }
  }

  // 3) HERMES_HOME (read by runtime-hermes.mjs / the real hermes harness).
  const hermesHome = vars.HERMES_HOME;
  if (typeof hermesHome !== 'string' || hermesHome.trim() === '') {
    return deny('daemon env script is missing/empty HERMES_HOME — the frozen hermes runtime reads it; refusing before any launch');
  }

  // 4) Harness binaries. REAL requires EVERY resolved roster harness the
  // campaign pinned (absolute, existing, and matching the pin);
  // SCRIPTED_REHEARSAL requires the frozen scripted pi/hermes binaries exactly
  // as before.
  if (real) {
    const expectedHarnesses = Object.keys(realHarnessPins ?? {});
    if (expectedHarnesses.length === 0) {
      return deny('REAL daemon env contract requires the campaign real harness pins (state.rehearsal.runtime_pins.harnesses) — the real harness binaries cannot be verified; refusing before any launch');
    }
    for (const harness of expectedHarnesses) {
      const key = HARNESS_BINARY_ENV[harness];
      if (!key) {
        return deny(`REAL daemon env contract: pinned harness ${JSON.stringify(harness)} has no env mapping — refusing before any launch`);
      }
      const p = vars[key];
      if (typeof p !== 'string' || p.trim() === '') {
        return deny(`REAL daemon env script is missing/empty ${key} (real ${harness} harness binary) — refusing before any launch`);
      }
      if (!path.isAbsolute(p)) {
        return deny(`${key} must be an absolute path (got ${JSON.stringify(p)}) — refusing before any launch`);
      }
      if (!fsx || typeof fsx.existsSync !== 'function' || !fsx.existsSync(p)) {
        return deny(`real ${harness} harness binary does not exist: ${p} — refusing before any launch`);
      }
      const pinned = realHarnessPins?.[harness]?.path;
      if (typeof pinned === 'string' && pinned.length > 0 && pinned !== p) {
        return deny(`${key} ${p} does not match the pinned ${harness} harness ${pinned} — refusing before any launch`);
      }
    }
  } else {
    // Frozen scripted pi/hermes binaries: present, non-empty, absolute, exist.
    for (const [key, label] of [['TAMANDUA_PI_BINARY', 'pi'], ['TAMANDUA_HERMES_BINARY', 'hermes']]) {
      const p = vars[key];
      if (typeof p !== 'string' || p.trim() === '') {
        return deny(`daemon env script is missing/empty ${key} (frozen scripted ${label} binary) — refusing before any launch`);
      }
      if (!path.isAbsolute(p)) {
        return deny(`${key} must be an absolute path (got ${JSON.stringify(p)}) — refusing before any launch`);
      }
      if (!fsx || typeof fsx.existsSync !== 'function' || !fsx.existsSync(p)) {
        return deny(`frozen scripted ${label} binary does not exist: ${p} — refusing before any launch`);
      }
    }
  }

  // 5) Derived cap must reach the DAEMON (S8).
  if (activeCap === null || activeCap === undefined || String(activeCap).trim() === '') {
    return deny('campaign state.source.active_cap is absent — the daemon timer cap cannot be verified; refusing before any launch');
  }
  const wantCap = String(activeCap);
  if (String(vars.TAMANDUA_MAX_ACTIVE_TIMERS ?? '') !== wantCap) {
    return deny(`daemon env TAMANDUA_MAX_ACTIVE_TIMERS ${JSON.stringify(vars.TAMANDUA_MAX_ACTIVE_TIMERS ?? null)} !== campaign active_cap ${wantCap} — the daemon would run its default cap; refusing before any launch`);
  }

  // 6) Listener ports must match the campaign allocation exactly, in order
  // [dashboard, mcp, control], and never be a production port.
  if (!daemonPorts || typeof daemonPorts !== 'object') {
    return deny("campaign state carries no recorded state.daemon_ports — the daemon listeners cannot be verified; refusing before any launch");
  }
  const wantPorts = [daemonPorts.dashboard, daemonPorts.mcp, daemonPorts.control];
  if (wantPorts.some((v) => v === undefined || v === null || String(v).trim() === '')) {
    return deny(`campaign state.daemon_ports is incomplete (${JSON.stringify(daemonPorts)}) — the daemon listeners cannot be verified; refusing before any launch`);
  }
  const gotPorts = [vars.TAMANDUA_DASHBOARD_PORT, vars.TAMANDUA_MCP_PORT, vars.TAMANDUA_CONTROL_PORT];
  if (gotPorts.some((v, i) => String(v ?? '') !== String(wantPorts[i]))) {
    return deny(`daemon env ports ${JSON.stringify(gotPorts)} do not match the campaign allocation ${JSON.stringify(wantPorts.map(String))} (dashboard, mcp, control) — refusing before any launch`);
  }
  if (wantPorts.map(Number).some((n) => PRODUCTION_PORTS.includes(n))) {
    return deny(`campaign daemon_ports include a production port ${JSON.stringify(wantPorts)} (3334/3338/3339) — refusing before any launch`);
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// daemon-control provenance + lifecycle object.
// ─────────────────────────────────────────────────────────────────────

// Read daemon-control's recorded provenance for a kind. daemon-control writes
// `<var>/daemon-control/<kind>.json` (per-worktree provenance carrying pid +
// process-start identity + ports + cwd). Absent/unreadable -> { found:false }.
export function readDaemonProvenance({ fsx, provenanceDir, kind }) {
  const file = path.join(String(provenanceDir), `${kind}.json`);
  try {
    if (!fsx?.existsSync?.(file)) return { found: false, file, record: null };
    const text = String(fsx.readFileSync(file));
    return { found: true, file, record: JSON.parse(text) };
  } catch {
    return { found: false, file, record: null };
  }
}

// realpathOrNearestReal: resolve a path to its real location, appending the
// not-yet-existing tail when the leaf does not exist (mirrors the safeRealpath
// convention in tt-storm-real.mjs). Falls back to the lexical absolute path
// when no fs adapter is supplied.
function realpathOrNearestReal(p, fsx) {
  const abs = path.resolve(String(p));
  if (fsx && typeof fsx.realpathSync === 'function') {
    let cur = abs;
    const tail = [];
    for (;;) {
      try {
        return path.join(fsx.realpathSync(cur), ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
  return abs;
}

// verifyRehearsalDaemonProvenance (S1 verify, run #56): compare the RUNNING
// daemon's daemon-control provenance against the campaign's recorded bind0
// allocation and private containment BEFORE any launch. Run #56 booted the
// daemon under var/home-scripted on fixed 5334/5338/5339 while
// state.daemon_ports recorded 44239/40023/37853 and nothing compared them.
//
// Fail-closed: a missing/unreadable provenance, a missing daemon_ports
// allocation, a port mismatch (normalized to strings, order
// [dashboard, mcp, control]) or a missing/blank/foreign cwd is ALWAYS a
// refusal — never a pass. The cwd must resolve (real path) within or equal to
// the campaign's private state root (state.exec_identity.state_root).
export function verifyRehearsalDaemonProvenance({ provenance, daemonPorts, privateStateDir, fsx = null } = {}) {
  const deny = (reason) => ({ ok: false, code: TT_DAEMON_PROVENANCE, reason });
  if (!provenance || provenance.found !== true || !provenance.record || typeof provenance.record !== 'object') {
    return deny('running daemon provenance is absent or unreadable — the daemon identity cannot be verified; refusing before any launch');
  }
  if (!daemonPorts || typeof daemonPorts !== 'object') {
    return deny("campaign state carries no recorded state.daemon_ports — the running daemon's listeners cannot be verified; refusing before any launch");
  }
  const wantRaw = [daemonPorts.dashboard, daemonPorts.mcp, daemonPorts.control];
  if (wantRaw.some((v) => v === undefined || v === null || String(v).trim() === '')) {
    return deny(`campaign state.daemon_ports is incomplete (${JSON.stringify(daemonPorts)}) — the running daemon's listeners cannot be verified; refusing before any launch`);
  }
  const want = wantRaw.map((v) => String(v));
  const gotRaw = provenance.record.ports;
  const got = Array.isArray(gotRaw) ? gotRaw.map((v) => String(v)) : null;
  if (!got || got.length !== want.length || got.some((v, i) => v !== want[i])) {
    return deny(`running daemon provenance ports ${JSON.stringify(gotRaw ?? null)} do not match the campaign allocation [${want.join(', ')}] (dashboard, mcp, control) — refusing before any launch`);
  }
  const cwd = provenance.record.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return deny('running daemon provenance carries no cwd — the daemon containment cannot be verified; refusing before any launch');
  }
  if (typeof privateStateDir !== 'string' || privateStateDir.trim() === '') {
    return deny('campaign state.exec_identity.state_root is absent — the private state root cannot be verified; refusing before any launch');
  }
  const realRoot = realpathOrNearestReal(privateStateDir, fsx);
  const realCwd = realpathOrNearestReal(cwd, fsx);
  if (!pathIsWithin(realRoot, realCwd)) {
    return deny(`running daemon cwd ${realCwd} is outside the campaign private state root ${realRoot} — refusing before any launch`);
  }
  return { ok: true };
}

// The verifier inputs a campaign state must carry. The private state root is
// read ONLY from state.exec_identity.state_root (the persisted trusted
// allocation receipt); a fallback derived from state.rehearsal is NOT allowed
// and simply yields a mismatch.
function rehearsalDaemonProvenanceInputs(state) {
  return {
    daemonPorts: state?.daemon_ports ?? null,
    privateStateDir: state?.exec_identity?.state_root ?? null,
  };
}

// makeRehearsalDaemonControl — the rehearsal run layer's daemon-control
// handle: canonical argv + dispatch through the ctx proc adapter (real or
// recording) + provenance reads. The proc adapter (makeRealProc / the
// recording gate) is what locks argv[0] to the absolute daemon-control binary
// and the private child env — this handle never spawns anything itself.
export function makeRehearsalDaemonControl({ proc, kind = REHEARSAL_DAEMON_KIND, fsx = null, provenanceDir = null }) {
  if (!proc || typeof proc.daemonControl !== 'function') {
    throw refusal('makeRehearsalDaemonControl requires a proc bundle with a daemonControl channel', 'TT_USAGE');
  }
  const control = {
    kind,
    argFor: (op) => daemonControlArgv(kind, op),
    async dispatch(op, opts = {}) {
      const built = daemonControlArgv(kind, op);
      if (!built.ok) throw refusal(built.reason, 'TT_USAGE');
      return proc.daemonControl(built.argv, opts);
    },
    provenance: () => (provenanceDir && fsx ? readDaemonProvenance({ fsx, provenanceDir, kind }) : { found: false, file: null, record: null }),
  };
  return control;
}

// Status classification of a daemon-control `status` result + provenance.
// RUNNING requires: exit 0, the result stream carries the wrapper's running
// marker, and (when provenance exists) the recorded pid is alive per the
// result. Anything unreadable is UNKNOWN — never assumed stopped/running.
export function classifyDaemonStatus({ result, provenance, kind }) {
  const out = { ok: result?.exitCode === 0, code: null, reason: null, running: false, pid: null, evidence: null };
  if (result?.exitCode !== 0) {
    out.code = 'TT_DAEMON_STATUS';
    out.reason = `daemon-control ${kind} status exited ${result?.exitCode}: ${String(result?.stderr ?? '').trim().slice(0, 300)}`;
    return out;
  }
  const text = `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`;
  // STOPPED markers first: `not running`/`STOPPED`/`already stopped` describe
  // a stopped daemon and must NEVER be read as RUNNING by a loose substring.
  const stopped = /not running/i.test(text) || /STOPPED/i.test(text) || /STATUS:\s*STOPPED/i.test(text) || /already stopped/i.test(text);
  const running = /STATUS:\s*RUNNING/i.test(text) || /daemon RUNNING/i.test(text) || /is running/i.test(text);
  if (!stopped && running) {
    out.running = true;
    out.pid = provenance?.found ? (provenance.record?.pid ?? null) : null;
    out.evidence = { pid: out.pid, ports: provenance?.record?.ports ?? null, startTime: provenance?.record?.startTime ?? null, statusText: text.trim().slice(0, 200) };
    return out;
  }
  if (stopped) return out; // running:false, ok:true
  out.code = 'TT_DAEMON_UNKNOWN';
  out.reason = `daemon-control ${kind} status output did not classify RUNNING/STOPPED: ${text.trim().slice(0, 300)}`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Rehearsal run-mode opts overlay from the prepared campaign state.
// ─────────────────────────────────────────────────────────────────────

// Derive the run ctx opts overlay from the US-001 prepared campaign state
// (state.rehearsal): the per-run task files, fixture identity, owned repos,
// worktree root, task-file root and daemon kind. When `daemonPorts` (the
// bind0 allocation recorded at daemon start) is supplied, read-path pounding
// is wired to the private daemon's dashboard + MCP endpoints. A campaign
// without a rehearsal bundle is refused — the engine never re-derives a
// substitute profile.
export function rehearsalRunOptsFromState(state, { daemonPorts = null } = {}) {
  const rh = state?.rehearsal;
  if (!rh || typeof rh !== 'object') {
    return { ok: false, opts: null, reason: 'campaign carries no rehearsal bundle (state.rehearsal) — run-mode overlay requires a US-001 prepared rehearsal campaign' };
  }
  const manifest = rh.task_manifest ?? {};
  const taskFiles = {};
  for (const [runName, m] of Object.entries(manifest)) {
    if (m && m.rosterId && m.file) taskFiles[m.rosterId] = m.file;
  }
  const inputs = rh.inputs ?? {};
  const fixture = inputs.fixture ?? {};
  const fixtureIdentity = rh.fixture_identity
    ?? {
      originRepo: fixture.originRepo ?? null,
      colleagueRepo: fixture.colleagueRepo ?? null,
      parkRepo: fixture.parkRepo ?? null,
      cc1File: null,
      cc2File: null,
      seedRef: 'seed/storm',
    };
  const opts = {
    profile: rh.profile ?? null,
    label: rh.label ?? null,
    taskFiles,
    taskFileRoot: inputs.tasksRoot ?? null,
    worktreeRoot: inputs.worktreeRoot ?? null,
    fixtureIdentity: {
      originRepo: fixtureIdentity.originRepo ?? null,
      colleagueRepo: fixtureIdentity.colleagueRepo ?? null,
      parkRepo: fixtureIdentity.parkRepo ?? null,
      cc1File: fixtureIdentity.cc1File ?? null,
      cc2File: fixtureIdentity.cc2File ?? null,
      seedRef: fixtureIdentity.seedRef ?? 'seed/storm',
    },
    originRepo: fixtureIdentity.originRepo ?? null,
    colleagueRepo: fixtureIdentity.colleagueRepo ?? null,
    parkRepo: fixtureIdentity.parkRepo ?? null,
    daemonKind: rh.resource_plan?.daemon?.kind ?? REHEARSAL_DAEMON_KIND,
  };
  if (daemonPorts && daemonPorts.dashboard && daemonPorts.mcp) {
    opts.pounding = {
      dashboardUrl: `http://127.0.0.1:${daemonPorts.dashboard}/`,
      mcpToolNames: [...REHEARSAL_MCP_TOOLS],
      mcpToolArgs: { ...REHEARSAL_MCP_TOOL_ARGS },
      mcpEndpoint: `http://127.0.0.1:${daemonPorts.mcp}/mcp`,
      cadenceMs: REHEARSAL_POUND_INTERVAL_MS,
      latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,
    };
  }
  return { ok: true, opts, state };
}

// ─────────────────────────────────────────────────────────────────────
// Rehearsal daemon lifecycle orchestration (recorded; driven through the
// ctx.proc.daemonControl adapter so the recording gate never spawns).
// ─────────────────────────────────────────────────────────────────────

function oprec(ops) {
  return { record: (kind, detail = {}) => { try { ops?.record?.(kind, detail); } catch { /* ops is best-effort */ } } };
}

function daemonControlFromCtx(ctx, kind) {
  const provenanceDir = ctx.opts?.daemonProvenanceDir ?? null;
  return makeRehearsalDaemonControl({ proc: ctx.proc, kind, fsx: ctx.fs ?? null, provenanceDir });
}

// ensureRehearsalDaemon — make the ONE private daemon available for the
// campaign: reattach when the recorded daemon is still running (status
// verifies the exact recorded provenance, never a name match), otherwise
// dispatch `daemon-control <kind> start` and record the provenance evidence
// into state.daemon. Before returning ok:true — after BOTH branches — the
// daemon's daemon-control provenance is verified against the campaign's
// recorded state.daemon_ports and private state root (TT_DAEMON_PROVENANCE on
// mismatch, no record persisted). This is rehearsal-gate-only
// (ctx.opts.rehearsalRun): outside a rehearsal run it REFUSES rather than
// silently starting a daemon.
export async function ensureRehearsalDaemon(ctx, state, ops = null) {
  const rec = oprec(ops);
  const kind = ctx.opts?.daemonKind ?? state?.rehearsal?.resource_plan?.daemon?.kind ?? REHEARSAL_DAEMON_KIND;
  if (ctx.opts?.rehearsalRun !== true) {
    return { ok: false, code: TT_REHEARSAL_DAEMON, reason: `daemon lifecycle is rehearsal-gate-only (ctx.opts.rehearsalRun !== true); refusing to start a ${kind} daemon outside the approved rehearsal`, daemon: null };
  }
  if (typeof ctx.proc?.daemonControl !== 'function') {
    return { ok: false, code: TT_REHEARSAL_DAEMON, reason: 'no ctx.proc.daemonControl adapter — daemon-control is unavailable in this context', daemon: null };
  }
  const control = daemonControlFromCtx(ctx, kind);
  // S1 verify (run #56): the RUNNING daemon must prove it is the campaign's
  // own private daemon — its recorded bind0 ports must equal state.daemon_ports
  // and its cwd must live under the persisted private state root. The verifier
  // runs after BOTH the reattach-status branch and the fresh-start branch,
  // BEFORE this function ever returns ok:true.
  const provenanceInputs = rehearsalDaemonProvenanceInputs(state);
  const verifyDaemon = (prov, mode) => {
    const verified = verifyRehearsalDaemonProvenance({ provenance: prov, ...provenanceInputs, fsx: ctx.fs ?? null });
    if (!verified.ok) {
      rec.record('daemon.provenance.refused', {
        daemonKind: kind,
        mode,
        code: verified.code,
        reason: verified.reason,
        provenanceFile: prov?.file ?? null,
      });
    }
    return verified;
  };
  // US-002 (fix-2, S5/S8): AFTER the provenance identity check and BEFORE any
  // daemon record is persisted, verify the campaign's daemon.env.sh carries the
  // COMPLETE scripted-runtime contract (behaviors + private state dir) and the
  // DERIVED timer cap. Attempt 2 (run #59) had a matching provenance while the
  // script omitted both, so every work round crashed and the daemon ran its
  // default cap. Fail-closed on BOTH the reattach and fresh-start branches.
  const envContractInputs = () => ({
    daemonPorts: state?.daemon_ports ?? null,
    privateStateDir: state?.exec_identity?.state_root ?? null,
    activeCap: state?.source?.active_cap ?? null,
    campaignDir: ctx.campaignDir ?? null,
    fsx: ctx.fs ?? null,
    // STORM-REAL US-004: the env contract is profile-bound. A REAL campaign
    // verifies the real harness pins recorded at prepare; the default
    // (SCRIPTED_REHEARSAL) keeps the frozen scripted-runtime contract.
    profile: state?.rehearsal?.profile ?? null,
    realHarnessPins: state?.rehearsal?.runtime_pins?.harnesses ?? null,
  });
  const verifyEnvContract = (mode) => {
    const verified = verifyRehearsalDaemonEnvContract(envContractInputs());
    if (!verified.ok) {
      rec.record('daemon.env_contract.refused', {
        daemonKind: kind,
        mode,
        code: verified.code,
        reason: verified.reason,
      });
    }
    return verified;
  };
  const existing = state?.daemon ?? null;
  if (existing?.status === 'running' && existing?.evidence?.pid) {
    // Reattach: verify the EXACT recorded daemon (daemon-control's own
    // recorded identity gates the wrapper; we additionally require the status
    // to name a running daemon). Reattach NEVER starts a second daemon.
    rec.record('daemon.reattach.intent', { kind, recordedPid: existing.evidence.pid });
    const statusResult = await control.dispatch('status', {});
    const prov = control.provenance();
    const status = classifyDaemonStatus({ result: statusResult, provenance: prov, kind });
    if (status.ok && status.running) {
      const verified = verifyDaemon(prov, 'reattach');
      if (!verified.ok) {
        return { ok: false, code: verified.code, reason: verified.reason, daemon: null };
      }
      const envVerified = verifyEnvContract('reattach');
      if (!envVerified.ok) {
        return { ok: false, code: envVerified.code, reason: envVerified.reason, daemon: null };
      }
      rec.record('daemon.reattached', { kind, pid: status.pid ?? existing.evidence.pid, provenanceFile: prov.file });
      return { ok: true, reattached: true, daemon: { ...existing, status: 'running', reattachedAt: ctx.clock?.nowUtc ? ctx.clock.nowUtc() : new Date().toISOString() }, control };
    }
    // The recorded daemon is gone (crash/bounce) — fall through to a fresh
    // start of the SAME kind; the old record is retained for forensics.
    rec.record('daemon.reattach.failed', { kind, recordedPid: existing.evidence.pid, reason: status.reason ?? 'daemon not running' });
  }
  rec.record('daemon.start.intent', { kind, argv: control.argFor('start').argv });
  const result = await control.dispatch('start', {});
  rec.record('daemon.start.result', { kind, exitCode: result?.exitCode, stdoutTail: (result?.stdout ?? '').slice(-300), stderrTail: (result?.stderr ?? '').slice(-300) });
  const prov = control.provenance();
  if (result?.exitCode !== 0 || !prov.found || !prov.record?.pid) {
    return {
      ok: false,
      code: TT_DAEMON_NOT_EVIDENCED,
      reason: `daemon-control ${kind} start produced no positive provenance evidence (exit ${result?.exitCode}, provenance found=${prov.found}): ${String(result?.stderr ?? '').trim().slice(0, 300)}`,
      daemon: null,
    };
  }
  const daemon = {
    kind,
    status: 'running',
    started_at: ctx.clock?.nowUtc ? ctx.clock.nowUtc() : new Date().toISOString(),
    evidence: {
      pid: prov.record.pid,
      ports: prov.record.ports ?? null,
      startTime: prov.record.startTime ?? null,
      cwd: prov.record.cwd ?? null,
      startedAt: prov.record.startedAt ?? null,
      provenanceFile: prov.file,
      scopeUnit: prov.record.scopeUnit ?? null,
      cgroupVerified: prov.record.cgroupVerified ?? null,
    },
  };
  // S1 verify BEFORE persisting any daemon record: a mismatched provenance is
  // refused fail-closed and leaves state.daemon untouched.
  const verifiedStart = verifyDaemon(prov, 'start');
  if (!verifiedStart.ok) {
    return { ok: false, code: verifiedStart.code, reason: verifiedStart.reason, daemon: null };
  }
  // US-002 (fix-2, S5/S8): the env contract must ALSO hold before any daemon
  // record is persisted (provenance identity alone let attempt 2 launch a daemon
  // whose env omitted the scripted-runtime contract + derived cap).
  const envVerifiedStart = verifyEnvContract('start');
  if (!envVerifiedStart.ok) {
    return { ok: false, code: envVerifiedStart.code, reason: envVerifiedStart.reason, daemon: null };
  }
  if (state) state.daemon = daemon;
  rec.record('daemon.started', { kind, pid: daemon.evidence.pid, ports: daemon.evidence.ports, provenanceFile: prov.file });
  return { ok: true, reattached: false, daemon, control };
}

// stopRehearsalDaemon — positive closure for the recorded daemon. Requires a
// state.daemon record (identity); dispatches `daemon-control <kind> stop`
// (the wrapper's own recorded process-start identity gates the signal) and
// returns evidence: stop exit 0 AND the provenance/status no longer RUNNING.
export async function stopRehearsalDaemon(ctx, state, ops = null) {
  const rec = oprec(ops);
  const kind = ctx.opts?.daemonKind ?? state?.rehearsal?.resource_plan?.daemon?.kind ?? REHEARSAL_DAEMON_KIND;
  const existing = state?.daemon ?? null;
  if (!existing || typeof ctx.proc?.daemonControl !== 'function') {
    rec.record('daemon.stop.unknown', { kind, reason: existing ? 'no daemon-control adapter' : 'no recorded daemon to stop' });
    return { ok: false, code: TT_DAEMON_NOT_EVIDENCED, evidenced: false, reason: 'no recorded owned daemon (state.daemon) to stop' };
  }
  const control = daemonControlFromCtx(ctx, kind);
  rec.record('daemon.stop.intent', { kind, recordedPid: existing.evidence?.pid ?? null });
  const result = await control.dispatch('stop', {});
  rec.record('daemon.stop.result', { kind, exitCode: result?.exitCode, stdoutTail: (result?.stdout ?? '').slice(-300), stderrTail: (result?.stderr ?? '').slice(-300) });
  // Positive closure requires the wrapper's stop to succeed AND the recorded
  // provenance to no longer describe a running daemon (status verification).
  const statusResult = await control.dispatch('status', {});
  const prov = control.provenance();
  const status = classifyDaemonStatus({ result: statusResult, provenance: prov, kind });
  const closed = result?.exitCode === 0 && (status.ok === true) && status.running === false;
  const evidence = {
    evidenced: closed,
    stopExit: result?.exitCode,
    statusText: `${String(statusResult?.stdout ?? '')}${String(statusResult?.stderr ?? '')}`.trim().slice(0, 200),
    provenanceFile: prov.file,
    recordedPid: existing.evidence?.pid ?? null,
    retained: 'daemon logs/provenance retained (no-removal policy)',
  };
  if (closed) {
    if (state?.daemon) state.daemon = { ...state.daemon, status: 'stopped', stopped_at: ctx.clock?.nowUtc ? ctx.clock.nowUtc() : new Date().toISOString(), evidence: { ...state.daemon.evidence, closed } };
    rec.record('daemon.stopped', { kind, recordedPid: existing.evidence?.pid ?? null });
    return { ok: true, evidenced: true, evidence };
  }
  return { ok: false, code: TT_DAEMON_NOT_EVIDENCED, evidenced: false, evidence, reason: `daemon-control ${kind} stop did not produce positive closed evidence (stop exit ${result?.exitCode}, status running=${status.running}): ${status.reason ?? ''}`.trim() };
}

// ─────────────────────────────────────────────────────────────────────
// US-004 (fix-2, S6): campaign-owned standalone listener cleanup.
//
// Attempt 2 stopped the recorded daemon (daemon-control stop exit 0,
// provenance stoppedAt) but its standalone dashboard/MCP children were
// orphaned to PID 1 and kept LISTENING on the campaign's bind0-allocated
// ports 43935/39675 while `tt-storm report` printed `all owned cleanup phases
// ok`. The daemon-control wrapper's own stop gate checks the kind's FIXED
// ports (ports_for_kind -> 5334/5338/5339) AND only waits on pid-file
// children, so a bind0-allocated campaign's standalone children can escape
// it. Cleanup therefore INDEPENDENTLY reaps the campaign's listeners by
// PROVENANCE and verifies the campaign's OWN three allocated ports are free.
//
// Provenance sources ONLY: (a) the recorded daemon pid's descendant chain
// captured before/at stop (orphaned children keep no parent link after the
// stop), (b) the campaign state dir's dashboard.pid/mcp.pid pid files, and
// (c) the daemon-control provenance record. A pid is signalled ONLY after it
// is proven TT-owned AND tied to the campaign state dir; an unverifiable pid
// is refused and counted as a survivor. NO name/glob/port-scan kills: the
// campaign's own ports are only PROBED, never used to discover/kill a pid.
// ─────────────────────────────────────────────────────────────────────

// Real /proc-backed process operations for the cleanup handler. Every read is
// best-effort (null on failure) and a zombie is NOT alive (kill(pid,0)
// succeeds for a zombie until it is reaped). Injectable so the self-test can
// drive the handler without real signals.
export function makeRehearsalProcessOps({ fsx = fs } = {}) {
  const readText = (p) => {
    try {
      return fsx.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    alive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
      } catch (err) {
        return err?.code === 'EPERM';
      }
      // kill(0) also succeeds for a zombie; read the state to treat it as gone.
      const stat = readText(`/proc/${pid}/stat`);
      if (stat) {
        const idx = stat.lastIndexOf(')');
        if (idx >= 0) {
          const state = stat.slice(idx + 2).trim().split(/\s+/)[0];
          if (state === 'Z' || state === 'X') return false;
        }
      }
      return true;
    },
    readCwd: (pid) => {
      try {
        return fsx.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    },
    readCmdline: (pid) => {
      const raw = readText(`/proc/${pid}/cmdline`);
      return raw === null ? null : raw.replace(/\0/g, ' ').trim();
    },
    readEnviron: (pid) => {
      const raw = readText(`/proc/${pid}/environ`);
      if (raw === null) return null;
      const env = {};
      for (const kv of raw.split('\0')) {
        const eq = kv.indexOf('=');
        if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      return env;
    },
    listPids: () => {
      try {
        return fsx.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
      } catch {
        return [];
      }
    },
    ppidOf: (pid) => {
      const stat = readText(`/proc/${pid}/stat`);
      if (!stat) return null;
      const idx = stat.lastIndexOf(')');
      if (idx < 0) return null;
      const ppid = Number(stat.slice(idx + 2).trim().split(/\s+/)[1]);
      return Number.isInteger(ppid) ? ppid : null;
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

// All descendants of `rootPid` from the live process table (before/at stop).
// Orphaned children lose the parent link after the stop, so this MUST run
// while the recorded daemon is still alive.
export function collectRehearsalDescendantPids(rootPid, ops = null) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const active = ops ?? makeRehearsalProcessOps();
  const childrenOf = new Map();
  for (const pid of active.listPids()) {
    const ppid = active.ppidOf(pid);
    if (ppid === null) continue;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// Read one campaign state-dir pid file (dashboard.pid / mcp.pid). Only a
// positive integer is accepted; a missing/garbage file yields null.
export function readRehearsalStatePidFile({ fsx = fs, privateStateDir = null, name } = {}) {
  if (!privateStateDir || !name) return null;
  try {
    const raw = String(fsx.readFileSync(path.join(privateStateDir, name), 'utf8')).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Classify whether `pid` is a campaign-owned listener. Accepts ONLY a pid
// that is (a) tied to the campaign private state dir (its environ names the
// exact TAMANDUA_STATE_DIR, or its cwd lives under that dir) AND (b)
// TT-owned (its cmdline names tamandua / this repo's built daemon family, or
// its cwd is under the campaign state dir). Anything unverifiable is REFUSED.
export function classifyRehearsalCampaignListenerPid(pid, { privateStateDir = null, repoRoot = REPO_ROOT, ops = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: `pid ${JSON.stringify(pid)} is not a positive integer` };
  if (!privateStateDir) return { ok: false, reason: `pid ${pid} cannot be tied to a campaign state dir (none recorded)` };
  const active = ops ?? makeRehearsalProcessOps();
  const cwd = active.readCwd(pid);
  const cmdline = active.readCmdline(pid);
  const environ = active.readEnviron(pid);
  if (environ && environ.TAMANDUA_STATE_DIR && environ.TAMANDUA_STATE_DIR !== privateStateDir) {
    return { ok: false, reason: `pid ${pid} is tied to a different state dir (${environ.TAMANDUA_STATE_DIR})` };
  }
  const envTie = Boolean(environ && environ.TAMANDUA_STATE_DIR === privateStateDir);
  const cwdTie = Boolean(cwd) && pathIsWithin(privateStateDir, cwd);
  if (!envTie && !cwdTie) {
    return { ok: false, reason: `pid ${pid} is not tied to the campaign state dir (cwd=${cwd ?? 'unreadable'}, TAMANDUA_STATE_DIR=${environ?.TAMANDUA_STATE_DIR ?? 'unset'})` };
  }
  const distServerDir = path.join(repoRoot, 'dist', 'server');
  const ownedCmdline = Boolean(cmdline) && (cmdline.includes('tamandua') || cmdline.includes(distServerDir));
  if (!ownedCmdline && !cwdTie) {
    return { ok: false, reason: `pid ${pid} cmdline does not prove TT ownership (${cmdline ?? 'unreadable'})` };
  }
  return { ok: true, cwd, cmdline, envTie, cwdTie };
}

// Stop one identity-verified campaign listener with SIGTERM then, after a
// bounded wait, SIGKILL — re-verifying identity immediately before the
// escalation (ABA-safe). Returns { ok:true, signal } only once the pid is
// gone; otherwise { ok:false, reason } (the caller counts a survivor).
export async function stopRehearsalCampaignListenerPid(pid, { privateStateDir = null, ops = null, waitMs = 5_000, pollMs = 100 } = {}) {
  const active = ops ?? makeRehearsalProcessOps();
  active.signal(pid, 'SIGTERM');
  const termDeadline = Date.now() + waitMs;
  while (Date.now() < termDeadline) {
    if (!active.alive(pid)) return { ok: true, signal: 'SIGTERM' };
    // eslint-disable-next-line no-await-in-loop
    await active.sleep(pollMs);
  }
  if (active.alive(pid)) {
    const again = classifyRehearsalCampaignListenerPid(pid, { privateStateDir, ops: active });
    if (!again.ok) return { ok: false, reason: `pid ${pid} identity changed before SIGKILL: ${again.reason}` };
    active.signal(pid, 'SIGKILL');
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      if (!active.alive(pid)) return { ok: true, signal: 'SIGKILL' };
      // eslint-disable-next-line no-await-in-loop
      await active.sleep(pollMs);
    }
  }
  return { ok: false, reason: `pid ${pid} survived SIGTERM and SIGKILL` };
}

// Bounded 127.0.0.1 TCP-connect probe: resolve true ONLY when the connection
// is refused (the port is free). A connect/timeout means a listener is
// present; an unexpected failure is resolved as "not free" so cleanup fails
// closed rather than blessing an unverifiable port.
export function probeTcpPortFree(port, { timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      resolve(false);
      return;
    }
    let settled = false;
    let socket;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      resolve(free);
    };
    try {
      socket = net.connect({ host: '127.0.0.1', port: n });
    } catch {
      finish(false);
      return;
    }
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(false)); // something is listening
    socket.once('error', () => finish(true)); // refused => free
  });
}

async function waitPortFree(port, isPortFree, { timeoutMs = 3_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let free = false;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      free = (await isPortFree(port)) === true;
    } catch {
      free = false;
    }
    if (free) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Cleanup handler factory for the report path: stop the recorded daemon with
// POSITIVE evidence AND reap any campaign-owned standalone dashboard/MCP
// listeners by provenance, then verify the campaign's three allocated ports
// are free. Absent record/control, a non-positive stop, an unverifiable pid,
// a surviving listener, or an unverifiable port all REFUSE (evidenced:false)
// — never a silent PASS. `privateStateDir` is state.exec_identity.state_root;
// `daemonPorts` is state.daemon_ports.
export function makeRehearsalDaemonCleanupHandler({
  control,
  record,
  clock = null,
  fsx = null,
  privateStateDir = null,
  daemonPorts = null,
  processOps = null,
  isPortFree = null,
  stopWaitMs = 5_000,
} = {}) {
  return async ({ execCtx = null, resources = null } = {}) => {
    const activeControl = resources?.daemonControl ?? control;
    const activeRecord = resources?.daemonRecord ?? record;
    const activeFsx = resources?.fsx ?? fsx ?? fs;
    const activeStateDir = resources?.privateStateDir ?? privateStateDir;
    const activePorts = resources?.daemonPorts ?? daemonPorts;
    const activeOps = resources?.processOps ?? processOps ?? makeRehearsalProcessOps({ fsx: activeFsx });
    const activePortFree = resources?.isPortFree ?? isPortFree ?? ((p) => probeTcpPortFree(p));
    const now = () => (clock?.nowUtc ? clock.nowUtc() : new Date().toISOString());

    if (!activeControl || !activeRecord) {
      return { evidenced: false, error: `rehearsal-daemon cleanup requires the recorded daemon identity + daemon-control handle; absent cleanup cannot mean PASS (record=${Boolean(activeRecord)}, control=${Boolean(activeControl)})` };
    }
    if (!activeStateDir) {
      return { evidenced: false, error: 'rehearsal-daemon cleanup cannot verify campaign listeners: state.exec_identity.state_root (private state dir) is absent — the port check cannot run' };
    }
    if (!activePorts || activePorts.dashboard == null || activePorts.mcp == null || activePorts.control == null) {
      return { evidenced: false, error: `rehearsal-daemon cleanup cannot verify the campaign ports: state.daemon_ports is absent/incomplete (${JSON.stringify(activePorts)}) — the port check cannot run` };
    }
    for (const [label, port] of Object.entries({ dashboard: activePorts.dashboard, mcp: activePorts.mcp, control: activePorts.control })) {
      if (PRODUCTION_PORTS.includes(Number(port))) {
        return { evidenced: false, error: `rehearsal-daemon cleanup refuses to operate on the production ${label} port ${port}; campaign ports must never be 3334/3338/3339` };
      }
    }

    const recordedPid = Number.isInteger(activeRecord.evidence?.pid) ? activeRecord.evidence.pid : null;
    const alreadyStopped = activeRecord.status === 'stopped';
    let prov = { found: false, file: null, record: null };

    // Capture the descendant chain BEFORE the stop: once the daemon dies its
    // standalone children are reparented to PID 1 and the link is gone.
    const descendantChain = !alreadyStopped && recordedPid ? collectRehearsalDescendantPids(recordedPid, activeOps) : [];

    if (!alreadyStopped) {
      const stopResult = await activeControl.dispatch('stop', {});
      prov = activeControl.provenance ? activeControl.provenance() : { found: false, file: null, record: null };
      const statusResult = typeof activeControl.dispatch === 'function' ? await activeControl.dispatch('status', {}) : null;
      const status = classifyDaemonStatus({ result: statusResult, provenance: prov, kind: activeRecord.kind ?? REHEARSAL_DAEMON_KIND });
      const closed = stopResult?.exitCode === 0 && status.ok === true && status.running === false;
      if (!closed) {
        return { evidenced: false, error: `rehearsal-daemon stop produced no positive closed evidence (stop exit ${stopResult?.exitCode}, status running=${status.running}, reason=${status.reason ?? 'n/a'})` };
      }
    } else if (activeControl.provenance) {
      prov = activeControl.provenance() ?? prov;
    }

    // Enumerate campaign-owned standalone listeners from PROVENANCE ONLY.
    const candidates = new Set();
    for (const pid of descendantChain) candidates.add(pid);
    for (const name of ['dashboard.pid', 'mcp.pid']) {
      const pid = readRehearsalStatePidFile({ fsx: activeFsx, privateStateDir: activeStateDir, name });
      if (pid) candidates.add(pid);
    }
    if (Number.isInteger(prov?.record?.pid) && prov.record.pid > 0) candidates.add(Number(prov.record.pid));

    const survivors = [];
    const stoppedListenerPids = [];
    for (const pid of candidates) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue; // never our own process
      if (!activeOps.alive(pid)) continue;
      const verdict = classifyRehearsalCampaignListenerPid(pid, { privateStateDir: activeStateDir, ops: activeOps });
      if (!verdict.ok) {
        survivors.push({ kind: 'pid', pid, reason: verdict.reason });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const stopped = await stopRehearsalCampaignListenerPid(pid, { privateStateDir: activeStateDir, ops: activeOps, waitMs: stopWaitMs });
      if (!stopped.ok) {
        survivors.push({ kind: 'pid', pid, reason: stopped.reason });
      } else {
        stoppedListenerPids.push({ pid, signal: stopped.signal });
      }
    }

    // The campaign's OWN allocated ports are the authoritative closure check.
    const portResults = {};
    for (const [label, port] of Object.entries({ dashboard: activePorts.dashboard, mcp: activePorts.mcp, control: activePorts.control })) {
      // eslint-disable-next-line no-await-in-loop
      const free = await waitPortFree(Number(port), activePortFree);
      portResults[label] = { port: Number(port), free };
      if (!free) survivors.push({ kind: 'port', label, port: Number(port), reason: 'still listening (or the port check could not run)' });
    }

    if (survivors.length > 0) {
      return {
        evidenced: false,
        error: `rehearsal-daemon cleanup left campaign-owned listener(s)/port(s) un-closed: ${JSON.stringify(survivors)}`,
        survivors,
        ports: portResults,
        stoppedListenerPids,
        recordedPid,
      };
    }
    return {
      evidenced: true,
      stoppedAt: now(),
      recordedPid,
      provenanceFile: prov.file,
      stoppedListenerPids,
      daemonPorts: portResults,
      retained: 'daemon logs/provenance retained (no-removal policy)',
    };
  };
}

// ─────────────────────────────────────────────────────────────────────
// N4 single-flight arm prelude (spec 09: single-flight is armed by a
// controlled prelude, never hoped from the roster).
//
// The arm runs N IDENTICAL origin/tree/wrapped-command waiters through the
// tamandua-test shim and records what the underlying stack does — it never
// fabricates an outcome. Two legs are exercised:
//   * release-on-stop: N waiters dispatch; the owner executes and releases on
//     completion; every waiter observes the SAME recorded result. Verdict is
//     `single_execution` ONLY when exactly one execution and N-1 replays of
//     the same recorded run are evidenced.
//   * dead-owner-reclaim: N waiters dispatch; the orchestrator kills the
//     exact OWNER child (the only pid it may kill is one its own live launch
//     returned) mid-execution; a waiter reclaims the key and executes fresh.
//     Verdict `dead_owner_reclaimed` ONLY when a SECOND execution row exists
//     after the kill — mechanically distinct from release-on-stop.
// Every waiter intent is recorded BEFORE its launch; kills are recorded with
// the exact owned pid; MISSING/UNKNOWN evidence is never relabelled green.
// ─────────────────────────────────────────────────────────────────────

// Canonical single-flight key for identical origin/tree/wrapped-command
// waiters. Only waiters with byte-identical inputs share a key.
export function singleFlightKeyOf({ originRepo, treeSha, wrappedCommand }) {
  const canonical = JSON.stringify({
    originRepo: originRepo ?? null,
    treeSha: treeSha ?? null,
    wrappedCommand: Array.isArray(wrappedCommand) ? wrappedCommand : [wrappedCommand],
  });
  return sha256(canonical);
}

// The wrapped command argv one waiter runs through the tamandua-test shim:
// `tamandua-test --repo <tree> --run <runId> --step <step> -- <cmd...>`.
// argv[0] 'tamandua-test' is rewritten to the absolute shim by the proc
// adapter's binary lockdown (makeRealProc KNOWN_NAMES) — never a PATH guess.
export function buildSingleFlightWaiterArgv({ repo, runId, stepId, wrappedCommand }) {
  return ['tamandua-test', '--repo', repo, '--run', runId, '--step', stepId, '--', ...(Array.isArray(wrappedCommand) ? wrappedCommand : [wrappedCommand])];
}

// Parse one tamandua-test invocation result into a truthful classification.
// Evidence sources are the shim's OWN stream markers + exit code:
//   * a `TAMANDUA-TEST CACHED:` banner = a WAITER REPLAY of the recorded run
//     named in the banner (never an execution);
//   * exit 87 / interruption markers = INTERRUPTED (shim torn down mid-flight);
//   * exit 0 without a cached banner = the invocation EXECUTED the suite;
//   * non-zero without a cached banner = execution with a non-green result;
//   * unreadable/empty = UNKNOWN (never relabelled).
export function parseSingleFlightResult({ result, waiterIndex = null }) {
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  const exitCode = result?.exitCode ?? null;
  const signal = result?.signal ?? null;
  const cached = /TAMANDUA-TEST\s+CACHED:/.exec(stdout);
  if (cached) {
    const runMatch = /run #([^,)\s]+)/i.exec(stdout);
    return {
      classification: 'waiter_replay',
      runId: runMatch ? runMatch[1] : null,
      exitCode,
      evidence: stdout.trim().slice(0, 300),
      waiterIndex,
    };
  }
  if (exitCode === 87 || /interrupted|signal/i.test(`${stderr}\n${signal ?? ''}`)) {
    return { classification: 'interrupted', runId: null, exitCode, signal, evidence: stderr.trim().slice(0, 300), waiterIndex };
  }
  if (exitCode === 0) {
    return { classification: 'execution', runId: null, exitCode, evidence: stdout.trim().slice(0, 300) || '(empty stdout — suite passthrough)', waiterIndex };
  }
  if (typeof exitCode === 'number') {
    return { classification: 'execution_nonzero', runId: null, exitCode, evidence: stderr.trim().slice(0, 300), waiterIndex };
  }
  return { classification: 'unknown', runId: null, exitCode, signal, evidence: `${stdout}${stderr}`.trim().slice(0, 300), waiterIndex };
}

// Classify one single-flight LEG from its waiter results + optional ledger
// rows. Verdicts are mechanical and truthful:
//   single_execution    exactly one execution + (n-1) replays all naming the
//                       SAME recorded run;
//   multiple_executions more than one execution (single-flight broken);
//   not_all_waiters     fewer than n waiters reached a verdict;
//   replay_mismatch     replays disagree on the recorded run;
//   unknown             evidence unreadable — never green.
export function classifySingleFlightLeg({ waiterResults, ledger = null, n = null }) {
  const parsed = (waiterResults ?? []).map((r, i) => (typeof r === 'object' && r.classification ? r : parseSingleFlightResult({ result: r, waiterIndex: i })));
  const executions = parsed.filter((p) => p.classification === 'execution' || p.classification === 'execution_nonzero');
  const replays = parsed.filter((p) => p.classification === 'waiter_replay');
  const interrupted = parsed.filter((p) => p.classification === 'interrupted');
  const unknown = parsed.filter((p) => p.classification === 'unknown');
  const ledgerRows = Array.isArray(ledger) ? ledger : [];
  const ledgerExecutions = ledgerRows.filter((r) => r?.role === 'execution' || r?.role === 'reclaim');
  const replayRunIds = [...new Set(replays.map((p) => p.runId).filter(Boolean))];
  const expectedWaiters = n ?? waiterResults?.length ?? null;
  let verdict = 'unknown';
  let reason = null;
  if (unknown.length > 0) {
    reason = `${unknown.length} waiter result(s) UNREADABLE (never relabelled)`;
  } else if (expectedWaiters !== null && parsed.length < expectedWaiters) {
    verdict = 'not_all_waiters';
    reason = `only ${parsed.length}/${expectedWaiters} waiters reached a verdict`;
  } else if (executions.length > 1 || ledgerExecutions.length > 1) {
    verdict = 'multiple_executions';
    reason = `single-flight broken: ${executions.length} direct execution(s), ${ledgerExecutions.length} ledger execution(s)`;
  } else if (replays.length > 0 && replayRunIds.length !== 1) {
    verdict = 'replay_mismatch';
    reason = `waiter replays disagree on the recorded run: ${JSON.stringify(replayRunIds)}`;
  } else if (executions.length === 1 || ledgerExecutions.length === 1) {
    verdict = 'single_execution';
  } else if (interrupted.length > 0) {
    verdict = 'interrupted_no_reclaim';
    reason = `${interrupted.length} waiter(s) interrupted with no replacement execution`;
  } else {
    reason = `no execution and no replay evidence (parsed ${parsed.length}, executions ${executions.length})`;
  }
  return { verdict, reason, parsed, executions: executions.length, replays: replays.length, ledgerExecutions: ledgerExecutions.length, perWaiter: parsed };
}

// armSingleFlightPrelude — the single-flight arm prelude driver. cfg:
// {
//   n: 4,
//   originRepo, treeSha, wrappedCommand,        // identical input identity
//   waiters: [{ runId, stepId, worktree } x n], // identical trees (validated)
//   launch: async (waiter, argv) => result,     // tamandua-test shim channel
//   liveLaunch: async (waiter, argv) => ({ pid, done }),  // dead-owner leg
//   ledgerRead: async () => rows | null,        // optional mechanical ledger
//   ownerBoundMs: 15000, reclaimBoundMs: 30000, // bounded polls (cadence profile)
// }
// Recording gate tests inject benign tamandua-test children; the real gate
// wires ctx.proc (tamandua-test absolute + private env) after coordinator
// approval. Every intent is recorded before dispatch; no real daemon/harness
// is ever started by this function itself.
export async function armSingleFlightPrelude(ctx, state, ops = null) {
  const rec = oprec(ops);
  const cfg = ctx.opts?.singleFlight ?? state?.rehearsal?.single_flight ?? null;
  if (!cfg || typeof cfg !== 'object') {
    return { ok: false, code: TT_SINGLEFLIGHT_CFG, reason: 'single-flight prelude requires ctx.opts.singleFlight (or state.rehearsal.single_flight) with n/waiters/launch', legs: null };
  }
  const n = cfg.n ?? 4;
  const waiters = Array.isArray(cfg.waiters) && cfg.waiters.length >= 2 ? cfg.waiters.slice(0, n) : null;
  if (!waiters || waiters.length < 2) {
    return { ok: false, code: TT_SINGLEFLIGHT_CFG, reason: `single-flight prelude requires >=2 identical waiters (got ${waiters?.length ?? 0})`, legs: null };
  }
  const key = singleFlightKeyOf({ originRepo: cfg.originRepo, treeSha: cfg.treeSha, wrappedCommand: cfg.wrappedCommand });

  // Identical-origin/tree validation: every waiter worktree must resolve to
  // the SAME committed tree as cfg.treeSha (mechanical git read via ctx.git);
  // a mismatch refuses before any launch.
  if (cfg.treeSha && typeof ctx?.git?.run === 'function') {
    const treeOf = async (dir) => {
      try {
        const res = await ctx.git.run(dir, ['rev-parse', 'HEAD^{tree}']);
        if (res?.exitCode !== 0) return { ok: false, error: `git rev-parse HEAD^{tree} in ${dir} failed: ${String(res?.stderr ?? '').trim().slice(0, 200)}` };
        return { ok: true, sha: String(res.stdout ?? '').trim().toLowerCase() };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    };
    const resolved = [];
    for (const w of waiters) {
      // eslint-disable-next-line no-await-in-loop
      const t = await treeOf(w.worktree);
      if (!t.ok) return { ok: false, code: 'TT_SINGLEFLIGHT_TREE_UNREADABLE', reason: t.error, legs: null };
      resolved.push(t.sha);
    }
    if (resolved.some((s) => s !== cfg.treeSha)) {
      rec.record('singleflight.tree_mismatch', { expected: cfg.treeSha, resolved });
      return { ok: false, code: TT_SINGLEFLIGHT_TREE_MISMATCH, reason: `not all ${n} waiter trees are identical to the pinned tree ${cfg.treeSha}: ${JSON.stringify(resolved)}`, legs: null };
    }
  }

  const argvFor = (w) => buildSingleFlightWaiterArgv({ repo: w.worktree ?? cfg.originRepo, runId: w.runId, stepId: w.stepId ?? 'single-flight-prelude', wrappedCommand: cfg.wrappedCommand });
  // Per-leg adapters: each leg may override launch/liveLaunch/ledgerRead with
  // its own state (e.g. a fresh claim/result area for the dead-owner round) —
  // `cfg.legs[<leg>]` wins over the top-level defaults.
  const legCfg = (name) => ({ ...cfg, ...((cfg.legs && cfg.legs[name]) || {}) });

  const legs = {};

  // ── Leg 1: release-on-stop (owner completes -> waiters replay) ──────
  const leg1 = legCfg('release-on-stop');
  if (typeof leg1.launch === 'function') {
    const intents = [];
    for (let i = 0; i < waiters.length; i += 1) {
      const argv = argvFor(waiters[i]);
      intents.push(argv);
      rec.record('singleflight.intent', { leg: 'release-on-stop', key, waiter: i, runId: waiters[i].runId, argv });
    }
    // Dispatch ALL N identical waiters CONCURRENTLY (the controlled prelude:
    // same-origin/same-tree/same-command waiters contend for the key exactly
    // like the real storm would); every result is recorded per waiter index.
    const launched = await Promise.all(
      waiters.map((w, i) => leg1.launch(w, intents[i], i).then((res) => ({ res, i }))),
    );
    const results = [];
    for (const { res, i } of launched) {
      results[i] = res;
      rec.record('singleflight.result', { leg: 'release-on-stop', key, waiter: i, runId: waiters[i].runId, exitCode: res?.exitCode, signal: res?.signal ?? null });
    }
    const ledger = typeof leg1.ledgerRead === 'function' ? await leg1.ledgerRead() : null;
    const verdict = classifySingleFlightLeg({ waiterResults: results, ledger, n });
    legs['release-on-stop'] = {
      key,
      waiters: waiters.length,
      verdict: verdict.verdict,
      reason: verdict.reason ?? null,
      perWaiter: verdict.perWaiter,
      ledger: ledger ?? null,
    };
    rec.record('singleflight.leg', { leg: 'release-on-stop', key, verdict: verdict.verdict, reason: verdict.reason ?? null });
    if (verdict.verdict !== 'single_execution') {
      return { ok: false, code: 'TT_SINGLEFLIGHT_VERDICT', reason: `release-on-stop leg verdict ${verdict.verdict}: ${verdict.reason ?? ''}`.trim(), legs, verdict };
    }
  } else {
    legs['release-on-stop'] = { key, waiters: waiters.length, verdict: 'not_run', reason: 'no launch adapter for the release-on-stop leg (tamandua-test shim channel absent) — leg NOT_RUN, never fabricated' };
    rec.record('singleflight.leg', { leg: 'release-on-stop', key, verdict: 'not_run' });
  }

  // ── Leg 2: dead-owner + reclaim (exact owned owner child killed) ────
  const leg2 = legCfg('dead-owner-reclaim');
  if (typeof leg2.liveLaunch === 'function') {
    const live = [];
    for (let i = 0; i < waiters.length; i += 1) {
      const argv = argvFor(waiters[i]);
      rec.record('singleflight.intent', { leg: 'dead-owner-reclaim', key, waiter: i, runId: waiters[i].runId, argv });
      // eslint-disable-next-line no-await-in-loop
      const handle = await leg2.liveLaunch(waiters[i], argv, i);
      live.push({ waiter: waiters[i], index: i, handle });
    }
    // Owner discovery is evidence-based: poll cfg.ledgerRead for the row that
    // names the executing owner's runId/pid. Only pids OUR OWN liveLaunch
    // returned may be killed (TT_SINGLEFLIGHT_NOT_OWNED otherwise).
    const deadline = Date.now() + (leg2.ownerBoundMs ?? 15_000);
    let owner = null;
    for (;;) {
      const rows = typeof leg2.ledgerRead === 'function' ? await leg2.ledgerRead() : null;
      if (Array.isArray(rows)) {
        const ownerRow = rows.find((r) => r && (r.role === 'execution') && r.key === key);
        if (ownerRow?.pid) {
          const match = live.find((l) => l.handle && Number(l.handle.pid) === Number(ownerRow.pid));
          if (match) owner = match;
        }
      }
      if (owner) break;
      if (Date.now() >= deadline) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!owner) {
      legs['dead-owner-reclaim'] = { key, waiters: waiters.length, verdict: 'owner_unknown', reason: 'no evidence-named owner pid appeared within the owner bound — no kill attempted (never a guess)' };
      rec.record('singleflight.leg', { leg: 'dead-owner-reclaim', key, verdict: 'owner_unknown' });
      // Still wait for the live handles so no child is left behind.
      await Promise.all(live.map((l) => l.handle.done.catch(() => null)));
      return { ok: false, code: 'TT_SINGLEFLIGHT_OWNER', reason: legs['dead-owner-reclaim'].reason, legs };
    }
    rec.record('singleflight.owner_kill.intent', { leg: 'dead-owner-reclaim', key, waiter: owner.index, pid: owner.handle.pid, owned: true });
    // eslint-disable-next-line no-await-in-loop
    const killResult = await owner.handle.kill('SIGKILL');
    rec.record('singleflight.owner_kill.result', { leg: 'dead-owner-reclaim', key, pid: owner.handle.pid, ok: killResult?.ok ?? false, error: killResult?.error ?? null });
    const ownerResult = await owner.handle.done.catch(() => ({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' }));
    rec.record('singleflight.owner_done', { leg: 'dead-owner-reclaim', key, pid: owner.handle.pid, exitCode: ownerResult?.exitCode, signal: ownerResult?.signal });
    const restDone = await Promise.all(live.filter((l) => l.index !== owner.index).map((l) => l.handle.done.catch(() => ({ exitCode: null, signal: null, stdout: '', stderr: '' }))));
    const ledgerAfter = typeof leg2.ledgerRead === 'function' ? await leg2.ledgerRead() : null;
    const ledgerRows = Array.isArray(ledgerAfter) ? ledgerAfter : [];
    // Reclaim = a SECOND execution row (distinct run id) recorded AFTER the
    // owner kill — mechanically distinct from release-on-stop (which never
    // produces a second execution).
    const reclaimRows = ledgerRows.filter((r) => r && r.role === 'reclaim' && r.key === key);
    const reclaim = reclaimRows.length > 0;
    const secondExec = ledgerRows.filter((r) => r && r.role === 'execution' && r.key === key).length > 1;
    legs['dead-owner-reclaim'] = {
      key,
      waiters: waiters.length,
      verdict: reclaim ? 'dead_owner_reclaimed' : secondExec ? 'dead_owner_reclaimed' : 'not_reclaimed',
      reason: reclaim ? `owner ${owner.handle.pid} killed; a waiter reclaimed and executed (reclaim evidence ${reclaimRows.length})` : secondExec ? 'a second execution row exists after the owner kill' : `owner ${owner.handle.pid} killed but no replacement execution observed within the bound`,
      killedPid: owner.handle.pid,
      perWaiter: restDone.map((r, i) => ({ waiter: live.filter((l) => l.index !== owner.index)[i]?.index ?? null, ...parseSingleFlightResult({ result: r }) })),
      ledger: ledgerAfter ?? null,
    };
    rec.record('singleflight.leg', { leg: 'dead-owner-reclaim', key, verdict: legs['dead-owner-reclaim'].verdict, reason: legs['dead-owner-reclaim'].reason });
    if (!reclaim && !secondExec) {
      return { ok: false, code: 'TT_SINGLEFLIGHT_RECLAIM', reason: legs['dead-owner-reclaim'].reason, legs };
    }
  } else {
    legs['dead-owner-reclaim'] = { key, waiters: waiters.length, verdict: 'not_run', reason: 'no liveLaunch adapter for the dead-owner leg — leg NOT_RUN, never fabricated' };
    rec.record('singleflight.leg', { leg: 'dead-owner-reclaim', key, verdict: 'not_run' });
  }

  return { ok: true, key, legs };
}

