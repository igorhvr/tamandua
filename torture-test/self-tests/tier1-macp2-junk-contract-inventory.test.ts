// US-004 (MACP2) — junk-contract inventory regression: every site that
// asserts or relies on the synthetic __pycache__ junk is enumerated and
// proven grep-rendered, and no site still demands interpreter-generated
// in-tree __pycache__.
//
// MACP2 reclassified the python __pycache__ junk from "regenerated junk
// (content free to change)" to DETERMINISTIC SEEDED JUNK — a synthetic
// marker (`__pycache__/junk-probe.synthetic`) planted at provisioning
// with byte-exact recorded content, must stay untracked + byte-identical
// after runs (US-001..US-003; spec 02 §junk probes). This test pins the
// US-004 acceptance criteria with zero tokens:
//
//   AC1: spec 02 §junk probes describes the deterministic seeded junk
//        class (python __pycache__) — untracked + byte-identical, not
//        regenerated-with-free-content.
//   AC2: EVERY site that asserts or relies on the synthetic __pycache__
//        junk (builders, provisioning adapter, self-tests, docs) is
//        enumerated here and proven RENDERED by a repo grep over
//        torture-test/ excluding var/ (no phantom entries).
//   AC3: no tracked file under torture-test/ (excluding var/ and the
//        intentional decision/negative-assertion sites) still describes
//        __pycache__ as regenerated junk with content free to change or
//        demands interpreter-generated in-tree __pycache__.
//
// Zero tokens. Reads only files under torture-test/ (no state writes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const spec02 = path.join(ttRoot, "tamandua-torture-test-spec", "02-fixture-projects.md");

// ── Inventory of every site that asserts or relies on the synthetic
//    __pycache__ junk ────────────────────────────────────────────────
// Mirrors the E2.4 tier1-e24-junk-contract-inventory pattern: each entry
// is a path (relative to ttRoot) that a repo grep MUST render. Two
// logically-partitioned grep spaces cover the two token families:
//
//   CODE_GREP ("junk-probe.synthetic") — builders that seed + verify the
//     marker, the provisioning adapter that plants it, the self-tests
//     that pin the contract, and the MACP2 task doc.
//   DOC_GREP ("seeded/deterministic") — the docs that reclassify
//     __pycache__ as seeded/deterministic junk (untracked + byte-identical).
const CODE_GREP = "junk-probe.synthetic";
const DOC_GREP = "seeded/deterministic";

const CODE_SITES: string[] = [
  // Builders (seed the marker + assert present/untracked/byte-identical)
  "fixtures-src/tt-python/build-golden.sh",
  "fixtures-src/tt-python@master/build-golden.sh",
  "fixtures-src/tt-poly/build-golden.sh",
  "fixtures-src/tt-poly-lite/build-golden.sh",
  // Provisioning adapter (plants + verifies the marker in work clones)
  "bin/tt-fixture-provision.mjs",
  // Fixture e2e validator (seeds + asserts the marker in a scratch clone)
  "fixtures-src/tt-python/validate-e2e.sh",
  // Self-tests pinning the seeded-junk contract
  "self-tests/tier1-macp2-builder-junk-seeding.test.ts",
  "self-tests/tier1-macp2-poly-builder-junk-seeding.test.ts",
  "self-tests/tier1-macp2-provision-junk-seeding.test.ts",
  "self-tests/tier1-e24-all-fixture-provision.test.ts",
  "self-tests/tier1-fixture-provision.test.ts",
  "self-tests/tier1-controller-provisioning-wiring.test.ts",
  "self-tests/tt-poly-junk-probes.test.ts",
  "self-tests/tt-poly-end-to-end-verification.test.ts",
  "self-tests/tt-poly-lite-build-golden.test.ts",
  "self-tests/tt-poly-python-subtree.test.ts",
  "self-tests/tt-poly-structure.test.ts",
  // Task doc (MACP2 decision narrative)
  "impl-tasks/MACP2-pycache-junk-portability.md",
];

const DOC_SITES: string[] = [
  // Spec 02 (junk-probes classes + tt-python section)
  "tamandua-torture-test-spec/02-fixture-projects.md",
  // Spec 04 (W0.4 preflight junk invariants, all three classes)
  "tamandua-torture-test-spec/04-wave-0-preflight.md",
  // tt-python docs
  "fixtures-src/tt-python/README-JUNK.md",
  "fixtures-src/tt-python/JUNK-IS-INTENTIONAL.md",
  "fixtures-src/tt-python/FIXTURE.md",
  "fixtures-src/tt-python/.gitignore",
  // tt-poly docs
  "fixtures-src/tt-poly/README-JUNK.md",
  "fixtures-src/tt-poly/JUNK-IS-INTENTIONAL.md",
  "fixtures-src/tt-poly/README.md",
  "fixtures-src/tt-poly/.gitignore",
  "fixtures-src/tt-poly/python/FIXTURE.md",
  "fixtures-src/tt-poly/python/README-JUNK.md",
  "fixtures-src/tt-poly/python/.gitignore",
  // tt-poly-lite docs
  "fixtures-src/tt-poly-lite/README-JUNK.md",
  "fixtures-src/tt-poly-lite/JUNK-IS-INTENTIONAL.md",
  "fixtures-src/tt-poly-lite/README.md",
  "fixtures-src/tt-poly-lite/.gitignore",
  "fixtures-src/tt-poly-lite/python/FIXTURE.md",
  "fixtures-src/tt-poly-lite/python/.gitignore",
  // Case prompts describing provisioning junk
  "cases/tier1-traceability.md",
  "cases/tasks/tier2/W5.storm-capacity-scaled.md",
  // tt-go FIXTURE.md (compares Go's junk to python's seeded __pycache__)
  "fixtures-src/tt-go/FIXTURE.md",
];

const grepExcludes = ["var", "node_modules", ".git"];

function grepRender(token: string, caseInsensitive = false): string[] {
  const args = caseInsensitive ? ["-rlin", token, "."] : ["-rln", token, "."];
  for (const ex of grepExcludes) args.push("--exclude-dir", ex);
  const res = spawnSync("grep", args, { cwd: ttRoot, encoding: "utf8" });
  // grep exits 1 when nothing matches — not an error here.
  const out = (res.stdout ?? "").trim();
  if (!out) return [];
  return out.split("\n").map((l) => l.replace(/^\.\//, ""));
}

// Old-contract phrasings that must NEVER co-occur with __pycache__ outside
// the intentional decision/negative-assertion sites: they describe
// __pycache__ as regenerated junk with content free to change, or demand
// interpreter-generated in-tree __pycache__ (the Darwin-broken pattern).
const OLD_CONTRACT_LINE_RE = /\[ ! -d "__pycache__" \]|not found after test run|exists after test run|regenerated by `?pytest|content free to change|still generated by Python|regenerated junk probe|regenerates? `?__pycache__/;

// Intentional sites that legitimately contain old-contract phrasings:
//   * the MACP2 task doc documents the pre-fix behavior as history;
//   * the macp2 seeding self-tests assert the old phrasings are GONE from
//     the builders (they carry the strings as negative assertions);
//   * this inventory test itself carries the old phrasings as
//     negative-assertion literals (the regexes it asserts must not match).
const INTENTIONAL_OLD_PHRASING_SITES = [
  "impl-tasks/MACP2-pycache-junk-portability.md",
  "self-tests/tier1-macp2-builder-junk-seeding.test.ts",
  "self-tests/tier1-macp2-poly-builder-junk-seeding.test.ts",
  "self-tests/tier1-macp2-junk-contract-inventory.test.ts",
];

function trackedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "var" || ent.name === "node_modules" || ent.name === ".git") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(ttRoot, p));
    }
  };
  walk(ttRoot);
  return out;
}

describe("US-004 MACP2 junk-contract inventory (deterministic seeded __pycache__)", () => {
  it("AC1: spec 02 §junk probes describes the deterministic seeded junk class (python __pycache__)", () => {
    const raw = fs.readFileSync(spec02, "utf8");
    const text = raw.replace(/\n\s*/g, " ");
    assert.ok(
      /Junk probes, three classes/.test(raw) || /Junk probes, three classes/.test(text),
      "spec 02 §junk probes must enumerate three classes",
    );
    assert.ok(
      /deterministic seeded junk/.test(text) && /seeded\/deterministic/.test(text),
      "spec 02 must name the deterministic seeded junk class",
    );
    assert.ok(
      /`__pycache__` probe/.test(text),
      "spec 02 must tie the deterministic seeded class to the python __pycache__ probe",
    );
    assert.ok(
      /byte-identical/.test(text) && /untracked/.test(text),
      "spec 02 must require untracked + byte-identical for the seeded junk",
    );
    assert.ok(
      /sys\.pycache_prefix/.test(text),
      "spec 02 must cite Apple's pycache_prefix redirect (the Darwin reason for the fix)",
    );
  });

  it("AC2: inventory grep RENDERS every inventoried site (no phantom entries)", () => {
    const renderedCode = new Set(grepRender(CODE_GREP));
    // Doc grep is case-insensitive: docs write "Seeded/deterministic" in
    // table cells and "seeded/deterministic" in prose.
    const renderedDoc = new Set(grepRender(DOC_GREP, true));
    const missingCode = CODE_SITES.filter((s) => !renderedCode.has(s));
    const missingDoc = DOC_SITES.filter((s) => !renderedDoc.has(s));
    assert.deepEqual(
      missingCode,
      [],
      `code inventory references sites NOT rendered by grep "${CODE_GREP}": ${missingCode.join(", ")}`,
    );
    assert.deepEqual(
      missingDoc,
      [],
      `doc inventory references sites NOT rendered by grep "${DOC_GREP}": ${missingDoc.join(", ")}`,
    );
    // Sanity: both greps must actually render their families (guards against
    // a broken grep invocation silently returning empty).
    assert.ok(renderedCode.size > 0, "code grep must render at least one site");
    assert.ok(renderedDoc.size > 0, "doc grep must render at least one site");
  });

  it("AC3: no tracked file (excl. var/ + intentional sites) still describes __pycache__ as regenerated/free-content or demands interpreter-generated in-tree __pycache__", () => {
    const violations: string[] = [];
    for (const rel of trackedFiles()) {
      if (INTENTIONAL_OLD_PHRASING_SITES.includes(rel)) continue;
      const text = fs.readFileSync(path.join(ttRoot, rel), "utf8");
      if (!text.includes("__pycache__")) continue;
      for (const line of text.split("\n")) {
        if (!line.includes("__pycache__")) continue;
        if (OLD_CONTRACT_LINE_RE.test(line)) {
          violations.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `old-contract phrasings still co-occur with __pycache__:\n${violations.join("\n")}`,
    );
  });

  it("AC3 anchor: every python-bearing fixture builder seeds + verifies the marker (present/untracked/byte-identical), and no builder demands interpreter-generated __pycache__", () => {
    // Anchor the contract on the builders themselves: the seeded-marker
    // verification (not the interpreter-generated dir) is what every python
    // builder must assert. (US-001/US-003 already pin the exact seeding
    // mechanics; this keeps the inventory contract grounded in the builders.)
    const builders = [
      "fixtures-src/tt-python/build-golden.sh",
      "fixtures-src/tt-python@master/build-golden.sh",
      "fixtures-src/tt-poly/build-golden.sh",
      "fixtures-src/tt-poly-lite/build-golden.sh",
    ];
    for (const rel of builders) {
      const src = fs.readFileSync(path.join(ttRoot, rel), "utf8");
      assert.ok(
        src.includes("junk-probe.synthetic"),
        `${rel} must reference the synthetic marker`,
      );
      // The old interpreter-dependence check for __pycache__ is gone; the
      // ".pytest_cache/ not found after test run" phrasing (regenerated
      // junk) is legitimately retained and must not be confused with it.
      assert.ok(
        !/\[ ! -d "__pycache__" \]/.test(src) &&
          !src.includes('"✗ __pycache__/ not found after test run"'),
        `${rel} must not demand interpreter-generated in-tree __pycache__`,
      );
    }
  });
});
