#!/usr/bin/env node

// o12-repin-contract.test.mjs — focused tests for the O12-REPIN acceptance
// contract machinery (US-009).
//
// Unit-tests the pure builders/validator against the REAL retained artifacts
// (fixture matrix, seed-snapshot matrix, pre-arm gate battery summary, storm
// chain summary, aged validation report) and, when the contract has been
// published, validates the published file at CONTRACT_OUTPUT_PATH.
//
// It never writes into torture-test/var, never spawns a test file and never
// acquires the flock. It is a `.mjs` self-test and therefore NOT part of
// `npm test`; run it alone with:
//   node --test torture-test/self-tests/o12-repin-contract.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CONTRACT_KIND,
  CONTRACT_OUTPUT_PATH,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_SECTIONS,
  EIGHT_CORRECTION_CASE_IDS,
  PUBLISHED_QUALIFICATION_PATH,
  READINESS_POINTER_REL,
  assembleContract,
  buildEightCaseEvidence,
  buildFinalHead,
  buildFixturesSection,
  buildGatesSection,
  buildNewPin,
  buildSchema10Rules,
  buildSeedSnapshotMatrix,
  buildValidationSection,
  extractFailClosedMessage,
  normalizeRunId,
  parseAgedPinConstants,
  validateContract,
} from "./o12-repin-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");

function newestDir(prefix, accept) {
  if (!fs.existsSync(RESULTS_BASE)) return null;
  const candidates = fs
    .readdirSync(RESULTS_BASE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const full = path.join(RESULTS_BASE, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    if (accept(candidate.full)) return candidate.full;
  }
  return null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Resolve the same retained artifacts the publisher consumes.
const FIXTURE_DIR = newestDir("o12-gate-self-tests-", (dir) => {
  const p = path.join(dir, "o12-fixture-matrix.json");
  if (!fs.existsSync(p)) return false;
  const matrix = readJson(p);
  return matrix.all_match === true && matrix.all_correction_cases_green === true;
});
const SEED_DIR = newestDir("o12-seed-snapshot-", (dir) => {
  const p = path.join(dir, "seed-snapshot-matrix.json");
  return fs.existsSync(p) && readJson(p).verdict === "EXPECTED_MATRIX";
});
const BATTERY = newestDir("pre-arm-gate-battery-", (dir) => {
  const p = path.join(dir, "pre-arm-gate-battery-summary.json");
  if (!fs.existsSync(p)) return false;
  const summary = readJson(p);
  return summary.scope === "all" && summary.verdict === "PASS";
});
const CHAIN = newestDir("storm-chain-", (dir) => {
  const p = path.join(dir, "chain-summary.json");
  if (!fs.existsSync(p)) return false;
  const summary = readJson(p);
  return summary.verdict === "PASS" && summary.file_count_observed === 49;
});

const FIXTURE_MATRIX = FIXTURE_DIR ? readJson(path.join(FIXTURE_DIR, "o12-fixture-matrix.json")) : null;
const SEED_MATRIX = SEED_DIR ? readJson(path.join(SEED_DIR, "seed-snapshot-matrix.json")) : null;
const BATTERY_SUMMARY = BATTERY ? readJson(path.join(BATTERY, "pre-arm-gate-battery-summary.json")) : null;
const CHAIN_SUMMARY = CHAIN ? readJson(path.join(CHAIN, "chain-summary.json")) : null;

const READINESS_PATH = path.join(REPO_ROOT, READINESS_POINTER_REL);
const READINESS = fs.existsSync(READINESS_PATH) ? readJson(READINESS_PATH) : null;
const VALIDATION_REPORT_PATH = READINESS?.seed?.root
  ? path.join(READINESS.seed.root, "evidence", "seed-validation-report.json")
  : null;
const VALIDATION_REPORT = VALIDATION_REPORT_PATH && fs.existsSync(VALIDATION_REPORT_PATH)
  ? readJson(VALIDATION_REPORT_PATH)
  : null;
const QUALIFICATION = fs.existsSync(PUBLISHED_QUALIFICATION_PATH)
  ? readJson(PUBLISHED_QUALIFICATION_PATH)
  : null;
const PIN = parseAgedPinConstants(
  fs.readFileSync(path.join(REPO_ROOT, "torture-test", "aged", "validate.mjs"), "utf8"),
);

const HEX40 = "a".repeat(40);

function buildRetainedContractBits() {
  return {
    schema10_rules: buildSchema10Rules({
      supportedVersions: [9, 10],
      descriptors: {
        9: { coreTables: { runs: ["id", "run_number", "workflow_id", "status", "context", "tokens_spent", "created_at", "updated_at"] } },
        10: {
          coreTables: {
            runs: [
              "id",
              "run_number",
              "workflow_id",
              "status",
              "context",
              "tokens_spent",
              "created_at",
              "updated_at",
              "matchlock_policy",
            ],
          },
        },
      },
      failClosedMessage: extractFailClosedMessage(
        fs.readFileSync(path.join(REPO_ROOT, "torture-test", "oracles", "lib", "o12.mjs"), "utf8"),
      ),
    }),
    fixtures: buildFixturesSection(FIXTURE_MATRIX, path.join(FIXTURE_DIR, "o12-fixture-matrix.json")),
    eight_case_evidence: buildEightCaseEvidence(FIXTURE_MATRIX),
    seed_snapshot_matrix: buildSeedSnapshotMatrix(SEED_MATRIX, path.join(SEED_DIR, "seed-snapshot-matrix.json")),
    new_pin: buildNewPin({
      pin: PIN,
      acceptanceEvidence: [{ kind: "seed-snapshot-matrix", path: path.join(SEED_DIR, "seed-snapshot-matrix.json") }],
    }),
    gates: buildGatesSection({
      batterySummary: BATTERY_SUMMARY,
      batteryRetainedPath: path.join(BATTERY, "pre-arm-gate-battery-summary.json"),
      chainSummary: CHAIN_SUMMARY,
      chainRetainedPath: path.join(CHAIN, "chain-summary.json"),
    }),
    validation: buildValidationSection({
      report: VALIDATION_REPORT,
      reportPath: VALIDATION_REPORT_PATH,
      readiness: READINESS,
      readinessPointerPath: READINESS_PATH,
      qualification: QUALIFICATION,
      qualificationPath: PUBLISHED_QUALIFICATION_PATH,
    }),
    final_head: buildFinalHead({
      commit: HEX40,
      tree: HEX40,
      subject: "test",
      branch: "feature/o12-repin-schema10",
      worktreeClean: true,
      srcModified: false,
      approvalFilesChanged: [],
      baseRef: "integration/o12-repin",
    }),
  };
}

function buildRetainedContract() {
  return assembleContract({
    generated_at_utc: "2026-01-01T00:00:00Z",
    run_id: "run-test",
    branch: "feature/o12-repin-schema10",
    ...buildRetainedContractBits(),
  });
}

test("the contract requires the eight named sections", () => {
  assert.deepEqual([...CONTRACT_SECTIONS], [
    "schema10_rules",
    "fixtures",
    "eight_case_evidence",
    "seed_snapshot_matrix",
    "new_pin",
    "gates",
    "validation",
    "final_head",
  ]);
});

test("normalizeRunId yields the canonical run-<uuid> identity", () => {
  assert.equal(normalizeRunId("b3057222-f531-46df-8d2c-0dd74fbfae88"), "run-b3057222-f531-46df-8d2c-0dd74fbfae88");
  assert.equal(normalizeRunId("run-b3057222-f531-46df-8d2c-0dd74fbfae88"), "run-b3057222-f531-46df-8d2c-0dd74fbfae88");
  assert.equal(normalizeRunId(""), null);
  assert.equal(normalizeRunId(null), null);
});

test("parseAgedPinConstants reads the aged validator's content-addressed pin", () => {
  assert.match(PIN.content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    PIN.content_sha256,
    // O12-SCHEMA-14 (STORM-AGED-FULL US-002): recomputed BY CONTENT with
    // computeO12OracleContentHash after the O12 oracle was taught the v14
    // LEDGER-DIAG chain; the nine-path O12 content set is unchanged.
    // (Superseded pre-story value: d5027546... from O12-SCHEMA-13 US-005.)
    "fb542e7f94c9950fb6551eb5d3624d4bb6bb06870ed701798fbe3460135ae5a5",
  );
  assert.match(PIN.provenance_commit, /^[0-9a-f]{40}$/);
  assert.equal(PIN.provenance_commit, "7fe9f258b066069d3a9c171df311487da6d54594");
  // Provenance is fed from git (the LIVE source), never retyped as a subject
  // literal: the recorded subject must be that real commit's own subject.
  const subject = spawnSync("git", ["log", "-1", "--format=%s", PIN.provenance_commit], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(subject.status, 0, "provenance commit must resolve in this repository");
  assert.equal(PIN.provenance_subject, subject.stdout.trim());
  assert.doesNotMatch(PIN.provenance_subject, /^feat: US-\d{3}/, "provenance is never a pre-squash story commit");
  assert.equal(PIN.acceptance, "ROOT_ACCEPTED");
  assert.match(PIN.acceptance_detail, /o12-owned-store-acceptance-/);
  // The pre-squash story commit pin (064e9cb5) is unreachable after the
  // merge-worktree squash and must no longer be parsed or surfaced.
  assert.equal(PIN.commit, undefined);
  assert.equal(PIN.tree, undefined);
  assert.equal(PIN.subject, undefined);
  // The prior schema-9 RUN45 pin stays as a provisional reference.
  assert.equal(PIN.prior.commit, "eb953ca52e531a2c5725ac2a30e663e9bea5d49e");
  assert.equal(PIN.prior.acceptance, "NOT_ROOT_ACCEPTED");
});

test("the publisher shapes new_pin from the aged report's o12_pin content fields", () => {
  const publisher = fs.readFileSync(path.join(HERE, "publish-o12-repin-contract.mjs"), "utf8");
  // Read the report block, never retype values from elsewhere.
  assert.match(publisher, /const reportPin = report\?\.o12_pin/);
  assert.match(publisher, /content_sha256: reportPin\.content_sha256/);
  assert.match(publisher, /provenance_commit: reportPin\.provenance_commit/);
  assert.match(publisher, /provenance_subject: reportPin\.provenance_subject/);
  // Cross-check the report against the validator's own constants (fail closed).
  assert.match(publisher, /pin\[field\] !== reportPin\[field\]/);
  // The published summary and the legacy commit/tree pin are gone.
  assert.doesNotMatch(publisher, /new_pin\.commit/);
  assert.doesNotMatch(publisher, /new_pin\.tree/);
});

test("buildSchema10Rules encodes {9,10}, the matchlock_policy delta and fail-closed", () => {
  const libSource = fs.readFileSync(path.join(REPO_ROOT, "torture-test", "oracles", "lib", "o12.mjs"), "utf8");
  const message = extractFailClosedMessage(libSource);
  assert.ok(message, "fail-closed message extracted from lib/o12.mjs");
  assert.match(message, /not supported by this O12 build/);
  assert.match(message, /user_version/);
  const rules = buildSchema10Rules({
    supportedVersions: Object.freeze([9, 10]),
    descriptors: {
      9: { coreTables: { runs: ["id", "updated_at"] } },
      10: { coreTables: { runs: ["id", "updated_at", "matchlock_policy"] } },
    },
    failClosedMessage: message,
  });
  assert.deepEqual(rules.supported_user_versions, [9, 10]);
  assert.deepEqual(rules.v9_to_v10_delta.added_columns, ["runs.matchlock_policy"]);
  assert.deepEqual(rules.v9_to_v10_delta.removed_columns, []);
  assert.ok(!rules.v9_to_v10_delta.v9_runs_columns.includes("matchlock_policy"));
  assert.ok(rules.v9_to_v10_delta.v10_runs_columns.includes("matchlock_policy"));
  assert.equal(rules.v10_column.column, "runs.matchlock_policy");
  assert.equal(rules.unknown_user_version.names_observed_version, true);
  assert.equal(rules.unknown_user_version.names_supported_set, true);
  assert.deepEqual(rules.unknown_user_version.supported_set, [9, 10]);
  assert.match(rules.unknown_user_version.behavior, /ERROR/);
});

test("buildFixturesSection summarizes the regenerated schema-10 fixture set", (t) => {
  if (!FIXTURE_MATRIX) return t.skip("no retained fixture matrix");
  const fixtures = buildFixturesSection(FIXTURE_MATRIX, "/x/o12-fixture-matrix.json");
  assert.equal(fixtures.fixture_count, fixtures.expected_fixture_count);
  assert.ok(fixtures.fixture_count >= 69);
  assert.equal(fixtures.all_match, true);
  assert.equal(fixtures.all_correction_cases_green, true);
  assert.equal(fixtures.fixture_names.length, fixtures.fixture_count);
  assert.equal(fixtures.schema_distribution["9"], 1);
  assert.equal(fixtures.schema_distribution["10"], 2);
  assert.equal(fixtures.schema_distribution["8"], 1);
  assert.equal(fixtures.schema_distribution["11"], 1);
  assert.ok(fixtures.retained_workspace);
});

test("buildEightCaseEvidence maps all eight correction cases with expected == observed", (t) => {
  if (!FIXTURE_MATRIX) return t.skip("no retained fixture matrix");
  const cases = buildEightCaseEvidence(FIXTURE_MATRIX);
  assert.equal(cases.length, EIGHT_CORRECTION_CASE_IDS.length);
  for (const id of EIGHT_CORRECTION_CASE_IDS) {
    const entry = cases.find((candidate) => candidate.case_id === id);
    assert.ok(entry, `correction case present: ${id}`);
    assert.equal(entry.present, true);
    assert.equal(entry.match, true);
    assert.equal(entry.expected, entry.observed, `${id} expected == observed`);
  }
  const allocator = cases.find((entry) => entry.case_id === "o12-close-run-number-allocator-characterization");
  assert.equal(allocator.kind, "probe");
  assert.equal(allocator.probes.length, 2);
});

test("buildSeedSnapshotMatrix records the exact US-004 R1..R6 matrix", (t) => {
  if (!SEED_MATRIX) return t.skip("no retained seed-snapshot matrix");
  const seed = buildSeedSnapshotMatrix(SEED_MATRIX, "/x/seed-snapshot-matrix.json");
  assert.equal(seed.user_version, 10);
  assert.deepEqual(seed.supported_user_versions, [9, 10, 11, 12, 13, 14]);
  assert.equal(seed.legs.R1.result, "PASS");
  assert.equal(seed.legs.R1.orphan_count_total, 0);
  assert.equal(seed.legs.R2.result, "PASS");
  assert.equal(seed.legs.R2.rows_checked, 5000);
  assert.equal(seed.legs.R3.result, "FAIL");
  assert.equal(seed.legs.R3.pair_format_mismatch_count, 24166);
  assert.equal(seed.legs.R3.runs_pair_mismatch_count, 5000);
  assert.equal(seed.legs.R3.steps_pair_mismatch_count, 19166);
  assert.equal(seed.legs.R3.steps_updated_at_native_sqlite, 19166);
  assert.equal(seed.legs.R3.steps_updated_at_native_iso, 7360);
  assert.equal(seed.legs.R4.result, "PASS");
  assert.equal(seed.legs.R4.keys_checked, 85000);
  assert.equal(seed.legs.R4.overwrite_count, 0);
  assert.equal(seed.legs.R4.host_transition_matches, 150);
  assert.equal(seed.legs.R5.result, "PASS");
  assert.equal(seed.overall_result, "FAIL");
  assert.equal(seed.r3_attribution.not_seed_corruption, true);
  assert.equal(seed.r3_attribution.not_validator_defect, true);
});

test("buildGatesSection records the self-tests-alone groups and the flocked chain", (t) => {
  if (!BATTERY_SUMMARY || !CHAIN_SUMMARY) return t.skip("no retained gate summaries");
  const gates = buildGatesSection({
    batterySummary: BATTERY_SUMMARY,
    batteryRetainedPath: "/x/battery.json",
    chainSummary: CHAIN_SUMMARY,
    chainRetainedPath: "/x/chain.json",
  });
  assert.equal(gates.lock_path, "/home/kaladin/matchlock-work/vaivm-gate.lock");
  assert.equal(gates.aged_o12_storm_self_tests_alone.verdict, "PASS");
  assert.equal(gates.aged_o12_storm_self_tests_alone.by_group.aged.total, 3);
  assert.equal(gates.aged_o12_storm_self_tests_alone.by_group.o12.total, 8);
  assert.equal(gates.aged_o12_storm_self_tests_alone.by_group.storm.total, 49);
  assert.equal(gates.storm_chain_49.verdict, "PASS");
  assert.equal(gates.storm_chain_49.file_count_observed, 49);
  assert.equal(gates.storm_chain_49.red_file_count, 0);
  assert.equal(gates.storm_chain_49.totals.fail, 0);
  assert.ok(gates.storm_chain_49.lock.submit_iso);
  assert.ok(gates.storm_chain_49.lock.acquire_iso);
  assert.ok(gates.storm_chain_49.lock.release_iso);
  assert.equal(gates.storm_chain_49.lock.untouched, true);
});

test("assemble + validate accepts a contract built from the retained artifacts", (t) => {
  if (!FIXTURE_MATRIX || !SEED_MATRIX || !BATTERY_SUMMARY || !CHAIN_SUMMARY) {
    return t.skip("retained artifacts incomplete");
  }
  const contract = buildRetainedContract();
  assert.equal(contract.kind, CONTRACT_KIND);
  assert.equal(contract.schema_version, CONTRACT_SCHEMA_VERSION);
  for (const section of CONTRACT_SECTIONS) assert.ok(section in contract, section);
  assert.equal(contract.new_pin.content_sha256, PIN.content_sha256);
  assert.equal(contract.new_pin.provenance_commit, PIN.provenance_commit);
  assert.equal(contract.new_pin.provenance_subject, PIN.provenance_subject);
  assert.equal(contract.new_pin.acceptance, "ROOT_ACCEPTED");
  const validation = validateContract(contract);
  assert.equal(validation.ok, true, validation.problems.join("; "));
});

test("validateContract is honest about tampered contracts", (t) => {
  if (!FIXTURE_MATRIX || !SEED_MATRIX || !BATTERY_SUMMARY || !CHAIN_SUMMARY) {
    return t.skip("retained artifacts incomplete");
  }
  const base = buildRetainedContract();
  assert.equal(validateContract(base).ok, true, validateContract(base).problems.join("; "));

  const redArms = [];
  const push = (label, mutate) => {
    const copy = JSON.parse(JSON.stringify(base));
    mutate(copy);
    redArms.push([label, copy]);
  };
  push("missing section", (c) => delete c.gates);
  push("supported versions drift", (c) => {
    c.schema10_rules.supported_user_versions = [9];
  });
  push("v10 delta lost", (c) => {
    c.schema10_rules.v9_to_v10_delta.added_columns = [];
  });
  push("fixture mismatch", (c) => {
    c.fixtures.all_match = false;
  });
  push("eight case red", (c) => {
    c.eight_case_evidence[0].expected = "PASS";
    c.eight_case_evidence[0].observed = "FAIL";
    c.eight_case_evidence[0].match = false;
  });
  push("eight case missing", (c) => {
    c.eight_case_evidence = c.eight_case_evidence.slice(0, 7);
  });
  push("R3 count drift", (c) => {
    c.seed_snapshot_matrix.legs.R3.pair_format_mismatch_count = 1;
  });
  push("pin not accepted", (c) => {
    c.new_pin.acceptance = "NOT_ROOT_ACCEPTED";
  });
  push("content hash truncated", (c) => {
    c.new_pin.content_sha256 = PIN.content_sha256.slice(0, 12);
  });
  push("content hash non-hex", (c) => {
    c.new_pin.content_sha256 = "z".repeat(64);
  });
  push("content hash missing", (c) => {
    delete c.new_pin.content_sha256;
  });
  push("provenance commit not a full sha", (c) => {
    c.new_pin.provenance_commit = PIN.provenance_commit.slice(0, 8);
  });
  push("provenance commit missing", (c) => {
    delete c.new_pin.provenance_commit;
  });
  push("chain red", (c) => {
    c.gates.storm_chain_49.red_file_count = 1;
  });
  push("chain missing flock release", (c) => {
    delete c.gates.storm_chain_49.lock.release_iso;
  });
  push("src modified", (c) => {
    c.final_head.src_modified = true;
  });
  push("dirty worktree", (c) => {
    c.final_head.worktree_clean = false;
  });
  push("approval file created", (c) => {
    c.final_head.approval_files_created_or_modified = true;
  });
  for (const [label, tampered] of redArms) {
    const result = validateContract(tampered);
    assert.equal(result.ok, false, `red-arm must be rejected: ${label}`);
  }
  assert.equal(validateContract(null).ok, false, "null contract must be rejected");
});

test("buildSchema10Rules matches the live O12 schema descriptors", async () => {
  const o12 = await import(new URL("../oracles/lib/o12.mjs", import.meta.url).href);
  // O12-SCHEMA-14: the live supported set is the whole product chain 9..14.
  assert.deepEqual([...o12.O12_SUPPORTED_SCHEMA_VERSIONS], [9, 10, 11, 12, 13, 14]);
  const rules = buildSchema10Rules({
    supportedVersions: o12.O12_SUPPORTED_SCHEMA_VERSIONS,
    descriptors: o12.O12_SCHEMA_DESCRIPTORS,
    failClosedMessage: extractFailClosedMessage(
      fs.readFileSync(path.join(REPO_ROOT, "torture-test", "oracles", "lib", "o12.mjs"), "utf8"),
    ),
  });
  assert.deepEqual(rules.supported_user_versions, [...o12.O12_SUPPORTED_SCHEMA_VERSIONS]);
  assert.deepEqual(rules.unknown_user_version.supported_set, [...o12.O12_SUPPORTED_SCHEMA_VERSIONS]);
  // The union chain moved the policy column to a LATER version: v9 -> v10 is
  // TIME-STORAGE (instants, no column), so the runs delta is EMPTY and neither
  // v9 nor v10 carries runs.matchlock_policy (that column is v13's).
  assert.deepEqual(rules.v9_to_v10_delta.added_columns, []);
  assert.deepEqual(rules.v9_to_v10_delta.removed_columns, []);
  assert.ok(!rules.v9_to_v10_delta.v9_runs_columns.includes("matchlock_policy"));
  assert.ok(!rules.v9_to_v10_delta.v10_runs_columns.includes("matchlock_policy"));
  assert.match(rules.unknown_user_version.message_template, /not supported by this O12 build/);
  assert.match(rules.unknown_user_version.message_template, /user_version/);
});

test("published contract (when present) validates and matches the content pin", async (t) => {
  if (!fs.existsSync(CONTRACT_OUTPUT_PATH)) {
    return t.skip(`contract not yet published at ${CONTRACT_OUTPUT_PATH}`);
  }
  const contract = readJson(CONTRACT_OUTPUT_PATH);
  // The run-#23 contract predates the content-addressed pin (US-005..US-007);
  // it is stale evidence that the US-012 aged re-validation republishes.  A
  // contract without a content pin cannot be validated against the new schema.
  if (!contract?.new_pin?.content_sha256 || !contract?.new_pin?.provenance_commit) {
    return t.skip(
      `published contract predates the content pin (legacy new_pin.commit ${JSON.stringify(contract?.new_pin?.commit)}); republished after the US-012 aged re-validation`,
    );
  }
  const validation = validateContract(contract);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(contract.new_pin.content_sha256, PIN.content_sha256);
  assert.equal(contract.new_pin.provenance_commit, PIN.provenance_commit);
  assert.equal(contract.new_pin.acceptance, PIN.acceptance);
  assert.equal(contract.seed_snapshot_matrix.legs.R3.pair_format_mismatch_count, 24166);
  assert.equal(contract.final_head.worktree_clean, true);
  assert.equal(contract.final_head.src_modified, false);
  assert.equal(contract.final_head.approval_files_created_or_modified, false);
  assert.equal(contract.validation.published_qualification, PUBLISHED_QUALIFICATION_PATH);
});
