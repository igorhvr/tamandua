// Tier-2 STORM-REHEARSAL-FIX6 US-002 — SF-13: a cleanly stopped+deleted target
// is ENGINE-TERMINAL ('deleted') even when the identical relaunch sub-op
// fails, and a failed relaunch is a bounded first-class phase failure.
//
// Attempt 6 Round B (SF-13, engine:2158): stormRunRoundB marked the deleted
// target terminal only inside `if (ok && action.kind ===
// 'stop_delete_relaunch')`. When the relaunch failed (SF-12), B5 stayed
// status='registered' with its DB row gone, harvestTerminalRuns never marked
// it, and Round B waited the full 3h ROUND_B_END_MS window.
//
// This file pins the fix through the REAL dispatch path (no
// ctx.opts.dispatchPhaseAction adapter) and the real observation loop:
//   T1 stop+delete ok, relaunch exit 1 with no run identity -> B5
//      terminal/deleted + run.deleted op, phase 'failed', bounded
//      relaunchFailure code TT_MISSING_RUN, and no live relaunch record;
//   T2 stop+delete ok, relaunch exit 1 WITH a resolvable run identity -> B5
//      still terminal/deleted, relaunchFailure code TT_RELAUNCH_FAILED, and
//      the relaunch record is first-class launch_failed (never live);
//   T3 all three sub-ops exit 0 -> B5 terminal/deleted and the relaunch record
//      carries relaunchOf='B5' (the pre-existing happy path is preserved);
//   T4 a fake-clock observation loop over a round whose only live record was
//      just marked terminal returns at once (clock does not advance, the
//      campaign DB is never probed) — far below ROUND_B_END_MS and with no
//      'run row missing' wait;
//   T5 CONTRAST: the same loop with B5 still 'registered' and no DB row does
//      consume the window (the terminal verdict is what makes T4 prompt);
//   T6 every launch argv the real dispatch emits is absolute and under the
//      campaign tasks root (SF-12 regression net at the dispatch seam).
//
// In-process only: a real temp campaign dir, an injected advancing fake clock
// and recording proc adapters. No daemon, scheduler, harness, model token,
// campaign DB or production port is touched.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { newCampaignState, ROUND_B_END_MS } from "../bin/tt-storm-shared.mjs";
import { dispatchPhaseSchedule, runObservationLoop } from "../bin/tt-storm-engine.mjs";

const B5_RUN = "run-b5aaaaaa-0000-4000-8000-000000000005";
const RELAUNCH_RUN = "run-b5ae1a0c-0000-4000-8000-000000000006";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // diagnostics-only cleanup
    }
  }
});

function makeClock(startMs = 0) {
  let ms = startMs;
  const sleeps: Array<{ n: number; reason?: string }> = [];
  return {
    sleeps,
    nowMs: () => ms,
    nowUtc: () => new Date(ms).toISOString(),
    sleep: async (n: number, reason?: string) => { sleeps.push({ n, reason }); ms += n; },
    advance: (n: number) => { ms += n; },
  };
}

function makeOps() {
  const entries: any[] = [];
  return {
    entries,
    record(kind: string, detail: any = {}) {
      if (typeof kind !== "string" || kind.length === 0) throw new Error("bad op kind");
      entries.push({ kind, ...detail });
      return kind;
    },
    ofKind(kind: string) {
      return entries.filter((e) => e.kind === kind);
    },
  };
}

function launchOutcome(runId: string) {
  return {
    exitCode: 0,
    stdout: `Run: ${runId}\nWorkflow: do-now\nTask: storm-b5-donow\n`,
    stderr: `run #7 (${runId.slice(4, 12)}) created; preparing workspace...\n`,
  };
}

const STOPDEL_PHASE = {
  id: "B-stopdel",
  label: "stop + delete B5 under load, relaunch identical do-now",
  earliest_offset_ms: 0,
  waitFor: { kind: "none", marker: null },
  action: { kind: "stop_delete_relaunch", target: "B5", relaunchRun: "storm-b5-donow" },
};

function makeState(clock: any, { runStatus = "registered" }: { runStatus?: string } = {}) {
  const state: any = newCampaignState({
    campaignId: "camp-us002-stopdel-terminal",
    clock,
    source: { repo: "/var/repo", branch: "test", commit: "0".repeat(40), tree: "0".repeat(40) },
    fixture: { name: "tt-poly", basis: "US-002 stopdel-terminal self-test" },
  });
  state.plan = {
    launches: [],
    roundBPhases: [STOPDEL_PHASE],
    fixtureIdentity: {
      originRepo: "/var/fixtures/origin",
      colleagueRepo: "/var/fixtures/colleague",
      parkRepo: "/var/fixtures/park",
      cc1File: "docs/cc1.md",
      cc2File: "client-store.ts",
    },
  };
  state.rounds.B.runs = {
    B5: {
      rosterId: "B5",
      run: "storm-b5-donow",
      workflow: "do-now",
      harness: "pi",
      status: runStatus,
      runId: B5_RUN,
      children: [],
      relaunchOf: null,
    },
  };
  state.rounds.B.phases = {};
  return state;
}

function makeCtx({ clock, campaignDir, launch, tamandua }: any) {
  const calls: any[] = [];
  let dbOpenCalls = 0;
  const ctx: any = {
    fs,
    clock,
    varRoot: "/var",
    campaignDir,
    calls,
    db: {
      get dbOpenCalls() { return dbOpenCalls; },
      open() {
        dbOpenCalls += 1;
        return {
          ok: true,
          api: {
            getRun: () => undefined, // the product removed the row after delete
            activeStepsForRuns: () => [],
            close: () => {},
          },
        };
      },
    },
    opts: {
      // The fail-closed resolver hands the relaunch the SAME absolute B5 task
      // file the primary launch uses (never a HOME-relative name).
      taskFiles: { B5: path.join(campaignDir, "tasks", "storm-b5-donow.task.md") },
    },
    proc: {
      tamandua: async (argv: string[], opts: any) => {
        calls.push(["tamandua", [...argv], opts]);
        const fn = tamandua ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
        return fn(argv, opts);
      },
      launchWorkflow: async (argv: string[], opts: any) => {
        calls.push(["launch", [...argv], opts]);
        const fn = launch ?? (async () => launchOutcome(RELAUNCH_RUN));
        return fn(argv, opts);
      },
    },
  };
  return ctx;
}

function findArg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

async function runStopdel({ launch }: any) {
  const clock = makeClock(0);
  const campaignDir = makeTempDir("storm-us002-stopdel-");
  const ctx = makeCtx({ clock, campaignDir, launch });
  const state = makeState(clock);
  const ops = makeOps();
  await dispatchPhaseSchedule(ctx, state, ops, campaignDir, 0);
  return { clock, campaignDir, ctx, state, ops };
}

describe("tier2-storm-rehearsal-stopdel-terminal (US-002, SF-13)", () => {
  it("T1: stop+delete ok with a relaunch exit 1 (no run identity) leaves B5 terminal/deleted and the phase failed + bounded", async () => {
    const { state, ops, ctx, campaignDir } = await runStopdel({
      launch: async () => ({ exitCode: 1, stdout: "", stderr: "Error: ENOENT no such task file\n" }),
    });

    // (1) the deleted target is engine-terminal first-class.
    const b5 = state.rounds.B.runs.B5;
    assert.equal(b5.status, "terminal", "B5 is engine-terminal even though the relaunch failed");
    assert.equal(b5.terminalStatus, "deleted", "B5 terminalStatus is deleted");
    assert.ok(b5.terminalAt, "B5 records terminalAt");
    const deleted = ops.ofKind("run.deleted");
    assert.equal(deleted.length, 1, "run.deleted is recorded exactly once");
    assert.equal(deleted[0].rosterId, "B5");
    assert.equal(deleted[0].runId, B5_RUN);

    // (2) the phase is failed and carries the bounded first-class classification.
    const ph = state.rounds.B.phases["B-stopdel"];
    assert.equal(ph.status, "failed", "the B-stopdel phase is failed when the relaunch fails");
    assert.ok(ph.relaunchFailure, "the phase carries a relaunchFailure");
    assert.equal(ph.relaunchFailure.code, "TT_MISSING_RUN", "no run identity -> TT_MISSING_RUN");
    assert.equal(ph.relaunchFailure.bounded, true, "the failure is bounded");
    assert.ok(String(ph.relaunchFailure.message).length > 0, "the failure carries a message");
    const failedOps = ops.ofKind("phase.relaunch.failed");
    assert.ok(failedOps.some((o) => o.code === "TT_MISSING_RUN" && o.bounded === true), "phase.relaunch.failed is emitted with the bounded code");

    // No live relaunch record is left behind (the loop has nothing to wait on).
    assert.equal(state.rounds.B.runs["B5-relaunch"], undefined, "a runless failed relaunch registers no live run");

    // (6) every emitted launch argv is absolute and under the campaign tasks root.
    const launchCall = ctx.calls.find(([k]: any) => k === "launch");
    const taskFile = findArg(launchCall[1], "--task-file");
    assert.ok(taskFile?.startsWith("/"), `relaunch --task-file is absolute (${taskFile})`);
    assert.ok(String(taskFile).startsWith(path.join(campaignDir, "tasks")), "relaunch task file is under the campaign tasks root");
  });

  it("T2: stop+delete ok with a relaunch exit 1 but a resolvable identity -> TT_RELAUNCH_FAILED and a first-class launch_failed record", async () => {
    const { state, ops } = await runStopdel({
      launch: async () => ({ exitCode: 1, stdout: `Run: ${RELAUNCH_RUN}\n`, stderr: "" }),
    });

    // B5 is still engine-terminal despite the failed relaunch.
    const b5 = state.rounds.B.runs.B5;
    assert.equal(b5.status, "terminal", "B5 is engine-terminal");
    assert.equal(b5.terminalStatus, "deleted", "B5 terminalStatus is deleted");
    assert.equal(ops.ofKind("run.deleted").length, 1, "run.deleted is recorded");

    // A resolvable identity means the failure is not a MISSING identity.
    const ph = state.rounds.B.phases["B-stopdel"];
    assert.equal(ph.status, "failed");
    assert.equal(ph.relaunchFailure.code, "TT_RELAUNCH_FAILED", "a resolved run identity -> TT_RELAUNCH_FAILED");
    assert.equal(ph.relaunchFailure.bounded, true);
    assert.ok(
      ops.ofKind("phase.relaunch.failed").some((o) => o.code === "TT_RELAUNCH_FAILED"),
      "the bounded TT_RELAUNCH_FAILED op is emitted",
    );

    // The failed relaunch is first-class, never a live 'registered' run.
    const rr = state.rounds.B.runs["B5-relaunch"];
    assert.ok(rr, "the relaunch identity is recorded");
    assert.equal(rr.status, "launch_failed", "a failed launch is launch_failed, never registered");
    assert.equal(rr.relaunchOf, "B5");
  });

  it("T3: all three sub-ops exit 0 -> B5 stays terminal/deleted and the relaunch carries relaunchOf lineage", async () => {
    const { state, ops } = await runStopdel({
      launch: async () => launchOutcome(RELAUNCH_RUN),
    });

    const b5 = state.rounds.B.runs.B5;
    assert.equal(b5.status, "terminal", "B5 is engine-terminal");
    assert.equal(b5.terminalStatus, "deleted", "B5 terminalStatus is deleted");
    assert.equal(ops.ofKind("run.deleted").length, 1, "run.deleted is recorded");

    const ph = state.rounds.B.phases["B-stopdel"];
    assert.equal(ph.status, "fired", "all-ok keeps the phase fired");
    assert.equal(ph.relaunchFailure, undefined, "no failure classification on the happy path");

    const rr = state.rounds.B.runs["B5-relaunch"];
    assert.ok(rr, "the relaunch record exists");
    assert.equal(rr.status, "registered", "an exit-0 relaunch is registered for observation");
    assert.equal(rr.relaunchOf, "B5", "the relaunch carries its parent lineage");
    assert.equal(rr.runId, RELAUNCH_RUN);
    assert.equal(ops.ofKind("phase.relaunch.failed").length, 0, "no failure op on the happy path");
  });

  it("T4: once the deleted target is terminal, the observation loop returns promptly (no ROUND_B_END_MS wait, no run-row probe)", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-us002-loop-terminal-");
    const ctx = makeCtx({ clock, campaignDir });
    const state = makeState(clock);
    // The post-stopdel state: the DB row is gone and the target is terminal.
    state.rounds.B.runs.B5.status = "terminal";
    state.rounds.B.runs.B5.terminalStatus = "deleted";
    state.rounds.B.runs.B5.terminalAt = clock.nowUtc();
    const ops = makeOps();

    await runObservationLoop(ctx, state, ops, campaignDir, { round: "B", startedAt: 0, sample: false, samplerStartedAt: 0 });

    assert.equal(ctx.clock.nowMs(), 0, "the loop returns without advancing the clock");
    assert.ok(ctx.clock.nowMs() < ROUND_B_END_MS, "returns far below ROUND_B_END_MS");
    assert.equal(ctx.db.dbOpenCalls, 0, "the deleted target is never probed (no 'run row missing' wait)");
  });

  it("T5: contrast — the same loop with B5 still registered and no DB row consumes the window", async () => {
    const clock = makeClock(0);
    const campaignDir = makeTempDir("storm-us002-loop-live-");
    const ctx = makeCtx({ clock, campaignDir });
    ctx.opts.roundWindowMs = 5_000;
    const state = makeState(clock, { runStatus: "registered" });
    const ops = makeOps();

    await runObservationLoop(ctx, state, ops, campaignDir, { round: "B", startedAt: 0, sample: false, samplerStartedAt: 0 });

    assert.ok(ctx.clock.nowMs() >= 5_000, "a still-live target consumes the round window");
    assert.ok(ctx.db.dbOpenCalls > 0, "the live target IS probed (the row is missing) — this is the wait SF-13 removes");
  });
});
