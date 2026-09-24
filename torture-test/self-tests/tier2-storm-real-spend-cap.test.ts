// Tier-2 STORM-REAL US-006 — REQUIRED hard spend cap and cap-crossing abort
// (pure arithmetic + in-process engine + real CLI refusal; NO daemon, NO model,
// NO real tokens).
//
// A REAL storm spends real tokens, so it MUST carry a hard, persisted cap and
// the campaign MUST abort (owned cleanup + honest aborted report) when the
// product's own attribution crosses it. This focused self-test proves:
//
//   C1  cap parsing: --spend-cap-tokens is a non-negative integer,
//       --spend-cap-scope is paid|total (default total), and a REAL profile
//       without a cap refuses TT_USAGE while SCRIPTED_REHEARSAL stays
//       unaffected;
//   C2  the cap scope arithmetic is exact: 'paid' observes ONLY paid-provider
//       tokens (local-endpoint pi/hermes never consume it) and 'total' observes
//       every counted token; an UNKNOWN snapshot is never a fabricated
//       crossing;
//   C3  stormPrepare refuses a REAL prepare without a cap (TT_USAGE, no
//       campaign dir) and SCRIPTED_REHEARSAL still prepares without one;
//   C4  the cap + scope are recorded in state.rehearsal.spend_cap and
//       descriptor.spend_cap for REAL (null for the scripted rehearsal);
//   C5  crossing the cap aborts the campaign: owned cleanup runs EXACTLY ONCE,
//       the campaign/round are marked aborted, and the honest aborted report is
//       written (a second tick is already_aborted and does not re-run cleanup);
//   C6  the real CLI refuses `prepare --profile REAL` without
//       --spend-cap-tokens with exit 4 before creating a campaign.
//
// Everything runs under owned temp fixtures with injected seams; the tests
// remove only their own scratch dirs in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import {
  abortCampaignForSpendCap,
  enforceSpendCapOnTick,
  stormPrepare,
} from "../bin/tt-storm-engine.mjs";
import { REAL, SCRIPTED_REHEARSAL, parseProfile } from "../bin/tt-storm-profile.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  computeGateHashes,
} from "../bin/tt-storm-rehearsal.mjs";
import {
  DEFAULT_SPEND_CAP_SCOPE,
  SPEND_CAP_SCOPES,
  SPEND_STATUS_KNOWN,
  capObservedTokens,
  evaluateSpendCap,
  parseSpendCapScope,
  parseSpendCapTokens,
  resolveLaunchSpendCap,
  resolveSpendCapForProfile,
  spendCapFromState,
  sumSpendSnapshot,
} from "../bin/tt-storm-spend.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

const RUN_PI = "run-11111111-1111-4111-8111-111111111111";
const RUN_DSH = "run-33333333-3333-4333-8333-333333333333";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-spend-cap-${label}-`));
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

// Build the SAME ctx the CLI wires for prepare, with an explicit profile and
// injected REAL harness env/version seams (hermetic). `spendCapTokens` is the
// US-006 cap under test; omitted -> the REAL prepare must refuse.
function inProcessCtx(scratch: string, profile: string | undefined, { spendCapTokens = undefined as string | undefined, spendCapScope = undefined as string | undefined } = {}): any {
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
    proc: { spawn: async () => { throw new Error("no proc"); }, daemonControl: async () => { throw new Error("no proc"); }, harness: async () => { throw new Error("no proc"); } },
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
      // A deterministic fake resolver so this file never depends on the
      // operator's installed toolchain (the real resolution is covered by
      // tier2-storm-real-harness-pins.test.ts).
      resolveHarnessPins: (names: string[]) => Object.fromEntries(names.map((n) => [n, {
        harness: n,
        path: `/fake/harness/${n}`,
        resolved_from: `env:TAMANDUA_${n.toUpperCase()}_BINARY`,
        sha256: "a".repeat(64),
        version: `${n} 1.2.3`,
        version_exit_code: 0,
      }])),
      ...(profile === undefined ? {} : { profile }),
      ...(spendCapTokens === undefined ? {} : { spendCapTokens }),
      ...(spendCapScope === undefined ? {} : { spendCapScope }),
    },
    argv: profile === undefined ? ["prepare"] : ["prepare", "--profile", profile],
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

// A minimal engine state carrying the persisted cap and the round structure the
// report builder reads.
function abortState(scope: "paid" | "total" = "paid", tokens = 100): any {
  return {
    campaign_id: "storm-cap-abort-fixture",
    mode: "run-A",
    source: { active_cap: 52 },
    qualification: { real_launch_allowed: false },
    rounds: {
      A: { status: "running", runs: {}, phases: {}, pounding: null },
      B: { status: "pending", runs: {}, phases: {}, pounding: null },
    },
    sampler: { samples: [] },
    queue: { attempts: [] },
    cleanup: { ledger: [] },
    rehearsal: { profile: REAL, spend_cap: { tokens, scope } },
  };
}

function deterministicOps(): { records: any[]; record: (kind: string, detail: any) => void } {
  const records: any[] = [];
  return { records, record: (kind, detail) => records.push({ kind, detail }) };
}

describe("STORM-REAL US-006: required REAL spend cap and cap-crossing abort", () => {
  it("C1: cap parsing/validation — tokens a non-negative integer, scope paid|total, REAL requires a cap", () => {
    assert.deepEqual([...SPEND_CAP_SCOPES], ["paid", "total"]);
    assert.equal(DEFAULT_SPEND_CAP_SCOPE, "total");
    assert.equal(parseSpendCapTokens(undefined), null);
    assert.equal(parseSpendCapTokens(null), null);
    assert.equal(parseSpendCapTokens(""), null);
    assert.equal(parseSpendCapTokens("200000000"), 200000000);
    assert.equal(parseSpendCapTokens(42), 42);
    assert.equal(parseSpendCapTokens("0"), 0);
    for (const bad of ["-1", "1.5", "abc", "1e3", " 2 "]) {
      if (bad === " 2 ") { assert.equal(parseSpendCapTokens(bad), 2, "surrounding whitespace is tolerated"); continue; }
      assert.throws(() => parseSpendCapTokens(bad), (e: any) => e?.code === "TT_USAGE", `tokens ${JSON.stringify(bad)}`);
    }
    assert.equal(parseSpendCapScope(undefined), "total");
    assert.equal(parseSpendCapScope("paid"), "paid");
    assert.equal(parseSpendCapScope("total"), "total");
    assert.throws(() => parseSpendCapScope("dsh"), (e: any) => e?.code === "TT_USAGE");

    // REAL without a cap refuses TT_USAGE; SCRIPTED_REHEARSAL is unaffected.
    assert.throws(
      () => resolveSpendCapForProfile(REAL, undefined, undefined),
      (e: any) => e?.code === "TT_USAGE" && /spend-cap-tokens/.test(e.message),
      "REAL must require --spend-cap-tokens",
    );
    assert.equal(resolveSpendCapForProfile(SCRIPTED_REHEARSAL, undefined, undefined), null);
    assert.deepEqual(resolveSpendCapForProfile(REAL, "500", "paid"), { tokens: 500, scope: "paid" });
    assert.deepEqual(resolveSpendCapForProfile(REAL, "500"), { tokens: 500, scope: "total" });

    // A launching route (run/rehearse) must re-supply the cap and it must match
    // the persisted cap exactly.
    assert.equal(resolveLaunchSpendCap({ profile: SCRIPTED_REHEARSAL, persisted: null }).ok, true);
    const missing = resolveLaunchSpendCap({ profile: REAL, persisted: spendCapFromState(abortState("total", 5)) });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /spend-cap-tokens/);
    assert.equal(resolveLaunchSpendCap({ profile: REAL, persisted: spendCapFromState(abortState("total", 5)), rawTokens: "5" }).ok, true);
    assert.equal(resolveLaunchSpendCap({ profile: REAL, persisted: spendCapFromState(abortState("total", 5)), rawTokens: "6" }).ok, false, "a substituted cap refuses");
    assert.equal(resolveLaunchSpendCap({ profile: REAL, persisted: spendCapFromState(abortState("paid", 5)), rawTokens: "5", rawScope: "total" }).ok, false, "a substituted scope refuses");
    assert.equal(resolveLaunchSpendCap({ profile: REAL, persisted: null, rawTokens: "5" }).ok, false, "no persisted cap refuses");
  });

  it("C2: cap scope arithmetic — paid excludes local-endpoint tokens; unknown never crosses; total includes everything", () => {
    const assignments = [
      { run_id: RUN_PI, harness: "pi" },
      { run_id: RUN_DSH, harness: "dsh" },
    ];
    const snapshot = sumSpendSnapshot({
      assignments,
      runRows: [
        { id: RUN_PI.slice(4), tokens_spent: 1000 },
        { id: RUN_DSH.slice(4), tokens_spent: 50 },
      ],
      tickAt: "2026-09-23T00:00:00.000Z",
    });
    assert.equal(snapshot.status, SPEND_STATUS_KNOWN);
    assert.equal(snapshot.local_tokens, 1000);
    assert.equal(snapshot.paid_tokens, 50);
    assert.equal(snapshot.total_tokens, 1050);

    // paid scope observes ONLY the paid provider — the huge local spend cannot
    // consume a paid cap.
    assert.equal(capObservedTokens(snapshot, "paid"), 50);
    assert.equal(capObservedTokens(snapshot, "total"), 1050);
    assert.equal(evaluateSpendCap(snapshot, { tokens: 100, scope: "paid" }).status, "ok", "local tokens do not consume a paid cap");
    assert.equal(evaluateSpendCap(snapshot, { tokens: 100, scope: "total" }).status, "crossed", "total counts local + paid");
    const paidCrossed = evaluateSpendCap(snapshot, { tokens: 40, scope: "paid" });
    assert.equal(paidCrossed.status, "crossed");
    assert.equal(paidCrossed.observed, 50);
    assert.equal(paidCrossed.cap, 40);
    assert.equal(paidCrossed.remaining, -10);

    // UNKNOWN spend is never fabricated into a crossing.
    const unknown = evaluateSpendCap({ status: "unknown", reason: "db unreadable" }, { tokens: 1, scope: "total" });
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.observed, null);
    assert.equal(unknown.cap, 1);
    assert.equal(capObservedTokens({ status: "unknown" }, "total"), null);

    // No cap -> no_cap (a SCRIPTED_REHEARSAL tick is a no-op).
    assert.equal(evaluateSpendCap(snapshot, null).status, "no_cap");
  });

  it("C3: stormPrepare refuses a REAL prepare without a cap (TT_USAGE, no campaign dir) and the scripted rehearsal still prepares", async () => {
    const scratch = ownedScratch("prepare-refuse");
    try {
      const ctx = inProcessCtx(scratch, REAL);
      const target = path.join(scratch, "var", "results", "storm-must-not-exist");
      ctx.campaignDir = target;
      await assert.rejects(
        () => stormPrepare(ctx),
        (e: any) => e?.code === "TT_USAGE" && /spend-cap-tokens/.test(e.message),
        "a REAL prepare without --spend-cap-tokens must refuse TT_USAGE",
      );
      assert.equal(fs.existsSync(target), false, "the refusal left NO campaign dir behind");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    // SCRIPTED_REHEARSAL without any cap still prepares (unaffected).
    const scratch2 = ownedScratch("prepare-scripted");
    try {
      const ctx = inProcessCtx(scratch2, undefined);
      const res: any = await stormPrepare(ctx);
      assert.equal(res.state.rehearsal.profile, SCRIPTED_REHEARSAL);
      assert.equal(res.state.rehearsal.spend_cap, null, "the scripted rehearsal records a null cap");
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.spend_cap, null, "the scripted descriptor records a null cap");
    } finally {
      fs.rmSync(scratch2, { recursive: true, force: true });
    }
  });

  it("C4: a REAL prepare records the required cap + scope in state and descriptor", async () => {
    const scratch = ownedScratch("prepare-record");
    try {
      const ctx = inProcessCtx(scratch, REAL, { spendCapTokens: "200000000", spendCapScope: "paid" });
      const res: any = await stormPrepare(ctx);
      assert.deepEqual(res.state.rehearsal.spend_cap, { tokens: 200000000, scope: "paid" }, "state records the cap + scope");
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.deepEqual(desc.spend_cap, { tokens: 200000000, scope: "paid" }, "descriptor records the cap + scope");
      const onDisk = loadJson(path.join(res.campaignDir, "state.json"));
      assert.deepEqual(onDisk.rehearsal.spend_cap, { tokens: 200000000, scope: "paid" }, "state.json carries the cap");
      assert.deepEqual(spendCapFromState(onDisk), { tokens: 200000000, scope: "paid" });
      // Default scope is total when only tokens are supplied.
      const ctx2 = inProcessCtx(ownedScratch("prepare-default-scope"), REAL, { spendCapTokens: "7" });
      const res2: any = await stormPrepare(ctx2);
      assert.deepEqual(res2.state.rehearsal.spend_cap, { tokens: 7, scope: "total" });
      fs.rmSync(ctx2.varRoot.replace(/\/var$/, ""), { recursive: true, force: true });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C5: crossing the cap aborts with owned cleanup exactly once and an honest aborted report", async () => {
    const scratch = ownedScratch("abort");
    try {
      const campaignDir = path.join(scratch, "storm-cap-abort");
      fs.mkdirSync(campaignDir, { recursive: true });
      const state = abortState("paid", 100);
      const ops = deterministicOps();
      let cleanupCalls = 0;
      const ctx: any = {
        fs: REAL_FS,
        clock: { nowUtc: () => "2026-09-23T01:00:00.000Z", nowMs: () => 1000, sleep: async () => {} },
        campaignDir,
        opts: {
          runOwnedCleanup: async () => {
            cleanupCalls += 1;
            return { ok: true, ledger: [{ phase: "campaign-owned", ok: true }] };
          },
        },
      };
      const snapshot = sumSpendSnapshot({
        assignments: [{ run_id: RUN_DSH, harness: "dsh" }],
        runRows: [{ id: RUN_DSH.slice(4), tokens_spent: 250 }],
        tickAt: "2026-09-23T01:00:00.000Z",
      });
      const first = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(first.status, "crossed");
      assert.equal(cleanupCalls, 1, "owned cleanup runs exactly once");
      assert.equal(state.spend_cap_abort.aborted, true);
      assert.equal(state.spend_cap_abort.cleanup_done, true);
      assert.equal(state.spend_cap_abort.scope, "paid");
      assert.equal(state.spend_cap_abort.cap_tokens, 100);
      assert.equal(state.spend_cap_abort.observed_tokens, 250);
      assert.equal(state.aborted, true);
      assert.equal(state.mode, "aborted");
      assert.equal(state.rounds.A.status, "aborted");
      assert.ok(ops.records.some((r) => r.kind === "spend.cap.crossed"), "the crossing is recorded");
      assert.ok(ops.records.some((r) => r.kind === "spend.cap.abort"), "the abort is recorded");

      // The honest aborted report exists and names the crossing + scope.
      const report = loadJson(path.join(campaignDir, "results", "report.json"));
      assert.equal(report.aborted.cap_crossed, true);
      assert.equal(report.aborted.scope, "paid");
      assert.equal(report.aborted.cap_tokens, 100);
      assert.equal(report.aborted.observed_tokens, 250);
      assert.equal(report.aborted.cleanup_done, true);
      assert.ok(fs.existsSync(path.join(campaignDir, "results", "report.txt")));

      // A second tick already sees the abort and never re-runs cleanup.
      const second = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(second.status, "already_aborted");
      assert.equal(cleanupCalls, 1, "cleanup never runs twice");

      // Directly calling the abort again is likewise idempotent.
      const third = await abortCampaignForSpendCap(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(third.status, "already_aborted");
      assert.equal(cleanupCalls, 1);

      // An UNKNOWN tick does NOT abort (no fabricated crossing).
      const cleanState = abortState("total", 100);
      let cleanCleanup = 0;
      const cleanCtx = { ...ctx, opts: { runOwnedCleanup: async () => { cleanCleanup += 1; return { ok: true }; } } };
      const unknown = await enforceSpendCapOnTick(cleanCtx, cleanState, deterministicOps(), campaignDir, {
        round: "A",
        snapshot: { status: "unknown", reason: "campaign DB unreadable" },
      });
      assert.equal(unknown.status, "unknown");
      assert.equal(cleanCleanup, 0);
      assert.equal(cleanState.spend_cap_abort, undefined);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("C6: the real CLI refuses `prepare --profile REAL` without --spend-cap-tokens before creating a campaign", () => {
    const scratch = ownedScratch("cli-refuse");
    const scratchVar = path.join(scratch, "var");
    try {
      const refused = runCliPrepare(scratchVar, ["--profile", parseProfile(REAL), "--fixture", "tt-poly-lite"]);
      assert.equal(refused.status, 4, `REAL prepare without a cap must exit 4:\nstdout=${refused.stdout}\nstderr=${refused.stderr}`);
      assert.match(refused.stderr, /spend-cap-tokens/, "the refusal names --spend-cap-tokens");
      assert.equal(fs.existsSync(path.join(scratchVar, "results")), false, "no campaign dir was created");

      // An unknown scope is likewise a usage refusal (exit 4). A fresh TT_VAR
      // avoids the exec-identity DB reuse refusal of a second prepare.
      const scratchVar2 = path.join(scratch, "var2");
      const badScope = runCliPrepare(scratchVar2, ["--profile", REAL, "--spend-cap-tokens", "10", "--spend-cap-scope", "dsh"]);
      assert.equal(badScope.status, 4, `an unknown scope must exit 4:\nstderr=${badScope.stderr}`);
      assert.match(badScope.stderr, /spend cap scope/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});