// Tier-2 STORM-REHEARSAL US-005 (attempt-1 finding S4) — Round B fail-closed
// status persistence.
//
// Story: an abort that happens AFTER stormRunRoundB marks the round 'running'
// must leave state.rounds.B.status === 'failed' persisted on disk before the
// error propagates, exactly like stormRunRoundA's fail-closed launch branch
// (tt-storm-engine.mjs). A normal completion still ends 'round_done'.
//
// These tests drive the REAL committed stormRunRoundB through the recording
// fs/clock/proc adapters — no daemon, harness, workflow launch, model token or
// network call is ever executed. The launch stub returns a runless result so
// requireUnambiguousRunId throws TT_MISSING_RUN; a phase-evidence stub throws
// to cover a non-launch mid-round abort.
//
// Coverage (acceptance criteria of US-005):
//   T1 runless/ambiguous B launch -> state.rounds.B.status === 'failed' on
//      disk, run record launch_failed, TT_MISSING_RUN error propagates;
//   T2 a mid-round abort during phase evidence dispatch -> also 'failed';
//   T3 a successful Round B (no active runs, phases missed) -> 'round_done';
//   T4 an already-'round_done' Round B is re-attached, never re-driven.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import { stormRunRoundB } from "../bin/tt-storm-engine.mjs";

// ─────────────────────────────────────────────────────────────────────
// Compact deterministic recording adapters.
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

// A launch adapter that records args and returns a canned result. The default
// result is RUNLESS (exit 1, empty streams) — requireUnambiguousRunId throws.
function makeFakeProc(result?: any) {
  const calls: any[] = [];
  const proc: any = {
    calls,
    launchWorkflow: async (argv: string[], opts?: any) => {
      calls.push(["launch", argv, opts]);
      const r = typeof result === "function" ? result(argv, opts) : result;
      return r ?? { exitCode: 1, stdout: "", stderr: "" };
    },
  };
  return proc;
}

const CAMPAIGN_DIR = "/var/results/camp-us005-roundb";
const LAUNCH_CWD = "/var/launch-cwd";

function makeState(clock: any, launches: any[] = []) {
  const state: any = newCampaignState({
    campaignId: "camp-us005-roundb",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-005 roundb-abort self-test" },
  });
  state.plan = {
    launches,
    fixtureIdentity: {
      originRepo: "/var/fixtures/origin",
      colleagueRepo: "/var/fixtures/colleague",
      parkRepo: "/var/fixtures/park",
      cc1File: "docs/cc1.md",
      cc2File: "ts/src/store.ts",
    },
  };
  return state;
}

function makeB1Launch() {
  return {
    round: "B",
    rosterId: "B1",
    run: "storm-b1",
    workflow: "do-now",
    harness: "pi",
    timers: 1,
    demand: 1,
    queued: false,
    redBait: false,
    targetBranch: "main",
    taskArea: "do-now agitator",
    context: [],
    earliestOffsetMs: 0,
  };
}

function makeCtx({ fsx, clock, proc, opts = {} }: any) {
  return {
    fs: fsx,
    clock,
    proc,
    varRoot: "/var",
    campaignDir: CAMPAIGN_DIR,
    // A DB whose open() always fails: the observation loop/harvest treat that
    // as "no readable evidence" rather than fabricating rows.
    db: { open: () => { throw new Error("US-005 self-test: no DB adapter"); } },
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    opts: {
      launchCwd: LAUNCH_CWD,
      launchArgvFor: (launch: any) => ["tamandua", "workflow", "run", launch.workflow, "--storm-marker", launch.rosterId],
      ...opts,
    },
  };
}

function loadStateFile(fsx: any, campaignDir: string): any {
  return JSON.parse(fsx.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
}

describe("US-005 stormRunRoundB fail-closed abort status (S4)", () => {
  // ─────────────────────────────────────────────────────────────────
  // T1: the requireUnambiguousRunId launch_failed path persists 'failed'.
  // ─────────────────────────────────────────────────────────────────
  it("T1: a runless Round B launch aborts with rounds.B.status='failed' persisted before the error propagates", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const proc = makeFakeProc(); // runless result -> TT_MISSING_RUN
    const state = makeState(clock, [makeB1Launch()]);
    fsx.writeFileSync(path.join(CAMPAIGN_DIR, "state.json"), JSON.stringify(state));
    const ctx = makeCtx({ fsx, clock, proc });

    let caught: any = null;
    await assert.rejects(
      () => stormRunRoundB(ctx),
      (err: any) => {
        caught = err;
        assert.equal(err.code, "TT_MISSING_RUN", "the missing run identity is first-class");
        assert.match(String(err.message), /missing run identity for B1/);
        return true;
      },
    );

    // The failure was persisted BEFORE it propagated: re-reading state.json
    // must show a terminal 'failed' round status, never a stale 'running'.
    const after = loadStateFile(fsx, CAMPAIGN_DIR);
    assert.equal(after.rounds.B.status, "failed", "an aborted Round B persists status='failed'");
    assert.notEqual(after.rounds.B.status, "running");
    const rec = after.rounds.B.runs.B1;
    assert.ok(rec, "the B1 run record exists");
    assert.equal(rec.status, "launch_failed", "the run record is first-class launch_failed");
    assert.equal(rec.launchFailure.code, "TT_MISSING_RUN");
    assert.equal(after.mode, "run-B", "the round mode is persisted with the failure");
    assert.ok(caught, "the error was observed");
    // The launcher was actually exercised exactly once before the abort.
    assert.equal(proc.calls.filter(([k]: any) => k === "launch").length, 1);
  });

  // ─────────────────────────────────────────────────────────────────
  // T2: a non-launch mid-round abort (phase evidence dispatch) also
  // persists 'failed' — the wrapper is not launch-specific.
  // ─────────────────────────────────────────────────────────────────
  it("T2: a mid-round abort during phase dispatch also persists rounds.B.status='failed'", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const proc = makeFakeProc();
    // No roster launches so the round reaches the phase schedule; the phase
    // evidence adapter then aborts. (The first B-pounding phase has kind
    // 'none', so the throw lands on the first real evidence-gated phase.)
    const state = makeState(clock, []);
    fsx.writeFileSync(path.join(CAMPAIGN_DIR, "state.json"), JSON.stringify(state));
    const ctx = makeCtx({
      fsx, clock, proc,
      opts: {
        waitForPhaseEvidence: async () => { throw new Error("US-005 injected phase dispatch abort"); },
      },
    });

    await assert.rejects(
      () => stormRunRoundB(ctx),
      /injected phase dispatch abort/,
    );
    const after = loadStateFile(fsx, CAMPAIGN_DIR);
    assert.equal(after.rounds.B.status, "failed", "a phase-dispatch abort is persisted as failed");
  });

  // ─────────────────────────────────────────────────────────────────
  // T3: a normal completion still ends 'round_done'.
  // ─────────────────────────────────────────────────────────────────
  it("T3: a successful Round B still ends rounds.B.status='round_done'", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const proc = makeFakeProc();
    // No launches and every evidence-gated phase timed out (a legitimate
    // 'missed' outcome) -> the round completes normally.
    const state = makeState(clock, []);
    fsx.writeFileSync(path.join(CAMPAIGN_DIR, "state.json"), JSON.stringify(state));
    const ctx = makeCtx({
      fsx, clock, proc,
      opts: {
        waitForPhaseEvidence: async () => ({ satisfied: false, outcome: "timed_out", marker: null, reason: "US-005 happy path: evidence not materialized" }),
      },
    });

    const res = await stormRunRoundB(ctx);
    assert.equal(res.state.rounds.B.status, "round_done");
    const after = loadStateFile(fsx, CAMPAIGN_DIR);
    assert.equal(after.rounds.B.status, "round_done", "a completed Round B persists 'round_done'");
    assert.equal(after.harvest?.B != null, true, "harvest ran for the completed round");
  });

  // ─────────────────────────────────────────────────────────────────
  // T4: re-driving an already-completed Round B is a no-op.
  // ─────────────────────────────────────────────────────────────────
  it("T4: an already-'round_done' Round B is re-attached without a launch and stays 'round_done'", async () => {
    const fsx = makeFakeFs();
    const clock = makeFakeClock(0);
    const proc = makeFakeProc();
    const state = makeState(clock, [makeB1Launch()]);
    state.rounds.B.status = "round_done";
    fsx.writeFileSync(path.join(CAMPAIGN_DIR, "state.json"), JSON.stringify(state));
    const ctx = makeCtx({ fsx, clock, proc });

    const res = await stormRunRoundB(ctx);
    assert.equal(res.state.rounds.B.status, "round_done");
    assert.equal(proc.calls.filter(([k]: any) => k === "launch").length, 0, "a completed round is never re-launched");
    assert.equal(loadStateFile(fsx, CAMPAIGN_DIR).rounds.B.status, "round_done");
  });
});
