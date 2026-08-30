// Tier-2 US-005: section-B (moving targets & rugpull) + section-G
// (composition & resume) roster.
//
// Pins the section-B/G batch of cases/tier2.jsonl:
//   * the manifest exists with the 11 section-B/G rows and
//     tt-controller --manifest cases/tier2.jsonl --validate-only exits 0;
//   * W4.08's two variants (no-relaunch flag / control) are DISTINCT rows
//     carrying opposite no_relaunch_upon_rugpull context values; W4.06/07
//     are fdmw rows with wall caps at/above the family p50 138-min floor;
//   * W4.33's four resume legs (a daemon-restart, b update-under-it,
//     c deleted-worktree refusal, d reroute-exhaustion) and W4.48's three
//     composed-fault arms (a daemon-kill mid-PARK, b pause-rugpull-window,
//     c compound gate degradation) are each represented by a manifest row,
//     with the exclusive-window sequencing note in the task text;
//   * every workflow-launching case carries context.test_cmd matching its
//     fixture's canonical TEST_CMD (incl. tt-go "go test ./...");
//   * every bug-fix case's seed exists in the fixture SEEDS.md catalog and
//     its task names the seeded defect; the fdmw rows carry probe_id
//     FEAT-G1/FEAT-G2 documented in the tt-go FIXTURE.md feature backlog;
//   * E3.D floors + caps (fdmw p50 138-min floor / p95 2.5M; bfmw p50
//     35-min floor / p95 1M);
//   * traceability rows appended for sections B and G (case -> spec_ref ->
//     expectation) and both exclusion enumerations present.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");

// The canonical per-fixture TEST_CMD, verified against each fixture's
// FIXTURE.md (tt-go: "go test ./..." per its TEST_CMD section).
const FIXTURE_TEST_CMD: Record<string, string> = {
  "tt-ts": "npm test",
  "tt-go": "go test ./...",
  "tt-poly": "./run-all-tests",
};

// The 11 section-B/G cases (spec 08 §B + §G, US-005).
const SECTION_BG_IDS = [
  "W4.06-colleague-rebase",
  "W4.07-conflicting-colleague-commit",
  "W4.08-no-relaunch",
  "W4.08-control",
  "W4.33a-daemon-restart-resume",
  "W4.33b-update-under-it-resume",
  "W4.33c-deleted-worktree-refusal",
  "W4.33d-reroute-exhaustion-resume",
  "W4.48a-daemon-kill-mid-park",
  "W4.48b-pause-rugpull-window",
  "W4.48c-compound-gate-degradation",
];

// Bug-fix (bfmw) section-B/G cases — seed must exist in the fixture SEEDS.md
// catalog AND the task text must name the seeded defect.
const SEEDED_CASES: Record<string, { fixture: string; seed: string }> = {
  "W4.08-no-relaunch": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.08-control": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.33a-daemon-restart-resume": { fixture: "tt-ts", seed: "BUG-T3" },
  "W4.33b-update-under-it-resume": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.33c-deleted-worktree-refusal": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.33d-reroute-exhaustion-resume": { fixture: "tt-ts", seed: "BUG-T4" },
  "W4.48a-daemon-kill-mid-park": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.48b-pause-rugpull-window": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.48c-compound-gate-degradation": { fixture: "tt-poly", seed: "POLY-BUG-T1" },
};

// fdmw rows carry probe_id (the tier1 fdmw pattern) — the FEAT-* feature
// backlog is documented in the fixture FIXTURE.md, not SEEDS.md.
const FDMW_FEATURES: Record<string, string> = {
  "W4.06-colleague-rebase": "FEAT-G1",
  "W4.07-conflicting-colleague-commit": "FEAT-G2",
};

type Case = Record<string, any>;

function readManifest(): Case[] {
  const source = fs.readFileSync(manifestPath, "utf8");
  const records: Case[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function readSeedsMd(fixture: string): string {
  return fs.readFileSync(path.join(ttRoot, "fixtures-src", fixture, "seeds", "SEEDS.md"), "utf8");
}

function readFixtureMd(fixture: string): string {
  return fs.readFileSync(path.join(ttRoot, "fixtures-src", fixture, "FIXTURE.md"), "utf8");
}

// A seed is in the catalog iff the SEEDS.md has a heading `### <seed>` (the
// catalog's entry format for both tt-ts and tt-poly).
function seedInCatalog(seedsMd: string, seed: string): boolean {
  const escaped = seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^###\\s+${escaped}\\b`, "m").test(seedsMd);
}

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

describe("Tier-2 US-005 — section-B/G roster (moving targets & rugpull + composition & resume)", () => {
  it("cases/tier2.jsonl contains the 11 section-B/G cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_BG_IDS) {
      assert.ok(ids.includes(id), `section-B/G case ${id} must be present`);
    }
    // Exactly the 11 new rows beyond section A (checked in the section-A test).
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("W4.08's two variants are distinct rows with opposite no_relaunch_upon_rugpull context", () => {
    const records = readManifest();
    const flag = recordById(records, "W4.08-no-relaunch");
    const control = recordById(records, "W4.08-control");
    assert.equal(flag.context.no_relaunch_upon_rugpull, "true",
      "W4.08-no-relaunch must launch with no_relaunch_upon_rugpull=true (the --no-relaunch-upon-rugpull flag corridor)");
    assert.equal(control.context.no_relaunch_upon_rugpull, "false",
      "W4.08-control must launch with no_relaunch_upon_rugpull=false (the product default corridor)");
    assert.equal(flag.workflow, "bug-fix-merge-worktree", "W4.08 rows are bfmw per spec 08 §B W4.08");
    assert.equal(control.workflow, "bug-fix-merge-worktree", "W4.08 rows are bfmw per spec 08 §B W4.08");
    // Both rows carry the target-move corridor documented as a machinery delta
    // (chaos:null) — never a silent trim.
    assert.equal(flag.chaos, null, "W4.08-no-relaunch injection (target move) is a documented machinery delta");
    assert.equal(control.chaos, null, "W4.08-control injection (target move) is a documented machinery delta");
  });

  it("W4.06/07 are fdmw rows on tt-go with wall caps at/above the family p50 138-min floor", () => {
    const records = readManifest();
    for (const [id, feature] of Object.entries(FDMW_FEATURES)) {
      const record = recordById(records, id);
      assert.equal(record.workflow, "feature-dev-merge-worktree", `${id} must be an fdmw (feature-dev-merge-worktree) case`);
      assert.equal(record.fixture, "tt-go", `${id} must run on the tt-go fixture (Tier-2 fdmw) — the go toolchain absence gates NOT_RUN(predicate) honestly`);
      assert.ok(record.caps.wall_min >= 138,
        `${id}: fdmw wall cap must be at/above the family p50 138-min floor (got ${record.caps.wall_min})`);
      assert.ok(record.caps.tokens >= 2500000,
        `${id}: fdmw token cap must sit at family p95 2.5M, never below p50 (got ${record.caps.tokens})`);
      assert.equal(record.probe_id, feature, `${id} must declare probe_id ${feature}`);
      assert.deepEqual(record.requires.toolchains, ["go"],
        `${id}: requires must gate honestly on the go toolchain (host-profile toolchains.go.present)`);
      // The feature is documented in the tt-go FIXTURE.md feature backlog.
      assert.match(readFixtureMd("tt-go"), new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `tt-go FIXTURE.md must document ${feature} in its Seeded Features catalog`);
      // The rebase-loopback / conflict-corridor expectations live in the task.
      const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
      assert.match(task, /FEAT-/, `${id}: task must name its FEAT-* feature`);
      assert.ok(task.includes("colleague"), `${id}: task must describe the colleague-commit injection`);
    }
  });

  it("W4.33's four resume legs and W4.48's three composed-fault arms are each manifest rows with the exclusive-window note in task text", () => {
    const records = readManifest();
    const w433 = ["W4.33a-daemon-restart-resume", "W4.33b-update-under-it-resume",
      "W4.33c-deleted-worktree-refusal", "W4.33d-reroute-exhaustion-resume"];
    const w448 = ["W4.48a-daemon-kill-mid-park", "W4.48b-pause-rugpull-window",
      "W4.48c-compound-gate-degradation"];
    for (const id of [...w433, ...w448]) {
      const record = recordById(records, id);
      assert.match(record.spec_ref, /#W4\.(33|48)$/, `${id}: spec_ref must point at the W4.33/W4.48 spec section`);
    }
    // W4.33a (daemon restart) and all three W4.48 arms carry the exclusive-
    // window + (for W4.48) single-fault-ancestors-green sequencing notes.
    for (const id of ["W4.33a-daemon-restart-resume", ...w448]) {
      const task = fs.readFileSync(path.join(ttRoot, recordById(records, id).task), "utf8");
      assert.match(task, /[Ee]xclusive (scheduling )?window/, `${id}: task text must carry the exclusive-window sequencing note`);
    }
    for (const id of w448) {
      const task = fs.readFileSync(path.join(ttRoot, recordById(records, id).task), "utf8");
      assert.match(task, /single-fault ancestor/i, `${id}: task text must require its single-fault ancestors green (composed-fault discipline)`);
    }
    // The resume legs carry probe sequences where the corridor is expressible:
    // a/b pause(+drain)+resume, d resume-on-failure; c is operator-choreographed
    // (no typed op for worktree deletion) and documents the refusal in text.
    const w433a = recordById(records, "W4.33a-daemon-restart-resume");
    const opsA = w433a.probe_sequence[0].actions.map((action: any) => action.op);
    assert.deepEqual(opsA, ["pause_drain", "resume"], "W4.33a probe ops must be pause_drain then resume");
    assert.equal(w433a.probe_sequence[0].actions[0].when, "step:fixer:running",
      "W4.33a pause_drain must arm on the bfmw coding step (S29 calibration, US-002: step:developer:running is not bfmw vocabulary)");
    assert.equal(w433a.probe_sequence[0].actions[0].hold_seconds, 600,
      "W4.33a pause_drain must keep the declared 600s hold (never weakened)");
    const w433b = recordById(records, "W4.33b-update-under-it-resume");
    const opsB = w433b.probe_sequence[0].actions.map((action: any) => action.op);
    assert.deepEqual(opsB, ["pause", "resume"], "W4.33b probe ops must be pause then resume");
    assert.equal(w433b.probe_sequence[0].actions[0].when, "step:fixer:running",
      "W4.33b pause must arm on the bfmw coding step (S29 calibration, US-002: step:developer:running is not bfmw vocabulary)");
    assert.equal(w433b.probe_sequence[0].actions[0].hold_seconds, 600,
      "W4.33b pause must keep the declared 600s hold (never weakened)");
    const w433d = recordById(records, "W4.33d-reroute-exhaustion-resume");
    assert.equal(w433d.probe_sequence[0].actions[0].op, "resume", "W4.33d probe op must be resume");
    assert.equal(w433d.probe_sequence[0].actions[0].when, "event:run.failed",
      "W4.33d resume must arm on the run's permanent failure (reroute exhaustion)");
    assert.equal(w433d.probe_sequence[0].actions[0].expect?.run_completes, true,
      "W4.33d resume must expect the run to complete");
    // W4.48b arms its pause on the real merge.target_moved event (the rugpull
    // window) and is a characterization corridor.
    const w448b = recordById(records, "W4.48b-pause-rugpull-window");
    assert.equal(w448b.class, "characterization", "W4.48b is the one-of-two characterization corridor");
    assert.equal(w448b.probe_sequence[0].actions[0].op, "pause", "W4.48b probe op must be pause");
    assert.equal(w448b.probe_sequence[0].actions[0].when, "event:merge.target_moved",
      "W4.48b pause must arm on target-moved detection (between detection and the relaunch decision)");
    assert.ok(!w448b.oracles.includes("O16"),
      "W4.48b must not declare O16 (its resume-completes leg cannot judge the {relaunch, paused-no-relaunch} branch)");
    // W4.48c is the compound: typed delete-tstx-row + drain barrier + slow-suite
    // sizing; W4.48a is the typed kill-daemon chaos block.
    const w448c = recordById(records, "W4.48c-compound-gate-degradation");
    assert.equal(w448c.chaos.type, "delete-tstx-row", "W4.48c must carry the typed evidence-deletion chaos block");
    assert.equal(w448c.chaos.trigger, "step:finalize_merge:pending", "W4.48c delete arms at finalize pending under the drain");
    assert.ok(w448c.caps.wall_min >= 150,
      "W4.48c wall cap must cover the slow suite + 40-min drain hold + reroute re-verify (compound corridor)");
    const w448a = recordById(records, "W4.48a-daemon-kill-mid-park");
    assert.equal(w448a.chaos.type, "kill-daemon", "W4.48a must carry the typed kill-daemon chaos block");
  });

  it("every workflow-launching section-B/G case has context.test_cmd matching its fixture's canonical TEST_CMD", () => {
    const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
    let workflowCases = 0;
    for (const record of readManifest()) {
      if (!SECTION_BG_IDS.includes(record.id)) continue;
      if (!REAL_HARNESSES.has(record.harness)) continue;
      if (record.workflow === "local") continue;
      workflowCases += 1;
      const canonical = FIXTURE_TEST_CMD[record.fixture];
      assert.ok(canonical, `${record.id}: fixture ${record.fixture} has no canonical TEST_CMD in the test map`);
      assert.equal(record.context?.test_cmd, canonical,
        `${record.id}: context.test_cmd must be the fixture's canonical TEST_CMD (${canonical}), got ${JSON.stringify(record.context?.test_cmd)}`);
    }
    assert.equal(workflowCases, 11, "all 11 section-B/G cases are workflow-launching real cases");
  });

  it("every bug-fix section-B/G case's seed exists in the fixture SEEDS.md catalog and its task names the seeded defect", () => {
    for (const [caseId, { fixture, seed }] of Object.entries(SEEDED_CASES)) {
      const record = recordById(readManifest(), caseId);
      assert.equal(record.seed, seed, `${caseId} must declare seed ${seed}`);
      const seedsMd = readSeedsMd(fixture);
      assert.ok(seedInCatalog(seedsMd, seed), `${caseId}: seed ${seed} must exist in ${fixture} SEEDS.md catalog`);
      const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
      assert.match(task, new RegExp(seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${caseId}: task file must name the seeded defect (seed ${seed})`);
    }
  });

  it("E3.D calibration holds for the section-B/G rows (floors never below family p50)", () => {
    for (const record of readManifest()) {
      if (!SECTION_BG_IDS.includes(record.id)) continue;
      assert.ok(record.caps.wall_min > 0 && record.caps.tokens > 0, `${record.id}: real case caps must be positive`);
      assert.ok(record.production_duration_floor_ms > 0,
        `${record.id}: must carry production_duration_floor_ms (E3.D calibration record)`);
      if (record.workflow === "bug-fix-merge-worktree") {
        assert.ok(record.caps.wall_min >= 35,
          `${record.id}: bfmw wall cap at/above the family p50 35-min floor (got ${record.caps.wall_min})`);
        assert.ok(record.caps.tokens >= 1000000,
          `${record.id}: bfmw token cap at family p95 1M (got ${record.caps.tokens})`);
      }
    }
  });

  it("traceability rows exist for sections B and G (case -> spec_ref -> expectation)", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    for (const id of SECTION_BG_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    assert.match(trace, /Wave 4 Section B \(moving targets & rugpull\)/, "section-B reference map header");
    assert.match(trace, /Wave 4 Section G \(composition & resume\)/, "section-G reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section B\)/, "section-B exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section G\)/, "section-G exclusion enumeration");
    // Every section-B/G row carries spec_ref into the spec file.
    for (const record of readManifest()) {
      if (!SECTION_BG_IDS.includes(record.id)) continue;
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${record.id}: spec_ref into 08-wave-4-fault-injection.md`);
    }
  });

  it("task files exist for all 11 section-B/G cases under cases/tasks/tier2/ and describe the fixture's actual contents", () => {
    for (const record of readManifest()) {
      if (!SECTION_BG_IDS.includes(record.id)) continue;
      assert.equal(typeof record.task, "string", `${record.id}: task path required`);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${record.id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${record.id}: task file must exist as a regular file`);
      const task = fs.readFileSync(taskPath, "utf8");
      assert.ok(task.trim().length > 0, `${record.id}: task file must be non-empty`);
      assert.match(task, new RegExp(record.fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${record.id}: task must describe the ${record.fixture} fixture's actual contents`);
    }
  });
});
