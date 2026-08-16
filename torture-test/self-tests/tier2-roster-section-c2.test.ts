// Tier-2 US-007: section-C2 (daemon & launch violence) roster.
//
// Pins the section-C2 batch of cases/tier2.jsonl:
//   * the 3 new rows exist and tt-controller --manifest cases/tier2.jsonl
//     --validate-only exits 0 (Validated 70 case(s));
//   * W4.11-sigkill-launch-matrix is a NEW zero-token scripted local-command
//     case (harness local, workflow local, execution_mode scripted,
//     caps.tokens 0) whose scenario cell scenarios/w4.11/sigkill-launch-matrix/
//     covers ALL THREE SIGKILL phase markers (before INSERT / during git
//     worktree add / before registration) PLUS the three Ctrl-C (SIGINT-to-
//     process-group) arms (pre-registration / during daemon auto-start /
//     during --wait) as distinct sub-arms; the cell passes validate-scenario.mjs
//     and its run.sh is executable;
//   * W4.12-port-squatter is a NEW zero-token scripted local-command case
//     whose scenario cell implements the retrying-binder choreography
//     (pre-bound retry loop on EADDRINUSE, wins the stop->start barrier,
//     releases after capture; EADDRINUSE diagnosis + no half-up daemon O13 in
//     the cell + task text);
//   * W4.13-worktree-deletion is a REAL bfmw row (pi, tt-ts, seed BUG-T1) with
//     an honest diagnosable-failure expectation (no infinite retry, O6
//     worktree reality) in its task text; chaos null + no probe_sequence +
//     deliberately NO O16 (the W4.33c pattern);
//   * E3.D floors + caps (real bfmw p50 35-min floor / p95 1M; scripted cells
//     zero-token);
//   * traceability rows + the section-C2 map + exclusion enumeration +
//     machinery-delta rows + the updated C1 exclusion enumeration (W4.11/12/13
//     moved to C2, never trimmed) exist.
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
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");
const scenarioDirW411 = path.join(ttRoot, "scenarios", "w4.11", "sigkill-launch-matrix");
const scenarioDirW412 = path.join(ttRoot, "scenarios", "w4.12", "port-squatter");

// The 3 section-C2 cases (spec 08 §C, US-007).
const SECTION_C2_IDS = [
  "W4.11-sigkill-launch-matrix",
  "W4.12-port-squatter",
  "W4.13-worktree-deletion",
];

// Bug-fix (bfmw) section-C2 cases — seed must exist in the fixture SEEDS.md
// catalog AND the task text must name the seeded defect.
const SEEDED_CASES: Record<string, { fixture: string; seed: string }> = {
  "W4.13-worktree-deletion": { fixture: "tt-ts", seed: "BUG-T1" },
};

type Case = Record<string, any>;

// node:test marks descendant processes; drop NODE_TEST_CONTEXT so the
// TAMANDUA_TEST_GUARD live-state protection does not auto-activate for the
// spawned controller (the standard self-test pattern). /bin/false backstops
// guard against any accidental real model invocation.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

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
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

function readSeedsMd(fixture: string): string {
  return fs.readFileSync(path.join(ttRoot, "fixtures-src", fixture, "seeds", "SEEDS.md"), "utf8");
}

function seedInCatalog(seedsMd: string, seed: string): boolean {
  const escaped = seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^###\\s+${escaped}\\b`, "m").test(seedsMd);
}

describe("Tier-2 US-007 — section-C2 roster (daemon & launch violence)", () => {
  it("cases/tier2.jsonl contains the 3 section-C2 cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_C2_IDS) {
      assert.ok(ids.includes(id), `section-C2 case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("W4.11 is a NEW zero-token scripted local-command case whose cell covers all three SIGKILL phase markers + the three Ctrl-C process-group arms", () => {
    const record = recordById(readManifest(), "W4.11-sigkill-launch-matrix");
    assert.equal(record.harness, "local", "W4.11 must be a local-command case");
    assert.equal(record.workflow, "local", "W4.11 must be a local (non-workflow) case");
    assert.equal(record.context.execution_mode, "scripted", "W4.11 must be execution_mode scripted");
    assert.equal(record.caps.tokens, 0, "W4.11 must be zero-token");
    assert.equal(record.fixture, "none", "W4.11 provisions no fixture (the scenario builds its own scratch origin)");
    assert.ok(record.command, "W4.11 must carry the local command hook (the w4.49 scenario-cell shape)");
    assert.equal(record.command.executable, "scenarios/lib/run-scripted-scenario",
      "W4.11 command hook must be the shared scripted-scenario harness");
    assert.deepEqual(record.command.args, ["scenarios/w4.11/sigkill-launch-matrix"],
      "W4.11 command hook must point at the w4.11 scenario cell");
    assert.equal(record.context.scenario_id, "w4.11-sigkill-launch-matrix", "scenario_id must match");
    assert.equal(record.context.scenario_path, "scenarios/w4.11/sigkill-launch-matrix", "scenario_path must match");
    assert.equal(record.context.expected_command_outcome, "PASS", "expected_command_outcome must be PASS");
    // The scenario cell exists and passes the shared validator.
    const scenarioJson = path.join(scenarioDirW411, "scenario.json");
    assert.ok(fs.existsSync(scenarioJson), "scenario.json must exist");
    const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
    assert.equal(scenario.id, record.context.scenario_id, "scenario.id must match context.scenario_id");
    assert.equal(scenario.expected_outcome, record.context.scenario_expected_outcome,
      "scenario.expected_outcome must match context.scenario_expected_outcome");
    assert.ok(Array.isArray(scenario.oracles) && scenario.oracles.includes("O3z"),
      "a scripted scenario must declare O3z");
    for (const file of ["run.sh", "run-sigkill-launch-matrix.mjs", "behaviors.json"]) {
      const details = fs.lstatSync(path.join(scenarioDirW411, file), { throwIfNoEntry: false });
      assert.ok(details?.isFile(), `W4.11 scenario cell file missing: ${file}`);
    }
    const runSh = path.join(scenarioDirW411, "run.sh");
    assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, "run.sh must be executable");
    const validated = run("node", [validator, "torture-test/scenarios/w4.11/sigkill-launch-matrix"]);
    assert.equal(validated.status, 0, `validate-scenario must pass:\n${validated.stdout}${validated.stderr}`);
    // The runner covers the full corridor: the three SIGKILL phase markers
    // (before INSERT / during worktree add / before registration) plus the
    // three Ctrl-C process-group arms (pre-registration / daemon auto-start /
    // during --wait), each a distinct sub-arm.
    const runner = fs.readFileSync(path.join(scenarioDirW411, "run-sigkill-launch-matrix.mjs"), "utf8");
    for (const needle of [
      "a_sigkill_before_insert", "b_sigkill_during_worktree_add", "c_sigkill_before_registration",
      "d_sigint_pre_registration", "e_sigint_during_daemon_autostart", "f_sigint_during_wait",
      "SIGKILL", "SIGINT", "killGroup", "worktree add", "^{tree}", "--abbrev-ref",
      "run #", "no permanent zombie", "half-registered orphan", "full detach",
    ]) {
      assert.ok(runner.includes(needle), `W4.11 runner must cover the ${needle} corridor`);
    }
    const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
    assert.match(task, /SIGKILL/, "W4.11 task must document the SIGKILL arms");
    assert.match(task, /Ctrl-C|SIGINT/, "W4.11 task must document the Ctrl-C/SIGINT arms");
    assert.match(task, /DC9|run id on stderr/, "W4.11 task must document the DC9 id-on-stderr contract");
    assert.match(task, /half-registered orphan/, "W4.11 task must pin the never-a-half-registered-orphan contract");
    assert.match(task, /--wait/, "W4.11 task must document the during---wait arm");
  });

  it("W4.12 is a NEW zero-token scripted local-command case whose cell implements the retrying-binder choreography", () => {
    const record = recordById(readManifest(), "W4.12-port-squatter");
    assert.equal(record.harness, "local", "W4.12 must be a local-command case");
    assert.equal(record.workflow, "local", "W4.12 must be a local (non-workflow) case");
    assert.equal(record.context.execution_mode, "scripted", "W4.12 must be execution_mode scripted");
    assert.equal(record.caps.tokens, 0, "W4.12 must be zero-token");
    assert.equal(record.fixture, "none", "W4.12 provisions no fixture");
    assert.ok(record.command, "W4.12 must carry the local command hook");
    assert.equal(record.command.executable, "scenarios/lib/run-scripted-scenario",
      "W4.12 command hook must be the shared scripted-scenario harness");
    assert.deepEqual(record.command.args, ["scenarios/w4.12/port-squatter"],
      "W4.12 command hook must point at the w4.12 scenario cell");
    assert.equal(record.context.scenario_id, "w4.12-port-squatter", "scenario_id must match");
    assert.equal(record.context.scenario_path, "scenarios/w4.12/port-squatter", "scenario_path must match");
    const scenarioJson = path.join(scenarioDirW412, "scenario.json");
    assert.ok(fs.existsSync(scenarioJson), "scenario.json must exist");
    const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
    assert.equal(scenario.id, record.context.scenario_id, "scenario.id must match context.scenario_id");
    for (const file of ["run.sh", "run-port-squatter.mjs", "behaviors.json"]) {
      const details = fs.lstatSync(path.join(scenarioDirW412, file), { throwIfNoEntry: false });
      assert.ok(details?.isFile(), `W4.12 scenario cell file missing: ${file}`);
    }
    const runSh = path.join(scenarioDirW412, "run.sh");
    assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, "run.sh must be executable");
    const validated = run("node", [validator, "torture-test/scenarios/w4.12/port-squatter"]);
    assert.equal(validated.status, 0, `validate-scenario must pass:\n${validated.stdout}${validated.stderr}`);
    // The retrying-binder choreography: pre-bound retry loop on EADDRINUSE,
    // wins the stop->start barrier, holds until capture, releases; clean
    // EADDRINUSE diagnosis + no half-up daemon (O13).
    const runner = fs.readFileSync(path.join(scenarioDirW412, "run-port-squatter.mjs"), "utf8");
    for (const needle of [
      "EADDRINUSE", "retry loop", "WON the bind", "stop->start barrier",
      "release", "restart --force", "All services restarted",
      "no half-up daemon", "pidfile", "heldMarker", "errorMarker", "releaseFile",
      "must NOT exit on EADDRINUSE",
    ]) {
      assert.ok(runner.includes(needle), `W4.12 runner must implement the ${needle} choreography leg`);
    }
    const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
    assert.match(task, /EADDRINUSE/, "W4.12 task must document the EADDRINUSE corridor");
    assert.match(task, /O13|no half-up daemon/, "W4.12 task must name the O13 backstop (not declared)");
    assert.match(task, /5339|4339/, "W4.12 task must document the port (spec 4339 -> contained 5339)");
    assert.match(task, /retry restart succeeds|retry.*restart.*succeeds/i,
      "W4.12 task must document the post-release retry restart");
  });

  it("W4.13 is a REAL bfmw case with an honest diagnosable-failure expectation and O6 worktree reality in its task text", () => {
    const record = recordById(readManifest(), "W4.13-worktree-deletion");
    assert.equal(record.workflow, "bug-fix-merge-worktree", "W4.13 must be bfmw (spec 08 §C W4.13)");
    assert.equal(record.harness, "pi", "W4.13 must be a real pi case");
    assert.equal(record.context.execution_mode, "real", "W4.13 must be execution_mode real");
    assert.equal(record.context.test_cmd, "npm test", "W4.13 test_cmd must be the tt-ts canonical TEST_CMD");
    assert.equal(record.chaos, null, "W4.13 cannot carry a typed chaos block (no worktree-delete op — documented machinery delta)");
    assert.equal(record.probe_sequence, undefined, "W4.13 must carry no probe_sequence (operator choreography)");
    assert.ok(!record.oracles.includes("O16"),
      "W4.13 must deliberately omit O16 (the deleted-worktree corridor is not a resume-completes corridor — W4.33c pattern)");
    assert.ok(!record.oracles.includes("O6"),
      "W4.13 must not declare O6 (not implemented — the O6 backstop lives in the task text)");
    assert.ok(record.caps.wall_min >= 35,
      `W4.13 wall cap must sit at/above the bfmw p50 35-min floor (got ${record.caps.wall_min})`);
    assert.ok(record.caps.tokens >= 1000000, "W4.13 token cap must sit at pi bfmw p95 (1M)");
    const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
    assert.match(task, /out-of-band|OUT-OF-BAND/, "W4.13 task must declare the out-of-band deletion");
    assert.match(task, /diagnosable/i, "W4.13 task must carry the diagnosable-failure expectation");
    assert.match(task, /infinite retry|never an infinite retry/i,
      "W4.13 task must carry the no-infinite-retry expectation");
    assert.match(task, /run_worktrees|O6/, "W4.13 task must carry the O6 worktree-reality expectation");
    assert.match(task, /TAMANDUA_WORKTREE_ROOT/, "W4.13 task must name the contained worktree-root guard");
  });

  it("E3.D calibration holds for the section-C2 rows (scripted zero-token; real bfmw at family p95)", () => {
    for (const record of readManifest()) {
      if (!SECTION_C2_IDS.includes(record.id)) continue;
      assert.equal(record.gates.join(","), "TIER2,W4", `${record.id}: gates must be [TIER2, W4]`);
      assert.equal(record.mandatory, true, `${record.id} must be mandatory`);
      assert.equal(record.shed_ok, false, `${record.id} must not be shed-ok`);
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${record.id}: spec_ref into 08`);
      if (record.harness === "local") {
        assert.equal(record.caps.tokens, 0, `${record.id}: scripted case must be zero-token`);
        assert.ok(record.production_duration_floor_ms > 0,
          `${record.id}: scripted case must carry production_duration_floor_ms`);
        continue;
      }
      assert.ok(record.caps.wall_min > 0 && record.caps.tokens > 0, `${record.id}: real caps must be positive`);
      assert.ok(record.production_duration_floor_ms > 0,
        `${record.id}: must carry production_duration_floor_ms (E3.D calibration record)`);
      assert.ok(record.caps.wall_min >= 35,
        `${record.id}: bfmw wall cap at/above the family p50 35-min floor (got ${record.caps.wall_min})`);
      assert.ok(record.caps.tokens >= 1000000,
        `${record.id}: pi bfmw token cap at family p95 1M (got ${record.caps.tokens})`);
    }
  });

  it("every workflow-launching section-C2 real case has context.test_cmd matching its fixture's canonical TEST_CMD", () => {
    const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
    let workflowCases = 0;
    for (const record of readManifest()) {
      if (!SECTION_C2_IDS.includes(record.id)) continue;
      if (!REAL_HARNESSES.has(record.harness)) continue;
      if (record.workflow === "local") continue;
      workflowCases += 1;
      assert.equal(record.context?.test_cmd, "npm test",
        `${record.id}: context.test_cmd must be the tt-ts canonical TEST_CMD (npm test)`);
    }
    assert.equal(workflowCases, 1, "exactly one real workflow-launching section-C2 row (W4.13); W4.11/W4.12 are local-command scripted cells");
  });

  it("every bug-fix section-C2 case's seed exists in the fixture SEEDS.md catalog and its task names the seeded defect", () => {
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

  it("task files exist for all 3 section-C2 cases under cases/tasks/tier2/ and describe the fixture's actual contents", () => {
    for (const record of readManifest()) {
      if (!SECTION_C2_IDS.includes(record.id)) continue;
      assert.equal(typeof record.task, "string", `${record.id}: task path required`);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${record.id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${record.id}: task file must exist as a regular file`);
      const task = fs.readFileSync(taskPath, "utf8");
      assert.ok(task.trim().length > 0, `${record.id}: task file must be non-empty`);
      if (record.fixture !== "none") {
        assert.match(task, new RegExp(record.fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${record.id}: task must describe the ${record.fixture} fixture's actual contents`);
      }
    }
  });

  it("traceability rows + section-C2 map + exclusion enumeration + machinery deltas + updated C1 exclusion exist", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    for (const id of SECTION_C2_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    assert.match(trace, /Wave 4 Section C2/, "section-C2 reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section C2\)/, "section-C2 exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(section C2\)/, "section-C2 token budget note must exist");
    // The section-C1 exclusion enumeration is HONEST: W4.11/12/13 were listed
    // there as deferred in US-006 and are now authored in section C2 — never
    // silently trimmed.
    assert.match(trace, /W4\.11 \/ W4\.12 \/ W4\.13 are authored in \*\*section C2\*\* \(US-007\)/,
      "the C1 exclusion enumeration must document that W4.11/12/13 moved to section C2");
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases");
    // Machinery deltas for the C2 rows.
    assert.match(trace, /W4\.11-sigkill-launch-matrix/, "traceability must document the W4.11 PTY/group-signal delta");
    assert.match(trace, /W4\.12-port-squatter/, "traceability must document the W4.12 port-substitution + O13 deltas");
    assert.match(trace, /W4\.13-worktree-deletion/, "traceability must document the W4.13 operator-seam + O6 deltas");
    assert.match(trace, /O13 \("no half-up daemon with a live pidfile"\) is NOT a declared oracle/,
      "the O13 not-declared delta must be documented");
    assert.match(trace, /O6 \("run_worktrees reflects reality"\) is NOT a declared oracle/,
      "the O6 not-declared delta must be documented");
  });
});
