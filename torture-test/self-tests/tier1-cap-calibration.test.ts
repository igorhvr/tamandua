// US-003 — tier1 wall-cap recalibration floors and the caps-calibration.md
// table contract (S8b).
//
// Campaign #7's 10-30min tier1 wall caps cancelled honest runs (S8 backlog,
// campaign-20260813T123604986Z): a cap breach stops the run and files RUNAWAY
// triage, so a cap below the honest duration of its probe sequence destroys
// the case's own evidence. This test pins the recalibration:
//   * every bug-fix-family pi wall cap (workflow bug-fix or
//     bug-fix-merge-worktree under harness pi) is >= 20 minutes;
//   * W3.04-fdmw-pi-ts wall cap is >= 138 minutes, OR the case is
//     marathon-classified with the classification stated in the table;
//   * cases/caps-calibration.md exists, states the family-p95-not-below-p50
//     rule, and has one row per changed cap whose Justification cites a spec
//     section or the campaign backlog, and whose New value MATCHES the
//     manifest (the table cannot drift from tier1.jsonl);
//   * the production controller's --validate-only still accepts the
//     recalibrated manifest (28 cases).
//
// Confined to torture-test/. Zero tokens. No daemons, no launches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const calibrationDoc = path.join(ttRoot, "cases", "caps-calibration.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function loadTier1(): Record<string, any>[] {
  return fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const BUG_FIX_FAMILY_WORKFLOWS = new Set(["bug-fix", "bug-fix-merge-worktree"]);

// Parse the calibration table's data rows: { case, field, old, new, justification }.
interface TableRow {
  caseId: string;
  field: string;
  oldValue: string;
  newValue: string;
  justification: string;
}

function parseTableRows(): TableRow[] {
  const doc = fs.readFileSync(calibrationDoc, "utf8");
  const rows: TableRow[] = [];
  let inTable = false;
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith("| Case | Field |")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (/^\|[- :|]+\|$/.test(line)) continue; // separator row
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    rows.push({
      caseId: cells[0],
      field: cells[1],
      oldValue: cells[2],
      newValue: cells[3],
      justification: cells.slice(4).join(" "),
    });
  }
  return rows;
}

describe("tier1 wall-cap recalibration (US-003 / S8b)", () => {
  it("caps-calibration.md exists and states the family-p95-not-below-p50 rule", () => {
    assert.ok(fs.existsSync(calibrationDoc), "cases/caps-calibration.md must exist");
    const doc = fs.readFileSync(calibrationDoc, "utf8");
    assert.match(doc, /p95/, "table must state the family-p95 rule");
    assert.match(doc, /p50/, "table must state the never-below-p50 rule");
  });

  it("every bug-fix-family pi wall cap in tier1.jsonl is >= 20 minutes", () => {
    const cases = loadTier1();
    const bugFixPi = cases.filter(
      (record) => record.harness === "pi" && BUG_FIX_FAMILY_WORKFLOWS.has(record.workflow),
    );
    assert.ok(bugFixPi.length > 0, "expected at least one bug-fix-family pi case");
    for (const record of bugFixPi) {
      assert.ok(
        record.caps.wall_min >= 20,
        `${record.id}: bug-fix-family pi wall cap ${record.caps.wall_min} < 20 min`,
      );
    }
  });

  it("W3.04-fdmw-pi-ts wall cap is >= 138 or the case is marathon-classified in the table", () => {
    const cases = loadTier1();
    const w304 = cases.find((record) => record.id === "W3.04-fdmw-pi-ts");
    assert.ok(w304, "W3.04-fdmw-pi-ts must be in tier1.jsonl");
    if (w304.caps.wall_min >= 138) return;
    const doc = fs.readFileSync(calibrationDoc, "utf8");
    const marathonClassified =
      /\bmarathon\b/.test(w304.class ?? "") && /W3\.04/.test(doc) && /marathon/.test(doc);
    assert.ok(
      marathonClassified,
      `W3.04 wall cap ${w304.caps.wall_min} < 138 and no marathon classification is stated in the table`,
    );
  });

  it("the calibration table has one row per changed cap, each citing a spec section or the campaign, and each New value matches the manifest", () => {
    const rows = parseTableRows();
    assert.ok(rows.length > 0, "calibration table must have at least one data row");
    const cases = loadTier1();
    const byId = new Map(cases.map((record) => [record.id, record]));

    // The complete set of case ids this story's recalibration touched — the
    // table must cover every one of them.
    const changedCaseIds = [
      "W1.L3-python",
      "W1.L3-ts",
      "W2.22-non-main-bfmw",
      "W2.24-docs-drift",
      "W3.01-bfmw-pi-python",
      "W3.02-bfmw-pi-ts",
      "W3.04-fdmw-pi-ts",
      "W3.18-pause-no-drain",
      "W3.19-pause-drain",
      "W3.20-cancel",
      "W3.21-fail-force-resume",
      "W3.22-daemon-restart",
      "W3.23-token-saver",
    ];
    const coveredIds = new Set(rows.map((row) => row.caseId));
    for (const id of changedCaseIds) {
      assert.ok(coveredIds.has(id), `calibration table must cover changed case ${id}`);
    }

    for (const row of rows) {
      const record = byId.get(row.caseId);
      assert.ok(record, `table row names a case absent from tier1.jsonl: ${row.caseId}`);
      const fieldPath = row.field.split(".");
      assert.ok(
        fieldPath.length === 2 && fieldPath[0] === "caps",
        `table field must be caps.<tokens|wall_min>: ${row.field}`,
      );
      const manifestValue = record.caps[fieldPath[1]];
      assert.equal(
        String(manifestValue),
        row.newValue,
        `${row.caseId} ${row.field}: table says ${row.newValue} but manifest has ${manifestValue}`,
      );
      // Justification must cite a spec section (0N-wave/11-schedule) or the campaign backlog.
      assert.match(
        row.justification,
        /(?:0[5-7]-wave|11-schedule|campaign-)/,
        `${row.caseId} ${row.field}: justification must cite a spec section or campaign-observed duration`,
      );
    }
  });

  it("tt-controller --validate-only accepts the recalibrated tier1 manifest (28 cases)", () => {
    const res = spawnSync(controller, ["--manifest", tier1Manifest, "--validate-only"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(res.status, 0, `validate-only must pass:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
