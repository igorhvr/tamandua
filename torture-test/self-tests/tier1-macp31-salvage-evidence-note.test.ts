// MACP3.1 salvage US-006 — evidence-note pin for the original MACP3 US-010 (a)
// deliverable: the MACP3 task doc must carry an auditable evidence note
// pointing at the adopted commits (US-001..US-009) and the union
// re-validation suites that passed (US-002..US-005).
//
// The MACP3 run (run-0ba389c8) force-failed on the abandonment ceiling before
// it could write this evidence note; the MACP3.1 salvage lands it. This test
// pins the landing's honesty: the doc's evidence-note section exists, cites
// the adopted commit for each story (including US-009 `f53737f9`, the branch
// HEAD), and names every union re-validation suite that was re-run green on
// the merged union.
//
// Zero tokens. Reads only files under torture-test/ (no state writes).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const macp3Doc = path.join(
  ttRoot,
  "impl-tasks",
  "MACP3-procfd-portability-vacuous-green.md",
);

// The adopted commit for every MACP3 story, as cited in the evidence note.
// US-009 (`f53737f9`) is the branch HEAD and the acceptance-anchor citation.
const ADOPTED_COMMITS: Record<string, string> = {
  "US-001": "922c0f34", // portable exclusive-create in the oracle evidence writer
  "US-002": "94b2cafe", // hermetic red-then-green proof for the portable create
  "US-003": "14ac1c01", // /proc sweep of runtime tools (guarded/documented)
  "US-004": "58c249fc", // /proc sweep of test harnesses (guarded/documented)
  "US-005": "90c21f14", // unguarded-/proc lint self-test (allowlist)
  "US-006": "01bfc95f", // fail-closed predicate semantics
  "US-007": "67f83c11", // tests for fail-closed predicates
  "US-008": "ba3fc754", // bare-verdict vacuity guard
  "US-009": "f53737f9", // red-then-green proof for the bare vacuity guard
};

// Union re-validation suites (US-002..US-005) that must be named by the
// evidence note, keyed by the recognizable self-test / script token.
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

describe("MACP3.1 US-006 — MACP3 task doc evidence note (US-010 (a))", () => {
  it("AC1: the task doc exists and carries an evidence-note section", () => {
    assert.ok(fs.existsSync(macp3Doc), `task doc missing: ${macp3Doc}`);
    const doc = fs.readFileSync(macp3Doc, "utf8");
    // Proper markdown: a second-level heading that names the landing.
    assert.match(
      doc,
      /^## Evidence note — US-010 \(a\) landing \(MACP3\.1 salvage, run-8b9671d8\)$/m,
      "the doc must carry the evidence-note section heading",
    );
  });

  it("AC1: the evidence note references commit f53737f9 (US-009)", () => {
    const doc = fs.readFileSync(macp3Doc, "utf8");
    const note = evidenceNote(doc);
    assert.match(note, /`f53737f9`/, "evidence note must cite US-009 commit f53737f9");
    assert.match(
      note,
      /Red-then-green proof for the bare vacuity guard/,
      "evidence note must describe what f53737f9 delivered",
    );
  });

  it("AC1: the evidence note cites every adopted commit (US-001..US-009)", () => {
    const doc = fs.readFileSync(macp3Doc, "utf8");
    const note = evidenceNote(doc);
    for (const [story, sha] of Object.entries(ADOPTED_COMMITS)) {
      assert.match(
        note,
        new RegExp(`\\|\\s*${story}\\s*\\|\\s*\`${sha}\``),
        `evidence note must cite ${story} commit ${sha} in the adopted-commits table`,
      );
    }
  });

  it("AC2: the evidence note names every union re-validation suite that passed", () => {
    const doc = fs.readFileSync(macp3Doc, "utf8");
    const note = evidenceNote(doc);
    for (const suite of REVALIDATION_SUITES) {
      assert.ok(
        note.includes(suite),
        `evidence note must name the union re-validation suite: ${suite}`,
      );
    }
    // And it must record that they passed on the union, not merely list them.
    assert.match(note, /exited 0/, "evidence note must state the suites exited 0");
  });

  it("AC1/AC2: the evidence note is inside the markdown document (renders as one section)", () => {
    const doc = fs.readFileSync(macp3Doc, "utf8");
    const note = evidenceNote(doc);
    // The note begins at its heading and runs to the end of the file — the
    // heading is a top-level section (## ), i.e. the doc structure is intact
    // (no half-appended fragment, no dangling sub-heading without a parent).
    assert.ok(note.startsWith("## Evidence note"), "note must start at its own heading");
    const nextHeading = /^## /m.exec(note.slice(note.indexOf("\n", note.indexOf("## Evidence note")) + 1));
    assert.equal(nextHeading, null, "no stray top-level heading inside the evidence note");
  });
});

/** The evidence-note section of the task doc (from its heading to EOF). */
function evidenceNote(doc: string): string {
  const idx = doc.indexOf("## Evidence note");
  assert.notEqual(idx, -1, "evidence-note heading not found");
  return doc.slice(idx);
}
