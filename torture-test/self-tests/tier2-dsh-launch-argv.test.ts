// Tier-2 US-002: controller dsh launch support — --dsh-as-harness argv,
// preflight presence leg, fail-closed harness mapping.
//
// The controller previously mapped every non-pi harness to --hermes-as-harness
// (silent substitution) and its real-case preflight probed only pi/hermes.
// This file pins the Tier-2 dsh lane: a dsh case launches with the scheduler
// flag --dsh-as-harness (never --hermes-as-harness / --pi-as-harness), routes
// to executeWorkflowCase as a REAL case (never the scripted environment), the
// real-case preflight probes dsh via tt-harness-auth-probe's dsh PRESENCE
// leg (binary-only; record-only; absent -> fail-closed harness-auth-missing:
// dsh; answer leg alpha-skipped unless --spend), and an unknown harness value
// fails closed at manifest validation instead of silently defaulting to
// hermes.
//
// Zero-token by construction: the argv proof uses the controller's
// TT_DRY_RUN_REAL_LAUNCH hook (records the exact launch argv, marks the case
// PASS, never spawns a model-backed run), the preflight wiring test uses stub
// helpers that only log their invocation, and the probe-level tests use a
// fake dsh binary — no live dsh invocation, no daemon, no tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const authProbe = path.join(binDir, "tt-harness-auth-probe");
const varRoot = path.join(ttRoot, "var");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;
const DSH_CASE_ID = "T2-DSH-LAUNCH";
const LOCAL_CASE_ID = "T2-DSH-LAUNCH-LOCAL";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Spawn env for the controller/probe: the operator env minus NODE_TEST_CONTEXT
// (node:test sets it in every test process, which would auto-arm the tamandua
// TEST ISOLATION guard inside the controller's spawned children — the
// standard self-test pattern, see tier0-repeatability/tier1-cap-calibration)
// and with TAMANDUA_TEST_GUARD explicitly disabled, so the contained
// torture-test/var state (never the operator's ~/.tamandua) is usable by the
// campaign machinery.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env, TAMANDUA_TEST_GUARD: "0" };
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

function runBash(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync("bash", [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 120_000,
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

// A real-shaped dsh case record: harness "dsh", execution_mode real, workflow
// do-now on the tt-ts fixture. This is the Tier-2 dsh lane shape (operator-
// directed alpha harness) — a dsh case is ALWAYS real.
function dshCaseRecord(): any {
  return {
    id: DSH_CASE_ID,
    wave: 4,
    workflow: "do-now",
    fixture: "tt-ts",
    harness: "dsh",
    task: `cases/tasks/tier2/${DSH_CASE_ID}.md`,
    context: { execution_mode: "real", test_cmd: "npm test" },
    caps: { tokens: 0, wall_min: 5 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: false,
    class: "verification",
    spec_ref: "08-wave-4-fault-injection.md#W4.37",
    production_duration_floor_ms: 60_000,
  };
}

// A zero-token scripted local-command case (completes green via `node -e`).
function localScriptedCaseRecord(): any {
  return {
    id: LOCAL_CASE_ID,
    wave: 4,
    workflow: "local",
    fixture: "none",
    harness: "local",
    task: `cases/tasks/tier2/${LOCAL_CASE_ID}.md`,
    context: { execution_mode: "scripted" },
    caps: { tokens: 0, wall_min: 5 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    reset: { executable: "node", args: ["-e", "1"], cwd: "." },
    command: { executable: "node", args: ["-e", "process.exit(0)"], cwd: "." },
  };
}

function writeManifest(records: any[]): string {
  const name = `US002-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function campaignIdOf(res: RunResult): string | null {
  const m = CAMPAIGN_LINE.exec(res.stdout);
  return m === null ? null : m[1];
}

function loadCampaignState(campaignId: string): any {
  const statePath = path.join(varRoot, "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return loadJson(statePath);
}

describe("Tier-2 dsh launch support in tt-controller (US-002)", () => {
  it("dry-run (TT_DRY_RUN_REAL_LAUNCH) argv for a dsh case contains --dsh-as-harness and never --hermes-as-harness/--pi-as-harness; routes to executeWorkflowCase as REAL with zero tokens", () => {
    const manifestPath = writeManifest([dshCaseRecord()]);
    const outPath = path.join(varRoot, `us002-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    // AC1: the recorded launch argv carries --dsh-as-harness and NO
    // --hermes-as-harness / --pi-as-harness.
    assert.ok(fs.existsSync(outPath), `argv-recording file was not written: ${outPath}`);
    const lines = fs
      .readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "one argv record for the single dsh case");
    const record = lines[0];
    assert.equal(record.case_id, DSH_CASE_ID);
    assert.equal(record.harness, "dsh");
    assert.equal(record.workflow, "do-now");
    assert.equal(record.executable, "tamandua");
    assert.ok(Array.isArray(record.argv), "record must carry the argv array");
    assert.ok(record.argv.includes("--dsh-as-harness"),
      `argv must include --dsh-as-harness (got ${JSON.stringify(record.argv)})`);
    assert.ok(!record.argv.includes("--hermes-as-harness"),
      "dsh argv must NOT include --hermes-as-harness");
    assert.ok(!record.argv.includes("--pi-as-harness"),
      "dsh argv must NOT include --pi-as-harness");
    const taskIdx = record.argv.indexOf("--task-file");
    assert.ok(taskIdx >= 0, "argv must include --task-file");
    assert.equal(record.argv[taskIdx + 1], `cases/tasks/tier2/${DSH_CASE_ID}.md`);
    assert.ok(record.argv.includes("--wait") && record.argv.includes("--json"),
      "argv must include the scheduler args --wait --json");
    assert.ok(record.work_clone?.existed === true,
      "the provisioned work clone must exist at argv-capture time");

    // AC3: the case routed to executeWorkflowCase (attempt.kind workflow,
    // execution_mode REAL — never the scripted environment) and completed
    // PASS with zero tokens.
    const state = loadCampaignState(campaignId!);
    const caseState = state.cases.find((c: any) => c.id === DSH_CASE_ID);
    assert.ok(caseState, "dsh case missing from campaign state");
    assert.equal(caseState.outcome, "PASS", "dry-run dsh case must be PASS");
    const attempt = caseState.attempts[0];
    assert.ok(attempt, "dsh case must have a recorded attempt");
    assert.equal(attempt.kind, "workflow",
      "dsh case must route to executeWorkflowCase (attempt.kind workflow)");
    assert.equal(attempt.execution_mode, "real",
      "dsh case must NOT be treated as a scripted-environment case");
    assert.equal(attempt.dry_run_launch, true, "attempt must carry the dry_run_launch marker");
    assert.equal(state.spend.tokens_observed, 0, "dry-run must spend zero tokens");

    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  });

  it("bare --scripted-only treats a dsh case as REAL (pending-real), never scripted", () => {
    const manifestPath = writeManifest([dshCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath), "--scripted-only"]);
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `scripted-only campaign must exit 0:\n${res.stdout}${res.stderr}`);
    const state = loadCampaignState(campaignId!);
    const caseState = state.cases.find((c: any) => c.id === DSH_CASE_ID);
    assert.ok(caseState, "dsh case missing from campaign state");
    assert.equal(caseState.outcome, "NOT_RUN",
      "bare scripted-only must mark a real dsh case NOT_RUN (never executed as scripted)");
    assert.equal(caseState.reason?.category, "pending-real",
      "dsh case must be pending-real under bare scripted-only");
    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
  });

  it("real-case preflight probes dsh (requiredHarnessesFor includes dsh) and the auth leg never crashes on the dsh name", () => {
    // Stub preflight helpers that only log their invocation (CALL <name>
    // args=<args>) — the real-case preflight chain (home-provision ->
    // harness-auth -> catalog-install -> daemon-up) is exercised with
    // deterministic zero-token stubs, exactly like tt-controller-preflight.
    const stubDir = fs.mkdtempSync(path.join(varRoot, `us002-stubs-${process.pid}-`));
    const stubLog = path.join(varRoot, `us002-pflog-${Date.now()}-${process.pid}.log`);
    const missingDaemonControl = path.join(varRoot, `us002-missing-${process.pid}`);
    fs.rmSync(stubLog, { force: true });
    fs.rmSync(missingDaemonControl, { force: true });
    const stubBody = `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
log="\${US002_STUB_LOG:?US002_STUB_LOG must be set}"
{ printf 'CALL %s args=%s\\n' "$name" "$*"; } >> "$log"
exit 0
`;
    for (const helper of ["tt-provision-home", "tt-harness-auth-probe", "tt-catalog-install", "tt-daemon-up"]) {
      const stubPath = path.join(stubDir, helper);
      fs.writeFileSync(stubPath, stubBody, { mode: 0o755 });
    }

    const manifestPath = writeManifest([dshCaseRecord(), localScriptedCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_CONTROLLER_PREFLIGHT_PROVISION: path.join(stubDir, "tt-provision-home"),
        TT_CONTROLLER_PREFLIGHT_AUTH: path.join(stubDir, "tt-harness-auth-probe"),
        TT_CONTROLLER_PREFLIGHT_CATALOG: path.join(stubDir, "tt-catalog-install"),
        TT_CONTROLLER_PREFLIGHT_DAEMON: path.join(stubDir, "tt-daemon-up"),
        TT_CONTROLLER_DAEMON_CONTROL_PATH: missingDaemonControl,
        US002_STUB_LOG: stubLog,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    // E2.2 fail-closed exit semantics: the campaign engaged the real preflight
    // (all legs OK, dsh probed) but the injected missing daemon-control path
    // meant the real dsh case never launched under execution_selection=all —
    // the vacuous-GREEN guard must report INFRA_FAILURE (exit 2), never a
    // silent GREEN. Exactly the tt-controller-preflight pi-manifest shape.
    assert.equal(res.status, 2,
      `preflight campaign must fail closed (vacuous-GREEN guard), not exit 0:\n${res.stdout}${res.stderr}`);

    // The harness-auth leg must probe dsh for a dsh-only real selection.
    const log = fs.readFileSync(stubLog, "utf8");
    assert.match(log, /CALL tt-harness-auth-probe args=dsh(\s|$)/,
      `real-case preflight must probe dsh (got:\n${log})`);
    assert.match(log, /CALL tt-provision-home /, "preflight must start with home-provision");
    assert.match(log, /CALL tt-catalog-install /, "preflight must run catalog-install");
    assert.match(log, /CALL tt-daemon-up args=ensure-up/, "preflight must run daemon-up ensure-up");

    // The dsh case is NOT_RUN (daemon-control-unavailable — the injected
    // missing path), the scripted local case completes green; preflight ok.
    const state = loadCampaignState(campaignId!);
    assert.equal(state.real_preflight?.ok, true, "preflight must be ok");
    assert.equal(state.real_preflight?.leg, undefined, "preflight must not have a failed leg");
    const dshCase = state.cases.find((c: any) => c.id === DSH_CASE_ID);
    assert.equal(dshCase.outcome, "NOT_RUN");
    assert.equal(dshCase.reason?.category, "daemon-control-unavailable");
    const localCase = state.cases.find((c: any) => c.id === LOCAL_CASE_ID);
    assert.equal(localCase.outcome, "PASS", "scripted local case must complete green");
    // The E2.2 vacuous-GREEN guard must name the real dsh case in its cause.
    const report = loadJson(path.join(varRoot, "results", campaignId!, "report.json"));
    assert.equal(report.fail_closed?.triggered, true,
      "the vacuous-GREEN fail-closed guard must trigger for the unlaunched real dsh case");
    assert.match(report.fail_closed?.cause ?? "", /dsh/,
      "the fail-closed cause must name the real dsh harness");

    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
    fs.rmSync(stubLog, { force: true });
  });

  it("tt-harness-auth-probe accepts a dsh selection: records presence, fails closed with harness-auth-missing: dsh when absent, never crashes", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "us002-dsh-probe-"));
    const fakeDsh = path.join(fakeBin, "fake-dsh");
    fs.writeFileSync(fakeDsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      // Present binary -> exit 0 (answer leg alpha-skipped without --spend).
      const present = runBash(authProbe, ["dsh"], { TAMANDUA_DSH_BINARY: fakeDsh });
      assert.equal(present.status, 0, `dsh probe with present binary must exit 0:\n${present.stderr}${present.stdout}`);
      assert.match(present.stdout, /alpha-skipped/, "answer leg must be reported alpha-skipped");
      assert.ok(!/REASON:/.test(present.stderr), "no fail-closed reason for a present dsh");

      // Absent binary (set-but-missing override; no PATH fallback) -> fail
      // closed with the DISTINCT reason; the probe never crashes on 'dsh'.
      const absent = runBash(authProbe, ["dsh"], { TAMANDUA_DSH_BINARY: path.join(fakeBin, "nope") });
      assert.equal(absent.status, 1, `dsh probe with absent binary must exit non-zero:\n${absent.stdout}${absent.stderr}`);
      assert.match(absent.stderr, /REASON: harness-auth-missing: dsh/,
        "absent dsh must fail closed with harness-auth-missing: dsh");

      // --spend runs the alpha answer self-check (zero-token, fake binary).
      const spend = runBash(authProbe, ["--spend", "dsh"], { TAMANDUA_DSH_BINARY: fakeDsh });
      assert.equal(spend.status, 0, `dsh probe --spend must exit 0:\n${spend.stderr}${spend.stdout}`);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("an unknown harness value in a scratch manifest fails closed at validation (no silent hermes fallback)", () => {
    const bogus = {
      ...dshCaseRecord(),
      id: "T2-BOGUS-HARNESS",
      harness: "bogus",
    };
    const manifestPath = writeManifest([bogus]);
    let res!: RunResult;
    try {
      res = runTt(controller, ["--manifest", path.relative(ttRoot, manifestPath), "--validate-only"]);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.notEqual(res.status, 0, "unknown harness must fail closed at validation");
    assert.match(res.stderr, /Manifest validation failed/,
      "validation failure must be reported");
    assert.match(res.stderr, /harness/,
      "validation error must name the harness field");
  });
});
