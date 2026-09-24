#!/usr/bin/env node

// o12-schema13-gate-evidence.test.mjs — focused test for the O12-SCHEMA-13
// gate evidence record (US-006).
//
// Unit-tests the pure shaping + validator with a synthesized green record built
// from the REAL gate selection, exercises the red arms (a tampered entry exit,
// a drifted group total, a red verdict, an O12 gate entry that did not exit 0, a
// fixture-count mismatch, a missing command list, a non-v13 seed store), and —
// when the published record exists — validates it and cross-checks every
// recorded exit against the retained summaries it was generated from. It spawns
// no gate, no oracle and no product code.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GATE_EVIDENCE_KIND,
  GATE_EVIDENCE_OUTPUT_REL,
  buildGateEvidence,
  validateO12Schema13GateEvidence,
} from "./o12-schema13-gate-evidence.mjs";
import {
  AGED_ENTRIES,
  NPF2_ENTRIES,
  O12_ENTRIES,
  QUALIFICATION_ENTRIES,
  summarizeSelfTestsAlone,
} from "./self-tests-alone-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");
const RECORD_PATH = path.join(REPO_ROOT, GATE_EVIDENCE_OUTPUT_REL);

const GATE_ENV = Object.freeze({
  TAMANDUA_TEST_GUARD: "1",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
});

const GATE_HEAD = "e".repeat(40);

/** A synthesized self-tests-alone summary over the real frozen selection. */
function greenSelfTestsAlone({ red = null } = {}) {
  const entries = [];
  for (const definition of NPF2_ENTRIES) {
    entries.push({ ...definition, argv: ["node", "--test", definition.rel], exit_code: 0, duration_ms: 1000, pass: true, stdout_log: `/tmp/${definition.name}.stdout.log`, stderr_log: `/tmp/${definition.name}.stderr.log` });
  }
  for (const rel of AGED_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "aged", kind: "test", rel, argv: ["node", "--test", rel], exit_code: 0, duration_ms: 1000, pass: true, stdout_log: `/tmp/${path.basename(rel)}.stdout.log`, stderr_log: `/tmp/${path.basename(rel)}.stderr.log` });
  }
  for (const definition of O12_ENTRIES) {
    entries.push({ ...definition, group: "o12", argv: ["node", definition.rel], exit_code: 0, duration_ms: 1000, pass: true, stdout_log: `/tmp/${definition.name}.stdout.log`, stderr_log: `/tmp/${definition.name}.stderr.log` });
  }
  for (const rel of QUALIFICATION_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "qualification", kind: "test", rel, argv: ["node", "--test", rel], exit_code: 0, duration_ms: 1000, pass: true, stdout_log: `/tmp/${path.basename(rel)}.stdout.log`, stderr_log: `/tmp/${path.basename(rel)}.stderr.log` });
  }
  if (red) {
    const target = entries.find((entry) => entry.name === red);
    assert.ok(target, `red fixture entry exists: ${red}`);
    target.exit_code = 1;
    target.pass = false;
  }
  return {
    kind: "self-tests-alone-summary",
    repo_root: "/tmp/o12s13-gate-deadbeef",
    git_head: GATE_HEAD,
    results_dir: "/tmp/o12s13-gate-deadbeef/torture-test/var/results/self-tests-alone-fixture",
    environment: { guard_safe_repo_root: true, real_state_prefix: "/root/.tamandua", gate_env: { ...GATE_ENV } },
    expected_counts: { npf2: 2, aged: 4, o12: 8, qualification: 1 },
    entries,
    ...summarizeSelfTestsAlone(entries),
  };
}

/** A synthesized O12 gate self-test summary. */
function greenO12Gate({ red = null, fixtureCount = 78, expectedFixtureCount = 78 } = {}) {
  const entries = O12_ENTRIES.map((definition) => ({
    name: definition.name,
    kind: definition.kind,
    argv: ["node", definition.rel],
    exit_code: red === definition.name ? 1 : 0,
    signal: null,
    duration_ms: 1000,
    pass: red !== definition.name,
    stdout_log: `/tmp/${definition.name}.stdout.log`,
    stderr_log: `/tmp/${definition.name}.stderr.log`,
  }));
  const redEntries = entries.filter((entry) => entry.exit_code !== 0);
  return {
    kind: "o12-gate-self-tests-summary",
    repo_root: "/tmp/o12s13-gate-deadbeef",
    dist_dir: "/tmp/o12s13-gate-deadbeef/dist",
    results_dir: "/tmp/o12s13-gate-deadbeef/torture-test/var/results/o12-gate-self-tests-fixture",
    gate_env: { ...GATE_ENV, TAMANDUA_O12_PROBE_DIST: "/tmp/o12s13-gate-deadbeef/dist" },
    entries,
    total: entries.length,
    passed: entries.length - redEntries.length,
    failed: redEntries.length,
    red_files: redEntries.map((entry) => entry.name),
    verdict: redEntries.length === 0 ? "PASS" : "FAIL",
    fixture_matrix: {
      path: "/tmp/o12-fixture-matrix.json",
      expected_fixture_count: expectedFixtureCount,
      fixture_count: fixtureCount,
      all_match: true,
      all_correction_cases_green: true,
      snapshot_immutability_ok: true,
      validation: { ok: true, problems: [] },
    },
    matrix_pass: true,
    overall_verdict: redEntries.length === 0 ? "PASS" : "FAIL",
  };
}

function greenSeedReceipt({ userVersion = 13, mode = 0o444 } = {}) {
  return {
    kind: "o12-owned-seed-snapshots",
    receiptPath: "/tmp/owned-seed-snapshots-receipt.json",
    var_root: "/tmp/o12-var",
    supported_user_versions: [9, 10, 11, 12, 13],
    snapshots: [
      {
        label: "v13",
        case_id: "owned-store-current-v13",
        path: "/tmp/o12-var/seed-snapshot-v13.sqlite",
        basename: "seed-snapshot-v13.sqlite",
        user_version: userVersion,
        lineage: "current",
        sha256: "a".repeat(64),
        bytes: 61440,
        mode,
      },
      {
        label: "legacy-v12-main",
        case_id: "owned-store-legacy-v12-main",
        path: "/tmp/o12-var/seed-snapshot-legacy-v12.sqlite",
        basename: "seed-snapshot-legacy-v12.sqlite",
        user_version: 12,
        lineage: "main-v12",
        sha256: "b".repeat(64),
        bytes: 61440,
        mode: 0o444,
      },
    ],
  };
}

function greenRecord(overrides = {}) {
  return buildGateEvidence({
    runId: "run-fixture",
    story: "US-006 - Gates: run the torture self-tests each alone under the guard and retain evidence",
    branch: "feature/o12-schema-13-support",
    base: "7fe9f258",
    head: "e03281fa",
    commands: [
      "flock --exclusive /tmp/vaivm-gate.lock node torture-test/self-tests/run-self-tests-alone.mjs --results-base <run-worktree>/torture-test/var/results",
      "node torture-test/oracles/self-test/run-o12-gate-self-tests.mjs",
    ],
    substitutions: ["gate lock = /tmp/vaivm-gate.lock"],
    selfTestsAlone: greenSelfTestsAlone(overrides.selfTestsAlone),
    o12Gate: greenO12Gate(overrides.o12Gate),
    seedReceipt: overrides.seedReceipt === undefined ? greenSeedReceipt() : overrides.seedReceipt,
    generatedAt: "2026-09-21T00:00:00.000Z",
  });
}

test("the green record validates and records the frozen selection, env and exits", () => {
  const record = greenRecord();
  assert.equal(record.kind, GATE_EVIDENCE_KIND);
  assert.equal(record.gate.expected_required_total, 14);
  assert.deepEqual(record.gate.expected_counts, { npf2: 2, aged: 4, o12: 8, qualification: 1 });
  const validation = validateO12Schema13GateEvidence(record);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(record.self_tests_alone.entries.length, 15, "14 gating + 1 informational entry");
  assert.equal(record.self_tests_alone.by_group.qualification.gating, false);
});

test("the validator rejects every load-bearing drift", () => {
  const tamperedExit = greenRecord();
  tamperedExit.self_tests_alone.entries.find((entry) => entry.name === "o12-run-number-probe.mjs").exit_code = 1;
  let result = validateO12Schema13GateEvidence(tamperedExit);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("exited 1")), result.problems.join("; "));

  const tamperedVerdict = greenRecord();
  tamperedVerdict.self_tests_alone.entries[0].verdict = "FAIL";
  assert.equal(validateO12Schema13GateEvidence(tamperedVerdict).ok, false);

  const driftedGroup = greenRecord();
  driftedGroup.self_tests_alone.by_group.o12.total = 7;
  result = validateO12Schema13GateEvidence(driftedGroup);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("by_group.o12.total")));

  const redGate = greenRecord({ selfTestsAlone: { red: "aged-core.test.mjs" } });
  assert.equal(validateO12Schema13GateEvidence(redGate).ok, false);

  const redO12Entry = greenRecord({ o12Gate: { red: "o12.test.mjs" } });
  result = validateO12Schema13GateEvidence(redO12Entry);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("o12 gate entry o12.test.mjs exited 1")));

  const fixtureDrift = greenRecord({ o12Gate: { fixtureCount: 77, expectedFixtureCount: 78 } });
  result = validateO12Schema13GateEvidence(fixtureDrift);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("expected_fixture_count 78 !== fixture_count 77")));

  const weakenedEnv = greenRecord();
  weakenedEnv.self_tests_alone.environment.gate_env.TAMANDUA_PI_BINARY = "/bin/true";
  assert.equal(validateO12Schema13GateEvidence(weakenedEnv).ok, false);

  const unsafeRoot = greenRecord();
  unsafeRoot.self_tests_alone.environment.guard_safe_repo_root = false;
  assert.equal(validateO12Schema13GateEvidence(unsafeRoot).ok, false);

  const noCommands = greenRecord();
  noCommands.gate.commands = [];
  assert.equal(validateO12Schema13GateEvidence(noCommands).ok, false);

  const wrongSeed = greenRecord({ seedReceipt: greenSeedReceipt({ userVersion: 10 }) });
  result = validateO12Schema13GateEvidence(wrongSeed);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("stamped 13")));

  const writableSeed = greenRecord({ seedReceipt: greenSeedReceipt({ mode: 0o644 }) });
  assert.equal(validateO12Schema13GateEvidence(writableSeed).ok, false);

  const noSeed = greenRecord({ seedReceipt: null });
  assert.equal(validateO12Schema13GateEvidence(noSeed).ok, false);

  assert.equal(validateO12Schema13GateEvidence(null).ok, false);
  assert.equal(validateO12Schema13GateEvidence({ kind: GATE_EVIDENCE_KIND }).ok, false);
});

test("the published record (when present) validates and matches the retained summaries", () => {
  if (!fs.existsSync(RECORD_PATH)) {
    process.stderr.write(`no published gate evidence record found at ${RECORD_PATH}; skipping retained-record assertions\n`);
    return;
  }
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const validation = validateO12Schema13GateEvidence(record);
  assert.equal(validation.ok, true, validation.problems.join("; "));

  // Cross-check every recorded exit against the retained summaries themselves.
  const selfTestsAlonePath = path.join(record.self_tests_alone.results_dir, "self-tests-alone-summary.json");
  if (fs.existsSync(selfTestsAlonePath)) {
    const retained = JSON.parse(fs.readFileSync(selfTestsAlonePath, "utf8"));
    assert.equal(record.self_tests_alone.git_head, retained.git_head, "recorded gate HEAD must be the retained one");
    assert.equal(record.self_tests_alone.verdict, retained.verdict);
    for (const entry of retained.entries) {
      const recorded = record.self_tests_alone.entries.find((candidate) => candidate.name === entry.name);
      assert.ok(recorded, `recorded entry ${entry.name}`);
      assert.equal(recorded.exit_code, entry.exit_code, `recorded exit for ${entry.name}`);
    }
  }
  const o12GatePath = path.join(record.o12_gate.results_dir, "o12-gate-self-tests-summary.json");
  if (fs.existsSync(o12GatePath)) {
    const retained = JSON.parse(fs.readFileSync(o12GatePath, "utf8"));
    assert.equal(record.o12_gate.overall_verdict, retained.overall_verdict);
    for (const entry of retained.entries) {
      const recorded = record.o12_gate.entries.find((candidate) => candidate.name === entry.name);
      assert.ok(recorded, `recorded O12 gate entry ${entry.name}`);
      assert.equal(recorded.exit_code, entry.exit_code, `recorded O12 gate exit for ${entry.name}`);
    }
  }
  // The record must point at retained artifacts that still exist on this host.
  assert.ok(fs.existsSync(path.join(record.self_tests_alone.results_dir, "results.tsv")),
    "the recorded self-tests-alone results dir must still hold results.tsv");
  for (const entry of record.self_tests_alone.entries) {
    assert.ok(entry.stdout_log && fs.existsSync(entry.stdout_log), `retained stdout log: ${entry.name}`);
    assert.ok(entry.stderr_log && fs.existsSync(entry.stderr_log), `retained stderr log: ${entry.name}`);
  }
});
