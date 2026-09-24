// Tier-2 STORM-REHEARSAL US-009 — tt-chaos campaign DB / run-id resolution
// and terminal-target NOT_RUN classification (SF-4).
//
// Attempt 3 recorded `tt-chaos colleague-commit exited 3 guard_miss "Run
// run-<uuid> not found in TT DB"` because the chaos channel resolved the WRONG
// database (TAMANDUA_STATE_DIR won over the exec context's TAMANDUA_DB_PATH)
// and because the engine dispatched a phase action against a target run that
// was already terminal. US-009 fixes both:
//
//   * tt-chaos resolveDbPath honors TAMANDUA_DB_PATH FIRST, then the
//     state-dir/TT_HOME derivations, and every guard lookup tolerates the
//     run-<uuid> spelling against a runs row keyed by the raw uuid;
//   * the engine resolves a phase's target run(s) BEFORE dispatch (state
//     record + campaign DB row) and records the phase NOT_RUN with the
//     terminal run named — never spawning a guaranteed guard_miss;
//   * a guard_miss that still names a terminal target is reclassified
//     NOT_RUN; a genuine dispatch error (exit 1) and a multi-target guard
//     miss with a live target keep their fire/fail semantics.
//
// This file is hermetic: recording fakes for the engine plus ONE real tt-chaos
// subprocess against a private temp TT_ROOT/git repo/DB. No daemon, scheduler,
// harness, model token or production port is ever touched.
//
// Coverage:
//   C1  tt-chaos colleague-commit guard with TAMANDUA_DB_PATH set resolves a
//       run-<uuid> target whose campaign DB row is keyed on the raw uuid
//       (GREEN), while the pre-fix order (no TAMANDUA_DB_PATH) opens the
//       state-dir DB and GUARD_MISSes (RED);
//   C2  phaseTargetRosterIds for single/multi/dirty-park/control-only actions;
//   C3  guardMissTerminalRun parses only exit-3 terminal guard misses;
//   C4  a terminal target is recorded NOT_RUN (ops + state.rounds.B.phases)
//       with the run named and ZERO tt-chaos spawns;
//   C5  a single-target guard_miss that names a terminal run is NOT_RUN;
//   C6  a live non-terminal target still fires (B-park) and a genuine
//       dispatch error (exit 1) still FAILS (B-kill) — the not_run path never
//       swallows a real failure;
//   C7  a multi-target guard_miss with one live target stays FAILED.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  guardMissTerminalRun,
  phaseTargetRosterIds,
  resolveRosterTerminal,
  stormRunRoundB,
} from "../bin/tt-storm-engine.mjs";

const repoRoot = process.cwd();
const ttChaos = path.join(repoRoot, "torture-test", "bin", "tt-chaos");

// ─────────────────────────────────────────────────────────────────────
// Real-subprocess helper for the tt-chaos guard (C1).
// ─────────────────────────────────────────────────────────────────────

function runTtChaos(args: string[], extraEnv: Record<string, string>) {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT") continue;
    if (v !== undefined) inherited[k] = v;
  }
  const result = spawnSync(ttChaos, args, {
    cwd: repoRoot,
    env: { ...inherited, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function makeRunsDb(dbPath: string, rows: Array<{ id: string; status: string }>) {
  const db = new DatabaseSync(dbPath, { open: true });
  db.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    context TEXT
  );`);
  const stmt = db.prepare("INSERT OR REPLACE INTO runs (id, run_id, status, context) VALUES (?, ?, ?, ?)");
  for (const r of rows) stmt.run(r.id, null, r.status, "{}");
  db.close();
}

function makeSeedGitRepo(root: string): string {
  const repo = path.join(root, "colleague");
  fs.mkdirSync(repo, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "tt-test",
    GIT_AUTHOR_EMAIL: "tt-test@tamandua.test",
    GIT_COMMITTER_NAME: "tt-test",
    GIT_COMMITTER_EMAIL: "tt-test@tamandua.test",
  };
  const g = (args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv, maxBuffer: 1 << 20 });
  assert.equal(g(["init", "-q", "-b", "main"]).status, 0, "git init");
  fs.writeFileSync(path.join(repo, "notes.md"), "seed\n");
  assert.equal(g(["add", "notes.md"]).status, 0, "git add");
  assert.equal(g(["commit", "-q", "-m", "seed"]).status, 0, "git commit");
  return repo;
}

// ─────────────────────────────────────────────────────────────────────
// Recording adapters for the engine (C4–C7).
// ─────────────────────────────────────────────────────────────────────

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
      while (d !== "/" && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); }
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

function opsLines(fsx: any, campaignDir: string): any[] {
  const p = `${campaignDir}/ops.jsonl`;
  if (!fsx.existsSync(p)) return [];
  return fsx.readFileSync(p).split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
}

const RUNS = {
  B1: "run-b1aaaaaa-0000-4000-8000-000000000001",
  B2: "run-b2aaaaaa-0000-4000-8000-000000000002",
  B3: "run-b3aaaaaa-0000-4000-8000-000000000003",
  B4: "run-b4aaaaaa-0000-4000-8000-000000000004",
  B5: "run-b5aaaaaa-0000-4000-8000-000000000005",
};

const CC1_FILE = "docs/cc1.md";
const CC2_FILE = "client-store.ts";

// B1 is terminal before the B-cc1 phase (15 min); B2..B5 stay live long
// enough for the live-target phases, then terminal at 120 min so the round's
// observation loop converges.
function bDefs() {
  return [
    { runId: RUNS.B1, terminalAt: 5 * 60_000, terminalStatus: "completed" },
    { runId: RUNS.B2, terminalAt: 120 * 60_000, terminalStatus: "completed" },
    { runId: RUNS.B3, terminalAt: 120 * 60_000, terminalStatus: "completed" },
    { runId: RUNS.B4, terminalAt: 120 * 60_000, terminalStatus: "completed" },
    { runId: RUNS.B5, terminalAt: 120 * 60_000, terminalStatus: "completed" },
  ];
}

function makeFakeDb({ defs, clock }: { defs: any[]; clock: any }) {
  const byId = new Map(defs.map((d: any) => [d.runId, d]));
  return {
    open: () => ({
      ok: true,
      api: {
        getRun: (runId: string) => {
          const d: any = byId.get(runId);
          if (!d) return undefined;
          const status = clock.nowMs() >= d.terminalAt ? (d.terminalStatus ?? "completed") : "running";
          return { id: runId, status };
        },
        listRuns: () => [],
        activeStepsForRuns: () => [],
        activeTimerCount: () => [],
        close: () => {},
      },
    }),
  };
}

function makeFakeProc(chaosImpl: (argv: string[]) => any) {
  const calls: any[] = [];
  const proc: any = {
    calls,
    launchWorkflow: async (argv: string[]) => { calls.push(["launch", argv]); return { exitCode: 0, stdout: "", stderr: "" }; },
    tamandua: async (argv: string[]) => { calls.push(["tamandua", argv]); return { exitCode: 0, stdout: "", stderr: "" }; },
    chaosAction: async (argv: string[]) => { calls.push(["chaos", argv]); return chaosImpl(argv); },
    daemonControl: async (argv: string[]) => { calls.push(["daemon", argv]); return { exitCode: 0, stdout: "", stderr: "" }; },
  };
  return proc;
}

const CAMPAIGN_DIR = "/var/results/camp-us009-chaos";

function makeBState(clock: any) {
  const state: any = newCampaignState({
    campaignId: "camp-us009-chaos",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-009 chaos-guard self-test" },
  });
  state.plan = {
    launches: [],
    fixtureIdentity: {
      originRepo: "/var/fixtures/origin",
      colleagueRepo: "/var/fixtures/colleague",
      parkRepo: "/var/fixtures/park",
      cc1File: CC1_FILE,
      cc2File: CC2_FILE,
    },
  };
  state.rounds.B.runs = {
    B1: { rosterId: "B1", run: "storm-b1", workflow: "feature-dev-merge-worktree", runId: RUNS.B1, status: "registered" },
    B2: { rosterId: "B2", run: "storm-b2", workflow: "feature-dev-merge-worktree", runId: RUNS.B2, status: "registered" },
    B3: { rosterId: "B3", run: "storm-b3", workflow: "bug-fix-merge-worktree", runId: RUNS.B3, status: "registered" },
    B4: { rosterId: "B4", run: "storm-b4", workflow: "bug-fix-merge-worktree", runId: RUNS.B4, status: "registered" },
    B5: { rosterId: "B5", run: "storm-b5", workflow: "do-now", runId: RUNS.B5, status: "registered" },
  };
  return state;
}

function makeEngineCtx({ fsx, clock, proc }: any) {
  return {
    fs: fsx,
    clock,
    proc,
    varRoot: "/var",
    campaignDir: CAMPAIGN_DIR,
    db: makeFakeDb({ defs: bDefs(), clock }),
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    opts: {
      launchCwd: "/var/launch-cwd",
      launchArgvFor: (launch: any) => ["tamandua", "workflow", "run", launch.workflow, "--storm-marker", launch.rosterId],
      waitForPhaseEvidence: async (_c: any, _s: any, ph: any) => ({
        satisfied: true,
        outcome: "marker_satisfied",
        marker: ph.waitFor?.marker ?? ph.waitFor?.kind,
      }),
    },
  };
}

// The chaos operator fake: B-cc2 (B3, live in the DB) reports the target
// terminal via a guard_miss (the single-target fallback path); B-rugpull's
// colleague commit is handed B1's (terminal) run id while B2..B4 are live
// (multi-target fallback must NOT swallow it); kill-harness fails hard
// (exit 1) — a genuine dispatch error on a live target.
function chaosImpl(argv: string[]) {
  const runIdx = argv.indexOf("--run");
  const runId = runIdx >= 0 ? argv[runIdx + 1] : null;
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : null;
  if (argv[1] === "colleague-commit" && file === CC2_FILE) {
    return { exitCode: 3, stdout: "", stderr: `GUARD_MISS: Run ${RUNS.B3} is terminal (completed) — refusing to fire` };
  }
  if (argv[1] === "colleague-commit" && runId === RUNS.B1 && file === CC1_FILE) {
    return { exitCode: 3, stdout: "", stderr: `GUARD_MISS: Run ${RUNS.B1} is terminal (completed) — refusing to fire` };
  }
  if (argv.includes("kill-harness")) {
    return { exitCode: 1, stdout: "", stderr: "boom: kill-harness dispatch failed" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

// ─────────────────────────────────────────────────────────────────────

describe("US-009 tt-chaos campaign DB / run-id resolution + terminal-target NOT_RUN (SF-4)", () => {
  it("C1: colleague-commit guard resolves TAMANDUA_DB_PATH with a run-<uuid> target keyed on the raw uuid (green), and misses without it (red)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-chaos-guard-"));
    try {
      const uuid = "12345678-1234-4abc-8def-1234567890ab";
      const fullRunId = `run-${uuid}`;
      const repo = makeSeedGitRepo(root);
      const campaignDb = path.join(root, "campaign.db");
      makeRunsDb(campaignDb, [{ id: uuid, status: "running" }]);
      // The state-dir DB is the WRONG DB (the pre-fix resolution order): the
      // run is absent there, so only TAMANDUA_DB_PATH can satisfy the guard.
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      makeRunsDb(path.join(stateDir, "tamandua.db"), []);
      const baseEnv = { TAMANDUA_STATE_DIR: stateDir, TT_HOME: stateDir, TT_ROOT: root };

      const green = runTtChaos(
        ["colleague-commit", "--repo", repo, "--file", "notes.md", "--run", fullRunId, "--when", "now"],
        { ...baseEnv, TAMANDUA_DB_PATH: campaignDb },
      );
      assert.equal(green.status, 0, `colleague-commit must fire when TAMANDUA_DB_PATH carries the raw-uuid row: ${green.stderr}`);
      const count = spawnSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
      assert.equal(String(count.stdout).trim(), "2", "colleague-commit landed a second commit in the owned repo");

      const red = runTtChaos(
        ["colleague-commit", "--repo", repo, "--file", "notes.md", "--run", fullRunId, "--when", "now"],
        baseEnv,
      );
      assert.equal(red.status, 3, `without TAMANDUA_DB_PATH the state-dir DB must miss the run: ${red.stderr}`);
      assert.match(red.stderr, /GUARD_MISS: Run run-12345678-1234-4abc-8def-1234567890ab not found in TT DB/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("C2: phaseTargetRosterIds resolves single, multi, dirty-park and control-only actions", () => {
    assert.deepEqual(phaseTargetRosterIds({ kind: "colleague_commit", target: "B1" }), ["B1"]);
    assert.deepEqual(phaseTargetRosterIds({ kind: "mass_rugpull", targets: ["B1", "B2", "B3", "B4"] }), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phaseTargetRosterIds({ kind: "dirty_tree_park" }), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phaseTargetRosterIds({ kind: "read_path_pounding" }), []);
    assert.deepEqual(phaseTargetRosterIds({ kind: "nudge_storm", count: 20 }), []);
    assert.deepEqual(phaseTargetRosterIds({ kind: "daemon_bounce" }), []);
  });

  it("C3: guardMissTerminalRun parses only exit-3 terminal guard misses", () => {
    assert.equal(guardMissTerminalRun({ exitCode: 1, stderr: "GUARD_MISS: Run run-x is terminal (completed)" }), null);
    assert.equal(guardMissTerminalRun({ exitCode: 3, stderr: "GUARD_MISS: Run run-x not found in TT DB" }), null);
    const named = guardMissTerminalRun({ exitCode: 3, stderr: "GUARD_MISS: Run run-x is terminal (completed) — refusing to fire" });
    assert.deepEqual(named, { runId: "run-x", status: "completed" });
  });

  it("C4/C5/C6/C7: terminal targets are NOT_RUN with no spawn; live targets keep fire/fail semantics", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const proc = makeFakeProc(chaosImpl);
    const state = makeBState(clock);
    fsx.writeFileSync(`${CAMPAIGN_DIR}/state.json`, JSON.stringify(state));
    const ctx = makeEngineCtx({ fsx, clock, proc });

    const res = await stormRunRoundB(ctx);
    const st = res.state;
    const ops = opsLines(fsx, CAMPAIGN_DIR);

    // ── C4: B-cc1 targets B1, terminal in the DB before the 15-min phase. ──
    assert.equal(st.rounds.B.phases["B-cc1"].status, "not_run", "terminal target phase is NOT_RUN");
    assert.match(String(st.rounds.B.phases["B-cc1"].notRunReason), new RegExp(RUNS.B1), "the reason names the terminal run");
    assert.ok(ops.some((o) => o.kind === "phase.not_run" && o.id === "B-cc1"), "phase.not_run recorded in ops.jsonl");
    assert.ok(ops.some((o) => o.kind === "phase.not_run_terminal" && o.id === "B-cc1"), "the terminal pre-check is recorded first-class");
    assert.ok(!ops.some((o) => o.kind === "phase.dispatched" && o.id === "B-cc1"), "NO tt-chaos process was spawned for the terminal target");

    // ── C5: B-cc2 targets B3 (LIVE in the DB) but the operator itself ──
    // reports the target terminal; the guard_miss fallback reclassifies it.
    assert.equal(st.rounds.B.phases["B-cc2"].status, "not_run", "a terminal guard_miss is NOT_RUN, not a failed phase");
    assert.match(String(st.rounds.B.phases["B-cc2"].notRunReason), new RegExp(RUNS.B3));
    assert.ok(ops.some((o) => o.kind === "phase.guard_miss_terminal" && o.id === "B-cc2"), "the guard_miss reclassification is recorded");

    // ── C6a: B-park targets the LIVE merge targets B1-B4 -> dirty-tree fires
    // (B1 is terminal but B2-B4 are live, so the shared target is still live). ──
    assert.equal(st.rounds.B.phases["B-park"].status, "fired", "a live non-terminal target still fires");
    // ── C6b: B-kill targets the LIVE B4 -> kill-harness exit 1 stays FAILED. ──
    assert.equal(st.rounds.B.phases["B-kill"].status, "failed", "a genuine dispatch error is never swallowed as not_run");

    // ── C7: B-rugpull lists B1..B4; B1 is terminal but B2..B4 are live, so ──
    // the multi-target guard_miss must NOT collapse to not_run.
    assert.equal(st.rounds.B.phases["B-rugpull"].status, "failed", "one live multi-target run keeps the failure semantics");
    assert.ok(ops.some((o) => o.kind === "phase.fired" && o.id === "B-kill" && o.ok === false), "B-kill's failure is a first-class ops record");

    // The live-target chaos phases actually reached the operator channel.
    const chaosCalls = proc.calls.filter(([k]: any) => k === "chaos");
    assert.ok(chaosCalls.length >= 2, `live chaos phases did reach the operator: ${JSON.stringify(chaosCalls.map((c: any) => c[1][1]))}`);
  });

  it("C8: resolveRosterTerminal reads the DB row while the state record is still 'registered'", () => {
    const clock = makeFakeClock(0);
    const state = makeBState(clock);
    const ctx = makeEngineCtx({ fsx: makeFakeFs(), clock, proc: makeFakeProc(chaosImpl) });
    // At t=0 B1's DB row is still running.
    assert.equal(resolveRosterTerminal(ctx, state, "B1").terminal, false);
    // Past its terminalAt the DB row is terminal even though state says
    // 'registered' (the observation loop has not harvested yet).
    clock.advance(6 * 60_000);
    const verdict = resolveRosterTerminal(ctx, state, "B1");
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.source, "db");
    assert.equal(verdict.status, "completed");
    assert.match(verdict.reason, new RegExp(RUNS.B1));
  });
});
