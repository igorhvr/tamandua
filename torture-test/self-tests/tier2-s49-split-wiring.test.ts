// S49 (US-010) — W4.33d/W4.48b SPLIT wiring pins (fast, zero tokens).
//
// igorhvr's triage (triage-decisions-2026-09-01 item 6 — "Adopt the split")
// splits the two real premise-redesign cells — W4.33d-reroute-exhaustion-
// resume and W4.48b-pause-rugpull-window — whose premises three real-campaign
// redesigns (S29/S36/mac #1) could never fire because the product ABSORBS the
// injected faults gracefully. The split produces, per corridor, an
// absorption-assertion cell AND a directly-constructed-state cell:
//
//   (a) absorption-assertion (reroute/PARK absorbs the injected fault — RED
//       on regression): W4.33d-reroute-absorption, W4.48b-park-absorption;
//   (b) directly-constructed-state (the failure vectors without a race — CLI
//       force-fail then resume; move-target-during-hold seam action):
//       W4.33d-resume-force-fail, W4.48b-move-during-hold.
//
// This file pins the DECLARATIONS (fast, runs in the normal battery):
//   * the retired real rows are GONE from cases/tier2.jsonl and the four
//     split cells exist as SCRIPTED zero-token rows (bare --tier2) with
//     scenario_id/scenario_path into their scenario cells;
//   * the absorption rows declare the typed move-branch REARM chaos on the
//     case's target ref and NO probe sequence;
//   * the constructed-state rows construct their state: W4.33d-resume-force-
//     fail declares fail_force (finalize) -> resume (event:run.force_failed);
//     W4.48b-move-during-hold declares pause (finalize marker, hold) ->
//     resume with the typed move-branch cadence moving DURING the hold;
//   * the task docs describe the split corridors and the W4.48b arms keep
//     the composed-fault discipline (exclusive window + single-fault
//     ancestors green);
//   * each scenario cell exists (scenario.json/behaviors.json/run.sh), its
//     behaviors cover the bfmw agent roster with the merger as a behavior
//     ARRAY, and validate-scenario exits 0;
//   * the traceability S49 section exists and tabulates the split;
//   * tt-controller --validate-only stays green on the full 72-row manifest.
//
// The EXECUTION proofs (each corridor provably runs in bare --tier2 against
// the CONTAINED scripted daemon with probe/chaos evidence and a single
// truthful terminal outcome) live in
// self-tests/tier2-s29-premise-redesign-corridor.test.ts (S49 arm — HEAVY,
// isolated like tier2-s44-operator-seam-corridors).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier2Path = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

// The four S49 split cells and their scenario cells.
const ABSORPTION_CELLS = ["W4.33d-reroute-absorption", "W4.48b-park-absorption"];
const CONSTRUCTED_CELLS = ["W4.33d-resume-force-fail", "W4.48b-move-during-hold"];
const SPLIT_CELLS = [...ABSORPTION_CELLS, ...CONSTRUCTED_CELLS];
const RETIRED_CELLS = ["W4.33d-reroute-exhaustion-resume", "W4.48b-pause-rugpull-window"];
const SEED_BY_CELL: Record<string, string> = {
  "W4.33d-reroute-absorption": "BUG-T4",
  "W4.33d-resume-force-fail": "BUG-T4",
  "W4.48b-park-absorption": "BUG-T2",
  "W4.48b-move-during-hold": "BUG-T2",
};
const REF_BY_CELL: Record<string, string> = {
  "W4.33d-reroute-absorption": "refs/heads/seed/BUG-T4",
  "W4.33d-resume-force-fail": "refs/heads/seed/BUG-T4",
  "W4.48b-park-absorption": "refs/heads/seed/BUG-T2",
  "W4.48b-move-during-hold": "refs/heads/seed/BUG-T2",
};
const SCENARIO_BY_CELL: Record<string, string> = {
  "W4.33d-reroute-absorption": "w4.33d-reroute-absorption",
  "W4.33d-resume-force-fail": "w4.33d-resume-force-fail",
  "W4.48b-park-absorption": "w4.48b-park-absorption",
  "W4.48b-move-during-hold": "w4.48b-move-during-hold",
};

function tier2Rows(): Record<string, any>[] {
  return fs.readFileSync(tier2Path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function row(id: string): Record<string, any> {
  const found = tier2Rows().find((r) => r.id === id);
  assert.ok(found, `${id} must exist in tier2.jsonl`);
  return found;
}

function run(file: string, args: string[], timeout = 120_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

describe("S49 — W4.33d/W4.48b split wiring (absorption-assertion + directly-constructed-state)", () => {
  it("the retired real premise-redesign rows are gone and the four split cells exist as scripted zero-token rows with scenario cells", () => {
    const records = tier2Rows();
    for (const retired of RETIRED_CELLS) {
      assert.equal(records.some((r) => r.id === retired), false,
        `${retired}: the retired real premise-redesign row must be gone (S49 split)`);
    }
    for (const id of SPLIT_CELLS) {
      const r = row(id);
      assert.equal(r.workflow, "bug-fix-merge-worktree", `${id}: must run bug-fix-merge-worktree`);
      assert.equal(r.fixture, "tt-ts", `${id}: must run on tt-ts`);
      assert.equal(r.seed, SEED_BY_CELL[id], `${id}: must declare seed ${SEED_BY_CELL[id]}`);
      assert.equal(r.harness, "scripted-pi", `${id}: the split cell must be scripted-pi`);
      assert.equal(r.context.execution_mode, "scripted", `${id}: the split cell must be scripted (bare --tier2)`);
      assert.equal(r.caps.tokens, 0, `${id}: the split cell must be zero-token`);
      assert.equal(r.context.scenario_id, SCENARIO_BY_CELL[id], `${id}: scenario_id must match the cell`);
      assert.equal(r.context.scenario_path, `scenarios/${SCENARIO_BY_CELL[id]}`, `${id}: scenario_path must point at the cell`);
      assert.match(String(r.spec_ref), /#W4\.(33|48)$/, `${id}: spec_ref must point at the W4.33/W4.48 spec section`);
      assert.equal(r.mandatory, true, `${id}: mandatory`);
      assert.equal(r.shed_ok, false, `${id}: not shed-ok`);
    }
  });

  it("the absorption cells declare the typed move-branch REARM chaos on the case's target ref and NO probe sequence", () => {
    for (const id of ABSORPTION_CELLS) {
      const r = row(id);
      assert.equal(r.probe_sequence, null, `${id}: absorption cell declares no probe sequence`);
      const chaos = r.chaos;
      assert.ok(chaos && typeof chaos === "object", `${id}: the absorption cell must carry the typed move-branch chaos`);
      assert.equal(chaos.type, "move-branch", `${id}: typed injection must be move-branch`);
      assert.equal(chaos.target, "origin_target_ref", `${id}: move-branch targets the origin target ref`);
      assert.equal(chaos.ref, REF_BY_CELL[id], `${id}: move ref must be ${REF_BY_CELL[id]} (the merger's merge target)`);
      assert.equal(chaos.trigger, "step:finalize_merge:running", `${id}: arming on the finalize step`);
      assert.equal(chaos.rearm, true, `${id}: per-attempt re-arm mode (each fresh finalize attempt observes a moved tip)`);
      assert.ok(Number.isInteger(chaos.rearm_hold_s) && (chaos.rearm_hold_s as number) > 0,
        `${id}: the post-marker re-arm hold must be positive`);
      assert.equal(r.class, "verification", `${id}: the absorption pin is a verification cell`);
    }
  });

  it("the directly-constructed-state cells build their state without a race: CLI force-fail then resume; pause then move-during-hold then resume", () => {
    const force = row("W4.33d-resume-force-fail");
    assert.equal(force.chaos.type ?? null, null,
      "W4.33d-resume-force-fail: no chaos — the failure is constructed with the CLI force-fail");
    const forceActions = force.probe_sequence[0].actions;
    assert.equal(forceActions.length, 2, "W4.33d-resume-force-fail: fail_force -> resume");
    assert.equal(forceActions[0].op, "fail_force", "W4.33d-resume-force-fail: the CLI force-fail probe op");
    assert.equal(forceActions[0].when, "step:finalize_merge:running",
      "W4.33d-resume-force-fail: the force-fail arms on the finalize step");
    assert.equal(forceActions[1].op, "resume", "W4.33d-resume-force-fail: the resume probe op");
    assert.equal(forceActions[1].when, "event:run.force_failed",
      "W4.33d-resume-force-fail: the resume arms on the constructed failure event");
    assert.deepEqual(forceActions[1].expect, { run_completes: true },
      "W4.33d-resume-force-fail: the resume expects the same run to complete");
    assert.ok(force.oracles.includes("O16"), "W4.33d-resume-force-fail must declare O16 (resume-completes)");

    const hold = row("W4.48b-move-during-hold");
    assert.equal(hold.class, "characterization", "W4.48b-move-during-hold is the one-of-two characterization corridor");
    const holdActions = hold.probe_sequence[0].actions;
    assert.equal(holdActions.length, 2, "W4.48b-move-during-hold: pause -> resume");
    assert.equal(holdActions[0].op, "pause", "W4.48b-move-during-hold: pause FIRST (the deterministic hold)");
    assert.equal(holdActions[0].when, "step:finalize_merge:running",
      "W4.48b-move-during-hold: the pause arms on the deterministic finalize marker");
    assert.ok(holdActions[0].hold_seconds >= 600,
      "W4.48b-move-during-hold: the hold must be long enough for the during-hold moves");
    assert.equal(holdActions[1].op, "resume", "W4.48b-move-during-hold: resume after the hold");
    assert.equal(hold.chaos.type, "move-branch", "W4.48b-move-during-hold: the typed move-branch chaos");
    assert.equal(hold.chaos.ref, REF_BY_CELL["W4.48b-move-during-hold"],
      "W4.48b-move-during-hold: move ref must be the case's target ref");
    assert.equal(hold.chaos.rearm, undefined,
      "W4.48b-move-during-hold: free-running cadence (moves keep landing DURING the pause hold — no rearm)");
    assert.ok(!hold.oracles.includes("O16"),
      "W4.48b-move-during-hold must not declare O16 (its resume-completes leg cannot judge the {relaunch, paused-no-relaunch} branch)");
  });

  it("the split task docs describe the corridors and the W4.48b arms keep the composed-fault discipline", () => {
    const expectations: Record<string, RegExp> = {
      "W4.33d-reroute-absorption": /absorption/i,
      "W4.33d-resume-force-fail": /fail_force|force-fail/i,
      "W4.48b-park-absorption": /PARK/i,
      "W4.48b-move-during-hold": /during the hold|during-hold/i,
    };
    for (const [id, needle] of Object.entries(expectations)) {
      const r = row(id);
      const taskText = fs.readFileSync(path.join(ttRoot, r.task), "utf8");
      assert.match(taskText, needle, `${id} task text must describe its corridor (${needle})`);
      assert.match(taskText, new RegExp(SEED_BY_CELL[id].replace(/\./g, "\\.")),
        `${id} task text must name the seeded defect (${SEED_BY_CELL[id]})`);
      assert.match(taskText, /tt-ts/, `${id} task must describe the tt-ts fixture`);
    }
    for (const id of ["W4.48b-park-absorption", "W4.48b-move-during-hold"]) {
      const taskText = fs.readFileSync(path.join(ttRoot, row(id).task), "utf8");
      assert.match(taskText, /[Ee]xclusive (scheduling )?window/,
        `${id}: task text must carry the exclusive-window sequencing note (W4.48 composed-fault discipline)`);
      assert.match(taskText, /single-fault ancestor/i,
        `${id}: task text must require its single-fault ancestors green (composed-fault discipline)`);
    }
  });

  it("each scenario cell exists with scenario.json + behaviors.json + run.sh, the merger is a behavior ARRAY, and validate-scenario exits 0", () => {
    for (const id of SPLIT_CELLS) {
      const cellDir = path.join(ttRoot, "scenarios", SCENARIO_BY_CELL[id]);
      for (const file of ["scenario.json", "behaviors.json", "run.sh"]) {
        const details = fs.lstatSync(path.join(cellDir, file), { throwIfNoEntry: false });
        assert.ok(details?.isFile(), `${id}: cell file missing: scenarios/${SCENARIO_BY_CELL[id]}/${file}`);
      }
      const scenario = JSON.parse(fs.readFileSync(path.join(cellDir, "scenario.json"), "utf8"));
      assert.equal(scenario.id, SCENARIO_BY_CELL[id], `${id}: scenario.json id must match context.scenario_id`);
      assert.equal(scenario.workflow_base, "bug-fix-merge-worktree", `${id}: workflow_base must be bfmw`);
      const behaviors = JSON.parse(fs.readFileSync(path.join(cellDir, scenario.behaviors), "utf8"));
      assert.ok(Array.isArray(behaviors.agents.merger) && behaviors.agents.merger.length >= 2,
        `${id}: the merger must be a behavior ARRAY (>= 2 entries — the corridor dispatches the merger more than once)`);
      assert.equal(behaviors.heartbeatTokens, 0, `${id}: heartbeatTokens must be 0`);
      assert.equal(behaviors.defaultTokens, 0, `${id}: defaultTokens must be 0`);
      for (const entry of Object.values(behaviors.agents)) {
        for (const item of (Array.isArray(entry) ? entry : [entry])) {
          assert.equal(item.tokens ?? 0, 0, `${id}: agent tokens must be 0`);
        }
      }
      const res = run("node", [validator, path.join("torture-test", "scenarios", SCENARIO_BY_CELL[id])]);
      assert.equal(res.status, 0, `${id}: validate-scenario must exit 0:\n${res.stdout}${res.stderr}`);
    }
  });

  it("tier2-traceability.md has the S49 section and carries a case-map row per split cell", () => {
    const doc = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(doc, /## S49 W4\.33d\/W4\.48b split/, "traceability must have the S49 split section");
    for (const id of SPLIT_CELLS) {
      assert.match(doc, new RegExp(`\\| ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`),
        `traceability must carry a case-map row for ${id}`);
    }
    assert.match(doc, /absorption-assertion/, "S49 section must name the absorption-assertion arm");
    assert.match(doc, /directly-constructed-state/, "S49 section must name the directly-constructed-state arm");
  });

  it("tt-controller --validate-only stays green on the full 72-row manifest with the split probe/chaos declarations", () => {
    const res = spawnSync(controller, ["--manifest", tier2Path, "--validate-only"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `validate-only must stay green:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 72 case\(s\)/, `validate-only must validate all 72 cases: ${res.stdout}`);
  });
});
