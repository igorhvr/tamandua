/**
 * DIAG-PRUNE US-002 — unit tests for run-target resolution.
 *
 * Pure (no real database, no child_process, no temp files) — stays in the
 * parallel lane. The tests inject a fake read-only db-like object.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRunTarget,
  parseHarnessTypeFromContext,
  RunNotFoundError,
  AmbiguousRunError,
  type RunTargetDb,
  type RunTargetRow,
  type RunTargetStatement,
} from "../../dist/diagnostics/run-target.js";

interface FakeRuns {
  runs: RunTargetRow[];
  worktrees: Map<string, string>;
}

/** A read-only fake db that answers the SELECTs run-target issues. */
function makeDb(fixture: FakeRuns): RunTargetDb {
  return {
    prepare(sql: string): RunTargetStatement {
      return {
        get(...params: (string | number | null)[]): unknown {
          const p = params[0];
          if (/FROM runs WHERE id = \?/.test(sql)) {
            return fixture.runs.find((r) => r.id === p);
          }
          if (/FROM runs WHERE run_number = \?/.test(sql)) {
            return fixture.runs.find((r) => r.run_number === p);
          }
          if (/FROM run_worktrees WHERE run_id = \?/.test(sql)) {
            const wt = fixture.worktrees.get(String(p));
            return wt === undefined ? undefined : { worktree_path: wt };
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all(...params: (string | number | null)[]): unknown[] {
          if (/FROM runs WHERE id LIKE \?/.test(sql)) {
            const prefix = String(params[0]).replace(/%+$/, "");
            return fixture.runs.filter((r) => r.id.startsWith(prefix));
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  };
}

const RUN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_B = "aaaaaaab-2222-4222-8222-222222222222";

function fixtureRow(over: Partial<RunTargetRow> & { id: string }): RunTargetRow {
  return {
    run_number: 7,
    workflow_id: "feature-dev-merge-worktree",
    status: "running",
    scheduling_status: "active",
    context: JSON.stringify({ harness_type: "pi", working_directory_for_harness: "/repo" }),
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T01:00:00.000Z",
    ...over,
  };
}

describe("resolveRunTarget", () => {
  it("resolves an exact run id and exposes the projected row", () => {
    const row = fixtureRow({ id: RUN_A, tokens_spent: 42 });
    const db = makeDb({ runs: [row], worktrees: new Map() });
    const target = resolveRunTarget(RUN_A, db);
    assert.equal(target.runId, RUN_A);
    assert.equal(target.bareRunId, RUN_A);
    assert.equal(target.runNumber, 7);
    assert.equal(target.status, "running");
    assert.equal(target.schedulingStatus, "active");
    assert.equal(target.workflowId, "feature-dev-merge-worktree");
    assert.equal(target.createdAt, "2026-09-22T00:00:00.000Z");
    assert.equal(target.updatedAt, "2026-09-22T01:00:00.000Z");
    assert.equal(target.harnessType, "pi");
    assert.equal(target.worktreePath, null);
    assert.equal(target.row.tokens_spent, 42);
  });

  it("resolves a run- prefixed run id by stripping the prefix", () => {
    const db = makeDb({ runs: [fixtureRow({ id: RUN_A })], worktrees: new Map() });
    const target = resolveRunTarget(`run-${RUN_A}`, db);
    assert.equal(target.runId, RUN_A);
    assert.equal(target.bareRunId, RUN_A);
  });

  it("resolves #N and a bare integer as run-number lookups", () => {
    const db = makeDb({ runs: [fixtureRow({ id: RUN_A, run_number: 12 })], worktrees: new Map() });
    assert.equal(resolveRunTarget("#12", db).runId, RUN_A);
    assert.equal(resolveRunTarget("12", db).runId, RUN_A);
  });

  it("resolves an unambiguous id prefix", () => {
    const db = makeDb({
      runs: [fixtureRow({ id: RUN_A }), fixtureRow({ id: "bbbbbbbb-3333-4333-8333-333333333333" })],
      worktrees: new Map(),
    });
    const target = resolveRunTarget("aaaaaaaa", db);
    assert.equal(target.runId, RUN_A);
  });

  it("throws RunNotFoundError for an unknown selector", () => {
    const db = makeDb({ runs: [fixtureRow({ id: RUN_A })], worktrees: new Map() });
    assert.throws(
      () => resolveRunTarget("deadbeef", db),
      (err: unknown) => err instanceof RunNotFoundError && err.selector === "deadbeef",
    );
  });

  it("throws RunNotFoundError for an empty selector", () => {
    const db = makeDb({ runs: [], worktrees: new Map() });
    assert.throws(() => resolveRunTarget("   ", db), RunNotFoundError);
  });

  it("throws RunNotFoundError when a run number has no row", () => {
    const db = makeDb({ runs: [fixtureRow({ id: RUN_A, run_number: 7 })], worktrees: new Map() });
    assert.throws(() => resolveRunTarget("#999", db), RunNotFoundError);
  });

  it("throws AmbiguousRunError listing every match for a multi-match prefix", () => {
    const db = makeDb({
      runs: [fixtureRow({ id: RUN_A }), fixtureRow({ id: RUN_B })],
      worktrees: new Map(),
    });
    assert.throws(
      () => resolveRunTarget("aaaaaaa", db),
      (err: unknown) =>
        err instanceof AmbiguousRunError &&
        err.selector === "aaaaaaa" &&
        err.matches.length === 2 &&
        err.matches.includes(RUN_A) &&
        err.matches.includes(RUN_B),
    );
  });

  it("resolves the managed worktree path when a run_worktrees row exists", () => {
    const db = makeDb({
      runs: [fixtureRow({ id: RUN_A })],
      worktrees: new Map([[RUN_A, "/worktrees/run-a"]]),
    });
    assert.equal(resolveRunTarget(RUN_A, db).worktreePath, "/worktrees/run-a");
  });

  it("tolerates a db without the run_worktrees table", () => {
    const db: RunTargetDb = {
      prepare(sql: string): RunTargetStatement {
        return {
          get(): unknown {
            if (/run_worktrees/.test(sql)) throw new Error("no such table: run_worktrees");
            return fixtureRow({ id: RUN_A });
          },
          all(): unknown[] {
            return [];
          },
        };
      },
    };
    const target = resolveRunTarget(RUN_A, db);
    assert.equal(target.runId, RUN_A);
    assert.equal(target.worktreePath, null);
  });

  it("reports harnessType null when the context is missing or corrupt", () => {
    const missing = makeDb({ runs: [fixtureRow({ id: RUN_A, context: null })], worktrees: new Map() });
    const corrupt = makeDb({ runs: [fixtureRow({ id: RUN_A, context: "{not json" })], worktrees: new Map() });
    const nonString = makeDb({
      runs: [fixtureRow({ id: RUN_A, context: JSON.stringify({ harness_type: 5 }) })],
      worktrees: new Map(),
    });
    assert.equal(resolveRunTarget(RUN_A, missing).harnessType, null);
    assert.equal(resolveRunTarget(RUN_A, corrupt).harnessType, null);
    assert.equal(resolveRunTarget(RUN_A, nonString).harnessType, null);
  });
});

describe("parseHarnessTypeFromContext", () => {
  it("extracts a string harness_type and rejects everything else", () => {
    assert.equal(parseHarnessTypeFromContext(JSON.stringify({ harness_type: "dsh" })), "dsh");
    assert.equal(parseHarnessTypeFromContext("{}"), null);
    assert.equal(parseHarnessTypeFromContext(""), null);
    assert.equal(parseHarnessTypeFromContext(null), null);
    assert.equal(parseHarnessTypeFromContext(undefined), null);
    assert.equal(parseHarnessTypeFromContext("not json"), null);
    assert.equal(parseHarnessTypeFromContext("[]"), null);
  });
});