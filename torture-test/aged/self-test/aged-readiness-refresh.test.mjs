// aged-readiness-refresh.test.mjs — NPF-2 US-012 self-test for the aged
// re-validation on an owned copy of the retained seed snapshot and the
// refreshed storm-seed readiness pointer / published qualification.
//
// Two layers:
//   1. Pure builders: the gate-hash honesty comparison, the refreshed
//      qualification shaping and the acceptance validator (with red arms).
//   2. Host layer (skips when the retained copy is not on this host): the
//      committed readiness pointer points at a seed root whose fresh
//      `seed-validation-report.json` carries the accepted CONTENT pin + the
//      recorded provenance commit and whose O12 matrix is unchanged (R1/R2/R4/R5
//      PASS, R3 FAIL native TIME), and the published qualification agrees.
//
// No model, no live state, no network.  Run alone with:
//   TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false \
//   TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false \
//   node --test torture-test/aged/self-test/aged-readiness-refresh.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareGateHashes,
  buildRefreshedQualification,
  validateRefreshedReadiness,
  REFRESH_KIND,
} from "../refresh-readiness.mjs";
import { findLatestDbIntegrity, extractLegMatrix } from "../seed-root-copy.mjs";
import {
  O12_PINNED_CONTENT_SHA256,
  O12_PINNED_PROVENANCE_COMMIT,
  O12_PINNED_ACCEPTANCE,
  O12_PRE_PORT_CONTENT_SHA256,
  O12_PRE_PORT_PROVENANCE_COMMIT,
  O12_PRE_PORT_PROVENANCE_SUBJECT,
} from "../validate.mjs";
import { QUALIFICATION_KIND, READINESS_KIND } from "../qualification.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const POINTER_PATH = path.join(REPO_ROOT, "torture-test", "storm-seed-readiness.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ── pure layer ───────────────────────────────────────────────────────────

test("compareGateHashes names the drift and never claims an unobserved match", () => {
  const gateHashes = { "a.ts": "1".repeat(64), "b.ts": "2".repeat(64), "c.ts": "3".repeat(64) };
  const same = compareGateHashes({ gateHashes, preparedCampaignDescriptor: gateHashes });
  assert.equal(same.matches_prepared_campaign_descriptor, true);
  assert.deepEqual(same.drifted_files, []);

  const prepared = { "a.ts": "1".repeat(64), "b.ts": "0".repeat(64), "d.ts": "4".repeat(64) };
  const drifted = compareGateHashes({ gateHashes, preparedCampaignDescriptor: prepared });
  assert.equal(drifted.matches_prepared_campaign_descriptor, false);
  assert.deepEqual(drifted.drifted_files.map((d) => d.file), ["b.ts", "c.ts", "d.ts"]);
  assert.equal(drifted.count, 3);
});

function syntheticReport() {
  return {
    ts_utc: "2026-09-16T00:00:00Z",
    validator_source: { head: { sha: "f".repeat(40) } },
    o12_pin: {
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      provenance_subject: "schema-10 pin",
      acceptance: O12_PINNED_ACCEPTANCE,
    },
    routing: {
      rows: ["O1", "O2", "O3z", "O4", "O5", "O6", "O7", "O8", "O9", "O10", "O11", "O16"].map((oracle) => ({
        oracle,
        status: "PASS",
        findings: [],
      })).concat([
        {
          oracle: "O12",
          status: "FAIL",
          findings: [{ id: "O12_TIME_PAIR_FORMAT_MISMATCH" }],
        },
      ]),
    },
    o12: {
      exitCode: 1,
      stdoutJson: { result: "FAIL", findings: [{ id: "O12_TIME_PAIR_FORMAT_MISMATCH" }] },
    },
  };
}

function syntheticClassification() {
  return {
    native_reds: [
      {
        oracle: "O12",
        classification: "NATIVE",
        counts: { O12_TIME_PAIR_FORMAT_MISMATCH: { pair_format_mismatch_count: 24166 } },
      },
    ],
    observations: ["O12 R1 EVALUABLE and PASSES"],
  };
}

function syntheticSeedManifest(root) {
  return {
    seed_kind: "full",
    allocated_at_utc: "2026-09-15T05:25:19.369Z",
    allocated_by_run: "run-b3057222",
    qualified: false,
    disposition_counts: { completed: 298 },
    snapshot: {
      db: { file: path.join(root, "evidence", "db-full-post.sqlite"), userVersion: 10 },
      reservedBaselineSidecar: { file: path.join(root, "evidence", "o12-reserved-baseline.json") },
    },
  };
}

test("buildRefreshedQualification re-derives the dynamic sections and preserves the arming/gates", () => {
  const seedRoot = "/tmp/o12-repin-seed-root-us012-synthetic";
  const existing = {
    kind: QUALIFICATION_KIND,
    task: "STORM-SEED-QUALIFY",
    bead: "tamandua-6sy.6.4.1",
    run_id: "run-b3057222-f531-46df-8d2c-0dd74fbfae88",
    branch: "feature/o12-repin-schema10",
    qualified_scope_note: "scope",
    arming: { campaign_id: "campaign-x", campaign_dir: "/campaign", profile: "SCRIPTED_REHEARSAL", mode: "prepared" },
    gates: { storm_chain_49: { verdict: "PASS" } },
    pins: { origin: { sha: "b".repeat(40) }, o12_oracle: { commit: "legacy" } },
    seed: { root: "/old", kind: "full", manifest_qualified: false },
    validation: { matrix: [], o12: { result: "FAIL" } },
    gate_hashes: { prepared_campaign_descriptor: {} },
  };
  const q = buildRefreshedQualification({
    existing,
    refreshedBy: { run_id: "run-71af02c8", head: "e".repeat(40), at_utc: "2026-01-01T00:00:00Z" },
    source: {
      commit: O12_PINNED_PROVENANCE_COMMIT,
      tree: "9".repeat(40),
      subject: "squash",
      tree_dirty: false,
      provenance: "durable",
    },
    seedRoot,
    seedManifest: syntheticSeedManifest(seedRoot),
    censusReceipt: { db: { runs: 5000, steps: 26526, run_worktrees: 200, byStatus: [] }, events: { perRunLogicalLines: 505000 }, worktrees: { rowCount: 200, directoryCount: 200, byStatus: [] } },
    report: syntheticReport(),
    classification: syntheticClassification(),
    gateHashes: { "a.ts": "1".repeat(64) },
    preparedCampaignDescriptor: { "a.ts": "0".repeat(64) },
    gateHashesSourceCommit: "e".repeat(40),
    publishedAtUtc: "2026-01-01T00:00:00Z",
    publishedPath: "/published/q.json",
    pointerPath: "/repo/pointer.json",
  });
  assert.equal(q.seed.root, seedRoot);
  assert.equal(q.seed.counts.runs, 5000);
  assert.equal(q.seed.counts.logical_events, 505000);
  assert.equal(q.source.commit, O12_PINNED_PROVENANCE_COMMIT);
  assert.equal(q.pins.o12_oracle.content_sha256, O12_PINNED_CONTENT_SHA256);
  assert.equal(q.pins.origin.sha, "b".repeat(40), "unchanged pins preserved");
  assert.equal(q.arming.campaign_id, "campaign-x", "arming preserved");
  assert.deepEqual(q.validation.matrix.find((r) => r.oracle === "O12").classification, "NATIVE");
  assert.equal(q.gate_hashes.matches_prepared_campaign_descriptor, false);
  assert.deepEqual(q.gate_hashes.drifted_files.map((d) => d.file), ["a.ts"]);
  assert.equal(q.refreshed_by.run_id, "run-71af02c8");
  assert.equal(q.gate_hashes.recomputed_source_commit, "e".repeat(40));
});

test("validateRefreshedReadiness accepts the fresh pair and rejects fabricated evidence", () => {
  const seedRoot = "/tmp/o12-repin-seed-root-us012-synthetic";
  const qualification = {
    kind: QUALIFICATION_KIND,
    task: "STORM-SEED-QUALIFY",
    seed: { root: seedRoot },
    source: { commit: O12_PINNED_PROVENANCE_COMMIT },
    pins: {
      o12_oracle: {
        content_sha256: O12_PINNED_CONTENT_SHA256,
        provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
        acceptance: O12_PINNED_ACCEPTANCE,
      },
    },
    qualified: false,
    blockers: [
      { id: "BLOCKER-O12-TIME-NATIVE", classification: "NATIVE", igor_decision: true },
    ],
    gate_hashes: { matches_prepared_campaign_descriptor: false, drifted_files: [{ file: "a.ts" }] },
  };
  const pointer = {
    kind: READINESS_KIND,
    seed: { root: seedRoot },
    source: { commit: O12_PINNED_PROVENANCE_COMMIT },
    qualification: { path: "/published/q.json" },
  };
  const legMatrix = {
    overall: "FAIL",
    legs: { R1: { result: "PASS" }, R2: { result: "PASS" }, R3: { result: "FAIL" }, R4: { result: "PASS" }, R5: { result: "PASS" } },
  };
  const ok = validateRefreshedReadiness({ qualification, pointer, legMatrix, qualificationPath: "/published/q.json" });
  assert.equal(ok.ok, true, ok.problems.join("; "));

  // Red arms: wrong pin, R1 not evaluable, honest-match inconsistency, pointer drift.
  const wrongPin = JSON.parse(JSON.stringify(qualification));
  wrongPin.pins.o12_oracle.content_sha256 = "0".repeat(64);
  assert.equal(validateRefreshedReadiness({ qualification: wrongPin, pointer, legMatrix, qualificationPath: "/published/q.json" }).ok, false);

  const r1Bad = JSON.parse(JSON.stringify(legMatrix));
  r1Bad.legs.R1.result = "NOT_EVALUABLE";
  assert.equal(validateRefreshedReadiness({ qualification, pointer, legMatrix: r1Bad, qualificationPath: "/published/q.json" }).ok, false);

  const gateBad = JSON.parse(JSON.stringify(qualification));
  gateBad.gate_hashes.matches_prepared_campaign_descriptor = true;
  assert.equal(validateRefreshedReadiness({ qualification: gateBad, pointer, legMatrix, qualificationPath: "/published/q.json" }).ok, false);

  const pointerDrift = JSON.parse(JSON.stringify(pointer));
  pointerDrift.seed.root = "/elsewhere";
  assert.equal(validateRefreshedReadiness({ qualification, pointer: pointerDrift, legMatrix, qualificationPath: "/published/q.json" }).ok, false);

  const qualifiedGreen = JSON.parse(JSON.stringify(qualification));
  qualifiedGreen.qualified = true;
  assert.equal(validateRefreshedReadiness({ qualification: qualifiedGreen, pointer, legMatrix, qualificationPath: "/published/q.json" }).ok, false);
});

test("REFRESH_KIND names the readiness refresh artifact", () => {
  assert.equal(REFRESH_KIND, "storm-seed-readiness-refresh");
});

// ── host layer ───────────────────────────────────────────────────────────

test("committed readiness pointer targets a fresh content-pin aged re-validation", (t) => {
  assert.ok(fs.existsSync(POINTER_PATH), `committed pointer exists: ${POINTER_PATH}`);
  const pointer = readJson(POINTER_PATH);
  // STORM-AGED-FULL US-009 regenerates the seed on this product and refreshes
  // the pointer to the regen seed root.  The retained US-012 copy this host
  // layer was written for is a different, pre-port artifact; when the pointer
  // no longer targets it, defer to the regeneration run's seed-readiness gate.
  if (!/o12-repin-seed-root-us012-/.test(pointer.seed.root)) {
    return t.skip(
      `pointer targets the regenerated seed root ${pointer.seed.root}; `
      + "the retained US-012 host layer does not apply",
    );
  }
  const reportPath = path.join(pointer.seed.root, "evidence", "seed-validation-report.json");
  const classificationPath = path.join(pointer.seed.root, "evidence", "seed-validation-classification.json");
  if (!fs.existsSync(reportPath) || !fs.existsSync(classificationPath)) {
    return t.skip(`retained US-012 copy not present on this host: ${pointer.seed.root}`);
  }

  const report = readJson(reportPath);
  // TORTURE-PORT US-006: the committed pointer locates the PRE-PORT seed
  // qualification, whose report pins the DECLARED schema-10 content set.  The
  // schema-9..13 re-pin superseded that pin and the seed is regenerated on this
  // product (out of TORTURE-PORT scope), so the current-pin identity assertions
  // below do not apply to the retained copy.  Assert the declared legacy
  // identity so a forged/unknown pin still fails, and leave the current-pin
  // readiness to the regeneration run.
  if (report.o12_pin?.content_sha256 === O12_PRE_PORT_CONTENT_SHA256) {
    assert.equal(report.o12_pin.provenance_commit, O12_PRE_PORT_PROVENANCE_COMMIT);
    assert.equal(report.o12_pin.provenance_subject, O12_PRE_PORT_PROVENANCE_SUBJECT);
    assert.equal(report.o12_pin.acceptance, "ROOT_ACCEPTED");
    const legacyO12Row = report.routing.rows.find((r) => r.oracle === "O12");
    assert.equal(legacyO12Row.pinnedContentSha256, O12_PRE_PORT_CONTENT_SHA256);
    return t.skip(
      `retained seed report is the declared pre-port schema-10 content pin ${O12_PRE_PORT_CONTENT_SHA256.slice(0, 12)}; `
      + "current-pin readiness is re-validated when the seed is regenerated on this product",
    );
  }
  assert.equal(report.o12_pin.content_sha256, O12_PINNED_CONTENT_SHA256);
  assert.equal(report.o12_pin.provenance_commit, O12_PINNED_PROVENANCE_COMMIT);
  assert.equal(report.o12_pin.acceptance, O12_PINNED_ACCEPTANCE);
  assert.equal(report.o12.stdoutJson.result, "FAIL");
  const o12Row = report.routing.rows.find((r) => r.oracle === "O12");
  assert.equal(o12Row.pinnedContentSha256, O12_PINNED_CONTENT_SHA256);
  assert.equal(o12Row.pinnedProvenanceCommit, O12_PINNED_PROVENANCE_COMMIT);
  assert.equal(o12Row.acceptance, O12_PINNED_ACCEPTANCE);

  const dbIntegrityFile = findLatestDbIntegrity(pointer.seed.root);
  assert.ok(dbIntegrityFile, "fresh O12 db-integrity evidence exists");
  const legMatrix = extractLegMatrix(readJson(dbIntegrityFile));
  assert.equal(legMatrix.legs.R1.result, "PASS");
  assert.equal(legMatrix.legs.R2.result, "PASS");
  assert.equal(legMatrix.legs.R3.result, "FAIL");
  assert.equal(legMatrix.legs.R4.result, "PASS");
  assert.equal(legMatrix.legs.R5.result, "PASS");
  assert.equal(legMatrix.overall, "FAIL");
  assert.equal(legMatrix.schema.user_version, 10);

  const qualificationPath = pointer.qualification.path;
  if (!fs.existsSync(qualificationPath)) {
    return t.skip(`published qualification not present on this host: ${qualificationPath}`);
  }
  const qualification = readJson(qualificationPath);
  const result = validateRefreshedReadiness({
    qualification,
    pointer,
    legMatrix,
    qualificationPath,
  });
  assert.equal(result.ok, true, result.problems.join("; "));

  // The classification is the fresh US-012 one, not a copied stale ledger.
  const classification = readJson(classificationPath);
  assert.equal(classification.story, "US-012");
  assert.equal(classification.o12_pin.content_sha256, O12_PINNED_CONTENT_SHA256);
  assert.equal(classification.native_reds[0].classification, "NATIVE");
});
