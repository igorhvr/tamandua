// US-001 — E2.4 canonical junk-probe contract: decision doc + site inventory.
//
// This test pins the canonical UNTRACKED-in-clone decision and the site
// inventory grounded in real greppable sites. Since US-002 flipped the five
// B1 builders to EXCLUDE operator-notes.local (the canonical contract), the
// AC3-anchor check now asserts EVERY fixture builder excludes it — the pre-fix
// snapshot (B1 "lacked the exclusion") is obsolete. This test:
//
//   * AC1/AC2: asserts the E2.4 resolution-decision section exists in the task doc
//     (`torture-test/impl-tasks/E2.4-junk-probe-provisioning-contract.md`) and
//     concludes the canonical inert-junk contract is UNTRACKED-IN-CLONE with an
//     explicit citation to spec 02 §junk probes.
//   * AC3/AC5: re-runs the inventory grep (`grep -rn "operator-notes"` over
//     torture-test/, excluding generated `var/`) and asserts that EVERY site the
//     inventory enumerates is actually RENDERED by that grep — i.e. the inventory
//     is grounded in real, greppable sites (no phantom entries).
//   * AC3-anchor (post-US-002): asserts EVERY fixture build-golden.sh now contains
//     the `--exclude='operator-notes.local'` rule — no tracked-path golden remains.
//
// Zero tokens. Reads only files under torture-test/ (no state writes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const e24Doc = path.join(ttRoot, "impl-tasks", "E2.4-junk-probe-provisioning-contract.md");

// ── Inventory of every site that asserts or relies on operator-notes.local ──
// Mirrors the "E2.4 resolution — US-001 decision" inventory in the task doc.
// Each entry is a path (relative to ttRoot) that the grep below MUST render.
// Grouped by inventory section B1 (tracked, to flip), B2 (guard, keep),
// B3 (self-tests, keep), B4 (source-content/docs, untracked). B5 (hashes) is
// generated under var/ and deliberately not grep-rendered here (var/ is excluded).
const INVENTORIED_SITES: string[] = [
  // B1 — golden builders that currently COMMIT it (TRACKED → must flip in US-002)
  "fixtures-src/tt-java/build-golden.sh",
  "fixtures-src/tt-ts/build-golden.sh",
  "fixtures-src/tt-poly/build-golden.sh",
  "fixtures-src/tt-poly-lite/build-golden.sh",
  "fixtures-src/tt-python@master/build-golden.sh",
  // Already-correct builders (exclude) — reference pattern for US-002
  "fixtures-src/tt-python/build-golden.sh",
  "fixtures-src/tt-go/build-golden.sh",
  "fixtures-src/tt-rust/build-golden.sh",
  // B2 — provisioning guard / fail-closed oracle (KEEP, never weaken)
  "bin/tt-fixture-provision.mjs",
  // B3 — self-tests asserting the UNTRACKED (correct) side (KEEP green)
  "self-tests/tier1-fixture-provision.test.ts",
  "self-tests/tier1-controller-provisioning-wiring.test.ts",
  // B4 — source-content tests that READ fixtures-src (not golden tracking)
  "self-tests/tt-poly-junk-probes.test.ts",
  "self-tests/tt-poly-go-subtree.test.ts",
  "self-tests/tt-poly-java-subtree.test.ts",
  "self-tests/tt-poly-rust-subtree.test.ts",
  "self-tests/tt-poly-python-subtree.test.ts",
  "self-tests/tt-poly-ts-subtree.test.ts",
];

// Logically-partitioned grep spaces, so we can prove "renders the listed sites"
// while never touching generated state (var/) or the inventory doc itself.
const grepExcludes = ["var", "node_modules", ".git"];

function grepOperatorNotes(): string[] {
  const args = ["-rln", "operator-notes", "."];
  for (const ex of grepExcludes) args.push("--exclude-dir", ex);
  const res = spawnSync("grep", args, { cwd: ttRoot, encoding: "utf8" });
  // grep exits 1 when nothing matches — not an error here.
  const out = (res.stdout ?? "").trim();
  if (!out) return [];
  return out.split("\n").map((l) => l.replace(/^\.\//, ""));
}

describe("US-001 E2.4 canonical junk-probe contract decision + inventory", () => {
  it("AC1: E2.4 resolution-decision section exists committed under torture-test/", () => {
    assert.ok(fs.existsSync(e24Doc), `decision doc missing: ${e24Doc}`);
    const text = fs.readFileSync(e24Doc, "utf8");
    assert.ok(
      text.includes("E2.4 resolution decision") &&
        text.includes("canonical inert-junk contract"),
      "decision section header must exist in the E2.4 doc",
    );
    assert.ok(
      text.includes("E2.4 resolution decision"),
      "E2.4 resolution-decision heading (task deliverable wording) must be present",
    );
    assert.match(text, /US-001/, "decision authored under US-001");
  });

  it("AC2: decision concludes UNTRACKED-in-clone with explicit spec-02 citation", () => {
    const raw = fs.readFileSync(e24Doc, "utf8");
    // Normalize markdown blockquote continuations before asserting prose ("must
    // stay untracked" / "planted at instantiation" are split across "\n> " lines
    // in the verbatim spec quote).
    const text = raw.replace(/\n\s*>\s?/g, " ");
    assert.ok(
      /UNTRACKED-IN-CLONE|untracked-in-clone/.test(text),
      "decision must conclude untracked-in-clone is canonical",
    );
    assert.ok(
      /02-fixture-projects\.md/.test(text),
      "decision must cite spec 02 §junk probes explicitly",
    );
    assert.ok(
      text.includes("must stay untracked") &&
        text.includes("planted at instantiation"),
      "decision must quote the spec's inert-junk mandate",
    );
  });

  it("AC3/AC5: inventory grep RENDERS every inventoried site (no phantom entries)", () => {
    const rendered = grepOperatorNotes();
    assert.ok(
      rendered.length >= INVENTORIED_SITES.length,
      `grep rendered ${rendered.length} sites but inventory lists ${INVENTORIED_SITES.length}`,
    );
    const renderedSet = new Set(rendered);
    const missing = INVENTORIED_SITES.filter((s) => !renderedSet.has(s));
    assert.deepEqual(
      missing,
      [],
      `inventory references sites NOT rendered by grep (remove or fix inventory): ${missing.join(", ")}`,
    );
  });

  it("AC3 anchor check: EVERY fixture builder excludes operator-notes.local (post-US-002)", () => {
    // After US-002 the flip is complete: all eight builders (the five former
    // B1 tracked builders AND the three already-correct ones) must contain an
    // operator-notes.local tar/rsync exclusion. Any builder missing it means a
    // tracked-path golden remains — a regression of the canonical contract.
    const builders = [
      "fixtures-src/tt-java/build-golden.sh",
      "fixtures-src/tt-ts/build-golden.sh",
      "fixtures-src/tt-poly/build-golden.sh",
      "fixtures-src/tt-poly-lite/build-golden.sh",
      "fixtures-src/tt-python@master/build-golden.sh",
      "fixtures-src/tt-python/build-golden.sh",
      "fixtures-src/tt-go/build-golden.sh",
      "fixtures-src/tt-rust/build-golden.sh",
    ];
    for (const rel of builders) {
      const src = fs.readFileSync(path.join(ttRoot, rel), "utf8");
      assert.ok(
        /--exclude\s*=\s*['"]operator-notes\.local['"]/.test(src) ||
          /--exclude\s*=operator-notes\.local/.test(src),
        `${rel} must exclude operator-notes.local from the golden commit (canonical untracked contract)`,
      );
    }
  });
});
