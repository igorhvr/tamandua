// US-001 — seed-ref support in the case manifest schema and validation.
//
// Real-case fixture provisioning reproduces each case's exact starting tree by
// checking a working clone out onto a seed git ref (green base + exactly one
// seeded defect, per spec 02-fixture-projects.md). The `seed` manifest field
// carries that ref NAME and must be strictly validated so the provisioning
// adapter never receives a malformed ref. This test pins the schema contract:
//   * `seed` is OPTIONAL and NULLABLE (absent or null = provision green base);
//   * a non-null `seed` must match the ref-name regex (no bad characters);
//   * every real tier1 manifest (with and without seed present) still
//     validates through the PRODUCTION controller's --validate-only path;
//   * an invalid ref name is REJECTED fail-closed.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");

const REF_NAME_PATTERN = "^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$";

// Valid ref-name spellings the seed field must accept.
const VALID_SEEDS = ["BUG-P1", "seed/storm", "broken-tests", "v1.2.3", "feature/foo-bar", "main"];
// Bad-character ref names the schema must REJECT (fail-closed).
const INVALID_SEEDS = ["BUG:1", "BUG P1", "~BUG", "BUG^", "BUG?", "BUG*", "BUG[1]", "BUG\\1", "BUG/", "BUG."];

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Build a single-case manifest with 28 full case fields under a temp dir
// inside torture-test/var (the controller refuses manifests that escape
// torture-test/). The base case is a copy of the first tier1 record; a seed
// override is applied only when requested (absent otherwise).
function buildCaseManifest(seedOverride: { present: boolean; value: unknown }): string {
  const dir = fs.mkdtempSync(path.join(ttRoot, "var", "seed-schema-"));
  const base = JSON.parse(fs.readFileSync(tier1Manifest, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0]);
  if (seedOverride.present) base.seed = seedOverride.value;
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

describe("Manifest seed schema validation (US-001)", () => {
  it("case.schema.json defines an optional, nullable 'seed' with a ref-name pattern", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.ok(schema.properties?.seed, "schema must define a top-level seed property");
    const seed = schema.properties.seed;
    assert.ok(Array.isArray(seed.anyOf), "seed must be nullable via anyOf(null, string)");
    const strings = seed.anyOf.filter((arm: any) => arm.type === "string");
    assert.equal(strings.length, 1, "seed must have exactly one string alternative");
    assert.equal(strings[0].pattern, REF_NAME_PATTERN, "seed string alternative must carry the ref-name regex");
    const nulls = seed.anyOf.filter((arm: any) => arm.type === "null");
    assert.equal(nulls.length, 1, "seed must have a null alternative");
    // Optional: it must NOT be in the required array.
    assert.ok(!schema.required.includes("seed"), "seed must not be a required field");
  });

  it("accepts manifests with valid seed values (including null) and without seed", () => {
    // No seed field present at all (vanilla real manifest).
    const noSeed = runValidate(tier1Manifest);
    assert.equal(noSeed.status, 0, `vanilla tier1 manifest must validate:\n${noSeed.stdout}${noSeed.stderr}`);
    assert.match(noSeed.stdout, /Validated 28 case\(s\)/);

    for (const seed of [...VALID_SEEDS, null]) {
      const manifest = buildCaseManifest({ present: true, value: seed });
      try {
        const res = runValidate(manifest);
        assert.equal(res.status, 0, `seed ${JSON.stringify(seed)} must validate:\n${res.stdout}${res.stderr}`);
        assert.match(res.stdout, /Validated 1 case\(s\)/);
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("rejects manifests with an invalid seed ref name (bad characters)", () => {
    for (const seed of INVALID_SEEDS) {
      const manifest = buildCaseManifest({ present: true, value: seed });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `seed ${JSON.stringify(seed)} must be REJECTED`);
        assert.match(res.stdout + res.stderr, /seed/, "rejection must name the seed field");
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("rejects non-string, non-null seed types", () => {
    for (const bad of [42, ["BUG-P1"], { ref: "BUG-P1" }, true]) {
      const manifest = buildCaseManifest({ present: true, value: bad });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `seed of type ${JSON.stringify(bad)} must be REJECTED`);
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });
});
