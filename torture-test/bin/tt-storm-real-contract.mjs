#!/usr/bin/env node
// tt-storm-real-contract.mjs — STORM-REAL-PROFILE US-016 published contract.
//
// The STORM-REAL feature adds the REAL campaign profile to the storm
// orchestrator: real pi/hermes/dsh harnesses, the real product daemon from this
// tree, the aged seed, a hard spend cap and real tokens. Every individual rule
// already lives in its own torture-owned module (profile identity, real
// harness resolution/pins, spend accounting + cap, scale-lite roster, aged
// arming). This module is the ONE published DOCUMENT that records those rules
// together for the coordinator, plus the gate results that prove them.
//
// Design:
//   * buildStormRealProfileContract(...) is PURE: it projects the single
//     source constants (imported from the REAL modules, never re-typed) into a
//     contract document, with the volatile inputs (source commit/tree, gate
//     results, published readiness) injected.
//   * validateStormRealProfileContract(contract) is PURE and fail-closed: a
//     truncated section, a drifted profile/env/spend/scale/arming value, a
//     missing source pin or a readiness path that differs from the REAL
//     readiness module's constant is refused.
//   * The CLI resolves the source provenance (git HEAD/tree/branch), reads the
//     published pilot readiness and a recorded --gate-results JSON, then
//     writes the contract to the published host path.
//
// The JSON is the durable coordinator artifact. It performs no arming, no
// approval and no launch.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_STORM_PROFILE,
  PROFILE_DAEMON_KIND,
  PROFILE_LABELS,
  REAL,
  SCRIPTED_REHEARSAL,
  STORM_PROFILES,
} from './tt-storm-profile.mjs';
import {
  HARNESS_BINARY_ENV,
  HARNESS_NAMES,
  TT_UNRESOLVED_BINARY,
} from './tt-storm-harness-pins.mjs';
import {
  DEFAULT_SPEND_CAP_SCOPE,
  HARNESS_PROVIDER_CLASS,
  SPEND_CAP_SCOPES,
  SPEND_FILE_NAME,
  SPEND_SCHEMA_VERSION,
} from './tt-storm-spend.mjs';
import {
  AGED_STATE_ADOPTION_PATH,
  AGED_STATE_ARM_KIND,
  AGED_STATE_ARM_RECEIPT_NAME,
  AGED_STATE_ARM_SCHEMA_VERSION,
  ARM_RECEIPTS_DIR,
} from './tt-storm-arm.mjs';
import {
  CLASS_NOT_EVALUABLE,
  CLASS_NOT_RUN,
  CLASS_POLICY,
  CLASS_SEED_INTEGRITY,
  NOT_RUN_ORACLES,
  O12_AGGREGATE_LEG,
  O12_POLICY_LEGS,
  O12_SEED_INTEGRITY_LEGS,
  SEED_INTEGRITY_ORACLES,
  SEED_VALIDATION_ARMING_RULE,
  SEED_VALIDATION_ARM_KIND,
  SEED_VALIDATION_ARM_RECEIPT_NAME,
  SEED_VALIDATION_ARM_SCHEMA_VERSION,
} from './tt-storm-seed-validation.mjs';
import {
  LITE_FIXTURE_NAME,
  LITE_ROUND_A_ROSTER,
  LITE_ROUND_B_PHASES,
  LITE_ROUND_B_ROSTER,
} from './tt-storm-scale.mjs';
import {
  PILOT_APPROVAL_PATH,
  PILOT_READINESS_PATH,
  SEED_ROOT_PLACEHOLDER,
  SEED_ROOT_SOURCE,
} from './tt-storm-real-readiness.mjs';
import { REAL_CAMPAIGN_BOUND_MS, REAL_MIN_ROUND_WALL_MS } from './tt-storm-unattended.mjs';
import { TT_EXEC_ESCAPE, TT_REHEARSAL_NOT_APPROVED } from './tt-storm-real.mjs';

// The published contract path (a host artifact the coordinator reads; it is
// NOT inside the repo, so publishing it never dirties the worktree).
export const CONTRACT_PATH = '/home/kaladin/matchlock-work/storm-real-profile-contract.json';

export const STORM_REAL_CONTRACT_KIND = 'storm-real-profile-contract';
export const STORM_REAL_STORY = 'STORM-REAL-PROFILE';
export const STORM_REAL_BEAD = 'tamandua-6sy.6.6';
export const STORM_REAL_PARENT_BEAD = 'tamandua-6sy.6';

// The stable source identity the campaign is built against. The feature branch
// is squash-merged onto the integration branch, so the branch HEAD moves; the
// integration base commit is the durable upstream id the contract names.
export const INTEGRATION_BRANCH = 'integration/torture-final';
export const INTEGRATION_BASE_COMMIT = 'b3e3a62873ac168e25461f424fc581cac12d71c7';
export const INTEGRATION_ORIGIN = '/opt/tamandua-origin-torture-final';

// The live operator instance the storm must never touch.
export const LIVE_DAEMON = Object.freeze({
  install: '/opt/tamandua',
  state_dir: '~/.tamandua',
  ports: Object.freeze([3334, 3338, 3339]),
});

// Every module this feature added or changed (torture-owned only).
export const STORM_REAL_MODULES = Object.freeze([
  'torture-test/bin/tt-storm-profile.mjs',
  'torture-test/bin/tt-storm-harness-pins.mjs',
  'torture-test/bin/tt-storm-spend.mjs',
  'torture-test/bin/tt-storm-scale.mjs',
  'torture-test/bin/tt-storm-arm.mjs',
  'torture-test/bin/tt-storm-seed-validation.mjs',
  'torture-test/bin/tt-storm-unattended.mjs',
  'torture-test/bin/tt-storm-real-readiness.mjs',
  'torture-test/bin/tt-storm-real-contract.mjs',
  'torture-test/bin/tt-storm-real-gate-battery.mjs',
]);

// The focused behavior/negative self-tests that are the evidence for the
// modules above (including the boundary negative battery and this contract's
// own drift sentinel).
export const STORM_REAL_SELF_TESTS = Object.freeze([
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
  'torture-test/self-tests/tier2-storm-real-pilot-readiness.test.ts',
  'torture-test/self-tests/tier2-storm-real-profile-contract.test.ts',
  'torture-test/self-tests/tier2-storm-real-gate-battery.test.ts',
]);

// The complete set of top-level keys a published contract MUST carry. Kept
// explicit so validateStormRealProfileContract refuses a truncated document.
export const REQUIRED_CONTRACT_KEYS = Object.freeze([
  'contract',
  'story',
  'bead',
  'parent_bead',
  'purpose',
  'status',
  'published_at_utc',
  'source',
  'profile_design',
  'binary_resolution',
  'spend_accounting',
  'arming_rule',
  'scale_lite_roster',
  'unattended_rounds',
  'boundary',
  'tests',
  'gate_results',
  'pilot_readiness',
  'hard_rules',
]);

// The exact working rules the feature obeys. Kept as plain strings so they can
// be quoted verbatim by the coordinator.
export const STORM_REAL_HARD_RULES = Object.freeze([
  'Torture-owned tree only (torture-test/**): NO src/ edits.',
  'The live operator daemon (/opt/tamandua, ports 3334/3338/3339, ~/.tamandua) is never touched.',
  'Harness credentials/config are never copied and never printed; REAL reads the operator homes through the daemon-control real seam.',
  'The campaign is contained under its private HOME/STATE/DB/TMPDIR; every mode revalidates the owned exec-context receipt before any effect.',
  'The scripted rehearsal path stays byte-identical; the default profile is SCRIPTED_REHEARSAL.',
  'REAL is refused without a hard spend cap; the persisted cap is authoritative and enforced every observation tick.',
  'A coordinator approval is profile-bound; an approval for one profile never authorizes the other.',
  'No broad rm/reset/clean/prune; no name/glob/PID-file kills; every artifact is retained.',
]);

function defaultGateResults() {
  return {
    build: { command: 'npm run build', verdict: 'NOT_RUN', note: 'run the build before publishing' },
    test_cmd: { command: 'npm test (via the tamandua-test shim)', verdict: 'NOT_RUN', note: 'run TEST_CMD before publishing' },
    storm_chain: {
      command: 'flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock node --test <49-file storm chain>',
      verdict: 'NOT_RUN',
      files_expected: 49,
      files_observed: null,
      red_files: [],
      environment_deviations: [],
    },
    focused_self_tests: [],
    overall: { verdict: 'NOT_RUN', note: 'gate results were not supplied at build time' },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure projection.
// ─────────────────────────────────────────────────────────────────────
export function buildStormRealProfileContract({
  source,
  gateResults = null,
  publishedAtUtc = null,
  readiness = null,
  status = null,
} = {}) {
  if (!source || typeof source !== 'object') throw new Error('buildStormRealProfileContract requires a source provenance object');
  const gate = gateResults ?? defaultGateResults();
  const r = readiness && typeof readiness === 'object' ? readiness : null;
  const campaignId = r?.campaign?.id ?? null;
  const spendCap = r?.campaign?.spend_cap ?? null;

  return {
    contract: STORM_REAL_CONTRACT_KIND,
    story: STORM_REAL_STORY,
    bead: STORM_REAL_BEAD,
    parent_bead: STORM_REAL_PARENT_BEAD,
    purpose:
      'Add the REAL campaign profile to the storm orchestrator so the real storm (real pi/hermes/dsh harnesses, the real product daemon from this tree, the aged seed, real tokens) can be prepared, armed, approved and run exactly like the scripted rehearsal — while the zero-token SCRIPTED_REHEARSAL path stays byte-identical.',
    status:
      status ??
      'REAL PROFILE IMPLEMENTED — REAL rules, accounting, arming, scale-lite roster and the REAL pilot readiness are implemented and self-tested; the REAL execution itself is a separate, coordinator-approved step. This contract performs no arming, no approval and no launch.',
    published_at_utc: publishedAtUtc,
    source: {
      branch: source.branch ?? null,
      commit: source.commit ?? null,
      tree: source.tree ?? null,
      tree_dirty: source.tree_dirty ?? null,
      integration_branch: INTEGRATION_BRANCH,
      integration_base_commit: INTEGRATION_BASE_COMMIT,
      origin: INTEGRATION_ORIGIN,
    },
    profile_design: {
      profiles: [...STORM_PROFILES],
      default_profile: DEFAULT_STORM_PROFILE,
      real_profile: REAL,
      scripted_rehearsal_profile: SCRIPTED_REHEARSAL,
      daemon_kind: { ...PROFILE_DAEMON_KIND },
      labels: { ...PROFILE_LABELS },
      approval_binding:
        'verifyCoordinatorApproval expectedProfile is read from the campaign PERSISTED state (state.rehearsal.profile), never from a CLI flag; an approval naming one profile is refused for the other at approve/rehearse/run.',
      refusals: { unknown_profile: 'TT_USAGE', approval_profile_mismatch: TT_REHEARSAL_NOT_APPROVED },
      prepare_command:
        'tt-storm prepare --profile REAL --scale full|lite --spend-cap-tokens <n> --spend-cap-scope paid|total',
    },
    binary_resolution: {
      harness_names: [...HARNESS_NAMES],
      harness_env: { ...HARNESS_BINARY_ENV },
      resolution:
        'TAMANDUA_<HARNESS>_BINARY (absolute path only) else PATH search; the resolved candidate must be an existing executable regular file; any unresolvable roster harness refuses the WHOLE prepare.',
      pins: 'descriptor.runtime_pins.harnesses records { harness, path, resolved_from, sha256, version, version_exit_code } for every resolved roster harness; a REAL descriptor carries NO scripted_runtimes block.',
      refusal: TT_UNRESOLVED_BINARY,
      credentials: 'prepare only stat()s and runs the binary once with --version; it never reads or copies credentials/config.',
      lite_harnesses_note: 'the lite roster uses pi/hermes only, so a lite prepare never demands dsh.',
    },
    spend_accounting: {
      provider_class: { ...HARNESS_PROVIDER_CLASS },
      spend_file: `${'results'}/${SPEND_FILE_NAME}`,
      schema_version: SPEND_SCHEMA_VERSION,
      cap_scopes: [...SPEND_CAP_SCOPES],
      default_cap_scope: DEFAULT_SPEND_CAP_SCOPE,
      cap_required_for: [REAL],
      cap_enforcement:
        'the persisted cap (state.rehearsal.spend_cap + descriptor.spend_cap) is the sole enforcement authority; resolveLaunchSpendCap refuses a launch that omits or substitutes it, and enforceSpendCapOnTick aborts an over-cap campaign with owned cleanup and an honest report.',
      unknown_rule: 'an unreadable/missing campaign DB is reported as UNKNOWN with null numerics — never a fabricated 0.',
      local_vs_paid: 'pi/hermes are local-endpoint (counted, reported, cost 0); dsh is the paid provider; the cap scope selects paid-only or total.',
      headline: 'every observation tick writes results/spend.json and the report headline states per-provider spend.',
    },
    arming_rule: {
      rule: SEED_VALIDATION_ARMING_RULE,
      attributed_to: 'Igor 2026-09-23',
      class_seed_integrity: CLASS_SEED_INTEGRITY,
      class_policy: CLASS_POLICY,
      class_not_run: CLASS_NOT_RUN,
      class_not_evaluable: CLASS_NOT_EVALUABLE,
      seed_integrity_oracles: [...SEED_INTEGRITY_ORACLES],
      o12_seed_integrity_legs: [...O12_SEED_INTEGRITY_LEGS],
      o12_policy_legs: [...O12_POLICY_LEGS],
      o12_aggregate_leg: O12_AGGREGATE_LEG,
      carried_oracles: [...NOT_RUN_ORACLES],
      adoption_path: AGED_STATE_ADOPTION_PATH.map((e) => ({ ...e })),
      adoption_arm_kind: AGED_STATE_ARM_KIND,
      adoption_receipt: `${ARM_RECEIPTS_DIR}/${AGED_STATE_ARM_RECEIPT_NAME}`,
      adoption_schema_version: AGED_STATE_ARM_SCHEMA_VERSION,
      seed_validation_arm_kind: SEED_VALIDATION_ARM_KIND,
      seed_validation_receipt: `${ARM_RECEIPTS_DIR}/${SEED_VALIDATION_ARM_RECEIPT_NAME}`,
      seed_validation_schema_version: SEED_VALIDATION_ARM_SCHEMA_VERSION,
      commands: {
        arm_aged_state: 'tt-storm arm aged-state --campaign <campaign-dir> --seed-root <owned-seed-root>',
        arm_seed_validation: 'tt-storm arm seed-validation --campaign <campaign-dir>',
        arm_seed_validation_replay:
          'tt-storm arm seed-validation --campaign <campaign-dir> --seed-validation-matrix <recorded-matrix.json>',
      },
      launch_free: true,
      doc: 'torture-test/aged/docs/STORM-AGED-CONTRACT.md (the rule is recorded verbatim as a spec clarification).',
    },
    scale_lite_roster: {
      fixture: LITE_FIXTURE_NAME,
      roster: {
        A: LITE_ROUND_A_ROSTER.map((row) => ({ ...row, context: [...(row.context ?? [])] })),
        B: LITE_ROUND_B_ROSTER.map((row) => ({ ...row, context: [...(row.context ?? [])] })),
      },
      phases: LITE_ROUND_B_PHASES.map((phase) => ({ ...phase })),
      derivation:
        'rosterForScale/roundBPhasesForScale are the single source; deriveStormNumbers recomputes the timer cap from the actual lite agent counts; the lite roster uses exactly one colleague_commit and one kill_harness.',
      report_headline: 'the report headline states the roster that ran (full|lite) and the per-provider spend.',
    },
    unattended_rounds: {
      real_campaign_bound_ms: REAL_CAMPAIGN_BOUND_MS,
      real_min_round_cap_ms: REAL_MIN_ROUND_WALL_MS,
      note:
        'a REAL per-round cap below 6h is refused TT_USAGE; with no configured cap the REAL round window is the campaign-level bound. tt-storm run --detach re-execs the observation loop under setsid/nohup so it survives the operator ssh session ending.',
    },
    boundary: {
      exec_context: 'buildPrivateExecContext admits one immutable owned authority per campaign; every later mode revalidates its persisted dev/ino receipt (TT_NOT_OWNED).',
      escape_refusal: TT_EXEC_ESCAPE,
      live_daemon: { ...LIVE_DAEMON },
      live_daemon_untouched: '/opt/tamandua and its ports 3334/3338/3339 and ~/.tamandua are never touched by a campaign.',
      negative_proofs: [
        'approval of the wrong profile is refused (TT_REHEARSAL_NOT_APPROVED)',
        'a REAL prepare/launch without a spend cap is refused (TT_USAGE)',
        'crossing the cap aborts with owned cleanup exactly once and an honest report',
        'a missing roster harness is refused (TT_UNRESOLVED_BINARY)',
      ],
      negative_proof_test: 'torture-test/self-tests/tier2-storm-real-boundary-negative.test.ts',
    },
    tests: {
      modules: [...STORM_REAL_MODULES],
      self_tests: [...STORM_REAL_SELF_TESTS],
      chain: {
        selection: 'torture-test/self-tests/storm-chain-files.mjs',
        files_expected: 49,
        env: 'TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false',
        lock: '/home/kaladin/matchlock-work/vaivm-gate.lock',
      },
    },
    gate_results: gate,
    pilot_readiness: {
      path: PILOT_READINESS_PATH,
      approval_path: PILOT_APPROVAL_PATH,
      seed_root_placeholder: SEED_ROOT_PLACEHOLDER,
      seed_root_source: SEED_ROOT_SOURCE,
      campaign_id: campaignId,
      spend_cap: spendCap,
      note:
        'US-015 prepared the REAL lite pilot campaign and published the readiness (mode=prepared, qualification.real_launch_allowed=false). The seed-root placeholder is filled from the SEED-REGEN run (#79).',
    },
    hard_rules: [...STORM_REAL_HARD_RULES],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure validation.
// ─────────────────────────────────────────────────────────────────────
const HEX40 = /^[0-9a-f]{40}$/;

function sameStringSet(observed, expected) {
  if (!Array.isArray(observed)) return false;
  const a = [...observed].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function validateStormRealProfileContract(contract, { contractPath = CONTRACT_PATH } = {}) {
  const issues = [];
  const notes = [];
  if (!contract || typeof contract !== 'object') {
    return { ok: false, issues: ['contract is not an object'], notes };
  }
  for (const key of REQUIRED_CONTRACT_KEYS) {
    if (!(key in contract)) issues.push(`contract is missing required key ${key}`);
  }
  if (contract.contract !== STORM_REAL_CONTRACT_KIND) issues.push(`contract ${JSON.stringify(contract.contract)} != ${STORM_REAL_CONTRACT_KIND}`);
  if (contract.story !== STORM_REAL_STORY) issues.push(`story ${JSON.stringify(contract.story)} != ${STORM_REAL_STORY}`);

  // source pins: commit/tree must be real 40-hex ids and the integration base
  // must be the stable upstream id the contract names.
  const s = contract.source;
  if (!s || typeof s !== 'object') {
    issues.push('source missing/invalid');
  } else {
    if (!HEX40.test(String(s.commit ?? ''))) issues.push('source.commit must be a 40-hex git commit');
    if (!HEX40.test(String(s.tree ?? ''))) issues.push('source.tree must be a 40-hex git tree');
    if (s.integration_branch !== INTEGRATION_BRANCH) issues.push(`source.integration_branch != ${INTEGRATION_BRANCH}`);
    if (s.integration_base_commit !== INTEGRATION_BASE_COMMIT) issues.push('source.integration_base_commit != the recorded integration base');
  }

  // profile design: exact identities, default and daemon mapping.
  const p = contract.profile_design;
  if (!p || typeof p !== 'object') {
    issues.push('profile_design missing/invalid');
  } else {
    if (!sameStringSet(p.profiles, STORM_PROFILES)) issues.push('profile_design.profiles != STORM_PROFILES');
    if (p.default_profile !== DEFAULT_STORM_PROFILE) issues.push('profile_design.default_profile must be SCRIPTED_REHEARSAL');
    if (p.real_profile !== REAL) issues.push('profile_design.real_profile must be REAL');
    if (!p.daemon_kind || p.daemon_kind[REAL] !== PROFILE_DAEMON_KIND[REAL] || p.daemon_kind[SCRIPTED_REHEARSAL] !== PROFILE_DAEMON_KIND[SCRIPTED_REHEARSAL]) {
      issues.push('profile_design.daemon_kind must map REAL->real and SCRIPTED_REHEARSAL->scripted');
    }
  }

  // binary resolution: exact env mapping and refusal code.
  const b = contract.binary_resolution;
  if (!b || typeof b !== 'object') {
    issues.push('binary_resolution missing/invalid');
  } else {
    if (!b.harness_env || b.harness_env.pi !== HARNESS_BINARY_ENV.pi || b.harness_env.hermes !== HARNESS_BINARY_ENV.hermes || b.harness_env.dsh !== HARNESS_BINARY_ENV.dsh) {
      issues.push('binary_resolution.harness_env must be the TAMANDUA_PI/HERMES/DSH_BINARY mapping');
    }
    if (b.refusal !== TT_UNRESOLVED_BINARY) issues.push(`binary_resolution.refusal != ${TT_UNRESOLVED_BINARY}`);
  }

  // spend accounting: provider classes, scopes and the UNKNOWN rule.
  const sp = contract.spend_accounting;
  if (!sp || typeof sp !== 'object') {
    issues.push('spend_accounting missing/invalid');
  } else {
    if (!sp.provider_class || sp.provider_class.pi !== HARNESS_PROVIDER_CLASS.pi || sp.provider_class.hermes !== HARNESS_PROVIDER_CLASS.hermes || sp.provider_class.dsh !== HARNESS_PROVIDER_CLASS.dsh) {
      issues.push('spend_accounting.provider_class must classify pi/hermes local and dsh paid');
    }
    if (!sameStringSet(sp.cap_scopes, SPEND_CAP_SCOPES)) issues.push('spend_accounting.cap_scopes != paid|total');
    if (sp.default_cap_scope !== DEFAULT_SPEND_CAP_SCOPE) issues.push('spend_accounting.default_cap_scope must be total');
    if (!Array.isArray(sp.cap_required_for) || !sp.cap_required_for.includes(REAL)) issues.push('spend_accounting.cap_required_for must include REAL');
    if (typeof sp.unknown_rule !== 'string' || !/never a fabricated 0/i.test(sp.unknown_rule)) {
      issues.push('spend_accounting.unknown_rule must state the never-a-fabricated-0 rule');
    }
  }

  // arming rule: the Igor 2026-09-23 rule verbatim plus the classification.
  const a = contract.arming_rule;
  if (!a || typeof a !== 'object') {
    issues.push('arming_rule missing/invalid');
  } else {
    if (a.rule !== SEED_VALIDATION_ARMING_RULE) issues.push('arming_rule.rule must equal the shared SEED_VALIDATION_ARMING_RULE verbatim');
    if (a.attributed_to !== 'Igor 2026-09-23') issues.push('arming_rule.attributed_to must be Igor 2026-09-23');
    if (!sameStringSet(a.seed_integrity_oracles, SEED_INTEGRITY_ORACLES)) issues.push('arming_rule.seed_integrity_oracles mismatch');
    if (!sameStringSet(a.o12_seed_integrity_legs, O12_SEED_INTEGRITY_LEGS)) issues.push('arming_rule.o12_seed_integrity_legs mismatch');
    if (!sameStringSet(a.o12_policy_legs, O12_POLICY_LEGS)) issues.push('arming_rule.o12_policy_legs mismatch');
    if (a.launch_free !== true) issues.push('arming_rule.launch_free must be true');
    if (!Array.isArray(a.adoption_path) || a.adoption_path.length !== AGED_STATE_ADOPTION_PATH.length) {
      issues.push('arming_rule.adoption_path must carry every adoption-path step');
    }
  }

  // scale-lite roster: the fixture and the exact roster workflows/harnesses.
  const lite = contract.scale_lite_roster;
  if (!lite || typeof lite !== 'object') {
    issues.push('scale_lite_roster missing/invalid');
  } else {
    if (lite.fixture !== LITE_FIXTURE_NAME) issues.push(`scale_lite_roster.fixture != ${LITE_FIXTURE_NAME}`);
    const rosterA = Array.isArray(lite.roster?.A) ? lite.roster.A : [];
    const rosterB = Array.isArray(lite.roster?.B) ? lite.roster.B : [];
    if (rosterA.length !== LITE_ROUND_A_ROSTER.length || rosterB.length !== LITE_ROUND_B_ROSTER.length) {
      issues.push('scale_lite_roster.roster must carry the full A/B lite roster');
    }
    const expectedA = LITE_ROUND_A_ROSTER.map((r) => `${r.harness}:${r.workflow}`).sort();
    const observedA = rosterA.map((r) => `${r.harness}:${r.workflow}`).sort();
    if (expectedA.length !== observedA.length || expectedA.some((v, i) => v !== observedA[i])) {
      issues.push('scale_lite_roster roster A harness/workflow set drifts from LITE_ROUND_A_ROSTER');
    }
    if (!Array.isArray(lite.phases) || lite.phases.length !== LITE_ROUND_B_PHASES.length) {
      issues.push('scale_lite_roster.phases must carry the full reduced lite phase table');
    } else {
      const cc = lite.phases.filter((ph) => ph?.action?.kind === 'colleague_commit').length;
      const kill = lite.phases.filter((ph) => ph?.action?.kind === 'kill_harness').length;
      if (cc !== 1 || kill !== 1) issues.push('scale_lite_roster.phases must contain exactly one colleague_commit and one kill_harness');
    }
  }

  // tests: every REAL module and self-test is listed.
  const t = contract.tests;
  if (!t || typeof t !== 'object') {
    issues.push('tests missing/invalid');
  } else {
    for (const rel of STORM_REAL_MODULES) {
      if (!Array.isArray(t.modules) || !t.modules.includes(rel)) issues.push(`tests.modules is missing ${rel}`);
    }
    for (const rel of STORM_REAL_SELF_TESTS) {
      if (!Array.isArray(t.self_tests) || !t.self_tests.includes(rel)) issues.push(`tests.self_tests is missing ${rel}`);
    }
  }

  // gate results: the four gate families must be present and carry a verdict.
  const g = contract.gate_results;
  if (!g || typeof g !== 'object') {
    issues.push('gate_results missing/invalid');
  } else {
    for (const key of ['build', 'test_cmd', 'storm_chain', 'focused_self_tests']) {
      if (!(key in g)) issues.push(`gate_results is missing ${key}`);
    }
    for (const key of ['build', 'test_cmd', 'storm_chain']) {
      if (g[key] && typeof g[key] === 'object' && typeof g[key].verdict !== 'string') {
        issues.push(`gate_results.${key}.verdict must be a string`);
      }
    }
    if (g.storm_chain && !Array.isArray(g.storm_chain.red_files)) issues.push('gate_results.storm_chain.red_files must be an array');
    if (g.storm_chain && g.storm_chain.files_expected !== 49) issues.push('gate_results.storm_chain.files_expected must be 49');
    if (!Array.isArray(g.focused_self_tests)) issues.push('gate_results.focused_self_tests must be an array');
  }

  // pilot readiness: the exact published path + approval path.
  const pr = contract.pilot_readiness;
  if (!pr || typeof pr !== 'object') {
    issues.push('pilot_readiness missing/invalid');
  } else {
    if (pr.path !== PILOT_READINESS_PATH) issues.push(`pilot_readiness.path ${JSON.stringify(pr.path)} != ${PILOT_READINESS_PATH}`);
    if (pr.approval_path !== PILOT_APPROVAL_PATH) issues.push(`pilot_readiness.approval_path != ${PILOT_APPROVAL_PATH}`);
    if (typeof pr.seed_root_placeholder !== 'string' || pr.seed_root_placeholder.length === 0) {
      issues.push('pilot_readiness.seed_root_placeholder missing');
    }
  }

  if (!Array.isArray(contract.hard_rules) || contract.hard_rules.length === 0) issues.push('hard_rules must be a non-empty array');
  if (contractPath !== CONTRACT_PATH) notes.push(`validated against an alternate path ${contractPath}`);
  return { ok: issues.length === 0, issues, notes };
}

// ─────────────────────────────────────────────────────────────────────
// I/O helpers + CLI.
// ─────────────────────────────────────────────────────────────────────
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
  const branchName = branch.ok ? String(branch.stdout).trim() : null;
  const porcelain = status.ok ? String(status.stdout).trimEnd() : null;
  return {
    branch: branchName,
    commit: HEX40.test(commit ?? '') ? commit : null,
    tree: HEX40.test(treeSha ?? '') ? treeSha : null,
    tree_dirty: porcelain === null ? null : porcelain !== '',
  };
}

export function readJsonIfPresent(absPath, fsx = fs) {
  try {
    if (!absPath || !fsx.existsSync(absPath)) return null;
    return JSON.parse(fsx.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeStormRealProfileContract({ contract, outPath = CONTRACT_PATH, fsx = fs } = {}) {
  const dir = path.dirname(outPath);
  fsx.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(contract, null, 2) + '\n';
  fsx.writeFileSync(outPath, body);
  return { file: outPath, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

// CLI:
//   node torture-test/bin/tt-storm-real-contract.mjs [--out <path>]
//     [--gate-results <json>] [--readiness <json>] [--repo <dir>]
// A missing --gate-results records the NOT_RUN placeholder (still schema-valid)
// but the CLI then warns, so a published contract always says whether the
// gates were actually observed.
export function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--gate-results') opts.gateResults = argv[++i];
    else if (a === '--readiness') opts.readiness = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: tt-storm-real-contract [--out <path>] [--gate-results <json>] [--readiness <json>] [--repo <dir>]\n');
      return 0;
    }
  }
  const repoRoot = path.resolve(opts.repo ?? process.cwd());
  const source = gitProvenance(repoRoot);
  if (!source.commit || !source.tree) {
    process.stderr.write(`cannot resolve git provenance in ${repoRoot}\n`);
    return 1;
  }
  const gateResults = readJsonIfPresent(opts.gateResults ?? null);
  const readiness = readJsonIfPresent(opts.readiness ?? PILOT_READINESS_PATH);
  const contract = buildStormRealProfileContract({
    source,
    gateResults,
    publishedAtUtc: new Date().toISOString(),
    readiness,
  });
  const verdict = validateStormRealProfileContract(contract, { contractPath: opts.out ?? CONTRACT_PATH });
  if (!verdict.ok) {
    process.stderr.write(`contract INVALID:\n${verdict.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }
  const written = writeStormRealProfileContract({ contract, outPath: opts.out ?? CONTRACT_PATH });
  process.stdout.write(`Storm-real-profile contract: ${written.file}\n`);
  process.stdout.write(`  source: ${source.branch} ${source.commit} tree ${source.tree} (dirty=${source.tree_dirty})\n`);
  process.stdout.write(`  pilot readiness: ${contract.pilot_readiness.path}\n`);
  process.stdout.write(`  gates: build=${contract.gate_results?.build?.verdict ?? 'n/a'} test_cmd=${contract.gate_results?.test_cmd?.verdict ?? 'n/a'} chain=${contract.gate_results?.storm_chain?.verdict ?? 'n/a'}\n`);
  if (!gateResults) process.stderr.write('  WARNING: no --gate-results supplied; gate section is NOT_RUN\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}