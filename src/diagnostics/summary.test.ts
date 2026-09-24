/**
 * DIAG-PRUNE US-009 — unit tests for the diagnostics summary + SUMMARY.md
 * builder.
 *
 * Pure: the module reads nothing, spawns nothing and imports only Node-core
 * plus `src/lib/instant.ts`, so this file stays in the parallel lane. The
 * fixtures below are hand-built collector outputs, including a Matchlock-shaped
 * run and a run whose sources are entirely absent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnosticsSummary,
  renderSummaryMarkdown,
  MAX_STDERR_TAIL_CHARS,
  type DiagnosticsSummaryParts,
} from "../../dist/diagnostics/summary.js";

const BARE = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_ID = `run-${BARE}`;

type AnyRecord = Record<string, unknown>;

function event(partial: AnyRecord): AnyRecord {
  return { runId: RUN_ID, ...partial };
}

function dbRows(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    status: "present",
    runs: [
      {
        id: BARE,
        run_number: 87,
        workflow_id: "feature-dev-merge-worktree",
        status: "failed",
        scheduling_status: "error",
        scheduling_error: "force-failed",
        worker_lost_count: 2,
        ceiling_expiry_count: 1,
        instant_fail_count: 0,
        harness_probe_status: "failed",
        matchlock_policy_present: false,
        created_at: "2026-09-23T10:00:00.000Z",
        updated_at: "2026-09-23T10:30:00.000Z",
        tokens_spent: 1234,
      },
    ],
    steps: [
      {
        id: "row-1",
        step_id: "plan",
        agent_id: "planner",
        type: "plan",
        status: "done",
        retry_count: 0,
        abandoned_count: 0,
        created_at: "2026-09-23T10:01:00.000Z",
        updated_at: "2026-09-23T10:02:00.000Z",
      },
      {
        id: "row-2",
        step_id: "implement",
        agent_id: "developer",
        type: "work",
        status: "failed",
        retry_count: 3,
        abandoned_count: 2,
        created_at: "2026-09-23T10:03:00.000Z",
        updated_at: "2026-09-23T10:20:00.000Z",
      },
    ],
    stories: [
      {
        id: "srow-1",
        story_id: "US-001",
        title: "First story",
        status: "failed",
        retry_count: 1,
        abandoned_count: 1,
        created_at: "2026-09-23T10:04:00.000Z",
        updated_at: "2026-09-23T10:21:00.000Z",
      },
    ],
    story_abandonments: [],
    run_worktrees: [],
    ...overrides,
  };
}

function eventsCollection(events: AnyRecord[]): AnyRecord {
  return { status: "present", files: ["/state/events/x.jsonl"], events, corrupt: [] };
}

function baseParts(overrides: Partial<DiagnosticsSummaryParts> = {}): DiagnosticsSummaryParts {
  return {
    runId: RUN_ID,
    bareRunId: BARE,
    generatedAt: "2026-09-23T11:00:00.000Z",
    ...overrides,
  } as DiagnosticsSummaryParts;
}

describe("buildDiagnosticsSummary", () => {
  it("extracts the force-fail reason and last failing round stderr tail from fixture events", () => {
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        event({ ts: "2026-09-23T10:05:00.000Z", event: "run.started" }),
        event({
          ts: "2026-09-23T10:10:00.000Z",
          event: "step.worker_lost",
          stepId: "implement",
          stderrTail: "early tail",
          exitCode: 1,
        }),
        event({
          ts: "2026-09-23T10:25:00.000Z",
          event: "step.failed",
          stepId: "implement",
          detail: "retries exhausted",
        }),
        event({
          ts: "2026-09-23T10:30:00.000Z",
          event: "run.force_failed",
          reason: "operator force-fail: wedged harness",
        }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);

    assert.equal(summary.status, "failed");
    assert.equal(summary.schedulingStatus, "error");
    assert.equal(summary.workflowId, "feature-dev-merge-worktree");
    assert.equal(summary.createdAt, "2026-09-23T10:00:00.000Z");
    assert.equal(summary.updatedAt, "2026-09-23T10:30:00.000Z");

    assert.equal(summary.forceFail?.status, "present");
    assert.equal(summary.forceFail?.event, "run.force_failed");
    assert.equal(summary.forceFail?.reason, "operator force-fail: wedged harness");
    assert.equal(summary.forceFail?.instant, "2026-09-23T10:30:00.000Z");

    assert.equal(summary.lastFailingRound?.status, "present");
    assert.equal(summary.lastFailingRound?.event, "step.worker_lost");
    assert.equal(summary.lastFailingRound?.stepId, "implement");
    assert.equal(summary.lastFailingRound?.stderrTail, "early tail");
    assert.equal(summary.lastFailingRound?.truncated, false);
  });

  it("prefers the LAST force-fail event and the last tail-bearing failing round", () => {
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        event({
          ts: "2026-09-23T10:01:00.000Z",
          event: "run.failed",
          reason: "first failure",
        }),
        event({
          ts: "2026-09-23T10:02:00.000Z",
          event: "step.worker_lost",
          stepId: "implement",
          stderrTail: "first tail",
        }),
        event({
          ts: "2026-09-23T10:03:00.000Z",
          event: "step.preclaim_round_died",
          stepId: "test",
          stderrTail: "second tail",
        }),
        event({
          ts: "2026-09-23T10:04:00.000Z",
          event: "run.force_failed",
          reason: "second failure",
        }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    assert.equal(summary.forceFail?.reason, "second failure");
    assert.equal(summary.lastFailingRound?.stderrTail, "second tail");
    assert.equal(summary.lastFailingRound?.event, "step.preclaim_round_died");
    assert.equal(summary.lastFailingRound?.stepId, "test");
  });

  it("does not let a later tail-less step.failed overwrite the tail evidence", () => {
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        event({
          ts: "2026-09-23T10:01:00.000Z",
          event: "step.worker_lost",
          stepId: "implement",
          stderrTail: "real tail",
        }),
        event({
          ts: "2026-09-23T10:02:00.000Z",
          event: "step.failed",
          stepId: "implement",
          detail: "no tail here",
        }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    assert.equal(summary.lastFailingRound?.status, "present");
    assert.equal(summary.lastFailingRound?.stderrTail, "real tail");
  });

  it("bounds a long stderr tail to the most recent characters and records truncation", () => {
    const longTail = `${"x".repeat(MAX_STDERR_TAIL_CHARS + 500)}TAILEND`;
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        event({
          ts: "2026-09-23T10:01:00.000Z",
          event: "step.worker_lost",
          stepId: "implement",
          stderrTail: longTail,
        }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    assert.equal(summary.lastFailingRound?.status, "present");
    assert.equal(summary.lastFailingRound?.truncated, true);
    assert.equal(String(summary.lastFailingRound?.stderrTail).length, MAX_STDERR_TAIL_CHARS);
    assert.ok(String(summary.lastFailingRound?.stderrTail).endsWith("TAILEND"));
  });

  it("marks missing sections 'absent' instead of fabricating values", () => {
    const summary = buildDiagnosticsSummary(baseParts());

    assert.equal(summary.run.status, "absent");
    assert.match(String(summary.run.absenceReason), /no run row/);
    assert.equal(summary.timelineStatus, "absent");
    assert.deepEqual(summary.timeline, []);
    assert.equal(summary.forceFail?.status, "absent");
    assert.match(String(summary.forceFail?.absenceReason), /run events not collected/);
    assert.equal(summary.lastFailingRound?.status, "absent");
    assert.equal(summary.lastFailingRound?.stderrTail, undefined);
    assert.equal(summary.status, "absent");

    assert.deepEqual(summary.sources, {
      db: "absent",
      events: "absent",
      logs: "absent",
      evidence: "absent",
      sessions: "absent",
      matchlock: "absent",
    });
    assert.equal(summary.logs?.status, "absent");
    assert.equal(summary.evidence?.status, "absent");
    assert.equal(summary.sessions?.status, "absent");
    assert.equal(summary.matchlock?.status, "absent");
  });

  it("reports absent when events exist but carry no failing-round tail", () => {
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        event({ ts: "2026-09-23T10:01:00.000Z", event: "run.started" }),
        event({ ts: "2026-09-23T10:02:00.000Z", event: "step.completed" }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    assert.equal(summary.forceFail?.status, "absent");
    assert.equal(summary.lastFailingRound?.status, "absent");
    assert.match(String(summary.lastFailingRound?.absenceReason), /no non-empty stderrTail/);
  });

  it("builds an ordered step/story timeline with retries and abandon counts", () => {
    const parts = baseParts({ db: dbRows() as never });
    const summary = buildDiagnosticsSummary(parts);

    assert.equal(summary.timelineStatus, "present");
    assert.equal(summary.timeline.length, 3);
    assert.deepEqual(
      summary.timeline.map((entry) => `${entry.kind}:${entry.id}`),
      ["step:plan", "step:implement", "story:US-001"],
    );
    const implement = summary.timeline.find((entry) => entry.id === "implement");
    assert.equal(implement?.retries, 3);
    assert.equal(implement?.abandonCount, 2);
    const story = summary.timeline.find((entry) => entry.id === "US-001");
    assert.equal(story?.title, "First story");
    assert.equal(story?.retries, 1);

    assert.deepEqual(
      summary.retries.map((row) => row.id),
      ["implement", "US-001"],
    );
  });

  it("summarizes present non-run sources with explicit statuses", () => {
    const parts = baseParts({
      db: dbRows() as never,
      logs: {
        status: "present",
        files: [{ path: "/state/tamandua.log", status: "present", lines: 3 }],
        entries: [{ file: "/state/tamandua.log", line: 1, text: "x" }],
        truncated: false,
      } as never,
      evidence: {
        status: "present",
        evidenceDir: `/state/runs/${BARE}`,
        entries: [{ path: "a.txt", sizeBytes: 3 }],
        totalBytes: 3,
        suiteLedger: [],
        suiteLedgerStatus: "empty",
      } as never,
      sessions: {
        status: "present",
        workdir: "/repo",
        entries: [{ harness: "pi", status: "present", storeDir: "/pi", candidatePaths: [], files: [] }],
      } as never,
      matchlock: {
        status: "present",
        policy: { apiKey: "<redacted>" },
        policyStatus: "present",
        vms: [{ vmId: "vm-1234abcd", dir: "/x", status: "present", logs: [], totalBytes: 0 }],
        consoleLogs: [],
        errorRecords: [],
      } as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    assert.deepEqual(summary.sources, {
      db: "present",
      events: "absent",
      logs: "present",
      evidence: "present",
      sessions: "present",
      matchlock: "present",
    });
    assert.equal((summary.logs as AnyRecord).entries, 1);
    assert.equal((summary.evidence as AnyRecord).suiteLedgerStatus, "empty");
    assert.equal((summary.matchlock as AnyRecord).vmCount ?? (summary.matchlock as AnyRecord).vms, 1);
  });

  it("never throws on malformed events and stays JSON-serializable", () => {
    const parts = baseParts({
      db: dbRows() as never,
      events: eventsCollection([
        null as never,
        { notAnEvent: true } as never,
        event({ event: "step.worker_lost", stderrTail: 42 as never }),
      ]) as never,
    });

    const summary = buildDiagnosticsSummary(parts);
    const roundTripped = JSON.parse(JSON.stringify(summary)) as AnyRecord;
    assert.equal(roundTripped.runId, RUN_ID);
    assert.ok(Array.isArray(roundTripped.timeline));
  });
});

describe("renderSummaryMarkdown", () => {
  it("renders the run status and step/story timeline", () => {
    const summary = buildDiagnosticsSummary(
      baseParts({
        db: dbRows() as never,
        events: eventsCollection([
          event({
            ts: "2026-09-23T10:25:00.000Z",
            event: "run.force_failed",
            reason: "wedged harness",
          }),
          event({
            ts: "2026-09-23T10:24:00.000Z",
            event: "step.worker_lost",
            stepId: "implement",
            stderrTail: "boom\nstack",
          }),
        ]) as never,
      }),
    );

    const md = renderSummaryMarkdown(summary);
    assert.match(md, /# Diagnostics summary/);
    assert.match(md, /Run status: failed/);
    assert.match(md, /## Step and story timeline/);
    assert.match(md, /- step `plan`/);
    assert.match(md, /- step `implement`/);
    assert.match(md, /- story `US-001` \(First story\)/);
    assert.match(md, /Reason: wedged harness/);
    assert.match(md, /boom/);
    assert.match(md, /- db: present/);
    assert.match(md, /- events: present/);
  });

  it("renders absent sections explicitly and never throws on malformed input", () => {
    const absent = renderSummaryMarkdown(buildDiagnosticsSummary(baseParts()));
    assert.match(absent, /Run status: absent/);
    assert.match(absent, /Timeline status: absent/);
    assert.match(absent, /Force-fail status: absent/);
    assert.match(absent, /Last failing round status: absent/);
    assert.match(absent, /- db: absent/);

    // A deliberately malformed summary object must not throw.
    const malformed = renderSummaryMarkdown({
      runId: "run-x",
      bareRunId: "x",
      status: "failed",
      generatedAt: "not-an-instant",
    } as never);
    assert.match(malformed, /Run status: failed/);
    assert.match(malformed, /Timeline status: absent/);
  });
});