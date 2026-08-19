// Tier-2 US-012: sections I/J/K (hermes stream & resolver torture, launch &
// control-plane hostility, provider & auth faults) roster.
//
// Pins the section-I/J/K batch of cases/tier2.jsonl:
//   * the 12 new rows exist (W4.40 x4, W4.41 x2, W4.42, W4.43, W4.44a/b,
//     W4.46, W4.47) and tt-controller --manifest cases/tier2.jsonl
//     --validate-only exits 0 (Validated 70 case(s)) — AC1;
//   * W4.40 has all FOUR stream arms (delayed-trailer / oversized-stdout /
//     trailer-absent / malformed-trailer) and W4.41 has BOTH resolver arms
//     (login-shell-tier / all-tiers-fail) + the zero-filesystem-mutation
//     assertion — all six zero-token scripted-hermes (AC2);
//   * W4.43 declares 10 distinct refusal diagnostics with zero run rows and
//     W4.44 has the double-tap + post-success-immunity arms (AC3);
//   * W4.46's task text asserts retry-with-backoff (inter-attempt spacing)
//     and PROVIDER_FAIL discipline (O11); W4.47 asserts no fallback to the
//     real ~/.pi (O15 — named in task text, never a declared oracle) (AC4);
//   * every scenario cell passes the shared validator; run.sh executable;
//     the W4.41 resolver runners are EXECUTED directly against a scratch env
//     to prove the tier-3 win + all-tiers-fail refusal + zero-filesystem-
//     mutation (the direct-execution pattern);
//   * traceability rows + the section-I/J/K maps + exclusion enumerations +
//     machinery-delta rows + token budgets exist; manifest summary shows 70.
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
const varRoot = path.join(ttRoot, "var");

// The 12 section-I/J/K cases (spec 08 §I/§J/§K, US-012).
const SECTION_IJK_IDS = [
  "W4.40-delayed-trailer",
  "W4.40-oversized-stdout",
  "W4.40-trailer-absent",
  "W4.40-malformed-trailer",
  "W4.41-login-shell-tier",
  "W4.41-all-tiers-fail",
  "W4.42-shared-workdir-refusal",
  "W4.43-refusal-storm",
  "W4.44a-double-tap",
  "W4.44b-post-success-immunity",
  "W4.46-provider-error-rounds",
  "W4.47-auth-expiry-copy",
];

const W4_40_ARMS = [
  "W4.40-delayed-trailer",
  "W4.40-oversized-stdout",
  "W4.40-trailer-absent",
  "W4.40-malformed-trailer",
];
const W4_41_ARMS = ["W4.41-login-shell-tier", "W4.41-all-tiers-fail"];

// Scenario cell directory per case id.
const CELL_DIRS: Record<string, string> = {
  "W4.40-delayed-trailer": "scenarios/w4.40/delayed-trailer",
  "W4.40-oversized-stdout": "scenarios/w4.40/oversized-stdout",
  "W4.40-trailer-absent": "scenarios/w4.40/trailer-absent",
  "W4.40-malformed-trailer": "scenarios/w4.40/malformed-trailer",
  "W4.41-login-shell-tier": "scenarios/w4.41/login-shell-tier",
  "W4.41-all-tiers-fail": "scenarios/w4.41/all-tiers-fail",
  "W4.42-shared-workdir-refusal": "scenarios/w4.42/shared-workdir-refusal",
  "W4.43-refusal-storm": "scenarios/w4.43/refusal-storm",
  "W4.44a-double-tap": "scenarios/w4.44/double-tap",
  "W4.44b-post-success-immunity": "scenarios/w4.44/post-success-immunity",
  "W4.46-provider-error-rounds": "scenarios/w4.46/provider-error-rounds",
};

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
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

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000, cwd = repoRoot) {
  const result = spawnSync(file, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function taskText(record: Case): string {
  return fs.readFileSync(path.join(ttRoot, record.task), "utf8");
}

describe("Tier-2 US-012 — sections I/J/K roster (hermes stream & resolver torture, launch & control-plane hostility, provider & auth faults)", () => {
  it("cases/tier2.jsonl contains the 12 section-I/J/K cases and --validate-only exits 0 (AC1)", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_IJK_IDS) {
      assert.ok(ids.includes(id), `section-I/J/K case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("W4.40 has all four stream arms — zero-token scripted-hermes workflow rows with per-arm knob cells (AC2)", () => {
    for (const id of W4_40_ARMS) {
      const record = recordById(readManifest(), id);
      assert.equal(record.harness, "scripted-hermes", `${id} must run on the scripted-hermes harness`);
      assert.equal(record.context.execution_mode, "scripted", `${id} must be execution_mode scripted`);
      assert.equal(record.workflow, "bug-fix-merge-worktree", `${id} must be one scripted bfmw round`);
      assert.equal(record.fixture, "tt-ts", `${id} must use the tt-ts fixture`);
      assert.equal(record.caps.tokens, 0, `${id} must be zero-token`);
      assert.equal(record.context.test_cmd, "npm test", `${id} must carry the tt-ts canonical test_cmd (E3.A)`);
      const cellDir = CELL_DIRS[id];
      assert.equal(record.context.scenario_path, cellDir, `${id} must reference its scenario cell`);
      assert.equal(record.context.scenario_id, `w4.40-${id.replace("W4.40-", "")}`,
        `${id} scenario_id must be w4.40-<arm>`);
      assert.ok(record.requires?.platform === "linux" && record.requires?.capabilities?.includes("node-sqlite"),
        `${id} must carry the standard scripted-cell requires`);
      assert.ok(record.requires?.containment?.includes("systemd-user-scope"), `${id} must require systemd-user-scope`);
      assert.equal(record.requires?.node_min, 22, `${id} must require node_min 22`);
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${id} gates must be [TIER2, W4]`);
      assert.equal(record.mandatory, true, `${id} must be mandatory`);
      assert.equal(record.shed_ok, false, `${id} must not be shed-ok`);
      assert.match(record.spec_ref, /#W4\.40/, `${id} spec_ref must point at W4.40`);
      // T2.1 US-010: the arms carry NO chaos injection (the knob IS the
      // injection) but DO declare the O11 synthetic-token ledger for the
      // scripted run (the controller fills the launch run id at oracle time).
      assert.equal(record.chaos?.type ?? null, null, `${id} must carry no chaos injection`);
      assert.ok(Array.isArray(record.chaos?.synthetic_token_ledger)
        && record.chaos.synthetic_token_ledger.length === 1
        && record.chaos.synthetic_token_ledger[0].expected_tokens === 0,
        `${id} must declare the zero-token O11 synthetic ledger (T2.1 US-010)`);
      assert.ok(record.production_duration_floor_ms > 0, `${id} must carry production_duration_floor_ms`);
    }
    // The per-arm knobs live in each cell's behaviors file (the knob IS the
    // injection — never a silent trim).
    const knobNeedles: Record<string, string> = {
      "W4.40-delayed-trailer": "delayed_trailer_ms",
      "W4.40-oversized-stdout": "oversized_stdout_mb",
      "W4.40-trailer-absent": "omit_trailer",
      "W4.40-malformed-trailer": "malformed_trailer",
    };
    for (const [id, knob] of Object.entries(knobNeedles)) {
      const cellDir = CELL_DIRS[id];
      const behaviors = JSON.parse(fs.readFileSync(path.join(ttRoot, cellDir, "behaviors.json"), "utf8"));
      const fixer = behaviors.agents.fixer;
      assert.ok(Array.isArray(fixer) || typeof fixer === "object", `${id}: fixer behavior must exist`);
      const entry = Array.isArray(fixer) ? fixer[0] : fixer;
      assert.ok(Object.hasOwn(entry, knob), `${id}: fixer behaviors must carry the ${knob} knob`);
      assert.equal(behaviors.heartbeatTokens, 0, `${id}: heartbeatTokens must be 0`);
      assert.equal(behaviors.defaultTokens, 0, `${id}: defaultTokens must be 0`);
    }
  });

  it("W4.41 has both resolver arms + the zero-filesystem-mutation assertion — zero-token scripted-hermes (AC2)", () => {
    for (const id of W4_41_ARMS) {
      const record = recordById(readManifest(), id);
      assert.equal(record.harness, "scripted-hermes", `${id} must run on the scripted-hermes harness`);
      assert.equal(record.context.execution_mode, "scripted", `${id} must be execution_mode scripted`);
      assert.equal(record.caps.tokens, 0, `${id} must be zero-token`);
      assert.equal(record.context.scenario_path, CELL_DIRS[id], `${id} must reference its scenario cell`);
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${id} gates must be [TIER2, W4]`);
      assert.match(record.spec_ref, /#W4\.41/, `${id} spec_ref must point at W4.41`);
    }
    const login = recordById(readManifest(), "W4.41-login-shell-tier");
    assert.equal(login.context.scenario_expected_outcome, "completed", "login-shell arm expects resolution success");
    const fail = recordById(readManifest(), "W4.41-all-tiers-fail");
    assert.equal(fail.context.scenario_expected_outcome, "failed", "all-tiers-fail arm expects the launch refusal");
    // The resolver runners cover the tier-3 win, the all-tiers-fail refusal,
    // and the zero-filesystem-mutation check.
    for (const id of W4_41_ARMS) {
      const runner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.41", "run-resolver-torture.mjs"), "utf8");
      for (const needle of [
        "hermes-resolver",       // the PRODUCT resolver module
        "login-shell",           // the tier-3 corridor
        "zsh", "-lic",           // the login-shell invocation shape
        "command -v hermes",     // the resolver's tier-3 query
        "HermesResolverError",   // the all-tiers-fail throw
        "requests hermes harness but hermes is not available", // the launch-path refusal
        "filesystem-read-only",  // the zero-mutation contract
        "treeSnapshot",          // the snapshot machinery
      ]) {
        assert.ok(runner.includes(needle), `W4.41 runner must cover ${needle}`);
      }
      const task = taskText(recordById(readManifest(), id));
      const armNeedles = id === "W4.41-login-shell-tier"
        ? ["zero-filesystem-mutation", "login-shell", "tier"]
        : ["zero-filesystem-mutation", "diagnosable", "worker_lost", "refusal"];
      for (const needle of armNeedles) {
        assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          `${id} task must pin ${needle}`);
      }
    }
  });

  it("W4.43 declares 10 distinct refusal diagnostics with zero run rows; W4.44 has the double-tap + post-success-immunity arms (AC3)", () => {
    const w443 = recordById(readManifest(), "W4.43-refusal-storm");
    assert.equal(w443.harness, "local", "W4.43 must be a local-command cell (zero tokens)");
    assert.equal(w443.caps.tokens, 0, "W4.43 must be zero-token");
    const stormRunner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.43", "run-refusal-storm.mjs"), "utf8");
    for (const needle of [
      "INVALID_LAUNCHES",            // the 10-launch roster
      "nonexistent-workflow",        // diagnostic 1
      "malformed",                   // diagnostic 2
      "task-file",                   // diagnostics 3-4
      "pi-as-harness", "hermes-as-harness", // diagnostic 5
      "no-such-flag",                // diagnostic 6
      "no-task",                     // diagnostic 7
      "10",                          // the 10 distinct refusals
      "DISTINCT",                    // the distinctness contract
      "ZERO run rows",               // the zero-rows contract
      "runsBefore",                  // the run-count ledger check
      "live run",                    // the concurrent-live-run contract
      "dispatch latency",            // the latency measurement
      "follow-up",                   // no-lock-left-behind
    ]) {
      assert.ok(stormRunner.includes(needle), `W4.43 runner must cover ${needle}`);
    }
    const stormTask = taskText(w443);
    for (const needle of ["10", "distinct", "zero run rows", "dispatch latency", "lock/claim"]) {
      assert.match(stormTask, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.43 task must pin ${needle}`);
    }

    // W4.44: BOTH arms as distinct terminal rows.
    const w444a = recordById(readManifest(), "W4.44a-double-tap");
    assert.equal(w444a.harness, "local", "W4.44a must be a local-command cell");
    assert.equal(w444a.caps.tokens, 0, "W4.44a must be zero-token");
    const doubleTapRunner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.44", "run-double-tap.mjs"), "utf8");
    for (const needle of [
      "double-tap",                  // the corridor name
      "300",                         // the within-1s double-fire
      "TWO DISTINCT runs",           // the two-distinct-runs contract
      "both-runs-one-worktree",      // the S1 exclusion
      "worktree",                    // the worktree-mode arm
      "W4.42",                       // the direct-mode refusal reference (pinned by W4.42)
    ]) {
      assert.ok(doubleTapRunner.includes(needle), `W4.44a runner must cover ${needle}`);
    }
    const w444b = recordById(readManifest(), "W4.44b-post-success-immunity");
    assert.equal(w444b.harness, "local", "W4.44b must be a local-command cell");
    assert.equal(w444b.caps.tokens, 0, "W4.44b must be zero-token");
    const immunityRunner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.44", "run-post-success-immunity.mjs"), "utf8");
    for (const needle of [
      "rugpull",                     // the rugpull corridor
      "replacement",                 // zero-replacement-runs
      "branch", "-f",                // the target move injection (git branch -f)
      "RUGPULL_WINDOW",              // the observation window
      "run.rugpull_detected",        // the closed-window event check
      "terminal",                    // the terminal-state anchor
    ]) {
      assert.ok(immunityRunner.includes(needle), `W4.44b runner must cover ${needle}`);
    }
  });

  it("W4.46's task asserts retry-with-backoff and PROVIDER_FAIL discipline; W4.47 asserts no fallback to the real ~/.pi (O15) (AC4)", () => {
    const w446 = recordById(readManifest(), "W4.46-provider-error-rounds");
    assert.equal(w446.harness, "scripted-pi", "W4.46 must run scripted-pi");
    assert.equal(w446.context.execution_mode, "scripted", "W4.46 must be execution_mode scripted");
    assert.equal(w446.caps.tokens, 0, "W4.46 must be zero-token");
    const behaviors = JSON.parse(
      fs.readFileSync(path.join(ttRoot, CELL_DIRS["W4.46-provider-error-rounds"], "behaviors.json"), "utf8"));
    const fixer = behaviors.agents.fixer;
    assert.ok(Array.isArray(fixer) && fixer.length === 4,
      "W4.46 fixer behaviors must be a 4-entry array (429 -> 529 -> mid-stream-drop -> success)");
    assert.equal(fixer[0].provider_error.shape, "429", "round 1 must be a 429-shaped error");
    assert.equal(fixer[1].provider_error.shape, "529", "round 2 must be a 529/overloaded error");
    assert.equal(fixer[2].provider_error.shape, "mid-stream-drop", "round 3 must be a mid-stream drop");
    assert.ok(!fixer[3].provider_error, "round 4 must be the success round");
    const w446Task = taskText(w446);
    for (const needle of ["backoff", "inter-attempt", "PROVIDER_FAIL", "O11", "strike"]) {
      assert.match(w446Task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.46 task must pin ${needle}`);
    }
    const w446Runner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.46", "run-provider-error.mjs"), "utf8");
    for (const needle of ["backoff", "inter-attempt spacing", "PROVIDER_FAIL", "abandonment", "provider_error shape", "invocations.jsonl", "429", "529", "mid-stream-drop"]) {
      assert.ok(w446Runner.includes(needle), `W4.46 runner must cover ${needle}`);
    }

    const w447 = recordById(readManifest(), "W4.47-auth-expiry-copy");
    assert.equal(w447.harness, "pi", "W4.47 must run the REAL pi harness (the diagnosable auth error needs the real binary)");
    assert.equal(w447.context.execution_mode, "real", "W4.47 must be a real row");
    assert.equal(w447.workflow, "do-now", "W4.47 must be a do-now");
    assert.equal(w447.context.test_cmd, "npm test", "W4.47 must carry the tt-ts canonical test_cmd");
    assert.equal(w447.caps.tokens, 200000, "W4.47 caps must sit at the do-now unit");
    assert.ok(w447.caps.wall_min >= 5, "W4.47 wall cap must be at/above the do-now floor");
    assert.ok(w447.requires?.capabilities?.includes("pi"), "W4.47 must gate on capabilities pi (harness presence)");
    const w447Task = taskText(w447);
    for (const needle of ["O15", "`~/.pi`", "access", "diagnosable", "restore", "never a fallback"]) {
      assert.match(w447Task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.47 task must pin ${needle}`);
    }
    // O15 is the CAMPAIGN-level W0/W6 oracle — it must NOT be declared in the
    // manifest oracle list (tier1-oracle-hygiene fails closed on
    // declared-but-missing oracles); the W4.36-O17 pattern.
    assert.ok(!w447.oracles.includes("O15"), "W4.47 must NOT declare O15 (campaign-level oracle; named in task text)");
    assert.deepEqual(w447.oracles.sort(), ["O1", "O11", "O3z", "O8"].sort(), "W4.47 must declare the do-now oracle set");
  });

  it("W4.42 pins the shared-workdir refusal contract (owning run named) — zero-token local-command cell", () => {
    const w442 = recordById(readManifest(), "W4.42-shared-workdir-refusal");
    assert.equal(w442.harness, "local", "W4.42 must be a local-command cell");
    assert.equal(w442.caps.tokens, 0, "W4.42 must be zero-token");
    assert.equal(w442.command.executable, "scenarios/lib/run-scripted-scenario", "W4.42 must use the scripted-scenario hook");
    const runner = fs.readFileSync(path.join(ttRoot, "scenarios", "w4.42", "run-shared-workdir.mjs"), "utf8");
    for (const needle of [
      "working-directory-for-harness", // DIRECT (non-worktree) mode
      "already scheduled for run",   // the refusal text (owning run named)
      "admitted",                    // run-1 must be admitted first
      "interleav",                   // the S1 exclusion
      "owning",                      // the owner-named contract
    ]) {
      assert.ok(runner.includes(needle), `W4.42 runner must cover ${needle}`);
    }
    const task = taskText(w442);
    for (const needle of ["owning run", "interleav", "S1", "refused"]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.42 task must pin ${needle}`);
    }
  });

  it("all 11 scenario cells exist, pass the shared validator, and their run.sh is executable", () => {
    for (const id of SECTION_IJK_IDS) {
      if (id === "W4.47-auth-expiry-copy") continue; // real row, no cell
      const record = recordById(readManifest(), id);
      const cellDir = CELL_DIRS[id];
      const scenarioDir = path.join(ttRoot, cellDir);
      const scenarioJson = path.join(scenarioDir, "scenario.json");
      assert.ok(fs.existsSync(scenarioJson), `${id}: scenario.json must exist`);
      const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
      assert.equal(scenario.id, record.context.scenario_id, `${id}: scenario.id must match context.scenario_id`);
      assert.equal(scenario.expected_outcome, record.context.scenario_expected_outcome,
        `${id}: scenario.expected_outcome must match`);
      for (const file of ["run.sh", "behaviors.json"]) {
        const details = fs.lstatSync(path.join(scenarioDir, file), { throwIfNoEntry: false });
        assert.ok(details?.isFile(), `${id}: scenario cell file missing: ${file}`);
      }
      const runSh = path.join(scenarioDir, "run.sh");
      assert.ok(fs.accessSync(runSh, fs.constants.X_OK) === undefined, `${id}: run.sh must be executable`);
      const validated = run("node", [validator, path.join("torture-test", cellDir)]);
      assert.equal(validated.status, 0, `${id}: validate-scenario must pass:\n${validated.stdout}${validated.stderr}`);
    }
  });

  it("W4.41 resolver runners EXECUTE and prove tier-3 win + all-tiers-fail refusal + zero-filesystem-mutation", () => {
    // The scratch parent lives under gitignored var/ and may not exist on a
    // FRESH tree (var/scenarios is created by campaign runs, not by git) —
    // provision it so the test is hermetic from an empty var (the w4.25
    // aged-state-fixture pattern).
    fs.mkdirSync(path.join(varRoot, "scenarios"), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(varRoot, "scenarios", "w441-direct-"));
    try {
      for (const id of W4_41_ARMS) {
        const arm = id.replace("W4.41-", "");
        const res = run("node", [
          path.join("torture-test", "scenarios", "w4.41", "run-resolver-torture.mjs"),
          path.join("torture-test", "scenarios", "w4.41", arm),
        ], {
          TT_REPO_ROOT: repoRoot,
          TT_SCENARIO_STATE_DIR: path.join(scratch, arm),
          TT_SCENARIO_ID: `w4.41-${arm}`,
          TT_SCENARIO_COMMAND_GROUP_PROVEN: "1",
        }, 120_000);
        assert.equal(res.status, 0, `${id} runner must pass:\n${res.stdout}${res.stderr}`);
        const out = JSON.parse(res.stdout);
        assert.equal(out.result, "PASS", `${id} must report PASS`);
        assert.equal(out.filesystem_mutation, 0, `${id} must prove zero filesystem mutation`);
        if (arm === "login-shell-tier") {
          assert.equal(out.resolved_source, "login-shell", "login-shell arm must resolve via tier 3");
          assert.ok(out.resolved_path, "login-shell arm must return the resolved path");
        } else {
          assert.equal(out.refusal_code, "not_found", "all-tiers-fail arm must throw not_found");
          assert.match(out.admission_refusal, /requests hermes harness but hermes is not available/,
            "the launch-path refusal must be the diagnosable 'hermes is not available' refusal");
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("task files exist for the 12 section-I/J/K cases under cases/tasks/tier2/ and describe the corridor", () => {
    const records = readManifest();
    for (const id of SECTION_IJK_IDS) {
      const record = recordById(records, id);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${id}: task file must exist as a regular file: ${record.task}`);
      const realTask = fs.realpathSync(taskPath);
      assert.ok(realTask.startsWith(`${fs.realpathSync(tasksDir)}${path.sep}`),
        `${id}: task file must resolve inside cases/tasks/tier2/`);
      const task = taskText(record);
      assert.ok(task.trim().length > 0, `${id}: task file must be non-empty`);
      if (id.startsWith("W4.40") || id === "W4.46") {
        // The scripted-hermes/scripted-pi arms carry bug-fix seeds — the task
        // must name the seeded defect (seed-in-SEEDS.md + task-names-defect).
        assert.match(task, new RegExp(record.seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${id}: task must name the seeded defect (${record.seed})`);
      }
      if (CELL_DIRS[id]) {
        assert.match(task, new RegExp(CELL_DIRS[id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${id}: task must name its scenario cell (${CELL_DIRS[id]})`);
      }
    }
    // No leftover extra files beyond the 70 authored.
    const authored = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".md")).sort();
    const expected = records.map((record) => path.basename(record.task)).sort();
    assert.deepEqual(authored, expected, "cases/tasks/tier2/ must contain exactly the 70 authored task files");
  });

  it("the traceability report carries the section-I/J/K maps, exclusion enumerations, machinery deltas, and token budgets", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section I/, "section-I reference map header");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section J/, "section-J reference map header");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section K/, "section-K reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section I\)/, "section-I exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section J\)/, "section-J exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section K\)/, "section-K exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(section I\)/, "section-I token budget note");
    assert.match(trace, /## Token Budget Note \(section J\)/, "section-J token budget note");
    assert.match(trace, /## Token Budget Note \(section K\)/, "section-K token budget note");
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases");
    assert.match(trace, /| Wave 4 section I \(hermes stream & resolver torture\) \| 6 /,
      "manifest summary must show the 6 section-I rows");
    assert.match(trace, /| Wave 4 section J \(launch & control-plane hostility\) \| 4 /,
      "manifest summary must show the 4 section-J rows");
    assert.match(trace, /| Wave 4 section K \(provider & auth faults\) \| 2 /,
      "manifest summary must show the 2 section-K rows");
    for (const id of SECTION_IJK_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    // Machinery deltas for the section-I/J/K seams.
    assert.match(trace, /W4\.40 × 4 \(stream arms\)/, "traceability must document the W4.40 knob machinery");
    assert.match(trace, /W4\.41 × 2 \(resolver arms\)/, "traceability must document the W4.41 resolver delta");
    assert.match(trace, /TAMANDUA_HERMES_BINARY/, "traceability must document the daemon env-tier precedence delta");
    assert.match(trace, /W4\.42-shared-workdir-refusal/, "traceability must document the W4.42 admission-gate pin");
    assert.match(trace, /W4\.43-refusal-storm/, "traceability must document the W4.43 storm cell");
    assert.match(trace, /W4\.44b-post-success-immunity/, "traceability must document the W4.44b immunity cell");
    assert.match(trace, /W4\.46-provider-error-rounds/, "traceability must document the W4.46 behaviors array");
    assert.match(trace, /O15 \(production untouchedness\)/, "traceability must document the W4.47 O15 backstop");
    assert.match(trace, /never a silent trim/, "section-I/J/K exclusions must be documented, never silent");
  });
});
