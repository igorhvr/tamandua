// US-016 — Tier-2 traceability completeness: zero silent trims.
//
// The read-only half of the Tier-2 acceptance battery (the campaign half —
// repeatability GREEN x2, dry-run argv, tier1 no-regression — lives in
// tier2-repeatability.test.ts). Pins, entirely mechanically:
//
//   * every case id in cases/tier2.jsonl has a traceability row in
//     cases/tier2-traceability.md (a `| <id> |` case-map row), and every
//     row carries a spec_ref into the wave spec;
//   * every spec'd W4 scenario (extracted from the wave-4 spec's own
//     scenario tables) is covered by cases/tier2.jsonl, the tier0 library
//     (w4.25 / w4.35 / w4.49 — referenced, never duplicated), or an
//     "Excluded Scenarios" enumeration row with an explicit reason — zero
//     silent trims;
//   * the wave-5 storm (spec 09) is authored as W5.storm-capacity-scaled
//     with its exclusion row naming the orchestrator machinery gap;
//   * the dsh lane (4 rows) is present with dsh-lane spec_refs.
//
// Fast + read-only (no campaign machinery) so it stays in self-tests/run.sh's
// tier2 glob. Zero tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier2Manifest = path.join(ttRoot, "cases", "tier2.jsonl");
const tier0Manifest = path.join(ttRoot, "cases", "tier0.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const specDir = path.join(ttRoot, "tamandua-torture-test-spec");
const wave4Spec = path.join(specDir, "08-wave-4-fault-injection.md");
const wave5Spec = path.join(specDir, "09-wave-5-storm.md");

// Spec'd W4 scenarios PROVIDED by the tier0 library (referenced, never
// duplicated into tier2.jsonl) — the story's "tier0 library
// (w4.25/w4.35/w4.49)" clause.
const TIER0_PROVIDED: Record<string, { cells: string[]; docName: string }> = {
  "W4.25": { cells: ["w4.25-aged-state-fixture"], docName: "w4.25-aged-state-fixture" },
  "W4.35": { cells: ["w4.35-done-rebased-absent-green"], docName: "w4.35-*" },
  "W4.49": { cells: ["w4.49-build-fails-after-pull"], docName: "w4.49-*" },
};

function loadJsonlLines(manifestPath: string): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// Extract the spec'd base scenario ids from the wave-4 spec's scenario
// tables: every `| W4.xx ...` table row (lines that START with a W4.x id).
function specWave4BaseIds(): string[] {
  const ids = new Set<string>();
  for (const line of fs.readFileSync(wave4Spec, "utf8").split(/\r?\n/)) {
    const match = /^\|\s*(W4\.\d{2})\b/.exec(line);
    if (match) ids.add(match[1]);
  }
  return Array.from(ids).sort();
}

// The traceability doc split into sections by `## ` headings.
function docSections(doc: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string } | null = null;
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = { heading: line, body: "" };
      sections.push(current);
    } else if (current !== null) {
      current.body += `${line}\n`;
    }
  }
  return sections;
}

describe("US-016 Tier-2 traceability completeness", () => {
  const manifest = loadJsonlLines(tier2Manifest);
  const tier0 = loadJsonlLines(tier0Manifest);
  const doc = fs.readFileSync(traceabilityPath, "utf8");
  const docLines = doc.split(/\r?\n/);
  const sections = docSections(doc);

  it("every tier2.jsonl id has a traceability row and every row carries a spec_ref", () => {
    assert.equal(manifest.length, 70, "tier2.jsonl must keep 70 cases");
    const missingRows: string[] = [];
    const missingSpecRefs: string[] = [];
    for (const record of manifest) {
      const row = docLines.find((line) => line.startsWith(`| ${record.id} |`));
      if (!row) missingRows.push(record.id);
      const specRef = record.spec_ref;
      if (typeof specRef !== "string" || specRef.trim() === "" ||
          (!specRef.includes("08-wave-4-fault-injection.md") && !specRef.includes("09-wave-5-storm.md"))) {
        missingSpecRefs.push(`${record.id}: spec_ref=${JSON.stringify(specRef)}`);
      }
    }
    assert.deepEqual(missingRows, [],
      `tier2.jsonl ids without a traceability case-map row:\n${missingRows.join("\n")}`);
    assert.deepEqual(missingSpecRefs, [],
      `tier2.jsonl rows without a wave-spec spec_ref:\n${missingSpecRefs.join("\n")}`);
  });

  it("every spec'd W4 scenario is in tier2.jsonl, the tier0 library, or the exclusion list", () => {
    const tier2SpecRefs = manifest.map((r) => String(r.spec_ref ?? ""));
    const exclusionSections = sections.filter((s) => /excluded scenarios/i.test(s.heading));

    const uncovered: string[] = [];
    const covered: string[] = [];
    for (const base of specWave4BaseIds()) {
      // 1. tier2.jsonl coverage: a row whose spec_ref anchors #W4.xx.
      const inTier2 = tier2SpecRefs.some((ref) => ref.includes(`#${base}`));
      if (inTier2) { covered.push(base); continue; }
      // 2. tier0 library provision (w4.25 / w4.35 / w4.49).
      const provided = TIER0_PROVIDED[base];
      if (provided !== undefined) {
        const cellPresent = provided.cells.some((cell) => tier0.some((r) => r.id === cell));
        const docNamesIt = doc.includes(provided.docName);
        if (cellPresent && docNamesIt) { covered.push(`${base} (tier0 ${provided.docName})`); continue; }
        uncovered.push(`${base}: tier0 library cell missing (cell=${cellPresent}, doc=${docNamesIt})`);
        continue;
      }
      // 3. explicit exclusion-list row (an "Excluded Scenarios" row naming it).
      const excluded = exclusionSections.some((s) =>
        s.body.split(/\r?\n/).some((line) => /^\|\s*/.test(line) && line.includes(base)));
      if (excluded) { covered.push(`${base} (exclusion row)`); continue; }
      uncovered.push(`${base}: not in tier2.jsonl, not tier0-provided, no exclusion row`);
    }
    assert.deepEqual(uncovered, [],
      `spec'd W4 scenarios with NO coverage (silent trims):\n${uncovered.join("\n")}`);
    assert.ok(covered.length >= 40,
      `spec'd W4 coverage too small (${covered.length}): ${covered.join(", ")}`);
  });

  it("the wave-5 storm is authored with its exclusion row naming the orchestrator gap", () => {
    const storm = manifest.find((r) => r.id === "W5.storm-capacity-scaled");
    assert.ok(storm, "tier2.jsonl must carry W5.storm-capacity-scaled");
    assert.ok(String(storm.spec_ref ?? "").includes("09-wave-5-storm.md"),
      "storm spec_ref must anchor 09-wave-5-storm.md");
    assert.equal(storm.wave, 5, "storm wave must be 5");
    assert.ok(docLines.some((line) => line.startsWith("| W5.storm-capacity-scaled |")),
      "traceability doc must carry the W5 storm case-map row");
    // The orchestrator gap is an EXPLICIT exclusion row, never a silent trim.
    const stormExclusion = sections.find((s) => /excluded scenarios.*storm/i.test(s.heading));
    assert.ok(stormExclusion, "traceability doc must have the wave-5 exclusion section");
    assert.match(stormExclusion.body,
      /orchestrator|ORCHESTRATOR/i,
      "the storm exclusion row must name the multi-run orchestrator machinery gap");
  });

  it("the dsh lane rows are present with dsh-lane spec_refs into their base scenarios", () => {
    const dshRows = manifest.filter((r) => r.id.startsWith("W4.dsh-"));
    assert.equal(dshRows.length, 4, "the dsh lane must keep 4 rows (do-now/bfmw/fdmw/lifecycle)");
    for (const row of dshRows) {
      assert.equal(row.harness, "dsh", `${row.id}: harness must be dsh`);
      assert.equal(row.context?.execution_mode, "real", `${row.id}: dsh rows are always real`);
      assert.ok(String(row.spec_ref ?? "").includes("08-wave-4-fault-injection.md"),
        `${row.id}: spec_ref must anchor the base wave-4 scenario`);
      assert.ok(docLines.some((line) => line.startsWith(`| ${row.id} |`)),
        `${row.id}: traceability doc must carry the dsh-lane case-map row`);
    }
  });

  it("the tier0-referenced W4 cells are enumerated in the traceability doc (referenced, never duplicated)", () => {
    // The doc's "Scripted W4 Cells Referenced from the Tier-0 Library" section
    // names w4.25 / w4.35 / w4.49 — the story's "tier0 library
    // (w4.25/w4.35/w4.49)" clause — and tier2.jsonl must NOT duplicate them.
    const tier0Section = sections.find((s) => /referenced from the tier-0 library/i.test(s.heading));
    assert.ok(tier0Section, "traceability doc must have the tier0-referenced cells section");
    for (const [base, meta] of Object.entries(TIER0_PROVIDED)) {
      assert.match(tier0Section.body, new RegExp(base.replace(/\./g, "\\.")),
        `tier0-referenced section must name ${base}`);
      assert.match(tier0Section.body, new RegExp(meta.docName.replace(/\./g, "\\.").replace(/\*/g, "\\*")),
        `tier0-referenced section must name the ${base} cells`);
    }
    // tier2.jsonl never carries a W4.25/W4.35/W4.49 row (referenced, not
    // duplicated) — and no row's spec_ref claims those ids as authored here.
    for (const record of manifest) {
      assert.ok(!record.id.startsWith("W4.25") && !record.id.startsWith("W4.35") && !record.id.startsWith("W4.49"),
        `${record.id}: tier0-provided W4.25/W4.35/W4.49 must not be duplicated in tier2.jsonl`);
    }
  });
});
