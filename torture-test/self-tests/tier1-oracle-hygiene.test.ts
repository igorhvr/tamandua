// E3.C US-011 — Declared-oracle hygiene gate.
//
// Campaign #7 (S3/S4) found oracles O16/O4 declared in the W3.0x manifests
// with NO executables — every lifecycle case and chaos marathon produced
// ORACLE_MISSING verdicts and ~2.6M tokens bought zero lifecycle coverage.
// E3.C closed the gap (US-009: O16 executable; US-010: O4 executable).
// This test pins the hygiene invariant FOREVER: every oracle id declared in
// ANY case manifest (tier1, tier0, cases, smoke) must resolve to an
// executable regular non-symlink file under torture-test/oracles/ — a
// declared-but-missing oracle is a hard failure, never a silent ORACLE_MISSING.
//
// Confined to torture-test/. Zero tokens. No daemons, no launches.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const casesDir = path.join(ttRoot, "cases");
const oraclesDir = path.join(ttRoot, "oracles");

// Every case manifest under torture-test/cases/ (new manifests are picked up
// automatically by the glob; smoke.jsonl declares no oracles and is included
// for completeness).
function declaredOracleIds(): Map<string, Set<string>> {
  const byManifest = new Map<string, Set<string>>();
  const files = fs
    .readdirSync(casesDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  assert.ok(files.length >= 4, `expected at least the four canonical manifests, got: ${files.join(", ")}`);
  for (const file of files) {
    const ids = new Set<string>();
    for (const line of fs.readFileSync(path.join(casesDir, file), "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line);
      assert.ok(record.id, `${file}: case record missing id`);
      assert.ok(Array.isArray(record.oracles), `${file}:${record.id}: oracles must be an array`);
      for (const oracle of record.oracles) {
        assert.equal(typeof oracle, "string", `${file}:${record.id}: oracle id must be a string`);
        ids.add(oracle);
      }
    }
    byManifest.set(file, ids);
  }
  return byManifest;
}

function assertOracleExecutable(oracleId: string, declaredIn: string): void {
  const executable = path.join(oraclesDir, oracleId);
  assert.ok(fs.existsSync(executable),
    `${declaredIn}: declared oracle ${oracleId} has NO executable at torture-test/oracles/${oracleId} — a declared-but-missing oracle must never remain`);
  const details = fs.lstatSync(executable);
  assert.ok(details.isFile() && !details.isSymbolicLink(),
    `${declaredIn}: oracle ${oracleId} must be a regular non-symlink file (got ${details.isSymbolicLink() ? "symlink" : "non-file"})`);
  fs.accessSync(executable, fs.constants.X_OK);
}

describe("E3.C US-011 declared-oracle hygiene", () => {
  it("every oracle id declared in any cases/*.jsonl resolves to an executable under torture-test/oracles/", () => {
    const byManifest = declaredOracleIds();
    const allIds = new Set<string>();
    for (const [manifest, ids] of byManifest) {
      for (const id of ids) {
        allIds.add(id);
        assertOracleExecutable(id, manifest);
      }
    }

    // The E3.C gating set is fully implemented — no declared-but-missing
    // oracle may remain (campaign #7's S3/S4 defect).
    for (const id of ["O1", "O2", "O3z", "O4", "O8", "O9", "O10", "O11", "O16"]) {
      assert.ok(allIds.has(id), `the spec-03 gating oracle ${id} must be declared by at least one manifest`);
    }
  });

  it("the declared set is exactly the E3.C gating set (no undeclared surprises, no stragglers)", () => {
    const byManifest = declaredOracleIds();
    const allIds = new Set<string>();
    for (const ids of byManifest.values()) {
      for (const id of ids) allIds.add(id);
    }
    assert.deepEqual([...allIds].sort(), ["O1", "O10", "O11", "O16", "O2", "O3z", "O4", "O8", "O9"],
      "the union of declared oracle ids must be exactly the nine implemented oracles");
  });
});
