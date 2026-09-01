// US-011 — S38-S44 final suite batch landing-report pin.
//
// The S38-S44 task (torture-test/impl-tasks/S38-44-final-suite-batch.md)
// fixed seven adjudication-sourced defect classes from campaign-
// 20260826T225744158Z (four-lane adjudication) plus the operator-seam
// execution class, all in this run (run-b3895a6b, US-001..US-010, zero real
// tokens): S38 snapshot target-ref pinning (W4.29), S39 fail-closed chaos
// arming + W4.29 corridor wiring, S40 per-case boundary_files (all 70 rows),
// S41 probe-sequence evidence graph (W4.10-restart-recovery), S42 W4.17
// red-baseline arming hook, S43 O1 floor calibration + wave-reporter dedupe +
// bfmw classification precedence, S44 operator-seam actions + cell wiring.
// This test pins the US-011 landing report's honesty: the doc carries a
// Landing report section that names ALL 14 mapped cells, maps every cell to
// its fixing story (US-xxx), records the rerun status per cell — the cells
// the batch made honestly re-runnable (with their fixing story) vs the cells
// still requiring a real-campaign rerun — and cites the campaign id
// run-b3895a6b evidence lines plus the zero-token verification gates
// (run.sh battery GREEN x2 on a pre-existing dirty var/home/.tamandua DB,
// verify-heavy-campaign-tests.test.sh, bare --tier2 GREEN x2, bare --tier1
// GREEN, oracle self-test battery).
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

// The 14 cells of the S38-44 per-cell rerun map, keyed by case id; the value
// is the fixing story (US-xxx) the cell's disposition row must cite.
// Rerun-status key: "rerun" = the batch made the cell honestly re-runnable
// (scripted red/green or corridor proof); "rerun-campaign" = the cell still
// needs a real-campaign rerun (its defect class was fixed in the S32-37
// batch, or it was untouched by S38-44; zero real tokens were spent here).
const RERUN_MAP: Record<
  string,
  { stories: string[]; rerun: "rerun" | "rerun-campaign" }
> = {
  "W4.09-pi-kill-harness": {
    stories: ["US-004"], // S33 (S32-37 batch); untouched by S38-44
    rerun: "rerun-campaign",
  },
  "W4.10-kill-daemon": {
    stories: ["US-009", "US-010"], // S44a machinery + S44b wiring (corridor)
    rerun: "rerun",
  },
  "W4.10-restart-recovery": {
    stories: ["US-004"], // S41 probe-sequence sibling graph + O2 two-landing
    rerun: "rerun",
  },
  "W4.17-a-red-baseline-land-annotated": {
    stories: ["US-001", "US-005"], // S40 boundary + S42 arming hook
    rerun: "rerun",
  },
  "W4.17-b-red-baseline-refuse": {
    stories: ["US-001", "US-005"], // S40 boundary + S42 arming hook
    rerun: "rerun",
  },
  "W4.29-strict-gate-retry-finalize": {
    stories: ["US-001", "US-002", "US-003"], // S40 boundary + S38 pinning + S39 corridor
    rerun: "rerun",
  },
  "W4.30-detached-head-origin": {
    stories: ["US-002"], // S38 pinning re-verified the S31 contract no-regression
    rerun: "rerun-campaign", // defect fixed in S32-37 US-005 (S35); real rerun pending
  },
  "W4.33a-daemon-restart-resume": {
    stories: ["US-009", "US-010"], // S44a machinery + S44b during_hold wiring
    rerun: "rerun",
  },
  "W4.33b-update-under-it-resume": {
    stories: ["US-009", "US-010"], // S44a machinery + S44b during_hold wiring
    rerun: "rerun",
  },
  "W4.33d-reroute-exhaustion-resume": {
    stories: ["US-006", "US-007"], // S36 (S32-37 batch); untouched by S38-44
    rerun: "rerun-campaign",
  },
  "W4.37-keyline-spoof-repo-content": {
    stories: ["US-006"], // S43a expected_fast_failure calibration
    rerun: "rerun",
  },
  "W4.47-auth-expiry-copy": {
    stories: ["US-006", "US-009", "US-010"], // S43a + S44a credentials + S44b wiring
    rerun: "rerun",
  },
  "W4.48a-daemon-kill-mid-park": {
    stories: ["US-009", "US-010"], // S44a machinery + S44b wiring (corridor)
    rerun: "rerun",
  },
  "W4.48b-pause-rugpull-window": {
    stories: ["US-008"], // S37 (S32-37 batch); untouched by S38-44
    rerun: "rerun-campaign",
  },
};

// The zero-token verification gates the landing report must cite.
const VERIFICATION_GATES: string[] = [
  "self-tests/run.sh",
  "verify-heavy-campaign-tests.test.sh",
  "--tier2",
  "--tier1",
  "oracles/self-test/run.sh",
];

// Campaign evidence lines (campaign-20260826T225744158Z, this run
// run-b3895a6b) the landing report must cite — a representative subset of
// the verbatim lines the red-arms pin.
const CAMPAIGN_EVIDENCE_LINES: string[] = [
  "campaign-20260826T225744158Z",
  "run-b3895a6b",
  "refs/heads/security-audit-2026-08-27", // S38 W4.29 divergence
  "run-9b0bff8a", // S39 W4.29 chaos never fired
  "run-2621299f", // S41 W4.10-restart sibling run absent from graph
  "chaos-invocation-failed", // S43c state.json classification
];

describe("US-011 S38-44 landing report", () => {
  it("AC1: the landing doc exists and carries a Landing report section", () => {
    assert.ok(fs.existsSync(landingDoc), `landing doc missing: ${landingDoc}`);
    const doc = fs.readFileSync(landingDoc, "utf8");
    assert.match(
      doc,
      /^## Landing report /m,
      "the landing doc must carry a top-level Landing report section",
    );
  });

  it("AC1: the landing report names all 14 mapped cells", () => {
    const report = landingReport();
    for (const cell of Object.keys(RERUN_MAP)) {
      assert.ok(
        report.includes(cell),
        `landing report must name the mapped cell: ${cell}`,
      );
    }
  });

  it("AC1: every cell maps to its fixing story (US-xxx)", () => {
    const report = landingReport();
    const lines = report.split(/\r?\n/);
    for (const [cell, { stories }] of Object.entries(RERUN_MAP)) {
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

  it("AC1: every cell records its rerun status (re-runnable vs needs real-campaign rerun)", () => {
    const report = landingReport();
    const lines = report.split(/\r?\n/);
    for (const [cell, { rerun }] of Object.entries(RERUN_MAP)) {
      const row = lines.find((line) => line.includes(`| ${cell} `));
      assert.ok(row, `no disposition row for ${cell}`);
      if (rerun === "rerun") {
        assert.match(
          row,
          /re-runnable/i,
          `row for ${cell} must record the re-runnable status: ${row.trim()}`,
        );
      } else {
        assert.match(
          row,
          /needs (a )?real-campaign rerun|needs rerun/i,
          `row for ${cell} must record the rerun status: ${row.trim()}`,
        );
      }
    }
  });

  it("AC2-AC3: the landing report cites the campaign id run-b3895a6b evidence lines", () => {
    const report = landingReport();
    for (const line of CAMPAIGN_EVIDENCE_LINES) {
      assert.ok(
        report.includes(line),
        `landing report must cite the campaign evidence line: ${line}`,
      );
    }
  });

  it("AC2-AC5: the landing report cites the zero-token verification gates", () => {
    const report = landingReport();
    for (const gate of VERIFICATION_GATES) {
      assert.ok(
        report.includes(gate),
        `landing report must cite the verification gate: ${gate}`,
      );
    }
    // The AC3 dirty-home gate: run.sh GREEN x2 with a pre-existing dirty
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
