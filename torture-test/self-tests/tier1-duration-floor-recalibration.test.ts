// TRIA US-006 — wave-1 do-now duration floor recalibration (120s -> 30s).
//
// Campaign #8's four wave-1 do-now runs finished 46-102s with fully audited
// honest work (lane D), so the spec-era 120s production_duration_floor_ms pin
// now guarantees false O1_DURATION_FLOOR findings in every future campaign
// (the SFX-B un-deadened guard fires on any run finishing under the floor).
// This test pins the recalibration authoring contract:
//   * EXACTLY the four wave-1 do-now rows (W1.L1-python, W1.L1-ts,
//     W1.X1-ts, W1.M1-python) carry production_duration_floor_ms 30000;
//   * the same four rows carry production_duration_floor_basis with the
//     documented recalibration basis text (2026-08-24 measured baseline);
//   * NO other tier1 row carries production_duration_floor_basis (it is a
//     W1-do-now-recalibration-only field for now);
//   * every other row's floor pin is unchanged (W2.22 300000, W2.24 120000,
//     W3.01/02/03 300000, W3.04 600000, W3.17a/b 1200000, W3.18/19/21
//     120000, W3.23 60000) and the unpinned rows stay unpinned
//     (W1.L2/L3/REPLAY, W2.21/23a/23b/23c, W3.20, W3.22);
//   * case.schema.json declares production_duration_floor_basis as an
//     optional string (minLength 1, maxLength 512) so the manifest still
//     passes the production controller's additionalProperties:false schema;
//   * the production controller's --validate-only still accepts the
//     recalibrated manifest (28 cases).
//
// Confined to torture-test/. Zero tokens. No daemons, no launches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const controller = path.join(ttRoot, "bin", "tt-controller");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

const RECALIBRATION_BASIS =
  "2026-08-24: measured honest baseline 46-102s across campaign-8; floor 30s = margin below fastest honest run; spec-era 120s produced 4/4 false positives";

// The four wave-1 do-now rows this story recalibrates.
const W1_DO_NOW_IDS = ["W1.L1-python", "W1.L1-ts", "W1.X1-ts", "W1.M1-python"];

// Floors that must remain untouched (other waves / other workflow families).
const PINNED_FLOORS: Record<string, number> = {
  "W2.22-non-main-bfmw": 300000,
  "W2.24-docs-drift": 120000,
  "W3.01-bfmw-pi-python": 300000,
  "W3.02-bfmw-pi-ts": 300000,
  "W3.03-bfmw-hermes-ts": 300000,
  "W3.04-fdmw-pi-ts": 600000,
  "W3.17a-marathon-natural": 1200000,
  "W3.17b-marathon-chaos": 1200000,
  "W3.18-pause-no-drain": 120000,
  "W3.19-pause-drain": 120000,
  "W3.21-fail-force-resume": 120000,
  "W3.23-token-saver": 60000,
};

// Rows that must stay UNPINNED (no production_duration_floor_ms at all).
const UNPINNED_IDS = [
  "W1.L2-python",
  "W1.L2-ts",
  "W1.L3-python",
  "W1.L3-ts",
  "W1.REPLAY-python",
  "W1.REPLAY-ts",
  "W2.21-admission",
  "W2.23a-expects-regex",
  "W2.23b-retry-step",
  "W2.23c-missing-persona",
  "W3.20-cancel",
  "W3.22-daemon-restart",
];

function loadTier1(): Array<Record<string, any>> {
  return fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("TRIA US-006 — wave-1 do-now duration floor recalibration (120s -> 30s)", () => {
  it("exactly the four wave-1 do-now rows carry production_duration_floor_ms 30000", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    for (const id of W1_DO_NOW_IDS) {
      const record = byId.get(id);
      assert.ok(record, `${id} must be in tier1.jsonl`);
      assert.equal(record.production_duration_floor_ms, 30000, `${id}: floor must be 30000`);
    }
    const at30000 = cases.filter((record) => record.production_duration_floor_ms === 30000);
    assert.deepEqual(
      at30000.map((record) => record.id).sort(),
      [...W1_DO_NOW_IDS].sort(),
      "no row outside the four wave-1 do-now cases may carry floor 30000",
    );
  });

  it("the four wave-1 do-now rows carry the documented production_duration_floor_basis", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    for (const id of W1_DO_NOW_IDS) {
      const record = byId.get(id);
      assert.equal(record.production_duration_floor_basis, RECALIBRATION_BASIS, `${id}: basis text mismatch`);
    }
    const basisRows = cases.filter((record) => record.production_duration_floor_basis !== undefined);
    assert.deepEqual(
      basisRows.map((record) => record.id).sort(),
      [...W1_DO_NOW_IDS].sort(),
      "production_duration_floor_basis must appear ONLY on the four wave-1 do-now rows",
    );
  });

  it("every other row's floor pin is untouched and the unpinned rows stay unpinned", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    for (const [id, floor] of Object.entries(PINNED_FLOORS)) {
      const record = byId.get(id);
      assert.ok(record, `${id} must be in tier1.jsonl`);
      assert.equal(
        record.production_duration_floor_ms,
        floor,
        `${id}: floor must stay ${floor} (untouched by the W1 recalibration)`,
      );
    }
    for (const id of UNPINNED_IDS) {
      const record = byId.get(id);
      assert.ok(record, `${id} must be in tier1.jsonl`);
      assert.ok(
        !Object.hasOwn(record, "production_duration_floor_ms"),
        `${id}: must stay unpinned (no production_duration_floor_ms)`,
      );
    }
    // Every manifest row is accounted for by the three classes above.
    const accounted = new Set([
      ...W1_DO_NOW_IDS,
      ...Object.keys(PINNED_FLOORS),
      ...UNPINNED_IDS,
    ]);
    const unaccounted = cases.filter((record) => !accounted.has(record.id)).map((record) => record.id);
    assert.deepEqual(unaccounted, [], `every tier1 row must be covered: ${unaccounted.join(", ")}`);
  });

  it("case.schema.json declares production_duration_floor_basis as an optional bounded string", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.equal(schema.additionalProperties, false, "schema must stay fail-closed on unknown properties");
    const prop = schema.properties?.production_duration_floor_basis;
    assert.ok(prop, "case.schema.json must declare production_duration_floor_basis");
    assert.equal(prop.type, "string");
    assert.equal(prop.minLength, 1);
    assert.equal(prop.maxLength, 512);
    assert.ok(!(schema.required ?? []).includes("production_duration_floor_basis"), "the field must be optional");
  });

  it("tt-controller --validate-only accepts the recalibrated tier1 manifest (28 cases)", () => {
    const res = spawnSync(controller, ["--manifest", tier1Manifest, "--validate-only"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
