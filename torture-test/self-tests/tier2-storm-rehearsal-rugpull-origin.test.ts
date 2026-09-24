// Tier-2 STORM-REHEARSAL US-002 (SF-14) — tt-chaos colleague-commit can
// fast-forward the owned origin's target branch.
//
// Attempt 7 recorded SF-14 NOT EXERCISED: `mass_rugpull` made a colleague
// commit in the sibling clone but never pushed, so the owned origin's
// refs/heads/main never moved and the product never observed merge.target_moved
// (relaunch-upon-rugpull). This test pins the new capability at the operator
// seam, with the REAL git binary and the REAL tt-chaos subprocess:
//
//   * colleagueCommit --push-origin <origin> [--ref <branch>] runs
//     `git push <origin> HEAD:refs/heads/<ref>` AFTER the local commit and is
//     fail-closed (structured chaos.log outcome + non-zero exit) on a missing
//     origin path, a missing origin ref, a non-fast-forward target, a rejected
//     push, or a ref that did not advance;
//   * provisionOwnedGitFixture configures the owned non-bare origin with
//     receive.denyCurrentBranch=ignore so the fast-forward push advances
//     refs/heads/main WITHOUT touching the origin working tree (the checkout
//     must stay available for the B-park dirtiness);
//   * the TT_ROOT containment guard also covers --push-origin.
//
// This file is hermetic: a private temp TT_ROOT + git fixture + campaign DB
// row. No daemon, scheduler, harness, model token or production port is ever
// touched. It spawns only local `git` and the local tt-chaos Node operator.
//
// Coverage:
//   R1  provisionOwnedGitFixture sets receive.denyCurrentBranch=ignore;
//   R2  colleague-commit defaults --ref to main, fast-forwards origin/main to
//       the colleague commit, and leaves the origin working tree byte-unchanged
//       (only the expected index-vs-HEAD divergence of denyCurrentBranch=ignore);
//   R3  explicit --ref main is accepted and fast-forwards the same way;
//   R4  a divergent origin (advanced independently after the colleague seed,
//       the real campaign shape) is rebased onto the current origin tip, then
//       the push is a TRUE fast-forward; the colleague's own commits are
//       preserved;
//   R4b a rebase conflict is refused `rebase_conflict` with origin untouched;
//   R5  a missing origin ref is refused (origin_ref_missing);
//   R6  a missing origin path is refused (push_target_not_found);
//   R7  an invalid --ref name is refused (invalid_ref);
//   R8  a --push-origin outside TT_ROOT is refused by the containment guard;
//   R9  without --push-origin the local-commit-only behaviour is unchanged;
//   R13 no --force / --force-with-lease and no forced refspec in the push path.
//
// US-001 (SF-14-REMAINING-2) adds the fixture-scoped identity contract:
//   I1  FIXTURE_GIT_IDENTITY + gitIdentityEnv set all four git identity vars
//       and are pure (base env never mutated, inherited identity overridden);
//   I2  classifyGitWriteFailure maps every identity stderr shape to
//       identity_missing and every other failure to rebase_conflict;
//   I3  tt-chaos carries no global git config and routes its rebase/push/commit
//       writes through the single shared identity helper;
//   I4  an identity-error rebase failure is labelled identity_missing (never
//       rebase_conflict) and leaves the owned origin untouched — the tt-chaos
//       wiring of the classifier, proven with a git shim that emits the exact
//       "Committer identity unknown" stderr.
//
// US-002 (SF-14-REMAINING-2) adds the REAL campaign fixture shape, which run
// #74's live E2E missed because its fixture happened to have an identity:
//   R14 the colleague clone has no local user.name/user.email and the child
//       env handed to tt-chaos has no GIT_AUTHOR_*/GIT_COMMITTER_*, no EMAIL,
//       GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1 and an empty HOME —
//       and git genuinely cannot resolve an identity in that shape;
//   R15 the PRE-FIX identity-less rebase (`git rebase FETCH_HEAD` with that
//       same env and no injected identity) fails with an identity error and
//       never moves origin — the regression this fix closes;
//   R16 with no identity anywhere tt-chaos rebases the colleague commit onto
//       the advanced origin/main and pushes a TRUE fast-forward (fired,
//       rebased:true, originAfter == origin refs/heads/main, no
//       rebase_conflict), and never writes clone/global git config.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import {
  FIXTURE_GIT_IDENTITY,
  classifyGitWriteFailure,
  gitIdentityEnv,
  spawnCapture,
} from "../bin/tt-storm-shared.mjs";
import { provisionOwnedGitFixture, assertLaunchOriginContained } from "../bin/tt-storm-rehearsal.mjs";
import {
  actionPlan,
  buildChaosArgv,
  dispatchPhaseAction,
  ownedLaunchRoots,
} from "../bin/tt-storm-engine.mjs";

const repoRoot = process.cwd();
const ttChaos = path.join(repoRoot, "torture-test", "bin", "tt-chaos");

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

function commitDirect(origin: string, rel: string, line: string): string {
  fs.appendFileSync(path.join(origin, rel), line);
  const env = {
    GIT_AUTHOR_NAME: "tt-origin", GIT_AUTHOR_EMAIL: "tt-origin@tamandua.test",
    GIT_COMMITTER_NAME: "tt-origin", GIT_COMMITTER_EMAIL: "tt-origin@tamandua.test",
  };
  assert.equal(git(origin, ["add", "--", rel], env).status, 0, "origin add");
  assert.equal(git(origin, ["commit", "-q", "-m", "origin advance"], env).status, 0, "origin commit");
  return revParse(origin, "HEAD");
}

// SHA-256 of every non-.git file under the working tree, keyed by relative
// path — the exact bytes a push must not disturb.
function hashWorktree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) {
        out.set(path.relative(root, abs), createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

// porcelain lines that represent a WORKING-TREE change (second column) or an
// untracked file. Under receive.denyCurrentBranch=ignore a push leaves the
// index/working tree alone, so this must be empty; the observed `M ` first-
// column entry is the expected index-vs-new-HEAD divergence.
function porcelainWorktreeChanges(origin: string): string[] {
  const res = git(origin, ["status", "--porcelain"]);
  assert.equal(res.status, 0, `status in ${origin}: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .filter((line) => (line.startsWith("??") ? true : line.length > 1 && line[1] !== " "));
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

function runTtChaos(
  args: string[],
  extraEnv: Record<string, string>,
  { inherit = true }: { inherit?: boolean } = {},
) {
  const inherited: Record<string, string> = {};
  if (inherit) {
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "NODE_TEST_CONTEXT") continue;
      if (v !== undefined) inherited[k] = v;
    }
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

// The exact git stderr shapes a git WRITE emits when it cannot resolve an
// author/committer identity. The identity-less real campaign shape produces
// "Committer identity unknown" on the rebase replay.
const GIT_IDENTITY_ERROR_TEXT =
  /Committer identity unknown|Author identity unknown|unable to auto-detect email address|empty ident name/i;

// The REAL campaign daemon shape: an env with NO git identity anywhere. Git
// can only resolve an author/committer here through an explicit env var,
// because the global config is /dev/null, the system config is disabled and
// HOME is an empty directory (no ~/.gitconfig). Only the harness env the
// operator genuinely needs survives — the exact shape run #74's live E2E
// missed (its fixture happened to have an identity configured).
function identityFreeHarnessEnv(rig: Rig): Record<string, string> {
  const emptyHome = path.join(rig.scratch, "empty-home");
  fs.mkdirSync(emptyHome, { recursive: true });
  return {
    TAMANDUA_STATE_DIR: rig.env.TAMANDUA_STATE_DIR,
    TT_HOME: rig.env.TT_HOME,
    TT_ROOT: rig.env.TT_ROOT,
    TAMANDUA_DB_PATH: rig.env.TAMANDUA_DB_PATH,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: emptyHome,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

// Assert the exact env handed to the tt-chaos child carries no identity and
// no identity SOURCE: no GIT_AUTHOR_*/GIT_COMMITTER_*, no EMAIL fallback, no
// global config (GIT_CONFIG_GLOBAL=/dev/null), no system config and an empty
// HOME (so no ~/.gitconfig can supply an identity).
function assertNoGitIdentity(env: Record<string, string>) {
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /^GIT_AUTHOR_|^GIT_COMMITTER_/, `the child env must carry no git identity: ${key}`);
  }
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null", "the child env must disable the global git config");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1", "the child env must disable the system git config");
  assert.equal(env.EMAIL, undefined, "the child env must carry no EMAIL fallback identity");
  assert.equal(fs.existsSync(path.join(env.HOME, ".gitconfig")), false, "HOME must be empty (no ~/.gitconfig)");
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

// ─────────────────────────────────────────────────────────────────────
// Fresh owned rig per test: provisioned fixture + campaign DB run row.
// ─────────────────────────────────────────────────────────────────────

async function setupRig(prefix: string): Promise<Rig> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `tt-rugpull-origin-${prefix}-`));
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

// ─────────────────────────────────────────────────────────────────────
// US-003 (SF-14) pure argv / actionPlan projection. The engine MUST build
// the mass_rugpull operator argv from the orchestrator-owned fixture identity
// and REQUIRE the owned --push-origin, so the colleague commit lands on the
// merge TARGET's main rather than only advancing the colleague clone.
// ─────────────────────────────────────────────────────────────────────

function massRugpullIdentity(rig: Rig, { omitOrigin = false } = {}) {
  return {
    colleagueRepo: rig.colleagueRepo,
    cc1File: rig.cc1File,
    cc2File: rig.cc1File,
    parkRepo: rig.parkRepo,
    originRepo: omitOrigin ? null : rig.originRepo,
    seedRef: "seed/storm",
  };
}

function makeBState(fixtureIdentity: any) {
  return {
    campaign_id: "camp-us003-rugpull",
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
  };
}

function makeEngineCtx(rig: Rig, fixtureIdentity: any, proc: any = null) {
  return {
    varRoot: rig.scratch,
    state: makeBState(fixtureIdentity),
    clock: { nowUtc: () => "2026-09-13T00:00:00Z" },
    fs: {},
    proc: proc ?? { chaosAction: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    opts: { fixtureIdentity },
  };
}

describe("STORM-REHEARSAL US-003 (SF-14) engine mass_rugpull argv pushes to the owned origin/main", () => {
  const RUN_B1 = "run-b1";
  const MASS_RUGPULL_ACTION = { kind: "mass_rugpull", targets: ["B1", "B2", "B3", "B4"] };

  it("R10: buildChaosArgv mass_rugpull emits the canonical colleague-commit argv with --push-origin <originRepo> --ref main", async () => {
    const rig = await setupRig("argv");
    try {
      const ident = massRugpullIdentity(rig);
      const ctx = makeEngineCtx(rig, ident);
      const built = buildChaosArgv(ctx as any, ctx.state as any, MASS_RUGPULL_ACTION as any, RUN_B1);
      assert.equal(built.ok, true, `mass_rugpull must build a real operator argv: ${built.reason}`);
      assert.deepEqual(built.argv, [
        "tt-chaos", "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", RUN_B1,
        "--when", "now",
      ]);
      // The push target is the merge-target ORIGIN, never a second local clone.
      assert.equal(built.argv[built.argv.indexOf("--push-origin") + 1], rig.originRepo);
      assert.equal(built.argv[built.argv.indexOf("--ref") + 1], "main");
    } finally {
      cleanup(rig);
    }
  });

  it("R11: actionPlan('mass_rugpull') returns the SAME argv (single source of truth) and the origin is campaign-contained", async () => {
    const rig = await setupRig("plan");
    try {
      const ident = massRugpullIdentity(rig);
      const ctx = makeEngineCtx(rig, ident);
      const built = buildChaosArgv(ctx as any, ctx.state as any, MASS_RUGPULL_ACTION as any, RUN_B1);
      const plan = actionPlan(ctx as any, ctx.state as any, MASS_RUGPULL_ACTION as any);
      assert.equal(plan.ok, true, `actionPlan must build the same argv: ${plan.reason}`);
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0].channel, "chaos");
      assert.deepEqual(plan.steps[0].argv, built.argv, "actionPlan argv is the buildChaosArgv argv (single source of truth)");

      // The owned origin the argv pushes to is contained by the campaign roots.
      const argv = plan.steps[0].argv;
      const pushOrigin = argv[argv.indexOf("--push-origin") + 1];
      assert.equal(pushOrigin, rig.originRepo);
      const roots = ownedLaunchRoots(ctx as any);
      assert.ok(roots.includes(rig.scratch), `owned roots include the campaign var root: ${JSON.stringify(roots)}`);
      const contained = assertLaunchOriginContained({ ownedRoots: roots, originRepository: pushOrigin, fs: REAL_FS, label: "mass_rugpull" });
      assert.equal(contained.ok, true, "the mass_rugpull push origin must be campaign-contained");
      assert.ok(String(contained.originRealpath).startsWith(fs.realpathSync(rig.scratch)), "the contained origin lives under the owned var root");
    } finally {
      cleanup(rig);
    }
  });

  it("R12: missing originRepo yields ok:false naming originRepo and dispatchPhaseAction records NOT_RUN — never a commit-only argv", async () => {
    const rig = await setupRig("noorigin");
    try {
      const ident = massRugpullIdentity(rig, { omitOrigin: true });
      const calls: any[] = [];
      const proc = {
        chaosAction: async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "" }; },
      };
      const ctx = makeEngineCtx(rig, ident, proc);

      // (a) buildChaosArgv fails closed, naming the missing origin, and emits
      // NO argv at all (never a local-commit-only substitute).
      const built = buildChaosArgv(ctx as any, ctx.state as any, MASS_RUGPULL_ACTION as any, RUN_B1);
      assert.equal(built.ok, false);
      assert.match(String(built.reason), /originRepo/, `the reason must name the missing origin: ${built.reason}`);
      assert.equal(built.argv, undefined, "a missing origin must never yield a commit-only argv");

      // (b) actionPlan propagates the same refusal.
      const plan = actionPlan(ctx as any, ctx.state as any, MASS_RUGPULL_ACTION as any);
      assert.equal(plan.ok, false);
      assert.match(String(plan.reason), /originRepo/);

      // (c) dispatchPhaseAction returns NOT_RUN, records no argv, spawns nothing.
      const records: any[] = [];
      const ops = { record: (kind: string, payload: any) => records.push([kind, payload]) };
      const ph = {
        id: "B-rugpull",
        label: "mass rugpull",
        waitFor: { kind: "step", marker: "B1-B4 pre-finalize" },
        action: MASS_RUGPULL_ACTION,
      };
      const phaseState: any = { id: "B-rugpull", status: "pending", ops: [] };
      const disp = await dispatchPhaseAction(ctx as any, ctx.state as any, ops as any, ph as any, phaseState, null);
      assert.equal(disp.notRun, true, "a mass_rugpull without an owned origin is NOT_RUN");
      assert.match(String(disp.reason), /originRepo/);
      assert.deepEqual(disp.record.argv, [], "the NOT_RUN dispatch record carries no argv");
      assert.equal(calls.length, 0, "no tt-chaos process is spawned for a NOT_RUN mass_rugpull");
    } finally {
      cleanup(rig);
    }
  });
});

describe("STORM-REHEARSAL US-002 (SF-14) tt-chaos colleague-commit → owned origin fast-forward", () => {
  it("R1: provisionOwnedGitFixture configures the non-bare origin with receive.denyCurrentBranch=ignore", async () => {
    const rig = await setupRig("config");
    try {
      const res = git(rig.originRepo, ["config", "--get", "receive.denyCurrentBranch"]);
      assert.equal(res.status, 0, `receive.denyCurrentBranch must be set: ${res.stderr}`);
      assert.equal(res.stdout.trim(), "ignore", "the origin must accept a fast-forward push to the checked-out branch");
      // The origin really has main checked out (the B-park target).
      assert.equal(currentBranch(rig.originRepo), "main");
    } finally {
      cleanup(rig);
    }
  });

  it("R2: default ref (main) fast-forwards origin/main; working tree stays byte-unchanged", async () => {
    const rig = await setupRig("default");
    try {
      const beforeBytes = hashWorktree(rig.originRepo);
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      assert.equal(beforeTip, rig.mainHead);

      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.equal(res.status, 0, `default-ref push must succeed: ${res.stderr}`);

      const colleagueHead = revParse(rig.colleagueRepo, "HEAD");
      const originTip = revParse(rig.originRepo, "refs/heads/main");
      assert.equal(originTip, colleagueHead, "origin refs/heads/main must equal the colleague commit");
      assert.notEqual(originTip, beforeTip, "origin main must actually have moved");
      assert.equal(git(rig.originRepo, ["merge-base", "--is-ancestor", beforeTip, colleagueHead]).status, 0,
        "the previous origin tip must be an ancestor of the pushed commit (fast-forward)");

      // Structured outcome carries the observed before/after.
      const fired = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit" && e.outcome === "fired");
      assert.equal(fired.length, 1, "exactly one fired colleague-commit outcome");
      assert.equal(fired[0].pushRef, "main");
      assert.equal(fired[0].originBefore, beforeTip);
      assert.equal(fired[0].originAfter, colleagueHead);

      // Working tree byte-unchanged: identical content hashes, no unstaged or
      // untracked porcelain entries. denyCurrentBranch=ignore leaves the index
      // stale relative to the advanced ref — that index-vs-HEAD divergence is
      // expected and is NOT a working-tree change.
      assert.deepEqual(hashWorktree(rig.originRepo), beforeBytes, "origin working tree bytes must be unchanged by the push");
      assert.equal(git(rig.originRepo, ["diff", "--quiet"]).status, 0, "origin working tree must match its index (no unstaged change)");
      assert.deepEqual(porcelainWorktreeChanges(rig.originRepo), [], "no push-induced working-tree/untracked changes");
    } finally {
      cleanup(rig);
    }
  });

  it("R3: explicit --ref main is accepted and fast-forwards origin/main", async () => {
    const rig = await setupRig("explicit");
    try {
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.equal(res.status, 0, `explicit --ref main push must succeed: ${res.stderr}`);
      const colleagueHead = revParse(rig.colleagueRepo, "HEAD");
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), colleagueHead);
      assert.notEqual(colleagueHead, beforeTip);
    } finally {
      cleanup(rig);
    }
  });

  it("R4: divergent origin is rebased then fast-forwarded (colleague commits preserved)", async () => {
    const rig = await setupRig("rebase");
    try {
      // Advance origin/main independently (real campaign shape: earlier merges
      // already moved the target while the colleague clone still sits on the
      // fixture seed). Use a DIFFERENT file than the colleague edit, so the
      // rebase is a clean replay.
      const originAdvanced = commitDirect(rig.originRepo, "README.md", "origin-side advance\n");
      assert.notEqual(originAdvanced, rig.mainHead);

      // Provably divergent at the start: the origin tip is NOT an ancestor of
      // the colleague clone HEAD (this is what made the fix7 push exit 1).
      assert.notEqual(
        git(rig.colleagueRepo, ["merge-base", "--is-ancestor", originAdvanced, "HEAD"]).status,
        0,
        "the colleague HEAD must NOT be a descendant of the advanced origin before the rebase",
      );

      const sentinel = "REBASE-COLLEAGUE-MARKER-4";
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--line", sentinel,
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.equal(res.status, 0, `a divergent origin must be rebased then fast-forwarded: ${res.stderr}`);

      const colleagueHead = revParse(rig.colleagueRepo, "HEAD");
      // A TRUE fast-forward: the pre-push origin tip is an ancestor of the
      // pushed commit, and the rebased commit sits directly on it.
      assert.equal(
        git(rig.colleagueRepo, ["merge-base", "--is-ancestor", originAdvanced, colleagueHead]).status,
        0,
        "the advanced origin tip must be an ancestor of the rebased colleague commit",
      );
      assert.equal(revParse(rig.colleagueRepo, "HEAD^"), originAdvanced,
        "the rebased colleague commit must sit directly on the advanced origin tip");
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), colleagueHead,
        "origin refs/heads/main must equal the rebased colleague commit");

      // The colleague's OWN earlier commit is preserved by the rebase: its
      // change content is reachable from the rebased HEAD and its commit
      // subject is still in the log.
      const colleagueContent = git(rig.colleagueRepo, ["show", `HEAD:${rig.cc1File}`]).stdout;
      assert.match(colleagueContent, new RegExp(sentinel),
        "the colleague's own change must be reachable from the rebased HEAD");
      assert.match(git(rig.colleagueRepo, ["log", "-1", "--format=%s"]).stdout, /colleague commit/,
        "the rebased commit message must be preserved");

      // Structured outcome records rebased=true, the pre-rebase head and
      // originBefore/originAfter.
      const fired = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit" && e.outcome === "fired");
      assert.equal(fired.length, 1, "exactly one fired colleague-commit outcome");
      assert.equal(fired[0].rebased, true, "the outcome must record that a rebase happened");
      assert.equal(fired[0].pushRef, "main");
      assert.equal(fired[0].originBefore, originAdvanced);
      assert.equal(fired[0].originAfter, colleagueHead);
      assert.match(String(fired[0].preRebaseHead), /^[0-9a-f]{40}$/, "preRebaseHead must be a full commit id");
      assert.notEqual(fired[0].preRebaseHead, colleagueHead, "the rebase rewrites the colleague commit id");
    } finally {
      cleanup(rig);
    }
  });

  it("R4b: a rebase conflict is refused fail-closed (rebase_conflict) and leaves the origin unchanged", async () => {
    const rig = await setupRig("rebaseconflict");
    try {
      // Both the origin advance and the colleague commit append to the SAME
      // file, so replaying the colleague commit onto the advanced tip conflicts.
      const originAdvanced = commitDirect(rig.originRepo, rig.cc1File, "origin-side same-file conflict\n");
      assert.notEqual(originAdvanced, rig.mainHead);

      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--line", "colleague-side same-file conflict",
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.notEqual(res.status, 0, "a rebase conflict must exit non-zero");
      assert.match(res.stderr, /rebase_conflict/, `stderr must name the refusal: ${res.stderr}`);

      // The origin is untouched and the clone is left clean (no rebase in
      // progress, no half-applied detached HEAD).
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), originAdvanced, "origin main must be untouched on refusal");
      assert.equal(git(rig.colleagueRepo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "main",
        "the failed rebase must be aborted, back on the colleague branch");

      const refused = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit" && e.outcome === "rebase_conflict");
      assert.equal(refused.length, 1, "exactly one rebase_conflict structured outcome");
      assert.equal(refused[0].originBefore, originAdvanced);
      assert.equal(refused[0].pushRef, "main");
      assert.equal(refused[0].rebased, false);
    } finally {
      cleanup(rig);
    }
  });

  it("R5: a missing origin ref is refused fail-closed (origin_ref_missing)", async () => {
    const rig = await setupRig("missingref");
    try {
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--ref", "does-not-exist",
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.notEqual(res.status, 0, "a missing origin ref must exit non-zero");
      assert.match(res.stderr, /origin_ref_missing/, `stderr must name the refusal: ${res.stderr}`);
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "origin main must be untouched");
      const refused = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit" && e.outcome === "origin_ref_missing");
      assert.equal(refused.length, 1);
    } finally {
      cleanup(rig);
    }
  });

  it("R6: a missing origin path is refused fail-closed (push_target_not_found)", async () => {
    const rig = await setupRig("missingorigin");
    try {
      const missing = path.join(rig.scratch, "repos", "not-an-origin");
      assert.equal(fs.existsSync(missing), false);
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", missing,
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.notEqual(res.status, 0, "a missing origin path must exit non-zero");
      assert.match(res.stderr, /push_target_not_found/, `stderr must name the refusal: ${res.stderr}`);
      const refused = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit" && e.outcome === "push_target_not_found");
      assert.equal(refused.length, 1);
    } finally {
      cleanup(rig);
    }
  });

  it("R7: an invalid --ref name is refused fail-closed (invalid_ref)", async () => {
    const rig = await setupRig("invalidref");
    try {
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--ref", "main; touch /tmp/tt-rugpull-should-not-exist",
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.notEqual(res.status, 0, "an invalid ref name must exit non-zero");
      assert.match(res.stderr, /invalid_ref/, `stderr must name the refusal: ${res.stderr}`);
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "origin main must be untouched");
    } finally {
      cleanup(rig);
    }
  });

  it("R8: a --push-origin outside TT_ROOT is refused by the containment guard (exit 3)", async () => {
    const rig = await setupRig("outofroot");
    try {
      // Put the colleague repo inside a sandbox TT_ROOT while the origin stays
      // outside it, so the repo passes containment and only --push-origin fails.
      const sandbox = path.join(rig.scratch, "sandbox");
      fs.mkdirSync(sandbox, { recursive: true });
      const containedColleague = path.join(sandbox, "colleague");
      fs.renameSync(rig.colleagueRepo, containedColleague);
      const narrowed = { ...rig.env, TT_ROOT: sandbox };
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", containedColleague,
        "--file", rig.cc1File,
        "--push-origin", rig.originRepo,
        "--run", rig.fullRunId,
        "--when", "now",
      ], narrowed);
      assert.equal(res.status, 3, `an out-of-root push origin must GUARD_MISS: ${res.stderr}`);
      assert.match(res.stderr, /is not under/, `stderr must name the containment refusal: ${res.stderr}`);
      assert.ok(res.stderr.includes(rig.originRepo), `the refusal must name the --push-origin path: ${res.stderr}`);
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "origin main must be untouched");
    } finally {
      cleanup(rig);
    }
  });

  it("R9: without --push-origin the local-commit-only behaviour is unchanged", async () => {
    const rig = await setupRig("localonly");
    try {
      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--run", rig.fullRunId,
        "--when", "now",
      ], rig.env);
      assert.equal(res.status, 0, `local-only colleague-commit must succeed: ${res.stderr}`);
      const colleagueHead = revParse(rig.colleagueRepo, "HEAD");
      assert.notEqual(colleagueHead, beforeTip, "the colleague clone advanced locally");
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "origin main must be untouched without --push-origin");
    } finally {
      cleanup(rig);
    }
  });

  it("R13: no --force / --force-with-lease and no forced refspec in the push path", () => {
    const src = fs.readFileSync(ttChaos, "utf8");
    // Exactly one push invocation and it must be the plain fast-forward refspec
    // `HEAD:refs/heads/<ref>` with no extra (force) flags.
    const pushCalls = src.match(/'push',\s*'--porcelain',\s*originPath,\s*`HEAD:refs\/heads\/\$\{pushRef\}`/g) ?? [];
    assert.equal(pushCalls.length, 1, "exactly one push invocation, using the plain HEAD:refs/heads/<ref> refspec");
    // No force refspec (+) and no quoted force argv token anywhere in the operator.
    assert.doesNotMatch(src, /\+HEAD:refs/, "the push refspec must never be force-prefixed with '+'");
    assert.doesNotMatch(src, /['"`]-{1,2}force(?:-with-lease)?['"`]/, "tt-chaos must never pass a --force / -f push argv token");
  });
});

describe("STORM-REHEARSAL US-001 (SF-14-REMAINING-2) fixture-scoped git identity + identity-vs-conflict classification", () => {
  it("I1: gitIdentityEnv applies the single fixture-scoped identity to every write env and never mutates the base env", () => {
    assert.equal(typeof FIXTURE_GIT_IDENTITY.name, "string");
    assert.ok(FIXTURE_GIT_IDENTITY.name.length > 0, "identity name must be set");
    assert.match(FIXTURE_GIT_IDENTITY.email, /^[^@\s]+@[^@\s]+$/, "identity email must look like an email");
    assert.ok(Object.isFrozen(FIXTURE_GIT_IDENTITY), "the fixture identity is a frozen constant");

    const base = { PATH: "/usr/bin", GIT_AUTHOR_NAME: "stale-operator", GIT_COMMITTER_EMAIL: "stale@example.test" };
    const env = gitIdentityEnv(base);
    assert.equal(env.PATH, "/usr/bin", "unrelated env survives");
    assert.equal(env.GIT_AUTHOR_NAME, FIXTURE_GIT_IDENTITY.name);
    assert.equal(env.GIT_AUTHOR_EMAIL, FIXTURE_GIT_IDENTITY.email);
    assert.equal(env.GIT_COMMITTER_NAME, FIXTURE_GIT_IDENTITY.name);
    assert.equal(env.GIT_COMMITTER_EMAIL, FIXTURE_GIT_IDENTITY.email);
    // A stale/foreign identity in the base env is always overridden.
    assert.notEqual(env.GIT_AUTHOR_NAME, "stale-operator");
    assert.notEqual(env.GIT_COMMITTER_EMAIL, "stale@example.test");
    // Pure: the caller's object is untouched.
    assert.equal(base.GIT_AUTHOR_NAME, "stale-operator");
    assert.equal(base.GIT_COMMITTER_EMAIL, "stale@example.test");
  });

  it("I2: classifyGitWriteFailure maps every identity-error shape to identity_missing and every other failure to rebase_conflict", () => {
    const identityStderr = [
      "Committer identity unknown",
      "*** Please tell me who you are.\n\nfatal: Author identity unknown",
      "fatal: unable to auto-detect email address (got 'root@host.(none)')",
      "fatal: empty ident name (for <>) not allowed",
      "error: Committer identity unknown\n",
    ];
    for (const s of identityStderr) {
      assert.equal(classifyGitWriteFailure(s), "identity_missing", `must classify as identity_missing: ${JSON.stringify(s)}`);
    }
    const otherFailures = [
      "CONFLICT (content): Merge conflict in torture-test/fixtures/f-cc1.txt",
      "error: could not apply 0a1b2c3... chaos: colleague commit",
      "fatal: Not possible to fast-forward, aborting.",
      "",
      undefined,
      null,
    ];
    for (const s of otherFailures) {
      assert.equal(classifyGitWriteFailure(s as any), "rebase_conflict", `must classify as rebase_conflict: ${JSON.stringify(s)}`);
    }
  });

  it("I3: tt-chaos has no global git config and routes every commit/rebase/push write through the shared identity helper", () => {
    const src = fs.readFileSync(ttChaos, "utf8");
    assert.doesNotMatch(src, /--global/, "tt-chaos must never write global git config");
    // The identity env vars are never literal at a tt-chaos call site: they live
    // only in the shared helper.
    assert.doesNotMatch(src, /GIT_AUTHOR_NAME\s*:/, "the identity literals belong to the shared helper");
    assert.doesNotMatch(src, /GIT_COMMITTER_NAME\s*:/, "the identity literals belong to the shared helper");
    // Colleague commit, rebase and push all use the helper-built env.
    assert.match(src, /commit -m[\s\S]{0,220}gitIdentityEnv\(process\.env\)/, "the colleague commit must use the identity helper");
    assert.match(src, /'rebase', 'FETCH_HEAD'\][\s\S]{0,220}gitIdentityEnv\(/, "the rebase must use the identity helper");
    assert.match(src, /'push', '--porcelain', originPath,[\s\S]{0,220}gitIdentityEnv\(/, "the push must use the identity helper");
    // The rebase-failure classification is wired in.
    assert.match(src, /classifyGitWriteFailure\(rebaseRes\.stderr\)/, "tt-chaos must classify the rebase failure");
    // move-branch's commit-tree / budget update-ref also carry the shared env.
    assert.match(src, /commit-tree[\s\S]{0,320}env: gitEnv/, "commit-tree must use the shared identity env");
    assert.match(src, /update-ref[\s\S]{0,220}env: gitEnv/, "budget update-ref must use the shared identity env");
  });

  it("I4: an identity-error rebase is refused identity_missing (never rebase_conflict) and leaves origin untouched", async () => {
    const rig = await setupRig("identityerr");
    try {
      // Divergent origin so the rebase branch is taken.
      const originAdvanced = commitDirect(rig.originRepo, "README.md", "origin-side identity-error advance\n");
      assert.notEqual(originAdvanced, rig.mainHead);

      // A git shim that delegates every call to the real git EXCEPT the
      // tt-chaos rebase replay, which it makes fail with the exact identity
      // stderr the real campaign shape produced.
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      assert.ok(realGit.startsWith("/"), `could not resolve the real git binary: ${realGit}`);
      const shimDir = path.join(rig.scratch, "git-shim");
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(
        path.join(shimDir, "git"),
        `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$3" = "rebase" ] && [ "$4" = "FETCH_HEAD" ]; then\n  echo "Committer identity unknown" >&2\n  echo "fatal: could not determine committer identity" >&2\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );

      const beforeTip = revParse(rig.originRepo, "refs/heads/main");
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--line", "identity-error-marker",
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", rig.fullRunId,
        "--when", "now",
      ], { ...rig.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` });

      assert.notEqual(res.status, 0, "an identity-error rebase must exit non-zero");
      assert.match(res.stderr, /identity_missing/, `stderr must name identity_missing: ${res.stderr}`);
      assert.doesNotMatch(res.stderr, /rebase_conflict/, `an identity error must never be labelled rebase_conflict: ${res.stderr}`);

      // Origin untouched, and the structured outcome is the identity one.
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), beforeTip, "origin main must be unchanged (same ref)");
      const outcomes = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit");
      const identity = outcomes.filter((e) => e.outcome === "identity_missing");
      assert.equal(identity.length, 1, `exactly one identity_missing outcome: ${JSON.stringify(outcomes)}`);
      assert.equal(identity[0].originBefore, originAdvanced);
      assert.equal(identity[0].rebased, false);
      assert.match(String(identity[0].error), /Committer identity unknown/);
      assert.equal(outcomes.filter((e) => e.outcome === "rebase_conflict").length, 0, "no rebase_conflict outcome exists");
    } finally {
      cleanup(rig);
    }
  });
});

describe("STORM-REHEARSAL US-002 (SF-14-REMAINING-2) real campaign shape: no git identity in the clone or the env", () => {
  it("R14: the colleague clone has no local user.name/user.email and the tt-chaos child env is identity-free (empty HOME, global config disabled)", async () => {
    const rig = await setupRig("noident-shape");
    try {
      // (a) The clone created by provisionOwnedGitFixture carries NO local
      //     identity: the fixture helper passes the identity only as env to its
      //     own git calls, so nothing was written into the clone config.
      assert.notEqual(
        git(rig.colleagueRepo, ["config", "--local", "--get", "user.name"]).status,
        0,
        "the colleague clone must have no local user.name",
      );
      assert.notEqual(
        git(rig.colleagueRepo, ["config", "--local", "--get", "user.email"]).status,
        0,
        "the colleague clone must have no local user.email",
      );
      // Merged local+global+system resolution yields nothing either.
      assert.notEqual(
        git(rig.colleagueRepo, ["config", "--get", "user.name"]).status,
        0,
        "no identity may resolve for the colleague clone",
      );

      // (b) The exact env handed to the tt-chaos child carries no identity and
      //     no identity SOURCE.
      const env = identityFreeHarnessEnv(rig);
      assertNoGitIdentity(env);
      assert.equal(env.HOME, path.join(rig.scratch, "empty-home"), "HOME must be the empty scratch dir");
      assert.ok(env.TT_ROOT && env.TAMANDUA_DB_PATH && env.PATH, "the harness env the operator needs survives");

      // (c) Prove git genuinely cannot resolve an identity in that shape: a raw
      //     commit in the clone with exactly that env fails with the pre-fix
      //     stderr shape.
      const raw = spawnSync("git", ["-C", rig.colleagueRepo, "commit", "--allow-empty", "-m", "no identity"], {
        encoding: "utf8",
        env,
      });
      assert.notEqual(raw.status, 0, "with no identity anywhere a raw commit must fail");
      assert.match(String(raw.stderr), GIT_IDENTITY_ERROR_TEXT, `the raw commit must fail on identity: ${raw.stderr}`);
    } finally {
      cleanup(rig);
    }
  });

  it("R15: the pre-fix identity-less rebase (same env, no injected identity) fails on identity and never moves origin", async () => {
    const rig = await setupRig("noident-prefix");
    try {
      const env = identityFreeHarnessEnv(rig);
      assertNoGitIdentity(env);

      // Real campaign shape: origin/main advanced independently after the clone
      // seed, so the colleague HEAD is provably not a descendant.
      const originAdvanced = commitDirect(rig.originRepo, "README.md", "origin-side identity-less pre-fix advance\n");
      assert.notEqual(originAdvanced, rig.mainHead);
      assert.notEqual(
        git(rig.colleagueRepo, ["merge-base", "--is-ancestor", originAdvanced, "HEAD"]).status,
        0,
        "the colleague HEAD must NOT be a descendant of the advanced origin before the pre-fix rebase",
      );

      // A colleague commit made with an explicit identity: this is exactly what
      // the PRE-FIX operator did successfully. Only the replay lacked identity.
      const colleaguePreFix = commitDirect(rig.colleagueRepo, rig.cc1File, "colleague pre-fix commit\n");
      assert.notEqual(colleaguePreFix, rig.mainHead);

      // Reproduce the PRE-FIX rebase path EXACTLY: feed the live origin tip
      // into the clone, then `git rebase FETCH_HEAD` with the identity-free env
      // and no injected identity (the old tt-chaos spawn env).
      const fetchRes = spawnSync(
        "git",
        ["-C", rig.colleagueRepo, "fetch", "--no-tags", rig.originRepo, "refs/heads/main"],
        { encoding: "utf8", env },
      );
      assert.equal(fetchRes.status, 0, `pre-fix fetch: ${fetchRes.stderr}`);
      const preFix = spawnSync("git", ["-C", rig.colleagueRepo, "rebase", "FETCH_HEAD"], { encoding: "utf8", env });
      assert.notEqual(preFix.status, 0, "the identity-less pre-fix rebase must fail");
      assert.match(String(preFix.stderr), GIT_IDENTITY_ERROR_TEXT, `the pre-fix rebase must fail on identity: ${preFix.stderr}`);
      assert.match(
        String(preFix.stderr),
        /Committer identity unknown|Author identity unknown/,
        `the pre-fix failure must be the exact identity shape run #74 missed: ${preFix.stderr}`,
      );

      // Origin is untouched by the failed pre-fix path, and the clone is left
      // clean (abort the in-progress rebase exactly as tt-chaos does).
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), originAdvanced, "the pre-fix failure must never move origin");
      spawnSync("git", ["-C", rig.colleagueRepo, "rebase", "--abort"], { encoding: "utf8", env });
      assert.equal(currentBranch(rig.colleagueRepo), "main", "the aborted rebase must leave the colleague on main");
      assert.equal(revParse(rig.colleagueRepo, "HEAD"), colleaguePreFix, "the abort must restore the pre-fix colleague commit");
    } finally {
      cleanup(rig);
    }
  });

  it("R16: identity-less real campaign shape: tt-chaos rebases and pushes a TRUE fast-forward (fired, rebased:true, no rebase_conflict)", async () => {
    const rig = await setupRig("noident-live");
    try {
      const env = identityFreeHarnessEnv(rig);
      assertNoGitIdentity(env);

      const originAdvanced = commitDirect(rig.originRepo, "README.md", "origin-side identity-less live advance\n");
      assert.notEqual(originAdvanced, rig.mainHead);
      assert.notEqual(
        git(rig.colleagueRepo, ["merge-base", "--is-ancestor", originAdvanced, "HEAD"]).status,
        0,
        "the colleague HEAD must be divergent before the run",
      );

      const sentinel = "IDENTITY-LESS-REAL-CAMPAIGN-16";
      const res = runTtChaos([
        "colleague-commit",
        "--repo", rig.colleagueRepo,
        "--file", rig.cc1File,
        "--line", sentinel,
        "--push-origin", rig.originRepo,
        "--ref", "main",
        "--run", rig.fullRunId,
        "--when", "now",
      ], env, { inherit: false });
      assert.equal(res.status, 0, `the identity-less rebase+push must succeed: ${res.stderr}`);
      assert.doesNotMatch(res.stderr, GIT_IDENTITY_ERROR_TEXT, `no identity error may surface: ${res.stderr}`);

      const rebasedHead = revParse(rig.colleagueRepo, "HEAD");
      // TRUE fast-forward: the advanced origin tip is an ancestor of the pushed
      // commit, the rebased colleague commit sits directly on it, and origin
      // main equals the rebased HEAD.
      assert.equal(revParse(rig.originRepo, "refs/heads/main"), rebasedHead,
        "origin refs/heads/main must equal the rebased colleague HEAD");
      assert.equal(
        git(rig.colleagueRepo, ["merge-base", "--is-ancestor", originAdvanced, rebasedHead]).status,
        0,
        "the advanced origin tip must be an ancestor of the rebased commit (true fast-forward)",
      );
      assert.equal(revParse(rig.colleagueRepo, "HEAD^"), originAdvanced,
        "the rebased commit must sit directly on the advanced origin tip");
      assert.match(
        git(rig.colleagueRepo, ["show", `HEAD:${rig.cc1File}`]).stdout,
        new RegExp(sentinel),
        "the colleague's own change must survive the identity-less rebase",
      );

      // Structured outcome: fired with rebased:true and the observed before/after.
      const entries = chaosLogEntries(rig.scratch).filter((e) => e.action === "colleague-commit");
      assert.equal(entries.filter((e) => e.outcome === "rebase_conflict").length, 0, "no rebase_conflict outcome exists");
      assert.equal(entries.filter((e) => e.outcome === "identity_missing").length, 0, "no identity_missing outcome exists");
      const fired = entries.filter((e) => e.outcome === "fired");
      assert.equal(fired.length, 1, `exactly one fired colleague-commit outcome: ${JSON.stringify(entries)}`);
      assert.equal(fired[0].rebased, true, "the outcome must record the rebase");
      assert.equal(fired[0].pushRef, "main");
      assert.equal(fired[0].originBefore, originAdvanced, "originBefore == the advanced tip");
      assert.equal(fired[0].originAfter, rebasedHead, "originAfter == the rebased colleague HEAD");

      // The identity rode the child env only: neither clone-local nor global
      // git config was mutated by the successful tt-chaos run.
      assert.notEqual(
        git(rig.colleagueRepo, ["config", "--local", "--get", "user.name"]).status,
        0,
        "tt-chaos must not write clone-local user.name",
      );
      assert.notEqual(
        git(rig.colleagueRepo, ["config", "--local", "--get", "user.email"]).status,
        0,
        "tt-chaos must not write clone-local user.email",
      );
    } finally {
      cleanup(rig);
    }
  });
});
