// US-005 — S38-44.1 landing-salvage note pin.
//
// The S38-44.1 salvage run (run-9e4cb14c) appended a short salvage note to
// the S38-44 landing report (torture-test/impl-tasks/S38-44-final-suite-
// batch.md) documenting what THIS run re-verified versus what it cites from
// run-b3895a6b's artifacts, so the deliverable honestly records the bounded
// verification performed here. This test pins the note's honesty: it must
// state the batch was ADOPTED (US-001..US-011 from run-b3895a6b, commits
// 02d18535..8e8f8d7e) with NO re-implementation, record the EXACTLY-ONCE
// bounded re-verification (full self-test battery green on a dirty
// var/home/.tamandua DB via self-tests/run.sh, bare --tier2 GREEN x2, bare
// --tier1 GREEN x1 — citing this run's campaign ids recorded under
// torture-test/var/results/), and cite the prior-run artifacts
// (campaign-20260831T232424488Z, campaign-20260901T001925277Z,
// campaign-20260901T011719592Z from run-b3895a6b) for the gates NOT
// re-run here. The note must be a ### (h3) subsection — never ## (h2) — and
// keep code fences balanced (the US-011 landing-report pin forbids stray
// top-level headings inside the landing-report section).
//
// Fast + read-only (no campaign machinery, no state writes) so it stays in
// self-tests/run.sh's bounded tier2 glob — NOT a heavy campaign test.
// Zero tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const landingDoc = path.join(
  ttRoot,
  "impl-tasks",
  "S38-44-final-suite-batch.md",
);

// The re-verified gates this run performed EXACTLY ONCE (the S38-44.1
// bounded gate set), each with the campaign id recorded in this run's
// torture-test/var/results/ (where a campaign applies — the battery is the
// self-tests/run.sh run, which has no campaign id).
const REVERIFIED_GATES: Array<{ gate: string; campaign?: string }> = [
  {
    gate: "self-tests/run.sh", // full self-test battery, once, dirty var/home DB
  },
  {
    gate: "--tier2",
    campaign:
      "campaign-20260901T065921032Z-fba3100d-20da-4aec-bcfa-dabb809ccdfd",
  },
  {
    gate: "--tier2",
    campaign:
      "campaign-20260901T075434360Z-7cbb117f-e842-4018-8c36-337c6ff32964",
  },
  {
    gate: "--tier1",
    campaign:
      "campaign-20260901T085426885Z-6689fed3-2ed2-405f-bfcb-104648596878",
  },
];

// Prior-run artifacts (run-b3895a6b) cited for gates NOT re-run here.
const PRIOR_RUN_ARTIFACTS: string[] = [
  "campaign-20260831T232424488Z",
  "campaign-20260901T001925277Z",
  "campaign-20260901T011719592Z",
];

describe("US-005 S38-44.1 salvage note", () => {
  it("AC1: the landing doc carries a '### Salvage note' subsection", () => {
    assert.ok(fs.existsSync(landingDoc), `landing doc missing: ${landingDoc}`);
    const doc = fs.readFileSync(landingDoc, "utf8");
    assert.match(
      doc,
      /^### Salvage note /m,
      "the landing doc must carry a '### Salvage note' subsection",
    );
  });

  it("AC1: the salvage note records the adoption (US-001..US-011, commits 02d18535..8e8f8d7e) with NO re-implementation", () => {
    const note = salvageNote();
    assert.match(
      note,
      /US-001\.\.US-011/,
      "salvage note must name the adopted story range",
    );
    assert.match(
      note,
      /02d18535\.\.8e8f8d7e|02d18535/,
      "salvage note must cite the adopted commit range",
    );
    assert.match(
      note,
      /NO re-implementation|no re-implementation/i,
      "salvage note must record the no-re-implementation contract",
    );
    assert.match(
      note,
      /run-b3895a6b/,
      "salvage note must name the prior run",
    );
  });

  it("AC1: the salvage note names the re-verified gates and this run's campaign ids", () => {
    const note = salvageNote();
    assert.match(
      note,
      /EXACTLY ONCE|exactly once/i,
      "salvage note must record the exactly-once bound",
    );
    for (const { gate, campaign } of REVERIFIED_GATES) {
      assert.ok(
        note.includes(gate),
        `salvage note must name the re-verified gate: ${gate}`,
      );
      if (campaign) {
        assert.ok(
          note.includes(campaign),
          `salvage note must cite this run's campaign id: ${campaign}`,
        );
      }
    }
    // The battery-once dirty-home condition (AC1: "battery-once dirty-home").
    assert.match(
      note,
      /dirty/i,
      "salvage note must record the dirty var/home DB condition",
    );
    assert.ok(
      note.includes("var/home/.tamandua"),
      "salvage note must cite the contained-home DB path",
    );
    // The tier2 repeatability (x2) and tier1 (x1) counts.
    assert.match(
      note,
      /--tier2.*x2|tier2.*GREEN x2|--tier2.*GREEN x2/i,
      "salvage note must record the bare --tier2 GREEN x2 repeatability",
    );
    assert.match(
      note,
      /--tier1.*x1|tier1.*GREEN x1|--tier1.*GREEN x1/i,
      "salvage note must record the bare --tier1 GREEN x1 run",
    );
  });

  it("AC1: the salvage note cites the prior-run artifacts for gates NOT re-run", () => {
    const note = salvageNote();
    for (const artifact of PRIOR_RUN_ARTIFACTS) {
      assert.ok(
        note.includes(artifact),
        `salvage note must cite the prior-run artifact: ${artifact}`,
      );
    }
    assert.match(
      note,
      /NOT re-run|not re-run/i,
      "salvage note must mark the cited gates as NOT re-run here",
    );
  });

  it("AC1: the salvage note is a well-formed markdown h3 subsection", () => {
    const note = salvageNote();
    assert.ok(
      note.startsWith("### Salvage note"),
      "salvage note must start at its own h3 heading",
    );
    // h3, never h2: the US-011 landing-report pin forbids stray '## '
    // top-level headings inside the landing-report section.
    assert.equal(
      /^## /m.exec(note),
      null,
      "no stray top-level heading inside the salvage note",
    );
    assert.equal(
      (note.match(/```/g) ?? []).length % 2,
      0,
      "code fences must be balanced",
    );
  });
});

/** The salvage-note subsection of the doc (from its heading to EOF). */
function salvageNote(): string {
  const doc = fs.readFileSync(landingDoc, "utf8");
  const idx = doc.indexOf("### Salvage note");
  assert.notEqual(idx, -1, "salvage-note heading not found");
  return doc.slice(idx);
}
