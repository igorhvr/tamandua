/**
 * NativeQueryServices (US-004): real native readers behind the broker's
 * run-scoped read-only query ops (serial lane — imports host modules that
 * reach node:child_process via step-ops).
 *
 * Drives the REAL production query service against a real isolated DB +
 * events store (temp HOME/STATE/DB): stories() returns the native-shaped
 * prefixed payload over getStories; workflowStatus() returns the shared
 * native run-JSON object (byte-identical builder used by the native CLI);
 * runLogs() returns bounded native log lines over getRunEvents + the native
 * logs-tail formatter, truncating at the strict tail/byte bounds. Defense in
 * depth: a binding for a different run is refused before any read.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import { NativeQueryServices } from "../../../dist/installer/matchlock/host-query-service.js";
import {
  GUEST_RUN_LOG_DEFAULT_LIMIT,
  GUEST_RUN_LOG_LIMIT_MAX,
  GUEST_RUN_LOG_PAYLOAD_BYTES,
} from "../../../dist/installer/matchlock/guest-protocol.js";
import { getDb } from "../../../dist/db.js";
import { getStories, buildStoriesJson } from "../../../dist/installer/step-ops.js";
import { formatLogsTailLines } from "../../../dist/installer/logs-tail-format.js";
import type { HostBinding } from "../../../dist/installer/matchlock/broker-services.js";

const RUN_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OTHER_RUN = "c9d8e7f6-a5b4-3210-fedc-ba9876543210";
const NOW = "2026-09-09T00:00:00.000Z";

interface TempState {
  homeDir: string;
  stateDir: string;
  dbPath: string;
  eventsDir: string;
}

let state: TempState;

function makeBinding(runId: string): HostBinding {
  return {
    runId,
    invocationId: "bbbbbbbb-2222-4222-8222-222222222222",
    agentId: "feature-dev-merge_developer",
    jobId: "job-1",
    role: "developer",
    admittedRoots: ["/work"],
    helperProtocolVersion: "bv+p1",
    helperBuildVersion: "bv",
  };
}

before(() => {
  // Project-sanctioned temp helpers (tamanduaTempDir) — no direct temp dir calls.
  const homeRoot = tamanduaTempDir("tamandua-hq-home-");
  const stateRoot = tamanduaTempDir("tamandua-hq-state-");
  const dbRoot = tamanduaTempDir("tamandua-hq-db-");
  state = {
    homeDir: homeRoot,
    stateDir: stateRoot,
    dbPath: path.join(dbRoot, "tamandua.db"),
    eventsDir: "",
  };
  state.eventsDir = path.join(state.stateDir, "events");
  process.env.HOME = state.homeDir;
  process.env.TAMANDUA_STATE_DIR = state.stateDir;
  process.env.TAMANDUA_DB_PATH = state.dbPath;
  process.env.TAMANDUA_TEST_GUARD = "1";
  // Seed ONCE for the whole file (tests never mutate the seeded rows).
  seedDb(getDb());
});

after(() => {
  for (const dir of [state.homeDir, state.stateDir, path.dirname(state.dbPath)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function seedDb(db: ReturnType<typeof getDb>): void {
  // Minimal runs row (schema-compatible; mirrors native CLI tests).
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(RUN_ID, 1, "feature-dev-merge-worktree", "US-004 query surface", "running", "{}", 0, NOW, NOW);
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, resume_reset_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s1", RUN_ID, 0, "US-001", "First story", "Desc", '["AC1"]', "done", 0, 4, 3, 0, NOW, NOW);
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, abandoned_count, resume_reset_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("s2", RUN_ID, 1, "US-002", "Second story", "Desc2", '["AC2"]', "pending", 2, 4, 0, 1, NOW, NOW);
}

function writeRunEvents(runId: string, events: unknown[]): void {
  fs.mkdirSync(state.eventsDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(state.eventsDir, `${runId}.jsonl`), lines, "utf-8");
}

function sampleEvents(): unknown[] {
  return [
    { ts: "2026-09-09T08:00:00.000Z", event: "step.pending", runId: RUN_ID, stepId: "step-a", agentId: "feature-dev-merge_developer", detail: "first" },
    { ts: "2026-09-09T08:00:01.000Z", event: "step.done", runId: RUN_ID, stepId: "step-a", agentId: "feature-dev-merge_developer", detail: "second" },
  ];
}

describe("NativeQueryServices (US-004)", () => {
  it("stories() returns the native-shaped prefixed payload built from getStories", async () => {

    const svc = new NativeQueryServices({ runId: RUN_ID });
    const payload = await svc.stories(makeBinding(RUN_ID));

    assert.equal(payload.runId, `run-${RUN_ID}`);
    const native = getStories(RUN_ID);
    assert.equal(payload.stories.length, native.length);

    // The --json entry the guest CLI will print equals native buildStoriesJson.
    const jsonEntries = payload.stories.map((s) => ({
      storyId: s.storyId,
      title: s.title,
      status: s.status,
      ...(s.abandonedCount !== undefined && s.abandonedCount !== 0 ? { abandonedCount: s.abandonedCount } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    }));
    assert.deepEqual(jsonEntries, buildStoriesJson(native));
  });

  it("workflowStatus() returns the exact native run-JSON object shape", async () => {

    const svc = new NativeQueryServices({ runId: RUN_ID });
    const status = await svc.workflowStatus(makeBinding(RUN_ID));
    assert.equal(status.runId, `run-${RUN_ID}`);
    assert.equal(status.workflowId, "feature-dev-merge-worktree");
    assert.equal(status.status, "running");
    assert.equal(status.harnessType, "pi");
    assert.ok(Array.isArray(status.steps));
    const stories = status.stories as Array<Record<string, unknown>>;
    assert.equal(stories.length, 2);
    // native status JSON keeps the RAW stored status + machine counters.
    assert.equal(stories[1].status, "pending");
    assert.equal(stories[1].resumeResetCount, 1);
    assert.equal(stories[1].priorFailureCount, 1);
  });

  it("runLogs() returns bounded native log lines over getRunEvents + formatLogsTailLines", async () => {

    writeRunEvents(RUN_ID, sampleEvents());
    const svc = new NativeQueryServices({ runId: RUN_ID });
    const logs = await svc.runLogs(makeBinding(RUN_ID), GUEST_RUN_LOG_DEFAULT_LIMIT);
    assert.equal(logs.runId, `run-${RUN_ID}`);
    assert.equal(logs.limit, GUEST_RUN_LOG_DEFAULT_LIMIT);
    assert.deepEqual(logs.lines, formatLogsTailLines(getStoriesEventsAsEvents()));
    assert.equal(logs.truncated, false);
  });

  it("runLogs() caps the tail at the strict wire maximum and reports truncation", async () => {

    const events = Array.from({ length: GUEST_RUN_LOG_LIMIT_MAX + 25 }, (_, i) => ({
      ts: "2026-09-09T08:00:00.000Z",
      event: "run.nudged",
      runId: RUN_ID,
      detail: `event ${i}`,
    }));
    writeRunEvents(RUN_ID, events);
    const svc = new NativeQueryServices({ runId: RUN_ID });
    // Requesting beyond the maximum is bounded by the service to the maximum.
    const logs = await svc.runLogs(makeBinding(RUN_ID), 10_000);
    assert.equal(logs.limit, GUEST_RUN_LOG_LIMIT_MAX);
    assert.equal(logs.lines.length, GUEST_RUN_LOG_LIMIT_MAX);
    assert.equal(logs.truncated, true, "events beyond the tail bound must be reported truncated");
    // The kept lines are the NEWEST events (chronological tail).
    assert.match(logs.lines[logs.lines.length - 1], /event 224/);
  });

  it("runLogs() byte-bounds the response and drops the OLDEST oversized lines", async () => {

    const bigA = `AAA ${"x".repeat(Math.floor(GUEST_RUN_LOG_PAYLOAD_BYTES * 0.6))}`;
    const bigB = `BBB ${"y".repeat(Math.floor(GUEST_RUN_LOG_PAYLOAD_BYTES * 0.6))}`;
    writeRunEvents(RUN_ID, [
      { ts: "2026-09-09T08:00:00.000Z", event: "run.nudged", runId: RUN_ID, detail: bigA },
      { ts: "2026-09-09T08:00:01.000Z", event: "run.nudged", runId: RUN_ID, detail: bigB },
    ]);
    const svc = new NativeQueryServices({ runId: RUN_ID });
    const logs = await svc.runLogs(makeBinding(RUN_ID), GUEST_RUN_LOG_LIMIT_MAX);
    assert.equal(logs.truncated, true, "oversized payload must be reported truncated");
    assert.equal(logs.lines.length, 1, "only the newest line that fits is kept");
    assert.match(logs.lines[0], /BBB/);
    assert.doesNotMatch(logs.lines[0], /AAA/, "the OLDEST oversized line is dropped");
  });

  it("defense in depth: a binding for a DIFFERENT run is refused before any read", async () => {

    const svc = new NativeQueryServices({ runId: RUN_ID });
    await assert.rejects(() => svc.stories(makeBinding(OTHER_RUN)), /binding mismatch/);
    await assert.rejects(() => svc.workflowStatus(makeBinding(OTHER_RUN)), /binding mismatch/);
    await assert.rejects(() => svc.runLogs(makeBinding(OTHER_RUN), 10), /binding mismatch/);
  });
});

/** Helper: read back the seeded events the same way the formatter expects. */
function getStoriesEventsAsEvents(): unknown[] {
  const content = fs.readFileSync(path.join(state.eventsDir, `${RUN_ID}.jsonl`), "utf-8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
