// Tier-2 STORM-REHEARSAL US-003 (S1 verify) — fail-closed daemon provenance.
//
// Run #56 (S1): the campaign rendered daemon.env.sh + recorded
// state.daemon_ports (44239/40023/37853) but the daemon actually booted under
// var/home-scripted on the fixed production ports 5334/5338/5339 (and the
// default cwd). NOTHING compared the running daemon's daemon-control
// provenance against the campaign's own recorded allocation before the first
// launch, so the split-brain went unnoticed until it was too late.
//
// This file is the ONE focused torture self-test for the S1 verify fix:
//   E1  verifyRehearsalDaemonProvenance pure matrix: absent provenance,
//       missing daemon_ports, port mismatch (normalized to strings), missing/
//       blank/foreign cwd and missing private state root all refuse with
//       TT_DAEMON_PROVENANCE; matching ports + cwd within (or equal to) the
//       private state root pass;
//   E2  ensureRehearsalDaemon FRESH-START: a mismatch refuses with
//       TT_DAEMON_PROVENANCE and persists NO daemon record; a match accepts
//       and records the provenance ports/cwd;
//   E3  ensureRehearsalDaemon REATTACH: the same verification runs on the
//       status branch (mismatch refuses; match reattaches);
//   E4  stormRunRehearsal refuses BEFORE stormResume/stormRunRoundA/B with
//       TT_DAEMON_PROVENANCE and records ZERO launchWorkflow/tamandua calls.
//   E5  (US-002 fix-2, S5/S8) verifyRehearsalDaemonEnvContract matrix: the
//       retained attempt-2 env script, a scripted state dir outside the private
//       root, a cap != state.source.active_cap, missing behaviors and missing
//       frozen binaries all refuse with TT_DAEMON_PROVENANCE + a non-empty
//       reason; a complete script is accepted (both text and campaignDir read).
//   E6  ensureRehearsalDaemon runs the env-contract check AFTER provenance on
//       BOTH the fresh-start and reattach branches, records
//       daemon.env_contract.refused, and persists NO daemon record.
//
// Everything runs under test-owned scratch dirs (removed in finally). No
// daemon/harness/workflow is ever spawned: the spawn boundary is an injected
// recording double and the provenance file is plain JSON on disk.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REHEARSAL_DAEMON_KIND,
  TT_DAEMON_PROVENANCE,
  ensureRehearsalDaemon,
  renderRehearsalDaemonEnvScript,
  verifyRehearsalDaemonEnvContract,
  verifyRehearsalDaemonProvenance,
} from "../bin/tt-storm-rehearsal.mjs";
import { stormRunRehearsal } from "../bin/tt-storm-engine.mjs";

const CAMPAIGN_PORTS = { dashboard: 44239, mcp: 40023, control: 37853 };
const ACTIVE_CAP = 52;
const REPO_ROOT = process.cwd();
const SCRIPTED_PI = path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "bin", "scripted-hermes");
// Retained attempt-2 (run #59) campaign env script: it carries the private
// roots/ports/binaries but NEVER TAMANDUA_SCRIPTED_BEHAVIORS /
// TAMANDUA_SCRIPTED_STATE / TAMANDUA_MAX_ACTIVE_TIMERS — exactly the S5/S8
// defect this verifier must refuse. Read it when present; otherwise use the
// embedded equivalent fixture.
const RETAINED_ATTEMPT2_ENV =
  "/opt/tamandua-storm-rehearsal-fix.SV0s67IF/torture-test/var/results/storm-20260912T021951Z-feec0d99-8c35-4572-b30a-bd4a64ab2832/daemon.env.sh";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-prov-${label}-`));
}

function makeClock() {
  return { nowUtc: () => new Date().toISOString(), nowMs: () => Date.now() };
}

function provenanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    name: REHEARSAL_DAEMON_KIND,
    kind: REHEARSAL_DAEMON_KIND,
    pid: 424242,
    ports: [CAMPAIGN_PORTS.dashboard, CAMPAIGN_PORTS.mcp, CAMPAIGN_PORTS.control],
    scopeUnit: "tamandua-tt-scripted-ffffffff",
    cgroupVerified: false,
    startTime: "proc:12345",
    daemonVersion: "test",
    callerArgv: [],
    launchCli: "/opt/bin/tamandua",
    ...overrides,
  };
}

function writeProvenance(provenanceDir: string, record: any, kind = REHEARSAL_DAEMON_KIND) {
  fs.mkdirSync(provenanceDir, { recursive: true });
  fs.writeFileSync(path.join(provenanceDir, `${kind}.json`), JSON.stringify(record, null, 2) + "\n");
}

// An embedded equivalent of the retained attempt-2 env script (used when the
// retained file is unreadable): private roots/ports/binaries but NO
// TAMANDUA_SCRIPTED_BEHAVIORS / TAMANDUA_SCRIPTED_STATE / cap.
function legacyEnvScriptFixture(stateRoot: string): string {
  return [
    "#!/usr/bin/env bash",
    `export HOME='${path.join(stateRoot, "..")}'`,
    `export TAMANDUA_STATE_DIR='${stateRoot}'`,
    "export TAMANDUA_DASHBOARD_PORT=43935",
    "export TAMANDUA_MCP_PORT=39675",
    "export TAMANDUA_CONTROL_PORT=43451",
    `export HERMES_HOME='${path.join(stateRoot, ".hermes")}'`,
    "export TAMANDUA_TEST_GUARD=1",
    `export TAMANDUA_PI_BINARY='${SCRIPTED_PI}'`,
    `export TAMANDUA_HERMES_BINARY='${SCRIPTED_HERMES}'`,
    "",
  ].join("\n");
}

// Provision a COMPLETE campaign daemon.env.sh + behaviors file + private
// scripted state dir under a test campaign dir, so the provenance-positive
// branches satisfy the S5/S8 env contract. `overrides` lets the matrix tests
// perturb individual recorded values.
function provisionDaemonEnvContract({
  campaignDir,
  stateRoot,
  activeCap = ACTIVE_CAP,
  scriptedStateDir = null,
  behaviorsFile = null,
  ports = CAMPAIGN_PORTS,
  maxActiveTimers = activeCap,
  piBinary = SCRIPTED_PI,
  hermesBinary = SCRIPTED_HERMES,
}: any) {
  fs.mkdirSync(campaignDir, { recursive: true });
  const behaviors = behaviorsFile ?? path.join(campaignDir, "behaviors.json");
  fs.mkdirSync(path.dirname(behaviors), { recursive: true });
  fs.writeFileSync(behaviors, JSON.stringify({ agents: {}, heartbeatTokens: 0, defaultTokens: 0 }) + "\n");
  const stateDir = scriptedStateDir ?? path.join(stateRoot, "scripted-state", "storm-prov-test");
  fs.mkdirSync(stateDir, { recursive: true });
  const script = renderRehearsalDaemonEnvScript({
    home: path.join(campaignDir, "home"),
    stateDir: stateRoot,
    tmpDir: path.join(campaignDir, "tmp"),
    ports,
    piBinary,
    hermesBinary,
    scriptedBehaviors: behaviors,
    scriptedStateDir: stateDir,
    maxActiveTimers,
  });
  fs.writeFileSync(path.join(campaignDir, "daemon.env.sh"), script);
  return { behaviorsFile: behaviors, scriptedStateDir: stateDir, script };
}

// Recording daemon-control double: `start` writes the supplied provenance
// record; `status` reports RUNNING/not-running; every dispatch (and every
// launch/tamandua attempt) is journaled so the test can assert the launch
// corridor is untouched.
function makeRecordingProc({
  provenanceDir,
  recordOnStart = provenanceRecord(),
  statusRunning = true,
  calls = [],
}: any) {
  const provFile = path.join(provenanceDir, `${REHEARSAL_DAEMON_KIND}.json`);
  const proc: any = {
    calls,
    daemonControl: async (argv: string[], opts?: any) => {
      calls.push(["daemon", [...argv], opts]);
      const op = argv[2];
      if (op === "start") {
        writeProvenance(provenanceDir, recordOnStart);
        return { exitCode: 0, stdout: `daemon-control: ${REHEARSAL_DAEMON_KIND} daemon started (pid ${recordOnStart.pid})\n`, stderr: `daemon-control: provenance written to ${provFile}\n` };
      }
      if (op === "status") {
        return statusRunning
          ? { exitCode: 0, stdout: `daemon-control: ${REHEARSAL_DAEMON_KIND} daemon RUNNING (pid ${recordOnStart.pid})\n`, stderr: "" }
          : { exitCode: 0, stdout: `daemon-control: ${REHEARSAL_DAEMON_KIND} daemon not running\n`, stderr: "" };
      }
      if (op === "stop") {
        return { exitCode: 0, stdout: `daemon-control: ${REHEARSAL_DAEMON_KIND} daemon stopped\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `daemon-control: unknown op ${op}` };
    },
    launchWorkflow: async (argv: string[], opts?: any) => {
      calls.push(["launch", [...argv], opts]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    tamandua: async (argv: string[], opts?: any) => {
      calls.push(["tamandua", [...argv], opts]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    chaosAction: async (argv: string[], opts?: any) => {
      calls.push(["chaos", [...argv], opts]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    httpGet: async (url: string, opts?: any) => {
      calls.push(["http", url, opts]);
      return { ok: true, statusCode: 200, latencyMs: 1 };
    },
    mcpTool: async (req: any, opts?: any) => {
      calls.push(["mcp", req, opts]);
      return { ok: true, latencyMs: 1 };
    },
    kill: async (pid: number, signal: string) => {
      calls.push(["kill", pid, signal]);
      return { ok: false, code: "TT_NOT_OWNED" };
    },
  };
  return proc;
}

function makeEnsureCtx({ fsx = fs, proc, provenanceDir, campaignDir = "/var/results/storm-prov", clock = makeClock() }: any) {
  return {
    fs: fsx,
    clock,
    proc,
    campaignDir,
    opts: {
      rehearsalRun: true,
      daemonProvenanceDir: provenanceDir,
      daemonKind: REHEARSAL_DAEMON_KIND,
    },
  };
}

function makeState({ stateRoot, daemonPorts = CAMPAIGN_PORTS, daemon = undefined }: any) {
  return {
    schema_version: 4,
    campaign_id: "storm-prov-test",
    source: { active_cap: ACTIVE_CAP },
    exec_identity: { state_root: stateRoot },
    daemon_ports: daemonPorts,
    ...(daemon ? { daemon } : {}),
    rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
  };
}

describe("STORM-REHEARSAL US-003 (S1 verify): pre-launch daemon provenance", () => {
  it("E1: verifyRehearsalDaemonProvenance matrix — absent/mismatch refuses, matching ports+cwd accepts", () => {
    const tmp = ownedScratch("matrix");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      const sub = path.join(stateRoot, "nested");
      const foreign = path.join(tmp, "foreign");
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(foreign, { recursive: true });

      const mismatch = (args: any, why: string) => {
        const res = verifyRehearsalDaemonProvenance({ ...args, fsx: fs });
        assert.equal(res.ok, false, why);
        assert.equal((res as any).code, TT_DAEMON_PROVENANCE, `${why} -> TT_DAEMON_PROVENANCE`);
        assert.ok(String((res as any).reason).length > 0, `${why} -> non-empty reason`);
      };

      // Absent / unreadable provenance.
      mismatch({ provenance: { found: false, file: null, record: null }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot }, "absent provenance");
      mismatch({ provenance: null, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot }, "null provenance");
      // Missing / incomplete daemon_ports.
      mismatch({ provenance: { found: true, record: provenanceRecord({ cwd: stateRoot }) }, daemonPorts: null, privateStateDir: stateRoot }, "missing daemon_ports");
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: stateRoot }) }, daemonPorts: { dashboard: 44239, mcp: 40023 }, privateStateDir: stateRoot },
        "incomplete daemon_ports",
      );
      // Port mismatch (both directions / reordered).
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ ports: [5334, 5338, 5339], cwd: stateRoot }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "provenance ports differ (run #56 fixed ports)",
      );
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ ports: ["44239", "37853", "40023"], cwd: stateRoot }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "provenance ports reordered",
      );
      // Missing / blank / foreign cwd.
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: undefined }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "missing cwd",
      );
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: "   " }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "blank cwd",
      );
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: foreign }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "foreign cwd",
      );
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: path.join(stateRoot, "..", "..", "..", "escape") }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot },
        "lexical .. cwd escape",
      );
      // Missing private state root (state.exec_identity.state_root absent).
      mismatch(
        { provenance: { found: true, record: provenanceRecord({ cwd: stateRoot }) }, daemonPorts: CAMPAIGN_PORTS, privateStateDir: null },
        "missing private state root",
      );

      // Positive: numeric ports normalize to strings; cwd equal to and nested
      // under the private state root both pass.
      const equalRes = verifyRehearsalDaemonProvenance({
        provenance: { found: true, record: provenanceRecord({ cwd: stateRoot }), file: "/x.json" },
        daemonPorts: { dashboard: "44239", mcp: "40023", control: "37853" },
        privateStateDir: stateRoot,
        fsx: null,
      });
      assert.deepEqual(equalRes, { ok: true }, "numeric-vs-string ports normalize and cwd equal to the root passes (fsx null)");

      const nestedRes = verifyRehearsalDaemonProvenance({
        provenance: { found: true, record: provenanceRecord({ cwd: sub }), file: "/x.json" },
        daemonPorts: CAMPAIGN_PORTS,
        privateStateDir: stateRoot,
        fsx: null,
      });
      assert.deepEqual(nestedRes, { ok: true }, "cwd nested under the private state root passes");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E2: ensureRehearsalDaemon fresh start — mismatch refuses TT_DAEMON_PROVENANCE with NO daemon record; match accepts", async () => {
    const tmp = ownedScratch("start");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      fs.mkdirSync(stateRoot, { recursive: true });
      const provenanceDir = path.join(tmp, "var", "daemon-control");
      const campaignDir = path.join(tmp, "var", "results", "storm-prov");
      provisionDaemonEnvContract({ campaignDir, stateRoot });

      // Negative: wrong ports AND a foreign cwd.
      const badCalls: any[] = [];
      const badProc = makeRecordingProc({
        provenanceDir,
        recordOnStart: provenanceRecord({ ports: [5334, 5338, 5339], cwd: path.join(tmp, "foreign") }),
        calls: badCalls,
      });
      const records: any[] = [];
      const badState = makeState({ stateRoot });
      const badRes = await ensureRehearsalDaemon(makeEnsureCtx({ proc: badProc, provenanceDir, campaignDir }), badState, { record: (kind: string, detail: any) => records.push({ kind, detail }) });
      assert.equal(badRes.ok, false, "a mismatched fresh-start provenance is refused");
      assert.equal((badRes as any).code, TT_DAEMON_PROVENANCE, "refusal code is TT_DAEMON_PROVENANCE");
      assert.equal(badRes.daemon, null, "no daemon record is returned on mismatch");
      assert.equal(badState.daemon, undefined, "NO daemon record is persisted into campaign state on mismatch");
      assert.ok(records.some((r) => r.kind === "daemon.provenance.refused"), "the refusal is recorded");
      assert.ok(!records.some((r) => r.kind === "daemon.started"), "a mismatched daemon is never recorded as started");

      // Positive: matching ports + cwd inside the private root.
      const goodCalls: any[] = [];
      const goodProc = makeRecordingProc({
        provenanceDir,
        recordOnStart: provenanceRecord({ cwd: stateRoot }),
        calls: goodCalls,
      });
      const goodState = makeState({ stateRoot });
      const goodRes = await ensureRehearsalDaemon(makeEnsureCtx({ proc: goodProc, provenanceDir, campaignDir }), goodState, { record: () => {} });
      assert.equal(goodRes.ok, true, "a matching fresh-start provenance is accepted");
      assert.equal(goodRes.reattached, false, "fresh start is not a reattach");
      assert.deepEqual(goodState.daemon?.evidence?.ports, [CAMPAIGN_PORTS.dashboard, CAMPAIGN_PORTS.mcp, CAMPAIGN_PORTS.control], "the verified ports are persisted");
      assert.equal(goodState.daemon?.status, "running", "the verified daemon is persisted running");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E3: ensureRehearsalDaemon reattach — the same verification gates the status branch", async () => {
    const tmp = ownedScratch("reattach");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      fs.mkdirSync(stateRoot, { recursive: true });
      const provenanceDir = path.join(tmp, "var", "daemon-control");
      const campaignDir = path.join(tmp, "var", "results", "storm-prov");
      provisionDaemonEnvContract({ campaignDir, stateRoot });

      // Negative: the running daemon reports a foreign cwd.
      writeProvenance(provenanceDir, provenanceRecord({ cwd: path.join(tmp, "foreign") }));
      const badProc = makeRecordingProc({ provenanceDir, statusRunning: true });
      const badState = makeState({
        stateRoot,
        daemon: { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: 424242 } },
      });
      const badRes = await ensureRehearsalDaemon(makeEnsureCtx({ proc: badProc, provenanceDir, campaignDir }), badState, { record: () => {} });
      assert.equal(badRes.ok, false, "a mismatched reattach provenance is refused");
      assert.equal((badRes as any).code, TT_DAEMON_PROVENANCE, "reattach refusal code is TT_DAEMON_PROVENANCE");
      assert.equal(badRes.daemon, null, "reattach returns no daemon on mismatch");
      assert.ok(!badProc.calls.some(([k, argv]: any) => k === "daemon" && argv[2] === "start"), "a mismatch never falls through to a fresh start");

      // Positive: matching ports + cwd within the private root reattaches.
      writeProvenance(provenanceDir, provenanceRecord({ cwd: stateRoot }));
      const goodProc = makeRecordingProc({ provenanceDir, statusRunning: true });
      const goodState = makeState({
        stateRoot,
        daemon: { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: 424242 } },
      });
      const goodRes = await ensureRehearsalDaemon(makeEnsureCtx({ proc: goodProc, provenanceDir, campaignDir }), goodState, { record: () => {} });
      assert.equal(goodRes.ok, true, "a matching reattach provenance is accepted");
      assert.equal(goodRes.reattached, true, "the matching daemon is reattached, not restarted");
      assert.ok(!goodProc.calls.some(([k, argv]: any) => k === "daemon" && argv[2] === "start"), "reattach never starts a second daemon");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E4: stormRunRehearsal refuses with TT_DAEMON_PROVENANCE before any round driver and records zero launches", async () => {
    const tmp = ownedScratch("refuse");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      const campaignDir = path.join(tmp, "var", "results", "storm-prov-refuse");
      const provenanceDir = path.join(tmp, "var", "daemon-control");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(campaignDir, { recursive: true });

      // Campaign records the bind0 allocation but the daemon that comes up is
      // the run #56 split-brain daemon (fixed ports, foreign cwd).
      const state = makeState({ stateRoot });
      state.rehearsal = {
        profile: "SCRIPTED_REHEARSAL",
        label: "infrastructure rehearsal",
        inputs: { root: path.join(tmp, "var", "reh"), tasksRoot: path.join(tmp, "var", "reh", "tasks"), worktreeRoot: path.join(tmp, "var", "wt"), fixture: {} },
        task_manifest: {},
        fixture_identity: { originRepo: "/x", colleagueRepo: "/y", parkRepo: "/z", seedRef: "seed/storm" },
        resource_plan: { daemon: { kind: REHEARSAL_DAEMON_KIND } },
      };
      fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify(state, null, 2) + "\n");

      const calls: any[] = [];
      const proc = makeRecordingProc({
        provenanceDir,
        recordOnStart: provenanceRecord({ ports: [5334, 5338, 5339], cwd: path.join(tmp, "home-scripted") }),
        calls,
      });
      const ctx = makeEnsureCtx({ proc, provenanceDir, campaignDir });

      await assert.rejects(
        () => stormRunRehearsal(ctx, { round: "A" }),
        (e: any) => e?.code === TT_DAEMON_PROVENANCE,
        "stormRunRehearsal must throw TT_DAEMON_PROVENANCE before any round driver",
      );

      assert.equal(calls.filter(([k]: any) => k === "launch").length, 0, "zero launchWorkflow calls recorded");
      assert.equal(calls.filter(([k]: any) => k === "tamandua").length, 0, "zero tamandua calls recorded");
      // The refusal is the ONLY daemon-corridor effect: exactly one
      // daemon-control `start` was attempted and the mismatch stopped the
      // corridor there (no fall-through, no round driver).
      const daemonCalls = calls.filter(([k]: any) => k === "daemon");
      assert.equal(daemonCalls.length, 1, "exactly one daemon-control dispatch (start) was attempted");
      assert.equal(daemonCalls[0][1][2], "start", "the single daemon-control dispatch is a start");

      const opsText = fs.readFileSync(path.join(campaignDir, "ops.jsonl"), "utf8");
      assert.ok(!/launch\.intent/.test(opsText), "no launch intent is ever recorded");
      assert.ok(!/resume\.start/.test(opsText), "stormResume never runs");
      assert.ok(/daemon\.provenance\.refused/.test(opsText), "the refusal is recorded in the ops ledger");

      // No daemon record was persisted into the campaign state.
      const persisted = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      assert.equal(persisted.daemon, undefined, "no daemon record persisted on refusal");
      // Round drivers never touched the state.
      assert.equal(persisted.rounds.A.status, "planned", "Round A was never driven");
      assert.equal(persisted.rounds.B.status, "planned", "Round B was never driven");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E5: verifyRehearsalDaemonEnvContract — legacy/foreign/cap-mismatch refuse, complete accepts (S5/S8)", () => {
    const tmp = ownedScratch("envmatrix");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      const campaignDir = path.join(tmp, "var", "results", "storm-prov");
      const foreign = path.join(tmp, "foreign");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(foreign, { recursive: true });

      const deny = (args: any, why: string) => {
        const res = verifyRehearsalDaemonEnvContract({ ...args, fsx: fs });
        assert.equal(res.ok, false, why);
        assert.equal((res as any).code, TT_DAEMON_PROVENANCE, `${why} -> TT_DAEMON_PROVENANCE`);
        assert.ok(String((res as any).reason).length > 0, `${why} -> non-empty reason`);
      };

      // Complete script accepted (explicit text AND read-from-campaignDir).
      provisionDaemonEnvContract({ campaignDir, stateRoot });
      const complete = fs.readFileSync(path.join(campaignDir, "daemon.env.sh"), "utf8");
      const baseArgs = { daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateRoot, activeCap: ACTIVE_CAP };
      assert.deepEqual(
        verifyRehearsalDaemonEnvContract({ ...baseArgs, envScriptText: complete, fsx: fs }),
        { ok: true },
        "a complete script is accepted from explicit text",
      );
      assert.deepEqual(
        verifyRehearsalDaemonEnvContract({ ...baseArgs, campaignDir, fsx: fs }),
        { ok: true },
        "a complete script is accepted via the campaignDir read path",
      );

      // 1) The retained attempt-2 env script (or the embedded equivalent).
      let legacy = legacyEnvScriptFixture(stateRoot);
      try {
        const retained = fs.readFileSync(RETAINED_ATTEMPT2_ENV, "utf8");
        if (retained.trim() !== "") legacy = retained;
      } catch { /* retained file unreadable — embedded fixture is equivalent */ }
      deny({ ...baseArgs, envScriptText: legacy }, "legacy attempt-2 env script (no scripted-runtime contract)");

      // 2) Scripted state dir OUTSIDE the private state root.
      const outside = renderRehearsalDaemonEnvScript({
        home: path.join(campaignDir, "home"),
        stateDir: stateRoot,
        tmpDir: path.join(campaignDir, "tmp"),
        ports: CAMPAIGN_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: path.join(campaignDir, "behaviors.json"),
        scriptedStateDir: path.join(foreign, "scripted-state"),
        maxActiveTimers: ACTIVE_CAP,
      });
      deny({ ...baseArgs, envScriptText: outside }, "TAMANDUA_SCRIPTED_STATE outside the private state root");

      // 3) Cap disagrees with state.source.active_cap (the S8 defect: daemon
      // default 50 vs campaign 52).
      const capped50 = renderRehearsalDaemonEnvScript({
        home: path.join(campaignDir, "home"),
        stateDir: stateRoot,
        tmpDir: path.join(campaignDir, "tmp"),
        ports: CAMPAIGN_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: path.join(campaignDir, "behaviors.json"),
        scriptedStateDir: path.join(stateRoot, "scripted-state", "storm-prov-test"),
        maxActiveTimers: 50,
      });
      deny({ ...baseArgs, envScriptText: capped50 }, "TAMANDUA_MAX_ACTIVE_TIMERS 50 != active_cap 52");
      deny({ ...baseArgs, activeCap: null, envScriptText: complete }, "missing campaign active_cap");

      // 4) Missing behaviors file / frozen binary / script.
      const missingBehaviors = renderRehearsalDaemonEnvScript({
        home: path.join(campaignDir, "home"),
        stateDir: stateRoot,
        tmpDir: path.join(campaignDir, "tmp"),
        ports: CAMPAIGN_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: path.join(campaignDir, "does-not-exist.json"),
        scriptedStateDir: path.join(stateRoot, "scripted-state", "storm-prov-test"),
        maxActiveTimers: ACTIVE_CAP,
      });
      deny({ ...baseArgs, envScriptText: missingBehaviors }, "nonexistent TAMANDUA_SCRIPTED_BEHAVIORS");
      const missingPi = renderRehearsalDaemonEnvScript({
        home: path.join(campaignDir, "home"),
        stateDir: stateRoot,
        tmpDir: path.join(campaignDir, "tmp"),
        ports: CAMPAIGN_PORTS,
        piBinary: path.join(campaignDir, "nope-scripted-pi"),
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: path.join(campaignDir, "behaviors.json"),
        scriptedStateDir: path.join(stateRoot, "scripted-state", "storm-prov-test"),
        maxActiveTimers: ACTIVE_CAP,
      });
      deny({ ...baseArgs, envScriptText: missingPi }, "nonexistent frozen pi binary");
      deny({ ...baseArgs, campaignDir: path.join(tmp, "var", "results", "no-such-campaign"), fsx: fs }, "missing daemon.env.sh");

      // 5) Ports mismatch.
      deny(
        { ...baseArgs, envScriptText: complete, daemonPorts: { dashboard: 5334, mcp: 40023, control: 37853 } },
        "daemon env ports disagree with state.daemon_ports",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E6: ensureRehearsalDaemon runs the env-contract check after provenance on BOTH branches and persists no record", async () => {
    const tmp = ownedScratch("envrefuse");
    try {
      const stateRoot = path.join(tmp, "var", "home", ".tamandua");
      const provenanceDir = path.join(tmp, "var", "daemon-control");
      const campaignDir = path.join(tmp, "var", "results", "storm-prov");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(campaignDir, { recursive: true });
      // Deliberately DO NOT provision daemon.env.sh: provenance matches but the
      // scripted-runtime env contract is absent (the attempt-2 S5 condition).

      // Fresh-start branch: matching provenance, missing env contract.
      const startRecords: any[] = [];
      const startProc = makeRecordingProc({ provenanceDir, recordOnStart: provenanceRecord({ cwd: stateRoot }) });
      const startState = makeState({ stateRoot });
      const startRes = await ensureRehearsalDaemon(
        makeEnsureCtx({ proc: startProc, provenanceDir, campaignDir }),
        startState,
        { record: (kind: string, detail: any) => startRecords.push({ kind, detail }) },
      );
      assert.equal(startRes.ok, false, "a matching provenance with an incompatible env contract is refused");
      assert.equal((startRes as any).code, TT_DAEMON_PROVENANCE, "env-contract refusal is TT_DAEMON_PROVENANCE");
      assert.equal(startState.daemon, undefined, "no daemon record is persisted on env-contract refusal");
      assert.ok(startRecords.some((r) => r.kind === "daemon.env_contract.refused"), "daemon.env_contract.refused is recorded (fresh start)");
      assert.ok(!startRecords.some((r) => r.kind === "daemon.started"), "the daemon is never recorded started");

      // Reattach branch: matching provenance, missing env contract.
      writeProvenance(provenanceDir, provenanceRecord({ cwd: stateRoot }));
      const reattachRecords: any[] = [];
      const reattachProc = makeRecordingProc({ provenanceDir, statusRunning: true });
      const reattachState = makeState({
        stateRoot,
        daemon: { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: 424242 } },
      });
      const reattachRes = await ensureRehearsalDaemon(
        makeEnsureCtx({ proc: reattachProc, provenanceDir, campaignDir }),
        reattachState,
        { record: (kind: string, detail: any) => reattachRecords.push({ kind, detail }) },
      );
      assert.equal(reattachRes.ok, false, "an incompatible env contract refuses the reattach");
      assert.equal((reattachRes as any).code, TT_DAEMON_PROVENANCE, "reattach env-contract refusal code");
      assert.ok(reattachRecords.some((r) => r.kind === "daemon.env_contract.refused"), "daemon.env_contract.refused is recorded (reattach)");
      assert.ok(
        !reattachProc.calls.some(([k, argv]: any) => k === "daemon" && argv[2] === "start"),
        "an env-contract refusal never falls through to a fresh start",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
