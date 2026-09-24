// Tier-2 STORM-REHEARSAL US-005 + US-006 — launch-origin wiring (SF-2).
//
// US-005 story: every workflow launch must carry the campaign-owned tiny
// fixture origin via --worktree-origin-repository/--worktree-origin-ref, so the
// product can never default WORKTREE_ORIGIN_REPOSITORY to HOME/cwd and resolve
// ORIGINAL_BRANCH to a foreign repository. A worktree launch with no resolvable
// owned origin refuses (fail closed) instead of emitting an origin-less argv.
//
// US-006 story: a launch is refused BEFORE any spawn unless its RESOLVED
// worktree origin is contained by the campaign's owned roots (var_root /
// rehearsal repos root). This makes the SF-2 mis-resolution (origin == this
// repo / the private HOME) structurally impossible. The refusal is persisted
// first-class (ops.jsonl launch.origin_refused) and the round is left 'failed'
// — never stale 'running', never silently continued.
//
// This file is pure/recording except for the US-006 negative round, which
// drives the REAL stormPrepare + stormRunRoundA against a real temp var root
// with a spy launch adapter. It never spawns a daemon, scheduler, harness or
// model and never touches live ~/.tamandua state.
//
// Coverage:
//   O1  workflowRunArgv appends --worktree-origin-repository + an explicit
//       --worktree-origin-ref exactly when an origin is supplied (ref never
//       omitted);
//   O2  the real roster plan derives each workflow's run.workspace mode;
//   O3  launchArgvFor for every worktree Round A + Round B roster launch
//       carries the owned origin (S7='broken-tests', else 'main'); direct
//       launches carry NO origin flags;
//   O4  the owned origin is read from the campaign state/overlay
//       (rehearsalRunOptsFromState -> fixtureIdentity.originRepo);
//   O4b origin precedence;
//   O5  a worktree launch with no resolvable owned origin refuses
//       TT_ORIGIN_MISSING and produces no argv (never an origin-less launch);
//   O6  assertLaunchOriginContained accepts a realpath-contained owned origin
//       and refuses an origin outside the owned roots (this repo, a symlink
//       escape, or no owned roots at all) with TT_ORIGIN_ESCAPE;
//   O7  stormRunRoundA refuses the exact SF-2 mis-resolution (origin == THIS
//       repo) with TT_ORIGIN_ESCAPE, records the refusal, marks the round
//       failed, and the spy launch adapter records ZERO spawns.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  deriveStormNumbers,
  workflowRunArgv,
} from "../bin/tt-storm-shared.mjs";
import { REAL_FS, STORM_WORKFLOW_IDS } from "../bin/tt-storm-roster.mjs";
import {
  buildLaunchPlan,
  launchArgvFor,
  launchWorkspaceMode,
  resolveOwnedWorktreeOrigin,
  stormPrepare,
  stormRunRoundA,
} from "../bin/tt-storm-engine.mjs";
import {
  assertLaunchOriginContained,
  buildRehearsalScriptedBehaviors,
  deriveFeatureCommitAgent,
  FEATURE_BRANCH_COMMIT_COMMAND,
  MERGER_MERGE_BRANCH_COMMAND,
  ownedRootsForLaunchOrigin,
  parseWorkflowSteps,
  readRehearsalWorkflowTexts,
  rehearsalRunOptsFromState,
} from "../bin/tt-storm-rehearsal.mjs";
import { applyBehaviorActions } from "../scripted-runtimes/runtime-shared.mjs";

const BUNDLED_WORKFLOWS = path.join(process.cwd(), "workflows");
const THIS_REPO = process.cwd();

// The owned fixture origin lives under the campaign var root (the rehearsal
// repos root is allocated UNDER varRoot by allocateRehearsalInputRoots). The
// paths need not exist for the wiring assertions; US-006 realpaths them.
const OWNED_VAR_ROOT = "/var/tt-owned";
const OWNED_REPOS_ROOT = "/var/tt-owned/storm-rehearsal-fix3/inputs/repos";
const OWNED_ORIGIN = `${OWNED_REPOS_ROOT}/origin`;
// SF-12 (fix-6): every launch argv must resolve an ABSOLUTE task file. These
// origin-containment fixtures are about the origin flags, so they supply the
// campaign tasks root the (now fail-closed) task-file resolver falls back to
// for a run-derived absolute path.
const OWNED_TASKS_ROOT = "/var/tt-owned/inputs/tasks";

function ctxWithOrigin(originRepository: string) {
  return {
    varRoot: OWNED_VAR_ROOT,
    opts: { fixtureIdentity: { originRepo: originRepository }, taskFiles: {}, taskFileRoot: OWNED_TASKS_ROOT },
  };
}

function findArg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function refusalFrom(fn: () => any): any {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function realPlan() {
  const numbers = await deriveStormNumbers({
    installedCatalogRoot: null,
    bundledCatalogRoot: BUNDLED_WORKFLOWS,
  });
  return { numbers, plan: buildLaunchPlan(numbers) };
}

function bundledRehearsalTexts(): Record<string, string> {
  return readRehearsalWorkflowTexts({ fs: REAL_FS, roots: [BUNDLED_WORKFLOWS], workflowIds: STORM_WORKFLOW_IDS });
}

// Real git helper for the US-007 end-to-end arm. Every repo lives under the
// test's temp scratch; HOME/config are pinned so the operator's git config can
// never influence the fixture.
function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

// Apply an embedded behavior command string (with {{input.KEY}} resolved) in a
// cwd, exactly the way the scripted runtimes do.
function runBehaviorCommand(command: string, cwd: string, inputVars: Record<string, string>) {
  return applyBehaviorActions({ commands: [command] }, cwd, inputVars);
}

describe("tier2 storm rehearsal US-005 launch origin wiring (SF-2)", () => {
  it("O1: workflowRunArgv appends the owned origin + an explicit ref exactly when supplied", () => {
    const bare = workflowRunArgv({
      workflow: "feature-dev-merge-worktree",
      taskFile: "t.task.md",
      harness: "pi",
      context: [],
    });
    assert.equal(bare.includes("--worktree-origin-repository"), false);
    assert.equal(bare.includes("--worktree-origin-ref"), false);

    const wired = workflowRunArgv({
      workflow: "feature-dev-merge-worktree",
      taskFile: "t.task.md",
      harness: "pi",
      context: [],
      originRepository: OWNED_ORIGIN,
      originRef: "broken-tests",
    });
    assert.equal(findArg(wired, "--worktree-origin-repository"), OWNED_ORIGIN);
    assert.equal(findArg(wired, "--worktree-origin-ref"), "broken-tests");

    // The ref is never omitted: an unspecified ref degrades to main, never to
    // a foreign/detached default.
    const refDefaulted = workflowRunArgv({
      workflow: "feature-dev-merge-worktree",
      taskFile: "t.task.md",
      harness: "pi",
      context: [],
      originRepository: OWNED_ORIGIN,
    });
    assert.equal(findArg(refDefaulted, "--worktree-origin-ref"), "main");
  });

  it("O2: the real roster plan derives run.workspace from each bundled workflow.yml", async () => {
    const { numbers, plan } = await realPlan();
    const worktree = new Set(
      Object.entries(numbers.counts ?? {})
        .filter(([, c]: [string, any]) => c.workspaceMode === "worktree")
        .map(([wf]) => wf),
    );
    for (const wf of [
      "feature-dev-merge-worktree",
      "bug-fix-merge-worktree",
      "security-audit-merge-worktree",
      "quarantine-broken-tests-merge-worktree",
    ]) {
      assert.equal(worktree.has(wf), true, `${wf} must derive run.workspace: worktree`);
    }
    for (const wf of ["do-now", "do-review-do-verify"]) {
      assert.equal(numbers.counts[wf]?.workspaceMode, "direct", `${wf} must derive direct`);
    }
    // Every launch carries the derived mode; no launch is silently mode-less.
    for (const launch of plan.launches) {
      assert.ok(
        launch.workspaceMode === "worktree" || launch.workspaceMode === "direct",
        `${launch.rosterId} must carry a derived workspaceMode`,
      );
      assert.equal(launch.workspaceMode, numbers.counts[launch.workflow]?.workspaceMode, `${launch.rosterId} mode matches its workflow`);
    }
  });

  it("O3: every worktree roster launch carries the owned origin with the right ref", async () => {
    const { plan } = await realPlan();
    const ctx = ctxWithOrigin(OWNED_ORIGIN);
    let worktreeCount = 0;
    let directCount = 0;
    for (const launch of ["A", "B"].flatMap((r) => plan.launches.filter((l: any) => l.round === r))) {
      const argv = launchArgvFor(launch, ctx);
      if (launch.workspaceMode === "worktree") {
        worktreeCount += 1;
        assert.equal(findArg(argv, "--worktree-origin-repository"), OWNED_ORIGIN, `${launch.rosterId} origin`);
        const expectedRef = launch.rosterId === "S7" ? "broken-tests" : "main";
        assert.equal(findArg(argv, "--worktree-origin-ref"), expectedRef, `${launch.rosterId} ref`);
      } else {
        directCount += 1;
        // Direct workflows reject these flags in the product; a worktree flag
        // on a direct launch would break the launch.
        assert.equal(argv.includes("--worktree-origin-repository"), false, `${launch.rosterId} must not carry an origin`);
        assert.equal(argv.includes("--worktree-origin-ref"), false, `${launch.rosterId} must not carry a ref`);
      }
    }
    // Round A S1-S7+S9 (8 worktree) + Round B B1-B4 (4 worktree) = 12;
    // Round A S8/S10 + Round B B5 = 3 direct.
    assert.equal(worktreeCount, 12, "all 12 worktree roster launches carry the origin");
    assert.equal(directCount, 3, "the 3 direct roster launches carry no origin flags");
    const s7 = plan.launches.find((l: any) => l.rosterId === "S7");
    assert.equal(findArg(launchArgvFor(s7, ctx), "--worktree-origin-ref"), "broken-tests");
  });

  it("O4: the owned origin comes from the campaign state/overlay fixtureIdentity", async () => {
    const { plan } = await realPlan();
    const state = {
      campaign_id: "storm-test",
      rehearsal: {
        profile: "SCRIPTED_REHEARSAL",
        label: "test",
        task_manifest: {},
        inputs: {
          tasksRoot: "/var/tt-owned/inputs/tasks",
          reposRoot: OWNED_REPOS_ROOT,
          worktreeRoot: "/var/tt-owned/inputs/worktree",
          fixture: {
            originRepo: OWNED_ORIGIN,
            colleagueRepo: "/var/tt-owned/inputs/repos/colleague",
            parkRepo: "/var/tt-owned/inputs/repos/park",
          },
        },
        // Deliberately omit the top-level fixture_identity so the overlay must
        // fall back to inputs.fixture.originRepo (the persisted rehearsal
        // receipt the story names).
        resource_plan: { daemon: { kind: "scripted" } },
      },
    };
    const overlay = rehearsalRunOptsFromState(state);
    assert.equal(overlay.ok, true, "a prepared rehearsal bundle yields a run overlay");
    assert.equal((overlay as any).opts.fixtureIdentity.originRepo, OWNED_ORIGIN);
    assert.equal((overlay as any).opts.originRepo, OWNED_ORIGIN);
    assert.equal((overlay as any).opts.fixtureIdentity.originRepo, (state as any).rehearsal.inputs.fixture.originRepo);
    assert.equal(resolveOwnedWorktreeOrigin({ opts: (overlay as any).opts, state }), OWNED_ORIGIN);

    const s1 = plan.launches.find((l: any) => l.rosterId === "S1");
    const argv = launchArgvFor(s1, { varRoot: OWNED_VAR_ROOT, opts: (overlay as any).opts, state });
    assert.equal(findArg(argv, "--worktree-origin-repository"), (state as any).rehearsal.inputs.fixture.originRepo);
    assert.equal(findArg(argv, "--worktree-origin-ref"), "main");
  });

  it("O4b: origin precedence is opts.originRepo > fixtureIdentity.originRepo > state.plan.fixtureIdentity.originRepo", () => {
    const state = { plan: { fixtureIdentity: { originRepo: "/state/origin" } } };
    assert.equal(resolveOwnedWorktreeOrigin({ opts: {}, state }), "/state/origin");
    assert.equal(resolveOwnedWorktreeOrigin({ opts: { fixtureIdentity: { originRepo: "/overlay/origin" } }, state }), "/overlay/origin");
    assert.equal(resolveOwnedWorktreeOrigin({ opts: { originRepo: "/explicit/origin", fixtureIdentity: { originRepo: "/overlay/origin" } }, state }), "/explicit/origin");
    assert.equal(resolveOwnedWorktreeOrigin({ opts: {} }), null);
  });

  it("O5: a worktree launch with no resolvable owned origin refuses TT_ORIGIN_MISSING", async () => {
    const { plan } = await realPlan();
    const s1 = plan.launches.find((l: any) => l.rosterId === "S1");
    assert.equal(s1.workspaceMode, "worktree");
    let refused: any = null;
    let argv: string[] | null = null;
    try {
      argv = launchArgvFor(s1, { opts: { taskFiles: {}, taskFileRoot: OWNED_TASKS_ROOT } });
    } catch (err) {
      refused = err;
    }
    assert.equal(argv, null, "no argv may be produced for an origin-less worktree launch");
    assert.ok(refused, "an origin-less worktree launch must refuse");
    assert.equal(refused.code, "TT_ORIGIN_MISSING");
    assert.match(String(refused.message), /worktree origin/i);

    // The same fail-closed rule applies to a launch that declares worktree mode
    // but the campaign state overlays a null origin.
    let refused2: any = null;
    try {
      launchArgvFor(s1, { opts: { fixtureIdentity: { originRepo: null }, taskFiles: {}, taskFileRoot: OWNED_TASKS_ROOT }, state: { plan: { fixtureIdentity: { originRepo: null } } } });
    } catch (err) {
      refused2 = err;
    }
    assert.equal(refused2?.code, "TT_ORIGIN_MISSING");

    // A DIRECT launch with no origin is fine: no worktree flag is emitted.
    const s10 = plan.launches.find((l: any) => l.rosterId === "S10");
    assert.equal(launchWorkspaceMode(s10, { opts: {} }), "direct");
    const directArgv = launchArgvFor(s10, { opts: { taskFiles: {}, taskFileRoot: OWNED_TASKS_ROOT } });
    assert.equal(directArgv.includes("--worktree-origin-repository"), false);
  });
});

describe("tier2 storm rehearsal US-006 launch-origin containment (fail closed)", () => {
  it("O6: assertLaunchOriginContained accepts an owned origin and refuses escapes with TT_ORIGIN_ESCAPE", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-origin-contained-"));
    const varRoot = path.join(tmp, "var");
    const reposRoot = path.join(varRoot, "rehearsal", "camp", "repos");
    const ownedOrigin = path.join(reposRoot, "origin");
    fs.mkdirSync(ownedOrigin, { recursive: true });

    // Accept: realpath under the var root / repos root.
    const ok = assertLaunchOriginContained({ ownedRoots: [varRoot], originRepository: ownedOrigin });
    assert.equal(ok.ok, true);
    assert.ok(ok.rootRealpath.startsWith(fs.realpathSync(varRoot)));
    assert.equal(assertLaunchOriginContained({ execCtx: { var_root: varRoot, repos_root: reposRoot }, originRepository: ownedOrigin }).ok, true);
    assert.deepEqual(ownedRootsForLaunchOrigin({ ownedRoots: [varRoot, varRoot], execCtx: { var_root: varRoot } }), [varRoot]);

    // Refuse: THIS repository is not under the campaign var root (the exact
    // SF-2 mis-resolution to a foreign repo).
    const escaped = refusalFrom(() => assertLaunchOriginContained({ ownedRoots: [varRoot], originRepository: THIS_REPO, label: "test launch" }));
    assert.ok(escaped, "an origin outside the owned roots must refuse");
    assert.equal(escaped.code, "TT_ORIGIN_ESCAPE");
    assert.match(String(escaped.message), /escapes the campaign-owned roots/);

    // Refuse: a lexically-nested symlink whose REAL destination is foreign
    // (realpath on BOTH sides, not just a lexical prefix check).
    const link = path.join(varRoot, "escape-link");
    fs.symlinkSync(THIS_REPO, link);
    const viaLink = refusalFrom(() => assertLaunchOriginContained({ ownedRoots: [varRoot], originRepository: link }));
    assert.equal(viaLink?.code, "TT_ORIGIN_ESCAPE", "a symlink escape is refused by realpath containment");

    // Refuse: no owned roots supplied at all — a launch that cannot PROVE
    // containment must not pass.
    const noRoots = refusalFrom(() => assertLaunchOriginContained({ ownedRoots: [], originRepository: ownedOrigin }));
    assert.equal(noRoots?.code, "TT_ORIGIN_ESCAPE");
    // Refuse: no origin to contain.
    const noOrigin = refusalFrom(() => assertLaunchOriginContained({ ownedRoots: [varRoot], originRepository: null }));
    assert.equal(noOrigin?.code, "TT_ORIGIN_ESCAPE");
  });

  it("O6b: launchArgvFor refuses a worktree origin that resolves to THIS repo (TT_ORIGIN_ESCAPE)", async () => {
    const { plan } = await realPlan();
    const s1 = plan.launches.find((l: any) => l.rosterId === "S1");
    let refused: any = null;
    let argv: string[] | null = null;
    try {
      argv = launchArgvFor(s1, ctxWithOrigin(THIS_REPO));
    } catch (err) {
      refused = err;
    }
    assert.equal(argv, null, "an escaping origin must produce no argv");
    assert.equal(refused?.code, "TT_ORIGIN_ESCAPE");
  });

  it("O7: stormRunRoundA refuses the SF-2 mis-resolution before any spawn and marks the round failed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-origin-round-escape-"));
    const varRoot = path.join(tmp, "var");
    const campaignDir = path.join(varRoot, "results", "storm-origin-escape");
    fs.mkdirSync(varRoot, { recursive: true });

    const spawns: string[][] = [];
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const ctx: any = {
      fs: REAL_FS,
      clock: {
        nowMs: () => nowMs,
        nowUtc: () => new Date(nowMs).toISOString(),
        sleep: async (ms: number) => { nowMs += Math.max(0, ms | 0); },
      },
      proc: {
        launchWorkflow: async (argv: string[]) => {
          spawns.push(argv);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      varRoot,
      campaignDir,
      opts: {
        bundledCatalogRoot: BUNDLED_WORKFLOWS,
        fixture: {},
        // The exact SF-2 mis-resolution: the fixture identity resolves to THIS
        // repository (never to the campaign-owned var root).
        fixtureIdentity: {
          originRepo: THIS_REPO,
          colleagueRepo: null,
          parkRepo: null,
          cc1File: null,
          cc2File: null,
          seedRef: "seed/storm",
        },
      },
    };

    const prepared = await stormPrepare(ctx);
    assert.equal(prepared.state.plan.fixtureIdentity.originRepo, THIS_REPO);

    let refused: any = null;
    try {
      await stormRunRoundA(ctx);
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, "an escaping origin must propagate a refusal");
    assert.equal(refused.code, "TT_ORIGIN_ESCAPE");
    assert.equal(spawns.length, 0, "the recording launch adapter records ZERO spawns");

    // The refusal is first-class in ops.jsonl...
    const ops = fs.readFileSync(path.join(campaignDir, "ops.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const refusalOp = ops.find((o) => o.kind === "launch.origin_refused");
    assert.ok(refusalOp, "launch.origin_refused is persisted in ops.jsonl");
    assert.equal(refusalOp.code, "TT_ORIGIN_ESCAPE");
    assert.equal(refusalOp.round, "A");
    assert.equal(refusalOp.originRepository, THIS_REPO);

    // ...and the round is left failed (never stale 'running').
    const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
    assert.equal(state.rounds.A.status, "failed");
    assert.equal(Object.values(state.rounds.A.runs).filter((r: any) => r.status === "launch_failed").length, 1);
    const failed = Object.values(state.rounds.A.runs).find((r: any) => r.status === "launch_failed") as any;
    assert.equal(failed.launchFailure.code, "TT_ORIGIN_ESCAPE");
    assert.equal(failed.launchFailure.stage, "origin_containment");
  });
});

describe("tier2 storm rehearsal US-007 scripted feature branch + commit (SF-2 completion)", () => {
  it("O8: every merge-family feature agent creates {{input.BRANCH}} and commits; the merger stays the real merge-branch", () => {
    const texts = bundledRehearsalTexts();
    const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: texts });
    const mergeWorkflows = STORM_WORKFLOW_IDS.filter((w) => w.endsWith("-merge-worktree"));
    assert.equal(mergeWorkflows.length, 4, "the roster's four merge-worktree workflows");

    for (const wf of mergeWorkflows) {
      const featureStep = deriveFeatureCommitAgent(parseWorkflowSteps(texts[wf]));
      assert.ok(featureStep?.agent, `${wf} derives a branch-naming feature agent`);
      const behavior = behaviors.agents[`${wf}_${featureStep!.agent}`];
      assert.ok(behavior, `${wf}/${featureStep!.agent} behavior exists`);
      const entries = Array.isArray(behavior) ? behavior : [behavior];
      assert.ok(entries.length >= 1, `${wf} feature agent has at least one entry`);
      for (const entry of entries) {
        assert.ok(Array.isArray(entry.commands), `${wf}/${featureStep!.agent} carries commands`);
        const joined = entry.commands.join("\n");
        assert.ok(joined.includes("git checkout -b"), `${wf} creates the feature branch`);
        assert.ok(joined.includes("{{input.BRANCH}}"), `${wf} branch value comes from {{input.BRANCH}}`);
        assert.ok(/\bgit\b.*\bcommit\b/.test(joined), `${wf} commits a real change`);
        assert.equal(joined.includes("tamandua merge-branch"), false, `${wf} feature agent must not run the merge`);
        // Containment: no command may reference the operator HOME or this repo.
        const home = process.env.HOME ?? "\u0000";
        assert.equal(joined.includes(home), false, `${wf} command never references HOME`);
        assert.equal(joined.includes(THIS_REPO), false, `${wf} command never references the fix worktree repo`);
      }
      // The merger keeps the real, unmodified merge-branch command.
      const merger = behaviors.agents[`${wf}_merger`];
      assert.deepEqual(merger.commands, [MERGER_MERGE_BRANCH_COMMAND], `${wf} merger runs the real merge-branch command`);
      assert.equal(merger.commands[0].includes("tamandua merge-branch"), true);
    }
    assert.ok(FEATURE_BRANCH_COMMIT_COMMAND.includes("git checkout -b"), "exported feature command creates the branch");
  });

  it("O9: in an owned temp origin+worktree the feature commands create the branch+commit and the real merger lands it on ORIGINAL_BRANCH", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tt-us007-branch-"));
    const origin = path.join(scratch, "origin");
    const worktree = path.join(scratch, "worktree");
    const stateHome = path.join(scratch, "home");
    const BRANCH = "feature/scripted-rehearsal";
    const savedEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
    };
    try {
      fs.mkdirSync(origin, { recursive: true });
      git(["init", "-b", "main"], origin);
      fs.writeFileSync(path.join(origin, "README.md"), "owned fixture\n");
      git(["add", "README.md"], origin);
      git(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "init"], origin);
      const initialMain = git(["rev-parse", "refs/heads/main"], origin);

      // The managed worktree starts detached at the origin target (the product
      // creates it that way); the scripted feature agent must create the branch.
      git(["worktree", "add", "--detach", worktree, "main"], origin);
      assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], worktree), "HEAD", "worktree starts detached");

      const behaviors = buildRehearsalScriptedBehaviors({ workflowTexts: bundledRehearsalTexts() });
      const devEntries = behaviors.agents["feature-dev-merge-worktree_developer"];
      assert.ok(Array.isArray(devEntries) && devEntries[0].commands, "developer behavior carries the branch/commit command");

      // Apply the generated feature command exactly as the runtime does.
      runBehaviorCommand(devEntries[0].commands[0], worktree, { BRANCH, WORKTREE_ORIGIN_REPOSITORY: origin, ORIGINAL_BRANCH: "main" });
      assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], worktree), BRANCH, "feature branch checked out");
      const branchTip = git(["rev-parse", `refs/heads/${BRANCH}`], origin);
      assert.match(branchTip, /^[0-9a-f]{40}$/, "feature branch exists in the origin");
      assert.notEqual(branchTip, initialMain, "feature branch has a new commit");

      // Apply the generated merger command exactly as the runtime does, with
      // `tamandua` resolvable through PATH and an isolated exec-identity state.
      fs.mkdirSync(stateHome, { recursive: true });
      process.env.PATH = `${path.join(THIS_REPO, "bin")}${path.delimiter}${process.env.PATH}`;
      process.env.HOME = stateHome;
      process.env.TAMANDUA_STATE_DIR = path.join(stateHome, ".tamandua");
      process.env.TAMANDUA_DB_PATH = path.join(stateHome, ".tamandua", "tamandua.db");
      const merger = behaviors.agents["feature-dev-merge-worktree_merger"];
      const merged = runBehaviorCommand(merger.commands[0], worktree, {
        BRANCH,
        WORKTREE_ORIGIN_REPOSITORY: origin,
        ORIGINAL_BRANCH: "main",
      });
      assert.match(merged.commandOutput, /STATUS: landed/, "the real merge command landed the branch");

      const finalMain = git(["rev-parse", "refs/heads/main"], origin);
      assert.notEqual(finalMain, initialMain, "origin main advanced");
      assert.match(git(["rev-parse", `refs/heads/${BRANCH}`], origin), /^[0-9a-f]{40}$/, "the merged branch still exists in the origin");
      assert.match(git(["log", "--format=%s", "-1", "main"], origin), /merge/i, "landing commit is on origin main");
    } finally {
      if (savedEnv.PATH === undefined) delete process.env.PATH; else process.env.PATH = savedEnv.PATH;
      if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME;
      if (savedEnv.TAMANDUA_STATE_DIR === undefined) delete process.env.TAMANDUA_STATE_DIR; else process.env.TAMANDUA_STATE_DIR = savedEnv.TAMANDUA_STATE_DIR;
      if (savedEnv.TAMANDUA_DB_PATH === undefined) delete process.env.TAMANDUA_DB_PATH; else process.env.TAMANDUA_DB_PATH = savedEnv.TAMANDUA_DB_PATH;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("O10: a merge-family workflow with no branch-naming feature agent refuses at build time (fail closed)", () => {
    const synthetic = [
      "id: synthetic-merge-worktree",
      "steps:",
      "  - id: setup",
      "    agent: setup",
      "    input: |",
      "      Prepare the environment.",
      "    expects: \"STATUS: done\"",
      "  - id: do",
      "    agent: doer",
      "    input: |",
      "      Do the thing; no branch is ever named.",
      "    expects: \"STATUS: done\"",
      "  - id: finalize_merge",
      "    agent: merger",
      "    input: |",
      "      BRANCH: static-value",
      "    expects: \"STATUS: done\"",
      "",
    ].join("\n");
    assert.equal(deriveFeatureCommitAgent(parseWorkflowSteps(synthetic)), null, "no feature agent is derivable");
    let refused: any = null;
    try {
      buildRehearsalScriptedBehaviors({ workflowTexts: { "synthetic-merge-worktree": synthetic }, workflowIds: ["synthetic-merge-worktree"] });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, "a merge-family workflow without a branch-naming agent must refuse at build time");
    assert.equal(refused.code, "TT_CATALOG");
    assert.match(String(refused.message), /branch-naming feature agent/);
  });
});
