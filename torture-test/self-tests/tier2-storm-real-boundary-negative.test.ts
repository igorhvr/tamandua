// Tier-2 STORM-REAL US-013 — REAL boundary negative and safety regression tests.
//
// The REAL storm can spend real money and touch real harness credentials, so
// its safety boundary must fail CLOSED. This is the focused negative battery
// proving the four unsafe conditions refuse with their exact, documented
// outcome and abort safely:
//
//   N1  a coordinator approval issued for the WRONG profile can never authorize
//       the campaign — refused with the exact TT_REHEARSAL_NOT_APPROVED code
//       (pure validator AND the real `tt-storm approve` route, exit 3), and the
//       campaign is left unqualified;
//   N2  a REAL prepare with no hard spend cap is refused with the documented
//       usage refusal (TT_USAGE in-process; the CLI exits 4) before any
//       campaign dir exists;
//   N3  crossing the cap triggers the OWNED cleanup path EXACTLY ONCE and marks
//       the campaign/report aborted (an injected cleanup counter proves the
//       once-only contract; a second tick never re-cleans);
//   N4  a REAL prepare with a missing roster harness is refused with
//       TT_UNRESOLVED_BINARY (in-process) and the CLI exits non-zero, with no
//       campaign dir left behind.
//
// No daemon, harness, model or token is used: every case is either pure or
// driven through injected adapters (the prepare resolution/version and the
// owned-cleanup seams); the only child processes are the tt-storm CLI itself
// and its read-only git provenance probe.
//
// NOT part of any default fast lane: run with `node --test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import {
  buildPrivateExecContext,
  persistableExecIdentity,
  verifyCoordinatorApproval,
} from "../bin/tt-storm-real.mjs";
import {
  abortCampaignForSpendCap,
  enforceSpendCapOnTick,
  stormPrepare,
} from "../bin/tt-storm-engine.mjs";
import { REAL, SCRIPTED_REHEARSAL } from "../bin/tt-storm-profile.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  computeGateHashes,
} from "../bin/tt-storm-rehearsal.mjs";
import {
  SPEND_STATUS_KNOWN,
  sumSpendSnapshot,
} from "../bin/tt-storm-spend.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

const RUN_DSH = "run-33333333-3333-4333-8333-333333333333";

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-storm-real-boundary-negative-"));
const varRoot = path.join(workRoot, "var");
const approvalsDir = path.join(workRoot, "approvals");
fs.mkdirSync(varRoot, { recursive: true });
fs.mkdirSync(approvalsDir, { recursive: true });

function currentHead(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return String(r.stdout ?? "").trim();
}
const HEAD = currentHead();

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(workRoot, `scratch-${label}-`));
}

// An owned fake harness that answers `--version` deterministically (so the
// missing-harness CLI case is hermetic — it never depends on the operator's
// real toolchain).
function writeFakeHarness(dir: string, name: string, versionText: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho '${versionText}'\n`);
  fs.chmodSync(p, 0o755);
  return p;
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

// The SAME ctx the CLI wires for prepare, with the REAL resolution path (or an
// injected one), the injected spend cap and an injected version runner. No
// daemon/harness/model is ever spawned: the `proc` adapter throws if touched.
function inProcessPrepareCtx(
  scratch: string,
  {
    profile = REAL as string | undefined,
    spendCapTokens = undefined as string | undefined,
    harnessEnv = {} as Record<string, string>,
    resolveHarnessPins = undefined as undefined | ((names: string[]) => Promise<Record<string, any>>),
  } = {},
): any {
  const scratchVar = path.join(scratch, "var");
  fs.mkdirSync(scratchVar, { recursive: true });
  const installedRoot = path.join(scratchVar, "home", ".tamandua", "workflows");
  const execCtx = buildPrivateExecContext({ varRoot: scratchVar, binaries: { tamandua: TAMANDUA_BIN } });
  return {
    fs: REAL_FS,
    clock: {
      nowMs: () => Date.now(),
      nowUtc: () => new Date().toISOString(),
      sleep: async () => {},
    },
    proc: {
      spawn: async () => { throw new Error("no proc spawn expected"); },
      daemonControl: async () => { throw new Error("no proc daemonControl expected"); },
      harness: async () => { throw new Error("no proc harness expected"); },
    },
    db: null,
    git: makeRealGitAdapter(),
    varRoot: scratchVar,
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
      // Hermetic harness resolution: an empty PATH plus the caller's env, and a
      // version runner that never executes a real harness.
      harnessEnv,
      harnessPath: "",
      harnessVersionRunner: async (binaryPath: string) => ({
        stdout: `fake ${path.basename(binaryPath)} 9.9.9`,
        stderr: "",
        exitCode: 0,
      }),
      scriptedRuntimes: {
        pi: path.join(TT_DIR, "scripted-runtimes", "bin", "scripted-pi"),
        hermes: path.join(TT_DIR, "scripted-runtimes", "bin", "scripted-hermes"),
      },
      ...(resolveHarnessPins ? { resolveHarnessPins } : {}),
      ...(profile === undefined ? {} : { profile }),
      ...(spendCapTokens === undefined ? {} : { spendCapTokens }),
    },
    argv: profile === undefined ? ["prepare"] : ["prepare", "--profile", profile],
  };
}

// Spawn the tt-storm CLI with an isolated TT_VAR. NODE_TEST_CONTEXT is cleared
// so the child is not silently forced through the product test guard; the
// contained campaign roots are all under TT_VAR regardless.
function runCli(args: string[], scratchVar: string, extraEnv: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string> = { ...process.env, TT_VAR: scratchVar, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env,
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// ── N1 fixture: a genuinely contained prepared campaign so requireContained
// passes and the refusal truly comes from the profile-bound approval validator.
let seq = 0;
function makeCampaign(profile: string): { id: string; campaignDir: string; statePath: string } {
  const id = `storm-neg-${profile.toLowerCase()}-${process.pid}-${++seq}`;
  const campaignDir = path.join(varRoot, "results", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  const state = {
    schema_version: 1,
    campaign_id: id,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    mode: "prepared",
    qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
    exec_identity: persistableExecIdentity(execCtx),
    rehearsal: profile === REAL ? { profile, spend_cap: { tokens: 1000, scope: "total" } } : { profile },
    rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
    plan: { launches: [], roundBPhases: [] },
  };
  const statePath = path.join(campaignDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(path.join(campaignDir, "ops.jsonl"), "");
  fs.writeFileSync(path.join(campaignDir, "intent.jsonl"), "");
  return { id, campaignDir, statePath };
}

function writeApproval(name: string, body: Record<string, any>): string {
  const file = path.join(approvalsDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

// A fully valid approval except for its `profile` (which the caller controls),
// so only the profile binding can be the reason for a refusal.
function baseApproval(campaignId: string, profile: string | null): Record<string, any> {
  const approval: Record<string, any> = {
    real_launch_allowed: true,
    campaign_id: campaignId,
    source_commit: HEAD,
    approval_kind: "SCRIPTED_REHEARSAL",
    gate_hashes: computeGateHashes(),
  };
  if (profile !== null) approval.profile = profile;
  return approval;
}

function readState(statePath: string): any {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

// ── N3 fixture: a minimal engine state carrying the persisted cap and the
// round/report structure the abort path writes.
function abortState(scope: "paid" | "total" = "paid", tokens = 100): any {
  return {
    campaign_id: "storm-neg-abort-fixture",
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

after(() => {
  // Only this test's own scratch tree is removed.
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe("STORM-REAL US-013 REAL boundary negative controls", () => {
  it("N1: a wrong-profile approval is refused with the exact TT_REHEARSAL_NOT_APPROVED code (validator + real approve route)", () => {
    // Pure validator: both mismatch directions plus the missing-profile case.
    const gateHashes = { "torture-test/bin/tt-storm-real.mjs": "a".repeat(64) };
    const base = {
      real_launch_allowed: true,
      campaign_id: "storm-neg",
      source_commit: "abc",
      approval_kind: "SCRIPTED_REHEARSAL",
      gate_hashes: gateHashes,
    };
    for (const [approvalProfile, expected] of [
      [REAL, SCRIPTED_REHEARSAL],
      [SCRIPTED_REHEARSAL, REAL],
      [null, SCRIPTED_REHEARSAL],
    ] as const) {
      const approval: Record<string, unknown> = { ...base };
      if (approvalProfile !== null) approval.profile = approvalProfile;
      const verdict = verifyCoordinatorApproval({
        approval,
        campaignId: "storm-neg",
        sourceCommit: "abc",
        gateHashes,
        expectedProfile: expected,
      });
      assert.equal(verdict.ok, false, `approval profile ${JSON.stringify(approvalProfile)} must be refused for ${expected}`);
      assert.equal(verdict.code, "TT_REHEARSAL_NOT_APPROVED", "the exact refusal code is pinned");
    }
    // A matching profile still passes, so the refusal is specifically the bind.
    assert.equal(
      verifyCoordinatorApproval({
        approval: { ...base, profile: REAL },
        campaignId: "storm-neg",
        sourceCommit: "abc",
        gateHashes,
        expectedProfile: REAL,
      }).ok,
      true,
    );

    // Real route: an approval for the OTHER profile is refused (exit 3) and the
    // campaign is left unqualified.
    const camp = makeCampaign(SCRIPTED_REHEARSAL);
    const wrong = writeApproval("n1-wrong-profile", baseApproval(camp.id, REAL));
    const r = runCli(["approve", "--campaign", camp.campaignDir, "--approval-file", wrong], varRoot, {
      TAMANDUA_TEST_GUARD: "1",
    });
    assert.equal(r.status, 3, `approve must refuse a wrong-profile approval (exit 3):\n${r.stderr}`);
    assert.match(r.stderr, /TT_REHEARSAL_NOT_APPROVED/, "the CLI reports the exact refusal code");
    assert.equal(readState(camp.statePath).qualification.real_launch_allowed, false, "the campaign stays unqualified");
  });

  it("N2: a REAL prepare without a spend cap is refused with the documented usage refusal and leaves no campaign dir", async () => {
    // In-process: TT_USAGE before any effect.
    const scratch = ownedScratch("no-cap");
    try {
      const ctx = inProcessPrepareCtx(scratch);
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

    // Real CLI: exit 4 (usage) and the documented remedy in the message.
    const cliScratch = ownedScratch("no-cap-cli");
    const cliVar = path.join(cliScratch, "var");
    try {
      const r = runCli(["prepare", "--profile", REAL], cliVar);
      assert.equal(r.status, 4, `REAL prepare without a cap must exit 4:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.match(r.stderr, /spend-cap-tokens/, "the refusal names --spend-cap-tokens");
      assert.equal(fs.existsSync(path.join(cliVar, "results")), false, "no campaign dir was created");
    } finally {
      fs.rmSync(cliScratch, { recursive: true, force: true });
    }
  });

  it("N3: crossing the cap triggers owned cleanup exactly once and marks the campaign/report aborted", async () => {
    const scratch = ownedScratch("abort");
    try {
      const campaignDir = path.join(scratch, "storm-neg-abort");
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
      assert.equal(snapshot.status, SPEND_STATUS_KNOWN);

      const first = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(first.status, "crossed");
      assert.equal(cleanupCalls, 1, "owned cleanup runs exactly once");
      assert.equal(state.spend_cap_abort.aborted, true);
      assert.equal(state.spend_cap_abort.cleanup_done, true);
      assert.equal(state.mode, "aborted");
      assert.equal(state.rounds.A.status, "aborted");
      assert.equal(ops.records.filter((r) => r.kind === "spend.cap.abort").length, 1, "the abort is recorded exactly once");

      const report = loadJson(path.join(campaignDir, "results", "report.json"));
      assert.equal(report.aborted.cap_crossed, true, "the report is marked aborted");
      assert.equal(report.aborted.scope, "paid");
      assert.equal(report.aborted.cap_tokens, 100);
      assert.equal(report.aborted.observed_tokens, 250);
      assert.equal(report.aborted.cleanup_done, true);
      assert.ok(fs.existsSync(path.join(campaignDir, "results", "report.txt")), "the aborted report text exists");

      // A second observation tick must not re-run owned cleanup.
      const second = await enforceSpendCapOnTick(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(second.status, "already_aborted");
      assert.equal(cleanupCalls, 1, "cleanup never runs twice");
      // Directly aborting again is likewise idempotent.
      const third = await abortCampaignForSpendCap(ctx, state, ops, campaignDir, { round: "A", snapshot });
      assert.equal(third.status, "already_aborted");
      assert.equal(cleanupCalls, 1);

      // An UNKNOWN tick is never fabricated into a crossing.
      const unknownState = abortState("total", 100);
      let unknownCleanup = 0;
      const unknownCtx = { ...ctx, opts: { runOwnedCleanup: async () => { unknownCleanup += 1; return { ok: true }; } } };
      const unknown = await enforceSpendCapOnTick(unknownCtx, unknownState, deterministicOps(), campaignDir, {
        round: "A",
        snapshot: { status: "unknown", reason: "campaign DB unreadable" },
      });
      assert.equal(unknown.status, "unknown");
      assert.equal(unknownCleanup, 0);
      assert.equal(unknownState.spend_cap_abort, undefined);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("N4: a missing roster harness refuses prepare with TT_UNRESOLVED_BINARY and no campaign dir", async () => {
    // In-process: pi resolves, hermes is missing -> the WHOLE prepare refuses
    // TT_UNRESOLVED_BINARY before any campaign dir exists. The injected version
    // runner is only ever asked about the harness that DID resolve.
    const scratch = ownedScratch("missing-harness");
    try {
      const pi = writeFakeHarness(scratch, "pi", "pi 1.0.0");
      const target = path.join(scratch, "var", "results", "storm-must-not-exist");
      const asked: string[] = [];
      const ctx = inProcessPrepareCtx(scratch, {
        spendCapTokens: "100000000",
        harnessEnv: { TAMANDUA_PI_BINARY: pi },
      });
      ctx.campaignDir = target;
      // Record which binaries the version runner is invoked for.
      ctx.opts.harnessVersionRunner = async (binaryPath: string) => {
        asked.push(path.basename(binaryPath));
        return { stdout: `fake ${path.basename(binaryPath)} 9.9.9`, stderr: "", exitCode: 0 };
      };
      await assert.rejects(
        () => stormPrepare(ctx),
        (e: any) => e?.code === "TT_UNRESOLVED_BINARY" && /hermes/.test(e.message),
        "the missing hermes harness must refuse the REAL prepare with TT_UNRESOLVED_BINARY",
      );
      assert.equal(fs.existsSync(target), false, "the refusal left NO campaign dir behind");
      assert.ok(!asked.includes("hermes"), "the missing harness is never executed for --version");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    // Real CLI: with a resolvable pi and an absent hermes override the prepare
    // refuses non-zero and says which harness could not be resolved.
    const cliScratch = ownedScratch("missing-harness-cli");
    const cliVar = path.join(cliScratch, "var");
    try {
      const pi = writeFakeHarness(cliScratch, "pi", "pi 1.0.0");
      const missing = path.join(cliScratch, "not-here-hermes");
      const r = runCli(["prepare", "--profile", REAL, "--spend-cap-tokens", "100000000"], cliVar, {
        TAMANDUA_PI_BINARY: pi,
        TAMANDUA_HERMES_BINARY: missing,
      });
      assert.notEqual(r.status, 0, `a missing roster harness must refuse:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.equal(r.status, 2, "TT_UNRESOLVED_BINARY maps to the generic non-usage exit 2");
      assert.match(r.stderr, /hermes/, "the refusal names the unresolvable harness");
      assert.equal(fs.existsSync(path.join(cliVar, "results")), false, "no campaign dir was created");
    } finally {
      fs.rmSync(cliScratch, { recursive: true, force: true });
    }
  });
});