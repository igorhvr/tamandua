// Tier-2 US-011: section-H (platform-conditional lanes) roster.
//
// Pins the section-H batch of cases/tier2.jsonl:
//   * the 4 new rows exist (W4.21-bare-noninteractive-launch,
//     W4.22-symlink-path-parity, W4.23-daemon-cross-runtime-restart,
//     W4.24-serial-lane-concurrent) and tt-controller --manifest
//     cases/tier2.jsonl --validate-only exits 0 (Validated 70 case(s));
//   * every `requires` key in the section-H cases is one of the CANONICAL
//     host-profile keys (E2.2 contract): platform / toolchains /
//     capabilities / containment / node_min — anything else is a validation
//     error (AC2);
//   * W4.21/22/23 predicates evaluate correctly against SYNTHESIZED linux
//     vs darwin host-profiles (matching host -> pass; non-matching ->
//     NOT_RUN(predicate) with evidence) — AC3: linux+2-runtimes passes
//     W4.21/23/24 and gates W4.22; darwin+2-runtimes passes W4.22 and gates
//     W4.21/23/24; linux+1-runtime gates W4.23 (capabilities.node-runtimes-2
//     absent) with evidence naming the predicate;
//   * W4.24 is a zero-token local-command case whose scenario cell runs the
//     product's serial lane concurrently with two contained scripted runs
//     (caps.tokens 0, the no-cross-talk corridor, the lane deadline
//     documented) — AC4 (the full cell's PASS under bare --tier2 is proven
//     end-to-end in the story verification; this file pins the shape +
//     runner + zero-token properties);
//   * all four cells pass the shared scenario validator; run.sh executable;
//     the W4.22 runner is EXECUTED directly against a contained scratch to
//     prove the symlink-parity corridor machinery (the platform-generic
//     runner, the section-F reset-hook-execution pattern);
//   * traceability rows + the section-H map + exclusion enumeration +
//     machinery-delta rows + token budget exist; manifest summary shows 70.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
// NOTE: this file REWRITES the shared var/w0/host-profile.json with
// synthesized profiles (AC3) — run it one-file-per-invocation (run.sh runs
// each file serially; do not combine it with
// tier0-real-host-profile-predicate.integration.test.ts in one node --test
// command — they race on the profile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const validator = path.join(ttRoot, "scenarios", "lib", "validate-scenario.mjs");
const verifyEnv = path.join(ttRoot, "bin", "tt-verify-environment");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");
const varRoot = path.join(ttRoot, "var");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");

// The 4 section-H cases (spec 08 §H, US-011).
const SECTION_H_IDS = [
  "W4.21-bare-noninteractive-launch",
  "W4.22-symlink-path-parity",
  "W4.23-daemon-cross-runtime-restart",
  "W4.24-serial-lane-concurrent",
];

// Scenario cell directory per case id.
const CELL_DIRS: Record<string, string> = {
  "W4.21-bare-noninteractive-launch": "scenarios/w4.21/bare-noninteractive-launch",
  "W4.22-symlink-path-parity": "scenarios/w4.22/symlink-path-parity",
  "W4.23-daemon-cross-runtime-restart": "scenarios/w4.23/daemon-cross-runtime-restart",
  "W4.24-serial-lane-concurrent": "scenarios/w4.24/serial-lane-concurrent",
};

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

// The canonical host-profile keys (E2.2 contract) — any other `requires` key
// is a validation error (AC2).
const CANONICAL_REQUIRES_KEYS = new Set(["platform", "toolchains", "capabilities", "containment", "node_min"]);

type Case = Record<string, any>;

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

// ── synthesized host-profiles (AC3) ──────────────────────────────────

function baseProfile(platform: string, runtimes: any[], nodeRuntimes2: boolean): any {
  return {
    platform: { os: platform, arch: "arm64", release: "0.0.0", label: platform },
    containment: { systemdUserScope: platform === "linux" },
    toolchains: {
      node: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
    },
    capabilities: { "node-runtimes-2": nodeRuntimes2 },
    nodeRuntimes: runtimes,
    npmVersion: "11.0.0",
    spawnSpeedClass: { class: "fast", medianMs: 1, iterations: 1 },
    diskHeadroom: { availableBytes: 1e12, available: "1 TB", thresholdBytes: 6.4e10, threshold: "60 GB" },
    harness: {
      pi: { present: true, authenticated: null },
      hermes: { present: true, authenticated: null },
      dsh: { present: true, authenticated: null },
    },
  };
}

const LINUX_2R = baseProfile("linux",
  [
    { version: "v22.23.1", major: 22, minor: 23, patch: 1, sqliteAvailable: true },
    { version: "v24.18.0", major: 24, minor: 18, patch: 0, sqliteAvailable: true },
  ], true);
const DARWIN_2R = baseProfile("darwin",
  [
    { version: "v22.23.1", major: 22, minor: 23, patch: 1, sqliteAvailable: true },
    { version: "v24.18.0", major: 24, minor: 18, patch: 0, sqliteAvailable: true },
  ], true);
const LINUX_1R = baseProfile("linux",
  [{ version: "v24.18.0", major: 24, minor: 18, patch: 0, sqliteAvailable: true }], false);

// A local-command case record carrying the REAL section-H case's `requires`
// verbatim — the controller evaluates predicates BEFORE execution, so the
// verdict is observable without launching anything (zero tokens).
function localCaseRecord(id: string, requires: any): any {
  return {
    id,
    wave: 4,
    workflow: "local",
    fixture: "none",
    harness: "local",
    task: `cases/tasks/tier2/${id}.md`,
    context: { execution_mode: "scripted" },
    caps: { tokens: 0, wall_min: 5 },
    requires,
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    reset: { executable: "node", args: ["-e", "process.exit(0)"], cwd: "." },
    command: {
      executable: "node",
      args: ["-e", "console.log(JSON.stringify({status:'done'}));process.exit(0)"],
      cwd: ".",
    },
  };
}

function writeProfile(profile: any): void {
  fs.mkdirSync(path.dirname(hostProfilePath), { recursive: true });
  fs.writeFileSync(hostProfilePath, `${JSON.stringify(profile, null, 2)}\n`);
}

function restoreHonestProfile(): void {
  // The profile file is ALWAYS rewritten by writeProfileFiles even when a
  // check fails (e.g. a concurrent campaign holds the scripted ports), so a
  // non-zero exit still restores an honest profile. Tolerate it: the restore
  // is a best-effort courtesy to sibling tests.
  run(verifyEnv, ["--fast", "--json"]);
  assert.ok(fs.existsSync(hostProfilePath), "restored host-profile.json must exist");
}

function writeManifest(records: any[]): string {
  const name = `US011-${Date.now()}-${process.pid}.jsonl`;
  const manifestPathScratch = path.join(varRoot, name);
  fs.writeFileSync(manifestPathScratch, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPathScratch;
}

function runCampaign(scratchManifest: string): { campaignId: string; state: any } {
  const rel = path.relative(ttRoot, scratchManifest);
  // The controller resolves the manifest against its cwd (ttRoot) — the
  // tier0-real-host-profile-predicate pattern.
  const res = run(controller, ["--manifest", rel], {}, 300_000, ttRoot);
  const m = CAMPAIGN_LINE.exec(res.stdout);
  assert.ok(m, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
  const campaignId = m[1];
  const statePath = path.join(varRoot, "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return { campaignId, state: JSON.parse(fs.readFileSync(statePath, "utf8")) };
}

describe("Tier-2 US-011 — section-H roster (platform-conditional lanes)", () => {
  it("cases/tier2.jsonl contains the 4 section-H cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_H_IDS) {
      assert.ok(ids.includes(id), `section-H case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("every requires key in the section-H cases is one of the canonical host-profile keys (AC2)", () => {
    for (const id of SECTION_H_IDS) {
      const record = recordById(readManifest(), id);
      const requires = record.requires ?? {};
      const keys = Object.keys(requires);
      for (const key of keys) {
        assert.ok(CANONICAL_REQUIRES_KEYS.has(key),
          `${id}: requires key "${key}" is NOT a canonical host-profile key (E2.2: platform/toolchains/capabilities/containment/node_min)`);
      }
    }
  });

  it("W4.21/22/23/24 are zero-token scripted local-command cells in the tier0 w4.49 cell shape", () => {
    for (const id of SECTION_H_IDS) {
      const record = recordById(readManifest(), id);
      assert.equal(record.harness, "local", `${id} must be a local-command case`);
      assert.equal(record.workflow, "local", `${id} must be a local (non-workflow) case`);
      assert.equal(record.context.execution_mode, "scripted", `${id} must be execution_mode scripted`);
      assert.equal(record.caps.tokens, 0, `${id} must be zero-token`);
      assert.equal(record.fixture, "none", `${id} provisions no fixture (the scenario builds its own)`);
      assert.ok(record.command, `${id} must carry the local command hook (the tier0 w4.49 scenario-cell shape)`);
      assert.equal(record.command.executable, "scenarios/lib/run-scripted-scenario",
        `${id} command hook must be the shared scripted-scenario harness`);
      const cellDir = CELL_DIRS[id];
      assert.deepEqual(record.command.args, [cellDir], `${id} command hook must point at its scenario cell`);
      assert.ok(record.context.scenario_id.startsWith("w4."), `${id} scenario_id must match the cell id`);
      assert.equal(record.context.scenario_path, cellDir, `${id} scenario_path must match`);
      assert.equal(record.context.expected_command_outcome, "PASS", `${id} expected_command_outcome must be PASS`);
      // The standard zero-token cell shape.
      assert.ok(record.requires?.capabilities?.includes("node-sqlite"), `${id} must require node-sqlite`);
      if (id !== "W4.22-symlink-path-parity") {
        // W4.22 performs PURE LOCAL path checks (git + containment machinery)
        // and never launches a workflow run — it must NOT require the
        // contained daemon's systemd-user-scope (a darwin host — its matching
        // platform — has no systemd user scope; daemon-control uses the
        // no-systemd fallback there).
        assert.ok(record.requires?.containment?.includes("systemd-user-scope"),
          `${id} must require systemd-user-scope containment`);
      } else {
        assert.ok(record.requires?.containment === undefined,
          "W4.22 must NOT require containment (pure local path checks, no daemon dependency)");
      }
      assert.equal(record.requires?.node_min, 22, `${id} must require node_min 22`);
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${id} gates must be [TIER2, W4]`);
      assert.equal(record.class, "verification", `${id} must be verification (mechanical corridor)`);
      assert.equal(record.mandatory, true, `${id} must be mandatory`);
      assert.equal(record.shed_ok, false, `${id} must not be shed-ok`);
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${id} spec_ref must point into spec 08`);
      assert.equal(record.chaos, null, `${id} must carry chaos null`);
      assert.ok(record.production_duration_floor_ms > 0, `${id} must carry production_duration_floor_ms`);
    }
    // Platform-conditional pins: W4.21 gates linux, W4.22 gates darwin
    // (the spec's [darwin] marker), W4.23 gates linux + node-runtimes-2.
    assert.equal(recordById(readManifest(), "W4.21-bare-noninteractive-launch").requires.platform, "linux",
      "W4.21 must gate platform linux (documented host adaptation)");
    assert.equal(recordById(readManifest(), "W4.22-symlink-path-parity").requires.platform, "darwin",
      "W4.22 must gate platform darwin (the spec's [darwin] marker)");
    const w423 = recordById(readManifest(), "W4.23-daemon-cross-runtime-restart");
    assert.equal(w423.requires.platform, "linux", "W4.23 must gate platform linux");
    assert.ok(w423.requires.capabilities.includes("node-runtimes-2"),
      "W4.23 must express the >=2-runtimes requirement via capabilities.node-runtimes-2 (documented exact key)");
    assert.equal(recordById(readManifest(), "W4.24-serial-lane-concurrent").requires.platform, "linux",
      "W4.24 must gate platform linux");
  });

  it("each scenario cell exists, passes the shared validator, and its run.sh is executable", () => {
    for (const id of SECTION_H_IDS) {
      const record = recordById(readManifest(), id);
      const cellDir = CELL_DIRS[id];
      const scenarioDir = path.join(ttRoot, cellDir);
      const scenarioJson = path.join(scenarioDir, "scenario.json");
      assert.ok(fs.existsSync(scenarioJson), `${id}: scenario.json must exist`);
      const scenario = JSON.parse(fs.readFileSync(scenarioJson, "utf8"));
      assert.equal(scenario.id, record.context.scenario_id, `${id}: scenario.id must match context.scenario_id`);
      assert.equal(scenario.expected_outcome, record.context.scenario_expected_outcome,
        `${id}: scenario.expected_outcome must match`);
      assert.deepEqual(scenario.oracles, ["O1", "O3z", "O11"], `${id}: local-case oracle set`);
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

  it("W4.21/22/23 predicates evaluate correctly against synthesized linux vs darwin host-profiles (AC3)", () => {
    const records = readManifest();
    const requiresBy = Object.fromEntries(SECTION_H_IDS.map((id) => [id, recordById(records, id).requires]));
    const scratch = writeManifest(SECTION_H_IDS.map((id) => localCaseRecord(id, requiresBy[id])));
    const campaignIds: string[] = [];
    try {
      // (a) linux + 2 distinct runtimes: W4.21/23/24 pass, W4.22 gated.
      writeProfile(LINUX_2R);
      let camp = runCampaign(scratch);
      campaignIds.push(camp.campaignId);
      let state = camp.state.cases;
      for (const id of ["W4.21-bare-noninteractive-launch", "W4.23-daemon-cross-runtime-restart", "W4.24-serial-lane-concurrent"]) {
        const cs = state.find((c: any) => c.id === id);
        assert.notEqual(cs?.outcome, "NOT_RUN", `${id} must pass on a linux+2-runtimes host`);
        assert.notEqual(cs?.reason?.category, "predicate", `${id} must not be predicate-blocked on linux+2-runtimes`);
      }
      const w422 = state.find((c: any) => c.id === "W4.22-symlink-path-parity");
      assert.equal(w422?.outcome, "NOT_RUN", "W4.22 (platform darwin) must gate NOT_RUN on a linux host");
      assert.equal(w422?.reason?.category, "predicate", "W4.22 must be gated category=predicate on linux");
      assert.match(JSON.stringify(w422?.reason?.evidence ?? []), /platform/,
        "W4.22's predicate block evidence must name the platform predicate");

      // (b) darwin + 2 distinct runtimes: W4.22 passes, W4.21/23/24 gated.
      writeProfile(DARWIN_2R);
      camp = runCampaign(scratch);
      campaignIds.push(camp.campaignId);
      state = camp.state.cases;
      const w422b = state.find((c: any) => c.id === "W4.22-symlink-path-parity");
      assert.notEqual(w422b?.outcome, "NOT_RUN", "W4.22 must pass on a darwin host (matching platform)");
      assert.notEqual(w422b?.reason?.category, "predicate", "W4.22 must not be predicate-blocked on darwin");
      for (const id of ["W4.21-bare-noninteractive-launch", "W4.23-daemon-cross-runtime-restart", "W4.24-serial-lane-concurrent"]) {
        const cs = state.find((c: any) => c.id === id);
        assert.equal(cs?.outcome, "NOT_RUN", `${id} (platform linux) must gate NOT_RUN on a darwin host`);
        assert.equal(cs?.reason?.category, "predicate", `${id} must be gated category=predicate on darwin`);
      }

      // (c) linux + ONE runtime: W4.23 gates on capabilities.node-runtimes-2
      //     (absent) with evidence naming the predicate.
      writeProfile(LINUX_1R);
      camp = runCampaign(scratch);
      campaignIds.push(camp.campaignId);
      state = camp.state.cases;
      const w423c = state.find((c: any) => c.id === "W4.23-daemon-cross-runtime-restart");
      assert.equal(w423c?.outcome, "NOT_RUN", "W4.23 (node-runtimes-2 absent) must gate NOT_RUN on a 1-runtime host");
      assert.equal(w423c?.reason?.category, "predicate", "W4.23 must be gated category=predicate");
      const w423Evidence = JSON.stringify(w423c?.reason?.evidence ?? []);
      assert.match(w423Evidence, /capabilities\.node-runtimes-2/,
        "W4.23's predicate block evidence must name capabilities.node-runtimes-2");
      for (const id of ["W4.21-bare-noninteractive-launch", "W4.24-serial-lane-concurrent"]) {
        const cs = state.find((c: any) => c.id === id);
        assert.notEqual(cs?.outcome, "NOT_RUN", `${id} must pass on a linux+1-runtime host (no node-runtimes-2 gate)`);
      }
    } finally {
      restoreHonestProfile();
      fs.rmSync(scratch, { force: true });
      for (const campaignId of campaignIds) {
        fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
      }
    }
  });

  it("W4.21's runner covers the bare non-interactive full-launch corridor (working run OR diagnosable refusal, never worker_lost loops)", () => {
    const record = recordById(readManifest(), "W4.21-bare-noninteractive-launch");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.21-bare-noninteractive-launch"], "run-bare-noninteractive.mjs"), "utf8");
    for (const needle of [
      "env", "-i",                      // the bare non-interactive shell construction
      "workflow", "run",                // the full launch verb
      "command -v node",                // PATH self-verification
      "worker_lost_count",              // the never-silent-worker_lost-loop assertion
      "step.worker_lost",               // the event-level loop check
      "worktree-origin-repository",     // the bfmw scratch-origin launch
      "diagnosable",                    // branch B's diagnosable-refusal contract
    ]) {
      assert.ok(runner.includes(needle), `W4.21 runner must cover ${needle}`);
    }
    const task = taskText(record);
    for (const needle of ["env -i", "worker_lost", "bare", "diagnosable", "platform"]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.21 task must pin ${needle}`);
    }
  });

  it("W4.22's runner exercises worktree checks, TSTX hashing, and containment on both path forms — EXECUTED against a contained scratch", () => {
    const record = recordById(readManifest(), "W4.22-symlink-path-parity");
    const runnerPath = path.join(ttRoot, CELL_DIRS["W4.22-symlink-path-parity"], "run-symlink-path-parity.mjs");
    const runner = fs.readFileSync(runnerPath, "utf8");
    for (const needle of [
      "assertContainedHome",            // the REAL containment machinery
      "worktree", "list",               // worktree checks
      "rev-parse", "HEAD^{tree}",       // TSTX hashing
      "realpath",                       // realpath-form resolution
      "symlink",                        // the /var -> /private/var model
      "fixtures-real", "fixtures-link", // the two path forms
    ]) {
      assert.ok(runner.includes(needle), `W4.22 runner must cover ${needle}`);
    }
    // EXECUTE the platform-generic runner directly against a contained
    // scratch dir (the section-F reset-hook-execution pattern) — proves the
    // corridor machinery (parity + fail-closed containment) on this host.
    // The scratch parent lives under gitignored var/ and may not exist on a
    // FRESH tree (var/scenarios is created by campaign runs, not by git) —
    // provision it so the test is hermetic from an empty var (the w4.25
    // aged-state-fixture pattern).
    fs.mkdirSync(path.join(varRoot, "scenarios"), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(varRoot, "scenarios", "w422-direct-"));
    try {
      const res = run("node", [path.join("torture-test", CELL_DIRS["W4.22-symlink-path-parity"], "run-symlink-path-parity.mjs")], {
        TT_REPO_ROOT: repoRoot,
        TT_SCENARIO_STATE_DIR: scratch,
        TT_SCENARIO_ID: "w4.22-symlink-path-parity",
        TAMANDUA_STATE_DIR: path.join(varRoot, "home-scripted", ".tamandua"),
        TT_SCENARIO_COMMAND_GROUP_PROVEN: "1",
      });
      assert.equal(res.status, 0, `W4.22 runner must pass against a contained scratch:\n${res.stdout}${res.stderr}`);
      const out = JSON.parse(res.stdout);
      assert.equal(out.result, "PASS", "W4.22 runner must report PASS");
      assert.equal(out.worktree_parity, true, "worktree checks must be identical across path forms");
      assert.equal(out.tstx_parity, true, "TSTX hashing must be identical across path forms");
      assert.equal(out.containment.realpath_form, "accepted", "realpath form must be contained");
      assert.equal(out.containment.symlink_form, "accepted", "symlinked form must be contained (no false failure)");
      assert.equal(out.containment.out_of_var_control, "rejected", "the out-of-var control symlink must be rejected (fail-closed)");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    const task = taskText(record);
    for (const needle of ["darwin", "symlink", "realpath", "TSTX", "worktree", "containment"]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.22 task must pin ${needle}`);
    }
  });

  it("W4.23's runner covers the daemon stop/start across node runtimes with zero behavioral drift (DC44)", () => {
    const record = recordById(readManifest(), "W4.23-daemon-cross-runtime-restart");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.23-daemon-cross-runtime-restart"], "run-cross-runtime.mjs"), "utf8");
    for (const needle of [
      "daemon-control", "scripted", "start", "stop",  // the daemon lifecycle
      "sqlite_master",                                // schema drift check
      "zero behavioral drift",                        // the DC44 contract
      "runtime B",                                    // the cross-runtime switch
      // "/proc/" needle is a linux-only assertion string (MACP3 US-003): it
      // is matched against run-cross-runtime.mjs SOURCE text only, never a
      // runtime /proc access — unreachable as runtime code on Darwin.
      "/proc/", "exe",                                // daemon-node assertion
      "volta",                                        // runtime discovery source
    ]) {
      assert.ok(runner.includes(needle), `W4.23 runner must cover ${needle}`);
    }
    const task = taskText(record);
    for (const needle of ["node-runtimes-2", "zero behavioral drift", "DC44", "runtime A", "runtime B"]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.23 task must pin ${needle}`);
    }
  });

  it("W4.24 is the zero-token serial-lane-concurrent cell: product serial lane + 2 TT runs, no cross-talk", () => {
    const record = recordById(readManifest(), "W4.24-serial-lane-concurrent");
    assert.equal(record.caps.tokens, 0, "W4.24 must be zero-token (AC4)");
    assert.equal(record.caps.wall_min, 45, "W4.24 wall cap must cover the product serial lane (the honest corridor)");
    const runner = fs.readFileSync(
      path.join(ttRoot, CELL_DIRS["W4.24-serial-lane-concurrent"], "run-serial-lane-concurrent.mjs"), "utf8");
    for (const needle of [
      "run-serial-tests.sh",            // the PRODUCT's own serial lane
      "npm run build",                  // the sequential product build
      "TEST ISOLATION VIOLATION",       // the no-cross-talk guard check
      "cleanLaneEnv",                   // the cleaned host env
      "no cross-talk",                  // the contract
      "TMPDIR",                         // lane temp-state isolation
      "worker_lost_count",              // TT runs unaffected
      "workflow", "run",                // the two contained TT runs
    ]) {
      assert.ok(runner.includes(needle), `W4.24 runner must cover ${needle}`);
    }
    const task = taskText(record);
    for (const needle of ["serial lane", "run-serial-tests.sh", "no cross-talk", "zero tokens", "concurrent"]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.24 task must pin ${needle}`);
    }
  });

  it("task files exist for the 4 section-H cases under cases/tasks/tier2/ and describe the cell's actual contents", () => {
    const records = readManifest();
    for (const id of SECTION_H_IDS) {
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
      // The section-H cells have fixture "none" — the scenario cell IS the
      // content; each task must name its own cell directory.
      assert.match(task, new RegExp(CELL_DIRS[id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${id}: task must name its scenario cell (${CELL_DIRS[id]})`);
    }
    // No leftover extra files beyond the 53 authored.
    const authored = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".md")).sort();
    const expected = records.map((record) => path.basename(record.task)).sort();
    assert.deepEqual(authored, expected, "cases/tasks/tier2/ must contain exactly the 53 authored task files");
  });

  it("the traceability report carries the section-H map, exclusion enumeration, machinery deltas, and token budget", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section H/, "section-H reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section H\)/, "section-H exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(section H\)/, "section-H token budget note");
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases");
    assert.match(trace, /| Wave 4 section H \(platform-conditional lanes\) \| 4 /,
      "manifest summary must show the 4 section-H rows");
    for (const id of SECTION_H_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    // Machinery deltas for the section-H seams.
    assert.match(trace, /W4\.21-bare-noninteractive-launch/, "traceability must document the W4.21 bare-shell delta");
    assert.match(trace, /node-runtimes-2/, "traceability must document the node-runtimes-2 capability recording");
    assert.match(trace, /W4\.24-serial-lane-concurrent/, "traceability must document the W4.24 serial-lane cell");
    assert.match(trace, /never a silent trim/, "section-H exclusions must be documented, never silent");
  });
});
