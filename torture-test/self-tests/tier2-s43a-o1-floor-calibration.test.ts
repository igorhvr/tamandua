// S43a (US-006) — O1 duration-floor calibration: expected_fast_failure flag
// + per-cell duration floors.
//
// The O1 duration-floor guard compares each real run against a duration
// floor (a per-case production_duration_floor_ms pin, else the wave-1
// median). Campaign-20260826T225744158Z showed the guard statistically
// flagging ~half of honest runs: W4.08-control (the honest full-pipeline
// bfmw control) finished **13% under its 600000ms production floor (522s)
// with green content oracles**, and the refusal / fast-honest do-now cells
// (W4.37-keyline-spoof-repo-content, W4.38-hostile-task-real,
// W4.47-auth-expiry-copy, W4.dsh-do-now) whose CORRECT behavior is early
// termination were flagged the same way — the pre-fix manifest declared NO
// `expected_fast_failure` on any of them (only
// `production_duration_floor_ms: 120000`).
//
// This test proves (zero tokens, files ONLY under torture-test/ + temp dirs):
//   * RED-ARM: pins the campaign evidence line (the S43a traceability
//     section quotes W4.08-control's 13%-under finding and names the
//     pre-fix manifest shape — the four fast-honest rows declared no
//     expected_fast_failure) and REPRODUCES the pre-fix flag
//     history-independently: the oracle self-test fixture
//     `o1-control-under-floor` (an honest 522s control run against the
//     600000ms family floor, green content oracles, the only fast run in a
//     4-run family) FAILs with O1_DURATION_FLOOR_RATE citing the honest
//     control run;
//   * GREEN-ARM (manifest): W4.37, W4.38-hostile-task-real, W4.47 and
//     W4.dsh-do-now now declare `expected_fast_failure: true`;
//     W4.08-control keeps a production floor (it must NOT be fast) as a
//     per-cell `production_duration_floor_ms: 480000` with a documented
//     basis; `tt-controller --manifest cases/tier2.jsonl --validate-only`
//     stays green;
//   * GREEN-ARM (O1): `o1-control-per-cell-floor` (the per-cell 480000ms
//     floor clears the 522s honest run — the per-cell floor is authoritative
//     for that cell, family PASSes), `o1-fast-honest-flagged` (an all-flagged
//     family PASSes with a zero-run observation row — flagged runs are
//     excluded from BOTH numerator and denominator), and
//     `o1-flagged-unflagged-mixed` (an UN-FLAGGED too-fast run still FAILs
//     the 120s floor — rate computed on the un-flagged eligible only, citing
//     only the un-flagged run);
//   * GREEN-ARM (schema fail-closed): case.schema.json declares
//     expected_fast_failure as an optional boolean and the controller's
//     --validate-only REJECTS a non-boolean value (never a silent pass).
//
// Follows the tier2-*.test.ts self-test pattern (node builtins +
// repo-relative module imports); picked up by self-tests/run.sh's tier2
// glob automatically.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");
const generator = path.join(ttRoot, "oracles", "self-test", "generate-o1-fixtures.mjs");
const oracleBinary = path.join(ttRoot, "oracles", "O1");
const varRoot = path.join(ttRoot, "var");

const FAST_HONEST_CELLS = [
  "W4.37-keyline-spoof-repo-content",
  "W4.38-hostile-task-real",
  "W4.47-auth-expiry-copy",
  "W4.dsh-do-now",
];

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function recordById(id: string): any {
  const record = readManifest().find((item) => item.id === id);
  assert.ok(record, `${id} must exist in tier2.jsonl`);
  return record;
}

function runController(args: string[], cwd: string = repoRoot) {
  return spawnSync(controller, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TAMANDUA_PI_BINARY: "/usr/bin/false", TAMANDUA_HERMES_BINARY: "/usr/bin/false" },
  });
}

// Invoke the O1 oracle binary against a generated fixture context
// (history-independent — the fixture is built inline by the generator).
function invokeO1Fixture(workspace: string, name: string) {
  const expectation = JSON.parse(fs.readFileSync(path.join(workspace, name, "expectation.json"), "utf8"));
  const contextPath = expectation.context;
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: "1",
    TT_ORACLE_ID: "O1",
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  };
  const result = spawnSync(oracleBinary, ["--contract-version", "1", "--context", contextPath], {
    cwd: path.dirname(contextPath), env, encoding: "utf8", shell: false, timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { expectation, response: JSON.parse(result.stdout.trim()), status: result.status };
}

function generateO1Fixtures(workspace: string) {
  const generated = spawnSync(process.execPath, [generator, workspace], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr);
}

describe("S43a US-006: O1 duration-floor calibration", () => {
  it("RED-ARM: pins the campaign evidence + pre-fix manifest shape and reproduces the pre-fix flag on the W4.08-control 13%-under shape", () => {
    const traceability = fs.readFileSync(traceabilityPath, "utf8");
    const section = traceability.match(/## S43a[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/)?.[1];
    assert.ok(section, "tier2-traceability.md must contain an S43a section");
    // Campaign evidence line (verbatim): W4.08-control ran 13% under the
    // 600000ms production floor with green content oracles.
    assert.match(section, /13% under/);
    assert.match(section, /600000ms/);
    assert.match(section, /green content oracles/);
    // Pre-fix manifest shape: the four fast-honest cells declared no
    // expected_fast_failure (only production_duration_floor_ms 120000).
    for (const id of FAST_HONEST_CELLS) {
      assert.ok(section.includes(id), `S43a section must name ${id}`);
    }
    assert.match(section, /pre-fix manifest/);

    // History-independent reproduction of the pre-fix flag: the generated
    // o1-control-under-floor fixture (honest 522s control run vs the
    // 600000ms family floor, the only fast run in a 4-run family) FAILs with
    // O1_DURATION_FLOOR_RATE citing the honest control run.
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test.s43a-red."));
    try {
      generateO1Fixtures(workspace);
      const { response, status } = invokeO1Fixture(workspace, "o1-control-under-floor");
      assert.equal(status, 1);
      assert.equal(response.result, "FAIL");
      const rate = response.findings.find((finding: any) => finding.id === "O1_DURATION_FLOOR_RATE");
      assert.ok(rate, JSON.stringify(response.findings));
      assert.equal(rate.run_count, 4);
      assert.equal(rate.fast_run_count, 1);
      assert.equal(rate.fast_rate, 0.25);
      assert.deepEqual(rate.run_ids, ["run-11111111-1111-4111-8111-111111111111"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: the fast-honest rows declare expected_fast_failure and W4.08-control declares a per-cell floor", () => {
    for (const id of FAST_HONEST_CELLS) {
      const record = recordById(id);
      assert.equal(record.expected_fast_failure, true, `${id} must declare expected_fast_failure: true`);
      assert.equal(record.workflow, "do-now", `${id} must be a do-now cell`);
    }
    const control = recordById("W4.08-control");
    // The control must NOT be fast: it keeps a production floor, recalibrated
    // as a per-cell floor that absorbs the measured honest variance (522s)
    // while still failing genuinely-fast sub-8-minute runs.
    assert.equal(control.expected_fast_failure, undefined, "W4.08-control must NOT be expected_fast_failure");
    assert.equal(control.production_duration_floor_ms, 480000, "W4.08-control per-cell floor must be 480000ms");
    assert.equal(typeof control.production_duration_floor_basis, "string", "W4.08-control must document the per-cell floor basis");
    assert.ok(control.production_duration_floor_basis.includes("S43a"), "the basis must cite the S43a recalibration");

    // The real manifest stays schema-valid through the production controller.
    const res = runController(["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("GREEN-ARM: O1 clears the per-cell floor, passes the all-flagged family, and still fails an un-flagged too-fast run", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test.s43a-green."));
    try {
      generateO1Fixtures(workspace);

      // Per-cell floor authoritative: the SAME 522s honest run clears the
      // recalibrated 480000ms per-cell floor and the family PASSes.
      const perCell = invokeO1Fixture(workspace, "o1-control-per-cell-floor");
      assert.equal(perCell.status, 0);
      assert.equal(perCell.response.result, "PASS");
      assert.equal(perCell.response.findings.some((finding: any) => finding.id.startsWith("O1_DURATION_FLOOR")), false, JSON.stringify(perCell.response.findings));
      const perCellEvidence = JSON.parse(fs.readFileSync(path.join(workspace, "o1-control-per-cell-floor", "evidence", perCell.response.evidence[0].path), "utf8"));
      const perCellFloors = new Map(perCellEvidence.duration_floor_observations[0].case_floors.map((row: any) => [row.case_id, row]));
      assert.equal(perCellFloors.get("o1-control-per-cell-floor").duration_floor_ms, 480000);
      assert.equal(perCellEvidence.duration_floor_observations[0].fast_run_count, 0);

      // Flag authoritative: an all-flagged fast-honest family PASSes; the
      // zero-run observation row is written (evidence completeness).
      const flagged = invokeO1Fixture(workspace, "o1-fast-honest-flagged");
      assert.equal(flagged.status, 0);
      assert.equal(flagged.response.result, "PASS");
      assert.equal(flagged.response.findings.some((finding: any) => finding.id.startsWith("O1_DURATION_FLOOR")), false, JSON.stringify(flagged.response.findings));
      const flaggedEvidence = JSON.parse(fs.readFileSync(path.join(workspace, "o1-fast-honest-flagged", "evidence", flagged.response.evidence[0].path), "utf8"));
      assert.equal(flaggedEvidence.duration_floor_observations.length, 1);
      assert.equal(flaggedEvidence.duration_floor_observations[0].run_count, 0);
      assert.equal(flaggedEvidence.duration_floor_observations[0].fast_run_count, 0);

      // Fail-closed unchanged: flagged fast runs are excluded from BOTH
      // numerator and denominator, but an un-flagged too-fast run (60s vs the
      // 120s floor) still FAILs — rate on the un-flagged eligible only,
      // citing only the un-flagged run.
      const mixed = invokeO1Fixture(workspace, "o1-flagged-unflagged-mixed");
      assert.equal(mixed.status, 1);
      assert.equal(mixed.response.result, "FAIL");
      const rate = mixed.response.findings.find((finding: any) => finding.id === "O1_DURATION_FLOOR_RATE");
      assert.ok(rate, JSON.stringify(mixed.response.findings));
      assert.equal(rate.run_count, 4);
      assert.equal(rate.fast_run_count, 1);
      assert.equal(rate.fast_rate, 0.25);
      assert.deepEqual(rate.run_ids, ["run-wave-peer-1"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: case.schema.json declares expected_fast_failure fail-closed (optional boolean, non-boolean rejected)", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const prop = schema.properties?.expected_fast_failure;
    assert.ok(prop, "case.schema.json must declare expected_fast_failure");
    assert.equal(prop.type, "boolean");
    assert.ok(!(schema.required ?? []).includes("expected_fast_failure"), "the field must be optional");

    // Fail-closed: a non-boolean expected_fast_failure is REJECTED by the
    // production controller's --validate-only (never a silent pass).
    fs.mkdirSync(varRoot, { recursive: true });
    const badDir = fs.mkdtempSync(path.join(varRoot, "s43a-schema-probe."));
    try {
      const rows = readManifest().map((record) => ({ ...record }));
      const target = rows.find((record) => record.id === "W4.37-keyline-spoof-repo-content");
      assert.ok(target);
      target.expected_fast_failure = "yes";
      const badManifest = path.join(badDir, "bad-manifest.jsonl");
      fs.writeFileSync(badManifest, rows.map((record) => JSON.stringify(record)).join("\n") + "\n");
      const res = runController(["--manifest", badManifest]);
      assert.equal(res.status, 2, "a non-boolean expected_fast_failure must fail --validate-only");
      assert.match(res.stderr, /expected_fast_failure/);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});
