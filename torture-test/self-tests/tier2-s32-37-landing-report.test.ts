// US-009 — S32-S37 re-run residue landing-report pin.
//
// The S32-S37 task (torture-test/impl-tasks/S32-37-rerun-residue.md) fixed
// seven tier-2 re-run residue cells from the 2026-08-30 targeted re-run
// (campaign-20260830T* single-case campaigns, one per cell): W4.10-kill-daemon,
// W4.37-keyline-spoof-repo-content and W4.48a-daemon-kill-mid-park (S34
// deadline-sweep race), W4.09-pi-kill-harness (S33 chaos guard), W4.30-
// detached-head-origin (S35 O9 oracle infra), W4.33d-reroute-exhaustion-resume
// (S36 premise) and W4.48b-pause-rugpull-window (S37 O8 checksum), plus the
// S32 battery-hermeticity item. This test pins the US-009 landing report's
// honesty: the doc carries a Landing report section that names ALL 7 residue
// cells, maps every cell to its fixing story (US-xxx), records the rerun
// status (every cell is marked 'needs real-campaign rerun' — the user re-runs
// the real cells after landing; zero real tokens were spent here), and cites
// the zero-token verification gates (run.sh battery GREEN x2 on a pre-existing
// dirty var/home/.tamandua DB, verify-heavy-campaign-tests.test.sh incl. the
// S29/S36 premise corridor, bare --tier2 GREEN x2, bare --tier1 GREEN).
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
  "S32-37-rerun-residue.md",
);

// The 7 re-run residue cells (campaign-20260830T* rerun), keyed by case id;
// the value is the fixing story (US-xxx) that root-caused and
// scripted-reproduced the defect (multi-story cells list every fixing story
// the row must cite).
const RESIDUE_CELLS: Record<string, string[]> = {
  "W4.10-kill-daemon": ["US-002", "US-003"], // S34 deadline-sweep grace + caps analysis
  "W4.37-keyline-spoof-repo-content": ["US-002", "US-003"], // S34 deadline-sweep grace + caps recalibration
  "W4.48a-daemon-kill-mid-park": ["US-002", "US-003"], // S34 deadline-sweep grace + caps analysis
  "W4.09-pi-kill-harness": ["US-004"], // S33 harness identity evidence chain
  "W4.30-detached-head-origin": ["US-005"], // S35 O9 detached-HEAD contract
  "W4.33d-reroute-exhaustion-resume": ["US-006", "US-007"], // S36 diagnosis + premise redesign
  "W4.48b-pause-rugpull-window": ["US-008"], // S37 O8 moved-target (rugpull) model
};

// The zero-token verification gates the landing report must cite.
const VERIFICATION_GATES: string[] = [
  "self-tests/run.sh",
  "verify-heavy-campaign-tests.test.sh",
  "--tier2",
  "--tier1",
];

describe("US-009 S32-37 landing report", () => {
  it("AC1: the landing doc exists and carries a Landing report section", () => {
    assert.ok(fs.existsSync(landingDoc), `landing doc missing: ${landingDoc}`);
    const doc = fs.readFileSync(landingDoc, "utf8");
    assert.match(
      doc,
      /^## Landing report /m,
      "the landing doc must carry a top-level Landing report section",
    );
  });

  it("AC1: the landing report names all 7 residue cells", () => {
    const report = landingReport();
    for (const cell of Object.keys(RESIDUE_CELLS)) {
      assert.ok(
        report.includes(cell),
        `landing report must name the residue cell: ${cell}`,
      );
    }
  });

  it("AC1: every residue cell maps to its fixing story (US-xxx)", () => {
    const report = landingReport();
    const lines = report.split(/\r?\n/);
    for (const [cell, stories] of Object.entries(RESIDUE_CELLS)) {
      // The cell's row in the disposition table must cite EVERY fixing story.
      const row = lines.find((line) => line.includes(`| ${cell} `));
      assert.ok(row, `no disposition row for ${cell}`);
      for (const story of stories) {
        assert.ok(
          row.includes(story),
          `row for ${cell} must cite the fixing story ${story}: ${row.trim()}`,
        );
      }
    }
  });

  it("AC1: every residue cell records the rerun status (needs real-campaign rerun)", () => {
    const report = landingReport();
    const lines = report.split(/\r?\n/);
    for (const cell of Object.keys(RESIDUE_CELLS)) {
      const row = lines.find((line) => line.includes(`| ${cell} `));
      assert.ok(row, `no disposition row for ${cell}`);
      assert.match(
        row,
        /needs (a )?real-campaign rerun|needs rerun/i,
        `row for ${cell} must record the rerun status: ${row.trim()}`,
      );
    }
  });

  it("AC2-AC3: the landing report cites the zero-token verification gates", () => {
    const report = landingReport();
    for (const gate of VERIFICATION_GATES) {
      assert.ok(
        report.includes(gate),
        `landing report must cite the verification gate: ${gate}`,
      );
    }
    // The AC2 dirty-home gate: run.sh GREEN x2 with a pre-existing dirty
    // var/home/.tamandua DB present (the US-001 hermeticity contract).
    assert.match(
      report,
      /dirty/i,
      "landing report must record the dirty-home verification condition",
    );
    assert.ok(
      report.includes("var/home/.tamandua"),
      "landing report must cite the contained-home DB path",
    );
    // The tier2 repeatability contract (GREEN x2) and GREEN verdicts.
    assert.match(
      report,
      /GREEN.*\*2\*|GREEN.*x2|exit 0.*exit 0|run 2\) \*\*GREEN|repeatability/i,
      "landing report must record the tier2 repeatability contract (GREEN x2)",
    );
    assert.match(
      report,
      /GREEN|exit 0/i,
      "landing report must record GREEN verdicts",
    );
  });

  it("AC1: the landing report section is a well-formed markdown section", () => {
    const doc = fs.readFileSync(landingDoc, "utf8");
    const report = landingReport();
    assert.ok(
      report.startsWith("## Landing report"),
      "report must start at its own heading",
    );
    assert.equal(
      (report.match(/```/g) ?? []).length % 2,
      0,
      "code fences must be balanced",
    );
    const body = report.slice(report.indexOf("\n") + 1);
    assert.equal(
      /^## /m.exec(body),
      null,
      "no stray top-level heading inside the landing report",
    );
    assert.match(
      report,
      /^\| Cell \|/m,
      "the landing report must carry a per-cell disposition table",
    );
  });
});

/** The Landing report section of the doc (from its heading to EOF). */
function landingReport(): string {
  const doc = fs.readFileSync(landingDoc, "utf8");
  const idx = doc.indexOf("## Landing report");
  assert.notEqual(idx, -1, "landing-report heading not found");
  return doc.slice(idx);
}
