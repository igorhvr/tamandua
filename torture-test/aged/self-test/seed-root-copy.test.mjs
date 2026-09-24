// seed-root-copy.test.mjs — Storm O12-REPIN US-006 self-test for the owned
// seed-root copy + fresh aged-validation report machinery.
//
// Pure/unit layer over synthetic fixtures: it does NOT touch the retained /opt
// seed root and does NOT run the real O12 oracle. The real run is retained as
// evidence by `node torture-test/aged/seed-root-copy.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SOURCE_ROOT,
  SEED_CENSUS_RECEIPT_BASENAME,
  SEED_SIDECAR_BASENAME,
  SEED_SNAPSHOT_BASENAME,
  allocateGuardSafeStateDir,
  buildFreshClassification,
  buildOwnedSeedRootCopy,
  captureRetainedSourceIdentity,
  isUnderRealStatePrefix,
  retainedSourceUnchanged,
  validateFreshReport,
} from "../seed-root-copy.mjs";
import {
  O12_PINNED_CONTENT_SHA256,
  O12_PINNED_PROVENANCE_COMMIT,
  O12_PINNED_ACCEPTANCE,
  SEED_VALIDATION_CLASSIFICATION_BASENAME,
  buildValidationClassification,
  writeValidationClassification,
} from "../validate.mjs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function makeSyntheticSourceRoot() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "o12-repin-src."));
  fs.mkdirSync(path.join(src, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(src, "receipts"), { recursive: true });
  fs.mkdirSync(path.join(src, "state", "events"), { recursive: true });
  fs.writeFileSync(path.join(src, "state.json"), '{"campaign":"synthetic","kind":"aged-state-seed"}\n');
  fs.writeFileSync(
    path.join(src, "manifest.json"),
    JSON.stringify(
      {
        schema_version: 1,
        seed_kind: "full",
        allocated_at_utc: "2026-09-15T00:00:00Z",
        allocated_by_run: "run-synthetic",
        ownership: { root: fs.realpathSync(src), dev: 1, ino: 2 },
        source: { repo_root: "/opt/retained" },
        catalog: null,
        origin: null,
        recipe: null,
        phases: { catalog: "done", seed: "done", census: "done", validate: "done" },
        counts: { runs: 2 },
        qualified: false,
        disposition_counts: { completed: 2 },
        seed_failures: [],
        snapshot: {
          db: { file: path.join(src, "evidence", SEED_SNAPSHOT_BASENAME), sha256: "x", userVersion: 10 },
          events: { dir: path.join(src, "state", "events"), copied: [] },
          reservedBaselineSidecar: { file: path.join(src, "evidence", SEED_SIDECAR_BASENAME), sha256: "y" },
          censusReceipt: { file: path.join(src, "receipts", SEED_CENSUS_RECEIPT_BASENAME), created: true },
          refs: null,
        },
        validation: { reportFile: "/opt/retained/evidence/seed-validation-report.json" },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(src, "evidence", SEED_SNAPSHOT_BASENAME), "SQLITE-PLACEHOLDER\n");
  fs.writeFileSync(path.join(src, "evidence", SEED_SIDECAR_BASENAME), '{"schema_version":2}\n');
  fs.writeFileSync(path.join(src, "evidence", "generation-report.json"), '{"timing_seconds":{"full_seed":1}}\n');
  fs.writeFileSync(path.join(src, "evidence", "seed-validation-report.json"), '{"prior":true}\n');
  fs.writeFileSync(
    path.join(src, "receipts", SEED_CENSUS_RECEIPT_BASENAME),
    '{"db":{"runs":2},"events":{"perRunLogicalLines":3},"worktrees":{"rowCount":0}}\n',
  );
  fs.writeFileSync(path.join(src, "state", "events", "run1.jsonl"), '{"event":"run.completed"}\n');
  fs.writeFileSync(path.join(src, "state", "events", "all.jsonl"), '{"event":"run.completed"}\n');
  return src;
}

function syntheticDbIntegrity() {
  return {
    schema_version: 1,
    overall_result: "FAIL",
    finding_ids: ["O12_TIME_MIXED_NATIVE_FORMAT", "O12_TIME_PAIR_FORMAT_MISMATCH"],
    observations: [
      {
        scope: "structural",
        schema_metadata: { user_version: 10, supported_user_versions: [9, 10] },
      },
      {
        scope: "timestamps",
        native_mixed_column_count: 1,
        pair_format_mismatch_count: 12,
        order_violation_count: 0,
        shape_histogram: { "steps.updated_at": { "native-sqlite": 7, "native-iso": 5 } },
      },
    ],
    coverage: {
      R1: { obligation: "structural-integrity-orphans", result: "PASS" },
      R2: { obligation: "run-number-uniqueness", result: "PASS", rows_checked: 2, duplicate_number_count: 0 },
      R3: { obligation: "timestamp-uniformity-instant-order", result: "FAIL", pair_format_mismatch_count: 12, native_format_mix_column_count: 1, order_violation_count: 0 },
      R4: {
        obligation: "context-json-reserved-keys",
        result: "PASS",
        reserved_key_leg: { result: "PASS", runs_compared: 2, keys_checked: 34, overwrite_count: 0, host_transition_matches: 0 },
      },
      R5: { obligation: "serial-composite-state", result: "PASS", violation_count: 0 },
      R6: { obligation: "per-obligation-coverage", result: "PASS", overall: "FAIL" },
    },
  };
}

function syntheticReport(evidenceDir, dbIntegrity) {
  const rows = ["O1", "O2", "O3z", "O4", "O5", "O6", "O7", "O8", "O9", "O10", "O11", "O16"].map((oracle) => ({
    oracle,
    status: oracle === "O5" ? "NOT_EVALUABLE" : "PASS",
    findings: [],
  }));
  rows.push({
    oracle: "O12",
    status: "FAIL",
    pinnedContentSha256: O12_PINNED_CONTENT_SHA256,
    pinnedProvenanceCommit: O12_PINNED_PROVENANCE_COMMIT,
    acceptance: O12_PINNED_ACCEPTANCE,
    findings: dbIntegrity.finding_ids.map((id) => ({ id })),
  });
  return {
    ts_utc: "2026-09-16T00:00:00Z",
    validator_source: { sha: "f".repeat(40) },
    o12_pin: {
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      provenance_subject: "schema-10 pin",
      acceptance: O12_PINNED_ACCEPTANCE,
      subject: "schema-10 pin",
    },
    routing: { rows },
    o12: {
      exitCode: 1,
      stdoutJson: {
        result: "FAIL",
        findings: [
          { id: "O12_TIME_MIXED_NATIVE_FORMAT", summary: "mixed", table: "steps", column: "updated_at" },
          { id: "O12_TIME_PAIR_FORMAT_MISMATCH", summary: "12 pairs", count: 12 },
        ],
      },
      evidenceDir,
      evidenceFile: path.join(evidenceDir, "o12-run-evidence.json"),
    },
  };
}

test("buildOwnedSeedRootCopy rewrites identity/paths and never writes the source", () => {
  const src = makeSyntheticSourceRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o12-repin-dst."));
  const guardState = fs.mkdtempSync(path.join(os.tmpdir(), "o12-repin-guard."));
  try {
    const before = captureRetainedSourceIdentity(src);
    const result = buildOwnedSeedRootCopy({
      sourceRoot: src,
      destRoot: root,
      stateDbPath: path.join(guardState, "tamandua.db"),
    });
    assert.equal(result.stateDbPath, path.join(guardState, "tamandua.db"));
    assert.ok(fs.existsSync(result.stateDbPath), "guard-safe live DB materialized");
    assert.equal(
      fs.readFileSync(result.stateDbPath, "utf8"),
      fs.readFileSync(path.join(src, "evidence", SEED_SNAPSHOT_BASENAME), "utf8"),
      "live DB is a copy of the immutable snapshot",
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.ownership.root, fs.realpathSync(root), "ownership rewritten to the copy real path");
    assert.equal(manifest.snapshot.db.file, path.join(root, "evidence", SEED_SNAPSHOT_BASENAME));
    assert.equal(manifest.snapshot.reservedBaselineSidecar.file, path.join(root, "evidence", SEED_SIDECAR_BASENAME));
    assert.equal(manifest.snapshot.censusReceipt.file, path.join(root, "receipts", SEED_CENSUS_RECEIPT_BASENAME));
    assert.equal(manifest.snapshot.events.dir, path.join(root, "state", "events"));
    assert.equal(manifest.validation, null, "stale validation block dropped");
    assert.deepEqual(manifest.counts, { runs: 2 }, "corpus counts copied verbatim");

    assert.ok(fs.existsSync(path.join(root, "evidence", "seed-validation-report.json")), "prior report retained for archival");
    assert.ok(fs.existsSync(path.join(root, "evidence", "o12-repin-copy-provenance.json")));
    assert.ok(fs.existsSync(path.join(root, "state", "events", "run1.jsonl")), "event stream copied");

    const after = captureRetainedSourceIdentity(src);
    assert.equal(retainedSourceUnchanged(before, after), true, "retained source untouched");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(guardState, { recursive: true, force: true });
  }
});

test("buildFreshClassification derives exact counts + observations from fresh evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "o12-repin-cls."));
  try {
    const dbIntegrity = syntheticDbIntegrity();
    const evidenceDir = path.join(root, "evidence", "o12", "o12", "2026-09-16T00-00-00-000Z");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "o12-db-integrity.json"), JSON.stringify(dbIntegrity));
    const report = syntheticReport(evidenceDir, dbIntegrity);
    const classification = buildFreshClassification({
      copyRoot: root,
      report,
      pairBreakdown: { runs: { pair_mismatch_count: 5 }, steps: { pair_mismatch_count: 7 } },
    });
    assert.equal(classification.o12_pin.content_sha256, O12_PINNED_CONTENT_SHA256);
    assert.equal(classification.matrix_tally.PASS, 11, "11 PASS rows in the synthetic matrix");
    assert.equal(classification.matrix_tally.FAIL, 1);
    assert.equal(classification.matrix_tally.NOT_EVALUABLE, 1);
    const red = classification.native_reds[0];
    assert.equal(red.oracle, "O12");
    assert.equal(red.classification, "NATIVE");
    assert.equal(red.counts.O12_TIME_PAIR_FORMAT_MISMATCH.pair_format_mismatch_count, 12);
    assert.equal(red.counts.O12_TIME_PAIR_FORMAT_MISMATCH.breakdown.runs_created_iso_vs_updated_sqlite, 5);
    assert.equal(red.counts.O12_TIME_PAIR_FORMAT_MISMATCH.breakdown.steps_created_iso_vs_updated_sqlite, 7);
    assert.equal(red.counts.O12_TIME_MIXED_NATIVE_FORMAT.shape_breakdown.total_steps, 12);
    assert.equal(classification.o12_time_red.reproduced, true);
    assert.equal(classification.o12_time_red.classification, "NATIVE");
    assert.deepEqual(classification.o12_time_red.beads, ["tamandua-6sy.31", "tamandua-6sy.27"]);
    assert.match(classification.observations[0], /R1 .*EVALUABLE and PASSES/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateFreshReport requires the accepted pin, R1 PASS and R3 the only FAIL", () => {
  const dbIntegrity = syntheticDbIntegrity();
  const good = syntheticReport("/evidence/o12", dbIntegrity);
  const ok = validateFreshReport({ report: good, dbIntegrity });
  assert.equal(ok.ok, true, `expected ok, problems: ${ok.problems.join("; ")}`);
  assert.deepEqual(ok.matrix.legs.R1, { result: "PASS" });
  assert.deepEqual(ok.matrix.legs.R3, { result: "FAIL" });

  const notEvaluable = JSON.parse(JSON.stringify(dbIntegrity));
  notEvaluable.coverage.R1.result = "NOT_EVALUABLE";
  const bad = validateFreshReport({ report: good, dbIntegrity: notEvaluable });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.startsWith("R1 NOT_EVALUABLE")), "R1 NOT_EVALUABLE rejected");

  const wrongPin = syntheticReport("/evidence/o12", dbIntegrity);
  wrongPin.o12_pin = { content_sha256: "0".repeat(64), provenance_commit: "0".repeat(40), acceptance: "NOT_ROOT_ACCEPTED" };
  const pinProblems = validateFreshReport({ report: wrongPin, dbIntegrity });
  assert.equal(pinProblems.ok, false);
  assert.equal(pinProblems.problems.length >= 3, true);

  // A report whose routing O12 row carries a non-content pin is refused too.
  const wrongRow = syntheticReport("/evidence/o12", dbIntegrity);
  wrongRow.routing.rows = wrongRow.routing.rows.map((r) =>
    r.oracle === "O12" ? { ...r, pinnedContentSha256: "0".repeat(64) } : r,
  );
  const rowProblems = validateFreshReport({ report: wrongRow, dbIntegrity });
  assert.equal(rowProblems.ok, false);
  assert.ok(rowProblems.problems.some((p) => p.startsWith("routing O12.pinnedContentSha256")));
});

test("allocateGuardSafeStateDir never returns a real-state path", () => {
  assert.equal(isUnderRealStatePrefix(path.join(os.userInfo().homedir, ".tamandua", "x")), true);
  const dir = allocateGuardSafeStateDir({
    preferredBase: path.join(os.userInfo().homedir, ".tamandua", "x"),
    fallbackBase: os.tmpdir(),
  });
  try {
    assert.equal(isUnderRealStatePrefix(dir), false, "guard-safe dir is outside the real-state prefix");
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_SOURCE_ROOT is the retained read-only seed root", () => {
  assert.match(DEFAULT_SOURCE_ROOT, /^\/opt\/tamandua-storm-seed\./);
  assert.equal(DEFAULT_SOURCE_ROOT.includes(".."), false);
});

// ── STORM-AGED-FULL US-006: honest classification ledger ────────────────
//
// `tt-storm-aged validate` must persist BOTH the report and the red
// classification ledger.  The classifier derives every non-PASS row's class
// from real evidence: a green O12 yields NO fabricated NATIVE red, while the
// NOT_RUN / NOT_EVALUABLE rows stay explicitly distinct from PASS.

function syntheticPassDbIntegrity(userVersion = 14) {
  return {
    schema_version: 1,
    overall_result: "PASS",
    finding_ids: [],
    observations: [
      {
        scope: "structural",
        schema_metadata: { user_version: userVersion, supported_user_versions: [9, 10, 11, 12, 13, 14] },
      },
      {
        scope: "timestamps",
        native_mixed_column_count: 0,
        pair_format_mismatch_count: 0,
        order_violation_count: 0,
        shape_histogram: {},
      },
    ],
    coverage: {
      R1: { obligation: "structural-integrity-orphans", result: "PASS", integrity_check: "ok", foreign_key_check_violations: 0 },
      R2: { obligation: "run-number-uniqueness", result: "PASS", rows_checked: 2, duplicate_number_count: 0 },
      R3: { obligation: "timestamp-uniformity-instant-order", result: "PASS", invalid_value_count: 0, native_format_mix_column_count: 0, pair_format_mismatch_count: 0, order_violation_count: 0 },
      R4: { obligation: "context-json-reserved-keys", result: "PASS", reserved_key_leg: { result: "PASS", runs_compared: 2, keys_checked: 34, overwrite_count: 0, host_transition_matches: 0 } },
      R5: { obligation: "serial-composite-state", result: "PASS", violation_count: 0 },
      R6: { obligation: "per-obligation-coverage", result: "PASS", overall: "PASS" },
    },
  };
}

function syntheticPassReport(evidenceDir) {
  const rows = ["O1", "O2", "O3z", "O4", "O5", "O6", "O7", "O8", "O9", "O10", "O11", "O16"].map((oracle) => ({
    oracle,
    status: oracle === "O5" ? "NOT_EVALUABLE" : oracle === "O2" ? "NOT_RUN" : "PASS",
    execution_kind: oracle === "O5" ? "custom-seed-slice" : oracle === "O2" ? "custom-seed-slice" : "not-executed",
    full_oracle_status: oracle === "O5" ? "NOT_RUN" : oracle === "O2" ? "NOT_RUN" : "NOT_RUN",
    findings: [],
    counts: oracle === "O1" ? { terminal: 2 } : null,
  }));
  rows.push({
    oracle: "O12",
    status: "PASS",
    execution_kind: "real-oracle-execution",
    full_oracle_status: "PASS",
    findings: [],
    counts: null,
    pinnedContentSha256: O12_PINNED_CONTENT_SHA256,
    pinnedProvenanceCommit: O12_PINNED_PROVENANCE_COMMIT,
    acceptance: O12_PINNED_ACCEPTANCE,
  });
  return {
    ts_utc: "2026-09-23T00:00:00Z",
    validator_source: { sha: "f".repeat(40) },
    o12_pin: {
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      acceptance: O12_PINNED_ACCEPTANCE,
    },
    routing: { rows },
    o12: {
      exitCode: 0,
      stdoutJson: { result: "PASS", findings: [] },
      evidenceDir,
      evidenceFile: path.join(evidenceDir, "o12-run-evidence.json"),
    },
  };
}

test("buildValidationClassification: green O12 yields NO fabricated NATIVE red; NOT_RUN/NOT_EVALUABLE stay distinct from PASS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "us006-cls-pass."));
  try {
    const evidenceDir = path.join(root, "evidence", "o12", "o12", "2026-09-23T00-00-00-000Z");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "o12-db-integrity.json"), JSON.stringify(syntheticPassDbIntegrity()));
    const report = syntheticPassReport(evidenceDir);
    const classification = buildValidationClassification({
      seedRoot: root,
      report,
      dbIntegrity: syntheticPassDbIntegrity(),
    });
    assert.equal(classification.kind, "aged-seed-validation-classification");
    assert.equal(classification.native_reds.length, 0, "a green O12 must not fabricate a NATIVE red");
    assert.equal(classification.suite_reds.length, 0);
    assert.equal(classification.environment_reds.length, 0);
    assert.equal(classification.matrix_tally.FAIL, 0);
    assert.equal(classification.matrix_tally.NOT_RUN, 1);
    assert.equal(classification.matrix_tally.NOT_EVALUABLE, 1);
    assert.equal(classification.o12_result, "PASS");
    assert.equal(classification.o12_legs.R3, "PASS");
    assert.deepEqual(classification.o12_failing_legs, []);
    assert.equal(classification.o12_time_red.reproduced, false, "the TIME red did not reproduce and must be recorded as an explicit absence");
    assert.equal(classification.o12_time_red.classification, "PASS");
    assert.deepEqual(classification.o12_time_red.beads, ["tamandua-6sy.31", "tamandua-6sy.27"]);
    // Every non-PASS row carries an explicit, legal classification.
    for (const row of classification.routing_matrix) {
      if (row.status === "PASS") continue;
      assert.ok(
        ["NATIVE", "SUITE", "ENVIRONMENT", "NOT_RUN", "NOT_EVALUABLE"].includes(row.classification),
        `row ${row.oracle} must carry an explicit classification, got ${row.classification}`,
      );
    }
    assert.equal(classification.routing_matrix.find((r) => r.oracle === "O2").classification, "NOT_RUN");
    assert.equal(classification.routing_matrix.find((r) => r.oracle === "O5").classification, "NOT_EVALUABLE");
    assert.equal(classification.routing_matrix.find((r) => r.oracle === "O12").classification, "PASS");
    assert.match(classification.observations.join("\n"), /did NOT reproduce/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeValidationClassification persists the ledger under <seedRoot>/evidence and archives a prior one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "us006-cls-write."));
  try {
    const evidenceDir = path.join(root, "evidence", "o12", "o12", "2026-09-23T00-00-00-000Z");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "o12-db-integrity.json"), JSON.stringify(syntheticPassDbIntegrity()));
    const report = syntheticPassReport(evidenceDir);
    const first = writeValidationClassification({ seedRoot: root, report, dbIntegrity: syntheticPassDbIntegrity() });
    const written = path.join(root, "evidence", SEED_VALIDATION_CLASSIFICATION_BASENAME);
    assert.ok(fs.existsSync(written), "classification ledger must be written under <seedRoot>/evidence");
    assert.equal(first.file, written);
    // A re-run archives the prior ledger rather than silently overwriting it.
    const second = writeValidationClassification({ seedRoot: root, report, dbIntegrity: syntheticPassDbIntegrity() });
    const archived = fs
      .readdirSync(path.join(root, "evidence"))
      .filter((f) => f.startsWith(`${SEED_VALIDATION_CLASSIFICATION_BASENAME}.pre-`));
    assert.equal(archived.length, 1, "a prior classification ledger must be retained");
    const parsed = JSON.parse(fs.readFileSync(second.file, "utf8"));
    assert.equal(parsed.kind, "aged-seed-validation-classification");
    assert.equal(parsed.o12_result, "PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// RED-ARM (demonstrated before the fix): `tt-storm-aged validate` wrote only
// `seed-validation-report.json`, so a consumer that required the honest red
// ledger failed.  The phase must WIRE the writer; this static contract fails on
// a tree where the call is absent (captured pre-fix run retained under
// torture-test/var/results/).
test("RED-ARM: the validate phase wires the classification ledger writer", () => {
  const phasesSrc = fs.readFileSync(path.join(REPO_ROOT, "torture-test", "aged", "phases.mjs"), "utf8");
  assert.match(phasesSrc, /writeValidationClassification\(\{/, "phaseValidate must call writeValidationClassification");
  assert.match(phasesSrc, /findLatestO12DbIntegrity/, "the O12 db-integrity evidence must be located for the classification");
  assert.match(phasesSrc, /classificationFile:/, "the manifest must record the classification ledger path");
  const validateSrc = fs.readFileSync(path.join(REPO_ROOT, "torture-test", "aged", "validate.mjs"), "utf8");
  assert.match(validateSrc, /export function writeValidationClassification\(/);
  assert.match(validateSrc, /export const SEED_VALIDATION_RED_CLASSES/);
});
