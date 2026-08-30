// Tier-2 US-013: the dsh lane — four operator-directed dsh-harness cases
// (do-now / bfmw / fdmw / lifecycle) in cases/tier2.jsonl.
//
// The dsh lane makes dsh a first-class campaign harness: each W4.dsh-* row is
// a REAL case (harness "dsh", execution_mode real — scripted-dsh does not
// exist) spec_ref'd to its base wave-4 scenario (W4.37 / W4.02 / W4.06 /
// W4.33), with requires.capabilities ["dsh"] resolving to the host-profile
// harness.dsh.present leaf (US-001) and launch support from US-002
// (--dsh-as-harness argv, preflight dsh presence leg). The task texts name
// the dsh-specific contracts from the product README's dsh section:
// DSH_PERMISSION_MODE=danger-full-access injection (step reporting works) and
// the profile-pin caveat (hard-pinned sandbox rows break step complete).
//
// Zero-token by construction: the manifest assertions are pure file reads +
// --validate-only; the predicate-resolution leg runs the controller with
// --scripted-only over a scratch manifest of the four VERBATIM dsh rows under
// a synthesized host-profile (dsh present -> pending-real, dsh absent ->
// NOT_RUN(predicate)) — never a workflow launch, no model, no daemon. The
// synthesized profile is restored to the honest W0.0 profile in `finally`
// (the standard one-file-per-invocation host-profile pattern).
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
const hostProfilePath = path.join(ttRoot, "var", "w0", "host-profile.json");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

// The four dsh-lane rows (US-013). Each is a REAL dsh case spec_ref'd to its
// base scenario: do-now = W4.37 (KEY-line spoof), bfmw = W4.02 (fail_missing=1
// refusal), fdmw = W4.06 (moving-target rebase), lifecycle = W4.33 (resume
// after daemon restart).
const DSH_IDS = [
  "W4.dsh-do-now",
  "W4.dsh-bfmw",
  "W4.dsh-fdmw",
  "W4.dsh-lifecycle",
];

// base scenario id -> { fixture, canonical test_cmd, workflow, seeded? }.
const DSH_BASE: Record<string, { specRef: string; fixture: string; testCmd: string; workflow: string }> = {
  "W4.dsh-do-now": { specRef: "08-wave-4-fault-injection.md#W4.37", fixture: "tt-ts", testCmd: "npm test", workflow: "do-now" },
  "W4.dsh-bfmw": { specRef: "08-wave-4-fault-injection.md#W4.02", fixture: "tt-ts", testCmd: "npm test", workflow: "bug-fix-merge-worktree" },
  "W4.dsh-fdmw": { specRef: "08-wave-4-fault-injection.md#W4.06", fixture: "tt-go", testCmd: "go test ./...", workflow: "feature-dev-merge-worktree" },
  "W4.dsh-lifecycle": { specRef: "08-wave-4-fault-injection.md#W4.33", fixture: "tt-ts", testCmd: "npm test", workflow: "bug-fix-merge-worktree" },
};

const DSH_SEEDS: Record<string, string> = {
  "W4.dsh-bfmw": "BUG-T2",
  "W4.dsh-lifecycle": "BUG-T3",
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Spawn env for the controller: the operator env minus NODE_TEST_CONTEXT
// (node:test sets it in every test process, which would auto-arm the tamandua
// TEST ISOLATION guard inside the controller's spawned children) with
// TAMANDUA_TEST_GUARD explicitly disabled, and the harness binaries pinned to
// /bin/false so an accidental real launch can never spend tokens.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_TEST_GUARD: "0",
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runTt(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

type Case = Record<string, any>;

function readManifest(): Case[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function dshRows(): Case[] {
  return readManifest().filter((record) => record.harness === "dsh");
}

// A synthesized host-profile: everything the four dsh rows' requires need
// (platform linux, toolchains node+go, node_min 22 via nodeRuntimes) plus the
// harness block with the caller-controlled dsh presence. W0.0's honest
// profile is restored in the test's finally block.
function writeSynthesizedProfile(dshPresent: boolean): void {
  const profile = {
    platform: { os: "linux", arch: "arm64", release: "0.0.0", label: "linux" },
    containment: { systemdUserScope: true },
    toolchains: {
      node: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
      go: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
    },
    capabilities: { "node-runtimes-2": true },
    nodeRuntimes: [{ version: "v24.0.0", major: 24, minor: 0, patch: 0, sqliteAvailable: true }],
    harness: {
      pi: { present: true, authenticated: null, skipReason: "synthesized" },
      hermes: { present: true, authenticated: null, skipReason: "synthesized" },
      dsh: { present: dshPresent, authenticated: null, skipReason: dshPresent ? "synthesized" : "synthesized-absent" },
    },
  };
  fs.writeFileSync(hostProfilePath, `${JSON.stringify(profile, null, 2)}\n`);
}

// A scratch manifest containing the four VERBATIM dsh rows (copied from
// cases/tier2.jsonl so the predicate leg tests the REAL roster shape). The
// name carries a monotonic counter so two manifests written in the same
// millisecond never collide (Date.now() alone is not unique enough).
let scratchCounter = 0;
function writeScratchManifest(records: Case[]): string {
  scratchCounter += 1;
  const name = `US013-${Date.now()}-${process.pid}-${scratchCounter}.jsonl`;
  const manifestPath = path.join(ttRoot, "var", name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function campaignIdOf(res: RunResult): string | null {
  const m = CAMPAIGN_LINE.exec(res.stdout);
  return m === null ? null : m[1];
}

function loadCampaignState(campaignId: string): any {
  const statePath = path.join(ttRoot, "var", "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return loadJson(statePath);
}

describe("Tier-2 dsh lane (US-013) — four operator-directed dsh-harness cases", () => {
  it("the four dsh-lane rows exist with harness dsh, requires.capabilities [dsh], execution_mode real, spec_ref into their base W4 scenario, and --validate-only exits 0", () => {
    const rows = dshRows();
    assert.deepEqual(
      rows.map((record) => record.id).sort(),
      [...DSH_IDS].sort(),
      `tier2.jsonl must contain exactly the four dsh-lane rows (got ${rows.map((r) => r.id).join(", ")})`,
    );
    for (const record of rows) {
      assert.equal(record.harness, "dsh", `${record.id}: harness must be dsh`);
      assert.equal(record.context?.execution_mode, "real",
        `${record.id}: a dsh case is ALWAYS real (scripted-dsh does not exist)`);
      assert.ok(Array.isArray(record.requires?.capabilities) && record.requires.capabilities.includes("dsh"),
        `${record.id}: requires.capabilities must include dsh (resolves to host-profile harness.dsh.present)`);
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${record.id}: gates must be [TIER2, W4]`);
      const base = DSH_BASE[record.id];
      assert.ok(base, `${record.id}: must be a known dsh-lane base scenario`);
      assert.equal(record.spec_ref, base.specRef,
        `${record.id}: spec_ref must name its base scenario (${base.specRef})`);
      assert.equal(record.workflow, base.workflow, `${record.id}: workflow must match its base scenario`);
      assert.equal(record.fixture, base.fixture, `${record.id}: fixture must match its base scenario`);
      assert.equal(record.context?.test_cmd, base.testCmd,
        `${record.id}: context.test_cmd must be the fixture's canonical TEST_CMD (${base.testCmd})`);
      // E3.D: floors + caps per family (never below family p50).
      assert.ok(record.production_duration_floor_ms > 0, `${record.id}: must carry production_duration_floor_ms`);
      if (record.workflow === "bug-fix-merge-worktree") {
        assert.ok(record.caps.wall_min >= 35 && record.caps.tokens >= 1000000,
          `${record.id}: bfmw caps must sit at/above family p50 35-min / p95 1M`);
      } else if (record.workflow === "feature-dev-merge-worktree") {
        assert.ok(record.caps.wall_min >= 138 && record.caps.tokens >= 2500000,
          `${record.id}: fdmw caps must sit at/above family p50 138-min / p95 2.5M`);
      } else if (record.workflow === "do-now") {
        assert.ok(record.caps.wall_min >= 5 && record.caps.tokens >= 200000,
          `${record.id}: do-now caps must sit at the tier1 do-now unit (wall 5 / 200k)`);
      }
      // E3.C: chaos/probe blocks where the base scenario has them.
      if (record.id === "W4.dsh-bfmw") {
        assert.equal(record.chaos?.type, "delete-tstx-row",
          "W4.dsh-bfmw inherits the W4.02 drain-armed delete-tstx-row chaos block");
        assert.equal(record.chaos?.trigger, "step:finalize_merge:pending", "W4.dsh-bfmw delete arms at finalize pending");
        assert.equal(record.chaos?.tree, "TESTEDTREE", "W4.dsh-bfmw carries the TESTEDTREE sentinel");
        assert.equal(record.context?.fail_missing, "1", "W4.dsh-bfmw launches with --context fail_missing=1");
        assert.deepEqual(record.probe_sequence[0].actions.map((a: any) => a.op), ["pause_drain", "resume"],
          "W4.dsh-bfmw carries the pause_drain + resume probe sequence");
      }
      if (record.id === "W4.dsh-lifecycle") {
        assert.equal(record.chaos, null, "W4.dsh-lifecycle carries no chaos block (operator restart seam, W4.33a shape)");
        assert.deepEqual(record.probe_sequence[0].actions.map((a: any) => a.op), ["pause_drain", "resume"],
          "W4.dsh-lifecycle carries the pause_drain + resume probe sequence");
        assert.equal(record.probe_sequence[0].actions[0].when, "step:fixer:running",
          "W4.dsh-lifecycle pause_drain arms at step:fixer:running (the W4.33a shape — S29 calibration US-003: step:developer:running is not bfmw vocabulary)");
        assert.equal(record.probe_sequence[0].actions[1].expect?.run_completes, true,
          "W4.dsh-lifecycle resume expects run_completes (O16)");
        assert.ok(record.oracles.includes("O16"), "W4.dsh-lifecycle must declare O16");
      }
      if (record.id === "W4.dsh-fdmw") {
        assert.equal(record.chaos, null,
          "W4.dsh-fdmw carries chaos:null (colleague-commit is a documented machinery delta, W4.06 shape)");
        assert.equal(record.probe_id, "FEAT-G1", "W4.dsh-fdmw implements the FEAT-G1 feature backlog item");
      }
      if (record.id === "W4.dsh-do-now") {
        assert.equal(record.chaos, null, "W4.dsh-do-now carries no chaos block (reset-hook arming, W4.37 shape)");
        assert.deepEqual(record.oracles, ["O1", "O3z", "O8", "O11"],
          "W4.dsh-do-now declares the do-now oracle set (W4.37 pattern)");
      }
    }
    const res = runTt(controller, ["--manifest", "cases/tier2.jsonl", "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("every dsh task file names the DSH_PERMISSION_MODE=danger-full-access injection and the profile-pin caveat, plus its fixture and (where bug-fix) its seed", () => {
    for (const record of dshRows()) {
      const taskPath = path.join(ttRoot, record.task);
      const task = fs.readFileSync(taskPath, "utf8");
      assert.ok(task.trim().length > 0, `${record.id}: task file must be non-empty`);
      // AC3: the dsh-specific expectations from the README dsh section.
      assert.match(task, /DSH_PERMISSION_MODE\s*=\s*danger-full-access/,
        `${record.id}: task must name the DSH_PERMISSION_MODE=danger-full-access injection`);
      assert.match(task, /step complete|step reporting/,
        `${record.id}: task must tie the injection to step reporting`);
      assert.match(task, /profile-pin|profile pin|hard-pins|hard-pinned|cordis\.patch\.yml/,
        `${record.id}: task must name the profile-pin caveat (hard-pinned sandbox rows break step complete)`);
      // Task text must describe the fixture's actual contents.
      assert.match(task, new RegExp(record.fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${record.id}: task must describe the ${record.fixture} fixture`);
      // Bug-fix rows: task names the seeded defect the seed actually implants.
      if (DSH_SEEDS[record.id]) {
        assert.equal(record.seed, DSH_SEEDS[record.id], `${record.id}: seed must be ${DSH_SEEDS[record.id]}`);
        assert.match(task, new RegExp(DSH_SEEDS[record.id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${record.id}: task must name the seeded defect (seed ${DSH_SEEDS[record.id]})`);
      }
      // Task file lives under cases/tasks/tier2/ and resolves inside it.
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${record.id}: task must live under cases/tasks/tier2/`);
      const realTask = fs.realpathSync(taskPath);
      assert.ok(realTask.startsWith(`${fs.realpathSync(tasksDir)}${path.sep}`),
        `${record.id}: task must resolve inside cases/tasks/tier2/`);
    }
  });

  it("the dsh predicate resolves against harness.dsh.present in the host-profile: synthesized true -> pending-real under bare --scripted-only, false -> NOT_RUN(predicate)", () => {
    // AC2 at the ROSTER level, in two zero-token legs:
    //   Leg 1 (present -> pending-real): the four VERBATIM dsh rows under bare
    //   --scripted-only with a synthesized profile where harness.dsh.present
    //   is true. A dsh case is ALWAYS real, so scripted-only marks it
    //   pending-real (never executed as scripted, zero tokens) — but note the
    //   controller applies execution selection BEFORE predicates, so the
    //   verbatim-real leg cannot observe the absent direction.
    //   Leg 2 (absent -> NOT_RUN(predicate)): LOCAL-COMMAND copies of the four
    //   rows whose requires are preserved VERBATIM (the
    //   tier0-real-host-profile-predicate pattern — predicates are evaluated
    //   before execution, so a local command case proves the verdict without
    //   launching any workflow/harness). With harness.dsh.present=false the
    //   predicate gates NOT_RUN(predicate) naming capabilities.dsh; with true
    //   the same copies PASS (green, zero tokens).
    const rows = dshRows();
    assert.equal(rows.length, 4, "exactly the four dsh rows");
    const realManifestPath = writeScratchManifest(rows);
    const localCopies = rows.map((record) => ({
      id: record.id,
      wave: 4,
      workflow: "local",
      fixture: "none",
      harness: "local",
      task: record.task,
      context: { execution_mode: "scripted" },
      caps: { tokens: 0, wall_min: 5 },
      requires: record.requires, // preserved verbatim
      boundary_files: [],
      forbidden: [],
      oracles: [],
      gates: ["TIER2"],
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
    }));
    const localManifestPath = writeScratchManifest(localCopies);
    const campaignIds: string[] = [];
    try {
      // Leg 1: dsh present -> the verbatim real rows are pending-real under
      // bare --scripted-only (GREEN, zero tokens).
      writeSynthesizedProfile(true);
      let res = runTt(controller, ["--manifest", path.relative(ttRoot, realManifestPath), "--scripted-only"]);
      let campaignId = campaignIdOf(res);
      assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
      campaignIds.push(campaignId);
      let state = loadCampaignState(campaignId);
      for (const id of DSH_IDS) {
        const caseState = state.cases.find((c: any) => c.id === id);
        assert.ok(caseState, `${id} missing from campaign state`);
        assert.equal(caseState.outcome, "NOT_RUN", `${id}: dsh present -> NOT_RUN under bare --scripted-only`);
        assert.equal(caseState.reason?.category, "pending-real",
          `${id}: dsh present -> pending-real (never executed as scripted)`);
      }
      assert.equal(state.spend.tokens_observed, 0, "bare --scripted-only must spend zero tokens");

      // Leg 2a: dsh absent -> the LOCAL copies (verbatim requires) gate
      // NOT_RUN(predicate) with evidence naming capabilities.dsh.
      writeSynthesizedProfile(false);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, localManifestPath)]);
      campaignId = campaignIdOf(res);
      assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
      campaignIds.push(campaignId);
      state = loadCampaignState(campaignId);
      for (const id of DSH_IDS) {
        const caseState = state.cases.find((c: any) => c.id === id);
        assert.ok(caseState, `${id} missing from gated campaign state`);
        assert.equal(caseState.outcome, "NOT_RUN", `${id}: dsh absent -> NOT_RUN`);
        assert.equal(caseState.reason?.category, "predicate", `${id}: dsh absent -> gated category=predicate`);
        const evidence = caseState.reason?.evidence ?? [];
        assert.ok(evidence.length > 0, `${id}: predicate block must carry evidence`);
        assert.ok(evidence.some((e: any) => String(e?.predicate).includes("capabilities.dsh")),
          `${id}: evidence must name capabilities.dsh (got ${JSON.stringify(evidence)})`);
      }
      assert.equal(state.spend.tokens_observed, 0, "the gated campaign must spend zero tokens");

      // Leg 2b: dsh present -> the SAME local copies pass (predicate passes,
      // the zero-token local command completes green).
      writeSynthesizedProfile(true);
      res = runTt(controller, ["--manifest", path.relative(ttRoot, localManifestPath)]);
      campaignId = campaignIdOf(res);
      assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
      campaignIds.push(campaignId);
      state = loadCampaignState(campaignId);
      for (const id of DSH_IDS) {
        const caseState = state.cases.find((c: any) => c.id === id);
        assert.ok(caseState, `${id} missing from passing campaign state`);
        assert.equal(caseState.outcome, "PASS",
          `${id}: honestly-present dsh capability must NOT be gated (predicate passes)`);
      }
      assert.equal(state.spend.tokens_observed, 0, "the passing local campaign must spend zero tokens");
    } finally {
      fs.rmSync(realManifestPath, { force: true });
      fs.rmSync(localManifestPath, { force: true });
      for (const campaignId of campaignIds) {
        fs.rmSync(path.join(ttRoot, "var", "results", campaignId), { recursive: true, force: true });
      }
      // Restore the honest W0.0 profile so sibling tests see truth.
      runTt(path.join(ttRoot, "bin", "tt-verify-environment"), ["--fast", "--json"]);
    }
  });

  it("traceability documents the dsh-lane decision (operator-directed, alpha harness) and carries a row for every dsh case", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    // AC4: traceability rows for the dsh-lane decision.
    assert.match(trace, /dsh lane/, "traceability must carry the dsh-lane section");
    assert.match(trace, /operator-directed/,
      "the dsh-lane decision (operator-directed, alpha harness) must be documented");
    assert.match(trace, /alpha/,
      "the alpha-harness status must be documented");
    assert.match(trace, /DSH_PERMISSION_MODE/,
      "traceability must reference the DSH_PERMISSION_MODE injection contract");
    assert.match(trace, /profile-pin|profile pin|hard-pin/,
      "traceability must reference the profile-pin caveat");
    // Every dsh case id has a traceability row (traceability completeness).
    for (const id of DSH_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    // The dsh lane has its own reference map + exclusion enumeration + token
    // budget note.
    assert.match(trace, /## Case ↔ Spec Reference Map — dsh lane/, "dsh-lane reference map section");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(dsh lane\)/, "dsh-lane exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(dsh lane\)/, "dsh-lane token budget note");
    // The manifest summary counts the dsh lane.
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases incl. the dsh lane");
    assert.match(trace, /\| Real \(token-bearing\) cases \| 45 \|/,
      "manifest summary must show 45 real cases (the four dsh rows + the W5 storm row are real)");
  });
});
