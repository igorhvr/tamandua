// Tier-2 STORM-REAL US-012 — unattended REAL round budget + detached launch.
//
// A REAL storm round is real model turns + real merges + real suites: it can
// run for hours, and the observation loop must survive the operator's ssh
// session ending. This focused self-test proves:
//
//   U1  the per-round wall-budget guard is exact: REAL refuses a configured cap
//       below the 6h floor (TT_USAGE) and, with no configured cap, bounds the
//       round by the campaign-level T+44h wedge — never the scripted 3h Round-B
//       corridor; SCRIPTED_REHEARSAL keeps its existing round defaults
//       unchanged and may set any positive value;
//   U2  the detached-launch invocation is pure and complete: the launcher is
//       platform-selected (setsid on Linux, nohup elsewhere), stdout/stderr are
//       captured under <campaign>/logs/, the full `run` argv is forwarded and
//       `--detach` is stripped so the child never recurses;
//   U3  the real CLI applies the guard BEFORE any launch: a malformed/zero
//       --round-wall-ms refuses exit 4 on a prepared campaign, and a valid
//       value proceeds to the (expected) qualification refusal exit 3 rather
//       than a usage error.
//
// NO daemon, NO harness, NO model, NO real tokens: U3 prepares a campaign and
// stops at the pre-launch qualification gate. The tests remove only their own
// scratch dirs in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DETACH_LAUNCHER_NOHUP,
  DETACH_LAUNCHER_SETSID,
  REAL_CAMPAIGN_BOUND_MS,
  REAL_MIN_ROUND_WALL_MS,
  ROUND_WALL_ROUNDS,
  SCRIPTED_ROUND_WALL_DEFAULTS,
  buildDetachedRunInvocation,
  detachLauncherForPlatform,
  detachedRunLogPaths,
  parseRoundWallMs,
  resolveRoundWallBudget,
  stripDetachFlag,
} from "../bin/tt-storm-unattended.mjs";
import { REAL, SCRIPTED_REHEARSAL } from "../bin/tt-storm-profile.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-unattended-${label}-`));
}

function childEnvForCli(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCli(scratchVar: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvForCli({ TT_VAR: scratchVar }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function findCampaignDir(scratchVar: string): string {
  const resultsDir = path.join(scratchVar, "results");
  const dir = fs
    .readdirSync(resultsDir)
    .map((n) => path.join(resultsDir, n))
    .find((p) => fs.existsSync(path.join(p, "descriptor.json")));
  assert.ok(dir, `no prepared campaign found under ${resultsDir}`);
  return dir!;
}

describe("STORM-REAL US-012 unattended round budget + detached launch", () => {
  it("U1: the REAL budget guard refuses a cap below 6h and keeps the scripted defaults unchanged", () => {
    // Constants: the 6h floor is exactly the spec's real-round minimum; the
    // scripted defaults are the existing T+44h / 3h round bounds.
    assert.equal(REAL_MIN_ROUND_WALL_MS, SIX_HOURS_MS, "the REAL floor is exactly 6h");
    assert.equal(REAL_CAMPAIGN_BOUND_MS, 44 * 60 * 60 * 1000, "the campaign-level bound stays T+44h");
    assert.equal(SCRIPTED_ROUND_WALL_DEFAULTS.A, 44 * 60 * 60 * 1000);
    assert.equal(SCRIPTED_ROUND_WALL_DEFAULTS.B, 3 * 60 * 60 * 1000);
    assert.deepEqual([...ROUND_WALL_ROUNDS], ["A", "B"]);

    // parseRoundWallMs: absent -> null; positive integer -> number; anything
    // else refuses TT_USAGE.
    assert.equal(parseRoundWallMs(), null);
    assert.equal(parseRoundWallMs(null), null);
    assert.equal(parseRoundWallMs(""), null);
    assert.equal(parseRoundWallMs(1000), 1000);
    assert.equal(parseRoundWallMs("21600000"), 21_600_000);
    for (const bad of [0, -1, 1.5, "abc", "12.5", NaN, Infinity]) {
      assert.throws(
        () => parseRoundWallMs(bad as any),
        (err: any) => err?.code === "TT_USAGE",
        `parseRoundWallMs(${JSON.stringify(bad)}) must refuse TT_USAGE`,
      );
    }

    // REAL with NO configured cap: the campaign-level wedge is the bound; the
    // effective window is never the scripted 3h Round-B corridor and is at or
    // above the 6h floor.
    for (const round of ["A", "B"] as const) {
      const noCap = resolveRoundWallBudget({ profile: REAL, round });
      assert.equal(noCap.ok, true, `REAL ${round} with no cap is admitted`);
      assert.equal(noCap.source, "campaign_wedge");
      assert.equal(noCap.effectiveWindowMs, REAL_CAMPAIGN_BOUND_MS);
      assert.ok(
        (noCap.effectiveWindowMs as number) >= REAL_MIN_ROUND_WALL_MS,
        `REAL ${round} applies no per-round cap below 6h`,
      );
      assert.notEqual(noCap.effectiveWindowMs, SCRIPTED_ROUND_WALL_DEFAULTS.B, "the 3h scripted corridor is not a REAL cap");
    }

    // REAL with a configured cap: at/above the floor is accepted; below is
    // refused with TT_USAGE and a reason naming the 6h floor.
    const exact = resolveRoundWallBudget({ profile: REAL, round: "A", configuredWallMs: SIX_HOURS_MS });
    assert.equal(exact.ok, true);
    assert.equal(exact.source, "configured");
    assert.equal(exact.effectiveWindowMs, SIX_HOURS_MS);
    const above = resolveRoundWallBudget({ profile: REAL, round: "B", configuredWallMs: 12 * 60 * 60 * 1000 });
    assert.equal(above.ok, true);
    assert.equal(above.effectiveWindowMs, 12 * 60 * 60 * 1000);
    const below = resolveRoundWallBudget({ profile: REAL, round: "A", configuredWallMs: SIX_HOURS_MS - 1 });
    assert.equal(below.ok, false);
    assert.equal(below.code, "TT_USAGE");
    assert.match(String(below.reason), /6h|21600000/);
    const malformed = resolveRoundWallBudget({ profile: REAL, round: "A", configuredWallMs: "nope" });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, "TT_USAGE");

    // SCRIPTED_REHEARSAL: the existing round defaults are unchanged; a
    // configured value is accepted verbatim even below 6h (the floor is a
    // REAL-only rule).
    const scriptedA = resolveRoundWallBudget({ profile: SCRIPTED_REHEARSAL, round: "A" });
    assert.equal(scriptedA.ok, true);
    assert.equal(scriptedA.source, "scripted_default");
    assert.equal(scriptedA.effectiveWindowMs, SCRIPTED_ROUND_WALL_DEFAULTS.A);
    const scriptedB = resolveRoundWallBudget({ profile: SCRIPTED_REHEARSAL, round: "B" });
    assert.equal(scriptedB.effectiveWindowMs, SCRIPTED_ROUND_WALL_DEFAULTS.B);
    const scriptedConfigured = resolveRoundWallBudget({ profile: SCRIPTED_REHEARSAL, round: "B", configuredWallMs: 1000 });
    assert.equal(scriptedConfigured.ok, true);
    assert.equal(scriptedConfigured.source, "configured");
    assert.equal(scriptedConfigured.effectiveWindowMs, 1000);

    // Round/profile validation.
    assert.throws(() => resolveRoundWallBudget({ profile: REAL, round: "C" }), (e: any) => e?.code === "TT_USAGE");
    const noProfile = resolveRoundWallBudget({ profile: null, round: "A" });
    assert.equal(noProfile.ok, false);
    assert.equal(noProfile.code, "TT_USAGE");
  });

  it("U2: the detached-launch invocation is platform-selected and forwards the run argv without --detach", () => {
    assert.equal(detachLauncherForPlatform("linux"), DETACH_LAUNCHER_SETSID);
    assert.equal(detachLauncherForPlatform("darwin"), DETACH_LAUNCHER_NOHUP);
    assert.equal(detachLauncherForPlatform("freebsd"), DETACH_LAUNCHER_NOHUP);

    const campaignDir = "/tmp/owned-var/results/storm-campaign";
    const logs = detachedRunLogPaths({ campaignDir, round: "B", at: "2026-09-23T18:51:11.432Z" });
    assert.equal(logs.dir, path.join(campaignDir, "logs"));
    assert.ok(logs.stdout.startsWith(path.join(campaignDir, "logs") + path.sep), "stdout is inside the campaign logs dir");
    assert.ok(logs.stderr.startsWith(path.join(campaignDir, "logs") + path.sep), "stderr is inside the campaign logs dir");
    assert.match(logs.stdout, /run-B\.detached\./);
    assert.match(logs.stderr, /\.err\.log$/);
    assert.throws(() => detachedRunLogPaths({ campaignDir: "", round: "A" }), (e: any) => e?.code === "TT_USAGE");

    const rawArgv = [
      "run",
      "--campaign",
      campaignDir,
      "--round",
      "B",
      "--spend-cap-tokens",
      "200000000",
      "--round-wall-ms",
      "21600000",
      "--detach",
    ];
    assert.deepEqual(
      stripDetachFlag(rawArgv),
      ["run", "--campaign", campaignDir, "--round", "B", "--spend-cap-tokens", "200000000", "--round-wall-ms", "21600000"],
      "stripDetachFlag removes only --detach",
    );

    const inv = buildDetachedRunInvocation({
      nodeBin: "/usr/bin/node",
      cliPath: "/repo/torture-test/bin/tt-storm",
      argv: rawArgv,
      launcher: DETACH_LAUNCHER_SETSID,
      stdoutLog: logs.stdout,
      stderrLog: logs.stderr,
    });
    assert.equal(inv.argv[0], DETACH_LAUNCHER_SETSID);
    assert.deepEqual(inv.argv.slice(0, 3), [DETACH_LAUNCHER_SETSID, "/usr/bin/node", "/repo/torture-test/bin/tt-storm"]);
    assert.ok(inv.argv.includes("--campaign") && inv.argv.includes("--round"), "the run options are forwarded");
    assert.ok(inv.argv.includes("--spend-cap-tokens") && inv.argv.includes("--round-wall-ms"));
    assert.ok(!inv.argv.includes("--detach"), "the child never re-detaches (no recursion)");
    assert.equal(inv.stdoutLog, logs.stdout);
    assert.equal(inv.stderrLog, logs.stderr);

    const nohupInv = buildDetachedRunInvocation({
      nodeBin: "/usr/bin/node",
      cliPath: "/repo/torture-test/bin/tt-storm",
      argv: ["run", "--campaign", campaignDir, "--round", "A"],
      launcher: DETACH_LAUNCHER_NOHUP,
      stdoutLog: logs.stdout,
      stderrLog: logs.stderr,
    });
    assert.equal(nohupInv.argv[0], DETACH_LAUNCHER_NOHUP);
    assert.equal(nohupInv.argv[1], "/usr/bin/node", "nohup execs the round directly (no launcher flags)");

    // Refusals: a missing binary/CLI/log path or an unknown launcher.
    for (const bad of [
      { nodeBin: "", cliPath: "/c", stdoutLog: "/a", stderrLog: "/b" },
      { nodeBin: "/n", cliPath: "", stdoutLog: "/a", stderrLog: "/b" },
      { nodeBin: "/n", cliPath: "/c", stdoutLog: "", stderrLog: "/b" },
      { nodeBin: "/n", cliPath: "/c", stdoutLog: "/a", stderrLog: "" },
      { nodeBin: "/n", cliPath: "/c", stdoutLog: "/a", stderrLog: "/b", launcher: "tmux" },
    ]) {
      assert.throws(
        () => buildDetachedRunInvocation(bad as any),
        (e: any) => e?.code === "TT_USAGE",
        `buildDetachedRunInvocation(${JSON.stringify(bad)}) must refuse TT_USAGE`,
      );
    }
  });

  it("U3: the CLI applies the budget guard before any launch (bad value exit 4; valid value reaches the qualification gate)", () => {
    const scratch = ownedScratch("cli");
    const scratchVar = path.join(scratch, "var");
    try {
      const prepared = runCli(scratchVar, ["prepare"]);
      assert.equal(prepared.status, 0, `scripted prepare must succeed:\n${prepared.stdout}\n${prepared.stderr}`);
      const campaignDir = findCampaignDir(scratchVar);

      for (const bad of ["0", "-5", "1.5", "nope"]) {
        const refused = runCli(scratchVar, ["run", "--campaign", campaignDir, "--round", "A", "--round-wall-ms", bad]);
        assert.equal(refused.status, 4, `--round-wall-ms ${bad} must refuse exit 4:\n${refused.stdout}\n${refused.stderr}`);
        assert.match(refused.stderr, /round-wall-ms|REAL per-round wall cap/i);
      }

      // A valid value is accepted by the budget guard; the campaign is still
      // unqualified, so the run stops at the qualification gate (exit 3), not a
      // usage error (exit 4).
      const accepted = runCli(scratchVar, ["run", "--campaign", campaignDir, "--round", "A", "--round-wall-ms", "21600000"]);
      assert.equal(accepted.status, 3, `a valid --round-wall-ms proceeds to the unqualified refusal:\n${accepted.stdout}\n${accepted.stderr}`);
      assert.match(accepted.stderr, /not-yet-qualified/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});