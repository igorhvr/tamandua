// US-009 — token-saver paired-launch signal on the W3.23 manifest line (S12
// authoring).
//
// The W3.23-token-saver lifecycle probe (spec 07-wave-3 §W3.23: a real
// do-now launch with --no-hurry-please-save-tokens-mode against the managed
// pi-token-saver stub on the contained daemon's PATH, plus a control run
// without either) is marked in the manifest by a controller-internal signal.
// This test pins the authoring contract:
//   * W3.23-token-saver carries context.token_saver_control === true;
//   * ONLY the W3.23 line carries token_saver_control — no other tier1 line
//     may declare it (the paired-launch adapter is a W3.23-only behavior);
//   * case.schema.json documents context.token_saver_control as an optional
//     boolean, and the PRODUCTION validator enforces it (non-boolean values
//     are rejected fail-closed); context stays an OPEN object;
//   * the production controller's --validate-only still accepts the
//     manifest (28 cases).
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

function loadTier1(): Record<string, any>[] {
  return fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Build a single-case manifest under torture-test/var with a
// token_saver_control override applied to a copy of the first tier1 record.
function buildCaseManifest(override: { present: boolean; value: unknown }): string {
  const dir = fs.mkdtempSync(path.join(ttRoot, "var", "token-saver-manifest-"));
  const base = JSON.parse(
    fs.readFileSync(tier1Manifest, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0],
  );
  if (override.present) {
    base.context = { ...base.context, token_saver_control: override.value };
  }
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

describe("tier1 token-saver manifest signal (US-009 / S12 authoring)", () => {
  it("W3.23-token-saver carries context.token_saver_control === true", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    const w323 = byId.get("W3.23-token-saver");
    assert.ok(w323, "W3.23-token-saver must be in tier1.jsonl");
    assert.equal(w323.context?.token_saver_control, true);
    assert.equal(w323.context?.execution_mode, "real", "the signal does not change the real execution mode");
  });

  it("ONLY the W3.23 line carries context.token_saver_control", () => {
    const cases = loadTier1();
    const carriers = cases.filter((record) =>
      Object.hasOwn(record.context ?? {}, "token_saver_control"),
    );
    const carrierIds = carriers.map((record) => record.id).sort();
    assert.deepEqual(carrierIds, ["W3.23-token-saver"]);
  });

  it("case.schema.json documents context.token_saver_control as an optional boolean", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const context = schema.properties?.context;
    assert.ok(context, "schema must define a top-level context property");
    // Context remains an OPEN object (no additionalProperties:false), so
    // authoring token_saver_control requires no schema widening — only
    // documentation + type pinning.
    assert.notEqual(context.additionalProperties, false, "context must stay an open object");
    const signal = context.properties?.token_saver_control;
    assert.ok(signal, "context.properties must document token_saver_control");
    assert.equal(signal.type, "boolean");
    assert.match(signal.description ?? "", /W3\.23-token-saver/);
    assert.match(signal.description ?? "", /no-hurry-please-save-tokens-mode/);
    assert.match(signal.description ?? "", /control run/);
    assert.match(signal.description ?? "", /exclude it from --context passthrough/);
  });

  it("the production validator enforces the boolean type (non-boolean values rejected fail-closed)", () => {
    // Valid boolean values: accepted.
    for (const value of [true, false]) {
      const manifest = buildCaseManifest({ present: true, value });
      try {
        const res = runValidate(manifest);
        assert.equal(
          res.status,
          0,
          `token_saver_control ${JSON.stringify(value)} must validate:\n${res.stdout}${res.stderr}`,
        );
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
    // Non-boolean values: rejected, and the rejection names the field.
    for (const value of ["true", 1, ["yes"], { enabled: true }]) {
      const manifest = buildCaseManifest({ present: true, value });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `token_saver_control ${JSON.stringify(value)} must be REJECTED`);
        assert.match(
          res.stdout + res.stderr,
          /token_saver_control/,
          "rejection must name the token_saver_control field",
        );
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
    // Absent token_saver_control (the other 27 lines): accepted.
    const absent = buildCaseManifest({ present: false, value: undefined });
    try {
      const res = runValidate(absent);
      assert.equal(res.status, 0, `token_saver_control-absent manifest must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(path.dirname(absent), { recursive: true, force: true });
    }
  });

  it("tt-controller --validate-only accepts the token-saver-signaled tier1 manifest (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
