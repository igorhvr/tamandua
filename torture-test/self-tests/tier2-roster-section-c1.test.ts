// Tier-2 US-006: section-C1 (process & daemon violence) roster.
//
// Pins the section-C1 batch of cases/tier2.jsonl:
//   * the 6 new rows exist and tt-controller --manifest cases/tier2.jsonl
//     --validate-only exits 0 (Validated 70 case(s) after US-012);
//   * W4.09's pi + hermes rows carry the typed kill-harness chaos block
//     (target harness_process, SIGKILL, armed at step:developer:running per
//     US-003); the hermes row gates honestly on requires.capabilities
//     ["hermes"];
//   * W4.10 is split into two terminal rows: W4.10-kill-daemon carries the
//     typed kill-daemon chaos block (target daemon_process, SIGKILL, armed at
//     step:developer:running) with the operator restart seam + machinery-delta
//     documentation; W4.10-restart-recovery carries the typed restart_daemon
//     probe action on EVERY run group with recovery_within_dispatch_intervals
//     + token_flush_preserved + run_completes and declares O16;
//   * W4.27 is a NEW zero-token scripted local-command case (harness local,
//     workflow local, execution_mode scripted, caps.tokens 0) whose scenario
//     cell scenarios/w4.27/shim-exit-matrix/ covers the exit-86/87/88 +
//     SIGKILL + prompt-order corridor; the cell passes validate-scenario.mjs
//     and its run.sh + runner are executable;
//   * W4.32 declares the loopback-fs setup (task text names the fs +
//     TAMANDUA_WORKTREE_ROOT + DB-intact expectation) with caps sized for the
//     slow fs (wall >= bfmw p50 35-min floor);
//   * E3.D floors + caps (bfmw p50 35-min floor / p95 1M; hermes bfmw p95 4M;
//     2-run restart-recovery 2 x 1M);
//   * traceability rows + the section-C1 map + exclusion enumeration +
//     machinery-delta rows exist.
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
const scenarioDir = path.join(ttRoot, "scenarios", "w4.27", "shim-exit-matrix");

// The 6 section-C1 cases (spec 08 §C, US-006).
const SECTION_C1_IDS = [
  "W4.09-pi-kill-harness",
  "W4.09-hermes-kill-harness",
  "W4.10-kill-daemon",
  "W4.10-restart-recovery",
  "W4.27-shim-exit-matrix",
  "W4.32-enospc",
];

// Bug-fix (bfmw) section-C1 cases — seed must exist in the fixture SEEDS.md
// catalog AND the task text must name the seeded defect.
const SEEDED_CASES: Record<string, { fixture: string; seed: string }> = {
  "W4.09-pi-kill-harness": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.09-hermes-kill-harness": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.10-kill-daemon": { fixture: "tt-ts", seed: "BUG-T3" },
  "W4.10-restart-recovery": { fixture: "tt-ts", seed: "BUG-T4" },
  "W4.32-enospc": { fixture: "tt-ts", seed: "BUG-T1" },
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

describe("Tier-2 US-006 — section-C1 roster (process & daemon violence)", () => {
  it("cases/tier2.jsonl contains the 6 section-C1 cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_C1_IDS) {
      assert.ok(ids.includes(id), `section-C1 case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("W4.09's pi and hermes rows carry the typed kill-harness chaos block (US-003 schema) and the hermes row gates on its presence", () => {
    const records = readManifest();
    const w409Pi = recordById(records, "W4.09-pi-kill-harness");
    const w409Hermes = recordById(records, "W4.09-hermes-kill-harness");
    for (const [record, harness] of [[w409Pi, "pi"], [w409Hermes, "hermes"]] as const) {
      assert.equal(record.workflow, "bug-fix-merge-worktree", `${record.id} must be bfmw (spec 08 §C W4.09)`);
      assert.equal(record.harness, harness, `${record.id} must run on ${harness}`);
      assert.equal(record.chaos.type, "kill-harness", `${record.id} must carry a kill-harness chaos block`);
      assert.equal(record.chaos.target, "harness_process", `${record.id} kill-harness targets harness_process`);
      assert.equal(record.chaos.signal, "SIGKILL", `${record.id} kill-harness declares SIGKILL (kill -9 per spec)`);
      assert.equal(record.chaos.trigger, "step:fixer:running",
        `${record.id} kill-harness arms mid-fix (the bfmw coding step — S29 calibration US-003: step:developer:running is not bfmw vocabulary)`);
      assert.equal(record.chaos.operator, "tt-chaos", `${record.id} chaos operator must be tt-chaos`);
      assert.ok(record.oracles.includes("O4"), `${record.id} must declare O4 (chaos-log dispatch hygiene)`);
      // The worker_lost -> re-pend corridor is in the task text.
      const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
      assert.match(task, /worker_lost/, `${record.id}: task must carry the worker_lost -> re-pend expectation`);
    }
    assert.deepEqual(w409Hermes.requires.capabilities, ["hermes"],
      "W4.09-hermes must gate honestly on hermes presence (host-profile harness.hermes.present)");
  });

  it("W4.10 is split: kill-daemon chaos on W4.10-kill-daemon; restart_daemon probes with recovery expectations on W4.10-restart-recovery", () => {
    const records = readManifest();
    // W4.10-kill-daemon: the typed kill-daemon chaos block (the spec's kill
    // -9 the daemon injection) + operator restart seam documented in task text.
    const kill = recordById(records, "W4.10-kill-daemon");
    assert.equal(kill.chaos.type, "kill-daemon", "W4.10-kill-daemon must carry a kill-daemon chaos block");
    assert.equal(kill.chaos.target, "daemon_process", "W4.10-kill-daemon targets daemon_process");
    assert.equal(kill.chaos.signal, "SIGKILL", "W4.10-kill-daemon declares SIGKILL");
    assert.equal(kill.chaos.trigger, "step:fixer:running",
      "W4.10-kill-daemon kills the daemon mid-fix while the harness is left alive (S29 calibration US-003 — step:developer:running is not bfmw vocabulary)");
    assert.equal(kill.chaos.operator, "tt-chaos", "W4.10-kill-daemon chaos operator must be tt-chaos");
    assert.ok(kill.oracles.includes("O4"), "W4.10-kill-daemon must declare O4 (chaos-log dispatch hygiene)");
    const killTask = fs.readFileSync(path.join(ttRoot, kill.task), "utf8");
    assert.match(killTask, /operator|OPERATOR/, "W4.10-kill-daemon task must carry the operator restart seam");
    assert.match(killTask, /recovery|dispatch intervals/i,
      "W4.10-kill-daemon task must carry the late-completion / recovery expectation");
    assert.match(killTask, /EXCLUSIVE WINDOW|exclusive window/i,
      "W4.10-kill-daemon task must carry the daemon-lifecycle exclusive-window note");
    // W4.10-restart-recovery: the typed restart_daemon probe action on EVERY
    // run group (the daemon-level multi-run contract) with the per-run
    // recovery expectation.
    const restart = recordById(records, "W4.10-restart-recovery");
    assert.ok(Array.isArray(restart.probe_sequence) && restart.probe_sequence.length === 2,
      "W4.10-restart-recovery must declare a two-run restart_daemon probe sequence");
    for (const [index, group] of restart.probe_sequence.entries()) {
      const action = group.actions.find((item: any) => item.op === "restart_daemon");
      assert.ok(action, `W4.10-restart-recovery run group ${index + 1} must declare restart_daemon`);
      assert.equal(action.when, "step:fixer:running",
        "restart arms mid-fix (the bfmw coding step — S29 calibration, US-002: step:developer:running is not bfmw vocabulary)");
      assert.equal(action.expect?.recovery_within_dispatch_intervals, 2,
        "recovery_within_dispatch_intervals must be 2 (spec: recovery <= 2 intervals)");
      assert.equal(action.expect?.token_flush_preserved, true, "token flush must be preserved across the restart");
      assert.equal(action.expect?.run_completes, true, "the in-flight run must complete after the restart");
    }
    assert.ok(restart.oracles.includes("O16"), "W4.10-restart-recovery must declare O16");
    assert.equal(restart.chaos, null, "W4.10-restart-recovery cannot carry chaos (chaos + multi-run probe_sequence is rejected by the validator — documented machinery delta)");
    const restartTask = fs.readFileSync(path.join(ttRoot, restart.task), "utf8");
    assert.match(restartTask, /restart_daemon/, "W4.10-restart-recovery task must name the restart_daemon probe op");
    assert.match(restartTask, /EXCLUSIVE WINDOW|exclusive window/i,
      "W4.10-restart-recovery task must carry the daemon-lifecycle exclusive-window note");
    // The split is documented as a machinery delta (never a silent trim).
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /W4\.10 \(kill-daemon \+ restart_daemon on ONE row\)/,
      "traceability must document the W4.10 kill+restart split as a machinery delta");
  });

  it("W4.27 is a NEW zero-token scripted local-command case whose scenario cell covers the exit-86/87/88 + SIGKILL + prompt-order corridor", () => {
    const record = recordById(readManifest(), "W4.27-shim-exit-matrix");
    assert.equal(record.harness, "local", "W4.27 must be a local-command case");
    assert.equal(record.workflow, "local", "W4.27 must be a local (non-workflow) case");
    assert.equal(record.context.execution_mode, "scripted", "W4.27 must be execution_mode scripted");
    assert.equal(record.caps.tokens, 0, "W4.27 must be zero-token");
    assert.equal(record.fixture, "none", "W4.27 provisions no fixture (the scenario builds its own scratch repo)");
    assert.ok(record.command, "W4.27 must carry the local command hook (the w4.49 scenario-cell shape)");
    assert.equal(record.command.executable, "scenarios/lib/run-scripted-scenario",
      "W4.27 command hook must be the shared scripted-scenario harness");
    assert.deepEqual(record.command.args, ["scenarios/w4.27/shim-exit-matrix"],
      "W4.27 command hook must point at the w4.27 scenario cell");
    // The tier0 w4.49 cell shape: scenario_id/scenario_path/expected_command_outcome.
    assert.equal(record.context.scenario_id, "w4.27-shim-exit-matrix", "scenario_id must match");
    assert.equal(record.context.scenario_path, "scenarios/w4.27/shim-exit-matrix", "scenario_path must match");
    assert.equal(record.context.expected_command_outcome, "PASS", "expected_command_outcome must be PASS");
    // The scenario cell exists and passes the shared validator.
    const scenarioJson = path.join(scenarioDir, "scenario.json");
    assert.ok(fs.existsSync(scenarioJson), "scenario.json must exist");
    const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
    assert.equal(scenario.id, record.context.scenario_id, "scenario.id must match context.scenario_id");
    assert.equal(scenario.expected_outcome, record.context.scenario_expected_outcome,
      "scenario.expected_outcome must match context.scenario_expected_outcome");
    assert.ok(Array.isArray(scenario.oracles) && scenario.oracles.includes("O3z"),
      "a scripted scenario must declare O3z");
    for (const file of ["run.sh", "run-shim-exit-matrix.mjs", "behaviors.json"]) {
      const details = fs.lstatSync(path.join(scenarioDir, file), { throwIfNoEntry: false });
      assert.ok(details?.isFile(), `scenario cell file missing: ${file}`);
    }
    const runSh = path.join(scenarioDir, "run.sh");
    assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, "run.sh must be executable");
    const validated = run("node", [validator, "torture-test/scenarios/w4.27/shim-exit-matrix"]);
    assert.equal(validated.status, 0, `validate-scenario must pass:\n${validated.stdout}${validated.stderr}`);
    // The runner covers the full corridor: SIGTERM->87, SIGKILL->no row +
    // fresh same-key execute, tracked-dirty->86/88, prompt-order.
    const runner = fs.readFileSync(path.join(scenarioDir, "run-shim-exit-matrix.mjs"), "utf8");
    for (const needle of ["exit 87", "SIGKILL", "FAILURE_CLASS: tree_dirty", "prompt-order",
      "W4.27 INTERRUPTIBLE STARTED", "TAMANDUA_TSTX_JUNK_PROBE"]) {
      assert.ok(runner.includes(needle), `W4.27 runner must cover the ${needle} corridor`);
    }
    const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
    assert.match(task, /86/, "W4.27 task must document the exit-86 corridor");
    assert.match(task, /87/, "W4.27 task must document the exit-87 corridor");
    assert.match(task, /88/, "W4.27 task must document the exit-88 corridor");
  });

  it("W4.32 declares the loopback-fs setup with caps sized for the slow fs and the DB-intact expectation in task text", () => {
    const record = recordById(readManifest(), "W4.32-enospc");
    assert.equal(record.workflow, "bug-fix-merge-worktree", "W4.32 must be bfmw (spec 08 §C W4.32)");
    assert.equal(record.harness, "pi", "W4.32 must be a real pi case");
    assert.ok(record.caps.wall_min >= 35,
      `W4.32 wall cap must sit at/above the bfmw p50 35-min floor (got ${record.caps.wall_min})`);
    assert.ok(record.caps.tokens >= 1000000, "W4.32 token cap must sit at pi bfmw p95 (1M)");
    const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
    assert.match(task, /loopback/, "W4.32 task must declare the loopback-fs setup");
    assert.match(task, /TAMANDUA_WORKTREE_ROOT/, "W4.32 task must name TAMANDUA_WORKTREE_ROOT");
    assert.match(task, /DB intact|db intact/i, "W4.32 task must carry the DB-intact expectation");
    assert.match(task, /diagnosable/i, "W4.32 task must carry the diagnosable-failure expectation");
    assert.match(task, /phantom completion/i, "W4.32 task must carry the no-phantom-completion expectation");
  });

  it("E3.D calibration holds for the section-C1 rows (floors never below family p50; the 2-run restart row at 2 x p95)", () => {
    for (const record of readManifest()) {
      if (!SECTION_C1_IDS.includes(record.id)) continue;
      assert.equal(record.gates.join(","), "TIER2,W4", `${record.id}: gates must be [TIER2, W4]`);
      assert.equal(record.mandatory, true, `${record.id} must be mandatory`);
      assert.equal(record.shed_ok, false, `${record.id} must not be shed-ok`);
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${record.id}: spec_ref into 08`);
      if (record.harness === "local") {
        assert.equal(record.caps.tokens, 0, `${record.id}: scripted case must be zero-token`);
        continue;
      }
      assert.ok(record.caps.wall_min > 0 && record.caps.tokens > 0, `${record.id}: real caps must be positive`);
      assert.ok(record.production_duration_floor_ms > 0,
        `${record.id}: must carry production_duration_floor_ms (E3.D calibration record)`);
      assert.ok(record.caps.wall_min >= 35,
        `${record.id}: bfmw wall cap at/above the family p50 35-min floor (got ${record.caps.wall_min})`);
      if (record.id === "W4.09-hermes-kill-harness") {
        assert.ok(record.caps.tokens >= 4000000,
          `${record.id}: hermes bfmw token cap at family p95 4M (W3.03 cell), got ${record.caps.tokens}`);
      } else if (record.id === "W4.10-restart-recovery") {
        assert.ok(record.caps.tokens >= 2000000,
          `${record.id}: two concurrent bfmw lifecycles -> 2 x p95 1M (got ${record.caps.tokens})`);
      } else {
        assert.ok(record.caps.tokens >= 1000000,
          `${record.id}: pi bfmw token cap at family p95 1M (got ${record.caps.tokens})`);
      }
    }
  });

  it("every workflow-launching section-C1 real case has context.test_cmd matching its fixture's canonical TEST_CMD", () => {
    const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
    let workflowCases = 0;
    for (const record of readManifest()) {
      if (!SECTION_C1_IDS.includes(record.id)) continue;
      if (!REAL_HARNESSES.has(record.harness)) continue;
      if (record.workflow === "local") continue;
      workflowCases += 1;
      assert.equal(record.context?.test_cmd, "npm test",
        `${record.id}: context.test_cmd must be the tt-ts canonical TEST_CMD (npm test)`);
    }
    assert.equal(workflowCases, 5, "the 5 real section-C1 rows are all workflow-launching (W4.27 is the local-command scripted cell)");
  });

  it("every bug-fix section-C1 case's seed exists in the fixture SEEDS.md catalog and its task names the seeded defect", () => {
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

  it("task files exist for all 6 section-C1 cases under cases/tasks/tier2/ and describe the fixture's actual contents", () => {
    for (const record of readManifest()) {
      if (!SECTION_C1_IDS.includes(record.id)) continue;
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

  it("traceability rows + section-C1 map + exclusion enumeration + machinery deltas exist", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    for (const id of SECTION_C1_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    assert.match(trace, /Wave 4 Section C1/, "section-C1 reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section C1\)/, "section-C1 exclusion enumeration");
    // The exclusion list is HONEST: W4.11/12/13 are deferred to US-007 (section C2),
    // never silently trimmed.
    assert.match(trace, /W4\.11/, "section-C1 exclusion enumeration must list W4.11");
    assert.match(trace, /W4\.12/, "section-C1 exclusion enumeration must list W4.12");
    assert.match(trace, /W4\.13/, "section-C1 exclusion enumeration must list W4.13");
    assert.match(trace, /US-007/, "the W4.11/12/13 exclusions must name the deferred story (US-007)");
    // Machinery deltas for the C1 rows.
    assert.match(trace, /W4\.10 \(kill-daemon \+ restart_daemon on ONE row\)/,
      "traceability must document the W4.10 kill+restart machinery delta");
    assert.match(trace, /W4\.32-enospc/, "traceability must document the W4.32 loopback-fs machinery delta");
    assert.match(trace, /W4\.27-shim-exit-matrix/, "traceability must document the W4.27 O9-battery delta");
    // Token budget note for section C1.
    assert.match(trace, /Token Budget Note \(section C1\)/, "section-C1 token budget note must exist");
  });
});
