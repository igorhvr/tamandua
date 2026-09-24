// Tier-2 STORM-REAL US-001 — campaign PROFILE identity + `--profile` prepare
// plumbing (in-process + real CLI; NO daemon/harness/chaos, NO real tokens).
//
// The real storm may only ever be prepared as an explicit, persisted identity:
// `tt-storm prepare --profile REAL` selects the real campaign (real
// pi/hermes/dsh harnesses, the real product daemon, real tokens) while the
// default stays the zero-model SCRIPTED_REHEARSAL. This file is the ONE
// focused self-test for that profile model:
//
//   * the pure profile module names SCRIPTED_REHEARSAL + REAL, maps each to a
//     daemon kind/label, and REFUSES an unknown/empty value with TT_USAGE;
//   * stormPrepare records the requested profile in state.rehearsal.profile and
//     resource_plan.daemon.kind, and a REAL descriptor carries no
//     scripted_runtime and no derived hold_schedule/roundBPhases (so the engine
//     keeps its authoritative ROUND_B_PHASES table);
//   * an unknown profile refuses TT_USAGE before any effect (no campaign dir);
//   * the SCRIPTED_REHEARSAL default path is unchanged (scripted_runtime +
//     derived hold schedule recorded; descriptor labelled the rehearsal).
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
import { stormPrepare } from "../bin/tt-storm-engine.mjs";
import {
  DEFAULT_STORM_PROFILE,
  REAL,
  SCRIPTED_REHEARSAL,
  STORM_PROFILES,
  daemonKindForProfile,
  isRealProfile,
  isStormProfile,
  labelForProfile,
  parseProfile,
} from "../bin/tt-storm-profile.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  deriveScriptedHoldSchedule,
  REHEARSAL_LABEL,
  computeGateHashes,
} from "../bin/tt-storm-rehearsal.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-real-profile-${label}-`));
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

// Build the SAME ctx the CLI wires for prepare, with an explicit profile.
function inProcessCtx(scratch: string, profile: string | undefined): any {
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
      // STORM-REAL US-002: a REAL prepare resolves the roster harness binaries
      // before any effect. This in-process profile test injects a deterministic
      // fake resolver so it stays hermetic (the real env/PATH resolution is
      // exercised by tier2-storm-real-harness-pins.test.ts).
      resolveHarnessPins: (names: string[]) => Object.fromEntries(names.map((n) => [n, {
        harness: n,
        path: `/fake/harness/${n}`,
        resolved_from: `env:TAMANDUA_${n.toUpperCase()}_BINARY`,
        sha256: "a".repeat(64),
        version: `${n} 1.2.3`,
        version_exit_code: 0,
      }])),
      ...(profile === undefined ? {} : { profile }),
      // STORM-REAL US-006: a REAL prepare now requires a hard spend cap; this
      // profile test injects one so the REAL prepare proceeds (the cap itself
      // is exercised by tier2-storm-real-spend-cap.test.ts).
      ...(profile === REAL ? { spendCapTokens: "100000000" } : {}),
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

describe("STORM-REAL US-001 profile model — pure identity + prepare plumbing", () => {
  it("P1: the profile module exports the two admitted identities and maps them to distinct daemon kinds/labels", () => {
    assert.equal(SCRIPTED_REHEARSAL, "SCRIPTED_REHEARSAL");
    assert.equal(REAL, "REAL");
    assert.equal(DEFAULT_STORM_PROFILE, SCRIPTED_REHEARSAL, "the default profile is the scripted rehearsal");
    assert.deepEqual([...STORM_PROFILES].sort(), [REAL, SCRIPTED_REHEARSAL].sort(), "both profiles are admitted");
    assert.equal(daemonKindForProfile(SCRIPTED_REHEARSAL), "scripted");
    assert.equal(daemonKindForProfile(REAL), "real");
    assert.equal(daemonKindForProfile(), "scripted", "an omitted profile defaults to the scripted kind");
    const scriptedLabel = labelForProfile(SCRIPTED_REHEARSAL);
    const realLabel = labelForProfile(REAL);
    assert.equal(scriptedLabel, REHEARSAL_LABEL, "the scripted label is the tiny-fixture infrastructure-rehearsal label");
    assert.notEqual(realLabel, REHEARSAL_LABEL, "the REAL label must differ from the tiny-fixture rehearsal label");
    assert.match(realLabel, /real/i);
    assert.ok(isStormProfile(SCRIPTED_REHEARSAL) && isStormProfile(REAL));
    assert.equal(isStormProfile("nope"), false);
    assert.equal(isRealProfile(REAL), true);
    assert.equal(isRealProfile(SCRIPTED_REHEARSAL), false);
  });

  it("P2: parseProfile defaults to SCRIPTED_REHEARSAL and refuses unknown/empty/non-string with TT_USAGE", () => {
    assert.equal(parseProfile(), SCRIPTED_REHEARSAL);
    assert.equal(parseProfile(undefined), SCRIPTED_REHEARSAL);
    assert.equal(parseProfile(null), SCRIPTED_REHEARSAL);
    assert.equal(parseProfile(SCRIPTED_REHEARSAL), SCRIPTED_REHEARSAL);
    assert.equal(parseProfile(REAL), REAL);
    for (const bad of ["", "   ", "real", "scripted_rehearsal", "REHEARSAL", "BOGUS"]) {
      assert.throws(
        () => parseProfile(bad),
        (err: any) => err?.code === "TT_USAGE",
        `parseProfile(${JSON.stringify(bad)}) must refuse TT_USAGE`,
      );
    }
    assert.throws(() => parseProfile(42 as any), (err: any) => err?.code === "TT_USAGE");
    assert.throws(() => daemonKindForProfile("BOGUS"), (err: any) => err?.code === "TT_USAGE");
    assert.throws(() => labelForProfile("BOGUS"), (err: any) => err?.code === "TT_USAGE");
  });

  it("P3: stormPrepare refuses an unknown profile with TT_USAGE before creating the campaign dir", async () => {
    const scratch = ownedScratch("refuse");
    try {
      const ctx = inProcessCtx(scratch, "BOGUS");
      const target = path.join(scratch, "var", "results", "storm-must-not-exist");
      ctx.campaignDir = target;
      await assert.rejects(() => stormPrepare(ctx), (err: any) => err?.code === "TT_USAGE");
      assert.equal(fs.existsSync(target), false, "an unknown profile leaves NO campaign dir behind");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P4: a REAL prepare records the REAL profile + real daemon kind and carries no scripted_runtime/hold_schedule/roundBPhases", async () => {
    const scratch = ownedScratch("real");
    try {
      const ctx = inProcessCtx(scratch, REAL);
      const res: any = await stormPrepare(ctx);
      assert.equal((ctx.proc.calls ?? []).length, 0, "prepare must not spawn a daemon/harness/chaos process");

      // state identity.
      assert.equal(res.state.rehearsal.profile, REAL, "state.rehearsal.profile is REAL");
      assert.equal(res.state.rehearsal.resource_plan.daemon.kind, "real", "resource_plan.daemon.kind is real");
      assert.equal(res.state.rehearsal.resource_plan.daemon.profile, REAL, "resource_plan.daemon.profile is REAL");
      assert.equal(res.state.rehearsal.scripted_runtime, undefined, "REAL state carries no scripted_runtime");
      assert.equal(res.state.rehearsal.hold_schedule, undefined, "REAL state carries no derived hold_schedule");
      assert.equal(res.state.plan.roundBPhases, undefined, "REAL state carries no derived roundBPhases");

      // descriptor identity.
      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.profile, REAL, "descriptor.profile is REAL");
      assert.notEqual(desc.label, REHEARSAL_LABEL, "REAL descriptor is not labelled the tiny-fixture rehearsal");
      assert.match(desc.label, /real/i, "REAL descriptor carries the real-storm label");
      assert.equal(Object.prototype.hasOwnProperty.call(desc, "scripted_runtime"), false, "REAL descriptor has no scripted_runtime key");
      assert.equal(Object.prototype.hasOwnProperty.call(desc, "hold_schedule"), false, "REAL descriptor has no hold_schedule key");
      assert.equal(desc.resource_plan.daemon.kind, "real");
      assert.equal(desc.authorized_rehearse.profile, REAL, "authorized rehearse is profile-bound to REAL");
      // The REAL campaign stays prepared and unqualified (no launch).
      assert.equal(res.state.mode, "prepared");
      assert.equal(res.state.qualification.real_launch_allowed, false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P5: the SCRIPTED_REHEARSAL default is unchanged (scripted profile, scripted_runtime, derived hold schedule, scripted daemon kind)", async () => {
    const scratch = ownedScratch("scripted");
    try {
      const ctx = inProcessCtx(scratch, undefined);
      const res: any = await stormPrepare(ctx);
      assert.equal(res.state.rehearsal.profile, SCRIPTED_REHEARSAL, "default prepare records SCRIPTED_REHEARSAL");
      assert.equal(res.state.rehearsal.resource_plan.daemon.kind, "scripted", "default daemon kind stays scripted");
      assert.ok(res.state.rehearsal.scripted_runtime?.behaviors_file, "default state records the scripted-runtime contract");
      assert.ok(res.state.rehearsal.hold_schedule, "default state records the derived hold schedule");
      const derived = deriveScriptedHoldSchedule();
      assert.deepEqual(res.state.plan.roundBPhases, derived.round_b.phases, "default roundBPhases equal the derived phases");

      const desc = loadJson(path.join(res.campaignDir, "descriptor.json"));
      assert.equal(desc.profile, SCRIPTED_REHEARSAL);
      assert.equal(desc.label, REHEARSAL_LABEL);
      assert.ok(desc.scripted_runtime?.behaviors_file, "default descriptor carries the scripted_runtime contract");
      assert.deepEqual(desc.hold_schedule, derived, "default descriptor carries the derived hold schedule");
      assert.equal(desc.resource_plan.daemon.kind, "scripted");
      assert.equal(desc.authorized_rehearse.profile, SCRIPTED_REHEARSAL);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P6: the real CLI defaults to SCRIPTED_REHEARSAL and refuses an unknown/empty --profile with exit 4 before any effect", () => {
    const scratch = ownedScratch("cli-refuse");
    const scratchVar = path.join(scratch, "var");
    try {
      const unknown = runCliPrepare(scratchVar, ["--profile", "BOGUS"]);
      assert.equal(unknown.status, 4, `unknown --profile must exit 4:\nstdout=${unknown.stdout}\nstderr=${unknown.stderr}`);
      assert.match(unknown.stderr, /unknown storm profile/i, "refusal names the unknown profile");
      assert.equal(fs.existsSync(path.join(scratchVar, "results")), false, "unknown profile created no campaign dir");

      const empty = runCliPrepare(scratchVar, ["--profile", ""]);
      assert.equal(empty.status, 4, `empty --profile must exit 4:\nstdout=${empty.stdout}\nstderr=${empty.stderr}`);
      assert.match(empty.stderr, /non-empty/i, "refusal names the empty profile");

      // The default path is SCRIPTED_REHEARSAL (a real, launch-free prepare).
      const def = runCliPrepare(scratchVar, []);
      assert.equal(def.status, 0, `default prepare exit 0:\nstdout=${def.stdout}\nstderr=${def.stderr}`);
      assert.match(def.stdout, new RegExp(SCRIPTED_REHEARSAL), "default prepare prints SCRIPTED_REHEARSAL");
      assert.match(def.stdout, /tiny owned fixture/, "default prepare prints the rehearsal label");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});