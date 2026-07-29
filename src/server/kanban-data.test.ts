import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import { DatabaseSync } from "node:sqlite";

import type { TamanduaEvent } from "../../dist/installer/events.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import {
  buildKanbanSnapshot,
  buildKanbanCardDetail,
  laneAgentSuffix,
  normaliseStatus,
} from "../../dist/server/kanban-data.js";
import { createDashboardServer, invalidateRunsCache } from "../../dist/server/dashboard.js";
import { getDb } from "../../dist/db.js";

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertRun(db: DatabaseSync, id: string, status: string, tokens = 0): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) " +
    "VALUES (?, 1, 'feature-dev-merge', 'demo task', ?, '{}', ?, ?, ?)",
  ).run(id, status, tokens, now, now);
}

function insertStep(
  db: DatabaseSync,
  runId: string,
  stepId: string,
  agent: string,
  index: number,
  status: string,
  opts: { type?: string; current_story_id?: string | null; retry?: number; input_template?: string; output?: string } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, retry_count, output, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    `step_${runId}_${stepId}`,
    runId,
    stepId,
    `feature-dev-merge_${agent}`,
    index,
    opts.input_template ?? "",
    status,
    opts.type ?? "single",
    opts.current_story_id ?? null,
    opts.retry ?? 0,
    opts.output ?? null,
    now,
    now,
  );
}

function insertStory(
  db: DatabaseSync,
  runId: string,
  storyId: string,
  index: number,
  title: string,
  status: string,
  opts: { description?: string; acceptance_criteria?: string; output?: string } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    `story_${runId}_${storyId}`,
    runId,
    index,
    storyId,
    title,
    opts.description ?? "",
    opts.acceptance_criteria ?? "[]",
    status,
    opts.output ?? null,
    now,
    now,
  );
}

describe("kanban-data: normaliseStatus", () => {
  it("collapses raw statuses into 4 visual buckets", () => {
    assert.equal(normaliseStatus("waiting"), "todo");
    assert.equal(normaliseStatus("pending"), "todo");
    assert.equal(normaliseStatus("running"), "running");
    assert.equal(normaliseStatus("done"), "done");
    assert.equal(normaliseStatus("completed"), "done");
    assert.equal(normaliseStatus("failed"), "failed");
    assert.equal(normaliseStatus("canceled"), "failed");
    assert.equal(normaliseStatus("cancelled"), "failed");
    assert.equal(normaliseStatus(""), "todo");
    assert.equal(normaliseStatus(null), "todo");
    assert.equal(normaliseStatus(undefined), "todo");
    assert.equal(normaliseStatus("RUNNING"), "running");
  });
});

describe("kanban-data: laneAgentSuffix", () => {
  it("returns the role suffix when agent_id is namespaced", () => {
    assert.equal(laneAgentSuffix("feature-dev-merge_developer"), "developer");
    assert.equal(laneAgentSuffix("bug-fix_planner"), "planner");
  });
  it("falls back to the whole id when no underscore is present", () => {
    assert.equal(laneAgentSuffix("solo"), "solo");
  });
});

describe("kanban-data: buildKanbanSnapshot", () => {
  it("returns null for unknown runs", () => {
    const db = seedDb();
    assert.equal(buildKanbanSnapshot(db, "missing"), null);
  });

  it("derives one card per step for single-type lanes", () => {
    const db = seedDb();
    insertRun(db, "r1", "running", 42);
    insertStep(db, "r1", "plan", "planner", 0, "done");
    insertStep(db, "r1", "verify", "verifier", 1, "waiting");

    const snap = buildKanbanSnapshot(db, "r1");
    assert.ok(snap);
    assert.equal(snap.lanes.length, 2);
    assert.equal(snap.lanes[0].agent, "planner");
    assert.equal(snap.lanes[0].label, "Planner");
    assert.equal(snap.lanes[0].status, "done");
    assert.equal(snap.lanes[0].cards.length, 1);
    assert.equal(snap.lanes[0].cards[0].status, "done");
    assert.equal(snap.lanes[1].status, "todo");
    assert.equal(snap.run.tokens_spent, 42);
    assert.equal(snap.currentStoryId, null);
  });

  it("freezes elapsed_seconds for terminal runs and leaves it null for active runs", () => {
    const db = seedDb();

    // Terminal run with SQLite-style space-separated UTC timestamps spanning 90s.
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) " +
      "VALUES ('r-done', 1, 'feature-dev-merge', 'demo', 'completed', '{}', 0, '2026-05-01 10:00:00', '2026-05-01 10:01:30')",
    ).run();
    insertStep(db, "r-done", "plan", "planner", 0, "done");

    const doneSnap = buildKanbanSnapshot(db, "r-done")!;
    assert.equal(doneSnap.run.elapsed_seconds, 90);

    // Active run: server must not freeze, the client uses its own clock.
    insertRun(db, "r-live", "running");
    insertStep(db, "r-live", "plan", "planner", 0, "running");

    const liveSnap = buildKanbanSnapshot(db, "r-live")!;
    assert.equal(liveSnap.run.elapsed_seconds, null);

    // Failed/canceled runs also freeze.
    insertRun(db, "r-fail", "failed");
    insertStep(db, "r-fail", "plan", "planner", 0, "failed");
    const failSnap = buildKanbanSnapshot(db, "r-fail")!;
    assert.ok(failSnap.run.elapsed_seconds !== null);
  });

  it("renders stories as cards for loop-type lanes", () => {
    const db = seedDb();
    insertRun(db, "r2", "running");
    insertStep(db, "r2", "plan", "planner", 0, "done");
    insertStep(db, "r2", "implement", "developer", 1, "running", {
      type: "loop",
      current_story_id: "US-002",
    });
    insertStory(db, "r2", "US-001", 0, "First story", "done");
    insertStory(db, "r2", "US-002", 1, "Second story", "pending");
    insertStory(db, "r2", "US-003", 2, "Third story", "pending");

    const snap = buildKanbanSnapshot(db, "r2")!;
    const devLane = snap.lanes.find((l) => l.agent === "developer")!;
    assert.equal(devLane.cards.length, 3);
    assert.equal(devLane.cards[0].status, "done");
    // The current story is promoted from pending → running.
    assert.equal(devLane.cards[1].id, "US-002");
    assert.equal(devLane.cards[1].status, "running");
    assert.equal(devLane.cards[2].status, "todo");
    assert.equal(devLane.summary.done, 1);
    assert.equal(devLane.summary.running, 1);
    assert.equal(devLane.summary.total, 3);
    assert.equal(snap.currentStoryId, "US-002");
  });

  it("does not promote stories when the loop step is already done", () => {
    const db = seedDb();
    insertRun(db, "r3", "completed");
    insertStep(db, "r3", "implement", "developer", 0, "done", {
      type: "loop",
      current_story_id: "US-002",
    });
    insertStory(db, "r3", "US-001", 0, "done one", "done");
    insertStory(db, "r3", "US-002", 1, "stale pointer", "pending");

    const snap = buildKanbanSnapshot(db, "r3")!;
    const devLane = snap.lanes[0];
    // Story stays todo because step.done supersedes a stale current_story_id.
    assert.equal(devLane.cards[1].status, "todo");
  });

  it("shows retry counters in card sub-text when retries are non-zero", () => {
    const db = seedDb();
    insertRun(db, "r4", "running");
    insertStep(db, "r4", "verify", "verifier", 0, "running", { retry: 2 });

    const snap = buildKanbanSnapshot(db, "r4")!;
    assert.match(snap.lanes[0].cards[0].sub, /retry 2\/4/);
  });

  it("parked loop lane has status verifying", () => {
    const db = seedDb();
    insertRun(db, "r-verify", "running");
    // Parked loop: running with no current_story_id
    insertStep(db, "r-verify", "implement", "developer", 0, "running", {
      type: "loop",
      current_story_id: null,
    });
    insertStory(db, "r-verify", "US-001", 0, "First story", "done");

    const snap = buildKanbanSnapshot(db, "r-verify")!;
    const devLane = snap.lanes[0];
    assert.equal(devLane.agent, "developer");
    assert.equal(devLane.status, "verifying");
    // Stories are still rendered as cards
    assert.equal(devLane.cards.length, 1);
    assert.equal(devLane.cards[0].status, "done");
  });

  it("active loop lane has status running with claimed story card promoted", () => {
    const db = seedDb();
    insertRun(db, "r-active", "running");
    // Active loop: running with a claimed story
    insertStep(db, "r-active", "implement", "developer", 0, "running", {
      type: "loop",
      current_story_id: "US-002",
    });
    insertStory(db, "r-active", "US-001", 0, "Done story", "done");
    insertStory(db, "r-active", "US-002", 1, "Active story", "pending");

    const snap = buildKanbanSnapshot(db, "r-active")!;
    const devLane = snap.lanes[0];
    assert.equal(devLane.status, "running");
    // The claimed story is promoted to running
    assert.equal(devLane.cards[1].id, "US-002");
    assert.equal(devLane.cards[1].status, "running");
  });

  it("non-loop steps keep their normal lane status", () => {
    const db = seedDb();
    insertRun(db, "r-single", "running");
    insertStep(db, "r-single", "plan", "planner", 0, "done");
    insertStep(db, "r-single", "verify", "verifier", 1, "running");

    const snap = buildKanbanSnapshot(db, "r-single")!;
    assert.equal(snap.lanes[0].status, "done");
    assert.equal(snap.lanes[1].status, "running");
  });

  it("orders lanes by step_index", () => {
    const db = seedDb();
    insertRun(db, "r5", "running");
    insertStep(db, "r5", "merge", "merger", 5, "waiting");
    insertStep(db, "r5", "plan", "planner", 0, "done");
    insertStep(db, "r5", "implement", "developer", 1, "running", { type: "loop" });

    const snap = buildKanbanSnapshot(db, "r5")!;
    assert.deepEqual(
      snap.lanes.map((l) => l.agent),
      ["planner", "developer", "merger"],
    );
  });
});

// ── buildKanbanCardDetail tests ────────────────────────────────────

function makeEvent(
  ts: string,
  event: string,
  opts: { runId?: string; stepId?: string; storyId?: string; detail?: string; tokenDelta?: number; tokensSpent?: number } = {},
): TamanduaEvent {
  return {
    ts,
    event,
    runId: opts.runId ?? "r-detail",
    stepId: opts.stepId,
    storyId: opts.storyId,
    detail: opts.detail,
    tokenDelta: opts.tokenDelta,
    tokensSpent: opts.tokensSpent,
  };
}

describe("kanban-data: buildKanbanCardDetail", () => {
  it("returns null for unknown runId", () => {
    const db = seedDb();
    assert.equal(buildKanbanCardDetail(db, "nonexistent", "US-001"), null);
  });

  it("returns null for cardId not matching any story or step", () => {
    const db = seedDb();
    insertRun(db, "r1", "running");
    assert.equal(buildKanbanCardDetail(db, "r1", "nonsense"), null);
  });

  it("returns story card detail with prompt from loop step", () => {
    const db = seedDb();
    insertRun(db, "r1", "running");
    insertStep(db, "r1", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "Implement the user story: {{story_id}}",
    });
    insertStory(db, "r1", "US-001", 0, "Add login", "done", {
      description: "As a user I want login",
      acceptance_criteria: '["Login form works", "Error on bad password"]',
      output: "STATUS: done\nCHANGES: Added login",
    });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-01T10:00:00Z", "story.started", { runId: "r1", stepId: "implement", storyId: "US-001" }),
      makeEvent("2025-01-01T10:05:00Z", "story.done", { runId: "r1", stepId: "implement", storyId: "US-001" }),
    ];

    const detail = buildKanbanCardDetail(db, "r1", "US-001", events);
    assert.ok(detail);
    assert.equal(detail.cardId, "US-001");
    assert.equal(detail.title, "Add login");
    assert.equal(detail.status, "done");
    assert.equal(detail.storyId, "US-001");
    assert.equal(detail.description, "As a user I want login");
    assert.deepEqual(detail.acceptanceCriteria, ["Login form works", "Error on bad password"]);
    assert.equal(detail.input_template, "Implement the user story: {{story_id}}");
    assert.equal(detail.output, "STATUS: done\nCHANGES: Added login");
    assert.equal(detail.retryCount, 0);
    assert.equal(detail.maxRetries, 4);
    assert.equal(detail.events.length, 2);
    assert.ok(detail.timing);
    assert.equal(detail.timing.durationMs, 5 * 60 * 1000); // 5 minutes
  });

  it("returns step card detail with input_template and output", () => {
    const db = seedDb();
    insertRun(db, "r2", "running");
    insertStep(db, "r2", "plan", "planner", 0, "done", {
      input_template: "Plan the feature",
      output: "STATUS: done\nREPO: /home/repo",
    });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-02T09:00:00Z", "step.running", { runId: "r2", stepId: "plan" }),
      makeEvent("2025-01-02T09:30:00Z", "step.done", { runId: "r2", stepId: "plan" }),
    ];

    const detail = buildKanbanCardDetail(db, "r2", "plan", events);
    assert.ok(detail);
    assert.equal(detail.cardId, "plan");
    assert.equal(detail.title, "planner step");
    assert.equal(detail.status, "done");
    assert.equal(detail.input_template, "Plan the feature");
    assert.equal(detail.output, "STATUS: done\nREPO: /home/repo");
    assert.equal(detail.events.length, 2);
    assert.ok(detail.timing);
    assert.equal(detail.timing.durationMs, 30 * 60 * 1000);
  });

  it("extracts failure detail from step.failed events", () => {
    const db = seedDb();
    insertRun(db, "r3", "running");
    insertStep(db, "r3", "verify", "verifier", 0, "failed", {
      input_template: "Verify the changes",
    });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-03T10:00:00Z", "step.running", { runId: "r3", stepId: "verify" }),
      makeEvent("2025-01-03T10:02:00Z", "step.failed", { runId: "r3", stepId: "verify", detail: "Agent terminated without completing step; retries exhausted" }),
    ];

    const detail = buildKanbanCardDetail(db, "r3", "verify", events);
    assert.ok(detail);
    assert.equal(detail.failureDetail, "Agent terminated without completing step; retries exhausted");
  });

  it("extracts failure detail from story.failed events (preferred over step.failed)", () => {
    const db = seedDb();
    insertRun(db, "r4", "running");
    insertStep(db, "r4", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "Implement {{story_id}}",
    });
    insertStory(db, "r4", "US-001", 0, "Broken story", "failed");

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-04T10:00:00Z", "story.started", { runId: "r4", stepId: "implement", storyId: "US-001" }),
      makeEvent("2025-01-04T10:01:00Z", "story.failed", { runId: "r4", stepId: "implement", storyId: "US-001", detail: "Abandoned — retries exhausted" }),
      makeEvent("2025-01-04T10:01:01Z", "step.failed", { runId: "r4", stepId: "implement", detail: "Loop step failed" }),
    ];

    const detail = buildKanbanCardDetail(db, "r4", "US-001", events);
    assert.ok(detail);
    // story.failed detail should win over step.failed detail
    assert.equal(detail.failureDetail, "Abandoned — retries exhausted");
  });

  it("aggregates token deltas from run.tokens.updated events", () => {
    const db = seedDb();
    insertRun(db, "r5", "running");
    insertStep(db, "r5", "plan", "planner", 0, "done", {
      input_template: "Plan it",
    });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-05T10:00:00Z", "step.running", { runId: "r5", stepId: "plan" }),
      makeEvent("2025-01-05T10:01:00Z", "run.tokens.updated", { runId: "r5", stepId: "plan", tokenDelta: 1500, tokensSpent: 1500 }),
      makeEvent("2025-01-05T10:02:00Z", "run.tokens.updated", { runId: "r5", stepId: "plan", tokenDelta: 800, tokensSpent: 2300 }),
      makeEvent("2025-01-05T10:03:00Z", "step.done", { runId: "r5", stepId: "plan" }),
      makeEvent("2025-01-05T10:03:01Z", "run.tokens.updated", { runId: "r5", stepId: "plan", tokenDelta: 200, tokensSpent: 2500 }),
    ];

    const detail = buildKanbanCardDetail(db, "r5", "plan", events);
    assert.ok(detail);
    assert.ok(detail.tokens);
    assert.equal(detail.tokens.total, 2500);
    assert.deepEqual(detail.tokens.deltas, [1500, 800, 200]);
  });

  it("returns undefined tokens when no token events exist", () => {
    const db = seedDb();
    insertRun(db, "r6", "running");
    insertStep(db, "r6", "plan", "planner", 0, "done", { input_template: "Plan" });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-06T10:00:00Z", "step.running", { runId: "r6", stepId: "plan" }),
      makeEvent("2025-01-06T10:01:00Z", "step.done", { runId: "r6", stepId: "plan" }),
    ];

    const detail = buildKanbanCardDetail(db, "r6", "plan", events);
    assert.ok(detail);
    assert.equal(detail.tokens, undefined);
  });

  it("returns undefined timing for empty events", () => {
    const db = seedDb();
    insertRun(db, "r7", "running");
    insertStep(db, "r7", "plan", "planner", 0, "waiting", { input_template: "Plan" });

    const detail = buildKanbanCardDetail(db, "r7", "plan", []);
    assert.ok(detail);
    assert.equal(detail.timing, undefined);
  });

  it("returns story card detail without optional fields when missing", () => {
    const db = seedDb();
    insertRun(db, "r8", "running");
    insertStep(db, "r8", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "",
    });
    insertStory(db, "r8", "US-001", 0, "Minimal", "pending");

    const detail = buildKanbanCardDetail(db, "r8", "US-001", []);
    assert.ok(detail);
    assert.equal(detail.description, undefined);
    assert.equal(detail.acceptanceCriteria, undefined);
    assert.equal(detail.input_template, "");
    assert.equal(detail.output, undefined);
    assert.equal(detail.failureDetail, undefined);
  });

  it("returns run task in the detail", () => {
    const db = seedDb();
    insertRun(db, "r9", "running");
    insertStep(db, "r9", "plan", "planner", 0, "done", {
      input_template: "Plan",
    });

    const detail = buildKanbanCardDetail(db, "r9", "plan", []);
    assert.ok(detail);
    assert.equal(detail.task, "demo task");
  });

  it("handles story with malformed acceptance_criteria JSON gracefully", () => {
    const db = seedDb();
    insertRun(db, "r10", "running");
    insertStep(db, "r10", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "Do it",
    });
    insertStory(db, "r10", "US-001", 0, "Broken JSON story", "done", {
      acceptance_criteria: "not-valid-json",
    });

    const detail = buildKanbanCardDetail(db, "r10", "US-001", []);
    assert.ok(detail);
    assert.equal(detail.acceptanceCriteria, undefined);
  });

  it("events array includes only step-matching events for step cards", () => {
    const db = seedDb();
    insertRun(db, "r11", "running");
    insertStep(db, "r11", "plan", "planner", 0, "done", { input_template: "Plan" });
    insertStep(db, "r11", "verify", "verifier", 1, "done", { input_template: "Verify" });

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-07T10:00:00Z", "step.running", { runId: "r11", stepId: "plan" }),
      makeEvent("2025-01-07T10:01:00Z", "step.done", { runId: "r11", stepId: "plan" }),
      makeEvent("2025-01-07T10:02:00Z", "step.running", { runId: "r11", stepId: "verify" }),
      makeEvent("2025-01-07T10:03:00Z", "step.done", { runId: "r11", stepId: "verify" }),
    ];

    const detail = buildKanbanCardDetail(db, "r11", "plan", events);
    assert.ok(detail);
    assert.equal(detail.events.length, 2);
    assert.ok(detail.events.every((e) => e.stepId === "plan"));
  });

  it("events array includes story-matching and loop-step events for story cards", () => {
    const db = seedDb();
    insertRun(db, "r12", "running");
    insertStep(db, "r12", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "Implement",
    });
    insertStory(db, "r12", "US-001", 0, "Story A", "done");
    insertStory(db, "r12", "US-002", 1, "Story B", "pending");

    const events: TamanduaEvent[] = [
      makeEvent("2025-01-08T10:00:00Z", "story.started", { runId: "r12", stepId: "implement", storyId: "US-001" }),
      makeEvent("2025-01-08T10:01:00Z", "run.tokens.updated", { runId: "r12", stepId: "implement", tokenDelta: 500, tokensSpent: 500 }),
      makeEvent("2025-01-08T10:02:00Z", "story.done", { runId: "r12", stepId: "implement", storyId: "US-001" }),
      // This one is for US-002 — should NOT be included for US-001 card
      makeEvent("2025-01-08T10:03:00Z", "story.started", { runId: "r12", stepId: "implement", storyId: "US-002" }),
    ];

    const detail = buildKanbanCardDetail(db, "r12", "US-001", events);
    assert.ok(detail);
    // Should include storyId==="US-001" events (3) + loop-step events (the token event with stepId==="implement")
    // The story.started for US-002 should be excluded
    assert.equal(detail.events.length, 3);
    // US-002 events should be excluded (different storyId + step-level filter)
    assert.ok(!detail.events.some((e) => e.storyId === "US-002"));
  });

  it("includes step output when story output is null", () => {
    const db = seedDb();
    insertRun(db, "r13", "running");
    insertStep(db, "r13", "implement", "developer", 0, "running", {
      type: "loop",
      input_template: "Do it",
      output: "Step-level output",
    });
    insertStory(db, "r13", "US-001", 0, "Story", "done");

    const detail = buildKanbanCardDetail(db, "r13", "US-001", []);
    assert.ok(detail);
    assert.equal(detail.output, "Step-level output");
  });

  it("filters events correctly with bounded (limited) events input", () => {
    const db = seedDb();
    insertRun(db, "r14", "running");
    insertStep(db, "r14", "plan", "planner", 0, "done", { input_template: "Plan" });

    // Simulate a scenario where only 5 of 500 total events are passed
    // (as happens when getRunEvents(runId, 200) is called but we want to
    //  exercise the extreme case of very few events)
    const boundedEvents: TamanduaEvent[] = [
      makeEvent("2025-02-01T10:00:00Z", "step.running", { runId: "r14", stepId: "plan" }),
      makeEvent("2025-02-01T10:01:00Z", "run.tokens.updated", { runId: "r14", stepId: "plan", tokenDelta: 100, tokensSpent: 100 }),
      makeEvent("2025-02-01T10:02:00Z", "step.done", { runId: "r14", stepId: "plan" }),
      makeEvent("2025-02-01T10:02:01Z", "run.tokens.updated", { runId: "r14", stepId: "plan", tokenDelta: 50, tokensSpent: 150 }),
      // This event is for a different step — should be filtered out
      makeEvent("2025-02-01T10:03:00Z", "step.running", { runId: "r14", stepId: "verify" }),
    ];

    const detail = buildKanbanCardDetail(db, "r14", "plan", boundedEvents);
    assert.ok(detail);
    // The verify event should be filtered out — only plan events remain
    assert.equal(detail.events.length, 4);
    assert.ok(detail.events.every((e) => e.stepId === "plan"));
    // Tokens still aggregate correctly from the included events
    assert.ok(detail.tokens);
    assert.equal(detail.tokens.total, 150);
  });
});

// ── Helper for handler-level tests ───────────────────────────────

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  invalidateRunsCache();
  const server = createDashboardServer(0);
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function appendRunEvent(stateDir: string, runId: string, evt: TamanduaEvent): void {
  const filePath = path.join(stateDir, "events", `${runId}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(evt)}\n`, "utf-8");
}

describe("kanban-data: kanban-card-detail bounded events handler", () => {
  it("response includes totalEvents and truncated fields", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-kanban-bounded-");
    const stateDir = tamanduaDir;
    const dbPath = path.join(stateDir, "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const runId = "run-kanban-bounded";

    // Create 10 events in the per-run file
    for (let i = 0; i < 10; i++) {
      appendRunEvent(stateDir, runId, {
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i * 1000)).toISOString(),
        event: "step.running",
        runId,
        stepId: "plan",
        detail: `event ${i}`,
      });
    }

    // Insert run and step into DB
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-test', 'test task', 'running', '{}', 0, ?, ?)
    `).run(runId, now, now);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 'done', 'single', NULL, 0, ?, ?)
    `).run(`step_${runId}_plan`, runId, "plan", "wf-test_planner", 0, "", now, now);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/kanban/card-detail?cardId=plan`);
      assert.equal(response.status, 200);

      const body = await response.json() as {
        totalEvents: number;
        truncated: boolean;
        title: string;
        events: TamanduaEvent[];
        [key: string]: unknown;
      };

      assert.equal(body.totalEvents, 10, "totalEvents should be 10");
      assert.equal(body.truncated, false, "truncated should be false for small file");
      // Existing fields still present
      assert.equal(body.title, "planner step");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
    }
  });

  it("response has truncated=true when totalEvents > bounded count", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-kanban-bounded-");
    const stateDir = tamanduaDir;
    const dbPath = path.join(stateDir, "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const runId = "run-kanban-many";

    // Create 250 events (more than the 200 cap)
    for (let i = 0; i < 250; i++) {
      appendRunEvent(stateDir, runId, {
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i * 1000)).toISOString(),
        event: "step.running",
        runId,
        stepId: "plan",
        detail: `event ${i}`,
      });
    }

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-test', 'test task', 'running', '{}', 0, ?, ?)
    `).run(runId, now, now);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 'done', 'single', NULL, 0, ?, ?)
    `).run(`step_${runId}_plan`, runId, "plan", "wf-test_planner", 0, "", now, now);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/kanban/card-detail?cardId=plan`);
      assert.equal(response.status, 200);

      const body = await response.json() as {
        totalEvents: number;
        truncated: boolean;
        events: TamanduaEvent[];
        [key: string]: unknown;
      };

      assert.equal(body.totalEvents, 250, "totalEvents should be 250");
      assert.equal(body.truncated, true, "truncated should be true when totalEvents > 200");
      assert.ok(body.events.length <= 200, `events length ${body.events.length} should be <= 200`);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
    }
  });
});
