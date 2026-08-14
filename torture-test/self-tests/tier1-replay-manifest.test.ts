// US-004 — replay-pair declaration on the two REPLAY manifest lines (S9
// authoring).
//
// TSTX's origin-scoped contract (spec 05 cross-cutting "TSTX cross-run
// replay": relaunch W1.L2 with unchanged trees, suites must replay with
// TAMANDUA-TEST CACHED / ledger row reuse; spec 08 W4.28: ledger rows
// keyed per origin_repo, zero cross-repo replay) requires every REPLAY
// case to be bound to its paired probe case. This test pins the
// authoring contract:
//   * W1.REPLAY-python carries context.replay_of === "W1.L2-python" and
//     W1.REPLAY-ts carries context.replay_of === "W1.L2-ts";
//   * ONLY the two REPLAY lines carry replay_of — no other tier1 line
//     may declare it (pairing is a REPLAY-case-only field);
//   * each replay_of target resolves to an existing manifest case that
//     is NOT itself a replay case, and shares the same fixture +
//     workflow as its replay case (same-origin pairing is reachable);
//   * case.schema.json documents context.replay_of as an optional,
//     pattern-constrained string, and the PRODUCTION validator enforces
//     it (malformed replay_of values are rejected fail-closed);
//   * the replay_of contract (same origin/tree, sequenced after pair,
//     cache-HIT assertion) is documented in tier1-traceability.md;
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
const traceabilityDoc = path.join(ttRoot, "cases", "tier1-traceability.md");
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

// Build a single-case manifest under torture-test/var with a replay_of
// override applied to a copy of the first tier1 record.
function buildCaseManifest(replayOfOverride: { present: boolean; value: unknown }): string {
  const dir = fs.mkdtempSync(path.join(ttRoot, "var", "replay-manifest-"));
  const base = JSON.parse(
    fs.readFileSync(tier1Manifest, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0],
  );
  if (replayOfOverride.present) {
    base.context = { ...base.context, replay_of: replayOfOverride.value };
  }
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

describe("tier1 replay-pair manifest wiring (US-004 / S9 authoring)", () => {
  it("W1.REPLAY-python and W1.REPLAY-ts each carry the correct context.replay_of pair id", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    const replayPython = byId.get("W1.REPLAY-python");
    const replayTs = byId.get("W1.REPLAY-ts");
    assert.ok(replayPython, "W1.REPLAY-python must be in tier1.jsonl");
    assert.ok(replayTs, "W1.REPLAY-ts must be in tier1.jsonl");
    assert.equal(replayPython.context?.replay_of, "W1.L2-python");
    assert.equal(replayTs.context?.replay_of, "W1.L2-ts");
  });

  it("ONLY the two REPLAY lines carry context.replay_of", () => {
    const cases = loadTier1();
    const carriers = cases.filter((record) => Object.hasOwn(record.context ?? {}, "replay_of"));
    const carrierIds = carriers.map((record) => record.id).sort();
    assert.deepEqual(carrierIds, ["W1.REPLAY-python", "W1.REPLAY-ts"]);
  });

  it("each replay_of target resolves to an existing, non-replay case sharing the pair's fixture and workflow", () => {
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));
    for (const replayId of ["W1.REPLAY-python", "W1.REPLAY-ts"]) {
      const replay = byId.get(replayId)!;
      const pairId = replay.context.replay_of as string;
      const pair = byId.get(pairId);
      assert.ok(pair, `${replayId}: replay_of target ${pairId} must exist in tier1.jsonl`);
      assert.ok(
        !Object.hasOwn(pair.context ?? {}, "replay_of"),
        `${replayId}: pair ${pairId} must not itself be a replay case (no replay chains)`,
      );
      assert.equal(
        pair.fixture,
        replay.fixture,
        `${replayId}: pair ${pairId} fixture ${pair.fixture} must equal the replay fixture — same origin_repo is only reachable from the same fixture`,
      );
      assert.equal(
        pair.workflow,
        replay.workflow,
        `${replayId}: pair ${pairId} workflow ${pair.workflow} must equal the replay workflow`,
      );
    }
  });

  it("case.schema.json documents context.replay_of as an optional pattern-constrained string", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const context = schema.properties?.context;
    assert.ok(context, "schema must define a top-level context property");
    // Context remains an OPEN object (no additionalProperties:false), so
    // authoring replay_of requires no schema widening — only documentation.
    assert.notEqual(context.additionalProperties, false, "context must stay an open object");
    const replayOf = context.properties?.replay_of;
    assert.ok(replayOf, "context.properties must document replay_of");
    assert.equal(replayOf.type, "string");
    assert.equal(replayOf.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]*$", "replay_of must carry the case-id pattern");
    assert.match(replayOf.description ?? "", /reuse its pair/);
  });

  it("the production validator enforces the replay_of contract (malformed values rejected fail-closed)", () => {
    // Valid string value: accepted.
    for (const value of ["W1.L2-python", "W1.L2-ts"]) {
      const manifest = buildCaseManifest({ present: true, value });
      try {
        const res = runValidate(manifest);
        assert.equal(
          res.status,
          0,
          `replay_of ${JSON.stringify(value)} must validate:\n${res.stdout}${res.stderr}`,
        );
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
    // Malformed values: rejected, and the rejection names the field.
    for (const value of ["bad id!", "~W1.L2", 42, ["W1.L2-python"], { id: "W1.L2-python" }]) {
      const manifest = buildCaseManifest({ present: true, value });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `replay_of ${JSON.stringify(value)} must be REJECTED`);
        assert.match(
          res.stdout + res.stderr,
          /replay_of/,
          "rejection must name the replay_of field",
        );
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
    // Absent replay_of (the other 26 lines): accepted.
    const absent = buildCaseManifest({ present: false, value: undefined });
    try {
      const res = runValidate(absent);
      assert.equal(res.status, 0, `replay_of-absent manifest must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(path.dirname(absent), { recursive: true, force: true });
    }
  });

  it("tier1-traceability.md documents the replay_of contract (same origin/tree, sequenced after pair, cache-HIT assertion)", () => {
    assert.ok(fs.existsSync(traceabilityDoc), "cases/tier1-traceability.md must exist");
    const doc = fs.readFileSync(traceabilityDoc, "utf8");
    assert.match(doc, /replay_of/, "doc must name the replay_of field");
    assert.match(doc, /origin_repo/, "contract must pin the origin-scoped identity (origin_repo)");
    assert.match(doc, /reuse its pair's work\s+clone/, "contract must require reusing the pair's work clone");
    assert.match(doc, /pair reaches terminal/, "contract must require sequencing after the pair reaches terminal");
    assert.match(doc, /lookup->cache_hit/, "contract must require the shim cache-HIT assertion");
    assert.match(doc, /replay-cache-miss/, "contract must name the miss finding (never a silent PASS)");
  });

  it("tt-controller --validate-only accepts the replay-paired tier1 manifest (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
