// US-003 — S34 caps-vs-honest-duration recalibration pin (the three deadline
// cells: W4.10-kill-daemon, W4.37-keyline-spoof-repo-content,
// W4.48a-daemon-kill-mid-park).
//
// The 2026-08-30 rerun's deadline-sweep race (S34, fixed by US-002's grace
// contract) exposed two distinct cap problems among the three cells:
//   * W4.37 (do-now, wall_min 5) was a genuinely-too-tight cap: the do-now
//     unit's honest duration is > 5m18s (both samples cap-truncated —
//     campaign-20260830T111549750Z voided 0s after the deadline with the
//     `execute` round still running; campaign-20260826T225744158Z
//     `runaway-cap-enforced` at 5m17.7s), and the family datapoint
//     W4.dsh-do-now completed honestly at 5m21.4s. Recalibrated 5 -> 10.
//   * W4.10-kill-daemon / W4.48a-daemon-kill-mid-park (bfmw, wall_min 55)
//     were genuine stalls, NOT cap breaches: the SIGKILLed contained daemon
//     was never restarted during the run (lifecycle-log proof —
//     `daemon.uncleanExit` last heartbeat at kill time, no `daemon.start`
//     until the sweep teardown 55 min later), so the 55-m caps were consumed
//     by un-recovered hangs, not honest work. No recalibration.
//
// This test pins the landed state (zero tokens, read-only — no campaign
// machinery, no launches):
//   * cases/tier2.jsonl carries the recalibrated caps (W4.37 + W4.dsh-do-now
//     wall_min 10; W4.10-kill-daemon + W4.48a unchanged at 55);
//   * cases/tier2-traceability.md carries the "S34 caps-vs-honest-duration
//     disposition" section citing all three rerun campaign ids, the
//     recalibrated/unchanged decision per cell, and caps-table rows whose
//     values MATCH the manifest (the table cannot drift from tier2.jsonl);
//   * cases/caps-calibration.md carries the tier-2 S34 section with a row
//     for W4.37 whose New value matches the manifest;
//   * impl-tasks/S32-37-rerun-residue.md's S34 section records the US-003
//     analysis (no longer "remaining").
//
// Fast + read-only so it stays in self-tests/run.sh's bounded tier2 glob.
// Zero tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier2Manifest = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityDoc = path.join(ttRoot, "cases", "tier2-traceability.md");
const calibrationDoc = path.join(ttRoot, "cases", "caps-calibration.md");
const implTaskDoc = path.join(ttRoot, "impl-tasks", "S32-37-rerun-residue.md");

// The three S34 deadline cells (rerun evidence, read-only — never modified):
// campaign ids are the single-case rerun campaigns of 2026-08-30.
const DEADLINE_CELLS: Record<string, { campaign: string; expired: string }> = {
  "W4.10-kill-daemon": {
    campaign: "campaign-20260830T065151712Z-37c54c06-b903-40d4-affc-c52939362479",
    expired: "expired 4s before the independent deadline sweep observed it",
  },
  "W4.37-keyline-spoof-repo-content": {
    campaign: "campaign-20260830T111549750Z-ac1e0b86-34ce-43e0-b026-75b7e3e50fd1",
    expired: "expired 0s before the independent deadline sweep observed it",
  },
  "W4.48a-daemon-kill-mid-park": {
    campaign: "campaign-20260830T090310754Z-6d67693d-c123-4a1d-9cdf-41303a1cc44c",
    expired: "expired 3s before the independent deadline sweep observed it",
  },
};

// The recalibration decisions (the S34 disposition table's Decision column).
const DECISIONS: Record<string, string> = {
  "W4.10-kill-daemon": "unchanged",
  "W4.37-keyline-spoof-repo-content": "recalibrated",
  "W4.48a-daemon-kill-mid-park": "unchanged",
};

function loadJsonl(manifestPath: string): Record<string, any>[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function recordById(records: Record<string, any>[], id: string): Record<string, any> {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

describe("Tier-2 S34 caps-vs-honest-duration recalibration (US-003)", () => {
  it("cases/tier2.jsonl carries the recalibrated caps: W4.37 + W4.dsh-do-now wall_min 10, W4.10/W4.48a unchanged at 55", () => {
    const records = loadJsonl(tier2Manifest);
    const cases = new Map(records.map((record) => [record.id, record]));

    // Recalibrated (do-now family — honest duration exceeds the old 5-min cap).
    for (const id of ["W4.37-keyline-spoof-repo-content", "W4.dsh-do-now"]) {
      const record = cases.get(id);
      assert.ok(record, `${id} must exist in the manifest`);
      assert.equal(record.caps.wall_min, 10, `${id}: wall_min must be recalibrated to 10`);
      assert.equal(record.caps.tokens, 200000, `${id}: token cap must stay at the do-now unit 200k`);
    }

    // Not recalibrated (genuine stalls — the caps were never the binding constraint).
    for (const id of ["W4.10-kill-daemon", "W4.48a-daemon-kill-mid-park"]) {
      const record = cases.get(id);
      assert.ok(record, `${id} must exist in the manifest`);
      assert.equal(record.caps.wall_min, 55, `${id}: wall_min must remain 55 (no recalibration)`);
      assert.equal(record.caps.tokens, 1000000, `${id}: token cap must stay at pi bfmw p95 1M`);
    }

    // The untouched do-now sibling stays at the old cap (its honest duration is ~44s).
    const w438 = cases.get("W4.38-hostile-task-real");
    assert.ok(w438, "W4.38-hostile-task-real must exist in the manifest");
    assert.equal(w438.caps.wall_min, 5, "W4.38-hostile-task-real wall_min stays 5 (honest duration ~44s)");
  });

  it("tier2-traceability.md carries the S34 disposition citing all three rerun campaign ids with the per-cell decision", () => {
    const doc = fs.readFileSync(traceabilityDoc, "utf8");
    assert.match(
      doc,
      /S34 caps-vs-honest-duration disposition \(US-003/,
      "traceability must carry the S34 caps-vs-honest-duration disposition section",
    );
    for (const [id, meta] of Object.entries(DEADLINE_CELLS)) {
      assert.ok(
        doc.includes(meta.campaign),
        `S34 disposition must cite the rerun campaign for ${id}: ${meta.campaign}`,
      );
      assert.match(doc, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `S34 disposition must name ${id}`);
    }
    for (const [id, decision] of Object.entries(DECISIONS)) {
      const label = decision === "recalibrated" ? "RECALIBRATED" : "NO RECALIBRATION";
      assert.ok(
        doc.includes(label),
        `S34 disposition must record the "${label}" decision for ${id}`,
      );
    }
  });

  it("the traceability caps-table rows match the manifest (no table drift)", () => {
    const records = loadJsonl(tier2Manifest);
    const doc = fs.readFileSync(traceabilityDoc, "utf8");
    // Each deadline cell's Token Budget Note row must show the manifest's
    // wall_min and token cap, and carry the S34 annotation. The token-budget
    // tables use the DISPLAY id (short form for the section-A/B+G rows).
    const expected: Record<string, { display: string; tokens: string; wall: string }> = {
      "W4.10-kill-daemon": { display: "W4.10-kill-daemon", tokens: "1,000,000", wall: "55" },
      "W4.37-keyline-spoof-repo-content": { display: "W4.37", tokens: "200,000", wall: "10" },
      "W4.48a-daemon-kill-mid-park": { display: "W4.48a", tokens: "1,000,000", wall: "55" },
      "W4.dsh-do-now": { display: "W4.dsh-do-now", tokens: "200,000", wall: "10" },
    };
    for (const [id, expect] of Object.entries(expected)) {
      const record = recordById(records, id);
      const row = new RegExp(
        `^\\| ${expect.display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| ${expect.tokens} \\| ${expect.wall} \\|`,
        "m",
      );
      assert.match(doc, row, `traceability caps-table must carry ${id} (${expect.display}) at ${expect.tokens}/${expect.wall} (manifest match)`);
      assert.equal(record.caps.tokens, Number(expect.tokens.replace(/,/g, "")), `${id}: manifest tokens`);
      assert.equal(record.caps.wall_min, Number(expect.wall), `${id}: manifest wall_min`);
    }
  });

  it("caps-calibration.md carries the tier-2 S34 section with W4.37's New value matching the manifest", () => {
    const doc = fs.readFileSync(calibrationDoc, "utf8");
    assert.match(doc, /Tier-2 S34 cap recalibration/, "caps-calibration.md must carry the tier-2 S34 section");
    const w437 = recordById(loadJsonl(tier2Manifest), "W4.37-keyline-spoof-repo-content");
    // The tier-2 changed-caps row (distinct header — never merged into the
    // tier-1 table pinned by tier1-cap-calibration.test.ts).
    const row = new RegExp(
      `^\\| W4\\.37-keyline-spoof-repo-content \\| caps\\.wall_min \\| 5 \\| ${w437.caps.wall_min} \\|`,
      "m",
    );
    assert.match(doc, row, "caps-calibration.md tier-2 table must carry W4.37 wall_min 5 -> 10");
  });

  it("impl-tasks/S32-37-rerun-residue.md's S34 section records the US-003 analysis (no longer 'remaining')", () => {
    const doc = fs.readFileSync(implTaskDoc, "utf8");
    assert.match(doc, /US-003 \(landed\): the caps-vs-honest-duration analysis/, "S34 section must record the US-003 analysis");
    assert.ok(
      !/Remaining for US-003/.test(doc),
      "S34 section must no longer say the caps analysis is 'remaining'",
    );
    assert.match(doc, /W4\.37-keyline-spoof-repo-content — RECALIBRATED \(wall_min 5 → 10\)/, "impl-task must record the W4.37 recalibration");
    assert.match(doc, /NO\s*\n?\s*RECALIBRATION/, "impl-task must record the no-recalibration decision");
  });
});
