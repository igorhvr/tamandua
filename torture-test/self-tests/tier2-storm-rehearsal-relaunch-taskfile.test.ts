// Tier-2 STORM-REHEARSAL-FIX6 US-001 — fail-closed launch task-file
// resolution (SF-12).
//
// Attempt 6 Round B: the B-stopdel identical relaunch was built by
//   launchArgvFor({ rosterId: 'B5-relaunch', run: 'storm-b5-donow' }, ctx)
// and the old resolver fell back to the bare relative
// `${launch.run}.task.md` because 'B5-relaunch' is not a key in
// ctx.opts.taskFiles (which covers B1..B5 only). The product resolved that
// relative --task-file against the launch cwd (the private HOME) and refused
// with ENOENT: exit 1, TT_MISSING_RUN, no relaunchOf lineage.
//
// This file pins the fix:
//   R1 launchArgvFor honours launch.taskFileRosterId and returns the
//      campaign's absolute taskFiles[B5] path — never the bare run name;
//   R2 launchArgvFor refuses TT_TASKFILE_MISSING when no taskFileFor /
//      absolute launch.taskFile / taskFiles entry / taskFileRoot exists;
//   R3 the stop_delete_relaunch actionPlan carries the absolute B5 task path
//      while keeping rosterId 'B5-relaunch' for lineage/tracking;
//   R4 the resolver precedence and the "never relative" contract (including
//      the taskFileRoot fallback and a relative taskFileRoot refusal);
//   R5 the very first ctx.opts.launchArgvFor short-circuit is unchanged (the
//      recording gate depends on it).
//
// Recording fakes only: no daemon, scheduler, harness, model token or
// production port is ever touched.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newCampaignState } from "../bin/tt-storm-shared.mjs";
import {
  actionPlan,
  launchArgvFor,
  resolveLaunchTaskFile,
} from "../bin/tt-storm-engine.mjs";

const TASKS_ROOT = "/var/tt-owned/rehearsal/camp/tasks";
const B5_TASK = `${TASKS_ROOT}/storm-b5-donow.task.md`;

function baseState(clock: any = { nowUtc: () => "2026-01-01T00:00:00.000Z" }) {
  const state = newCampaignState({
    campaignId: "storm-relaunch-taskfile",
    clock,
    source: {},
    fixture: {},
  });
  state.rounds.B.runs.B5 = {
    rosterId: "B5",
    run: "storm-b5-donow",
    workflow: "do-now",
    harness: "pi",
    status: "registered",
    runId: "run-b5-live",
    children: [],
    relaunchOf: null,
  };
  return state;
}

function ctxWith(opts: Record<string, any> = {}, state: any = baseState()) {
  return {
    varRoot: "/var",
    campaignDir: "/var/results/storm-relaunch-taskfile",
    state,
    opts: { ...opts },
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

function taskFilesAll(): Record<string, string> {
  return {
    B1: `${TASKS_ROOT}/storm-b1-merge.task.md`,
    B2: `${TASKS_ROOT}/storm-b2-merge.task.md`,
    B3: `${TASKS_ROOT}/storm-b3-merge.task.md`,
    B4: `${TASKS_ROOT}/storm-b4-merge.task.md`,
    B5: B5_TASK,
  };
}

describe("tier2 storm rehearsal US-001 fail-closed relaunch task file (SF-12)", () => {
  it("R1: the B5-relaunch resolves the campaign's absolute B5 task file, never a bare run name", () => {
    const ctx = ctxWith({ taskFiles: taskFilesAll() });
    const launch = { rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow", workflow: "do-now", harness: "pi" };
    const argv = launchArgvFor(launch, ctx);
    const taskFile = findArg(argv, "--task-file");
    assert.equal(taskFile, B5_TASK, "the relaunch names the SAME absolute task file as the primary B5 launch");
    assert.equal(taskFile, ctx.opts.taskFiles.B5, "resolved via taskFiles[taskFileRosterId]");
    assert.notEqual(taskFile, "storm-b5-donow.task.md", "never the bare relative run name");
    assert.ok(taskFile.startsWith("/"), "the task file is absolute");
    // The tracking identity is untouched: lineage records still key on
    // B5-relaunch, but the argv pulls B5's task file.
    assert.equal(launch.rosterId, "B5-relaunch");
  });

  it("R2: launchArgvFor refuses TT_TASKFILE_MISSING with no task-file source", () => {
    const launch = { rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow", workflow: "do-now", harness: "pi" };
    for (const opts of [
      {},
      { taskFiles: {} },
      // A rosterId absent from a populated map must not fall back to a
      // relative name either.
      { taskFiles: { B1: `${TASKS_ROOT}/storm-b1-merge.task.md` } },
      // A relative taskFileRoot cannot anchor an absolute task file.
      { taskFileRoot: "relative/tasks" },
    ]) {
      const refused = refusalFrom(() => launchArgvFor(launch, ctxWith(opts)));
      assert.ok(refused, `opts ${JSON.stringify(opts)} must refuse`);
      assert.equal(refused.code, "TT_TASKFILE_MISSING", `opts ${JSON.stringify(opts)} code`);
      assert.match(String(refused.message), /B5-relaunch|storm-b5-donow/, "the refusal names the rosterId/run");
    }
  });

  it("R3: the stop_delete_relaunch actionPlan launch step carries the absolute B5 task path", () => {
    const ctx = ctxWith({ taskFiles: taskFilesAll() });
    const state = baseState();
    const plan = actionPlan(ctx, state, {
      kind: "stop_delete_relaunch",
      target: "B5",
      relaunchRun: "storm-b5-donow",
    });
    assert.equal(plan.ok, true, "the canonical plan builds");
    assert.deepEqual(plan.steps.map((s: any) => s.channel), ["tamandua", "tamandua", "launch"]);
    const launchStep = plan.steps[2];
    const taskFile = findArg(launchStep.argv, "--task-file");
    assert.equal(taskFile, B5_TASK, "the relaunch argv carries the absolute B5 task path");
    assert.notEqual(taskFile, "storm-b5-donow.task.md", "never the bare relative name");
    assert.ok(String(taskFile).startsWith("/"), "the relaunch task path is absolute");
    assert.ok(String(taskFile).startsWith(TASKS_ROOT), "the relaunch task path lives under the campaign tasks root");
    assert.equal(launchStep.meta.relaunchRosterId, "B5-relaunch", "the tracking roster identity is preserved");
  });
  it("R3b: the relaunch task file equals the primary B5 task file (declared-identical)", () => {
    const ctx = ctxWith({ taskFiles: taskFilesAll() });
    const primary = launchArgvFor(
      { rosterId: "B5", run: "storm-b5-donow", workflow: "do-now", harness: "pi" },
      ctx,
    );
    const relaunch = launchArgvFor(
      { rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow", workflow: "do-now", harness: "pi" },
      ctx,
    );
    assert.equal(findArg(relaunch, "--task-file"), findArg(primary, "--task-file"));
  });

  it("R4: resolver precedence is taskFileFor > absolute launch.taskFile > taskFiles > taskFileRoot", () => {
    const launch = { rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow", workflow: "do-now" };

    // (1) taskFileFor wins over everything else.
    assert.equal(
      resolveLaunchTaskFile(launch, ctxWith({
        taskFileFor: () => "/from/callback.task.md",
        taskFiles: taskFilesAll(),
        taskFileRoot: TASKS_ROOT,
      })),
      "/from/callback.task.md",
    );
    // (2) an explicit absolute launch.taskFile wins when there is no callback.
    assert.equal(
      resolveLaunchTaskFile({ ...launch, taskFile: "/from/launch.task.md" }, ctxWith({ taskFiles: taskFilesAll() })),
      "/from/launch.task.md",
    );
    // (3) taskFiles[taskFileRosterId] beats the taskFileRoot fallback.
    assert.equal(
      resolveLaunchTaskFile(launch, ctxWith({ taskFiles: taskFilesAll(), taskFileRoot: "/other/tasks" })),
      B5_TASK,
    );
    // (4) a run-derived absolute path under taskFileRoot when the map misses.
    assert.equal(
      resolveLaunchTaskFile({ rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow" }, ctxWith({ taskFiles: {}, taskFileRoot: TASKS_ROOT })),
      B5_TASK,
    );
    // A relative taskFile is refused even when other sources exist.
    const rel = refusalFrom(() =>
      resolveLaunchTaskFile({ ...launch, taskFile: "storm-b5-donow.task.md" }, ctxWith({ taskFiles: taskFilesAll() })),
    );
    assert.equal(rel?.code, "TT_TASKFILE_MISSING", "a relative declared taskFile is refused");
  });

  it("R4b: a relative taskFiles entry is refused, not handed to the product", () => {
    const launch = { rosterId: "B5", run: "storm-b5-donow", workflow: "do-now" };
    const refused = refusalFrom(() =>
      resolveLaunchTaskFile(launch, ctxWith({ taskFiles: { B5: "storm-b5-donow.task.md" } })),
    );
    assert.equal(refused?.code, "TT_TASKFILE_MISSING");
    assert.match(String(refused.message), /not absolute/);
  });

  it("R5: the ctx.opts.launchArgvFor short-circuit is unchanged", () => {
    const launch = { rosterId: "B5-relaunch", taskFileRosterId: "B5", run: "storm-b5-donow", workflow: "do-now" };
    const ctx = ctxWith({ launchArgvFor: () => ["tamandua", "workflow", "run", "do-now", "--storm-marker", "B5-relaunch"] });
    const argv = launchArgvFor(launch, ctx);
    assert.deepEqual(argv, ["tamandua", "workflow", "run", "do-now", "--storm-marker", "B5-relaunch"]);
  });
});
