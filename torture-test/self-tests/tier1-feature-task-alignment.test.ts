// E3.A US-013 — Task-text alignment: feature-case tasks must describe the
// features their declared probes verify (same phantom-text class as S2, on
// the feature side).
//
// The four tier1 feature cases carried task texts that described DIFFERENT
// features than their declared probe_id verifies (e.g. W3.04 described a
// recurring-expense feature while its probe FEAT-T3 checks the CSV export
// endpoint). This test pins the corrected correspondence:
//   * each rewritten task's acceptance criteria cover its probe's check
//     list (mechanical grep correspondence, per probe.sh);
//   * probe.sh files are UNCHANGED (sha256 pins) and the four manifest
//     lines are byte-identical (no probes/, seeds/, or tier1.jsonl edits);
//   * each task keeps its lifecycle-probe framing and story-count sizing
//     notes (pause-no-drain / pause-drain / fail-force-resume / fdmw
//     cross-cutting ≥5-file planner note);
//   * the phantom feature tokens from the old texts are gone;
//   * the tier1 manifest still validates through the PRODUCTION
//     controller --validate-only path (28 cases).
//
// Confined to torture-test/. Zero tokens. Read-only except the validation
// run (which writes nothing).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier1");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");

const W304_ID = "W3.04-fdmw-pi-ts";
const W318_ID = "W3.18-pause-no-drain";
const W319_ID = "W3.19-pause-drain";
const W321_ID = "W3.21-fail-force-resume";

const task = (id: string) => fs.readFileSync(path.join(tasksDir, `${id}.md`), "utf8");
const probe = (probeId: string) => fs.readFileSync(path.join(ttRoot, "probes", "tt-ts", probeId, "probe.sh"), "utf8");

// Byte-exact manifest lines from the pre-US-013 tier1.jsonl. The story must
// NOT touch tier1.jsonl — any drift (probe_id, task path, test_cmd, ...)
// fails these pins. (Same established pattern as the W1.REPLAY-* pins.)
const W304_LINE = `{"id":"W3.04-fdmw-pi-ts","wave":3,"workflow":"feature-dev-merge-worktree","fixture":"tt-ts","harness":"pi","task":"cases/tasks/tier1/W3.04-fdmw-pi-ts.md","context":{"execution_mode":"real","test_cmd":"npm test"},"caps":{"tokens":2500000,"wall_min":30},"requires":{"toolchains":["node"],"node_min":22},"boundary_files":["fixtures-src/tt-ts/src"],"forbidden":["fixtures-src/tt-ts/operator-notes.local"],"oracles":["O1","O2","O3z","O4","O8","O9","O10","O11","O16"],"probe_id":"FEAT-T3","gates":["TIER1","W3"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"07-wave-3-harness-duel.md#W3.04","production_duration_floor_ms":600000}`;
const W318_LINE = `{"id":"W3.18-pause-no-drain","wave":3,"workflow":"feature-dev-merge-worktree","fixture":"tt-ts","harness":"pi","task":"cases/tasks/tier1/W3.18-pause-no-drain.md","context":{"execution_mode":"real","test_cmd":"npm test"},"caps":{"tokens":500000,"wall_min":20},"requires":{"toolchains":["node"],"node_min":22},"boundary_files":["fixtures-src/tt-ts/src"],"forbidden":["fixtures-src/tt-ts/operator-notes.local"],"oracles":["O1","O2","O3z","O4","O8","O9","O10","O11","O16"],"probe_id":"FEAT-T1","gates":["TIER1","W3"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"07-wave-3-harness-duel.md#W3.18","production_duration_floor_ms":120000}`;
const W319_LINE = `{"id":"W3.19-pause-drain","wave":3,"workflow":"feature-dev-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"cases/tasks/tier1/W3.19-pause-drain.md","context":{"execution_mode":"real","test_cmd":"npm test"},"caps":{"tokens":1000000,"wall_min":20},"requires":{"toolchains":["node"],"capabilities":["hermes"],"node_min":22},"boundary_files":["fixtures-src/tt-ts/src"],"forbidden":["fixtures-src/tt-ts/operator-notes.local"],"oracles":["O1","O2","O3z","O4","O8","O9","O10","O11","O16"],"probe_id":"FEAT-T2","gates":["TIER1","W3"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"07-wave-3-harness-duel.md#W3.19","production_duration_floor_ms":120000}`;
const W321_LINE = `{"id":"W3.21-fail-force-resume","wave":3,"workflow":"feature-dev-merge-worktree","fixture":"tt-ts","harness":"pi","task":"cases/tasks/tier1/W3.21-fail-force-resume.md","context":{"execution_mode":"real","test_cmd":"npm test"},"caps":{"tokens":1000000,"wall_min":20},"requires":{"toolchains":["node"],"node_min":22},"boundary_files":["fixtures-src/tt-ts/src"],"forbidden":["fixtures-src/tt-ts/operator-notes.local"],"oracles":["O1","O2","O3z","O4","O8","O9","O10","O11","O16"],"probe_id":"FEAT-T4","gates":["TIER1","W3"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"07-wave-3-harness-duel.md#W3.21","production_duration_floor_ms":120000}`;

const MANIFEST_PINS = [
  [W304_ID, W304_LINE],
  [W318_ID, W318_LINE],
  [W319_ID, W319_LINE],
  [W321_ID, W321_LINE],
] as const;

// sha256 of each probe.sh at US-013 time — the story must not modify probe
// files; these pins fail the moment any of them drifts.
const PROBE_SHA256 = {
  "FEAT-T1": "4d412a75410544d1d0d7b6c413bf04d6997c339a5d153a54e4e65e382ba86125",
  "FEAT-T2": "0018186bc73cefa0e40a237181cc1577ff5a68e6f24541e0c5c50f9f10f4b800",
  "FEAT-T3": "7689bc802fc03dbbdbaa86bc4d48b4ebdec90a5793773b7d91f944e7a268e198",
  "FEAT-T4": "5609bf0a094756085998b1a422f0573d6862c9fd94ff43e6a13c21b5687263a6",
} as const;

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readTier1Lines(): string[] {
  return fs.readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

describe("Feature-case task text ↔ probe alignment (E3.A US-013)", () => {
  it("tier1.jsonl keeps 28 lines and the four case lines are byte-identical", () => {
    const lines = readTier1Lines();
    assert.equal(lines.length, 28, "tier1 manifest must keep 28 lines");
    for (const [id, pinned] of MANIFEST_PINS) {
      const actual = lines.find((l) => l.includes(`"id":"${id}"`));
      assert.ok(actual, `manifest must contain ${id}`);
      assert.equal(actual, pinned, `${id} manifest line must be byte-identical (no tier1.jsonl changes in US-013)`);
    }
  });

  it("the four probe.sh files are unchanged (sha256 pins)", () => {
    for (const [probeId, expected] of Object.entries(PROBE_SHA256)) {
      const p = path.join(ttRoot, "probes", "tt-ts", probeId, "probe.sh");
      const actual = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      assert.equal(actual, expected, `probes/tt-ts/${probeId}/probe.sh must be unchanged`);
    }
  });

  it("W3.04 task (FEAT-T3) describes the CSV export feature and none of the old recurring-feature tokens", () => {
    const t = task(W304_ID);
    const p = probe("FEAT-T3");
    // Endpoint + content type + header + escaping — the probe's hard checks.
    assert.match(t, /src\/server\.ts/, "task must name src/server.ts");
    assert.match(t, /GET \/api\/expenses\/export/, "task must name the export endpoint");
    assert.match(t, /text\/csv/, "task must require the text/csv Content-Type");
    assert.match(t, /id,description,amount,category,date/, "task must pin the CSV header row");
    assert.match(t, /escaping/, "task must require CSV escaping");
    assert.match(t, /double quotes?|comma/, "task must describe comma/quote escaping");
    // Download button — the probe's hard frontend check.
    assert.match(t, /public\/index\.html/, "task must name public/index.html");
    assert.match(t, /public\/app\.js/, "task must name public/app.js");
    assert.match(t, /download/i, "task must require a download button");
    assert.match(t, /\.csv/, "task must name the .csv download");
    // FEAT-T3-tagged tests — the probe runs --test-name-pattern export|FEAT-T3|csv.
    assert.match(t, /FEAT-T3/, "task must instruct FEAT-T3-tagged tests");
    assert.match(t, /export/, "task must cover export tests");
    // Cross-cutting ≥5-file fdmw framing (planner note) kept.
    assert.match(t, /cross-cutting ≥5-file feature/, "task must keep the ≥5-file framing");
    assert.match(t, /planner/, "task must keep the fdmw planner note");
    assert.match(t, /npm test/, "task must state the suite command npm test");
    // Probe agreement (the probe checks what the task describes).
    assert.match(p, /\/api\/expenses\/export/, "probe must check the export endpoint");
    assert.match(p, /text\/csv/, "probe must check text/csv");
    assert.match(p, /download/, "probe must check the download button");
    assert.match(p, /FEAT-T3/, "probe must gate on FEAT-T3-tagged tests");
    // Phantom tokens from the old recurring-expense text are gone.
    for (const token of ["generateOccurrences", "weekly", "yearly", "Recurring Expense Support"]) {
      assert.ok(!t.includes(token), `task must not mention phantom token ${JSON.stringify(token)}`);
    }
  });

  it("W3.18 task (FEAT-T1) describes custom categories and keeps the pause-no-drain framing", () => {
    const t = task(W318_ID);
    const p = probe("FEAT-T1");
    // Category management — the probe's hard grep surface.
    assert.match(t, /addCategory/, "task must name addCategory");
    assert.match(t, /renameCategory/, "task must name renameCategory");
    assert.match(t, /removeCategory/, "task must name removeCategory");
    assert.match(t, /filter dropdown/, "task must require new categories in the filter dropdown");
    // Backing API endpoints.
    assert.match(t, /src\/server\.ts/, "task must name src/server.ts");
    assert.match(t, /GET \/api\/categories/, "task must name the category list endpoint");
    assert.match(t, /POST \/api\/categories/, "task must name the category add endpoint");
    assert.match(t, /PUT \/api\/categories/, "task must name the category rename endpoint");
    assert.match(t, /DELETE \/api\/categories/, "task must name the category remove endpoint");
    assert.match(t, /public\/index\.html/, "task must name public/index.html");
    assert.match(t, /public\/app\.js/, "task must name public/app.js");
    // FEAT-T1-tagged category tests — the probe runs --test-name-pattern category.
    assert.match(t, /FEAT-T1/, "task must instruct FEAT-T1-tagged tests");
    assert.match(t, /npm test/, "task must state the suite command npm test");
    // Lifecycle framing: pause without drain, 10-minute hold, resume.
    assert.match(t, /pause the daemon without drain/, "task must keep the pause-no-drain probe sequence");
    assert.match(t, /hold for 10 minutes/, "task must keep the 10-minute hold");
    assert.match(t, /then resume/, "task must keep the resume step");
    assert.match(t, /single implement story/, "task must keep the single-story sizing note");
    // Probe agreement.
    assert.match(p, /addCategory|newCategory/, "probe must check category management code");
    assert.match(p, /dropdown/, "probe must check category dropdown elements");
    assert.match(p, /categories/, "probe must check category endpoints");
    assert.match(p, /FEAT-T1/, "probe must gate on FEAT-T1-tagged tests");
    // Phantom tokens from the old date-range-filtering text are gone.
    assert.ok(!t.includes("getByDateRange"), "task must not mention phantom getByDateRange");
    assert.ok(!t.includes("Date Range"), "task must not keep the phantom date-range feature title");
  });

  it("W3.19 task (FEAT-T2) describes the Canvas dashboard and keeps the pause-drain framing", () => {
    const t = task(W319_ID);
    const p = probe("FEAT-T2");
    // Dashboard + Canvas bar chart — the probe's hard checks.
    assert.match(t, /dashboard/i, "task must describe the dashboard");
    assert.match(t, /Canvas API/, "task must require the Canvas API");
    assert.match(t, /getContext\('2d'\)/, "task must require getContext('2d') drawing");
    assert.match(t, /bar chart/, "task must require a bar chart");
    assert.match(t, /month navigation/i, "task must require month navigation");
    assert.match(t, /previous\/next month/, "task must describe previous/next month controls");
    // No chart library — the probe's hard fail check.
    for (const lib of ["Chart.js", "chartjs", "d3.js", "highcharts", "plotly"]) {
      assert.match(t, new RegExp(lib, "i"), `task must forbid the ${lib} chart library`);
    }
    // FEAT-T2-tagged tests — the probe runs --test-name-pattern dashboard|FEAT-T2|chart|canvas.
    assert.match(t, /FEAT-T2/, "task must instruct FEAT-T2-tagged tests");
    assert.match(t, /npm test/, "task must state the suite command npm test");
    // Lifecycle framing: drain lets the in-flight story complete, no wedge,
    // resume dispatches the next story.
    assert.match(t, /drain/i, "task must keep the drain framing");
    assert.match(t, /draining_pause wedge/, "task must keep the draining_pause wedge note");
    assert.match(t, /Resume dispatches the next story/, "task must keep the resume-dispatch framing");
    assert.match(t, /2-3 stories/, "task must keep the 2-3 story sizing note");
    // Probe agreement.
    assert.match(p, /dashboard/, "probe must check the dashboard");
    assert.match(p, /Canvas API/, "probe must check Canvas API usage");
    assert.match(p, /month.*navigat/, "probe must check month navigation");
    assert.match(p, /chart\.js|chartjs|d3\.js|highcharts|plotly/, "probe must forbid external chart libraries");
    assert.match(p, /FEAT-T2/, "probe must gate on FEAT-T2-tagged tests");
    // Phantom tokens from the old stats-summary text are gone.
    assert.ok(!t.includes("getStats"), "task must not mention phantom getStats");
    assert.ok(!t.includes("--stats"), "task must not mention the phantom --stats flag");
    assert.ok(!t.includes("Statistics Summary"), "task must not keep the phantom stats title");
  });

  it("W3.21 task (FEAT-T4) describes recurring monthly expenses and keeps the fail-force/resume framing", () => {
    const t = task(W321_ID);
    const p = probe("FEAT-T4");
    // Recurring flag on the model — the probe's hard types.ts check.
    assert.match(t, /src\/types\.ts/, "task must name src/types.ts");
    assert.match(t, /recurring/, "task must require a recurring field on the Expense model");
    // Generation endpoint + idempotency — the story's core requirement.
    assert.match(t, /src\/server\.ts/, "task must name src/server.ts");
    assert.match(t, /POST \/api\/expenses\/recurring\/generate/, "task must name the recurring generation endpoint");
    assert.match(t, /idempotent/i, "task must require idempotent generation");
    assert.match(t, /calendar month/, "task must scope idempotency to the calendar month");
    assert.match(t, /no duplicate expenses/i, "task must state the no-duplicate guarantee");
    // Frontend indicator + checkbox.
    assert.match(t, /public\/index\.html/, "task must name public/index.html");
    assert.match(t, /public\/app\.js/, "task must name public/app.js");
    assert.match(t, /🔄/, "task must require the 🔄 recurrence indicator");
    assert.match(t, /checkbox/, "task must require a recurring checkbox in the add form");
    // FEAT-T4-tagged tests — the probe runs --test-name-pattern recurring|FEAT-T4.
    assert.match(t, /FEAT-T4/, "task must instruct FEAT-T4-tagged tests");
    assert.match(t, /npm test/, "task must state the suite command npm test");
    // Lifecycle framing: fail --force then resume, same run id/number.
    assert.match(t, /workflow fail --force/, "task must keep the fail --force probe sequence");
    assert.match(t, /workflow resume/, "task must keep the resume probe sequence");
    assert.match(t, /SAME run id and run number/, "task must keep the same-run resume assertion");
    assert.match(t, /2-3 stories/, "task must keep the 2-3 story sizing note");
    // Probe agreement.
    assert.match(p, /src\/types\.ts/, "probe must check src/types.ts");
    assert.match(p, /recurring/, "probe must check the recurring flag");
    assert.match(p, /\/api\/expenses\/recurring\/generate/, "probe must check the generation endpoint");
    assert.match(p, /🔄/, "probe must check the 🔄 indicator");
    assert.match(p, /FEAT-T4/, "probe must gate on FEAT-T4-tagged tests");
    // Phantom tokens from the old budget-tracking text are gone.
    assert.ok(!t.includes("BudgetTracker"), "task must not mention phantom BudgetTracker");
    assert.ok(!t.includes("budget"), "task must not mention the phantom budget feature");
  });

  it("all four tasks keep the forbidden/boundary contract", () => {
    for (const id of [W304_ID, W318_ID, W319_ID, W321_ID]) {
      const t = task(id);
      assert.match(t, /operator-notes\.local/, `${id} must keep the operator-notes.local boundary`);
      assert.match(t, /seeds\//, `${id} must keep the seeds/ boundary`);
      assert.match(t, /probes\//, `${id} must keep the probes/ boundary`);
      assert.match(t, /feature-dev-merge-worktree/, `${id} must stay an fdmw case`);
    }
  });

  it("tier1 manifest with the rewritten task texts validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
