// Tier-2 STORM-REAL US-008 — the capacity-scaled LITE roster + reduced chaos
// plan (in-process + real CLI; NO daemon/harness/chaos, NO real tokens).
//
// The full storm is a ten-run Round A + five-run Round B campaign. A host
// below full-storm capability runs the spec's capacity-scaled variant: the
// four-run tt-poly-lite pilot (fdmw pi ts, bfmw hermes python, quarantine-mw
// pi ts -> broken-tests, do-now agitator) with a timer cap RECOMPUTED from the
// actual lite roster's agent counts and a reduced Round B chaos plan (exactly
// one colleague commit and one worker kill). This file is the ONE focused
// self-test for that scale:
//
//   * the pure scale module names FULL/LITE, refuses unknown/empty with
//     TT_USAGE, and exports exactly the four lite roster entries;
//   * the lite Round B plan contains exactly one colleague_commit and one
//     kill_harness;
//   * a lite prepare records scale/roster_id, the tt-poly-lite fixture, the
//     recomputed cap and the lite launch plan in state + descriptor;
//   * the full default (no --scale) is unchanged: full rosters, full cap, the
//     complete chaos plan (two colleague commits, one kill), and no lite
//     roster_id in state.
//
// Everything runs under fresh owned temp roots; the owned git fixture is
// created by LOCAL git subprocesses only (no network, no credentials). The
// tests remove only their own scratch dirs in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import { stormPrepare, buildLaunchPlan } from "../bin/tt-storm-engine.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  computeGateHashes,
} from "../bin/tt-storm-rehearsal.mjs";
import {
  DEFAULT_STORM_SCALE,
  FULL,
  LITE,
  LITE_FIXTURE_NAME,
  LITE_ROUND_A_ROSTER,
  LITE_ROUND_B_PHASES,
  LITE_ROUND_B_ROSTER,
  STORM_SCALES,
  expectedActiveCountForScale,
  expectedActiveCountFromState,
  isLiteScale,
  isStormScale,
  parseScale,
  rosterForScale,
  rosterHarnessNames,
  rosterWorkflowIds,
  roundBPhasesForScale,
  scaleFromState,
} from "../bin/tt-storm-scale.mjs";
import { deriveStormNumbers, spawnCapture } from "../bin/tt-storm-shared.mjs";
import { rosterIdentityFromState } from "../bin/tt-storm-roster.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-lite-${label}-`));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) => {
      return spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      });
    },
  };
}

function makeRecordingProc() {
  const calls: Array<[string, any]> = [];
  const fn = async () => { throw new Error("recording proc must not be invoked during prepare"); };
  return {
    calls,
    spawn: fn,
    daemonControl: fn,
    harness: fn,
  };
}

function inProcessCtx(scratch: string, scale: string | undefined, overrides: Record<string, any> = {}): any {
  const varRoot = path.join(scratch, "var");
  fs.mkdirSync(varRoot, { recursive: true });
  const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  return {
    fs: REAL_FS,
    clock: {
      nowMs: () => Date.now(),
      nowUtc: () => new Date().toISOString(),
      sleep: async () => {},
    },
    proc: makeRecordingProc(),
    db: null,
    git: makeRealGitAdapter(),
    varRoot,
    campaignDir: null,
    opts: {
      rehearsalPrepare: true,
      installedCatalogRoot: installedRoot,
      bundledCatalogRoot: BUNDLED_WORKFLOWS,
      sourceCommit: "c".repeat(40),
      sourceTree: "t".repeat(40),
      sourceTreeDirty: false,
      execIdentity: persistableExecIdentity(execCtx),
      gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
      gateHashes: computeGateHashes(),
      coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
      ...(scale === undefined ? {} : { scale }),
      ...overrides,
    },
    argv: scale === undefined ? ["prepare"] : ["prepare", "--scale", scale],
  };
}

function childEnvForCli(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCliPrepare(scratchVar: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, "prepare", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvForCli({ TT_VAR: scratchVar }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function chaosActionKinds(phases: any[]): string[] {
  return phases
    .map((p) => p?.action?.kind)
    .filter((k) => k && k !== "read_path_pounding");
}

describe("STORM-REAL US-008 lite roster — capacity-scaled pilot + reduced chaos", () => {
  it("S1: the scale module exports FULL/LITE, defaults to FULL and refuses unknown/empty/non-string with TT_USAGE", () => {
    assert.equal(FULL, "full");
    assert.equal(LITE, "lite");
    assert.equal(DEFAULT_STORM_SCALE, FULL, "the default scale is the full storm");
    assert.deepEqual([...STORM_SCALES].sort(), [FULL, LITE].sort());
    assert.equal(parseScale(), FULL);
    assert.equal(parseScale(null), FULL);
    assert.equal(parseScale("lite"), LITE);
    assert.equal(parseScale("LITE"), LITE, "the value is normalized case-insensitively");
    assert.equal(isStormScale(LITE), true);
    assert.equal(isStormScale("nope"), false);
    assert.equal(isLiteScale(LITE), true);
    assert.equal(isLiteScale(FULL), false);
    for (const bad of ["", "   ", "big", "Light", "0", "FULL_STORM"]) {
      assert.throws(
        () => parseScale(bad),
        (err: any) => err?.code === "TT_USAGE",
        `parseScale(${JSON.stringify(bad)}) must refuse TT_USAGE`,
      );
    }
    assert.throws(() => parseScale(42 as any), (err: any) => err?.code === "TT_USAGE");
  });

  it("S2: the lite roster is exactly the four specified runs (workflows, harnesses and the broken-tests lane)", () => {
    const liteA = rosterForScale(LITE).A;
    assert.equal(liteA.length, 4, "the lite roster has exactly four runs");
    assert.deepEqual(
      liteA.map((r: any) => [r.workflow, r.harness]),
      [
        ["feature-dev-merge-worktree", "pi"],
        ["bug-fix-merge-worktree", "hermes"],
        ["quarantine-broken-tests-merge-worktree", "pi"],
        ["do-now", "pi"],
      ],
      "the lite roster is fdmw(pi), bfmw(hermes), quarantine-mw(pi), do-now(pi)",
    );
    const quarantine = liteA.find((r: any) => r.workflow === "quarantine-broken-tests-merge-worktree");
    assert.deepEqual(quarantine.context, ["branch=broken-tests"], "the quarantine lane lands on broken-tests");
    assert.deepEqual([...new Set(liteA.map((r: any) => r.round))], ["A"]);
    assert.ok(liteA.every((r: any) => /^L\d+$/.test(r.id)), "lite ids are L-prefixed");
    // The lite harnesses are pi/hermes only: a lite REAL prepare must never
    // demand dsh.
    assert.deepEqual(rosterHarnessNames({ A: liteA, B: LITE_ROUND_B_ROSTER }), ["pi", "hermes"]);
    assert.deepEqual(rosterWorkflowIds({ A: liteA, B: LITE_ROUND_B_ROSTER }), [
      "feature-dev-merge-worktree",
      "bug-fix-merge-worktree",
      "quarantine-broken-tests-merge-worktree",
      "do-now",
    ]);
    // The full default roster is the authoritative global roster (unchanged).
    const full = rosterForScale(FULL);
    assert.equal(full.A.length, 10);
    assert.equal(full.B.length, 5);
  });

  it("S3: the lite Round B plan contains exactly one colleague commit and one worker kill", () => {
    assert.equal(roundBPhasesForScale(FULL), null, "the full storm keeps the authoritative table");
    const phases = roundBPhasesForScale(LITE);
    assert.deepEqual(phases, LITE_ROUND_B_PHASES);
    const kinds = chaosActionKinds(phases);
    assert.equal(kinds.filter((k) => k === "colleague_commit").length, 1, "exactly one colleague commit");
    assert.equal(kinds.filter((k) => k === "kill_harness").length, 1, "exactly one worker kill");
    assert.deepEqual([...kinds].sort(), ["colleague_commit", "kill_harness"], "no other chaos action is in the lite plan");
    const cc = phases.find((p: any) => p.action.kind === "colleague_commit");
    const kill = phases.find((p: any) => p.action.kind === "kill_harness");
    assert.equal(cc.action.target, "L1b");
    assert.equal(kill.action.target, "L2b");
    assert.equal(kill.action.signal, "SIGKILL");
  });

  it("S4: a lite prepare records the scale, the tt-poly-lite fixture, the recomputed cap and the reduced plan", async () => {
    const scratch = ownedScratch("lite");
    try {
      const ctx = inProcessCtx(scratch, LITE);
      const res: any = await stormPrepare(ctx);
      assert.equal((ctx.proc.calls ?? []).length, 0, "prepare must not spawn a daemon/harness/chaos process");

      // Persisted scale identity.
      assert.equal(res.state.rehearsal.roster_id, LITE);
      assert.equal(res.state.rehearsal.scale, LITE);
      assert.equal(res.state.fixture.name, LITE_FIXTURE_NAME, "the lite fixture identity is tt-poly-lite");
      assert.equal(scaleFromState(res.state), LITE);
      assert.equal(rosterIdentityFromState(res.state).id, LITE);
      assert.equal(rosterIdentityFromState(res.state).label, "lite roster");

      // The plan carries exactly the four-run roster (Round A) + the same four
      // workflows in Round B, with the quarantine lane on broken-tests.
      const launchesA = res.state.plan.launches.filter((l: any) => l.round === "A");
      assert.equal(launchesA.length, 4, "lite Round A has exactly four launches");
      assert.deepEqual(launchesA.map((l: any) => l.rosterId), LITE_ROUND_A_ROSTER.map((r: any) => r.id));
      const quarLaunch = launchesA.find((l: any) => l.workflow === "quarantine-broken-tests-merge-worktree");
      assert.equal(quarLaunch.targetBranch, "broken-tests");
      const launchesB = res.state.plan.launches.filter((l: any) => l.round === "B");
      assert.equal(launchesB.length, 4, "lite Round B re-launches the same four workflows");
      assert.deepEqual(launchesB.map((l: any) => l.rosterId), LITE_ROUND_B_ROSTER.map((r: any) => r.id));

      // The recomputed cap equals the sum of the lite roster's derived agent
      // counts and is strictly below the full-roster cap.
      const liteCapFromPlan = launchesA.reduce((n: number, l: any) => n + (l.timers ?? 0), 0);
      assert.equal(res.numbers.cap.total, liteCapFromPlan, "the cap is the sum of the lite roster's timers");
      assert.ok(res.numbers.cap.total > 0, "the lite cap is a real derived number");
      assert.equal(res.state.source.active_cap, res.numbers.cap.total);
      assert.deepEqual(res.numbers.queued, {}, "the lite roster has no queued runs");

      // The reduced chaotic plan is recorded so the engine uses it.
      const phaseKinds = chaosActionKinds(res.state.plan.roundBPhases);
      assert.equal(phaseKinds.filter((k: string) => k === "colleague_commit").length, 1);
      assert.equal(phaseKinds.filter((k: string) => k === "kill_harness").length, 1);

      // Descriptor identity.
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.scale, LITE);
      assert.equal(desc.roster.scale, LITE);
      assert.equal(desc.roster.roster_id, LITE);
      assert.equal(desc.roster.round_a, 4);
      assert.equal(desc.roster.round_b, 4);
      assert.equal(desc.roster.active_cap, res.numbers.cap.total, "the descriptor records the recomputed cap");
      assert.equal(desc.active_cap, res.numbers.cap.total);
      assert.deepEqual(desc.roster.workflow_ids, rosterWorkflowIds({ A: LITE_ROUND_A_ROSTER, B: LITE_ROUND_B_ROSTER }));

      // Task files are provisioned for the lite roster only and the quarantine
      // task file declares the broken-tests lane.
      const taskManifest = desc.input_manifest.task_files;
      assert.deepEqual(Object.keys(taskManifest).sort(), [
        "storm-lite-b1-fdmw",
        "storm-lite-b2-bfmw",
        "storm-lite-b3-quar",
        "storm-lite-b4-donow",
        "storm-lite-fdmw-1",
        "storm-lite-bfmw-1",
        "storm-lite-quar-1",
        "storm-lite-donow-1",
      ].sort());
      const quarTask = fs.readFileSync(taskManifest["storm-lite-quar-1"].file, "utf8");
      assert.match(quarTask, /TARGET_BRANCH: broken-tests/);

      assert.equal(res.state.mode, "prepared");
      assert.equal(res.state.qualification.real_launch_allowed, false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("S5: the full default (no --scale) is unchanged — full rosters, full cap and the complete chaos plan", async () => {
    const scratch = ownedScratch("full");
    try {
      const ctx = inProcessCtx(scratch, undefined);
      const res: any = await stormPrepare(ctx);
      assert.equal(res.state.rehearsal.roster_id, undefined, "a full campaign records no lite roster_id");
      assert.equal(res.state.rehearsal.scale, undefined);
      assert.equal(scaleFromState(res.state), FULL);
      assert.equal(rosterIdentityFromState(res.state).id, FULL);
      const launchesA = res.state.plan.launches.filter((l: any) => l.round === "A");
      const launchesB = res.state.plan.launches.filter((l: any) => l.round === "B");
      assert.equal(launchesA.length, 10);
      assert.equal(launchesB.length, 5);
      const fullCapFromPlan = launchesA.filter((l: any) => !l.queued).reduce((n: number, l: any) => n + (l.timers ?? 0), 0);
      assert.equal(res.numbers.cap.total, fullCapFromPlan);
      assert.ok(res.numbers.cap.total > 0);
      assert.deepEqual(Object.keys(res.numbers.queued).sort(), ["S10", "S9"]);
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.roster.round_a, 10);
      assert.equal(desc.roster.round_b, 5);
      assert.equal(desc.roster.active_cap, res.numbers.cap.total);
      assert.deepEqual(desc.roster.workflow_ids, [
        "feature-dev-merge-worktree",
        "bug-fix-merge-worktree",
        "security-audit-merge-worktree",
        "quarantine-broken-tests-merge-worktree",
        "do-review-do-verify",
        "do-now",
      ]);
      // The full chaos plan has two colleague commits and (at least) one kill.
      const phaseKinds = chaosActionKinds(res.state.plan.roundBPhases);
      assert.equal(phaseKinds.filter((k: string) => k === "colleague_commit").length, 2);
      assert.equal(phaseKinds.filter((k: string) => k === "kill_harness").length >= 1, true);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("S6: the lite cap is strictly below the full cap (computed from the SAME seeded catalog)", async () => {
    const scratch = ownedScratch("caps");
    try {
      const lite = await stormPrepare(inProcessCtx(scratch, LITE));
      // Re-derive the full cap against the SAME seeded installed catalog.
      const installedRoot = path.join(scratch, "var", "home", ".tamandua", "workflows");
      const fullNumbers: any = await deriveStormNumbers({
        fs: REAL_FS,
        installedCatalogRoot: installedRoot,
        bundledCatalogRoot: BUNDLED_WORKFLOWS,
        activeRoster: rosterForScale(FULL).A,
      });
      const liteNumbers: any = await deriveStormNumbers({
        fs: REAL_FS,
        installedCatalogRoot: installedRoot,
        bundledCatalogRoot: BUNDLED_WORKFLOWS,
        activeRoster: rosterForScale(LITE).A,
      });
      assert.equal(lite.numbers.cap.total, liteNumbers.cap.total);
      assert.ok(liteNumbers.cap.total < fullNumbers.cap.total, "the lite cap is strictly below the full cap");
      // computeActiveTimerCap over the lite roster is the same figure.
      const plan = buildLaunchPlan(liteNumbers, { roster: rosterForScale(LITE), roundBPhases: roundBPhasesForScale(LITE) });
      assert.equal(plan.launches.filter((l: any) => l.round === "A").length, 4);
      assert.equal(expectedActiveCountForScale(LITE), 4);
      assert.equal(expectedActiveCountForScale(FULL), 8);
      const synthetic = { rehearsal: { roster_id: LITE } };
      assert.equal(expectedActiveCountFromState(synthetic), 4);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("S7: the CLI refuses an unknown/empty --scale (exit 4, no campaign dir) and prepares lite with tt-poly-lite", () => {
    const scratch = ownedScratch("cli");
    const scratchVar = path.join(scratch, "var");
    try {
      const unknown = runCliPrepare(scratchVar, ["--scale", "BOGUS"]);
      assert.equal(unknown.status, 4, `unknown --scale must exit 4:\nstdout=${unknown.stdout}\nstderr=${unknown.stderr}`);
      assert.match(unknown.stderr, /unknown storm scale/i);
      assert.equal(fs.existsSync(path.join(scratchVar, "results")), false, "unknown scale created no campaign dir");

      const empty = runCliPrepare(scratchVar, ["--scale", ""]);
      assert.equal(empty.status, 4);
      assert.match(empty.stderr, /non-empty/i);

      const lite = runCliPrepare(scratchVar, ["--scale", "lite"]);
      assert.equal(lite.status, 0, `lite prepare exit 0:\nstdout=${lite.stdout}\nstderr=${lite.stderr}`);
      assert.match(lite.stdout, /Campaign scale: lite/);
      const resultsDir = path.join(scratchVar, "results");
      const campaignDir = fs.readdirSync(resultsDir).map((n) => path.join(resultsDir, n))
        .find((p) => fs.existsSync(path.join(p, "descriptor.json")))!;
      const desc = loadJson(path.join(campaignDir, "descriptor.json"));
      assert.equal(desc.scale, "lite");
      assert.equal(desc.roster.round_a, 4);
      const state = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(state.fixture.name, LITE_FIXTURE_NAME);
      assert.equal(state.rehearsal.roster_id, "lite");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("S8: a REAL lite prepare resolves ONLY the lite harnesses (pi/hermes) and pins them", async () => {
    const scratch = ownedScratch("real-lite");
    try {
      const requested: string[][] = [];
      const ctx = inProcessCtx(scratch, LITE, {
        profile: "REAL",
        spendCapTokens: "100000000",
        resolveHarnessPins: async (names: string[]) => {
          requested.push(names);
          return Object.fromEntries(names.map((n) => [n, {
            harness: n,
            path: `/fake/harness/${n}`,
            resolved_from: `env:TAMANDUA_${n.toUpperCase()}_BINARY`,
            sha256: "a".repeat(64),
            version: `${n} 1.2.3`,
            version_exit_code: 0,
          }]));
        },
      });
      const res: any = await stormPrepare(ctx);
      assert.deepEqual(requested, [["pi", "hermes"]], "a lite REAL prepare resolves pi/hermes only, never dsh");
      assert.deepEqual(Object.keys(res.state.rehearsal.runtime_pins.harnesses).sort(), ["hermes", "pi"]);
      assert.equal(res.state.rehearsal.roster_id, LITE);
      assert.equal(loadJson(path.join(res.campaignDir, "descriptor.json")).scale, LITE);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});