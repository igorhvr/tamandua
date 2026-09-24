#!/usr/bin/env node

// o12-schema13-contract.test.mjs — focused tests for the O12-SCHEMA-13
// acceptance contract machinery.
//
// Runs the REAL publisher against a temp --out path (so it does not depend on
// the tracked artifact existing yet), validates the contract it writes against
// the committed gate evidence, oracle descriptors and pin constants, and proves
// the validator rejects the four load-bearing red arms:
//   (a) a tampered content_sha256
//   (b) a tampered gate exit code
//   (c) a missing section
//   (d) a non-member supported version
//
// This is a `.mjs` self-test and therefore NOT part of `npm test`; run it ALONE
// under the frozen gate env:
//   TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false \
//   TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false \
//   node --test torture-test/self-tests/o12-schema13-contract.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  CONTRACT_KIND,
  CONTRACT_OUTPUT_REL,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_SECTIONS,
  CONTRACT_SHAPES,
  EXPECTED_GATE_COUNTS,
  EXPECTED_REQUIRED_TOTAL,
  GATE_EVIDENCE_REL,
  PIN_SOURCE_REL,
  REQUIRED_RED_ARMS,
  SUPPORTED_USER_VERSIONS,
  V12_LINEAGE_IDS,
  buildLineageHandling,
  buildMatchlockPolicy,
  buildPerVersionExpectations,
  extractFailClosedMessage,
  extractFixtureCaseIds,
  parsePinConstants,
  validateContract,
} from "./o12-schema13-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const PUBLISHER = path.join(HERE, "publish-o12-schema13-contract.mjs");
const MODULE_PATH = path.join(HERE, "o12-schema13-contract.mjs");
const O12_SOURCE_PATH = path.join(REPO_ROOT, "torture-test", "oracles", "lib", "o12.mjs");
const VALIDATE_SOURCE_PATH = path.join(REPO_ROOT, PIN_SOURCE_REL);
const GENERATOR_PATH = path.join(REPO_ROOT, "torture-test", "oracles", "self-test", "generate-o12-fixtures.mjs");

const GATE_ENV = Object.freeze({
  TAMANDUA_TEST_GUARD: "1",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "o12s13-contract-test."));
const outPath = path.join(tmpDir, "o12-schema13-contract.json");

const publish = spawnSync(
  process.execPath,
  [PUBLISHER, "--repo", REPO_ROOT, "--out", outPath, "--run-id", "run-o12s13-contract-test"],
  { encoding: "utf8", env: { ...process.env, ...GATE_ENV } },
);

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CONTRACT = publish.status === 0 ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null;

function cloneContract() {
  return JSON.parse(JSON.stringify(CONTRACT));
}

test("the publisher exits 0 and writes a contract that validates", () => {
  assert.equal(publish.status, 0, `publisher stderr:\n${publish.stderr}`);
  assert.ok(CONTRACT, "publisher wrote the contract");
  assert.equal(CONTRACT.kind, CONTRACT_KIND);
  assert.equal(CONTRACT.schema_version, CONTRACT_SCHEMA_VERSION);
  const validation = validateContract(CONTRACT);
  assert.equal(validation.ok, true, validation.problems.join("; "));
});

test("the contract carries the eight sections in publication order", () => {
  assert.deepEqual([...CONTRACT_SECTIONS], [
    "per_version_expectations",
    "lineage_handling",
    "matchlock_policy",
    "fixtures",
    "repin",
    "gates",
    "validation",
    "final_head",
  ]);
  for (const section of CONTRACT_SECTIONS) assert.ok(section in CONTRACT, section);
});

test("the pure module performs no I/O and spawns no process", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  for (const forbidden of ["node:fs", "node:child_process", "spawnSync", "readFileSync", "writeFileSync", "node:os"]) {
    assert.ok(!source.includes(forbidden), `the pure module must not reference ${forbidden}`);
  }
});

test("per_version_expectations matches the live O12 descriptors", async () => {
  const o12 = await import(new URL("../oracles/lib/o12.mjs", import.meta.url).href);
  const section = CONTRACT.per_version_expectations;
  assert.deepEqual(section.supported_user_versions, [...SUPPORTED_USER_VERSIONS]);
  assert.deepEqual(section.entries.map((entry) => entry.shape), [...CONTRACT_SHAPES]);
  const shapeDescriptors = {
    v9: o12.O12_SCHEMA_DESCRIPTORS[9],
    v10: o12.O12_SCHEMA_DESCRIPTORS[10],
    v11: o12.O12_SCHEMA_DESCRIPTORS[11],
    "v12-main": o12.O12_SCHEMA_DESCRIPTORS[12].lineages["main-v12"],
    "v12-matchlock": o12.O12_SCHEMA_DESCRIPTORS[12].lineages["matchlock-v12"],
    v13: o12.O12_SCHEMA_DESCRIPTORS[13],
  };
  for (const entry of section.entries) {
    const descriptor = shapeDescriptors[entry.shape];
    assert.equal(entry.user_version, descriptor.user_version, entry.shape);
    assert.deepEqual(entry.required_columns.runs, [...descriptor.coreTables.runs], entry.shape);
    assert.deepEqual(entry.required_columns.steps, [...descriptor.coreTables.steps], entry.shape);
    const expectedColumns = Object.entries(descriptor.columnDeclarations)
      .map(([column, declaration]) => ({ column, type: declaration.type, default: declaration.default }))
      .sort((a, b) => a.column.localeCompare(b.column));
    assert.deepEqual(entry.version_added_columns, expectedColumns, entry.shape);
    assert.equal(entry.expected_verdict, "PASS", entry.shape);
  }
  // Spot-check the declared version-added shapes the story names.
  const byShape = Object.fromEntries(section.entries.map((entry) => [entry.shape, entry]));
  assert.deepEqual(byShape.v11.version_added_columns, [
    { column: "steps.target_moved_reroute_count", type: "INTEGER", default: "0" },
  ]);
  assert.deepEqual(byShape["v12-main"].version_added_columns, [
    { column: "steps.preclaim_death_count", type: "INTEGER", default: "0" },
    { column: "steps.target_moved_reroute_count", type: "INTEGER", default: "0" },
  ]);
  assert.deepEqual(byShape["v12-matchlock"].version_added_columns, [
    { column: "runs.matchlock_policy", type: "TEXT", default: null },
  ]);
  assert.deepEqual(byShape.v13.version_added_columns, [
    { column: "runs.matchlock_policy", type: "TEXT", default: null },
    { column: "steps.preclaim_death_count", type: "INTEGER", default: "0" },
    { column: "steps.target_moved_reroute_count", type: "INTEGER", default: "0" },
  ]);
});

test("lineage_handling records the v12 dual-lineage classification and the fail-closed rule", () => {
  const section = CONTRACT.lineage_handling;
  assert.deepEqual(section.supported_user_versions, [...SUPPORTED_USER_VERSIONS]);
  assert.deepEqual(section.v12_dual_lineage.classifications.map((entry) => entry.lineage), [...V12_LINEAGE_IDS]);
  const byLineage = Object.fromEntries(section.v12_dual_lineage.classifications.map((entry) => [entry.lineage, entry]));
  assert.equal(byLineage["main-v12"].preclaim_death_count_present, true);
  assert.equal(byLineage["main-v12"].matchlock_policy_present, false);
  assert.equal(byLineage["matchlock-v12"].matchlock_policy_present, true);
  assert.equal(byLineage["matchlock-v12"].preclaim_death_count_present, false);
  assert.equal(byLineage["v12-superset"].matchlock_policy_present, true);
  assert.equal(byLineage["v12-superset"].preclaim_death_count_present, true);
  assert.match(section.v12_dual_lineage.neither_lineage.behavior, /ERROR/);
  assert.match(section.v12_dual_lineage.neither_lineage.message_template, /carries neither schema-lineage discriminator/);
  assert.match(section.unknown_user_version.behavior, /ERROR/);
  assert.deepEqual(section.unknown_user_version.supported_set, [9, 10, 11, 12, 13, 14]);
  assert.match(section.unknown_user_version.message_template, /not supported by this O12 build/);
  // The builder is a pure function of the descriptors.
  const rebuilt = buildLineageHandling({
    descriptors: { 12: CONTRACT_LINEAGE_DESCRIPTOR },
    supportedVersions: SUPPORTED_USER_VERSIONS,
    failClosedMessage: extractFailClosedMessage(fs.readFileSync(O12_SOURCE_PATH, "utf8")),
    neitherLineageMessage: "x",
  });
  assert.equal(rebuilt.v12_dual_lineage.classifications.length, 3);
});

// Minimal descriptor object used only to prove buildLineageHandling is pure.
const CONTRACT_LINEAGE_DESCRIPTOR = {
  discriminators: ["runs.matchlock_policy", "steps.preclaim_death_count"],
  lineages: {
    "main-v12": { coreTables: { runs: [], steps: ["preclaim_death_count"] } },
    "matchlock-v12": { coreTables: { runs: ["matchlock_policy"], steps: [] } },
    "v12-superset": { coreTables: { runs: ["matchlock_policy"], steps: ["preclaim_death_count"] } },
  },
};

test("matchlock_policy records the key set, per-harness blocks, native NULL and R1 FAIL", async () => {
  const o12 = await import(new URL("../oracles/lib/o12.mjs", import.meta.url).href);
  const section = CONTRACT.matchlock_policy;
  assert.equal(section.policy_version, o12.O12_MATCHLOCK_POLICY_VERSION);
  assert.equal(section.backend, o12.O12_MATCHLOCK_POLICY_BACKEND);
  assert.deepEqual(section.required_keys, [...o12.O12_MATCHLOCK_POLICY_REQUIRED_KEYS]);
  assert.deepEqual(section.optional_keys, [...o12.O12_MATCHLOCK_POLICY_OPTIONAL_KEYS]);
  assert.deepEqual(section.harness_submission_blocks.pi, []);
  assert.deepEqual(section.harness_submission_blocks.hermes, [...o12.O12_MATCHLOCK_POLICY_HARNESS_KEYS.hermes]);
  assert.deepEqual(section.harness_submission_blocks.dsh, [...o12.O12_MATCHLOCK_POLICY_HARNESS_KEYS.dsh]);
  assert.deepEqual(section.hermes_submission_block_keys, [...o12.O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS]);
  assert.match(section.null_native_semantics.null, /native/);
  assert.match(section.null_native_semantics.null, /VALID/);
  // The invalid-policy finding id is derived from the oracle source, not typed.
  const source = fs.readFileSync(O12_SOURCE_PATH, "utf8");
  assert.ok(source.includes(section.invalid_policy.finding), "the finding id must appear in lib/o12.mjs");
  assert.match(section.invalid_policy.effect, /R1[\s\S]*FAIL/);
  // The pure builder is honest about an unknown finding id.
  const rebuilt = buildMatchlockPolicy({
    policy: {
      policyVersion: o12.O12_MATCHLOCK_POLICY_VERSION,
      backend: o12.O12_MATCHLOCK_POLICY_BACKEND,
      harnesses: o12.O12_MATCHLOCK_POLICY_HARNESSES,
      requiredKeys: o12.O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
      optionalKeys: o12.O12_MATCHLOCK_POLICY_OPTIONAL_KEYS,
      harnessKeys: o12.O12_MATCHLOCK_POLICY_HARNESS_KEYS,
      hermesBlockKeys: o12.O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS,
      dshHomeSources: o12.O12_MATCHLOCK_POLICY_DSH_HOME_SOURCES,
      credentialKeyFragments: o12.O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS,
    },
    findingName: null,
  });
  assert.equal(rebuilt.invalid_policy.finding, null);
});

test("fixtures records the schema 9..13 case ids and the pinned count from the committed evidence", () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, GATE_EVIDENCE_REL), "utf8"));
  const pinnedCount = evidence.o12_gate.fixture_matrix.expected_fixture_count;
  const section = CONTRACT.fixtures;
  assert.equal(section.fixture_count, pinnedCount);
  assert.equal(section.expected_fixture_count, pinnedCount);
  assert.equal(section.all_match, true);
  assert.equal(section.all_correction_cases_green, true);
  const generatorIds = extractFixtureCaseIds(fs.readFileSync(GENERATOR_PATH, "utf8"));
  // The committed O12-SCHEMA-13 contract froze the schema 9..13 fixture set.
  // Later schema support (v14 LEDGER-DIAG) ADDS generator cases, so the
  // committed set must remain a SUBSET of the live generator: a removed case is
  // drift and fails, while additional later-schema cases are allowed.
  const missingCases = section.fixture_case_ids.filter((id) => !generatorIds.includes(id));
  assert.deepEqual(missingCases, [],
    `the live generator must still build every committed fixture case (missing: ${missingCases.join(", ")})`);
  for (const fragment of [
    "o12-schema-v9",
    "o12-schema-v10",
    "o12-schema-v11",
    "o12-schema-v12-main",
    "o12-schema-v12-matchlock",
    "o12-schema-v13",
    "o12-schema-version-unsupported",
  ]) {
    assert.ok(section.fixture_case_ids.some((id) => id.includes(fragment)), fragment);
  }
});

test("repin records the content pin and its swept consumers without a hand-typed hash", () => {
  const section = CONTRACT.repin;
  const parsedPin = parsePinConstants(fs.readFileSync(VALIDATE_SOURCE_PATH, "utf8"));
  assert.equal(section.content_sha256, parsedPin.content_sha256);
  assert.equal(section.provenance_commit, parsedPin.provenance_commit);
  assert.equal(section.provenance_subject, parsedPin.provenance_subject);
  assert.equal(section.acceptance, parsedPin.acceptance);
  assert.match(section.content_sha256, /^[0-9a-f]{64}$/);
  assert.ok(section.swept_consumers.includes(PIN_SOURCE_REL), "the pin source is a swept consumer");
  assert.ok(section.swept_consumer_count >= 1);
  // The publisher never embeds a pinned hash or commit literal.
  const publisherSource = fs.readFileSync(PUBLISHER, "utf8");
  assert.doesNotMatch(publisherSource, /\b[0-9a-f]{64}\b/, "the publisher must not hand-type a 64-hex hash");
  assert.doesNotMatch(publisherSource, /\b[0-9a-f]{40}\b/, "the publisher must not hand-type a 40-hex commit");
  assert.ok(!publisherSource.includes("fixture_count: 78"), "the publisher must not hand-type the fixture count");
  assert.ok(!publisherSource.includes("exit_code: 0"), "the publisher must not hand-type an exit code");
});

test("gates records the exact commands, frozen env, per-entry exits and expected counts", () => {
  const section = CONTRACT.gates;
  assert.deepEqual(section.expected_counts, { ...EXPECTED_GATE_COUNTS });
  assert.equal(section.expected_required_total, EXPECTED_REQUIRED_TOTAL);
  assert.ok(section.commands.length > 0, "commands recorded");
  assert.equal(section.gate_env.TAMANDUA_TEST_GUARD, "1");
  for (const key of ["TAMANDUA_PI_BINARY", "TAMANDUA_HERMES_BINARY", "TAMANDUA_DSH_BINARY"]) {
    assert.equal(section.gate_env[key], "/usr/bin/false");
  }
  assert.equal(section.self_tests_alone.verdict, "PASS");
  assert.equal(section.self_tests_alone.total_required, EXPECTED_REQUIRED_TOTAL);
  assert.equal(section.self_tests_alone.passed_required, EXPECTED_REQUIRED_TOTAL);
  const gating = section.self_tests_alone.entries.filter((entry) => ["npf2", "aged", "o12"].includes(entry.group));
  assert.equal(gating.length, EXPECTED_REQUIRED_TOTAL);
  for (const entry of section.self_tests_alone.entries) {
    assert.equal(entry.exit_code, 0, `entry ${entry.name}`);
    assert.equal(entry.verdict, "PASS", `entry ${entry.name}`);
  }
  assert.equal(section.self_tests_alone.by_group.qualification.gating, false);
  assert.equal(section.o12_gate.overall_verdict, "PASS");
  for (const entry of section.o12_gate.entries) assert.equal(entry.exit_code, 0, `o12 gate ${entry.name}`);
  const substitutions = section.substitutions.join("\n");
  assert.ok(substitutions.includes("/tmp/vaivm-gate.lock"), "the gate-lock substitution is recorded");
  assert.ok(substitutions.includes("seed-snapshot-v13.sqlite"), "the owned v13 seed substitution is recorded");
});

test("validation and final_head record the torture-only scope", () => {
  assert.equal(CONTRACT.validation.torture_only, true);
  assert.deepEqual(CONTRACT.validation.source_paths_touched, []);
  assert.equal(CONTRACT.validation.gate_evidence_validated, true);
  assert.equal(CONTRACT.validation.content_pin_valid, true);
  assert.equal(CONTRACT.validation.content_pin_recomputed, CONTRACT.repin.content_sha256);
  assert.deepEqual(CONTRACT.validation.red_arms, [...REQUIRED_RED_ARMS]);
  assert.ok(CONTRACT.validation.vm_substitutions.length > 0);
  assert.equal(CONTRACT.final_head.src_modified, false);
  assert.match(CONTRACT.final_head.commit, /^[0-9a-f]{40}$/);
  assert.match(CONTRACT.final_head.tree, /^[0-9a-f]{40}$/);
});

test("validateContract rejects the four required red arms", () => {
  const base = cloneContract();
  assert.equal(validateContract(base).ok, true, validateContract(base).problems.join("; "));
  assert.ok(base.repin.content_sha256, "base carries a content hash");

  // (a) tampered content_sha256
  const tamperedHash = cloneContract();
  tamperedHash.repin.content_sha256 = "0".repeat(64);
  assert.equal(validateContract(tamperedHash).ok, false, "tampered content_sha256 must be rejected");

  // (b) tampered gate exit code
  const tamperedExit = cloneContract();
  tamperedExit.gates.self_tests_alone.entries[0].exit_code = 1;
  assert.equal(validateContract(tamperedExit).ok, false, "tampered gate exit code must be rejected");

  // (c) missing section
  const missingSection = cloneContract();
  delete missingSection.gates;
  assert.equal(validateContract(missingSection).ok, false, "missing section must be rejected");

  // (d) non-member supported version
  const nonMember = cloneContract();
  nonMember.lineage_handling.unknown_user_version.supported_set = [9, 10, 11, 12, 13, 14, 15];
  assert.equal(validateContract(nonMember).ok, false, "non-member supported version must be rejected");
});

test("validateContract is honest about further tampering", () => {
  const redArms = [];
  const push = (label, mutate) => {
    const copy = cloneContract();
    mutate(copy);
    redArms.push([label, copy]);
  };
  push("per-version non-member version", (c) => { c.per_version_expectations.entries[0].user_version = 15; });
  push("per-version verdict not PASS", (c) => { c.per_version_expectations.entries[0].expected_verdict = "FAIL"; });
  push("per-version missing shape", (c) => { c.per_version_expectations.entries = c.per_version_expectations.entries.slice(0, 5); });
  push("v12 lineage missing", (c) => { c.lineage_handling.v12_dual_lineage.classifications.pop(); });
  push("unknown set drift", (c) => { c.lineage_handling.unknown_user_version.supported_set = [9, 10]; });
  push("matchlock finding nefarious", (c) => { c.matchlock_policy.invalid_policy.finding = "nope"; });
  push("fixture count drift", (c) => { c.fixtures.fixture_count = 1; });
  push("fixture case lost", (c) => { c.fixtures.fixture_case_ids = c.fixtures.fixture_case_ids.filter((id) => !id.includes("v13")); });
  push("repin commit not a sha", (c) => { c.repin.provenance_commit = "deadbeef"; });
  push("repin consumers emptied", (c) => { c.repin.swept_consumers = []; });
  push("gate env weakened", (c) => { c.gates.gate_env.TAMANDUA_PI_BINARY = "/bin/true"; });
  push("gate counts drift", (c) => { c.gates.expected_counts.o12 = 7; });
  push("gate o12 entry red", (c) => { c.gates.o12_gate.entries[0].exit_code = 1; });
  push("substitution lost", (c) => { c.gates.substitutions = ["nothing to see"]; });
  push("validation pin invalid", (c) => { c.validation.content_pin_valid = false; });
  push("validation src touched", (c) => { c.validation.source_paths_touched = ["src/db.ts"]; });
  push("final head dirty", (c) => { c.final_head.worktree_clean = false; });
  push("final head src modified", (c) => { c.final_head.src_modified = true; });
  for (const [label, tampered] of redArms) {
    const result = validateContract(tampered);
    assert.equal(result.ok, false, `red-arm must be rejected: ${label}`);
  }
  assert.equal(validateContract(null).ok, false, "null contract must be rejected");
  assert.equal(validateContract({ kind: CONTRACT_KIND }).ok, false, "sparse contract must be rejected");
});

test("buildPerVersionExpectations covers exactly the six shapes", () => {
  const entries = buildPerVersionExpectations({
    descriptors: {
      9: { user_version: 9, lineage: "v9", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
      10: { user_version: 10, lineage: "v10", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
      11: { user_version: 11, lineage: "v11", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
      12: {
        lineages: {
          "main-v12": { user_version: 12, lineage: "main-v12", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
          "matchlock-v12": { user_version: 12, lineage: "matchlock-v12", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
        },
      },
      13: { user_version: 13, lineage: "current", coreTables: { runs: [], steps: [], stories: [] }, columnDeclarations: {} },
    },
    supportedVersions: SUPPORTED_USER_VERSIONS,
  });
  assert.deepEqual(entries.entries.map((entry) => entry.shape), [...CONTRACT_SHAPES]);
  assert.deepEqual(entries.supported_user_versions, [...SUPPORTED_USER_VERSIONS]);
});

test("the tracked contract output path is the committed impl-tasks path", () => {
  assert.equal(CONTRACT_OUTPUT_REL, "torture-test/impl-tasks/o12-schema13-contract.json");
});
