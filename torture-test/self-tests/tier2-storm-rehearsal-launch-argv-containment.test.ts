// Tier-2 STORM-REHEARSAL-FIX6 US-003 — launch-argv containment audit (SF-12
// recurrence net for every roster launch and every derived Round B action).
//
// Attempt 6 recorded SF-12: the B-stopdel identical relaunch was built from a
// rosterId (`B5-relaunch`) that is NOT a key in `ctx.opts.taskFiles` (which
// covers B1..B5 only). The old resolver fell back to the bare relative
// `${run}.task.md`, the product resolved it against the launch cwd (the
// private HOME), ENOENTed, and no `relaunchOf` lineage was produced.
//
// US-001 fixed the resolver (fail-closed, absolute-only). This file is the
// MECHANICAL AUDIT that the whole defect class cannot recur:
//
//   A1 every roster launch in `buildLaunchPlan(...)` (10 Round A + 5 Round B)
//      resolves `--task-file` to an ABSOLUTE path under the campaign tasks
//      root, and resolves it through the launch's OWN `taskFiles[rosterId]`
//      entry — never a relative name, never a fallback;
//   A2 the B-stopdel identical relaunch (a `launch`-channel step of the phase
//      action plan the real dispatch uses) resolves the SAME absolute B5 task
//      file as the primary B5 launch — the task-file roster identity is B5,
//      not the tracking-only `B5-relaunch`;
//   A3 every derived Round B phase action (`scriptedRoundBPhases()`) emits only
//      absolute, campaign-contained path tokens: `--task-file` under the tasks
//      root, `--repo`/`--worktree-origin-repository` absolute and under the
//      owned roots, and `--file` still repo-relative. A recording Proxy over
//      `ctx.opts.taskFiles` proves NO derived action ever reads a rosterId
//      absent from the map (the exact SF-12 lookup the old code silently
//      accepted);
//   A4 the audit itself FAILS CLOSED on a relative `--task-file` (the
//      regression guard), so a future relative emission cannot pass.
//
// `actionPlan` is the same argv builder `dispatchPhaseAction` calls (engine
// line ~2097) before it records `phase.relaunch.intent`/spawns the launch, so
// auditing the plan audits the real emitted argv. Recording/pure assertions
// only: no daemon, scheduler, harness, model token or production port is
// touched (PI/DSH/HERMES are never spawned).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  deriveStormNumbers,
  newCampaignState,
} from "../bin/tt-storm-shared.mjs";
import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
} from "../bin/tt-storm-roster.mjs";
import {
  ROUND_B_PHASES,
  actionPlan,
  buildLaunchPlan,
  launchArgvFor,
} from "../bin/tt-storm-engine.mjs";
import { scriptedRoundBPhases } from "../bin/tt-storm-rehearsal.mjs";

const BUNDLED_WORKFLOWS = path.join(process.cwd(), "workflows");

// ── Owned scratch (unique; removed only in `after`) ──────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "tt-launch-argv-"));
const VAR_ROOT = path.join(SCRATCH, "var");
const RESULTS_ROOT = path.join(VAR_ROOT, "results");
const CAMPAIGN_DIR = path.join(RESULTS_ROOT, "storm-launch-argv");
const REHEARSAL_ROOT = path.join(VAR_ROOT, "rehearsal", "camp");
const TASKS_ROOT = path.join(REHEARSAL_ROOT, "tasks");
const REPOS_ROOT = path.join(REHEARSAL_ROOT, "repos");
const ORIGIN_REPO = path.join(REPOS_ROOT, "origin");
const COLLEAGUE_REPO = path.join(REPOS_ROOT, "colleague");
const PARK_REPO = path.join(REPOS_ROOT, "park");

fs.mkdirSync(TASKS_ROOT, { recursive: true });
fs.mkdirSync(COLLEAGUE_REPO, { recursive: true });
fs.mkdirSync(PARK_REPO, { recursive: true });
fs.mkdirSync(ORIGIN_REPO, { recursive: true });

// The task file NAME deliberately does NOT follow `<run>.task.md`: that makes
// the map resolution (`taskFiles[taskFileRosterId]`) distinguishable from the
// run-derived `taskFileRoot/<run>.task.md` fallback. A regression that drops
// the task-file roster identity resolves a DIFFERENT (still absolute) path and
// is caught by A1/A2 plus the absent-key proxy in A3.
const taskFiles: Record<string, string> = {};
for (const r of [...ROUND_A_ROSTER, ...ROUND_B_ROSTER]) {
  const file = path.join(TASKS_ROOT, `task-${r.id}.md`);
  fs.writeFileSync(file, `# task ${r.id} (${r.run})\nWORKFLOW: ${r.workflow}\nHARNESS: ${r.harness}\n`);
  taskFiles[r.id] = file;
}

const FIXTURE_IDENTITY = {
  originRepo: ORIGIN_REPO,
  colleagueRepo: COLLEAGUE_REPO,
  parkRepo: PARK_REPO,
  cc1File: "docs/cc1.md",
  cc2File: "ts/src/store.ts",
  seedRef: "seed/storm",
};

const CLOCK = {
  nowMs: () => Date.UTC(2026, 0, 1, 0, 0, 0),
  nowUtc: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
};

function makeRunId(tag: string): string {
  const h = Buffer.from(`storm-launch-argv:${tag}`).toString("hex").padEnd(32, "0").slice(0, 32);
  return `run-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// A context whose `taskFiles` map is wrapped in a recording Proxy so the audit
// can prove which roster keys the resolver actually read.
function makeCtx() {
  const accessedTaskKeys: string[] = [];
  const recordingTaskFiles = new Proxy(taskFiles, {
    get(target: Record<string, string>, prop: string | symbol) {
      if (typeof prop === "string") accessedTaskKeys.push(prop);
      return target[prop as string];
    },
  });
  const ctx: any = {
    varRoot: VAR_ROOT,
    campaignDir: CAMPAIGN_DIR,
    opts: {
      taskFiles: recordingTaskFiles,
      taskFileRoot: TASKS_ROOT,
      reposRoot: REPOS_ROOT,
      fixtureIdentity: FIXTURE_IDENTITY,
    },
    accessedTaskKeys,
  };
  return ctx;
}

function makeState() {
  const state: any = newCampaignState({
    campaignId: "storm-launch-argv",
    clock: CLOCK,
    source: {},
    fixture: {},
  });
  for (const r of ROUND_B_ROSTER) {
    state.rounds.B.runs[r.id] = {
      rosterId: r.id,
      run: r.run,
      workflow: r.workflow,
      harness: r.harness,
      status: "registered",
      runId: makeRunId(r.id),
      children: [],
      relaunchOf: null,
    };
  }
  // B-pounding's actionPlan acknowledgement requires an active pounding state.
  state.rounds.B.pounding = {
    active: true,
    notRunReason: null,
    cadenceMs: 30_000,
    latencyBoundMs: 2_000,
  };
  return state;
}

// ── Path audit (the mechanical containment check) ────────────────────────

function isWithin(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function valuesOf(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i += 1) if (argv[i] === flag) out.push(argv[i + 1]);
  return out;
}

function findArg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// The audit fails closed: ANY relative `--task-file` (the SF-12 defect class)
// is a hard failure, as is a `--repo`-style token that is relative or escapes
// the owned roots. A `--file` value must stay repo-relative (the tt-chaos
// operator resolves it against `--repo`).
function auditArgvPaths(
  argv: string[],
  { tasksRoot = TASKS_ROOT, ownedRoots = [VAR_ROOT, REPOS_ROOT], label = "argv" }: any = {},
) {
  assert.ok(Array.isArray(argv) && argv.length > 0, `${label}: argv is a non-empty array`);
  for (const tf of valuesOf(argv, "--task-file")) {
    assert.ok(path.isAbsolute(tf), `${label}: --task-file must be absolute (got ${tf})`);
    assert.ok(isWithin(tasksRoot, tf), `${label}: --task-file ${tf} must be under the campaign tasks root ${tasksRoot}`);
    assert.notEqual(path.basename(tf), tf, `${label}: --task-file must never be a bare relative name (${tf})`);
    assert.doesNotMatch(tf, /^[^/\\]+\.task\.md$/, `${label}: --task-file must not be a bare <run>.task.md (${tf})`);
  }
  for (const flag of ["--repo", "--worktree-origin-repository"]) {
    for (const v of valuesOf(argv, flag)) {
      assert.ok(path.isAbsolute(v), `${label}: ${flag} must be absolute (got ${v})`);
      assert.ok(
        ownedRoots.some((root: string) => isWithin(root, v)),
        `${label}: ${flag} ${v} must be under an owned campaign root`,
      );
    }
  }
  for (const f of valuesOf(argv, "--file")) {
    assert.ok(!path.isAbsolute(f), `${label}: --file ${f} must stay repo-relative (resolved against --repo)`);
  }
  return argv;
}

// A `launch`-channel step is a workflow launch and therefore MUST carry an
// absolute `--task-file` under the tasks root (auditArgvPaths already rejects
// a relative one; this also requires it to be PRESENT).
function auditLaunchChannelArgv(argv: string[], label: string) {
  auditArgvPaths(argv, { label });
  const tf = findArg(argv, "--task-file");
  assert.ok(tf, `${label}: a launch argv must carry --task-file`);
  assert.ok(path.isAbsolute(tf as string), `${label}: launch --task-file must be absolute`);
  assert.ok(isWithin(TASKS_ROOT, tf as string), `${label}: launch --task-file must be under the tasks root`);
  return tf as string;
}

const launchChannels = (plan: any) =>
  (plan.steps ?? []).filter((s: any) => s.channel === "launch");

async function rosterPlan() {
  const numbers = await deriveStormNumbers({ installedCatalogRoot: null, bundledCatalogRoot: BUNDLED_WORKFLOWS });
  return buildLaunchPlan(numbers);
}

after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("tier2 storm rehearsal US-003 launch-argv containment audit (SF-12 recurrence net)", () => {
  it("A1: every roster launch resolves an absolute --task-file under the tasks root via its OWN taskFiles entry", async () => {
    const plan = await rosterPlan();
    assert.equal(plan.launches.length, 15, "10 Round A + 5 Round B roster launches");
    const ctx = makeCtx();
    const taskFileByRoster = new Map<string, string>();
    const seenRosterIds: string[] = [];

    for (const launch of plan.launches) {
      const label = `${launch.round}:${launch.rosterId}`;
      const argv = launchArgvFor(launch, ctx);
      const tf = auditLaunchChannelArgv(argv, label);
      // The map entry is authoritative: the emitted path is the roster's own
      // declared task file, not the run-derived taskFileRoot fallback.
      assert.equal(tf, taskFiles[launch.rosterId], `${label}: resolves taskFiles[${launch.rosterId}]`);
      assert.notEqual(tf, path.join(TASKS_ROOT, `${launch.run}.task.md`), `${label}: must not use the run-derived fallback`);
      taskFileByRoster.set(launch.rosterId, tf);
      seenRosterIds.push(launch.rosterId);
      // Worktree launches additionally carry an owned absolute origin.
      const origin = findArg(argv, "--worktree-origin-repository");
      if (launch.workspaceMode === "worktree") {
        assert.ok(origin && path.isAbsolute(origin), `${label}: worktree origin is absolute`);
        assert.ok(isWithin(REPOS_ROOT, origin as string), `${label}: worktree origin is campaign-contained`);
      } else {
        assert.equal(origin, null, `${label}: direct launch carries no origin flag`);
      }
    }

    assert.equal(taskFileByRoster.size, 15, "distinct task file per roster launch");
    // The resolver read EXACTLY the 15 present roster keys — no absent
    // rosterId was ever used as a task-file source.
    assert.deepEqual(
      [...new Set(ctx.accessedTaskKeys)].sort(),
      [...seenRosterIds].sort(),
      "every roster launch read only its own present taskFiles key",
    );
    for (const k of ctx.accessedTaskKeys) assert.ok(k in taskFiles, `taskFiles key '${k}' must exist`);
  });

  it("A2: the B-stopdel relaunch resolves the SAME absolute B5 task file as the primary B5 launch", async () => {
    const plan = await rosterPlan();
    const ctx = makeCtx();
    const state = makeState();

    const primaryB5 = plan.launches.find((l: any) => l.rosterId === "B5");
    const primaryArgv = launchArgvFor(primaryB5, ctx);
    const primaryTaskFile = auditLaunchChannelArgv(primaryArgv, "B5-primary");
    assert.equal(primaryTaskFile, taskFiles.B5);

    const bStopdel = ROUND_B_PHASES.find((ph: any) => ph.id === "B-stopdel");
    assert.ok(bStopdel, "the B-stopdel phase exists");
    const built = actionPlan(ctx, state, bStopdel.action);
    assert.equal(built.ok, true, `B-stopdel action plan builds: ${built.reason ?? "ok"}`);
    assert.deepEqual(built.steps.map((s: any) => s.channel), ["tamandua", "tamandua", "launch"]);

    const launches = launchChannels(built);
    assert.equal(launches.length, 1, "exactly one launch-channel step (the identical relaunch)");
    const relaunchTaskFile = auditLaunchChannelArgv(launches[0].argv, "B5-relaunch");
    assert.equal(
      relaunchTaskFile,
      primaryTaskFile,
      "the identical relaunch names the SAME task file as the primary B5 launch (declared-identical)",
    );
    assert.equal(relaunchTaskFile, taskFiles.B5, "resolved via taskFiles[taskFileRosterId=B5]");
    assert.notEqual(relaunchTaskFile, path.join(TASKS_ROOT, "storm-b5-donow.task.md"), "never the run-derived fallback");
    assert.equal(launches[0].meta.relaunchRosterId, "B5-relaunch", "tracking-only roster identity preserved");
    // The relaunch resolution read the PRESENT B5 key, not the absent
    // 'B5-relaunch' key the old resolver silently accepted.
    assert.deepEqual([...new Set(ctx.accessedTaskKeys)], ["B5"], "the relaunch resolved through taskFiles[B5]");
    assert.ok(!ctx.accessedTaskKeys.includes("B5-relaunch"), "the absent tracking rosterId was never read from taskFiles");
  });

  it("A3: every derived Round B action emits only absolute, campaign-contained paths; no launch is built from an absent rosterId", async () => {
    const ctx = makeCtx();
    const state = makeState();
    const derived = scriptedRoundBPhases();
    assert.equal(derived.length, 11, "the derived schedule carries all 11 Round B phases");
    assert.deepEqual(
      derived.map((p: any) => p.id),
      ROUND_B_PHASES.map((p: any) => p.id),
      "the derived schedule is a projection of the real phase table",
    );

    const launchSteps: Array<{ id: string; argv: string[]; taskFile: string }> = [];
    const allArgvs: string[][] = [];
    const accessedBefore = ctx.accessedTaskKeys.length;

    for (const ph of derived) {
      // The derived action is copied verbatim from the real table; audit the
      // exact action the real dispatch builds argv for.
      assert.deepEqual(ph.action, ROUND_B_PHASES.find((r: any) => r.id === ph.id)!.action, `${ph.id}: action verbatim`);
      const built = actionPlan(ctx, state, ph.action);
      assert.equal(built.ok, true, `${ph.id}: action plan builds (${built.reason ?? "ok"})`);
      for (const step of built.steps) {
        assert.ok(Array.isArray(step.argv) && step.argv.length > 0, `${ph.id}/${step.channel}: argv present`);
        // No launch argv may be built without a resolvable task file; every
        // path token must be absolute/campaign-contained.
        auditArgvPaths(step.argv, { label: `${ph.id}/${step.channel}` });
        allArgvs.push(step.argv);
        if (step.channel === "launch") {
          const tf = auditLaunchChannelArgv(step.argv, `${ph.id}/launch`);
          assert.ok(Object.values(taskFiles).includes(tf), `${ph.id}: launch task file is a declared campaign task file`);
          launchSteps.push({ id: ph.id, argv: step.argv, taskFile: tf });
        }
      }
    }

    assert.equal(launchSteps.length, 1, "exactly one derived action (B-stopdel) carries a launch channel");
    assert.equal(launchSteps[0].id, "B-stopdel");
    assert.equal(launchSteps[0].taskFile, taskFiles.B5, "the derived relaunch resolves the B5 task file");

    // The 11 derived actions read taskFiles exactly once (the B-stopdel
    // relaunch) and never read a rosterId absent from the map: the SF-12
    // defect class (a launch argv built from an unknown rosterId) cannot recur
    // in any of the other 10 actions.
    const accessedDuring = [...new Set(ctx.accessedTaskKeys.slice(accessedBefore))];
    assert.deepEqual(accessedDuring, ["B5"], "only the present B5 key was resolved across all derived actions");
    for (const k of ctx.accessedTaskKeys) assert.ok(k in taskFiles, `derived action read taskFiles['${k}'] which must exist`);

    // Belt-and-braces: no emitted token is a bare relative *.task.md.
    for (const argv of allArgvs) {
      for (const tok of argv) {
        assert.doesNotMatch(tok, /^[^/\\]+\.task\.md$/, `no bare relative task file token (${tok}) in ${argv.join(" ")}`);
      }
    }
  });

  it("A4: the audit fails closed on a relative --task-file, a relative --repo, or an absolute --file (regression guard)", () => {
    // The exact SF-12 emission the audit must reject.
    assert.throws(
      () => auditArgvPaths(["tamandua", "workflow", "run", "do-now", "--task-file", "storm-b5-donow.task.md"], { label: "synthetic" }),
      /--task-file must be absolute/,
      "a relative --task-file fails the audit",
    );
    assert.throws(
      () => auditArgvPaths(["tamandua", "workflow", "run", "do-now", "--task-file", "run.task.md"], { label: "synthetic" }),
      /--task-file must be absolute/,
      "a bare <run>.task.md fails the audit",
    );
    // An absolute task file OUTSIDE the tasks root escapes the campaign root.
    assert.throws(
      () => auditArgvPaths(["tamandua", "workflow", "run", "do-now", "--task-file", "/etc/storm.task.md"], { label: "synthetic" }),
      /must be under the campaign tasks root/,
      "a task file outside the tasks root fails the audit",
    );
    // A relative --repo (resolved against the private HOME by the operator).
    assert.throws(
      () => auditArgvPaths(["tt-chaos", "dirty-tree", "--repo", "relative/repo"], { label: "synthetic" }),
      /--repo must be absolute/,
      "a relative --repo fails the audit",
    );
    // An absolute --file would be resolved as a host path, not a repo path.
    assert.throws(
      () => auditArgvPaths(["tt-chaos", "colleague-commit", "--repo", COLLEAGUE_REPO, "--file", "/etc/passwd"], { label: "synthetic" }),
      /--file .* must stay repo-relative/,
      "an absolute --file fails the audit",
    );
    // Sanity: a well-formed launch argv passes.
    assert.doesNotThrow(() =>
      auditArgvPaths(["tamandua", "workflow", "run", "do-now", "--task-file", taskFiles.B5], { label: "synthetic" }),
    );
  });

  it("A5: the emitted relaunch argv is what the real dispatch forwards (absolute task file, campaign-contained)", () => {
    const ctx = makeCtx();
    const state = makeState();
    const bStopdel = ROUND_B_PHASES.find((ph: any) => ph.id === "B-stopdel");
    const built = actionPlan(ctx, state, bStopdel.action);
    const launchStep = launchChannels(built)[0];
    // The dispatch path records this exact argv (`phase.relaunch.intent`) and
    // forwards it to `ctx.proc.launchWorkflow`; assert the forwarded token is
    // absolute and under the tasks root without needing a daemon/child.
    auditLaunchChannelArgv(launchStep.argv, "B5-relaunch-dispatch");
    assert.equal(launchStep.argv[0], "tamandua");
    assert.deepEqual(launchStep.argv.slice(1, 4), ["workflow", "run", "do-now"]);
    assert.equal(findArg(launchStep.argv, "--task-file"), taskFiles.B5);
  });
});
