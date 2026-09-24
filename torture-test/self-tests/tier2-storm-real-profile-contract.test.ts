// Tier-2 STORM-REAL-PROFILE US-016 — published storm-real-profile contract.
//
// US-016 publishes /home/kaladin/matchlock-work/storm-real-profile-contract.json
// recording the REAL profile design, the real harness binary resolution and
// pins, the spend accounting and cap, the Igor-2026-09-23 arming rule, the
// capacity-scaled lite roster, the tests and the observed gate results, plus
// the exact pilot readiness path and source commit/tree.
//
// This file is the focused self-test:
//   * the pure builder projects the single-source constants into a schema-valid
//     contract whose profile/env/spend/arming/roster/readiness values are
//     EXACT (they are imported from the same modules, never re-typed);
//   * the builder refuses a missing source provenance (fail-closed);
//   * the validator refuses a truncated document, a drifted profile/env/spend/
//     arming/roster value, a wrong readiness path, a missing source pin and a
//     missing gate-results section;
//   * when the published contract exists, it validates and is a drift sentinel
//     against the CURRENT source constants, and it names the exact pilot
//     readiness path.
//
// In-process only: no daemon, no harness, no model, no ports, no source edits.

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  CONTRACT_PATH,
  INTEGRATION_BASE_COMMIT,
  INTEGRATION_BRANCH,
  REQUIRED_CONTRACT_KEYS,
  STORM_REAL_SELF_TESTS,
  buildStormRealProfileContract,
  validateStormRealProfileContract,
} from "../bin/tt-storm-real-contract.mjs";
import {
  DEFAULT_STORM_PROFILE,
  PROFILE_DAEMON_KIND,
  REAL,
  SCRIPTED_REHEARSAL,
  STORM_PROFILES,
} from "../bin/tt-storm-profile.mjs";
import { HARNESS_BINARY_ENV } from "../bin/tt-storm-harness-pins.mjs";
import {
  DEFAULT_SPEND_CAP_SCOPE,
  HARNESS_PROVIDER_CLASS,
  SPEND_CAP_SCOPES,
} from "../bin/tt-storm-spend.mjs";
import {
  O12_POLICY_LEGS,
  O12_SEED_INTEGRITY_LEGS,
  SEED_INTEGRITY_ORACLES,
  SEED_VALIDATION_ARMING_RULE,
} from "../bin/tt-storm-seed-validation.mjs";
import {
  LITE_FIXTURE_NAME,
  LITE_ROUND_A_ROSTER,
  LITE_ROUND_B_PHASES,
  LITE_ROUND_B_ROSTER,
} from "../bin/tt-storm-scale.mjs";
import {
  PILOT_APPROVAL_PATH,
  PILOT_READINESS_PATH,
} from "../bin/tt-storm-real-readiness.mjs";

const DOES_NOT_EXIST = "/nonexistent/storm-real-profile-contract.json";
// The on-disk artifact lives outside the repo; an env override lets a verifier
// point the drift sentinel at a retained copy.
const PUBLISHED_PATH = process.env.STORM_REAL_PROFILE_CONTRACT ?? CONTRACT_PATH;

function syntheticSource(): any {
  return {
    branch: "feature/storm-real-profile",
    commit: "c".repeat(40),
    tree: "d".repeat(40),
    tree_dirty: false,
  };
}

function syntheticGateResults(): any {
  return {
    build: { command: "npm run build", verdict: "PASS" },
    test_cmd: { command: "npm test", verdict: "PASS", summary: "serial+parallel green" },
    storm_chain: {
      command: "flock ... node --test <49-file storm chain>",
      verdict: "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS",
      files_expected: 49,
      files_observed: 49,
      red_files: ["torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts"],
      environment_deviations: ["boundary TT_PRODUCT_DB_UNAVAILABLE in a recorder child"],
    },
    focused_self_tests: [{ file: STORM_REAL_SELF_TESTS[0], verdict: "PASS" }],
    overall: { verdict: "PASS" },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("STORM-REAL-PROFILE US-016 published contract", () => {
  it("H1: the pure builder projects the single-source constants into a schema-valid, exact contract", () => {
    const contract: any = buildStormRealProfileContract({
      source: syntheticSource(),
      gateResults: syntheticGateResults(),
      publishedAtUtc: "2026-09-23T00:00:00.000Z",
      readiness: { campaign: { id: "storm-pilot-us016", spend_cap: { tokens: 200000000, scope: "total" } } },
    });
    const verdict = validateStormRealProfileContract(contract, { contractPath: DOES_NOT_EXIST });
    assert.equal(verdict.ok, true, `built contract must validate: ${JSON.stringify(verdict.issues)}`);

    assert.equal(contract.contract, "storm-real-profile-contract");
    assert.deepEqual(contract.profile_design.profiles, [...STORM_PROFILES]);
    assert.equal(contract.profile_design.default_profile, DEFAULT_STORM_PROFILE);
    assert.equal(contract.profile_design.real_profile, REAL);
    assert.equal(contract.profile_design.daemon_kind[REAL], PROFILE_DAEMON_KIND[REAL]);
    assert.equal(contract.profile_design.daemon_kind[SCRIPTED_REHEARSAL], PROFILE_DAEMON_KIND[SCRIPTED_REHEARSAL]);
    assert.deepEqual(contract.binary_resolution.harness_env, { ...HARNESS_BINARY_ENV });
    assert.equal(contract.binary_resolution.refusal, "TT_UNRESOLVED_BINARY");
    assert.deepEqual(contract.spend_accounting.provider_class, { ...HARNESS_PROVIDER_CLASS });
    assert.deepEqual(contract.spend_accounting.cap_scopes, [...SPEND_CAP_SCOPES]);
    assert.equal(contract.spend_accounting.default_cap_scope, DEFAULT_SPEND_CAP_SCOPE);
    assert.deepEqual(contract.spend_accounting.cap_required_for, [REAL]);
    assert.equal(contract.arming_rule.rule, SEED_VALIDATION_ARMING_RULE);
    assert.equal(contract.arming_rule.attributed_to, "Igor 2026-09-23");
    assert.deepEqual(contract.arming_rule.seed_integrity_oracles, [...SEED_INTEGRITY_ORACLES]);
    assert.deepEqual(contract.arming_rule.o12_seed_integrity_legs, [...O12_SEED_INTEGRITY_LEGS]);
    assert.deepEqual(contract.arming_rule.o12_policy_legs, [...O12_POLICY_LEGS]);
    assert.equal(contract.scale_lite_roster.fixture, LITE_FIXTURE_NAME);
    assert.deepEqual(
      contract.scale_lite_roster.roster.A.map((r: any) => `${r.harness}:${r.workflow}`).sort(),
      LITE_ROUND_A_ROSTER.map((r) => `${r.harness}:${r.workflow}`).sort(),
    );
    assert.equal(contract.scale_lite_roster.roster.B.length, LITE_ROUND_B_ROSTER.length);
    assert.equal(contract.scale_lite_roster.phases.length, LITE_ROUND_B_PHASES.length);
    assert.equal(contract.pilot_readiness.path, PILOT_READINESS_PATH);
    assert.equal(contract.pilot_readiness.approval_path, PILOT_APPROVAL_PATH);
    assert.equal(contract.pilot_readiness.campaign_id, "storm-pilot-us016");
    assert.equal(contract.source.integration_branch, INTEGRATION_BRANCH);
    assert.equal(contract.source.integration_base_commit, INTEGRATION_BASE_COMMIT);
    assert.equal(contract.gate_results.build.verdict, "PASS");
    for (const key of REQUIRED_CONTRACT_KEYS) assert.ok(key in contract, `required key ${key} must be present`);
  });

  it("H2: the builder refuses a missing source provenance (fail-closed)", () => {
    assert.throws(() => buildStormRealProfileContract({}), /source provenance/);
    assert.throws(() => buildStormRealProfileContract({ source: null }), /source provenance/);
    // A contract built with the NOT_RUN placeholder is still schema-valid.
    const placeholder: any = buildStormRealProfileContract({ source: syntheticSource() });
    assert.equal(validateStormRealProfileContract(placeholder).ok, true);
    assert.equal(placeholder.gate_results.build.verdict, "NOT_RUN");
  });

  it("H3: the validator refuses a truncated/drifted document (fail-closed)", () => {
    const base: any = buildStormRealProfileContract({ source: syntheticSource(), gateResults: syntheticGateResults() });

    const missingKey: any = clone(base);
    delete missingKey.arming_rule;
    assert.equal(validateStormRealProfileContract(missingKey).ok, false, "a document without the arming rule is refused");

    const badProfile: any = clone(base);
    badProfile.profile_design.default_profile = REAL;
    assert.equal(validateStormRealProfileContract(badProfile).ok, false, "a drifted default profile is refused");

    const badEnv: any = clone(base);
    badEnv.binary_resolution.harness_env.pi = "TAMANDUA_WRONG";
    assert.equal(validateStormRealProfileContract(badEnv).ok, false, "a drifted harness env mapping is refused");

    const badSpend: any = clone(base);
    badSpend.spend_accounting.provider_class.dsh = "local";
    assert.equal(validateStormRealProfileContract(badSpend).ok, false, "a drifted provider class is refused");

    const badUnknown: any = clone(base);
    badUnknown.spend_accounting.unknown_rule = "a missing DB is 0";
    assert.equal(validateStormRealProfileContract(badUnknown).ok, false, "a fabricated-0 spend rule is refused");

    const badRule: any = clone(base);
    badRule.arming_rule.rule = "Seed-validation arming rule (someone else)";
    assert.equal(validateStormRealProfileContract(badRule).ok, false, "a drifted arming rule is refused");

    const badRoster: any = clone(base);
    badRoster.scale_lite_roster.fixture = "tt-poly-full";
    assert.equal(validateStormRealProfileContract(badRoster).ok, false, "a drifted lite fixture is refused");

    const badRosterPhase: any = clone(base);
    badRosterPhase.scale_lite_roster.phases = badRosterPhase.scale_lite_roster.phases.filter((p: any) => p.action.kind !== "kill_harness");
    assert.equal(validateStormRealProfileContract(badRosterPhase).ok, false, "a lite plan without its one kill is refused");

    const badReadiness: any = clone(base);
    badReadiness.pilot_readiness.path = "/elsewhere/readiness.json";
    assert.equal(validateStormRealProfileContract(badReadiness).ok, false, "a wrong pilot readiness path is refused");

    const badSource: any = clone(base);
    badSource.source.commit = "not-a-sha";
    assert.equal(validateStormRealProfileContract(badSource).ok, false, "a non-sha source commit is refused");

    const badGate: any = clone(base);
    delete badGate.gate_results;
    assert.equal(validateStormRealProfileContract(badGate).ok, false, "a document without gate results is refused");

    const badTests: any = clone(base);
    badTests.tests.self_tests = [];
    assert.equal(validateStormRealProfileContract(badTests).ok, false, "a document without the self-test list is refused");
  });

  it("H4: the published contract validates and is a drift sentinel against the current source constants", () => {
    if (!fs.existsSync(PUBLISHED_PATH)) return; // fresh host: the contract is an out-of-band artifact
    const published: any = JSON.parse(fs.readFileSync(PUBLISHED_PATH, "utf8"));
    const verdict = validateStormRealProfileContract(published, { contractPath: PUBLISHED_PATH });
    assert.equal(verdict.ok, true, `published contract must validate: ${JSON.stringify(verdict.issues)}`);

    // The contract must name the exact pilot readiness path and a real source
    // commit/tree, and it must list this drift sentinel itself.
    assert.equal(published.pilot_readiness.path, PILOT_READINESS_PATH, "the contract names the exact pilot readiness path");
    assert.match(String(published.source.commit), /^[0-9a-f]{40}$/);
    assert.match(String(published.source.tree), /^[0-9a-f]{40}$/);
    assert.equal(published.source.integration_base_commit, INTEGRATION_BASE_COMMIT);
    assert.ok(
      published.tests.self_tests.includes("torture-test/self-tests/tier2-storm-real-profile-contract.test.ts"),
      "the contract lists its own drift sentinel",
    );

    // Drift sentinel: the published values must equal the CURRENT constants.
    assert.deepEqual(published.profile_design.profiles, [...STORM_PROFILES]);
    assert.equal(published.profile_design.default_profile, DEFAULT_STORM_PROFILE);
    assert.deepEqual(published.binary_resolution.harness_env, { ...HARNESS_BINARY_ENV });
    assert.deepEqual(published.spend_accounting.provider_class, { ...HARNESS_PROVIDER_CLASS });
    assert.deepEqual(published.spend_accounting.cap_scopes, [...SPEND_CAP_SCOPES]);
    assert.equal(published.arming_rule.rule, SEED_VALIDATION_ARMING_RULE);
    assert.equal(published.scale_lite_roster.fixture, LITE_FIXTURE_NAME);
    assert.deepEqual(
      published.scale_lite_roster.roster.A.map((r: any) => `${r.harness}:${r.workflow}`).sort(),
      LITE_ROUND_A_ROSTER.map((r) => `${r.harness}:${r.workflow}`).sort(),
    );

    // Gate results are recorded (the builder cannot fabricate them): the
    // contract names the build, TEST_CMD, chain and focused self-tests.
    for (const key of ["build", "test_cmd", "storm_chain", "focused_self_tests"]) {
      assert.ok(key in published.gate_results, `gate_results.${key} must be recorded`);
    }
    assert.equal(published.gate_results.storm_chain.files_expected, 49);
    assert.ok(Array.isArray(published.gate_results.storm_chain.red_files));
    assert.ok(Array.isArray(published.gate_results.storm_chain.environment_deviations));
  });
});