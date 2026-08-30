// US-010 — S28-S31 integration landing-report pin.
//
// The S28-S31 task (torture-test/impl-tasks/S28-31-chaos-probe-install-
// scheduler.md) fixed four scenario-infra defect classes that voided 12
// tier-2 real cells in campaign-20260826T225744158Z-4bf26d7f (S28
// chaos-invocation-failed x5, S29 probe-trigger-unreached x4, S30
// workflow-spec-missing x1, S31 scheduler-execution-failed x1). This test
// pins the US-010 landing report's honesty: the doc carries a Landing
// report section that names ALL 12 voided cells, maps every cell to its
// fixing story (US-xxx), records the rerun status (every cell was voided
// before its oracle judged, so all need a real-campaign rerun), and cites
// the zero-token verification gates (run.sh battery GREEN, isolated heavy
// campaign tests GREEN, bare --tier2 GREEN x2, bare --tier1 GREEN).
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
  "S28-31-chaos-probe-install-scheduler.md",
);

// The 12 voided tier-2 cells (campaign-20260826T225744158Z-4bf26d7f),
// keyed by case id; the value is the fixing story (US-xxx) that
// root-caused and scripted-reproduced the defect.
const VOIDED_CELLS: Record<string, string> = {
  "W4.09-pi-kill-harness": "US-005", // S28 exit-null SIGKILL chain (trigger calibration US-003)
  "W4.09-hermes-kill-harness": "US-005", // S28 exit-null SIGKILL chain (US-003)
  "W4.10-kill-daemon": "US-005", // S28 exit-null SIGKILL chain (US-003 + US-006 daemon identity)
  "W4.48a-daemon-kill-mid-park": "US-006", // S28 exit-3 GUARD_MISS
  "W4.48c-compound-gate-degradation": "US-007", // S28 exit-1 TESTEDTREE
  "W4.10-restart-recovery": "US-002", // S29 calibration (US-003 preflight)
  "W4.33a-daemon-restart-resume": "US-002", // S29 calibration (US-003)
  "W4.33b-update-under-it-resume": "US-002", // S29 calibration (US-003)
  "W4.33d-reroute-exhaustion-resume": "US-004", // S29 premise redesign (typed move-branch)
  "W4.48b-pause-rugpull-window": "US-004", // S29 premise redesign (typed move-branch)
  "W4.14-verdict-trap": "US-008", // S30 workflow-spec-missing
  "W4.30-detached-head-origin": "US-009", // S31 scheduler-execution-failed
};

// The zero-token verification gates the landing report must cite.
const VERIFICATION_GATES: string[] = [
  "self-tests/run.sh",
  "verify-heavy-campaign-tests.test.sh",
  "--tier2",
  "--tier1",
];

describe("US-010 S28-S31 landing report", () => {
  it("AC4: the landing doc exists and carries a Landing report section", () => {
    assert.ok(fs.existsSync(landingDoc), `landing doc missing: ${landingDoc}`);
    const doc = fs.readFileSync(landingDoc, "utf8");
    assert.match(
      doc,
      /^## Landing report /m,
      "the landing doc must carry a top-level Landing report section",
    );
  });

  it("AC4: the landing report names all 12 voided cells", () => {
    const report = landingReport();
    for (const cell of Object.keys(VOIDED_CELLS)) {
      assert.ok(
        report.includes(cell),
        `landing report must name the voided cell: ${cell}`,
      );
    }
  });

  it("AC4: every voided cell maps to its fixing story (US-xxx)", () => {
    const report = landingReport();
    for (const [cell, story] of Object.entries(VOIDED_CELLS)) {
      // The cell's row in the disposition table must cite the fixing story.
      // Find the row line containing the cell id and assert the story
      // appears in it (the story id is unambiguous in the row context).
      const lines = report.split(/\r?\n/);
      const row = lines.find((line) => line.includes(`| ${cell} `));
      assert.ok(row, `no disposition row for ${cell}`);
      assert.ok(
        row.includes(story),
        `row for ${cell} must cite the fixing story ${story}: ${row.trim()}`,
      );
    }
  });

  it("AC4: every voided cell records a rerun status (needs rerun)", () => {
    const report = landingReport();
    for (const cell of Object.keys(VOIDED_CELLS)) {
      const lines = report.split(/\r?\n/);
      const row = lines.find((line) => line.includes(`| ${cell} `));
      assert.ok(row, `no disposition row for ${cell}`);
      assert.match(
        row,
        /needs (a )?real-campaign rerun|needs rerun/i,
        `row for ${cell} must record the rerun status: ${row.trim()}`,
      );
    }
  });

  it("AC1-AC3: the landing report cites the zero-token verification gates", () => {
    const report = landingReport();
    for (const gate of VERIFICATION_GATES) {
      assert.ok(
        report.includes(gate),
        `landing report must cite the verification gate: ${gate}`,
      );
    }
    // GREEN x2 for tier2 (repeatability contract) and GREEN for tier1.
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

  it("AC1-AC6: the landing report section is a well-formed markdown section", () => {
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
