// Tier-2 STORM-W5 recording-only conformance gate (STORM-W5 ONE designated
// in-run gate). Beads tamandua-6sy.6.2.
//
// What this gate is:
//   * A single, focused, RECORDING-ONLY conformance file auto-discovered by
//     self-tests/run.sh's existing fast `tier2-*.test.ts` glob. It is NOT a
//     heavy campaign test and is NOT registered in any HEAVY_CAMPAIGN_TESTS
//     lock-step list. It drives the ACTUAL COMMITTED storm orchestrator
//     decision code (torture-test/bin/tt-storm-engine.mjs,
//     tt-storm-shared.mjs, tt-storm-roster.mjs) — imported directly, exactly
//     like the tier2-contention-slice self-tests import
//     tt-contention-slice-shared.mjs — under injected
//     filesystem/process/CLI/clock/API adapters and synthetic records.
//   * Every side effect is observed as a RECORDED planned argv/API call on
//     the injected adapters (and the campaign's ops.jsonl); assertions are
//     made from those recordings and from the resulting state/report —
//     never from a parallel pretend scheduler.
//   * No real chaos, process control, daemon, DB, or filesystem-destructive
//     execution occurs: the fs is an in-memory map, the clock is synthetic
//     (all schedule timing is simulated and labeled), the DB is an in-memory
//     synthetic record set, and the proc adapters only record argv. The
//     isolation guard stays ENABLED (node:test sets NODE_TEST_CONTEXT; this
//     file never clears it and never touches live ~/.tamandua state).
//   * The full real single-daemon scripted rehearsal and the real campaign
//     are explicitly the NEXT acceptance gate — no recording test satisfies
//     them, and nothing here claims they ran.
//
// Matrix covered (STORM-W5 gate contract):
//   1. both complete rounds (full choreography, simulated timing);
//   2. queue early-admit/queued decision correctness (snapshot-based);
//   3. interrupted controller reattachment (no duplicate launches);
//   4. unknown run identity (missing/ambiguous -> TT_MISSING_RUN /
//      TT_AMBIGUOUS_RUN before any launch effect);
//   5. runless failed launch (first-class failure, never silently retried);
//   6. target-reuse / foreign / symlink-root refusal BEFORE effects;
//   7. phase miss (recorded MISSED, action not dispatched);
//   8. missed simultaneity (observed peak reported honestly);
//   9. quota/cap abort + S10 ten-minute drain bound;
//  10. red report + first-class missing/inconclusive/NOT_RUN states;
//  11. all owned-cleanup phases + cleanup failure propagation.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveTimerCounts,
  parseWorkflowAgents,
  computeActiveTimerCap,
} from "../bin/tt-storm-roster.mjs";
import {
  admissionDecision,
  deriveStormNumbers,
  extractRunEvidence,
} from "../bin/tt-storm-shared.mjs";
import {
  buildStormReport,
  cleanupOwned,
  simultaneityVerdict,
  stormPrepare,
  stormReport,
  stormReportFull,
  stormResume,
  stormRunRoundA,
  stormRunRoundB,
  launchArgvFor as engineLaunchArgvFor,
  fixtureIdentity,
  buildChaosArgv,
  poundIfDue,
  enablePounding,
  ensurePoundingState,
} from "../bin/tt-storm-engine.mjs";
const repoRoot = process.cwd();
const cli = path.join(repoRoot, "torture-test", "bin", "tt-storm");

// ─────────────────────────────────────────────────────────────────────
// Deterministic synthetic identities
// ─────────────────────────────────────────────────────────────────────

function hexFor(tag) {
  return createHash("sha256").update(String(tag)).digest("hex");
}

export function makeRunId(tag) {
  const h = hexFor(`storm-gate:${tag}`).slice(0, 32);
  return `run-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Workflow YAMLs whose agent counts match the current actual catalog
// (fdmw=7, bfmw=8, security-audit-mw=8, quarantine-mw=4, drdv=3, do-now=1).
function workflowYaml(agents) {
  const body = agents
    .map((a, i) => `  - id: step${i}\n    agent: ${a}\n`)
    .join("");
  return `workflow:\n  id: wf\nagents:\n${agents.map((a) => `  - id: ${a}`).join("\n")}\nsteps:\n${body}`;
}

export const SYNTH_CATALOG = {
  "workflows/feature-dev-merge-worktree/workflow.yml": workflowYaml(["planner", "setup", "developer", "verifier", "tester", "reviewer", "merger"]),
  "workflows/bug-fix-merge-worktree/workflow.yml": workflowYaml(["triager", "investigator", "setup", "fixer", "auditor", "verifier", "reviewer", "merger"]),
  "workflows/security-audit-merge-worktree/workflow.yml": workflowYaml(["scanner", "prioritizer", "setup", "fixer", "verifier", "tester", "reviewer", "merger"]),
  "workflows/quarantine-broken-tests-merge-worktree/workflow.yml": workflowYaml(["setup", "quarantiner", "verifier", "merger"]),
  "workflows/do-review-do-verify/workflow.yml": workflowYaml(["doer", "reviewer", "verifier"]),
  "workflows/do-now/workflow.yml": workflowYaml(["doer"]),
};

// ─────────────────────────────────────────────────────────────────────
// In-memory fs adapter (recording). All keys are literal paths; nothing
// touches the real filesystem.
// ─────────────────────────────────────────────────────────────────────

export function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [path.normalize(k), String(v)]));
  const dirs = new Set(["/", "/var", "/var/results"]);
  const realpathOverrides = new Map(); // ancestor path -> real target (symlink escape simulation)
  const ops = [];
  const fsx = {
    files, dirs, realpathOverrides, ops,
    existsSync: (p) => {
      const k = path.normalize(String(p));
      // Exact existence only (file key or recorded directory). Ancestry is
      // NOT existence: containment probes walk ancestors explicitly.
      return files.has(k) || dirs.has(k);
    },
    readFileSync: (p) => {
      const k = path.normalize(String(p));
      const v = files.get(k);
      if (v === undefined) throw new Error(`FakeFS: no such file ${k}`);
      return v;
    },
    readFile: async (p) => fsx.readFileSync(p),
    writeFileSync: (p, data) => {
      const k = path.normalize(String(p));
      ops.push(["write", k]);
      files.set(k, String(data));
      let d = path.dirname(k);
      while (d !== "/" && d !== "." && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    appendFileSync: (p, data) => {
      const k = path.normalize(String(p));
      ops.push(["append", k]);
      files.set(k, (files.get(k) ?? "") + String(data));
      let d = path.dirname(k);
      while (d !== "/" && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    mkdirSync: (p) => {
      const k = path.normalize(String(p));
      ops.push(["mkdir", k]);
      let d = k;
      while (d !== "/") { dirs.add(d); d = path.dirname(d); }
      dirs.add("/");
    },
    renameSync: (a, b) => {
      const ka = path.normalize(String(a));
      const kb = path.normalize(String(b));
      ops.push(["rename", ka, kb]);
      if (!files.has(ka)) throw new Error(`FakeFS: rename source missing ${ka}`);
      files.set(kb, files.get(ka));
      files.delete(ka);
    },
    realpathSync: (p) => {
      const k = path.normalize(String(p));
      for (const [anc, target] of realpathOverrides) {
        if (k === path.normalize(anc) || k.startsWith(path.normalize(anc) + "/")) {
          return path.normalize(target + k.slice(path.normalize(anc).length));
        }
      }
      return k;
    },
    statSync: (p) => ({ isDirectory: () => true }),
    lstatSync: (p) => fsx.statSync(p),
    readdirSync: () => [],
    resolve: (p) => path.normalize(String(p)),
    snapshot: () => Object.fromEntries(files),
  };
  return fsx;
}

// ─────────────────────────────────────────────────────────────────────
// Synthetic clock (all schedule timing simulated — clearly labeled).
// ─────────────────────────────────────────────────────────────────────

export function makeFakeClock(startMs = 0) {
  let ms = startMs;
  const sleeps = [];
  const clock = {
    sleeps,
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    sleep: async (n, reason) => {
      sleeps.push({ n, reason });
      ms += n;
    },
    advance: (n) => { ms += n; },
  };
  return clock;
}

// ─────────────────────────────────────────────────────────────────────
// Synthetic campaign DB: run/step rows computed from lifecycle defs at
// query time (the "real" read seam the engine opens read-only).
// ─────────────────────────────────────────────────────────────────────

export function makeFakeDb({ defs = [], children = [], clock }) {
  const defById = new Map(defs.map((d) => [d.runId, d]));
  const childrenList = [...children];
  const open = () => {
    const t = () => clock.nowMs();
    const rowOf = (def) => {
      const now = t();
      const status = now >= def.terminalAt ? (def.terminalStatus ?? "completed") : "running";
      const scheduling_status =
        def.schedulingError ? (status === "failed" ? null : "queued")
        : def.queuedUntil == null ? (status === "running" ? null : null)
        : now < def.queuedUntil ? "queued" : null;
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
        listRuns: () => [
          ...defs.map((d) => ({ ...rowOf(d), context: "{}" })),
          ...childrenList.map((c) => ({ ...c, context: c.context ?? "{}" })),
        ],
        getRun: (runId) => {
          const def = defById.get(runId);
          if (!def) return undefined;
          return rowOf(def);
        },
        activeStepsForRuns: (runIds) => {
          const now = t();
          const out = [];
          for (const id of runIds) {
            const def = defById.get(id);
            if (!def) continue;
            if (now >= (def.claimedFrom ?? 0) && now < (def.claimedTo ?? Infinity) && now < def.terminalAt) {
              out.push({ run_id: id, status: "running", n: 1 });
            }
          }
          return out;
        },
        activeTimerCount: () => [],
        close: () => {},
      },
    };
  };
  return { open };
}

// ─────────────────────────────────────────────────────────────────────
// Recording proc adapters. Every call is appended to `calls` — the gate
// asserts on the recorded planned argv, not a pretend scheduler.
// ─────────────────────────────────────────────────────────────────────

export function makeFakeProc({ launcher, chaos, tamandua, daemon, http, mcp }) {
  const calls = [];
  const proc = {
    calls,
    launchWorkflow: async (argv, opts) => {
      calls.push(["launch", argv, opts]);
      const fn = launcher ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      return fn(argv, opts);
    },
    tamandua: async (argv, opts) => {
      calls.push(["tamandua", argv, opts]);
      const fn = tamandua ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      return fn(argv, opts);
    },
    chaosAction: async (argv, opts) => {
      calls.push(["chaos", argv, opts]);
      const fn = chaos ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      return fn(argv, opts);
    },
    daemonControl: async (argv, opts) => {
      calls.push(["daemon", argv, opts]);
      const fn = daemon ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      return fn(argv, opts);
    },
    // Read-path pounding transport: the engine drives the 30s cadence and
    // latency/no-5xx assertions through these adapters. The gate records the
    // probe and returns canned results (override to inject 5xx/slow probes).
    httpGet: async (url, opts) => {
      calls.push(["http", url, opts]);
      const fn = http ?? (async () => ({ ok: true, statusCode: 200, latencyMs: 40 }));
      return fn(url, opts);
    },
    mcpTool: async (req, opts) => {
      calls.push(["mcp", req, opts]);
      const fn = mcp ?? (async () => ({ ok: true, latencyMs: 40 }));
      return fn(req, opts);
    },
    kill: async (pid, signal) => {
      calls.push(["kill", pid, signal]);
      return { ok: true, pid, signal };
    },
  };
  return proc;
}

export function launchOutcome(runId) {
  const short = runId.slice(4, 12);
  const num = (parseInt(hexFor(runId).slice(0, 6), 16) % 900) + 1;
  return {
    exitCode: 0,
    stdout: `Run: ${runId}\nWorkflow: wf\nTask: t\n`,
    stderr: `run #${num} (${short}) created; preparing workspace...\n`,
  };
}

// Default launcher: canned per roster marker (argv last arg) via world.
function defaultLauncher(world) {
  return async (argv) => {
    const markerIdx = argv.indexOf("--storm-marker");
    const rosterId = markerIdx >= 0 ? argv[markerIdx + 1] : null;
    const runId = world.runIdOf(rosterId);
    const canned = world.launchCanned[rosterId] ?? {};
    if (canned.raw) return { ...canned.raw };
    return {
      ...launchOutcome(runId),
      ...(canned.admission ? { admission: canned.admission } : {}),
    };
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scenario world: a synthetic Round A/B record set + canned admissions.
// ─────────────────────────────────────────────────────────────────────

export function stormWorkflows() {
  return {
    S1: "feature-dev-merge-worktree",
    S2: "feature-dev-merge-worktree",
    S3: "feature-dev-merge-worktree",
    S4: "bug-fix-merge-worktree",
    S5: "bug-fix-merge-worktree",
    S6: "security-audit-merge-worktree",
    S7: "quarantine-broken-tests-merge-worktree",
    S8: "do-review-do-verify",
    S9: "feature-dev-merge-worktree",
    S10: "do-now",
    B1: "feature-dev-merge-worktree",
    B2: "feature-dev-merge-worktree",
    B3: "bug-fix-merge-worktree",
    B4: "bug-fix-merge-worktree",
    B5: "do-now",
  };
}

export function makeWorld({ overrides = {}, clock }) {
  const wf = stormWorkflows();
  const runIdOf = (rosterId) => makeRunId(rosterId);
  const world = {
    clock,
    runIdOf,
    launchCanned: {},
    defs: [],
    children: [],
    ...overrides,
  };
  return world;
}

// Build ctx (adapter bundle) for the engine from a world + fs.
export function makeCtx({ fs, clock, proc, db, varRoot = "/var", campaignDir = null, opts = {} }) {
  return {
    fs,
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
      // Orchestrator-owned fixture identity (STORM-W5 requirement 1): the
      // Round B operator's repo/file identities the engine must own. The
      // gate asserts colleague-commit argv carries --repo/--file and
      // dirty-tree argv carries --repo from THIS identity — never empty.
      fixtureIdentity: {
        colleagueRepo: "/var/fixtures/tt-poly/colleague",
        cc1File: "docs/colleague-note.md",
        cc2File: "ts/src/store.ts",
        parkRepo: "/var/fixtures/tt-poly/origin",
        originRepo: "/var/fixtures/tt-poly/origin",
        seedRef: "seed/storm",
      },
      ...opts,
    },
  };
}

// Standard pounding config + healthy adapters: enables the engine's REAL
// read-path pounding loop (30s cadence, latency bound 2s). Tests override
// `http`/`mcp` adapter results to inject 5xx / slow-latency probes.
export function poundingOpts() {
  return {
    pounding: {
      dashboardUrl: "http://127.0.0.1:9/dash/",
      mcpToolNames: ["tamandua.runs.list", "tamandua.run.status"],
      cadenceMs: 30_000,
      latencyBoundMs: 2_000,
    },
  };
}

// Standard Round A lifecycle: S1..S8 claimed mid-flight then terminal;
// S9/S10 queued until S1 frees capacity. Times in ms from round start.
export function roundADefaults({ queuedUntilS9 = 62 * 60_000, queuedUntilS10 = 62 * 60_000 + 15_000, terminalTimes = null, claimedTo = 60 * 60_000, s9terminal = 65 * 60_000, s10terminal = 65 * 60_000 + 15_000 } = {}) {
  const T = terminalTimes ?? {
    S1: 62 * 60_000, S2: 63 * 60_000, S3: 64 * 60_000, S4: 65 * 60_000,
    S5: 66 * 60_000, S6: 67 * 60_000, S7: 68 * 60_000, S8: 69 * 60_000,
  };
  const defs = [];
  for (const rid of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) {
    defs.push({
      runId: makeRunId(rid), rosterId: rid, workflow: stormWorkflows()[rid],
      claimedFrom: 5 * 60_000, claimedTo, terminalAt: T[rid], terminalStatus: "completed",
      createdAt: 0,
    });
  }
  defs.push({
    runId: makeRunId("S9"), rosterId: "S9", workflow: stormWorkflows().S9,
    claimedFrom: queuedUntilS9 + 5_000, claimedTo: s9terminal - 5_000,
    terminalAt: s9terminal, terminalStatus: "completed", queuedUntil: queuedUntilS9, createdAt: 0,
  });
  defs.push({
    runId: makeRunId("S10"), rosterId: "S10", workflow: stormWorkflows().S10,
    claimedFrom: queuedUntilS10 + 5_000, claimedTo: s10terminal - 5_000,
    terminalAt: s10terminal, terminalStatus: "completed", queuedUntil: queuedUntilS10, createdAt: 0,
  });
  return defs;
}

// Round B defaults: B1..B5 claimed from launch, terminal at ~200min.
export function roundBDefaults({ terminalTimes = null, claimedTo = 195 * 60_000 } = {}) {
  const T = terminalTimes ?? {
    B1: 200 * 60_000, B2: 201 * 60_000, B3: 202 * 60_000, B4: 203 * 60_000, B5: 204 * 60_000,
  };
  return ["B1", "B2", "B3", "B4", "B5"].map((rid) => ({
    runId: makeRunId(rid), rosterId: rid, workflow: stormWorkflows()[rid],
    claimedFrom: 3 * 60_000, claimedTo, terminalAt: T[rid], terminalStatus: "completed",
    createdAt: 0,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Phase evidence control: by default every phase's waitFor is satisfied
// immediately (simulated phase evidence); a test can veto specific phase
// ids to exercise phase-miss.
// ─────────────────────────────────────────────────────────────────────
export function phaseEvidenceControl(veto = new Set()) {
  return {
    veto,
    async waitForPhaseEvidence(ctx, state, ph) {
      if (veto.has(ph.id)) {
        return { satisfied: false, outcome: "timed_out", marker: ph.waitFor?.marker ?? ph.waitFor?.kind, reason: `simulated evidence never materialized for ${ph.id}` };
      }
      return { satisfied: true, outcome: "marker_satisfied", marker: ph.waitFor?.marker ?? ph.waitFor?.kind };
    },
  };
}

// Standard argv builder: a deterministic, reviewable launch argv that also
// carries the roster marker the fake launcher keys on.
export function launchArgvFor(launch) {
  const argv = [
    "tamandua", "workflow", "run", launch.workflow,
    "--task-file", `${launch.run}.task.md`,
    launch.harness === "hermes" ? "--hermes-as-harness" : "--pi-as-harness",
    "--storm-marker", launch.rosterId,
  ];
  return argv;
}

// Prepare a campaign on the fake adapters (shared by many tests).
export async function prepareCampaign({ fs = null, clock = null, campaignDir = "/var/results/camp-default", roundWindowMs = null, extraOpts = {} } = {}) {
  const theFs = fs ?? makeFakeFs({ ...SYNTH_CATALOG });
  const theClock = clock ?? makeFakeClock();
  const world = makeWorld({ clock: theClock });
  const proc = makeFakeProc({ launcher: defaultLauncher(world) });
  const ctx = makeCtx({
    fs: theFs, clock: theClock, proc,
    db: makeFakeDb({ defs: [], clock: theClock }),
    varRoot: "/var", campaignDir,
    opts: { ...extraOpts, launchArgvFor },
  });
  const res = await stormPrepare(ctx);
  return { fs: theFs, clock: theClock, world, proc, ctx, campaignDir: res.campaignDir, state: res.state, numbers: res.numbers };
}

// Scan the fake fs for the campaign's recorded ops.jsonl.
export function opsLines(fs, campaignDir) {
  const p = `${campaignDir}/ops.jsonl`;
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("tt-storm orchestrator — recording-only conformance gate", () => {
  it("G1: full choreography of both rounds (simulated timing) records real planned argv/API calls and an 8-concurrent window", async () => {
    // Round A world
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const aDefs = roundADefaults();
    const world = makeWorld({ clock });
    // S9/S10 launches: daemon-authoritative queued responses at launch time.
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: aDefs, clock });
    const campaignDir = "/var/results/camp-happy-a";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000, ...poundingOpts() } });

    const prep = await stormPrepare(ctx);
    const stateA = prep.state;
    assert.equal(stateA.source.active_cap, 52, "derived active cap must be 52 for the current actual registrations");
    assert.equal(stateA.source.queued_demand.S9, 7);
    assert.equal(stateA.source.queued_demand.S10, 1);
    // The S1..S8 stagger and S9/S10 cadence are recorded as earliest offsets.
    // S8 is the 8th non-queued run: its slot is 7*90s = 630s; S9 fires 30s
    // after S8 (660s) and S10 30s after S9 (690s) — the "immediately after
    // S8's registration" probe, NOT 8*90+30=750 (a 120s gap).
    const A = stateA.plan.launches.filter((l) => l.round === "A");
    assert.equal(A.length, 10);
    for (let i = 0; i < 8; i += 1) {
      assert.equal(A[i].earliestOffsetMs, i * 90_000, `S${i + 1} 90s stagger`);
    }
    assert.equal(A[8].earliestOffsetMs, 7 * 90_000 + 30_000, "S9 30s after S8 registration (slot 630s)");
    assert.equal(A[9].earliestOffsetMs, 7 * 90_000 + 60_000, "S10 30s after S9");
    // I6 provenance: the launch plan owns S7's quarantine context + target
    // branch + task area, and prepare records the seed ref.
    const s7 = A.find((l) => l.rosterId === "S7");
    assert.deepEqual(s7.context, ["branch=broken-tests"], "S7 quarantine context owned by the plan");
    assert.equal(s7.targetBranch, "broken-tests", "S7 never targets main");
    assert.ok(s7.taskArea, "S7 task area owned by the plan");
    assert.equal(stateA.plan.provenance.seedRef, "seed/storm");
    assert.equal(stateA.plan.provenance.originRepo, "/var/fixtures/tt-poly/origin");

    const outA = await stormRunRoundA(ctx);
    const state = outA.state;
    assert.equal(state.rounds.A.status, "round_done");

    // Launch argv actually issued (from the recorded proc adapter): 10 runs.
    const launches = proc.calls.filter(([k]) => k === "launch");
    assert.equal(launches.length, 10, "exactly ten Round A launches recorded");
    const launchedIds = launches.map(([, argv]) => argv[argv.indexOf("--storm-marker") + 1]);
    assert.deepEqual(launchedIds, ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]);
    for (const [, argv] of launches) {
      assert.equal(argv[0], "tamandua");
      assert.ok(argv.includes("--task-file"));
    }
    // ops.jsonl records intent BEFORE result for every launch.
    const ops = opsLines(fs, campaignDir);
    for (const rid of launchedIds) {
      const intents = ops.filter((o) => o.kind === "launch.intent" && o.rosterId === rid);
      const results = ops.filter((o) => o.kind === "launch.result" && o.rosterId === rid);
      assert.equal(intents.length, 1, `intent recorded once for ${rid}`);
      assert.equal(results.length, 1, `result recorded once for ${rid}`);
      assert.ok(ops.indexOf(intents[0]) < ops.indexOf(results[0]), `intent precedes result for ${rid}`);
    }
    // Default launch argv builder owns S7's quarantine context (I6): even
    // without the gate's marker override, the engine's own argv for S7
    // carries `--context branch=broken-tests`.
    {
      const noOverride = makeCtx({
        fs, clock, proc, db, varRoot: "/var", campaignDir,
        // SF-12 (fix-6): the engine's own (overlay-free) argv builder is now
        // fail-closed on the task file, so declare an absolute tasks root.
        opts: { roundWindowMs: 72 * 60_000, bundledCatalogRoot: "workflows", fixture: { name: "tt-poly", basis: "synthetic" }, taskFileRoot: "/var/rehearsal/tasks" },
      });
      const s7argv = engineLaunchArgvFor(s7, noOverride);
      assert.ok(s7argv.includes("--context") && s7argv.includes("branch=broken-tests"), "S7 argv carries --context branch=broken-tests");
    }

    // Queue admission: S9/S10 each have recorded snapshot-based attempts.
    const s9 = state.rounds.A.runs.S9;
    const s10 = state.rounds.A.runs.S10;
    assert.ok(s9.admission.length >= 2, "S9 queued at launch then admitted on drain");
    assert.equal(s9.admission[0].decision, "queue");
    assert.equal(s9.admission[0].freeSlots, 0);
    assert.equal(s9.status, "terminal");
    assert.equal(s10.status, "terminal");
    assert.ok(s10.admission.length >= 1);
    // Admitted only as capacity freed (a queue-then-admit drain, nothing lost).
    const firstAdmitS9 = s9.admission.find((a) => a.decision === "admit");
    assert.ok(firstAdmitS9, "S9 eventually admitted");

    // Simultaneity: an all-8 window was observed and the peak is 8.
    const sim = simultaneityVerdict(state);
    assert.equal(sim.eightConcurrentWindowObserved, true, `all-8 window must be observed; verdict: ${sim.verdict}`);
    assert.equal(sim.observedPeak, 8);
    assert.ok(state.sampler.samples.some((s) => s.round === "A" && s.unknown === 0 && s.perRun[makeRunId("S1")]?.claimed && s.perRun[makeRunId("S8")]?.claimed));

    // Read-path pounding ran for real in Round A (30s cadence through the
    // injected httpGet/mcpTool adapters; healthy -> zero assertion failures).
    assert.equal(state.rounds.A.pounding.active, true, "Round A pounding enabled");
    assert.ok(state.rounds.A.pounding.rounds > 0, `Round A pounding rounds recorded (${state.rounds.A.pounding.rounds})`);
    assert.ok(state.rounds.A.pounding.probes > 0, "Round A pounding probes issued");
    assert.equal(state.rounds.A.pounding.assertionFailures, 0, "no 5xx / latency-bound failures with healthy adapters");
    assert.ok(proc.calls.some(([k]) => k === "http"), "dashboard HTTP probes recorded through the adapter");
    assert.ok(proc.calls.some(([k]) => k === "mcp"), "MCP tool probes recorded through the adapter");

    // ── Round B on the same campaign (fresh world/defs/DB) ──────────
    const bClock = makeFakeClock(clock.nowMs());
    const bDefs = roundBDefaults();
    // B5 is stopped+deleted at T+90m and an IDENTICAL do-now is relaunched;
    // the relaunch run reaches terminal inside the round window.
    bDefs.push({
      runId: makeRunId("B5-relaunch"), rosterId: "B5-relaunch", workflow: "do-now",
      claimedFrom: 92 * 60_000, claimedTo: 204 * 60_000, terminalAt: 206 * 60_000, terminalStatus: "completed",
      createdAt: 90 * 60_000,
    });
    const bWorld = makeWorld({ clock: bClock });
    const bProc = makeFakeProc({ launcher: defaultLauncher(bWorld) });
    const bDb = makeFakeDb({ defs: bDefs, clock: bClock });
    const bCtx = makeCtx({ fs, clock: bClock, proc: bProc, db: bDb, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 220 * 60_000, ...poundingOpts(), ...phaseEvidenceControl() } });
    const outB = await stormRunRoundB(bCtx);
    const stateB = outB.state;
    assert.equal(stateB.rounds.B.status, "round_done");
    // Pounding continues into Round B (B-pounding phase at offset 0).
    assert.equal(stateB.rounds.B.pounding.active, true, "Round B pounding enabled");
    assert.ok(stateB.rounds.B.pounding.rounds > 0, `Round B pounding rounds recorded (${stateB.rounds.B.pounding.rounds})`);
    assert.equal(stateB.rounds.B.pounding.assertionFailures, 0, "no pounding assertion failures (healthy adapters)");
    // Round B launches: B1..B5 roster + the B5 identical do-now relaunch.
    const bLaunches = bProc.calls.filter(([k]) => k === "launch");
    assert.equal(bLaunches.length, 6, "five Round B launches + one identical do-now relaunch");
    const bLaunchMarkers = bLaunches.map(([, argv]) => argv[argv.indexOf("--storm-marker") + 1]);
    assert.deepEqual([...bLaunchMarkers].sort(), ["B1", "B2", "B3", "B4", "B5", "B5-relaunch"].sort());
    // The relaunch is ordered AFTER B5's stop/delete (the B-stopdel phase).
    const deleteIdx = bProc.calls.findIndex(([k, argv]) => k === "tamandua" && argv.join(" ").includes("workflow delete"));
    const relaunchIdx = bProc.calls.findIndex(([k, argv]) => k === "launch" && argv.join(" ").includes("--storm-marker B5-relaunch"));
    assert.ok(deleteIdx >= 0 && relaunchIdx >= 0, "delete and relaunch both recorded");
    assert.ok(relaunchIdx > deleteIdx, "identical do-now relaunch happens after B5 delete");
    // B5 deleted first-class; the relaunch completes.
    const b5rec = stateB.rounds.B.runs.B5;
    assert.equal(b5rec.terminalStatus, "deleted", "B5 reaches deleted after stop+delete");
    const b5rRec = stateB.rounds.B.runs["B5-relaunch"];
    assert.ok(b5rRec?.runId, "relaunch run id captured from both launch streams");
    assert.equal(b5rRec.relaunchOf, "B5", "relaunch records its parent B5");
    assert.equal(b5rRec.status, "terminal", "relaunched do-now observed to terminal");

    // Phase schedule: every phase fired with marker_satisfied evidence and
    // each dispatched the documented operator argv.
    const phases = stateB.rounds.B.phases;
    for (const pid of ["B-pounding", "B-cc1", "B-nudge", "B-pause", "B-resume", "B-kill", "B-park", "B-cc2", "B-stopdel", "B-rugpull", "B-bounce"]) {
      assert.equal(phases[pid]?.status, "fired", `${pid} fired`);
      assert.equal(phases[pid]?.waitOutcome?.outcome, "marker_satisfied", `${pid} had phase evidence`);
    }
    const tam = bProc.calls.filter(([k]) => k === "tamandua").map(([, argv]) => argv.join(" "));
    assert.ok(tam.some((t) => t.includes("workflow pause")), "B3 pause issued");
    assert.ok(tam.some((t) => t.includes("workflow resume")), "B3 resume issued");
    assert.ok(tam.some((t) => t.includes("workflow stop")), "B5 stop issued");
    assert.ok(tam.some((t) => t.includes("workflow delete")), "B5 delete issued");
    assert.equal(tam.filter((t) => t.includes("nudge")).length, 20, "nudge storm: exactly 20 nudges");
    const chaos = bProc.calls.filter(([k]) => k === "chaos").map(([, argv]) => argv.join(" "));
    assert.ok(chaos.some((c) => c.includes("colleague-commit")), "colleague commit dispatched via tt-chaos");
    assert.ok(chaos.some((c) => c.includes("kill-harness") && c.includes(makeRunId("B4").slice(0, 20))), "B4 harness kill targeted at recorded run id");
    assert.ok(chaos.some((c) => c.includes("dirty-tree")), "PARK dirty-tree dispatched");
    assert.ok(bProc.calls.some(([k, argv]) => k === "daemon" && argv.includes("restart")), "daemon bounce via daemon-control wrapper");
    // I1: tt-chaos operator argv conforms to the real interface — colleague
    // commits carry orchestrator-owned --repo/--file, dirty-tree --repo, and
    // nothing is dispatched with an empty repo.
    for (const c of chaos.filter((x) => x.includes("colleague-commit"))) {
      assert.ok(c.includes("--repo /var/fixtures/tt-poly/colleague"), `colleague-commit carries colleague repo: ${c}`);
      assert.ok(c.includes("--file "), `colleague-commit carries --file: ${c}`);
    }
    const dirty = chaos.find((x) => x.includes("dirty-tree"));
    assert.ok(dirty && dirty.includes("--repo /var/fixtures/tt-poly/origin") && !dirty.includes("--repo ''"), `dirty-tree --repo owned, never empty: ${dirty}`);

    // Report: red-bait B4 landed -> RED is a first-class state.
    const rep = buildStormReport(ctx, stateB);
    assert.ok(rep.states.red.some((x) => x.rosterId === "B4"), "B4 red-bait landing is reported RED");
    assert.equal(rep.rounds.B.runs.find((r) => r.rosterId === "B4").terminalStatus, "completed");
    // Full report finalization works end-to-end (owned cleanup ok).
    const full = await stormReportFull({ ...bCtx, campaignDir });
    assert.ok(full.txt.includes(`Storm campaign: ${stateB.campaign_id}`));
  });

  it("G2: queue admission decision correctness is snapshot-based — a correct EARLY admit is a pass, not a forced-queue failure", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    // S1 completes very early (before S9's launch at ~13min), freeing 7
    // timers: the daemon's register response at S9 launch time is ACTIVE.
    const aDefs = roundADefaults({ terminalTimes: { S1: 10 * 60_000, S2: 62 * 60_000, S3: 64 * 60_000, S4: 65 * 60_000, S5: 66 * 60_000, S6: 67 * 60_000, S7: 68 * 60_000, S8: 69 * 60_000 } });
    const world = makeWorld({ clock });
    world.launchCanned.S9 = { admission: { state: "active", requiredTimers: 7, freeSlots: 52 - 45, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: aDefs, clock });
    const campaignDir = "/var/results/camp-early-admit";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await stormRunRoundA(ctx);
    const fsState = loadStateFile(fs, campaignDir).state;
    const s9 = fsState.rounds.A.runs.S9;
    const s10 = fsState.rounds.A.runs.S10;
    // S9's launch-time admission decision is a CORRECT early admit.
    assert.equal(s9.admission[0].decision, "admit");
    assert.equal(s9.admission[0].freeSlots, 7);
    assert.equal(s9.admission[0].freeSlots >= s9.admission[0].demandedTimers, true);
    // S10 similarly correct (capacity freed after S9 admitted? S9 runs claim
    // timers, so S10 may queue; either way correctness must hold).
    for (const a of [...s9.admission, ...s10.admission]) {
      if (a.decision === "admit" || a.decision === "queue") {
        if (typeof a.freeSlots === "number") {
          assert.equal(a.decision === "admit", a.freeSlots >= a.demandedTimers, `snapshot decision correctness for ${a.rosterId}`);
        }
      }
    }
  });

  it("G3: interrupted controller reattachment — resume NEVER relaunches recorded launches", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const aDefs = roundADefaults();
    const world = makeWorld({ clock });
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: aDefs, clock });
    const campaignDir = "/var/results/camp-resume";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);

    // Simulate an interrupted controller: launch Round A but stop after S4.
    const stateRes = loadStateFile(fs, campaignDir);
    stateRes.state.rounds.A.status = "running";
    stateRes.state.mode = "run-A";
    const planA = stateRes.state.plan.launches.filter((l) => l.round === "A").slice(0, 4);
    let prevOffset = 0;
    for (const launch of planA) {
      const argv = launchArgvFor(launch);
      await clock.sleep(launch.earliestOffsetMs - prevOffset, `simulated launch stagger ${launch.rosterId}`);
      prevOffset = launch.earliestOffsetMs;
      const result = await ctx.proc.launchWorkflow(argv, {});
      const runId = makeRunId(launch.rosterId);
      assert.ok(result.stdout.includes(runId));
      stateRes.state.rounds.A.runs[launch.rosterId] = {
        rosterId: launch.rosterId, run: launch.run, workflow: launch.workflow,
        harness: launch.harness, timers: launch.timers, demand: launch.demand,
        queued: launch.queued ?? false, targetBranch: launch.targetBranch ?? "main",
        status: "registered", runId, shortId: runId.slice(4, 12),
        launchedAt: clock.nowUtc(), admission: [], children: [],
      };
    }
    saveStateFile(fs, campaignDir, stateRes.state);
    const launchesBefore = proc.calls.filter(([k]) => k === "launch").length;
    assert.equal(launchesBefore, 4);

    // New "process" resumes the campaign: re-attach + continue.
    const ctx2 = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    const resumed = await stormResume(ctx2);
    assert.equal(resumed.reattached, 4);
    // Resume must not have launched anything.
    assert.equal(proc.calls.filter(([k]) => k === "launch").length, 4, "resume never relaunches");
    const outA = await stormRunRoundA(ctx2);
    assert.equal(outA.state.rounds.A.status, "round_done");
    assert.equal(proc.calls.filter(([k]) => k === "launch").length, 10, "continued round launches only the missing six");
    // S1..S4 were registered exactly once across interrupt+resume: the
    // recorded proc shows one launch each and the continued round launches
    // only S5..S10.
    const launchMarkers = proc.calls.filter(([k]) => k === "launch").map(([, argv]) => argv[argv.indexOf("--storm-marker") + 1]);
    for (const rid of ["S1", "S2", "S3", "S4"]) {
      assert.equal(launchMarkers.filter((m) => m === rid).length, 1, `${rid} launched exactly once across interrupt+resume`);
    }
    assert.deepEqual([...launchMarkers].sort(), ["S1", "S10", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"], "all ten Round A launches exactly once");
  });

  it("G4: unknown run identity is REFUSED (missing provenance) before any launch effect is trusted", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = makeWorld({ clock });
    // S2's launcher produces streams with NO run id (killed mid-launch, no
    // stdout/stderr run lines).
    world.launchCanned.S2 = { raw: { exitCode: 0, stdout: "nothing here\n", stderr: "" } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: roundADefaults(), clock });
    const campaignDir = "/var/results/camp-unknown-id";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await assert.rejects(() => stormRunRoundA(ctx), (err) => err.code === "TT_MISSING_RUN");
    const st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.A.runs.S2.status, "launch_failed");
    assert.equal(st.rounds.A.status, "failed");
    const rep = buildStormReport(ctx, st);
    assert.ok(rep.states.missing.some((x) => x.rosterId === "S2"), "unknown-identity run is a first-class MISSING state");
  });

  it("G5: runless failed launch is first-class evidence, never silently retried", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = makeWorld({ clock });
    world.launchCanned.S3 = { raw: { exitCode: 4, stdout: "", stderr: "tamandua: boom\n" } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: roundADefaults(), clock });
    const campaignDir = "/var/results/camp-runless";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await assert.rejects(() => stormRunRoundA(ctx), (err) => err.code === "TT_MISSING_RUN");
    // One launch attempt only — a failed runless launch is never relaunched
    // on a guess.
    const s3Launches = proc.calls.filter(([, argv]) => argv[argv.indexOf("--storm-marker") + 1] === "S3");
    assert.equal(s3Launches.length, 1);
    const st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.A.runs.S3.launchFailure.exitCode, 4);
  });

  it("G6: target-reuse / foreign / symlink-root destinations are refused BEFORE any effect", async () => {
    const catalogFs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: [], clock });

    // (a) foreign destination outside var root.
    const foreign = makeCtx({ fs: catalogFs, clock, proc, db, varRoot: "/var", campaignDir: "/tmp/outside", opts: { launchArgvFor } });
    await assert.rejects(() => stormPrepare(foreign), (err) => err.code === "TT_ESCAPE");
    // (b) target reuse — an existing campaign destination.
    const reuseFs = makeFakeFs({ ...SYNTH_CATALOG });
    const reuseCtx = makeCtx({ fs: reuseFs, clock, proc, db, varRoot: "/var", campaignDir: "/var/results/existing", opts: { launchArgvFor } });
    reuseFs.writeFileSync("/var/results/existing/state.json", "{}");
    await assert.rejects(() => stormPrepare(reuseCtx), (err) => err.code === "TT_EXISTS");
    // (c) symlink-root escape — an existing ancestor under var resolves
    // outside var via a symlink.
    const linkFs = makeFakeFs({ ...SYNTH_CATALOG });
    linkFs.writeFileSync("/var/link/keep.txt", "x");
    linkFs.realpathOverrides.set("/var/link", "/esc/link");
    const linkCtx = makeCtx({ fs: linkFs, clock, proc, db, varRoot: "/var", campaignDir: "/var/link/camp", opts: { launchArgvFor } });
    await assert.rejects(() => stormPrepare(linkCtx), (err) => err.code === "TT_SYMLINK");
    // Before-effects guarantee: no campaign files were created by any refusal
    // (the reuse case legitimately already had its own state.json — that is
    // exactly why it was refused).
    for (const p of ["/tmp/outside/state.json", "/var/link/camp/state.json"]) {
      assert.equal(fsExists(foreign.fs, p) || fsExists(linkFs, p), false, `${p} must not exist`);
    }
    assert.equal(fsExists(reuseFs, "/var/results/existing/state.json"), true, "reuse fixture present (and refused)");
    // No launch was attempted in any refused scenario.
    assert.equal(proc.calls.filter(([k]) => k === "launch").length, 0);
  });

  it("G7: a phase whose evidence never materializes is recorded MISSED and its action is never dispatched", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock(10 * 60 * 60_000); // start after Round A time
    // US-009: this fixture starts the Round B clock at T+10h, so the default
    // terminalAt (~T+200m) would make every B run ALREADY terminal and every
    // target phase NOT_RUN — masking the phase-evidence behavior under test.
    // Keep the runs live through the phase window (terminal at T+13h) so the
    // fired assertion still exercises the real dispatch path.
    const bDefs = roundBDefaults({ terminalTimes: { B1: 780 * 60_000, B2: 781 * 60_000, B3: 782 * 60_000, B4: 783 * 60_000, B5: 784 * 60_000 } });
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: bDefs, clock });
    const campaignDir = "/var/results/camp-phase-miss";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 260 * 60_000 } });
    await stormPrepare(ctx);
    // veto B-park (PARK bait evidence never appears)
    const veto = phaseEvidenceControl(new Set(["B-park"]));
    const ctxV = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 260 * 60_000, waitForPhaseEvidence: veto.waitForPhaseEvidence } });
    const out = await stormRunRoundB(ctxV);
    const phases = out.state.rounds.B.phases;
    assert.equal(phases["B-park"].status, "missed");
    assert.equal(phases["B-park"].waitOutcome.outcome, "timed_out");
    assert.equal(phases["B-park"].firedAt, null);
    // dirty-tree was never dispatched.
    assert.equal(proc.calls.filter(([k, argv]) => k === "chaos" && argv.includes("dirty-tree")).length, 0);
    // Other phases still fired.
    assert.equal(phases["B-kill"].status, "fired");
    const ops = opsLines(fs, campaignDir);
    assert.ok(ops.some((o) => o.kind === "phase.missed" && o.id === "B-park"), "phase miss recorded in ops");
  });

  it("G8: missed simultaneity reports the observed peak honestly (never the configured roster)", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    // S8 completes almost immediately — before any all-8 window can exist.
    const aDefs = roundADefaults({ terminalTimes: { S1: 62 * 60_000, S2: 63 * 60_000, S3: 64 * 60_000, S4: 65 * 60_000, S5: 66 * 60_000, S6: 67 * 60_000, S7: 68 * 60_000, S8: 2 * 60_000 } });
    const world = makeWorld({ clock });
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: aDefs, clock });
    const campaignDir = "/var/results/camp-missed-sim";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await stormRunRoundA(ctx);
    const st = loadStateFile(fs, campaignDir).state;
    const sim = simultaneityVerdict(st);
    assert.equal(sim.eightConcurrentWindowObserved, false);
    assert.ok(sim.observedPeak < 8, `observed peak ${sim.observedPeak} < 8 must be recorded`);
    assert.ok(sim.verdict.includes("observed peak"), "verdict names the observed peak, not the configured roster");
  });

  it("G9: quota/cap abort and the S10 ten-minute drain bound are first-class, not hidden in 'queued'", async () => {
    // (a) quota/cap abort: the daemon register response is unschedulable.
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const defsA = roundADefaults();
    const world = makeWorld({ clock });
    world.launchCanned.S9 = { admission: { state: "error", scheduling_error: "Run requires 7 scheduler timer(s), but TAMANDUA_MAX_ACTIVE_TIMERS is 6.", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 6 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: defsA, clock });
    const campaignDir = "/var/results/camp-capabort";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await stormRunRoundA(ctx);
    const stA = loadStateFile(fs, campaignDir).state;
    assert.equal(stA.rounds.A.runs.S9.admission[0].decision, "cap_abort");
    assert.equal(stA.rounds.A.runs.S9.status, "cap_abort");
    const rep = buildStormReport(ctx, stA);
    assert.ok(rep.states.not_run.some((x) => x.rosterId === "S9" && x.status === "cap_abort"), "cap abort is a first-class NOT_RUN state");

    // (b) S10 drain bound: capacity appears once but never enough for S10,
    // and S10 exceeds the 10-minute bound from first capacity.
    const fs2 = makeFakeFs({ ...SYNTH_CATALOG });
    const clock2 = makeFakeClock();
    // S9 admits at 62min (first capacity); S10 stays queued forever after.
    const defsB = roundADefaults({ queuedUntilS9: 62 * 60_000, queuedUntilS10: Infinity, s10terminal: Infinity });
    // S1..S8 complete so S9 can admit, but never free enough for S10.
    const world2 = makeWorld({ clock: clock2 });
    world2.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world2.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    const proc2 = makeFakeProc({ launcher: defaultLauncher(world2) });
    const db2 = makeFakeDb({ defs: defsB, clock: clock2 });
    const campaignDir2 = "/var/results/camp-drain";
    const ctx2 = makeCtx({ fs: fs2, clock: clock2, proc: proc2, db: db2, varRoot: "/var", campaignDir: campaignDir2, opts: { launchArgvFor, roundWindowMs: 90 * 60_000 } });
    await stormPrepare(ctx2);
    await stormRunRoundA(ctx2);
    const stB = loadStateFile(fs2, campaignDir2).state;
    const s10r = stB.rounds.A.runs.S10;
    assert.equal(s10r.status, "drain_bound_exceeded");
    assert.ok(stB.queue.first_capacity_at, "first capacity recorded");
  });

  it("G10: red / missing / inconclusive / NOT_RUN are first-class report states, never normalized to green", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const bDefs = roundBDefaults();
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    // B4 completed as the union-red bait: status completed (red landing).
    const b4 = bDefs.find((d) => d.rosterId === "B4");
    b4.terminalStatus = "completed";
    // Add a child run discovered under B1 (rugpull replacement).
    const child = { id: makeRunId("B1-child"), workflow_id: "feature-dev-merge-worktree", status: "completed", tokens_spent: 99, parent_run_id: makeRunId("B1"), context: "{}" };
    const db = makeFakeDb({ defs: bDefs, children: [child], clock });
    const campaignDir = "/var/results/camp-red";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 260 * 60_000, ...phaseEvidenceControl() } });
    await stormPrepare(ctx);
    await stormRunRoundB(ctx);
    const st = loadStateFile(fs, campaignDir).state;
    // B4 is flagged RED (red-bait roster member landed).
    assert.equal(st.rounds.B.runs.B4.redBait, true);
    const rep = buildStormReport(ctx, st);
    assert.ok(rep.states.red.some((x) => x.rosterId === "B4"), "red landing reported under RED");
    assert.ok(rep.rounds.B.runs.find((r) => r.rosterId === "B4").terminalStatus === "completed");
    const res = await stormReport(ctx);
    assert.ok(res.txt.includes("Red/missing/inconclusive/NOT_RUN are first-class reported states"));
    assert.ok(res.txt.includes("ROUND B"), "round B in the forensic text");
    assert.ok(res.txt.includes("B4"), "B4 in the forensic text");
  });

  it("G11: owned cleanup phases are ledgered and a cleanup failure PROPAGATES (report refused)", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const db = makeFakeDb({ defs: [], clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(makeWorld({ clock })) });
    const campaignDir = "/var/results/camp-cleanup";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor } });
    const prep = await stormPrepare(ctx);

    // All phases ok -> ok:true, ledger records every phase.
    const ok = cleanupOwned(ctx, prep.state, ["p1", "p2"]);
    assert.equal(ok.ok, true);
    assert.equal(ok.ledger.length, 2);
    assert.ok(ok.ledger.every((e) => e.ok));

    // A failing phase propagates: cleanupOwned reports the failure AND
    // report finalization refuses (no report.json written).
    const ctxFail = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, cleanupHandlers: { p1: () => { throw new Error("cleanup boom"); }, p2: () => true } } });
    const st = loadStateFile(fs, campaignDir).state;
    const cl = cleanupOwned(ctxFail, st, ["p1", "p2"]);
    assert.equal(cl.ok, false);
    assert.equal(cl.failed.length, 1);
    assert.equal(cl.failed[0].phase, "p1");
    await assert.rejects(() => stormReportFull(ctxFail, { cleanupPhases: ["p1", "p2"] }), (err) => err.code === "TT_CLEANUP_FAILED");
    assert.equal(fs.existsSync(`${campaignDir}/results/report.json`), false, "report must not finalize after a failed cleanup");
  });

  it("G12: help/plan CLI surface is side-effect-free; unknown commands exit non-zero", () => {
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes("Usage: tt-storm"));
    const noargs = spawnSync(process.execPath, [cli], { encoding: "utf8" });
    assert.equal(noargs.status, 0);
    assert.ok(noargs.stdout.includes("Usage: tt-storm"));
    const bad = spawnSync(process.execPath, [cli, "frobnicate"], { encoding: "utf8" });
    assert.equal(bad.status, 4);
    const plan = spawnSync(process.execPath, [cli, "plan"], { encoding: "utf8", cwd: repoRoot });
    assert.equal(plan.status, 0);
    const planJson = JSON.parse(plan.stdout);
    assert.equal(planJson.active_cap, 52, "plan derives the current actual cap");
    assert.ok(planJson.catalog.kind === "bundled" || planJson.catalog.kind === "installed");
  });

  it("G13: deriveTimerCounts/parseWorkflowAgents/computeActiveTimerCap produce provenance-backed counts and fail closed when a registration is missing", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const numbers = await deriveStormNumbers({ fs, installedCatalogRoot: null, bundledCatalogRoot: "workflows" });
    assert.equal(numbers.cap.total, 52);
    assert.equal(numbers.counts["feature-dev-merge-worktree"].distinctStepAgents, 7);
    assert.equal(numbers.counts["bug-fix-merge-worktree"].distinctStepAgents, 8);
    assert.equal(numbers.counts["do-now"].distinctStepAgents, 1);
    assert.ok(numbers.counts["feature-dev-merge-worktree"].source.sha256, "source provenance sha recorded");
    const missingFs = makeFakeFs({});
    const missingCounts = await deriveTimerCounts({ fs: missingFs, catalogRoot: "workflows" });
    assert.throws(() => computeActiveTimerCap(missingCounts), /cannot derive timer cap/);
    // pure admissionDecision contract
    const d = admissionDecision({ cap: 52, inUseTimers: 52, demandedTimers: 7, freeSlots: 0, rosterId: "S9" });
    assert.equal(d.decision, "queue");
    const d2 = admissionDecision({ cap: 52, inUseTimers: 45, demandedTimers: 7, freeSlots: 7, rosterId: "S9" });
    assert.equal(d2.decision, "admit");
    // extractRunEvidence contract
    const ev = extractRunEvidence({ stdout: `Run: ${makeRunId("S1")}\n`, stderr: `run #1 (${makeRunId("S1").slice(4, 12)}) created; preparing workspace...`, exitCode: 0 });
    assert.equal(ev.ok, true);
    assert.equal(ev.stdoutRunId, makeRunId("S1"));
  });

  it("G14: colleague-commit/dirty-tree argv CONFORMS to the real tt-chaos interface; missing fixture identity -> phase NOT_RUN (never dispatched)", async () => {
    // (a) buildChaosArgv with owned fixture identity produces argv the real
    // tt-chaos colleague-commit (requires --repo/--file) and dirty-tree
    // (requires --repo) accept.
    const owned = makeCtx({ fs: makeFakeFs({ ...SYNTH_CATALOG }), clock: makeFakeClock(), proc: makeFakeProc({}), db: makeFakeDb({ defs: [], clock: makeFakeClock() }), varRoot: "/var", campaignDir: null });
    const stateStub = { rounds: { A: { runs: { B1: { runId: makeRunId("B1") }, B3: { runId: makeRunId("B3") }, B4: { runId: makeRunId("B4") } } }, B: { runs: {} } } };
    const cc1 = buildChaosArgv(owned, stateStub, { kind: "colleague_commit", target: "B1", fileRole: "cc1" }, makeRunId("B1"));
    assert.equal(cc1.ok, true);
    assert.ok(cc1.argv.includes("--repo") && cc1.argv.includes(owned.opts.fixtureIdentity.colleagueRepo), "colleague-commit --repo owned");
    assert.ok(cc1.argv.includes("--file") && cc1.argv.includes(owned.opts.fixtureIdentity.cc1File), "colleague-commit --file owned");
    const cc2 = buildChaosArgv(owned, stateStub, { kind: "colleague_commit", target: "B3", fileRole: "cc2" }, makeRunId("B3"));
    assert.ok(cc2.argv.includes(owned.opts.fixtureIdentity.cc2File), "cc2 file identity owned");
    const dirty = buildChaosArgv(owned, stateStub, { kind: "dirty_tree_park" }, makeRunId("B4"));
    assert.equal(dirty.ok, true);
    assert.ok(dirty.argv.includes("--repo") && dirty.argv.includes(owned.opts.fixtureIdentity.parkRepo), "dirty-tree --repo owned");

    // (b) missing repo/file identity -> {ok:false, reason} and a Round B
    // phase whose action needs it is recorded NOT_RUN — the fake operator is
    // never handed an argv with an empty --repo/--file.
    const bare = makeCtx({ fs: makeFakeFs({ ...SYNTH_CATALOG }), clock: makeFakeClock(), proc: makeFakeProc({}), db: makeFakeDb({ defs: [], clock: makeFakeClock() }), varRoot: "/var", campaignDir: null, opts: { fixtureIdentity: { colleagueRepo: null, cc1File: null, cc2File: null, parkRepo: null } } });
    const ccMissing = buildChaosArgv(bare, stateStub, { kind: "colleague_commit", target: "B1", fileRole: "cc1" }, makeRunId("B1"));
    assert.equal(ccMissing.ok, false);
    assert.ok(/colleagueRepo/.test(ccMissing.reason), `missing colleague identity named: ${ccMissing.reason}`);
    const dirtyMissing = buildChaosArgv(bare, stateStub, { kind: "dirty_tree_park" }, makeRunId("B4"));
    assert.equal(dirtyMissing.ok, false);

    // Full Round B with missing identity: colleague phases + dirty-tree are
    // NOT_RUN (recorded), nothing is dispatched to the fake operator, and
    // other phases (pause/resume/kill/nudge/bounce) still fire.
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock(12 * 60 * 60_000);
    // US-009: the Round B clock starts at T+12h; keep the runs live through
    // the phase window (terminal at T+15h) so the identity-driven NOT_RUN
    // assertions below test the missing-fixture path, not the terminal-target
    // short-circuit.
    const bDefs = roundBDefaults({ terminalTimes: { B1: 900 * 60_000, B2: 901 * 60_000, B3: 902 * 60_000, B4: 903 * 60_000, B5: 904 * 60_000 } });
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: bDefs, clock });
    const campaignDir = "/var/results/camp-no-identity";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 260 * 60_000, fixtureIdentity: { colleagueRepo: null, cc1File: null, cc2File: null, parkRepo: null, originRepo: null }, ...phaseEvidenceControl() } });
    await stormPrepare(ctx);
    await stormRunRoundB(ctx);
    const st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.B.phases["B-cc1"].status, "not_run", "colleague commit without repo/file identity is NOT_RUN");
    assert.equal(st.rounds.B.phases["B-park"].status, "not_run", "dirty-tree without --repo identity is NOT_RUN");
    assert.equal(st.rounds.B.phases["B-kill"].status, "fired", "kill-harness has no identity dependency -> fires");
    assert.equal(st.rounds.B.phases["B-pause"].status, "fired");
    assert.equal(st.rounds.B.phases["B-nudge"].status, "fired");
    assert.equal(st.rounds.B.phases["B-bounce"].status, "fired");
    const badChaos = proc.calls.filter(([k, argv]) => k === "chaos" && (argv.some((a) => a.includes("colleague-commit")) || argv.some((a) => a.includes("dirty-tree"))));
    assert.equal(badChaos.length, 0, "no colleague-commit/dirty-tree dispatched without identity");
  });

  it("G15: pounding is NOT_RUN (first-class) when no config; a failing probe (5xx / over-latency) is recorded as an assertion failure, never normalized", async () => {
    // (a) No pounding config -> Round A pounding NOT_RUN, no probe calls.
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const aDefs = roundADefaults();
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: aDefs, clock });
    const campaignDir = "/var/results/camp-no-pound";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 60 * 60_000 } }); // no pounding config
    await stormPrepare(ctx);
    await stormRunRoundA(ctx);
    const st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.A.pounding.active, false, "pounding inactive without config");
    assert.ok(st.rounds.A.pounding.notRunReason, "pounding NOT_RUN has a named reason");
    assert.equal(proc.calls.filter(([k]) => k === "http" || k === "mcp").length, 0, "no probes without config");
    const rep = buildStormReport(ctx, st);
    assert.ok(rep.states.not_run.some((x) => x.activity === "read_path_pounding"), "pounding NOT_RUN is a first-class report state");

    // (b) Pounding configured but a probe returns 5xx: assertion failure is
    // recorded (never normalized), phase/state show the failure.
    const fs2 = makeFakeFs({ ...SYNTH_CATALOG });
    const clock2 = makeFakeClock();
    const aDefs2 = roundADefaults();
    const world2 = makeWorld({ clock: clock2 });
    const proc2 = makeFakeProc({ launcher: defaultLauncher(world2), http: async () => ({ ok: false, statusCode: 503, latencyMs: 10 }) });
    const db2 = makeFakeDb({ defs: aDefs2, clock: clock2 });
    const campaignDir2 = "/var/results/camp-pound-5xx";
    const ctx2 = makeCtx({ fs: fs2, clock: clock2, proc: proc2, db: db2, varRoot: "/var", campaignDir: campaignDir2, opts: { launchArgvFor, roundWindowMs: 60 * 60_000, ...poundingOpts() } });
    await stormPrepare(ctx2);
    await stormRunRoundA(ctx2);
    const st2 = loadStateFile(fs2, campaignDir2).state;
    assert.equal(st2.rounds.A.pounding.active, true, "pounding active with config");
    assert.ok(st2.rounds.A.pounding.assertionFailures > 0, "5xx probe recorded as an assertion failure");
    assert.ok(opsLines(fs2, campaignDir2).some((o) => o.kind === "pounding.round" && o.failures > 0), "pounding.round ops record the failures");

    // (c) over-latency (>2s bound) is likewise an assertion failure.
    const fs3 = makeFakeFs({ ...SYNTH_CATALOG });
    const clock3 = makeFakeClock();
    const world3 = makeWorld({ clock: clock3 });
    const proc3 = makeFakeProc({ launcher: defaultLauncher(world3), mcp: async () => ({ ok: true, latencyMs: 5_000 }) });
    const db3 = makeFakeDb({ defs: roundADefaults(), clock: clock3 });
    const campaignDir3 = "/var/results/camp-pound-slow";
    const ctx3 = makeCtx({ fs: fs3, clock: clock3, proc: proc3, db: db3, varRoot: "/var", campaignDir: campaignDir3, opts: { launchArgvFor, roundWindowMs: 60 * 60_000, ...poundingOpts() } });
    await stormPrepare(ctx3);
    await stormRunRoundA(ctx3);
    const st3 = loadStateFile(fs3, campaignDir3).state;
    assert.ok(st3.rounds.A.pounding.assertionFailures > 0, "over-latency probe recorded as assertion failure");
  });

  it("G16: simultaneity all-8 window is NOT observed when an active-roster run has no recorded id (launch_failed/missing)", async () => {
    // Simulate a resumed Round A where S8 launch_failed (no run id) while the
    // other 7 roster runs are claimed and nothing is UNKNOWN: the verdict must
    // NOT flip to an 8-concurrent window by silently dropping S8.
    const runId = (r) => makeRunId(r);
    const mkSample = (claimedIds) => {
      const perRun = {};
      for (const rid of claimedIds) perRun[runId(rid)] = { runId: runId(rid), present: true, claimed: true, status: "running" };
      return { ts: "2026-01-01T00:00:00Z", atMs: 0, round: "A", intervalMs: 15_000, configured: 7, active: claimedIds.length, unknown: 0, perRun };
    };
    const state = {
      rounds: {
        A: {
          runs: Object.fromEntries(
            ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"].map((rid) => [
              rid,
              { rosterId: rid, run: `storm-${rid}`, workflow: "wf", harness: "pi", queued: false, runId: rid === "S8" ? null : runId(rid), status: rid === "S8" ? "launch_failed" : "admitted" },
            ]),
          ),
        },
      },
      sampler: { samples: [mkSample(["S1", "S2", "S3", "S4", "S5", "S6", "S7"])], sample_gaps: [] },
      queue: { attempts: [] },
    };
    const sim = simultaneityVerdict(state);
    assert.equal(sim.eightConcurrentWindowObserved, false, "launch_failed S8 (no id) must prevent an all-8 window");
    assert.ok(sim.rosterWithoutRunId.includes("S8"), `verdict names the id-less roster run: ${sim.rosterWithoutRunId}`);
  });

  it("G17: resume after a Round A runless launch_failed continues the remaining roster (fail-closed documented) and keeps the failure first-class", async () => {
    // G5-style failure: S3 launch is runless (exit 4, no run id) -> Round A
    // aborts fail-closed (documented decision), S3 launch_failed.
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock();
    const world = makeWorld({ clock });
    world.launchCanned.S9 = { admission: { state: "queued", requiredTimers: 7, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S10 = { admission: { state: "queued", requiredTimers: 1, freeSlots: 0, maxActiveTimers: 52 } };
    world.launchCanned.S3 = { raw: { exitCode: 4, stdout: "", stderr: "tamandua: boom\n" } };
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: roundADefaults(), clock });
    const campaignDir = "/var/results/camp-resume-launch-failed";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 72 * 60_000 } });
    await stormPrepare(ctx);
    await assert.rejects(() => stormRunRoundA(ctx), (err) => err.code === "TT_MISSING_RUN");
    let st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.A.status, "failed");
    assert.equal(st.rounds.A.runs.S3.status, "launch_failed");

    // Resume re-attaches the runs that DID register (S1/S2); then the
    // operator re-invokes run Round A: remaining planned launches (S4..S10)
    // continue, the launch_failed S3 is never relaunched, and the round
    // completes with S3 first-class in the report.
    await stormResume(ctx, { round: "A" });
    const out = await stormRunRoundA(ctx);
    st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.A.status, "round_done");
    assert.equal(st.rounds.A.runs.S3.status, "launch_failed", "S3 stays launch_failed, never relaunched");
    const markers = proc.calls.filter(([k]) => k === "launch").map(([, argv]) => argv[argv.indexOf("--storm-marker") + 1]);
    assert.equal(markers.filter((m) => m === "S3").length, 1, "S3 attempted exactly once");
    for (const rid of ["S1", "S2", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]) {
      assert.equal(markers.filter((m) => m === rid).length, 1, `${rid} launched exactly once across abort+resume+continue`);
    }
    const rep = buildStormReport(ctx, st);
    assert.ok(rep.states.missing.some((x) => x.rosterId === "S3" && x.status === "launch_failed"), "S3 remains a first-class MISSING report state");
    assert.equal(rep.rounds.A.runs.find((r) => r.rosterId === "S3").status, "launch_failed");
  });

  it("G18: B-pounding phase is NOT_RUN (not fired) when pounding is not enabled", async () => {
    const fs = makeFakeFs({ ...SYNTH_CATALOG });
    const clock = makeFakeClock(10 * 60 * 60_000);
    const bDefs = roundBDefaults();
    const world = makeWorld({ clock });
    const proc = makeFakeProc({ launcher: defaultLauncher(world) });
    const db = makeFakeDb({ defs: bDefs, clock });
    const campaignDir = "/var/results/camp-bpounding-notrun";
    const ctx = makeCtx({ fs, clock, proc, db, varRoot: "/var", campaignDir, opts: { launchArgvFor, roundWindowMs: 220 * 60_000, ...phaseEvidenceControl() } }); // no pounding config
    await stormPrepare(ctx);
    await stormRunRoundB(ctx);
    const st = loadStateFile(fs, campaignDir).state;
    assert.equal(st.rounds.B.phases["B-pounding"].status, "not_run", "B-pounding is NOT_RUN without pounding config, never a fabricated fired");
    assert.ok(opsLines(fs, campaignDir).some((o) => o.kind === "pounding.not_run"), "pounding NOT_RUN recorded in ops");
  });
});

// helpers used by this file (small, local)
function loadStateFile(fs, campaignDir) {
  const state = JSON.parse(fs.readFileSync(`${campaignDir}/state.json`));
  return { ok: true, state };
}
function saveStateFile(fs, campaignDir, state) {
  fs.writeFileSync(`${campaignDir}/state.json`, JSON.stringify(state, null, 2) + "\n");
}
function fsExists(fs, p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
