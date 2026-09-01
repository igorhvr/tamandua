// Tier-2 US-001: S40 per-case boundary_files policy.
//
// Pins the S40 delta (2026-08-31): every tier2 row's `boundary_files` is the
// case's legitimate change surface — TIGHT to its task text — instead of the
// uniform `fixtures-src/<fixture>/src` prefix every row used before S40.
//
// What this file pins (zero tokens — pure file reads):
//   * AC1: every tier2 boundary entry resolves to an EXISTING path under
//     torture-test/ (the assertContainedExisting contract the tier0 manifest
//     test applies to tier0; applied here to the tier2 roster).
//   * AC2: W4.29-strict-gate-retry-finalize (security-audit-merge) includes
//     `fixtures-src/tt-ts/public` AND `fixtures-src/tt-ts/src` — the audit
//     fixes VULN-T1 in public/app.js and VULN-T2 in src/server.ts.
//   * AC3: W4.17-a / W4.17-b (tt-python, .venv/bin/pytest) include the
//     seeded `fixtures-src/tt-python/conftest.py` and the
//     `fixtures-src/tt-python/tests` tree.
//   * No boundary silently widened beyond its task text: every row's
//     boundary must equal its golden per-case value (the fixture default,
//     the local-case scenario path, or one of the S40 widened/tightened
//     values below), and every non-default entry must be justified by a
//     marker in the case's task file (or its context.test_cmd).
//   * The tier2-traceability.md S40 section exists (the policy + delta row).
//
// Confined to torture-test/. Zero tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");

type Case = Record<string, any>;

function readManifest(): Case[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// The assertContainedExisting contract from tier0-case-manifest.test.ts: a
// declared path must stay inside torture-test/ AND exist on disk.
function assertContainedExisting(relative: string, label: string): void {
  const resolved = path.resolve(ttRoot, relative);
  assert.ok(
    resolved === ttRoot || resolved.startsWith(`${ttRoot}${path.sep}`),
    `${label} escapes torture-test/: ${relative}`,
  );
  assert.ok(fs.existsSync(resolved), `${label} does not exist: ${relative}`);
}

// The fixture-default boundary: the boundary a row gets when its task
// surface is exactly the fixture's canonical source tree (tt-ts/tt-python
// have a src/ subtree; tt-go / tt-poly / tt-poly-lite are root-level or
// multi-subtree fixtures whose whole tree is the honest surface — see the
// traceability section for the per-fixture rationale).
const DEFAULT_BOUNDARY: Record<string, string[]> = {
  "tt-ts": ["fixtures-src/tt-ts/src"],
  "tt-python": ["fixtures-src/tt-python/src"],
  "tt-go": ["fixtures-src/tt-go"],
  "tt-poly": ["fixtures-src/tt-poly"],
  "tt-poly-lite": ["fixtures-src/tt-poly-lite"],
};

// The S40 delta rows (the ONLY rows whose boundary differs from the fixture
// default or the local-case scenario path). Each entry pins the exact
// boundary AND the task-text marker(s) that justify it — a boundary can
// never be silently widened beyond its task text without failing this pin.
const PER_CASE_BOUNDARY: Record<string, { boundary: string[]; justification: RegExp[] }> = {
  // security-audit-merge: fixes VULN-T1 in public/app.js + VULN-T2 in
  // src/server.ts — the mandated widening to the tt-ts public/ subtree.
  "W4.29-strict-gate-retry-finalize": {
    boundary: ["fixtures-src/tt-ts/public", "fixtures-src/tt-ts/src"],
    justification: [/public\/app\.js/, /src\/server\.ts/],
  },
  // tt-python pytest rows: the seeded conftest.py + tests/ tree are part of
  // the task surface (red-baseline arming plants pre-existing red tests
  // there; the regression test is written there). The pytest marker comes
  // from context.test_cmd (".venv/bin/pytest -q"); the red-tests marker
  // from the task text.
  "W4.17-a-red-baseline-land-annotated": {
    boundary: ["fixtures-src/tt-python/src", "fixtures-src/tt-python/conftest.py", "fixtures-src/tt-python/tests"],
    justification: [/pytest/, /pre-existing red tests/],
  },
  "W4.17-b-red-baseline-refuse": {
    boundary: ["fixtures-src/tt-python/src", "fixtures-src/tt-python/conftest.py", "fixtures-src/tt-python/tests"],
    justification: [/pytest/, /pre-existing red tests/],
  },
  // tt-poly rows whose defect is in the ts/ subtree (POLY-BUG-T1/T2): the
  // change surface is ts/, not the whole five-language fixture.
  "W4.05-slow-suite-contention": {
    boundary: ["fixtures-src/tt-poly/ts"],
    justification: [/ts\/src\/store\.ts/],
  },
  // NOTE: W4.39-a-union-honest is deliberately NOT here — it keeps the
  // fixture-default whole-fixture boundary (["fixtures-src/tt-poly"]). It is
  // the SCRIPTED arm (harness scripted-pi): the scripted corridor runs a
  // scratch fixture whose honest change surface is the fixture ROOT (the
  // canned fixer lands a root-level `value.txt` — the 'deterministic fixture
  // value' correction), so a ts/-only boundary makes O8 flag the corridor's
  // own landing (O8_NEW_OUTSIDE_ALLOWED_DIRECTORIES on value.txt). The
  // real-arm tightening applies only to W4.39-b-union-dishonest (the
  // ts/src/store.ts + ts/src/server.ts fix) and W4.05.
  "W4.39-b-union-dishonest": {
    boundary: ["fixtures-src/tt-poly/ts"],
    justification: [/server\+store/, /ts\//],
  },
  // Wave-5 storm: the capacity-scaled anchor's task areas live in the
  // python/ and ts/ subtrees of tt-poly-lite.
  "W5.storm-capacity-scaled": {
    boundary: ["fixtures-src/tt-poly-lite/python", "fixtures-src/tt-poly-lite/ts"],
    justification: [/schedlib-poly/, /expense-tracker-poly/],
  },
};

function taskText(record: Case): string {
  const taskPath = path.join(ttRoot, record.task);
  return fs.readFileSync(taskPath, "utf8");
}

describe("Tier-2 S40 per-case boundary_files policy", () => {
  it("AC1: every tier2 boundary entry resolves to an existing path under torture-test/", () => {
    const rows = readManifest();
    assert.equal(rows.length, 70, "tier2.jsonl must keep 70 rows");
    for (const record of rows) {
      assert.ok(Array.isArray(record.boundary_files) && record.boundary_files.length > 0,
        `${record.id} must declare a nonempty boundary_files list`);
      assert.equal(new Set(record.boundary_files).size, record.boundary_files.length,
        `${record.id} boundary_files must not contain duplicates`);
      for (const boundary of record.boundary_files) {
        assertContainedExisting(boundary, `${record.id} boundary`);
      }
    }
  });

  it("AC2: W4.29 (security-audit-merge) includes the public/ + src/ audit surface", () => {
    const w429 = readManifest().find((record) => record.id === "W4.29-strict-gate-retry-finalize");
    assert.ok(w429, "W4.29 must exist in tier2.jsonl");
    assert.ok(w429.boundary_files.includes("fixtures-src/tt-ts/public"),
      "W4.29 boundary must include fixtures-src/tt-ts/public (VULN-T1 in public/app.js)");
    assert.ok(w429.boundary_files.includes("fixtures-src/tt-ts/src"),
      "W4.29 boundary must include fixtures-src/tt-ts/src (VULN-T2 in src/server.ts)");
  });

  it("AC3: each tt-python red-baseline case includes its seeded conftest/test paths", () => {
    const rows = readManifest();
    for (const id of ["W4.17-a-red-baseline-land-annotated", "W4.17-b-red-baseline-refuse"]) {
      const record = rows.find((r) => r.id === id);
      assert.ok(record, `${id} must exist in tier2.jsonl`);
      assert.ok(record.boundary_files.includes("fixtures-src/tt-python/conftest.py"),
        `${id} boundary must include the seeded fixtures-src/tt-python/conftest.py`);
      assert.ok(record.boundary_files.includes("fixtures-src/tt-python/tests"),
        `${id} boundary must include the seeded fixtures-src/tt-python/tests tree`);
      assert.ok(record.boundary_files.includes("fixtures-src/tt-python/src"),
        `${id} boundary must keep fixtures-src/tt-python/src (the fix surface)`);
    }
  });

  it("no boundary silently widened beyond its task text (golden per-case map)", () => {
    const rows = readManifest();
    for (const record of rows) {
      const expected = PER_CASE_BOUNDARY[record.id]?.boundary
        ?? (record.harness === "local" ? [record.context.scenario_path] : DEFAULT_BOUNDARY[record.fixture]);
      assert.ok(expected !== undefined,
        `${record.id} has no golden boundary: fixture ${record.fixture} / harness ${record.harness} is not covered by the policy`);
      assert.deepEqual(
        record.boundary_files,
        expected,
        `${record.id} boundary_files drifted from the S40 per-case policy ` +
          `(expected ${JSON.stringify(expected)}); any boundary change must update ` +
          `self-tests/tier2-s40-boundary-policy.test.ts + the traceability S40 section`,
      );
    }
  });

  it("every non-default boundary is justified by its task text (or test_cmd)", () => {
    const rows = readManifest();
    for (const record of rows) {
      const golden = PER_CASE_BOUNDARY[record.id];
      if (golden === undefined) continue;
      const searchable = `${taskText(record)}\n${JSON.stringify(record.context ?? {})}`;
      for (const regex of golden.justification) {
        assert.match(searchable, regex,
          `${record.id} boundary ${JSON.stringify(record.boundary_files)} lacks task-text justification for ${regex}`);
      }
    }
  });

  it("local-command rows keep their scenario-path boundaries", () => {
    const rows = readManifest();
    const local = rows.filter((record) => record.harness === "local");
    assert.equal(local.length, 14, "tier2 must keep 14 local-command rows");
    for (const record of local) {
      assert.ok(record.context.scenario_path.startsWith("scenarios/"),
        `${record.id} scenario_path must be scenario-relative`);
      assert.deepEqual(record.boundary_files, [record.context.scenario_path],
        `${record.id} boundary must equal its scenario path`);
    }
  });

  it("tier2-traceability.md documents the S40 per-case boundary policy", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## S40 per-case boundary_files delta/,
      "traceability must carry the S40 per-case boundary policy section");
    assert.match(trace, /public\/app\.js/,
      "the S40 section must name the security-audit public/ widening");
    assert.match(trace, /conftest-seeded|conftest\.py/,
      "the S40 section must name the conftest-seeded widening");
  });
});
