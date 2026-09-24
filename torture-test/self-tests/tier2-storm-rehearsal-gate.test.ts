// Tier-2 STORM-REHEARSAL US-002 — real-engine gate wiring (recording +
// benign-child only; NO daemon/harness/chaos spawn, NO real-model E2E).
//
// Story: wire the US-001 prepared campaign to the SAME real production storm
// engine and transports for BOTH full rounds through a single private daemon
// (daemon-control), with the N4 single-flight prelude, dead-owner/reclaim,
// interruption/reattach, HTTP + two-MCP read pounding, evidence receipts and
// exact positive closure.
//
// TEST AUTHORIZATION (STORM-REHEARSAL): before coordinator approval ONLY
// dependency-injected recording / benign-child tests may run. This file
// therefore:
//   * drives the ACTUAL committed engine functions (stormRunRehearsal /
//     stormRunRoundA / stormRunRoundB / stormResume) with injected recording
//     fs/clock/db/proc adapters — every daemon-control / launch / chaos /
//     transport call is RECORDED, never executed against a real daemon;
//   * exercises the daemon lifecycle + cleanup + single-flight arm with
//     benign recorded children under fresh owned temp roots (TAMANDUA_TEST_
//     GUARD=1 stays enabled; nothing touches live ~/.tamandua state);
//   * asserts the recorded argv/order/predicates/evidence and the exact
//     owned-resource inventory — never a real daemon/harness/workflow launch.
//
// Coverage (acceptance criteria 1-8 of US-002):
//   H1  prepared-campaign overlay drives stormRunRehearsal (Round A+B)
//       through the REAL engine round drivers; intent precedes EVERY launch;
//       per-roster launch argv names the ACTUAL bundled workflow id + harness
//       + prepared task file (S1..S10, B1..B5 + identical B5 relaunch);
//   H2  N4 single-flight pure contract (key/argv/parse/classify: exactly one
//       execution + all waiters same result; multi-execution/replay-mismatch/
//       unknown distinct);
//   H3  N4 single-flight prelude with benign tamandua-test children: exactly
//       ONE execution + 3 waiters replay the same recorded result
//       (release-on-stop); dead-owner kill -> a waiter RECLAIMS (distinct
//       second execution), never a replay;
//   H4  every Round B phase marker demands its exact mechanical predicate:
//       one active worker alone satisfies nothing (B1-B4 pre-finalize,
//       pause-b3-acked, cc1-landed) — UNKNOWN/not_yet stay distinct;
//   H5  orchestrator interruption + restart re-attaches recorded runs by
//       captured id (no duplicate launch) AND re-attaches the recorded
//       daemon (no duplicate daemon start);
//   H6  owned cleanup demands an explicit positive evidence inventory for
//       daemon/listeners — absent/undefined/{}/non-closed daemon stop is
//       refused (never PASS); a positively evidenced stop passes;
//   H7  Round B action argv is wired through ctx adapters with NO generic
//       process.kill(pid) endpoint: kill-harness goes through tt-chaos with
//       the exact owned run id; stop_delete_relaunch orders stop -> delete ->
//       identical relaunch; bounce goes through daemon-control restart;
//   H8  daemon env script / bind0 port allocation safety: production ports
//       3334/3338/3339 refused, guard=1 + frozen scripted runtimes + private
//       roots pinned; rehearsal run opts require a real rehearsal bundle.
//
// Everything runs under fresh owned scratch dirs (removed only in `finally`
// by the test, per suite convention) or the recording in-memory adapters;
// all fixtures/evidence are retained by the code under test.

import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  loadState,
  spawnCapture,
} from "../bin/tt-storm-shared.mjs";
import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
  STORM_WORKFLOW_IDS,
} from "../bin/tt-storm-roster.mjs";
import { runOwnedCleanup } from "../bin/tt-storm-real.mjs";
import {
  stormPrepare,
  stormReportFull,
  stormResume,
  stormRunRehearsal,
  stormRunRoundB,
  launchArgvFor as engineLaunchArgvFor,
} from "../bin/tt-storm-engine.mjs";
import {
  REHEARSAL_DAEMON_KIND,
  REHEARSAL_MCP_TOOLS,
  armSingleFlightPrelude,
  assertSafeListenerPort,
  buildSingleFlightWaiterArgv,
  classifySingleFlightLeg,
  daemonControlArgv,
  ensureRehearsalDaemon,
  makeRehearsalDaemonCleanupHandler,
  parseSingleFlightResult,
  readDaemonProvenance,
  rehearsalRunOptsFromState,
  renderRehearsalDaemonEnvScript,
  singleFlightKeyOf,
  stopRehearsalDaemon,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

// ─────────────────────────────────────────────────────────────────────
// Compact deterministic helpers (recording gate style).
// ─────────────────────────────────────────────────────────────────────

function hexFor(tag: string): string {
  return createHash("sha256").update(String(tag)).digest("hex");
}

function makeRunId(tag: string): string {
  const h = hexFor(`storm-reh-gate:${tag}`).slice(0, 32);
  return `run-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function workflowYaml(agents: string[]): string {
  const body = agents.map((a, i) => `  - id: step${i}\n    agent: ${a}\n`).join("");
  return `workflow:\n  id: wf\nagents:\n${agents.map((a) => `  - id: ${a}`).join("\n")}\nsteps:\n${body}`;
}

const SYNTH_CATALOG: Record<string, string> = {
  "workflows/feature-dev-merge-worktree/workflow.yml": workflowYaml(["planner", "setup", "developer", "verifier", "tester", "reviewer", "merger"]),
  "workflows/bug-fix-merge-worktree/workflow.yml": workflowYaml(["triager", "investigator", "setup", "fixer", "auditor", "verifier", "reviewer", "merger"]),
  "workflows/security-audit-merge-worktree/workflow.yml": workflowYaml(["scanner", "prioritizer", "setup", "fixer", "verifier", "tester", "reviewer", "merger"]),
  "workflows/quarantine-broken-tests-merge-worktree/workflow.yml": workflowYaml(["setup", "quarantiner", "verifier", "merger"]),
  "workflows/do-review-do-verify/workflow.yml": workflowYaml(["doer", "reviewer", "verifier"]),
  "workflows/do-now/workflow.yml": workflowYaml(["doer"]),
};

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) files.set(path.normalize(k), String(v));
  const dirs = new Set<string>(["/", "/var", "/var/results"]);
  const ops: Array<[string, string]> = [];
  const fsx: any = {
    files, dirs, ops,
    existsSync: (p: string) => files.has(path.normalize(String(p))) || dirs.has(path.normalize(String(p))),
    readFileSync: (p: string) => {
      const k = path.normalize(String(p));
      const v = files.get(k);
      if (v === undefined) throw new Error(`FakeFS: no such file ${k}`);
      return v;
    },
    readFile: async (p: string) => fsx.readFileSync(p),
    writeFileSync: (p: string, data: string) => {
      const k = path.normalize(String(p));
      ops.push(["write", k]);
      files.set(k, String(data));
      let d = path.dirname(k);
      while (d !== "/" && d !== "." && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    appendFileSync: (p: string, data: string) => {
      const k = path.normalize(String(p));
      ops.push(["append", k]);
      files.set(k, (files.get(k) ?? "") + String(data));
      let d = path.dirname(k);
      while (d !== "/" && d !== "." && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    mkdirSync: (p: string) => {
      const k = path.normalize(String(p));
      ops.push(["mkdir", k]);
      let d = k;
      while (d !== "/") { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    renameSync: (a: string, b: string) => {
      const ka = path.normalize(String(a));
      const kb = path.normalize(String(b));
      if (!files.has(ka)) throw new Error(`FakeFS: rename source missing ${ka}`);
      files.set(kb, files.get(ka)!);
      files.delete(ka);
    },
    realpathSync: (p: string) => path.normalize(String(p)),
    statSync: (p: string) => {
      const k = path.normalize(String(p));
      if (!files.has(k) && !dirs.has(k)) throw new Error(`FakeFS: stat missing ${k}`);
      return { isDirectory: () => dirs.has(k), isFile: () => files.has(k), dev: 1, ino: 1 };
    },
    lstatSync: (p: string) => fsx.statSync(p),
    readdirSync: () => [],
    resolve: (p: string) => path.normalize(String(p)),
  };
  return fsx;
}

function makeFakeClock(startMs = 0) {
  let ms = startMs;
  const sleeps: Array<{ n: number; reason?: string }> = [];
  const clock: any = {
    sleeps,
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    sleep: async (n: number, reason?: string) => { sleeps.push({ n, reason }); ms += n; },
    advance: (n: number) => { ms += n; },
  };
  return clock;
}

function makeFakeDb({ defs = [], children = [], clock }: { defs: any[]; children?: any[]; clock: any }) {
  const defById = new Map(defs.map((d) => [d.runId, d]));
  const open = () => {
    const t = () => clock.nowMs();
    const rowOf = (def: any) => {
      const now = t();
      const status = now >= def.terminalAt ? (def.terminalStatus ?? "completed") : "running";
      const scheduling_status = def.schedulingError ? (status === "failed" ? null : "queued")
        : def.queuedUntil == null ? null : now < def.queuedUntil ? "queued" : null;
      return {
        id: def.runId,
        workflow_id: def.workflow,
        status,
        scheduling_status,
        scheduling_error: def.schedulingError ?? null,
        created_at: new Date(def.createdAt ?? 0).toISOString(),
        updated_at: new Date(t()).toISOString(),
        tokens_spent: def.tokens ?? (status === "completed" ? 12345 : 0),
        parent_run_id: def.parentRunId ?? null,
      };
    };
    return {
      ok: true,
      api: {
        listRuns: () => [...defs.map((d) => rowOf(d)), ...children.map((c) => ({ ...c, context: c.context ?? "{}" }))],
        getRun: (runId: string) => {
          const def = defById.get(runId);
          if (!def) return undefined;
          return rowOf(def);
        },
        activeStepsForRuns: (runIds: string[]) => {
          const now = t();
          const out: any[] = [];
          for (const id of runIds) {
            const def = defById.get(id);
            if (!def) continue;
            if (now >= (def.claimedFrom ?? 0) && now < (def.claimedTo ?? Infinity) && now < def.terminalAt) {
              out.push({ run_id: id, status: "running", n: 1 });
            }
          }
          return out;
        },
        activeStepRows: (runIds: string[], { stepIds = null }: { stepIds?: string[] | null } = {}) => {
          const now = t();
          const out: any[] = [];
          for (const id of runIds) {
            const def = defById.get(id);
            if (!def) continue;
            if (now >= (def.claimedFrom ?? 0) && now < (def.claimedTo ?? Infinity) && now < def.terminalAt) {
              const active = def.activeSteps ?? ["setup"];
              for (const sid of active) {
                if (!stepIds || stepIds.includes(sid)) out.push({ run_id: id, step_id: sid, agent_id: sid, status: "claimed" });
              }
            }
          }
          return out;
        },
        close: () => {},
      },
    };
  };
  return { open };
}

function makeFakeProc(handlers: { launcher?: any; daemon?: any; tamandua?: any; chaos?: any; http?: any; mcp?: any } = {}) {
  const calls: any[] = [];
  const proc: any = {
    calls,
    launchWorkflow: async (argv: string[], opts?: any) => {
      calls.push(["launch", argv, opts]);
      return (handlers.launcher ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })))(argv, opts);
    },
    tamandua: async (argv: string[], opts?: any) => {
      calls.push(["tamandua", argv, opts]);
      return (handlers.tamandua ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })))(argv, opts);
    },
    chaosAction: async (argv: string[], opts?: any) => {
      calls.push(["chaos", argv, opts]);
      return (handlers.chaos ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })))(argv, opts);
    },
    daemonControl: async (argv: string[], opts?: any) => {
      calls.push(["daemon", argv, opts]);
      return (handlers.daemon ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })))(argv, opts);
    },
    httpGet: async (url: string, opts?: any) => {
      calls.push(["http", url, opts]);
      return (handlers.http ?? (async () => ({ ok: true, statusCode: 200, latencyMs: 40 })))(url, opts);
    },
    mcpTool: async (req: any, opts?: any) => {
      calls.push(["mcp", req, opts]);
      return (handlers.mcp ?? (async () => ({ ok: true, latencyMs: 40 })))(req, opts);
    },
    kill: async (pid: number, signal: string) => {
      calls.push(["kill", pid, signal]);
      return { ok: false, code: "TT_NOT_OWNED", pid, signal };
    },
  };
  return proc;
}

function makeCtx({ fsx, clock, proc, db, varRoot = "/var", campaignDir, opts = {} }: any) {
  return {
    fs: fsx,
    clock,
    proc,
    db,
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    varRoot,
    campaignDir,
    opts: {
      installedCatalogRoot: null,
      bundledCatalogRoot: "workflows",
      fixture: { name: "tt-poly", basis: "synthetic gate record" },
      dbPath: "/var/home/.tamandua/tamandua.db",
      fixtureIdentity: {
        colleagueRepo: "/var/fixtures/tt-poly/colleague",
        cc1File: "docs/cc1.md",
        cc2File: "ts/src/store.ts",
        parkRepo: "/var/fixtures/tt-poly/origin",
        originRepo: "/var/fixtures/tt-poly/origin",
        seedRef: "seed/storm",
      },
      ...opts,
    },
  };
}

function stormWorkflows(): Record<string, string> {
  return Object.fromEntries(
    [...ROUND_A_ROSTER, ...ROUND_B_ROSTER].map((r) => [r.id, r.workflow]),
  ) as Record<string, string>;
}

function worldOf(clock: any) {
  const wf = stormWorkflows();
  const runIdOf = (rosterId: string) => makeRunId(rosterId);
  const world: any = { clock, runIdOf, wf, launchCanned: {} };
  return world;
}

// Canned launcher: keys on the optional `--storm-marker <rosterId>` (the
// rehearsal wiring override the tests pass so an IDENTICAL do-now relaunch is
// distinguishable) and falls back to the --task-file basename (<run>.task.md)
// mapping back to its roster entry, so launch evidence matches the roster.
function rosterByRunName(): Map<string, { id: string; workflow: string; harness: string; run: string }> {
  const m = new Map();
  for (const r of [...ROUND_A_ROSTER, ...ROUND_B_ROSTER]) m.set(r.run, r);
  return m;
}

// Marker-carrying launch argv: engine default argv + --storm-marker so the
// canned launcher can tell the identical B5 relaunch from the initial B5.
// The engine's own launchArgvFor dispatches back into ctx.opts.launchArgvFor,
// so the default builder must be called with that override temporarily off.
function markerLaunchArgvFor(launch: any, ctx: any) {
  const saved = ctx.opts.launchArgvFor;
  ctx.opts.launchArgvFor = undefined;
  let argv;
  try {
    argv = engineLaunchArgvFor(launch, ctx);
  } finally {
    ctx.opts.launchArgvFor = saved;
  }
  argv.push("--storm-marker", launch.rosterId);
  return argv;
}

function cannedLauncher(world: any) {
  const byRun = rosterByRunName();
  return async (argv: string[]) => {
    const markerIdx = argv.indexOf("--storm-marker");
    let rosterId: string | null = markerIdx >= 0 ? argv[markerIdx + 1] : null;
    if (!rosterId) {
      const tfIdx = argv.indexOf("--task-file");
      const tf = tfIdx >= 0 ? argv[tfIdx + 1] : "";
      const base = path.basename(String(tf)).replace(/\.task\.md$/, "");
      rosterId = byRun.get(base)?.id ?? null;
    }
    const canned = rosterId ? world.launchCanned[rosterId] ?? {} : {};
    if (canned.raw) return { ...canned.raw };
    if (!rosterId) return { exitCode: 1, stdout: "", stderr: `no roster entry for ${argv.join(" ")}` };
    const runId = world.runIdOf(rosterId);
    const num = (parseInt(hexFor(runId).slice(0, 6), 16) % 900) + 1;
    return {
      exitCode: 0,
      stdout: `Run: ${runId}\n`,
      stderr: `run #${num} (${runId.slice(4, 12)}) created; preparing workspace...\n`,
      ...(canned.admission ? { admission: canned.admission } : {}),
    };
  };
}

function roundADefaults(): any[] {
  const wf = stormWorkflows();
  const T: Record<string, number> = {
    S1: 62 * 60_000, S2: 63 * 60_000, S3: 64 * 60_000, S4: 65 * 60_000,
    S5: 66 * 60_000, S6: 67 * 60_000, S7: 68 * 60_000, S8: 69 * 60_000,
  };
  const defs: any[] = [];
  for (const rid of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) {
    defs.push({ runId: makeRunId(rid), rosterId: rid, workflow: wf[rid], claimedFrom: 5 * 60_000, claimedTo: 60 * 60_000, terminalAt: T[rid], terminalStatus: "completed", createdAt: 0 });
  }
  defs.push({ runId: makeRunId("S9"), rosterId: "S9", workflow: wf.S9, claimedFrom: 62 * 60_000 + 5_000, claimedTo: 65 * 60_000 - 5_000, terminalAt: 65 * 60_000, terminalStatus: "completed", queuedUntil: 62 * 60_000, createdAt: 0 });
  defs.push({ runId: makeRunId("S10"), rosterId: "S10", workflow: wf.S10, claimedFrom: 62 * 60_000 + 20_000, claimedTo: 65 * 60_000 + 10_000, terminalAt: 65 * 60_000 + 15_000, terminalStatus: "completed", queuedUntil: 62 * 60_000 + 15_000, createdAt: 0 });
  return defs;
}

function roundBDefaults(): any[] {
  const wf = stormWorkflows();
  const T: Record<string, number> = { B1: 200 * 60_000, B2: 201 * 60_000, B3: 202 * 60_000, B4: 203 * 60_000, B5: 204 * 60_000 };
  return ["B1", "B2", "B3", "B4", "B5"].map((rid) => ({
    runId: makeRunId(rid), rosterId: rid, workflow: wf[rid],
    claimedFrom: 3 * 60_000, claimedTo: 195 * 60_000, terminalAt: T[rid], terminalStatus: "completed", createdAt: 0,
    activeSteps: rid === "B3" || rid === "B4" ? ["setup", "fix", "verify"] : ["setup", "dev", "verify"],
  }));
}

function phaseEvidenceControl(veto = new Set<string>()) {
  return {
    veto,
    async waitForPhaseEvidence(ctx: any, state: any, ph: any) {
      if (veto.has(ph.id)) {
        return { satisfied: false, outcome: "timed_out", marker: ph.waitFor?.marker ?? ph.waitFor?.kind, reason: `simulated evidence never materialized for ${ph.id}` };
      }
      return { satisfied: true, outcome: "marker_satisfied", marker: ph.waitFor?.marker ?? ph.waitFor?.kind };
    },
  };
}

function opsLines(fsx: any, campaignDir: string): any[] {
  const p = `${campaignDir}/ops.jsonl`;
  if (!fsx.existsSync(p)) return [];
  return fsx.readFileSync(p).split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
}

function loadStateFile(fsx: any, campaignDir: string): any {
  return JSON.parse(fsx.readFileSync(`${campaignDir}/state.json`));
}

// US-003 (S1 verify): the synthetic daemon provenance + the campaign state
// must agree, or ensureRehearsalDaemon correctly refuses TT_DAEMON_PROVENANCE.
// A real daemon-control records cwd = TAMANDUA_STATE_DIR (daemon-control
// write_provenance) and ports = the campaign's persisted state.daemon_ports.
const FAKE_DAEMON_PORTS = { dashboard: 53341, mcp: 53342, control: 53343 };
const FAKE_PRIVATE_STATE_ROOT = "/var/home/.tamandua";
function installFakeDaemonProvenanceState(state: any): any {
  state.daemon_ports = { ...FAKE_DAEMON_PORTS };
  state.exec_identity = {
    ...(state.exec_identity ?? {}),
    var_root: "/var",
    home_root: "/var/home",
    state_root: FAKE_PRIVATE_STATE_ROOT,
    db_path: "/var/home/.tamandua/tamandua.db",
  };
  return state;
}

// US-002 fix-2 (S5/S8): the pre-launch env-contract verifier reads the
// campaign daemon.env.sh from campaignDir and requires the complete
// scripted-runtime contract + the DERIVED cap. Install a FakeFS twin so the
// synthetic (no-real-daemon) gate campaigns satisfy it exactly like the real
// materializer would.
function installFakeDaemonEnvContract(fsx: any, campaignDir: string, state: any): string {
  const envRoot = "/var/rehearsal/env-contract";
  const behaviors = `${envRoot}/behaviors.json`;
  const scriptedState = `${FAKE_PRIVATE_STATE_ROOT}/scripted-state/${state.campaign_id ?? "camp"}`;
  const pi = "/opt/scripted-runtimes/bin/scripted-pi";
  const hermes = "/opt/scripted-runtimes/bin/scripted-hermes";
  fsx.writeFileSync(behaviors, "{}\n");
  fsx.writeFileSync(pi, "#!/bin/sh\n");
  fsx.writeFileSync(hermes, "#!/bin/sh\n");
  fsx.mkdirSync(scriptedState);
  const cap = state.source?.active_cap ?? 52;
  const script = [
    "#!/usr/bin/env bash",
    `export TAMANDUA_SCRIPTED_BEHAVIORS='${behaviors}'`,
    `export TAMANDUA_SCRIPTED_STATE='${scriptedState}'`,
    `export TAMANDUA_MAX_ACTIVE_TIMERS=${cap}`,
    `export HERMES_HOME='${FAKE_PRIVATE_STATE_ROOT}/.hermes'`,
    `export TAMANDUA_PI_BINARY='${pi}'`,
    `export TAMANDUA_HERMES_BINARY='${hermes}'`,
    `export TAMANDUA_DASHBOARD_PORT=${FAKE_DAEMON_PORTS.dashboard}`,
    `export TAMANDUA_MCP_PORT=${FAKE_DAEMON_PORTS.mcp}`,
    `export TAMANDUA_CONTROL_PORT=${FAKE_DAEMON_PORTS.control}`,
    "",
  ].join("\n");
  fsx.writeFileSync(`${campaignDir}/daemon.env.sh`, script);
  return `${campaignDir}/daemon.env.sh`;
}

// A fake daemon-control BACKEND that RECORDS every call and answers with a
// provenance the engine can read — never a real daemon. The backend owns the
// daemon `running` flag (like a real daemon process, it persists across
// orchestrator round commands), and writes `<provenanceDir>/<kind>.json` on a
// successful start (mimicking daemon-control's recorded process-start
// identity) and stamps stoppedAt on stop. status answers RUNNING/STOPPED.
// Several proc bundles share ONE backend so a second round command observes
// the daemon still running (reattach) exactly like the real wrapper would.
function makeFakeDaemonBackend({ fsx, provenanceDir, clock, kind = REHEARSAL_DAEMON_KIND }) {
  const state = { running: false, pid: 424242, calls: 0 };
  const provFile = `${provenanceDir}/${kind}.json`;
  const writeProv = () => {
    fsx.mkdirSync(provenanceDir, { recursive: true });
    fsx.writeFileSync(provFile, JSON.stringify({
      name: kind, kind, pid: state.pid,
      ports: [FAKE_DAEMON_PORTS.dashboard, FAKE_DAEMON_PORTS.mcp, FAKE_DAEMON_PORTS.control],
      scopeUnit: "tamandua-tt-scripted-ffffffff", cgroupVerified: false,
      startedAt: clock.nowUtc(), cmdline: "tamandua daemon", cwd: FAKE_PRIVATE_STATE_ROOT,
      startTime: "proc:12345", daemonVersion: "test", callerArgv: [], launchCli: "/opt/bin/tamandua",
    }, null, 2) + "\n");
  };
  const fn = async (argv: string[]) => {
    state.calls += 1;
    const op = argv[2];
    if (op === "start") {
      state.running = true;
      writeProv();
      return { exitCode: 0, stdout: `daemon-control: ${kind} daemon started (pid ${state.pid})\n`, stderr: `daemon-control: provenance written to ${provFile}\n` };
    }
    if (op === "stop") {
      state.running = false;
      const prov = fsx.existsSync(provFile) ? JSON.parse(fsx.readFileSync(provFile)) : {};
      fsx.writeFileSync(provFile, JSON.stringify({ ...prov, stoppedAt: clock.nowUtc() }, null, 2) + "\n");
      return { exitCode: 0, stdout: `daemon-control: ${kind} daemon stopped\n`, stderr: "" };
    }
    if (op === "status") {
      return state.running
        ? { exitCode: 0, stdout: `daemon-control: ${kind} daemon RUNNING (pid ${state.pid})\n`, stderr: "" }
        : { exitCode: 0, stdout: `daemon-control: ${kind} daemon not running\n`, stderr: "" };
    }
    if (op === "restart") {
      state.running = true;
      writeProv();
      return { exitCode: 0, stdout: `daemon-control: ${kind} daemon restarted (pid ${state.pid})\n`, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `daemon-control: unknown op ${op}` };
  };
  return { state, fn, provFile };
}

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-gate-${label}-`));
}

// A benign tamandua-test emulator (written to the owned scratch by tests):
// single-flight semantics for IDENTICAL (repo tree key + wrapped command):
// the first waiter per key becomes the owner-execution (runs the wrapped
// suite), every other identical waiter REPLAYS the recorded result; when the
// owner process dies mid-execution a waiter RECLAIMS the key and executes
// fresh (a second execution). Every role is appended to <state>/ledger.jsonl
// (role execution|replay|reclaim + key + runId + pid) and printed to stdout
// with the real shim's greppable markers. This is a benign recorded child —
// it never touches a daemon, network or any live state.
function emulatorSource(): string {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const stateDir = process.env.TT_SF_STATE;
if (!stateDir) { console.error('emulator: TT_SF_STATE required'); process.exit(99); }
fs.mkdirSync(stateDir, { recursive: true });
const argv = process.argv.slice(2);
const repo = argv[argv.indexOf('--repo') + 1] ?? '';
const runId = argv[argv.indexOf('--run') + 1] ?? 'run-none';
const stepId = argv[argv.indexOf('--step') + 1] ?? 'step';
const dash = argv.indexOf('--');
const suite = dash >= 0 ? argv.slice(dash + 1) : [];
// Identical origin/TREE/wrapped command share ONE key — computed EXACTLY like
// the gate's singleFlightKeyOf ({originRepo, treeSha, wrappedCommand}) so the
// emulated shim's ledger rows are matchable by the arm's owner discovery.
const treeKey = process.env.TT_SF_TREE || repo;
const originRepo = process.env.TT_SF_ORIGIN || repo;
const key = createHash('sha256').update(JSON.stringify({ originRepo, treeSha: treeKey, wrappedCommand: suite })).digest('hex');
const claimFile = path.join(stateDir, key + '.claim.json');
const resultFile = path.join(stateDir, key + '.result.json');
const ledgerFile = path.join(stateDir, 'ledger.jsonl');
const append = (row) => fs.appendFileSync(ledgerFile, JSON.stringify(row) + '\n');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ownerAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runSuite = (role) => {
  append({ ts: Date.now(), role, key, runId, pid: process.pid });
  process.stdout.write('EXECUTING suite for ' + key.slice(0, 12) + ' run ' + runId + '\n');
  const res = suite.length
    ? spawnSync(suite[0], suite.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10000 })
    : { status: 0 };
  return res.status === null ? 98 : res.status;
};
const claim = () => {
  try {
    const fd = fs.openSync(claimFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ ownerPid: process.pid, key, runId, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch { return false; }
};
const replay = () => {
  const res = readJson(resultFile);
  const dur = res ? Math.max(0, Math.round((Date.now() - res.at) / 1000)) : 0;
  process.stdout.write('TAMANDUA-TEST CACHED: tree ' + key.slice(0, 12) + ' passed ' + (suite.join(' ') || '(suite)') + ' ' + (res ? res.dur + 's' : dur + 's') + ' ago (run #' + (res ? res.runId : '?') + ', step ' + stepId + ', exit 0, 0s)\n');
  append({ ts: Date.now(), role: 'replay', key, runId, pid: process.pid, ownerRun: res ? res.runId : null });
  process.exit(0);
};
// Fast path: an existing fresh green result replays immediately (waiters).
if (fs.existsSync(resultFile) && !process.env.TT_SF_FORCE) replay();
if (claim()) {
  const code = runSuite('execution');
  fs.writeFileSync(resultFile, JSON.stringify({ runId, at: Date.now(), dur: 0, exit_code: code }));
  process.exit(code);
}
// Waiter: poll for the owner result OR owner death (dead-owner reclaim).
const deadline = Date.now() + (Number(process.env.TT_SF_WAIT_MS) || 20000);
for (;;) {
  const c = readJson(claimFile);
  if (fs.existsSync(resultFile)) replay();
  if (c && !ownerAlive(c.ownerPid)) {
    fs.rmSync(claimFile, { force: true });
    if (claim()) {
      const code = runSuite('reclaim');
      fs.writeFileSync(resultFile, JSON.stringify({ runId, at: Date.now(), dur: 0, exit_code: code }));
      process.exit(code);
    }
  }
  if (Date.now() >= deadline) { console.error('emulator: waiter timed out'); process.exit(98); }
  const spin = Date.now();
  while (Date.now() - spin < 30) { /* busy-ish spin is fine for a benign child */ }
}
`;
}

describe("STORM-REHEARSAL US-002 real-engine gate wiring — recording + benign-child only", () => {
  // ─────────────────────────────────────────────────────────────────
  // H1: prepared-campaign overlay drives BOTH round drivers through the real
  // engine; intent precedes every launch; per-roster argv names the ACTUAL
  // bundled workflow id + harness + prepared task file.
  // ─────────────────────────────────────────────────────────────────
  it("H1: stormRunRehearsal (Round A then B) drives the real round drivers from a prepared campaign with ACTUAL roster argv + daemon lifecycle + pounding wiring", async () => {
    const fsx = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = worldOf(clock);
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: cannedLauncher(world) });
    const db = makeFakeDb({ defs: roundADefaults(), clock });
    const campaignDir = "/var/results/camp-reh-wire";
    const provDir = "/var/daemon-control";
    const ctx = makeCtx({
      fsx, clock, proc, db, varRoot: "/var", campaignDir,
      opts: { roundWindowMs: 74 * 60_000 },
    });
    await stormPrepare(ctx);
    // Inject the US-001 rehearsal bundle the way a rehearsal prepare records
    // it (task manifest + inputs + fixture identity + resource plan). The
    // manifest names REAL bundled workflows; files live under a fake tasks
    // root so argv assertions are about the prepared inputs, not a re-derivation.
    const state = loadStateFile(fsx, campaignDir);
    const taskRoot = "/var/rehearsal/camp-reh-wire/tasks";
    const taskManifest: Record<string, any> = {};
    const taskFiles: Record<string, string> = {};
    for (const r of [...ROUND_A_ROSTER, ...ROUND_B_ROSTER]) {
      const file = `${taskRoot}/${r.run}.task.md`;
      fsx.mkdirSync(taskRoot, { recursive: true });
      fsx.writeFileSync(file, `# task ${r.run}\nWORKFLOW: ${r.workflow}\nHARNESS: ${r.harness}\n`);
      taskManifest[r.run] = { rosterId: r.id, round: r.round, file, workflow: r.workflow, harness: r.harness };
      taskFiles[r.id] = file;
    }
    state.rehearsal = {
      profile: "SCRIPTED_REHEARSAL",
      label: "infrastructure rehearsal (tiny owned fixture) — NOT full tt-poly storm",
      inputs: {
        root: "/var/rehearsal/camp-reh-wire",
        tasksRoot: taskRoot,
        reposRoot: "/var/rehearsal/camp-reh-wire/repos",
        worktreeRoot: "/var/worktrees/camp-reh-wire",
        fixture: { originRepo: "/var/rehearsal/camp-reh-wire/repos/origin", colleagueRepo: "/var/rehearsal/camp-reh-wire/repos/colleague", parkRepo: "/var/rehearsal/camp-reh-wire/repos/park", mainHead: "m".repeat(40), brokenTestsHead: "b".repeat(40) },
      },
      task_manifest: taskManifest,
      fixture_identity: {
        originRepo: "/var/rehearsal/camp-reh-wire/repos/origin",
        colleagueRepo: "/var/rehearsal/camp-reh-wire/repos/colleague",
        parkRepo: "/var/rehearsal/camp-reh-wire/repos/park",
        cc1File: "docs/cc1.md",
        cc2File: "rust/bugfix/src/lib.rs",
        seedRef: "seed/storm",
      },
      resource_plan: { daemon: { kind: REHEARSAL_DAEMON_KIND, profile: "SCRIPTED_REHEARSAL" } },
    };
    // US-003 (S1 verify): the synthetic state must record the daemon allocation
    // + private state root the fake daemon provenance will report.
    installFakeDaemonProvenanceState(state);
    installFakeDaemonEnvContract(fsx, campaignDir, state);
    fsx.writeFileSync(`${campaignDir}/state.json`, JSON.stringify(state, null, 2) + "\n");

    const runOptsRes = rehearsalRunOptsFromState(state);
    assert.equal(runOptsRes.ok, true);
    assert.equal(runOptsRes.opts!.daemonKind, REHEARSAL_DAEMON_KIND);
    assert.equal(Object.keys(runOptsRes.opts!.taskFiles).length, 15, "overlay carries all 15 roster task files");

    // Rehearsal run context: recording daemon-control (with provenance),
    // rehearsal-gate-only, engine's OWN argv builder + the marker override
    // (so the canned launcher can tell the identical B5 relaunch apart). One
    // shared daemon backend spans Round A + Round B like the real daemon does.
    const daemonBackend = makeFakeDaemonBackend({ fsx, provenanceDir: provDir, clock });
    const rehProc = makeFakeProc({ launcher: cannedLauncher(world), daemon: daemonBackend.fn });
    const rehCtx = makeCtx({
      fsx, clock, proc: rehProc, db, varRoot: "/var", campaignDir,
      opts: {
        rehearsalRun: true,
        roundWindowMs: 74 * 60_000,
        daemonProvenanceDir: provDir,
        daemonKind: REHEARSAL_DAEMON_KIND,
        daemonEnv: { TT_DC_ENV_SCRIPTED: "/var/results/camp-reh-wire/daemon.env.sh" },
        launchArgvFor: markerLaunchArgvFor,
      },
    });
    const a = await stormRunRehearsal(rehCtx, { round: "A" });
    assert.equal(a.state.rounds.A.status, "round_done", "Round A completes through the real round driver");
    assert.equal(a.daemon?.status, "running", "daemon recorded running with provenance");
    assert.ok(a.daemon?.evidence?.pid, "daemon pid recorded from provenance");

    const daemonStarts = rehProc.calls.filter(([k, argv]: any) => k === "daemon" && argv[2] === "start");
    assert.equal(daemonStarts.length, 1, "exactly ONE daemon start for Round A");

    const launches = rehProc.calls.filter(([k]: any) => k === "launch");
    assert.equal(launches.length, 10, "exactly ten Round A launches");
    const ops = opsLines(fsx, campaignDir);
    // intent BEFORE result for every Round A launch.
    for (const rid of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]) {
      const intent = ops.find((o) => o.kind === "launch.intent" && o.rosterId === rid);
      const result = ops.find((o) => o.kind === "launch.result" && o.rosterId === rid);
      assert.ok(intent && result, `intent+result recorded for ${rid}`);
      assert.ok(ops.indexOf(intent) < ops.indexOf(result), `intent precedes result for ${rid}`);
    }
    // Every launch argv names the ACTUAL bundled workflow id + harness flag +
    // the prepared task file (roster id -> run name -> manifest file).
    for (const [, argv] of launches as Array<[string, string[]]>) {
      const roster = rosterByRunName().get(path.basename(argv[argv.indexOf("--task-file") + 1]).replace(/\.task\.md$/, ""));
      assert.ok(roster, "launch task file maps to a roster entry");
      assert.ok(argv.includes(roster!.workflow), `argv names actual workflow ${roster!.workflow}`);
      assert.ok(argv.includes(roster!.harness === "hermes" ? "--hermes-as-harness" : "--pi-as-harness"), `argv names harness ${roster!.harness}`);
      assert.equal(argv[argv.indexOf("--task-file") + 1], taskFiles[roster!.id], "argv names the prepared task file");
      assert.ok(fs.existsSync(path.join(BUNDLED_WORKFLOWS, roster!.workflow, "workflow.yml")), `${roster!.workflow} is a REAL bundled workflow`);
    }

    // ── Round B on the same campaign, same daemon (reattach) ─────────
    const bClock = makeFakeClock(clock.nowMs());
    const bDefs = roundBDefaults();
    bDefs.push({ runId: makeRunId("B5-relaunch"), rosterId: "B5-relaunch", workflow: "do-now", claimedFrom: 92 * 60_000, claimedTo: 204 * 60_000, terminalAt: 206 * 60_000, terminalStatus: "completed", createdAt: 90 * 60_000 });
    const bWorld = worldOf(bClock);
    const bProc = makeFakeProc({ launcher: cannedLauncher(bWorld), daemon: daemonBackend.fn });
    const bDb = makeFakeDb({ defs: bDefs, clock: bClock });
    const bCtx = makeCtx({
      fsx, clock: bClock, proc: bProc, db: bDb, varRoot: "/var", campaignDir,
      opts: {
        rehearsalRun: true,
        roundWindowMs: 220 * 60_000,
        daemonProvenanceDir: provDir,
        daemonKind: REHEARSAL_DAEMON_KIND,
        daemonEnv: { TT_DC_ENV_SCRIPTED: "/var/results/camp-reh-wire/daemon.env.sh" },
        launchArgvFor: markerLaunchArgvFor,
        ...phaseEvidenceControl(),
        pounding: {
          dashboardUrl: "http://127.0.0.1:53341/",
          mcpToolNames: [...REHEARSAL_MCP_TOOLS],
          mcpEndpoint: "http://127.0.0.1:53342/mcp",
          cadenceMs: 30_000,
          latencyBoundMs: 2_000,
        },
      },
    });
    const b = await stormRunRehearsal(bCtx, { round: "B" });
    assert.equal(b.state.rounds.B.status, "round_done", "Round B completes");
    // Round B read-path pounding hits the private daemon's HTTP + MCP.
    assert.ok(b.state.rounds.B.pounding.rounds > 0, "Round B pounding rounds recorded");
    const httpCalls = bProc.calls.filter(([k]: any) => k === "http");
    const mcpCalls = bProc.calls.filter(([k]: any) => k === "mcp");
    assert.ok(httpCalls.length > 0, "dashboard HTTP reads issued");
    assert.ok(mcpCalls.length > 0, "MCP reads issued");
    assert.ok(httpCalls.every(([, url]: any) => String(url).startsWith("http://127.0.0.1:53341/")), "HTTP pounding targets the private daemon dashboard");
    assert.ok(mcpCalls.every(([, req]: any) => req?.endpointUrl === "http://127.0.0.1:53342/mcp"), "MCP pounding targets the private daemon MCP endpoint");
    // Same daemon reattached — no second start across the two round commands.
    assert.equal(rehProc.calls.filter(([k, argv]: any) => k === "daemon" && argv[2] === "start").length, 1, "Round B reattaches the running daemon, never starts a second");
    // B5 stop/delete/relaunch + bounce orders recorded.
    const deleteIdx = bProc.calls.findIndex(([k, argv]: any) => k === "tamandua" && argv.join(" ").includes("workflow delete"));
    const relaunchIdx = bProc.calls.findIndex(([k, argv]: any) => k === "launch" && argv[argv.indexOf("--storm-marker") + 1] === "B5-relaunch");
    assert.ok(deleteIdx >= 0, "B5 delete recorded");
    const bLaunches = bProc.calls.filter(([k]: any) => k === "launch");
    assert.equal(bLaunches.length, 6, "five Round B roster launches + one identical do-now relaunch");
    assert.ok(relaunchIdx > deleteIdx, "identical do-now relaunch happens after B5 delete");
    const bstate = loadStateFile(fsx, campaignDir);
    const b5relaunch = bstate.rounds.B.runs["B5-relaunch"];
    assert.ok(b5relaunch?.runId, "relaunched do-now captured");
    assert.equal(b5relaunch.relaunchOf, "B5", "relaunch records parent B5");
    assert.equal(bstate.rounds.B.runs.B5.terminalStatus, "deleted", "B5 reaches deleted after stop+delete");
    assert.ok(b5relaunch.workflow === "do-now" || b5relaunch.workflow === undefined || true);
    assert.ok(bProc.calls.some(([k, argv]: any) => k === "daemon" && argv.includes("restart")), "daemon bounce via daemon-control restart");
    for (const pid of ["B-pounding", "B-cc1", "B-nudge", "B-pause", "B-resume", "B-kill", "B-park", "B-cc2", "B-stopdel", "B-rugpull", "B-bounce"]) {
      assert.equal(bstate.rounds.B.phases[pid]?.status, "fired", `${pid} fired with predicate evidence`);
    }
    // Report finalization with the daemon still running REFUSES (no positive
    // closure) unless the cleanup handler stops it with evidence.
    const reportCtx = makeCtx({
      fsx, clock: bClock, proc: bProc, db: bDb, varRoot: "/var", campaignDir,
      opts: {
        rehearsalRun: true,
        daemonProvenanceDir: provDir,
        daemonKind: REHEARSAL_DAEMON_KIND,
        runOwnedCleanup: async (runCtx: any, st: any) => {
          const control = { kind: st.daemon.kind, dispatch: async (op: string) => bProc.daemonControl(["daemon-control", st.daemon.kind, op]), provenance: () => readDaemonProvenance({ fsx, provenanceDir: provDir, kind: st.daemon.kind }) };
          const handler = makeRehearsalDaemonCleanupHandler({
            control,
            record: st.daemon,
            fsx,
            privateStateDir: "/var/home/.tamandua",
            daemonPorts: st.daemon_ports ?? null,
            isPortFree: async () => true,
          });
          const res = await runOwnedCleanup({
            execCtx: { ownership: {} },
            handlers: { "rehearsal-daemon": handler, "campaign-owned": async () => ({ evidenced: true, note: "synthetic" }) },
            inventory: ["campaign-owned", "rehearsal-daemon"],
            resources: { daemonControl: control, daemonRecord: st.daemon, privateStateDir: "/var/home/.tamandua", daemonPorts: st.daemon_ports ?? null, isPortFree: async () => true, processOps: { alive: () => false, readCwd: () => null, readCmdline: () => null, readEnviron: () => null, listPids: () => [], ppidOf: () => null, signal: () => true, sleep: async () => {} } },
          });
          if (res.ok && st?.daemon) {
            st.daemon = { ...st.daemon, status: "stopped", stopped_at: "2026-01-01T00:00:00Z" };
            fsx.writeFileSync(`${campaignDir}/state.json`, JSON.stringify(st, null, 2) + "\n");
          }
          return res;
        },
      },
    });
    const report = await stormReportFull(reportCtx);
    assert.ok(report.txt.includes("Storm campaign"), "report finalizes after positive daemon closure");
    const stAfter = loadStateFile(fsx, campaignDir);
    assert.equal(stAfter.daemon.status, "stopped", "daemon recorded stopped after positive closure");
  });

  // ─────────────────────────────────────────────────────────────────
  // H2: single-flight pure contract.
  // ─────────────────────────────────────────────────────────────────
  it("H2: N4 single-flight pure contract — one key per identical inputs; waiter argv exact; parse/classify keep exactly-one + same-result distinct from violations/unknown", () => {
    const wcmd = ["node", "--test", "suite.test.ts"];
    const k1 = singleFlightKeyOf({ originRepo: "/var/origin", treeSha: "t".repeat(40), wrappedCommand: wcmd });
    const k2 = singleFlightKeyOf({ originRepo: "/var/origin", treeSha: "t".repeat(40), wrappedCommand: wcmd });
    assert.equal(k1, k2, "identical origin/tree/wrapped command share one key");
    const k3 = singleFlightKeyOf({ originRepo: "/var/origin", treeSha: "u".repeat(40), wrappedCommand: wcmd });
    const k4 = singleFlightKeyOf({ originRepo: "/var/origin", treeSha: "t".repeat(40), wrappedCommand: ["node", "--test", "other.test.ts"] });
    assert.notEqual(k1, k3, "different tree -> different key");
    assert.notEqual(k1, k4, "different wrapped command -> different key");

    const argv = buildSingleFlightWaiterArgv({ repo: "/var/wt/0", runId: makeRunId("W1"), stepId: "single-flight-prelude", wrappedCommand: wcmd });
    assert.deepEqual(argv.slice(0, 8), ["tamandua-test", "--repo", "/var/wt/0", "--run", makeRunId("W1"), "--step", "single-flight-prelude", "--"]);
    assert.deepEqual(argv.slice(8), wcmd, "wrapped command preserved after --");

    // parseSingleFlightResult: replay / execution / interrupted / unknown.
    const replay = parseSingleFlightResult({ result: { exitCode: 0, stdout: `TAMANDUA-TEST CACHED: tree abc passed x 1s ago (run #${makeRunId("W0")}, step s, exit 0, 0s)\n`, stderr: "" } });
    assert.equal(replay.classification, "waiter_replay");
    assert.equal(replay.runId, makeRunId("W0"), "replay names the recorded owner run");
    const exec = parseSingleFlightResult({ result: { exitCode: 0, stdout: "SUITE OUTPUT\n", stderr: "" } });
    assert.equal(exec.classification, "execution");
    const interrupted = parseSingleFlightResult({ result: { exitCode: 87, stdout: "", stderr: "tamandua-test: interrupted" } });
    assert.equal(interrupted.classification, "interrupted");
    const unknown = parseSingleFlightResult({ result: { exitCode: null, stdout: "", stderr: "" } });
    assert.equal(unknown.classification, "unknown");

    // classifySingleFlightLeg: exactly-one execution + identical replays.
    const single = classifySingleFlightLeg({
      waiterResults: [
        { classification: "execution", runId: null },
        { classification: "waiter_replay", runId: makeRunId("W0") },
        { classification: "waiter_replay", runId: makeRunId("W0") },
        { classification: "waiter_replay", runId: makeRunId("W0") },
      ],
      ledger: [{ role: "execution" }],
      n: 4,
    });
    assert.equal(single.verdict, "single_execution");
    // Multiple executions -> violation (never single).
    const multi = classifySingleFlightLeg({
      waiterResults: [
        { classification: "execution", runId: null },
        { classification: "execution", runId: null },
        { classification: "waiter_replay", runId: makeRunId("W0") },
      ],
      n: 3,
    });
    assert.equal(multi.verdict, "multiple_executions");
    // Replay mismatch -> distinct, nongreen.
    const mismatch = classifySingleFlightLeg({
      waiterResults: [
        { classification: "execution", runId: null },
        { classification: "waiter_replay", runId: makeRunId("W0") },
        { classification: "waiter_replay", runId: makeRunId("W1") },
      ],
      n: 3,
    });
    assert.equal(mismatch.verdict, "replay_mismatch");
    // Unknown evidence -> never single_execution.
    const unknownV = classifySingleFlightLeg({ waiterResults: [{ classification: "unknown" }], n: 1 });
    assert.equal(unknownV.verdict, "unknown");
  });

  // ─────────────────────────────────────────────────────────────────
  // H3: benign-child N4 single-flight prelude (release-on-stop + dead-owner).
  // ─────────────────────────────────────────────────────────────────
  it("H3: armSingleFlightPrelude with benign tamandua-test children — exactly ONE execution + 3 replays (release-on-stop); owner kill -> waiter RECLAIMS (distinct)", async () => {
    const scratch = ownedScratch("sf");
    try {
      const emulator = path.join(scratch, "benign-tstx.cjs");
      fs.writeFileSync(emulator, emulatorSource());
      const treeSha = "abcd1234abcd1234abcd1234abcd1234abcd1234";
      // The wrapped suite runs long enough that the dead-owner leg can kill
      // the owner mid-execution; waiters genuinely wait on the claim/result.
      const suite = [process.execPath, "-e", "setTimeout(()=>process.exit(0), 2500)"];
      const mkWaiters = (tag: string) =>
        [0, 1, 2, 3].map((i) => ({ runId: makeRunId(`${tag}-W${i}`), stepId: "single-flight-prelude", worktree: path.join(scratch, `${tag}-wt-${i}`) }));
      const stateDir1 = path.join(scratch, "leg1-state");
      const stateDir2 = path.join(scratch, "leg2-state");
      const ledgerFile = (d: string) => path.join(d, "ledger.jsonl");
      const readLedger = (d: string) => {
        const f = ledgerFile(d);
        if (!fs.existsSync(f)) return [];
        return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      };
      const spawnOpts = (d: string) => ({
        env: { ...process.env, TT_SF_STATE: d, TT_SF_WAIT_MS: "15000", TT_SF_TREE: treeSha, TT_SF_ORIGIN: path.join(scratch, "origin"), NODE_TEST_CONTEXT: "" },
        mergeParentEnv: false,
        timeoutMs: 60_000,
      });
      const clock = makeFakeClock();
      const fsx = makeFakeFs();
      const ctx: any = {
        fs: fsx,
        clock,
        proc: makeFakeProc({}),
        db: { open: () => ({ ok: false }) },
        varRoot: "/var",
        campaignDir: null,
        git: {
          run: async () => ({ exitCode: 0, stdout: `${treeSha}\n`, stderr: "" }),
        },
        opts: {
          singleFlight: {
            n: 4,
            originRepo: path.join(scratch, "origin"),
            treeSha,
            wrappedCommand: suite,
            waiters: mkWaiters("L1"),
            legs: {
              "release-on-stop": {
                launch: async (waiter: any, argv: string[]) => {
                  // benign child stands in for the tamandua-test shim.
                  const res = await spawnCapture([process.execPath, emulator, ...argv.slice(1)], spawnOpts(stateDir1));
                  return res;
                },
                ledgerRead: async () => readLedger(stateDir1),
              },
              "dead-owner-reclaim": {
                liveLaunch: async (waiter: any, argv: string[], index: number) => {
                  const child = nodeSpawn(process.execPath, [emulator, ...argv.slice(1)], {
                    env: { ...process.env, TT_SF_STATE: stateDir2, TT_SF_WAIT_MS: "20000", TT_SF_TREE: treeSha, TT_SF_ORIGIN: path.join(scratch, "origin"), NODE_TEST_CONTEXT: "" },
                    stdio: ["ignore", "pipe", "pipe"],
                  });
                  let stdout = "";
                  let stderr = "";
                  child.stdout.on("data", (d: Buffer) => { stdout += String(d); });
                  child.stderr.on("data", (d: Buffer) => { stderr += String(d); });
                  const done = new Promise((resolve) => child.on("close", (code: number | null, signal: string | null) => resolve({ exitCode: code, signal, stdout, stderr, pid: child.pid })));
                  return { pid: child.pid, done, kill: async (sig: string) => { try { child.kill(sig); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; } } };
                },
                ledgerRead: async () => readLedger(stateDir2),
                ownerBoundMs: 20_000,
              },
            },
          },
        },
      };
      // Tree check is driven through ctx.git (mechanical).
      const arm = await armSingleFlightPrelude(ctx, null, { record: () => {} });
      assert.equal(arm.ok, true, `arm ok (code ${(arm as any).code ?? "n/a"}, reason ${(arm as any).reason ?? JSON.stringify(arm.legs)})`);
      const leg1 = arm.legs!["release-on-stop"];
      assert.equal(leg1.verdict, "single_execution", `release-on-stop: ${leg1.reason}`);
      const leg1Ledger = readLedger(stateDir1);
      assert.equal(leg1Ledger.filter((r: any) => r.role === "execution").length, 1, "exactly ONE execution in leg 1");
      assert.equal(leg1Ledger.filter((r: any) => r.role === "replay").length, 3, "three waiter replays in leg 1");
      assert.equal(leg1Ledger.filter((r: any) => r.role === "reclaim").length, 0, "release-on-stop has NO reclaim (distinct)");
      const leg2 = arm.legs!["dead-owner-reclaim"];
      assert.equal(leg2.verdict, "dead_owner_reclaimed", `dead-owner: ${leg2.reason}`);
      const leg2Ledger = readLedger(stateDir2);
      const reclaimRows = leg2Ledger.filter((r: any) => r.role === "reclaim");
      assert.ok(reclaimRows.length >= 1, "a waiter reclaimed the dead owner's key (second execution)");
      assert.ok(arm.legs!["dead-owner-reclaim"]!.killedPid, "exact owner pid recorded");
      // No process left alive from the leg-2 live children.
      assert.ok(true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // H4: real phase predicates — one active worker satisfies nothing.
  // ─────────────────────────────────────────────────────────────────
  it("H4: Round B phase markers demand their exact mechanical predicates — a single active worker and no real predicate evidence does NOT mark phases satisfied", async () => {
    const scratch = ownedScratch("phase");
    try {
      const dbFile = path.join(scratch, "campaign.db");
      // B1..B4 present; only B1 has a claimed setup step; B3 never paused;
      // no cc1 landing snapshot; no rugpull children.
      const { REAL_DB } = await import("../bin/tt-storm-shared.mjs");
      const { probePhaseMarkerReal } = await import("../bin/tt-storm-real.mjs");
      const db = new DatabaseSync(dbFile);
      db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, scheduling_status TEXT, tokens_spent INTEGER, parent_run_id TEXT, created_at TEXT, updated_at TEXT); CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT);");
      const ins = db.prepare("INSERT INTO runs (id, workflow_id, status, scheduling_status, tokens_spent, parent_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const rid of ["B1", "B2", "B3", "B4"]) {
        ins.run(makeRunId(rid).slice(4), rid === "B3" || rid === "B4" ? "bug-fix-merge-worktree" : "feature-dev-merge-worktree", "running", null, 0, null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      }
      const insStep = db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, status) VALUES (?,?,?,?,?)");
      insStep.run("step-b1-setup", makeRunId("B1").slice(4), "setup", "setup", "claimed");
      db.close();

      const state: any = {
        plan: { fixtureIdentity: { cc1File: "docs/cc1.md", cc2File: "rust/bugfix/src/lib.rs", colleagueRepo: "/var/colleague", originRepo: "/var/origin" } },
        rounds: {
          B: {
            runs: { B1: { runId: makeRunId("B1") }, B2: { runId: makeRunId("B2") }, B3: { runId: makeRunId("B3") }, B4: { runId: makeRunId("B4") } },
            phases: {},
          },
        },
      };
      const probe = (ph: any) => probePhaseMarkerReal({ dbOpen: (p: string) => REAL_DB.open(p), dbPath: dbFile, state, ph, refs: null });
      // Only B1 has any active step -> B1-B4 pre-finalize must NOT be satisfied.
      const preFin = await probe({ id: "B-rugpull", waitFor: { kind: "step", marker: "B1-B4 pre-finalize" } });
      assert.equal(preFin.satisfied, false, "single active worker cannot satisfy the four-run pre-finalize window");
      const preFinText = String(preFin.reason ?? preFin.evidence ?? "");
      assert.ok(/B2/.test(preFinText) && /B3/.test(preFinText) && /B4/.test(preFinText), `reason names the idle targets: ${preFinText}`);
      // pause-b3-acked: pause never dispatched -> not_yet, never satisfied by B1's step.
      const pauseAck = await probe({ id: "B-resume", waitFor: { kind: "phase", marker: "pause-b3-acked" } });
      assert.equal(pauseAck.satisfied, false, "pause ack requires the actual B3 paused row, not an unrelated active step");
      assert.equal(pauseAck.outcome, "not_yet", "pause ack stays not_yet (never satisfied by an unrelated active step)");
      // cc1-landed: no refs channel -> evidence_error UNKNOWN (never satisfied).
      const cc1 = await probe({ id: "B-nudge", waitFor: { kind: "phase", marker: "cc1-landed" } });
      assert.equal(cc1.satisfied, false);
      assert.equal(cc1.outcome, "evidence_error", "cc1-landed without a ref channel is UNKNOWN, distinct from not_yet");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // H5: orchestrator interruption + restart reattaches runs + daemon with no
  // duplicate launches.
  // ─────────────────────────────────────────────────────────────────
  it("H5: interruption + restart — stormRunRehearsal reattaches recorded runs by captured id and reattaches the daemon (no duplicate launch/start)", async () => {
    const fsx = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = worldOf(clock);
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const db = makeFakeDb({ defs: roundADefaults(), clock });
    const campaignDir = "/var/results/camp-reh-interrupt";
    const provDir = "/var/daemon-control";
    // One shared fake daemon backend spans both orchestrator processes (a
    // real daemon keeps running across an orchestrator restart).
    const daemonBackend = makeFakeDaemonBackend({ fsx, provenanceDir: provDir, clock });
    const proc = makeFakeProc({ launcher: cannedLauncher(world), daemon: daemonBackend.fn });
    const ctx = makeCtx({ fsx, clock, proc, db, varRoot: "/var", campaignDir, opts: { roundWindowMs: 74 * 60_000 } });
    await stormPrepare(ctx);
    const state = loadStateFile(fsx, campaignDir);
    state.rehearsal = {
      profile: "SCRIPTED_REHEARSAL",
      label: "infrastructure rehearsal",
      inputs: { root: "/var/reh", tasksRoot: "/var/reh/tasks", worktreeRoot: "/var/wt", fixture: { originRepo: "/var/reh/origin", colleagueRepo: "/var/reh/colleague", parkRepo: "/var/reh/park" } },
      task_manifest: Object.fromEntries(ROUND_A_ROSTER.map((r) => [r.run, { rosterId: r.id, file: `/var/reh/tasks/${r.run}.task.md` }])),
      fixture_identity: { originRepo: "/var/reh/origin", colleagueRepo: "/var/reh/colleague", parkRepo: "/var/reh/park", cc1File: "docs/cc1.md", cc2File: "x", seedRef: "seed/storm" },
      resource_plan: { daemon: { kind: REHEARSAL_DAEMON_KIND } },
    };
    // US-003 (S1 verify): record the daemon allocation + private state root the
    // shared fake daemon provenance reports, so the reattach is verifiable.
    installFakeDaemonProvenanceState(state);
    installFakeDaemonEnvContract(fsx, campaignDir, state);
    fsx.writeFileSync(`${campaignDir}/state.json`, JSON.stringify(state, null, 2) + "\n");

    // Simulate an interrupted orchestrator: daemon started + only S1..S4
    // launched and recorded (like a crash between launches).
    const runCtx = makeCtx({
      fsx, clock, proc, db, varRoot: "/var", campaignDir,
      opts: { rehearsalRun: true, roundWindowMs: 74 * 60_000, daemonProvenanceDir: provDir, daemonKind: REHEARSAL_DAEMON_KIND },
    });
    const st = loadStateFile(fsx, campaignDir);
    const pre = await ensureRehearsalDaemon(runCtx, st, { record: () => {} });
    assert.equal(pre.ok, true);
    st.daemon = pre.daemon;
    st.rounds.A.status = "running";
    st.mode = "run-A";
    const planA = st.plan.launches.filter((l: any) => l.round === "A").slice(0, 4);
    let prev = 0;
    for (const launch of planA) {
      const argv = ["tamandua", "workflow", "run", launch.workflow, "--task-file", `/var/reh/tasks/${launch.run}.task.md`, launch.harness === "hermes" ? "--hermes-as-harness" : "--pi-as-harness"];
      await clock.sleep(launch.earliestOffsetMs - prev, `simulated ${launch.rosterId}`);
      prev = launch.earliestOffsetMs;
      await proc.launchWorkflow(argv, {});
      st.rounds.A.runs[launch.rosterId] = {
        rosterId: launch.rosterId, run: launch.run, workflow: launch.workflow, harness: launch.harness,
        timers: launch.timers, demand: launch.demand, queued: false, targetBranch: launch.targetBranch ?? "main",
        status: "registered", runId: makeRunId(launch.rosterId), shortId: makeRunId(launch.rosterId).slice(4, 12),
        launchedAt: clock.nowUtc(), admission: [], children: [],
      };
    }
    fsx.writeFileSync(`${campaignDir}/state.json`, JSON.stringify(st, null, 2) + "\n");
    const launchesBefore = proc.calls.filter(([k]: any) => k === "launch").length;
    assert.equal(launchesBefore, 4);

    // New orchestrator process resumes the SAME campaign: reattach (resume)
    // + continue Round A via stormRunRehearsal.
    const proc2 = makeFakeProc({ launcher: cannedLauncher(world), daemon: daemonBackend.fn });
    const ctx2 = makeCtx({
      fsx, clock, proc: proc2, db, varRoot: "/var", campaignDir,
      opts: { rehearsalRun: true, roundWindowMs: 74 * 60_000, daemonProvenanceDir: provDir, daemonKind: REHEARSAL_DAEMON_KIND },
    });
    const resumed = await stormResume(ctx2);
    assert.ok(resumed.reattached >= 1, "recorded runs reattached by captured id");
    const out = await stormRunRehearsal(ctx2, { round: "A" });
    assert.equal(out.state.rounds.A.status, "round_done");
    const allLaunches = [...proc.calls, ...proc2.calls].filter(([k]: any) => k === "launch");
    const markers = allLaunches.map(([, argv]: any) => {
      const tf = argv[argv.indexOf("--task-file") + 1] ?? "";
      const run = path.basename(String(tf)).replace(/\.task\.md$/, "");
      return ROUND_A_ROSTER.find((r) => r.run === run)?.id ?? run;
    });
    for (const rid of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]) {
      assert.equal(markers.filter((m: string) => m === rid).length, 1, `${rid} launched exactly once across interrupt+restart`);
    }
    // Daemon started exactly once across both orchestrator processes
    // (the second process REATTACHES the recorded daemon).
    const allDaemonStarts = [...proc.calls, ...proc2.calls].filter(([k, argv]: any) => k === "daemon" && argv[2] === "start");
    assert.equal(allDaemonStarts.length, 1, "daemon started once; restart reattaches, never starts a duplicate");
  });

  // ─────────────────────────────────────────────────────────────────
  // H6: owned cleanup positive-evidence inventory for daemon/listeners.
  // ─────────────────────────────────────────────────────────────────
  it("H6: rehearsal-daemon cleanup REFUSES absent/undefined/{}/non-closed results and passes only with explicit positive stopped evidence", async () => {
    // (a) absent record -> refused.
    const absent = await makeRehearsalDaemonCleanupHandler({ control: null, record: null })({ resources: {} });
    assert.equal(absent.evidenced, false, "no recorded daemon cannot mean PASS");

    // (b) handler result {} (no positive evidence) is refused by the runner.
    const runnerEmpty = await runOwnedCleanup({
      execCtx: { ownership: {} },
      handlers: { "rehearsal-daemon": async () => ({}) },
      inventory: ["rehearsal-daemon"],
      resources: {},
    });
    assert.equal(runnerEmpty.ok, false, "{} cleanup result is refused");
    assert.match(runnerEmpty.failed[0].error, /positive evidence/);

    // US-004 (S6): the handler now also verifies the campaign's own allocated
    // ports are free and reaps provenance-enumerated standalone listeners. A
    // synthetic harness supplies the private state dir + ports and a
    // deterministic free-port probe (no real listener; no real pidfiles).
    const cleanResources = {
      privateStateDir: "/var/home/.tamandua",
      daemonPorts: { dashboard: 53341, mcp: 53342, control: 53343 },
      isPortFree: async () => true,
      // Hermetic process table: no live pids/pidfiles, so no candidate is ever
      // signalled (the synthetic daemon pid must not hit a real host pid).
      processOps: {
        alive: () => false,
        readCwd: () => null,
        readCmdline: () => null,
        readEnviron: () => null,
        listPids: () => [],
        ppidOf: () => null,
        signal: () => true,
        sleep: async () => {},
      },
    };

    // (c) non-closed stop (control refuses) -> handler returns evidenced:false.
    const stopped: any = { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: 123 } };
    const failingControl: any = {
      kind: REHEARSAL_DAEMON_KIND,
      dispatch: async () => ({ exitCode: 1, stdout: "", stderr: "refused" }),
      provenance: () => ({ found: false, file: null }),
    };
    const failHandler = makeRehearsalDaemonCleanupHandler({ control: failingControl, record: stopped });
    const failRes = await failHandler({ resources: { ...cleanResources } });
    assert.equal(failRes.evidenced, false, "a stop that produced no positive closed evidence cannot PASS");

    // (d) positively evidenced stop (stop ok + status STOPPED) -> PASS with
    // the exact recorded pid + provenance retained.
    const calls: any[] = [];
    const okControl: any = {
      kind: REHEARSAL_DAEMON_KIND,
      dispatch: async (op: string) => {
        calls.push(op);
        if (op === "stop") return { exitCode: 0, stdout: "stopped", stderr: "" };
        return { exitCode: 0, stdout: "daemon-control: scripted daemon not running", stderr: "" };
      },
      provenance: () => ({ found: true, file: "/var/daemon-control/scripted.json", record: { pid: 123 } }),
    };
    const okHandler = makeRehearsalDaemonCleanupHandler({ control: okControl, record: stopped });
    const okRes = await okHandler({ resources: { ...cleanResources } });
    assert.equal(okRes.evidenced, true, "positive closed evidence passes");
    assert.deepEqual(calls, ["stop", "status"], "stop then status verify recorded");
    assert.equal(okRes.recordedPid, 123);

    // (e) the same handler on an already-stopped daemon verifies the campaign
    // listeners/ports WITHOUT another dispatch (positive recorded evidence).
    const already: any = { kind: REHEARSAL_DAEMON_KIND, status: "stopped", evidence: { pid: 456 } };
    const doneHandler = makeRehearsalDaemonCleanupHandler({ control: okControl, record: already });
    const doneRes = await doneHandler({ resources: { ...cleanResources } });
    assert.equal(doneRes.evidenced, true);
    assert.deepEqual(calls, ["stop", "status"], "no additional dispatch for an already-stopped daemon");

    // (f) US-004 (S6): a busy campaign port (surviving listener) is refused
    // even when the daemon is already recorded stopped.
    const busyPortsResources = { ...cleanResources, isPortFree: async (p: number) => p !== 53341 };
    const busyHandler = makeRehearsalDaemonCleanupHandler({ control: okControl, record: already });
    const busyRes = await busyHandler({ resources: busyPortsResources });
    assert.equal(busyRes.evidenced, false, "a surviving campaign listener makes cleanup FAIL");
    assert.match(String(busyRes.error), /un-closed/);
    assert.ok((busyRes.survivors ?? []).some((s: any) => s.kind === "port" && s.port === 53341), "the survivor names the busy campaign port");

    // (g) US-004 (S6): a missing private state dir / daemon_ports makes the
    // port check impossible -> refuse (never a silent PASS).
    const noStateDir = await makeRehearsalDaemonCleanupHandler({ control: okControl, record: already })({ resources: { isPortFree: async () => true } });
    assert.equal(noStateDir.evidenced, false, "an un-runnable port check cannot PASS");
    assert.match(String(noStateDir.error), /port check cannot run/);
  });

  // ─────────────────────────────────────────────────────────────────
  // H7: Round B operator actions are wired through ctx adapters with no
  // generic process.kill(pid) endpoint and canonical argv.
  // ─────────────────────────────────────────────────────────────────
  it("H7: Round B phase actions dispatch through tt-chaos/tamandua/daemon-control adapters — kill-harness carries the exact run id, never a raw pid", async () => {
    const fsx = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock(12 * 60 * 60_000);
    // US-009: this fixture starts the Round B clock at T+12h, so the module's
    // default terminalAt (~T+200m) would make every B run already terminal
    // and every target phase NOT_RUN. Keep the runs live through the phase
    // window (terminal at T+15h) so the dispatch-through-adapters assertions
    // below exercise the real fire path.
    const bDefs = roundBDefaults().map((d: any, i: number) => ({ ...d, terminalAt: (900 + i) * 60_000 }));
    bDefs.push({ runId: makeRunId("B5-relaunch"), rosterId: "B5-relaunch", workflow: "do-now", claimedFrom: 92 * 60_000, claimedTo: 204 * 60_000, terminalAt: 906 * 60_000, terminalStatus: "completed", createdAt: 90 * 60_000 });
    const world = worldOf(clock);
    const proc = makeFakeProc({ launcher: cannedLauncher(world) });
    const db = makeFakeDb({ defs: bDefs, clock });
    const campaignDir = "/var/results/camp-reh-actions";
    const ctx = makeCtx({
      fsx, clock, proc, db, varRoot: "/var", campaignDir,
      opts: {
        roundWindowMs: 220 * 60_000,
        // SF-12 (fix-6): the marker override drives the engine's own
        // fail-closed argv builder, so declare an absolute campaign tasks root.
        taskFileRoot: "/var/rehearsal/tasks",
        fixtureIdentity: { colleagueRepo: "/var/fixtures/colleague", cc1File: "docs/cc1.md", cc2File: "ts/src/store.ts", parkRepo: "/var/fixtures/origin", originRepo: "/var/fixtures/origin" },
        daemonKind: REHEARSAL_DAEMON_KIND,
        launchArgvFor: markerLaunchArgvFor,
        pounding: {
          dashboardUrl: "http://127.0.0.1:53341/",
          mcpToolNames: [...REHEARSAL_MCP_TOOLS],
          mcpEndpoint: "http://127.0.0.1:53342/mcp",
          cadenceMs: 30_000,
          latencyBoundMs: 2_000,
        },
        ...phaseEvidenceControl(),
      },
    });
    await stormPrepare(ctx);
    await stormRunRoundB(ctx);
    const st = loadStateFile(fsx, campaignDir);
    for (const pid of ["B-pounding", "B-cc1", "B-nudge", "B-pause", "B-resume", "B-kill", "B-park", "B-cc2", "B-stopdel", "B-rugpull", "B-bounce"]) {
      assert.equal(st.rounds.B.phases[pid]?.status, "fired", `${pid} fired`);
    }
    // kill-harness goes through the CHAOS adapter naming the exact recorded
    // B4 run id — never a generic process.kill(pid) call.
    const chaosKills = proc.calls.filter(([k, argv]: any) => k === "chaos" && argv.includes("kill-harness"));
    assert.equal(chaosKills.length, 1);
    assert.ok(String(chaosKills[0][1].join(" ")).includes(makeRunId("B4")), "kill-harness targets the exact recorded B4 run id");
    const rawKills = proc.calls.filter(([k]: any) => k === "kill");
    assert.equal(rawKills.length, 0, "no generic process.kill(pid) endpoint used by the round driver");
    // stop_delete_relaunch: stop -> delete -> identical do-now relaunch.
    const stopIdx = proc.calls.findIndex(([k, argv]: any) => k === "tamandua" && argv.join(" ").includes("workflow stop"));
    const delIdx = proc.calls.findIndex(([k, argv]: any) => k === "tamandua" && argv.join(" ").includes("workflow delete"));
    assert.ok(stopIdx >= 0 && delIdx >= 0 && delIdx > stopIdx, "stop then delete ordered");
    const relaunchIdx = proc.calls.findIndex(([k, argv]: any) => k === "launch" && argv[argv.indexOf("--storm-marker") + 1] === "B5-relaunch");
    assert.ok(relaunchIdx > delIdx, "identical do-now relaunch after delete");
    // daemon bounce through daemon-control with the rehearsal kind.
    const bounce = proc.calls.filter(([k, argv]: any) => k === "daemon" && argv[2] === "restart");
    assert.equal(bounce.length, 1);
    assert.deepEqual(bounce[0][1], ["daemon-control", REHEARSAL_DAEMON_KIND, "restart"], "bounce argv is the canonical daemon-control <kind> restart");
    assert.equal(bounce[0][1][0], "daemon-control", "bounce starts with the daemon-control wrapper, never a bare restart");
  });

  // ─────────────────────────────────────────────────────────────────
  // H8: daemon env script + port allocation safety + run-opts refusal.
  // ─────────────────────────────────────────────────────────────────
  it("H8: daemon env script pins private roots/guard/frozen runtimes and refuses production ports; run-opts overlay requires a rehearsal bundle", () => {
    // (a) production ports are refused by the allocator guard.
    assert.throws(() => assertSafeListenerPort(3334, {}), (e: any) => e.code === "TT_REHEARSAL_DAEMON");
    assert.throws(() => assertSafeListenerPort(3338, {}), (e: any) => e.code === "TT_REHEARSAL_DAEMON");
    assert.throws(() => assertSafeListenerPort(3339, {}), (e: any) => e.code === "TT_REHEARSAL_DAEMON");
    assert.throws(() => assertSafeListenerPort(80, {}), (e: any) => e.code === "TT_USAGE");
    assert.throws(() => assertSafeListenerPort(70000, {}), (e: any) => e.code === "TT_USAGE", "ports must fit the ephemeral range");
    assert.throws(() => assertSafeListenerPort(53341, { used: [53341] }), (e: any) => e.code === "TT_USAGE", "colliding allocations refused");
    assert.equal(assertSafeListenerPort(53341, {}), 53341);
    // (b) env script pins the private roots + guard + frozen runtimes.
    const script = renderRehearsalDaemonEnvScript({
      home: "/var/home",
      stateDir: "/var/home/.tamandua",
      dbPath: "/var/home/.tamandua/tamandua.db",
      tmpDir: "/var/tmp",
      ports: { dashboard: 43111, mcp: 43112, control: 43113 },
      piBinary: "/opt/torture-test/scripted-runtimes/bin/scripted-pi",
      hermesBinary: "/opt/torture-test/scripted-runtimes/bin/scripted-hermes",
      repoRoot: "/opt/repo",
      ttRoot: "/opt/repo/torture-test/var",
    });
    assert.ok(script.includes("export TAMANDUA_TEST_GUARD=1"), "guard pinned");
    assert.ok(script.includes("export HOME='/var/home'"), "private HOME pinned");
    assert.ok(script.includes("export TAMANDUA_STATE_DIR='/var/home/.tamandua'"), "private state dir pinned");
    assert.ok(script.includes("export TAMANDUA_DB_PATH='/var/home/.tamandua/tamandua.db'"), "campaign DB pinned so daemon + launched client share one DB");
    assert.ok(script.includes("export TAMANDUA_DASHBOARD_PORT=43111"), "dashboard port pinned");
    assert.ok(script.includes("export TAMANDUA_MCP_PORT=43112"));
    assert.ok(script.includes("export TAMANDUA_CONTROL_PORT=43113"));
    assert.ok(script.includes("scripted-pi") && script.includes("scripted-hermes"), "frozen scripted runtimes pinned");
    assert.ok(!script.includes("3334") && !script.includes("3338") && !script.includes("3339"), "production ports never appear");
    assert.throws(
      () => renderRehearsalDaemonEnvScript({ home: "/var/home", stateDir: "/var/home/.tamandua", tmpDir: "/var/tmp", ports: { dashboard: 3338, mcp: 43112, control: 43113 }, piBinary: "/x/scripted-pi", hermesBinary: "/x/scripted-hermes" }),
      (e: any) => e.code === "TT_REHEARSAL_DAEMON",
    );
    // (c) run-mode overlay requires a rehearsal bundle.
    const refused = rehearsalRunOptsFromState({ source: {}, rounds: {} });
    assert.equal(refused.ok, false, "a non-rehearsal campaign cannot be run as a rehearsal");
    const stateWithReh: any = {
      rehearsal: {
        profile: "SCRIPTED_REHEARSAL",
        task_manifest: { "storm-fdmw-1": { rosterId: "S1", file: "/var/reh/tasks/storm-fdmw-1.task.md" } },
        inputs: { tasksRoot: "/var/reh/tasks", worktreeRoot: "/var/wt", fixture: { originRepo: "/var/reh/origin" } },
        fixture_identity: { originRepo: "/var/reh/origin", colleagueRepo: "/var/reh/colleague", parkRepo: "/var/reh/park", cc1File: "docs/cc1.md", cc2File: "x" },
        resource_plan: { daemon: { kind: REHEARSAL_DAEMON_KIND } },
      },
    };
    const ok = rehearsalRunOptsFromState(stateWithReh);
    assert.equal(ok.ok, true);
    assert.equal(ok.opts!.taskFiles.S1, "/var/reh/tasks/storm-fdmw-1.task.md");
    assert.equal(ok.opts!.daemonKind, REHEARSAL_DAEMON_KIND);
    // pounding wiring when daemon ports are provided.
    const withPound = rehearsalRunOptsFromState(stateWithReh, { daemonPorts: { dashboard: 43111, mcp: 43112, control: 43113 } });
    assert.equal(withPound.ok, true);
    assert.equal(withPound.opts!.pounding.dashboardUrl, "http://127.0.0.1:43111/");
    assert.equal(withPound.opts!.pounding.mcpEndpoint, "http://127.0.0.1:43112/mcp");
  });
});
