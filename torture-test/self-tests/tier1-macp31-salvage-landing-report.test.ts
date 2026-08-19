// MACP3.1 salvage US-009 — landing-report pin for the MACP3.1 salvage
// completion doc: torture-test/impl-tasks/MACP3.1-salvage-complete-
// procfd-vacuity.md must carry a landing-report section that names ALL FOUR
// original MACP3 acceptance items (portability fix, /proc sweep
// completeness, fail-closed predicates, vacuity guard), each with a commit
// pointer to the adopted branch (e.g. `f53737f9` for US-009) and union
// re-validation evidence.
//
// The MACP3 run (run-0ba389c8) force-failed on the abandonment ceiling
// before US-010's report could be written; the MACP3.1 salvage (run-
// 8b9671d8) adopts the reviewed branch (merge 3651f00c, union HEAD
// 17ac9e7e), re-validates it on the union (US-002..US-005), completes the
// original US-010 gates (a)/(b)/(c) (US-006..US-008), and records this
// landing report. This test pins the landing's honesty: the report section
// exists, names every acceptance item, cites an adopted commit per item,
// and cites the union re-validation suites.
//
// Zero tokens. Reads only files under torture-test/ (no state writes).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const landingDoc = path.join(
  ttRoot,
  "impl-tasks",
  "MACP3.1-salvage-complete-procfd-vacuity.md",
);

// The four original MACP3 acceptance items, as named by the task doc, each
// with the adopted commit(s) that delivered it (US-001..US-009 on
// feature/macp3-procfd-portability-vacuous-green, merged at 3651f00c).
const ACCEPTANCE_ITEMS: Record<string, string[]> = {
  "portability fix": ["922c0f34", "94b2cafe"], // US-001 portable exclusive-create + US-002 hermetic proof
  "/proc sweep completeness": ["14ac1c01", "58c249fc", "90c21f14"], // US-003 runtime sweep + US-004 harness sweep + US-005 lint
  "fail-closed predicates": ["01bfc95f", "67f83c11"], // US-006 semantics + US-007 tests
  "vacuity guard": ["ba3fc754", "f53737f9"], // US-008 guard + US-009 red-then-green proof
};

// Union re-validation suites (US-002..US-005) that must be named by the
// landing report, keyed by the recognizable self-test / script token.
const REVALIDATION_SUITES: string[] = [
  "tier1-daemon-control-scope-isolation", // US-002 scope isolation (T2.1 reconciliation)
  "tier2-cross-worktree-scope-isolation", // US-002 scope isolation (static pins)
  "tier0-procfs-portability-lint", // US-003 /proc lint (G1/G2/G3/G4)
  "evidence-portability", // US-003 hermetic portable-create proof
  "tier1-bare-vacuity-red-green", // US-004 vacuity guard red-then-green
  "tt-report", // US-004 fail-closed predicate + vacuity verdict units
  "tier2-tier2-assets", // US-005 tier2-assets guard (node)
  "tt-tier2-assets", // US-005 tier2-assets guard (bash)
];

// Union re-validation evidence-pointer commits (US-002..US-008) that the
// landing report cites.
const EVIDENCE_POINTERS: string[] = [
  "c973db58", // US-002 scope-isolation re-validation
  "519ee6a7", // US-003 /proc lint + evidence-portability re-validation
  "f70ec2d3", // US-004 vacuity + fail-closed re-validation
  "51baebd0", // US-005 tier2-assets re-validation
  "70656bdf", // US-006 US-010 (a) evidence note
  "fac8f443", // US-007 US-010 (b) self-test battery
  "ae9611dd", // US-008 US-010 (c) bare tier1 GREEN
];

describe("MACP3.1 US-009 — salvage landing report", () => {
  it("AC1: the landing doc exists and carries a landing-report section", () => {
    assert.ok(fs.existsSync(landingDoc), `landing doc missing: ${landingDoc}`);
    const doc = fs.readFileSync(landingDoc, "utf8");
    // Proper markdown: a second-level heading that names the report.
    assert.match(
      doc,
      /^## Landing report — MACP3\.1 salvage \(run-8b9671d8, US-009\)$/m,
      "the landing doc must carry the landing-report section heading",
    );
  });

  it("AC1: the landing report names all four acceptance items", () => {
    const doc = fs.readFileSync(landingDoc, "utf8");
    const report = landingReport(doc).toLowerCase();
    for (const item of Object.keys(ACCEPTANCE_ITEMS)) {
      assert.ok(
        report.includes(item.toLowerCase()),
        `landing report must name the acceptance item: ${item}`,
      );
    }
  });

  it("AC2: each acceptance item has a commit pointer to the adopted branch", () => {
    const doc = fs.readFileSync(landingDoc, "utf8");
    const report = landingReport(doc);
    for (const [item, shas] of Object.entries(ACCEPTANCE_ITEMS)) {
      for (const sha of shas) {
        assert.ok(
          report.includes(sha),
          `landing report must cite ${item} adopted commit ${sha}`,
        );
      }
    }
    // The US-009 branch-HEAD commit (f53737f9) must be cited — it is the
    // acceptance-anchor citation for the vacuity-guard item.
    assert.match(
      report,
      /`f53737f9`/,
      "landing report must cite US-009 commit f53737f9",
    );
  });

  it("AC2: each acceptance item cites union re-validation evidence", () => {
    const doc = fs.readFileSync(landingDoc, "utf8");
    const report = landingReport(doc);
    for (const suite of REVALIDATION_SUITES) {
      assert.ok(
        report.includes(suite),
        `landing report must name the union re-validation suite: ${suite}`,
      );
    }
    for (const ptr of EVIDENCE_POINTERS) {
      assert.ok(
        report.includes(ptr),
        `landing report must cite evidence-pointer commit ${ptr}`,
      );
    }
    // And it must record that the suites passed (exited 0) on the union.
    assert.match(report, /exits 0|exit 0/, "landing report must state the suites exited 0");
  });

  it("AC1/AC2: the landing report is inside the markdown document (renders as one section)", () => {
    const doc = fs.readFileSync(landingDoc, "utf8");
    const report = landingReport(doc);
    // The report begins at its heading and runs to the end of the file —
    // the heading is a top-level section (## ), i.e. the doc structure is
    // intact (no half-appended fragment, no dangling sub-heading without a
    // parent).
    assert.ok(report.startsWith("## Landing report"), "report must start at its own heading");
    // Markdown sanity: balanced code fences (none expected) and no stray
    // top-level heading inside the report section.
    assert.equal((report.match(/```/g) ?? []).length % 2, 0, "code fences must be balanced");
    const body = report.slice(report.indexOf("\n") + 1);
    const nextHeading = /^## /m.exec(body);
    assert.equal(nextHeading, null, "no stray top-level heading inside the landing report");
  });
});

/** The landing-report section of the doc (from its heading to EOF). */
function landingReport(doc: string): string {
  const idx = doc.indexOf("## Landing report");
  assert.notEqual(idx, -1, "landing-report heading not found");
  return doc.slice(idx);
}
