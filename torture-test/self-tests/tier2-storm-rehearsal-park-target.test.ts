// Tier-2 STORM-REHEARSAL US-006 (SF-15) — the B-park dirty-tree action dirties
// the LIVE run's ACTUAL merge target (the owned origin checkout).
//
// Attempt 7 recorded SF-15 NOT OBSERVED: `dirty_tree_park` dirtied the
// unrelated sibling `repos/park` clone while every one of the 12 worktree runs
// merged into `repos/origin`, so no run's merge target was ever dirty and the
// product's park-first landing path was never exercised. This test pins the
// new target at both the pure-argv seam and the REAL git operator seam:
//
//   * buildChaosArgv('dirty_tree_park') resolves the orchestrator-owned ORIGIN
//     checkout (fixtureIdentity.originRepo, the non-bare repo with the merge
//     target branch checked out) as `--repo`, using parkRepo only as a legacy
//     fallback when no origin exists (and failing closed when neither does);
//   * the REAL `tt-chaos dirty-tree` argv leaves the origin with at least one
//     modified tracked file AND one untracked bait file while refs/heads/main
//     is unchanged, and leaves the sibling `repos/park` clone untouched;
//   * phaseTargetRosterIds('dirty_tree_park') returns the shared live merge
//     targets B1..B4, and the derived SCRIPTED_REHEARSAL hold schedule still
//     releases B1..B4 only at B-bounce (B-park's release_targets stays empty).
//
// This file is hermetic: a private temp TT_ROOT + real git fixture + campaign
// DB row. No daemon, scheduler, harness, model token or production port is
// ever touched. It spawns only local `git` and the local tt-chaos Node
// operator, so it must run alone (the npm-style runner keeps spawn-capable
// files serial).
//
// Coverage:
//   P1  buildChaosArgv dirty-tree targets the owned origin, never repos/park;
//   P2  the legacy parkRepo fallback applies only when no origin exists, and
//       both-missing fails closed with a named reason (no empty --repo argv);
//   P3  actionPlan returns the same argv (single source of truth) and the
//       origin is campaign-contained;
//   P4  the REAL operator argv leaves origin with a modified tracked file +
//       untracked bait, main unchanged, and repos/park byte-untouched;
//   P5  phaseTargetRosterIds('dirty_tree_park') returns B1..B4;
//   P6  deriveScriptedHoldSchedule holds B1..B4 through B-park and B-rugpull
//       and releases them only after B-bounce.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";
import {
  assertLaunchOriginContained,
  deriveScriptedHoldSchedule,
  provisionOwnedGitFixture,
} from "../bin/tt-storm-rehearsal.mjs";
import {
  ROUND_B_PHASES,
  actionPlan,
  buildChaosArgv,
  ownedLaunchRoots,
  phaseTargetRosterIds,
  phaseWaitTargetRosterIds,
} from "../bin/tt-storm-engine.mjs";

const repoRoot = process.cwd();
const ttChaos = path.join(repoRoot, "torture-test", "bin", "tt-chaos");

const DIRTY_TREE_ACTION = { kind: "dirty_tree_park" };

// ─────────────────────────────────────────────────────────────────────
// Real git adapter for provisionOwnedGitFixture (hermetic: mergeParentEnv
// false so only the explicit fixture env reaches git).
// ─────────────────────────────────────────────────────────────────────

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

// Direct, synchronous git for the test-side assertions/mutations.
function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function revParse(repo: string, ref: string): string {
  const res = git(repo, ["rev-parse", ref]);
  assert.equal(res.status, 0, `rev-parse ${ref} in ${repo}: ${res.stderr}`);
  return res.stdout.trim();
}

function currentBranch(repo: string): string {
  const res = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(res.status, 0, `rev-parse --abbrev-ref HEAD in ${repo}: ${res.stderr}`);
  return res.stdout.trim();
}

function porcelain(repo: string): string[] {
  const res = git(repo, ["status", "--porcelain"]);
  assert.equal(res.status, 0, `status in ${repo}: ${res.stderr}`);
  return res.stdout.split(/\r?\n/).filter((l) => l.length > 0);
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// SHA-256 of every tracked file in a repo, keyed by its repo-relative path.
function hashTracked(repo: string): Map<string, string> {
  const res = git(repo, ["ls-files"]);
  assert.equal(res.status, 0, `ls-files in ${repo}: ${res.stderr}`);
  const out = new Map<string, string>();
  for (const rel of res.stdout.split(/\r?\n/).filter((l) => l.length > 0)) {
    out.set(rel, sha256File(path.join(repo, rel)));
  }
  return out;
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
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function chaosLogEntries(scratch: string): any[] {
  const logPath = path.join(scratch, "chaos", "chaos.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

interface Rig {
  scratch: string;
  originRepo: string;
  colleagueRepo: string;
  parkRepo: string;
  campaignDb: string;
  fullRunId: string;
  mainHead: string;
  cc1File: string;
  env: Record<string, string>;
}

async function setupRig(prefix: string): Promise<Rig> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `tt-park-target-${prefix}-`));
  const reposRoot = path.join(scratch, "repos");
  fs.mkdirSync(reposRoot, { recursive: true });
  const fixture = await provisionOwnedGitFixture({
    fs: REAL_FS,
    git: makeRealGitAdapter(),
    reposRoot,
    env: { HOME: scratch },
  });
  const stateDir = path.join(scratch, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const uuid = "abcdef01-2345-4678-9abc-def012345678";
  const campaignDb = path.join(scratch, "campaign.db");
  makeRunsDb(campaignDb, [{ id: uuid, status: "running" }]);
  return {
    scratch,
    originRepo: fixture.originRepo,
    colleagueRepo: fixture.colleagueRepo,
    parkRepo: fixture.parkRepo,
    campaignDb,
    fullRunId: `run-${uuid}`,
    mainHead: fixture.mainHead,
    cc1File: fixture.files.cc1,
    env: {
      TAMANDUA_STATE_DIR: stateDir,
      TT_HOME: stateDir,
      TT_ROOT: scratch,
      TAMANDUA_DB_PATH: campaignDb,
    },
  };
}

function cleanup(rig: Rig) {
  fs.rmSync(rig.scratch, { recursive: true, force: true });
}

// The rehearsal-shaped identity: parkRepo === originRepo (SF-15), the sibling
// repos/park path is deliberately NOT used.
function rehearsalIdentity(rig: Rig, { omitOrigin = false, omitPark = false } = {}) {
  return {
    colleagueRepo: rig.colleagueRepo,
    cc1File: rig.cc1File,
    cc2File: rig.cc1File,
    parkRepo: omitPark ? null : (omitOrigin ? rig.parkRepo : rig.originRepo),
    originRepo: omitOrigin ? null : rig.originRepo,
    seedRef: "seed/storm",
  };
}

function makeEngineCtx(rig: Rig, fixtureIdentity: any, proc: any = null) {
  return {
    varRoot: rig.scratch,
    state: {
      campaign_id: "camp-us006-park",
      plan: { fixtureIdentity },
      rounds: {
        A: { runs: {} },
        B: {
          runs: {
            B1: { rosterId: "B1", runId: "run-b1", status: "registered" },
            B2: { rosterId: "B2", runId: "run-b2", status: "registered" },
            B3: { rosterId: "B3", runId: "run-b3", status: "registered" },
            B4: { rosterId: "B4", runId: "run-b4", status: "registered" },
          },
          phases: {},
        },
      },
    },
    clock: { nowUtc: () => "2026-09-13T00:00:00Z" },
    fs: {},
    proc: proc ?? { chaosAction: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    opts: { fixtureIdentity },
  };
}

describe("STORM-REHEARSAL US-006 (SF-15) B-park targets the owned origin checkout", () => {
  const RUN_B4 = "run-b4";

  it("P1: buildChaosArgv dirty_tree_park targets the owned origin (main checked out), never repos/park", async () => {
    const rig = await setupRig("argv");
    try {
      const ident = rehearsalIdentity(rig);
      const ctx = makeEngineCtx(rig, ident);
      const built = buildChaosArgv(ctx as any, ctx.state as any, DIRTY_TREE_ACTION as any, RUN_B4);
      assert.equal(built.ok, true, `dirty-tree must build a real operator argv: ${built.reason}`);
      assert.deepEqual(built.argv, [
        "tt-chaos", "dirty-tree",
        "--repo", rig.originRepo,
        "--run", RUN_B4,
        "--when", "now",
      ]);
      // The merge target really is the owned origin with main checked out.
      assert.equal(currentBranch(rig.originRepo), "main", "the origin has the merge target branch checked out");
      assert.notEqual(built.argv[built.argv.indexOf("--repo") + 1], rig.parkRepo, "the unrelated repos/park clone is never the park target");
      assert.equal(built.argv[built.argv.indexOf("--repo") + 1], rig.originRepo);
    } finally {
      cleanup(rig);
    }
  });

  it("P2: parkRepo is only the legacy fallback; both missing fails closed with a named reason", async () => {
    const rig = await setupRig("fallback");
    try {
      // No origin -> the legacy parkRepo clone is used (compatibility).
      const legacy = makeEngineCtx(rig, rehearsalIdentity(rig, { omitOrigin: true }));
      const builtLegacy = buildChaosArgv(legacy as any, legacy.state as any, DIRTY_TREE_ACTION as any, RUN_B4);
      assert.equal(builtLegacy.ok, true, `legacy parkRepo fallback must still build: ${builtLegacy.reason}`);
      assert.equal(builtLegacy.argv[builtLegacy.argv.indexOf("--repo") + 1], rig.parkRepo, "without an owned origin the legacy parkRepo is the fallback");

      // Neither origin nor parkRepo -> fail closed, never an empty --repo argv.
      const bare = makeEngineCtx(rig, rehearsalIdentity(rig, { omitOrigin: true, omitPark: true }));
      const builtBare = buildChaosArgv(bare as any, bare.state as any, DIRTY_TREE_ACTION as any, RUN_B4);
      assert.equal(builtBare.ok, false, "a campaign with no park identity must be NOT_RUN");
      assert.match(String(builtBare.reason), /originRepo|parkRepo/, `the reason names the missing identity: ${builtBare.reason}`);
      assert.equal(builtBare.argv, undefined, "no argv is emitted without an owned repo");
    } finally {
      cleanup(rig);
    }
  });

  it("P3: actionPlan returns the SAME argv and the origin is campaign-contained", async () => {
    const rig = await setupRig("plan");
    try {
      const ident = rehearsalIdentity(rig);
      const ctx = makeEngineCtx(rig, ident);
      const built = buildChaosArgv(ctx as any, ctx.state as any, DIRTY_TREE_ACTION as any, RUN_B4);
      const plan = actionPlan(ctx as any, ctx.state as any, DIRTY_TREE_ACTION as any);
      assert.equal(plan.ok, true, `actionPlan must build the same argv: ${plan.reason}`);
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0].channel, "chaos");
      assert.deepEqual(plan.steps[0].argv, built.argv, "actionPlan argv is the buildChaosArgv argv (single source of truth)");

      const repo = plan.steps[0].argv[plan.steps[0].argv.indexOf("--repo") + 1];
      assert.equal(repo, rig.originRepo);
      const roots = ownedLaunchRoots(ctx as any);
      assert.ok(roots.includes(rig.scratch), `owned roots include the campaign var root: ${JSON.stringify(roots)}`);
      const contained = assertLaunchOriginContained({ ownedRoots: roots, originRepository: repo, fs: REAL_FS, label: "dirty_tree_park" });
      assert.equal(contained.ok, true, "the park target must be campaign-contained");
    } finally {
      cleanup(rig);
    }
  });

  it("P4: the REAL dirty-tree argv leaves origin dirty (modified tracked + untracked) and refs/heads/main unchanged while repos/park stays clean", async () => {
    const rig = await setupRig("real");
    try {
      const ctx = makeEngineCtx(rig, rehearsalIdentity(rig));
      const built = buildChaosArgv(ctx as any, ctx.state as any, DIRTY_TREE_ACTION as any, rig.fullRunId);
      assert.equal(built.ok, true, `argv must build: ${built.reason}`);

      const beforeTracked = hashTracked(rig.originRepo);
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const beforeParkTip = revParse(rig.parkRepo, "refs/heads/main");
      assert.equal(beforeTip, rig.mainHead);
      assert.deepEqual(porcelain(rig.parkRepo), [], "the sibling park clone starts clean");

      const res = runTtChaos(built.argv.slice(1), rig.env);
      assert.equal(res.status, 0, `the real dirty-tree argv must fire: ${res.stderr}`);

      // (a) main did NOT move — dirtying a working tree is not a ref mutation.
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "dirty-tree must leave refs/heads/main unchanged");

      // (b) origin has BOTH a modified tracked file and an untracked bait file.
      const lines = porcelain(rig.originRepo);
      const modifiedTracked = lines.filter((l) => l.startsWith(" M") || l[1] === "M");
      const untracked = lines.filter((l) => l.startsWith("??"));
      assert.ok(modifiedTracked.length >= 1, `a tracked file must be modified: ${JSON.stringify(lines)}`);
      assert.ok(untracked.length >= 1, `an untracked bait file must exist: ${JSON.stringify(lines)}`);
      const modifiedPath = modifiedTracked[0].slice(3);
      assert.ok(beforeTracked.has(modifiedPath), `the modified file is tracked: ${modifiedPath}`);
      assert.notEqual(sha256File(path.join(rig.originRepo, modifiedPath)), beforeTracked.get(modifiedPath), "the dirty sentinel changed the tracked file bytes");
      const untrackedBait = untracked.find((l) => l.includes("CHAOS_PARK_BAIT.txt"));
      assert.ok(untrackedBait, `the untracked bait file is named: ${JSON.stringify(lines)}`);

      // (c) the structured outcome names the origin repo and the untracked bait.
      const fired = chaosLogEntries(rig.scratch).filter((e) => e.action === "dirty-tree" && e.outcome === "fired");
      assert.equal(fired.length, 1, "exactly one fired dirty-tree outcome");
      assert.ok(String(fired[0].target).startsWith(`repo:${rig.originRepo}`), `the outcome names the owned origin: ${fired[0].target}`);
      assert.ok(String(fired[0].target).includes(modifiedPath), `the outcome names the modified tracked file (${modifiedPath}): ${fired[0].target}`);
      assert.equal(fired[0].untrackedFile, "CHAOS_PARK_BAIT.txt", "the outcome records the untracked bait file");

      // (d) the unrelated sibling park clone is byte-untouched.
      assert.deepEqual(porcelain(rig.parkRepo), [], "repos/park must remain clean (never the action target)");
      assert.equal(revParse(rig.parkRepo, "refs/heads/main"), beforeParkTip, "repos/park HEAD must be untouched");
    } finally {
      cleanup(rig);
    }
  });

  it("P5: phaseTargetRosterIds('dirty_tree_park') returns the shared live merge targets B1..B4", () => {
    assert.deepEqual(phaseTargetRosterIds(DIRTY_TREE_ACTION as any), ["B1", "B2", "B3", "B4"]);
    // The real Round B table action projects the same set (and the derived
    // wait predicate inherits it because B-park declares no predicate target).
    const realPark = ROUND_B_PHASES.find((p: any) => p.id === "B-park");
    assert.ok(realPark, "the real table has B-park");
    assert.deepEqual(phaseTargetRosterIds(realPark.action), ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phaseWaitTargetRosterIds(realPark), ["B1", "B2", "B3", "B4"]);
  });

  it("P6: the derived schedule holds B1..B4 through B-park/B-rugpull and releases them only after B-bounce", () => {
    const phases = deriveScriptedHoldSchedule().round_b.phases;
    const park = phases.find((p: any) => p.id === "B-park");
    const bounce = phases.find((p: any) => p.id === "B-bounce");
    const rugpull = phases.find((p: any) => p.id === "B-rugpull");
    assert.ok(park && bounce && rugpull, "the derived schedule carries B-park, B-rugpull and B-bounce");

    // B-park observes (and therefore holds) the shared merge targets B1..B4.
    assert.deepEqual(park.waitFor.targets, ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(park.release_targets, [], "B-park releases nothing (B1..B4 stay held)");
    assert.deepEqual(rugpull.release_targets, [], "B-rugpull releases nothing (B1..B4 stay held)");

    // B1..B4 are released by their LAST dependent phase, B-bounce.
    for (const rid of ["B1", "B2", "B3", "B4"]) {
      const releasers = phases.filter((p: any) => p.release_targets.includes(rid)).map((p: any) => p.id);
      assert.deepEqual(releasers, ["B-bounce"], `${rid} must be released only at B-bounce: ${JSON.stringify(releasers)}`);
    }
    assert.deepEqual(bounce.release_targets, ["B1", "B2", "B3", "B4"], "B-bounce releases the shared merge targets");

    // B-park fires strictly before the release phase.
    const order = phases.map((p: any) => p.id);
    assert.ok(order.indexOf("B-park") < order.indexOf("B-bounce"), "B-park fires before B-bounce releases the targets");
  });
});
