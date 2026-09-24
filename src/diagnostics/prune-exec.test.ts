/**
 * DIAG-PRUNE US-014 — unit tests for the evidence prune executor.
 *
 * Pure filesystem fixtures (no child_process, no daemon, no real state dir)
 * plus one monkey-patched `fs.rmSync` count — stays in the parallel lane.
 * The executor never touches SQLite, so these tests pass a plain plan object.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { executePrunePlan } from "../../dist/diagnostics/prune-exec.js";
import type { PruneItem } from "../../dist/diagnostics/types.js";

const created: string[] = [];

function makeDir(prefix = "prune-exec-"): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFile(fullPath: string, content = "x"): string {
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function makeRemoveItem(itemPath: string): PruneItem {
  return {
    kind: "evidence-dir",
    runId: "run-" + path.basename(itemPath),
    bareRunId: path.basename(itemPath),
    path: itemPath,
    sizeBytes: 1,
    action: "remove",
    reason: "terminal run older than the threshold and not live",
  };
}

function makeKeepItem(itemPath: string): PruneItem {
  return { ...makeRemoveItem(itemPath), action: "keep", reason: "run is live" };
}

describe("executePrunePlan — removal", () => {
  it("removes only action 'remove' paths and reports removed/skipped/failed counts", () => {
    const state = makeDir();
    const evDir = path.join(state, "runs", "aaaa1111");
    makeFile(path.join(evDir, "out.log"), "evidence");
    const bundle = path.join(state, "diagnostics", "aaaa1111-2026-09-20T00_00_00.000Z");
    makeFile(path.join(bundle, "SUMMARY.md"), "bundle");
    const suiteLog = makeFile(path.join(state, "suite-logs", "7.log"), "suite");
    const keepDir = path.join(state, "runs", "bbbb2222");
    makeFile(path.join(keepDir, "out.log"), "keep-me");

    const plan = {
      olderThanMs: 0,
      items: [
        makeRemoveItem(evDir),
        makeRemoveItem(bundle),
        makeRemoveItem(suiteLog),
        makeKeepItem(keepDir),
      ],
      refusals: [],
      totals: {
        itemCount: 4,
        removeCount: 3,
        keepCount: 1,
        removeBytes: 0,
        keepBytes: 0,
        totalBytes: 0,
      },
    };

    const result = executePrunePlan(plan, { stateDir: state });

    assert.equal(result.removed.length, 3);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(
      result.removed.map((item) => item.path).sort(),
      [evDir, bundle, suiteLog].sort(),
    );
    assert.equal(fs.existsSync(evDir), false);
    assert.equal(fs.existsSync(bundle), false);
    assert.equal(fs.existsSync(suiteLog), false);
    // A 'keep' item is never touched.
    assert.equal(fs.existsSync(path.join(keepDir, "out.log")), true);
  });

  it("is idempotent: a re-run skips paths that no longer exist", () => {
    const state = makeDir();
    const target = path.join(state, "runs", "cccc3333");
    makeFile(path.join(target, "out.log"), "data");
    const plan = {
      olderThanMs: 0,
      items: [makeRemoveItem(target)],
      refusals: [],
      totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
    };

    const first = executePrunePlan(plan, { stateDir: state });
    assert.equal(first.removed.length, 1);
    assert.equal(first.skipped.length, 0);

    const second = executePrunePlan(plan, { stateDir: state });
    assert.equal(second.removed.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.failed.length, 0);
    assert.equal(second.skipped[0].path, target);

    // A path that never existed is skipped too.
    const missing = path.join(state, "runs", "dddd4444");
    const third = executePrunePlan(
      { ...plan, items: [makeRemoveItem(missing)] },
      { stateDir: state },
    );
    assert.equal(third.removed.length, 0);
    assert.equal(third.skipped.length, 1);
  });

  it("does nothing (and reports nothing) for a plan with only keep items", () => {
    const state = makeDir();
    const keep = path.join(state, "runs", "eeee5555");
    makeFile(path.join(keep, "out.log"), "keep");
    const result = executePrunePlan(
      {
        olderThanMs: 0,
        items: [makeKeepItem(keep)],
        refusals: [],
        totals: { itemCount: 1, removeCount: 0, keepCount: 1, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: state },
    );
    assert.deepEqual(result, { removed: [], skipped: [], failed: [] });
    assert.equal(fs.existsSync(keep), true);
  });
});

describe("executePrunePlan — safety", () => {
  it("refuses a path that is not lexically inside the state dir", () => {
    const state = makeDir();
    const outside = makeDir("prune-exec-outside-");
    const outsideFile = makeFile(path.join(outside, "keep.txt"), "outside");

    const plan = {
      olderThanMs: 0,
      items: [makeRemoveItem(outsideFile), makeRemoveItem(outside)],
      refusals: [],
      totals: { itemCount: 2, removeCount: 2, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
    };

    const result = executePrunePlan(plan, { stateDir: state });
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.failed.length, 2);
    for (const failure of result.failed) {
      assert.match(failure.error, /inside the state dir/);
    }
    assert.equal(fs.existsSync(outsideFile), true);
    assert.equal(fs.existsSync(outside), true);
  });

  it("refuses the state dir itself and a sibling sharing a name prefix", () => {
    const state = makeDir();
    const sibling = makeDir(`${path.basename(state)}-sibling`);
    const siblingFile = makeFile(path.join(sibling, "f.txt"), "s");

    const result = executePrunePlan(
      {
        olderThanMs: 0,
        items: [makeRemoveItem(state), makeRemoveItem(siblingFile)],
        refusals: [],
        totals: { itemCount: 2, removeCount: 2, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: state },
    );
    assert.equal(result.failed.length, 2);
    assert.equal(fs.existsSync(state), true);
    assert.equal(fs.existsSync(siblingFile), true);
  });

  it("refuses a path reachable only through a symlinked directory escaping the state dir", () => {
    const state = makeDir();
    const outside = makeDir("prune-exec-escape-");
    const inner = path.join(outside, "inner");
    makeFile(path.join(inner, "out.log"), "escaped");

    const link = path.join(state, "runs-link");
    fs.symlinkSync(outside, link, "dir");

    const target = path.join(link, "inner");
    const result = executePrunePlan(
      {
        olderThanMs: 0,
        items: [makeRemoveItem(target)],
        refusals: [],
        totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: state },
    );

    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /outside the state dir/);
    assert.equal(fs.existsSync(path.join(inner, "out.log")), true);
  });

  it("removes a symlink target without following it out of the state dir", () => {
    const state = makeDir();
    const outside = makeDir("prune-exec-link-target-");
    const outsideFile = makeFile(path.join(outside, "real.txt"), "real");
    const link = path.join(state, "linkrun");
    fs.symlinkSync(outside, link, "dir");

    const result = executePrunePlan(
      {
        olderThanMs: 0,
        items: [makeRemoveItem(link)],
        refusals: [],
        totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: state },
    );

    assert.equal(result.removed.length, 1);
    assert.equal(result.failed.length, 0);
    // The link is gone; the pointed-to directory and its contents survive.
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(outsideFile), true);
  });

  it("never touches a path twice", () => {
    const state = makeDir();
    const target = path.join(state, "runs", "ffff6666");
    makeFile(path.join(target, "out.log"), "dup");

    const originalRm = fs.rmSync;
    let calls = 0;
    fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
      calls += 1;
      return originalRm(...args);
    }) as typeof fs.rmSync;
    try {
      const result = executePrunePlan(
        {
          olderThanMs: 0,
          items: [makeRemoveItem(target), makeRemoveItem(target)],
          refusals: [],
          totals: { itemCount: 2, removeCount: 2, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
        },
        { stateDir: state },
      );
      assert.equal(result.removed.length, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.failed.length, 0);
      assert.equal(calls, 1, "rmSync must be called exactly once for a duplicated path");
    } finally {
      fs.rmSync = originalRm;
    }
  });

  it("reports an rmSync failure in 'failed' and leaves the path in place", () => {
    const state = makeDir();
    const target = path.join(state, "runs", "9999aaaa");
    makeFile(path.join(target, "out.log"), "boom");

    const originalRm = fs.rmSync;
    fs.rmSync = (() => {
      throw new Error("EACCES: simulated");
    }) as typeof fs.rmSync;
    try {
      const result = executePrunePlan(
        {
          olderThanMs: 0,
          items: [makeRemoveItem(target)],
          refusals: [],
          totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
        },
        { stateDir: state },
      );
      assert.equal(result.removed.length, 0);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0].error, /EACCES/);
      assert.equal(fs.existsSync(target), true);
    } finally {
      fs.rmSync = originalRm;
    }
  });

  it("fails a malformed remove item and an empty state dir instead of guessing", () => {
    const state = makeDir();
    const target = path.join(state, "runs", "8badf00d");
    makeFile(path.join(target, "out.log"), "x");

    const noPath = { ...makeRemoveItem(target), path: "" };
    const bad = executePrunePlan(
      {
        olderThanMs: 0,
        items: [noPath],
        refusals: [],
        totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: state },
    );
    assert.equal(bad.failed.length, 1);
    assert.match(bad.failed[0].error, /no path/);

    const emptyState = executePrunePlan(
      {
        olderThanMs: 0,
        items: [makeRemoveItem(target)],
        refusals: [],
        totals: { itemCount: 1, removeCount: 1, keepCount: 0, removeBytes: 0, keepBytes: 0, totalBytes: 0 },
      },
      { stateDir: "" },
    );
    assert.equal(emptyState.failed.length, 1);
    assert.match(emptyState.failed[0].error, /state dir is empty/);
    assert.equal(fs.existsSync(target), true);
  });

  it("tolerates a plan without an items array", () => {
    const state = makeDir();
    const result = executePrunePlan(
      {} as never,
      { stateDir: state },
    );
    assert.deepEqual(result, { removed: [], skipped: [], failed: [] });
  });
});