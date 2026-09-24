/**
 * DIAG-PRUNE US-001 — shared-types contract test.
 *
 * `types.ts` is type-only, so the value of this test is that the literal
 * shapes used by every later collector/planner COMPILE against the exported
 * interfaces (run through `tsc` on the src tree) and that the runtime unions
 * behave as documented (`action`, `SourceStatus`).
 *
 * Pure (no child_process, no temp files) — stays in the parallel lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  SourceStatus,
  DiagnosticsBundle,
  DiagnosticsSummary,
  PrunePlan,
  PruneItem,
  PruneRefusal,
  DbRowsCollection,
  RunEventsCollection,
  DaemonLogCollection,
  EvidenceCollection,
  SessionPathsCollection,
  MatchlockCollection,
} from "../../dist/diagnostics/types.js";

describe("diagnostics shared types", () => {
  it("SourceStatus accepts exactly the three documented values", () => {
    const values: SourceStatus[] = ["present", "empty", "absent"];
    assert.deepEqual(values, ["present", "empty", "absent"]);
  });

  it("a collector result compiles with an explicit absent marker", () => {
    const db: DbRowsCollection = {
      status: "absent",
      absenceReason: "no runs row",
      runs: [],
      steps: [],
      stories: [],
      story_abandonments: [],
      run_worktrees: [],
    };
    assert.equal(db.status, "absent");
    assert.deepEqual(db.runs, []);

    const events: RunEventsCollection = {
      status: "present",
      files: [],
      events: [],
      corrupt: [],
    };
    assert.equal(events.status, "present");

    const logs: DaemonLogCollection = {
      status: "empty",
      files: [],
      entries: [],
      truncated: false,
    };
    assert.equal(logs.truncated, false);

    const evidence: EvidenceCollection = {
      status: "absent",
      evidenceDir: "/state/runs/abc",
      entries: [],
      totalBytes: 0,
      suiteLedger: [],
      suiteLedgerStatus: "absent",
    };
    assert.equal(evidence.totalBytes, 0);

    const sessions: SessionPathsCollection = {
      status: "present",
      workdir: "/repo",
      entries: [],
    };
    assert.equal(sessions.workdir, "/repo");

    const matchlock: MatchlockCollection = {
      status: "absent",
      policy: null,
      policyStatus: "absent",
      vms: [],
      consoleLogs: [],
      errorRecords: [],
    };
    assert.equal(matchlock.policyStatus, "absent");
  });

  it("a DiagnosticsBundle carries a summary with an explicit source map", () => {
    const summary: DiagnosticsSummary = {
      runId: "run-abc",
      bareRunId: "abc",
      status: "failed",
      generatedAt: "2026-09-23T00:00:00.000Z",
      run: { status: "absent", absenceReason: "no run row" },
      timeline: [],
      timelineStatus: "absent",
      retries: [],
      sources: { events: "present", matchlock: "absent" },
    };
    const bundle: DiagnosticsBundle = {
      runId: "run-abc",
      bareRunId: "abc",
      bundlePath: "/state/diagnostics/abc-2026",
      createdAt: "2026-09-23T00:00:00.000Z",
      files: ["summary.json"],
      summary,
    };
    assert.equal(bundle.summary.sources.matchlock, "absent");
  });

  it("PrunePlan items carry an action union and refusals carry a reason", () => {
    const removeItem: PruneItem = {
      kind: "evidence-dir",
      runId: "run-abc",
      bareRunId: "abc",
      path: "/state/runs/abc",
      sizeBytes: 10,
      action: "remove",
      reason: "terminal run older than threshold",
    };
    const keepItem: PruneItem = {
      kind: "suite-log",
      runId: "run-abc",
      bareRunId: "abc",
      path: "/state/suite-logs/1.log",
      sizeBytes: 4,
      action: "keep",
      reason: "run still live",
    };
    const refusal: PruneRefusal = {
      runId: "run-live",
      bareRunId: "live",
      status: "running",
      reason: "run is live",
    };
    const plan: PrunePlan = {
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      items: [removeItem, keepItem],
      refusals: [refusal],
      totals: {
        itemCount: 2,
        removeCount: 1,
        keepCount: 1,
        removeBytes: 10,
        keepBytes: 4,
        totalBytes: 14,
      },
    };
    assert.equal(plan.items.filter((i) => i.action === "remove").length, 1);
    assert.equal(plan.refusals[0].reason, "run is live");
    assert.equal(plan.totals.totalBytes, 14);
  });
});