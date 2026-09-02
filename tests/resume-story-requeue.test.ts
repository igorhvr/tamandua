/**
 * YSE US-002: resume re-queues FAILED loop stories to pending with a fresh
 * retry budget.
 *
 * Covers:
 * 1. resetFailedStoriesForResume (unit, in-process DB): failed stories of a
 *    loop-over-stories run are reset to pending (retry_count 0, output NULL,
 *    resume_reset_count +1) with one story.reset_for_resume event each
 *    (storyId + priorFailures = 1 on first reset); done/pending stories are
 *    untouched.
 * 2. Repeated resets accumulate resume_reset_count / priorFailures.
 * 3. No-op shapes: no loop-over-stories step, non-stories loop, no failed
 *    stories — resets nothing, emits no story.reset_for_resume events.
 * 4. CLI (daemon-backed): tamandua workflow resume of a failed loop run with
 *    reset stories prints the re-queue confirmation including the count, the
 *    DB rows are reset, and the event stream records the resets.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "dist", "server", "daemon.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForControlUp(port: number, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/control/health`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`control plane did not come up on port ${port}`);
}

function ts(): string {
  return new Date().toISOString();
}

// ── In-process unit tests for resetFailedStoriesForResume ─────────────

describe("YSE resetFailedStoriesForResume", { concurrency: 1 }, () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  const th = createTempHome("tamandua-resume-requeue-unit-");

  before(() => {
    process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
  });

  // Lazily import so TAMANDUA_DB_PATH is already set before getDb is first used.
  let db: DatabaseSync;
  let resetFailedStoriesForResume: (runId: string) => { resetCount: number };
  let getRunEvents: (runId: string) => Array<Record<string, unknown>>;

  before(async () => {
    const { getDb } = await import("../dist/db.js");
    db = getDb();
    const stepOps = await import("../dist/installer/step-ops.js");
    resetFailedStoriesForResume = stepOps.resetFailedStoriesForResume;
    const events = await import("../dist/installer/events.js");
    getRunEvents = events.getRunEvents;
  });

  function seedRun(runId: string, workflowId = "wf-loop"): void {
    const now = ts();
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, ?, 'loop resume task', 'failed', '{}', 0, ?, ?)`,
    ).run(runId, workflowId, now, now);
  }

  function seedLoopStep(runId: string, opts: { over?: string; loopConfigRaw?: string } = {}): string {
    const now = ts();
    const loopStepRowId = crypto.randomUUID();
    const loopConfig = opts.loopConfigRaw ?? JSON.stringify({ over: opts.over ?? "stories", completion: "all_done" });
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'implement', 'wf-loop_developer', 2, 'Implement {{current_story}}', '', 'failed', 0, 4, 'loop', ?, ?, ?)`,
    ).run(loopStepRowId, runId, loopConfig, now, now);
    return loopStepRowId;
  }

  function seedSingleStep(runId: string): void {
    const now = ts();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'single-step', 'wf-loop_single', 0, 'work', '', 'failed', 0, 4, 'single', ?, ?)`,
    ).run(crypto.randomUUID(), runId, now, now);
  }

  function seedStory(
    runId: string,
    storyIndex: number,
    storyId: string,
    status: string,
    opts: { retryCount?: number; output?: string | null; resetCount?: number } = {},
  ): void {
    const now = ts();
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, retry_count, max_retries, resume_reset_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'desc', '[]', ?, ?, ?, 4, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(), runId, storyIndex, storyId, `Story ${storyId}`,
      status, opts.output ?? null, opts.retryCount ?? 0, opts.resetCount ?? 0, now, now,
    );
  }

  function storyRow(runId: string, storyId: string): {
    status: string; retry_count: number; output: string | null; resume_reset_count: number;
  } {
    return db.prepare(
      "SELECT status, retry_count, output, resume_reset_count FROM stories WHERE run_id = ? AND story_id = ?",
    ).get(runId, storyId) as {
      status: string; retry_count: number; output: string | null; resume_reset_count: number;
    };
  }

  function newRunId(): string {
    return crypto.randomUUID();
  }

  it("resets FAILED loop stories to pending (retry 0, output NULL, resume_reset_count +1), leaves done/pending untouched, emits one event per reset with storyId and priorFailures 1", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedLoopStep(runId);
    seedStory(runId, 0, "US-001", "failed", { retryCount: 4, output: "verification retries exhausted" });
    seedStory(runId, 1, "US-002", "failed", { retryCount: 4, output: "verification retries exhausted" });
    seedStory(runId, 2, "US-003", "done", { output: "story done output" });
    seedStory(runId, 3, "US-004", "pending");

    const result = resetFailedStoriesForResume(runId);

    assert.equal(result.resetCount, 2, "both failed stories should be reset");

    for (const storyId of ["US-001", "US-002"]) {
      const row = storyRow(runId, storyId);
      assert.equal(row.status, "pending", `${storyId} should be pending after reset`);
      assert.equal(row.retry_count, 0, `${storyId} should have a fresh retry budget (retry_count 0)`);
      assert.equal(row.output, null, `${storyId} output should be cleared so stale failure text is not re-surfaced`);
      assert.equal(row.resume_reset_count, 1, `${storyId} resume_reset_count should increment to 1 on first reset`);
    }

    // Stories already done/pending are untouched.
    const doneRow = storyRow(runId, "US-003");
    assert.equal(doneRow.status, "done", "done story must stay done");
    assert.equal(doneRow.resume_reset_count, 0, "done story must not be touched");
    assert.equal(doneRow.output, "story done output", "done story output must not be cleared");
    const pendingRow = storyRow(runId, "US-004");
    assert.equal(pendingRow.status, "pending", "pending story stays pending");
    assert.equal(pendingRow.retry_count, 0, "pending story retry budget untouched");
    assert.equal(pendingRow.resume_reset_count, 0, "pending story must not be counted as a reset");

    // Event stream: one story.reset_for_resume per reset with storyId + priorFailures.
    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 2, "one reset event per reset story");
    const storyIds = events.map((e) => e.storyId).sort();
    assert.deepEqual(storyIds, ["US-001", "US-002"]);
    for (const evt of events) {
      assert.equal(evt.stepId, "implement", "event should carry the loop step's step_id");
      assert.equal(evt.runId, runId);
      assert.equal(evt.priorFailures, 1, "first reset should carry priorFailures 1");
      assert.ok(
        typeof evt.detail === "string" && (evt.detail as string).includes("prior failures: 1"),
        `detail should carry the prior failure count, got: ${evt.detail}`,
      );
    }
  });

  it("second failure episode + resume produces resume_reset_count 2 and priorFailures 2", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedLoopStep(runId);
    seedStory(runId, 0, "US-001", "failed", { retryCount: 4, output: "first failure" });

    const first = resetFailedStoriesForResume(runId);
    assert.equal(first.resetCount, 1);
    assert.equal(storyRow(runId, "US-001").resume_reset_count, 1);

    // Simulate the story failing again after the reset (fresh episode).
    db.prepare(
      "UPDATE stories SET status = 'failed', retry_count = 4, output = 'second failure', updated_at = datetime('now') WHERE run_id = ? AND story_id = ?",
    ).run(runId, "US-001");

    const second = resetFailedStoriesForResume(runId);
    assert.equal(second.resetCount, 1, "second episode should reset again");
    assert.equal(storyRow(runId, "US-001").status, "pending");
    assert.equal(storyRow(runId, "US-001").resume_reset_count, 2, "resume_reset_count accumulates across episodes");

    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.priorFailures),
      [1, 2],
      "priorFailures should be 1 then 2 across the two resets",
    );
  });

  it("no-op when the run has no loop-over-stories step (single step / no loop step): 0 resets, no events", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedSingleStep(runId);
    seedStory(runId, 0, "US-001", "failed", { retryCount: 4, output: "boom" });

    const result = resetFailedStoriesForResume(runId);

    assert.equal(result.resetCount, 0);
    assert.equal(storyRow(runId, "US-001").status, "failed", "failed story must not be touched without a loop step");
    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 0, "no reset events when there is no loop-over-stories step");
  });

  it("no-op when the loop step is not over stories: 0 resets, no events", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedLoopStep(runId, { over: "files" });
    seedStory(runId, 0, "US-001", "failed", { retryCount: 4, output: "boom" });

    const result = resetFailedStoriesForResume(runId);

    assert.equal(result.resetCount, 0);
    assert.equal(storyRow(runId, "US-001").status, "failed", "failed story must not be touched for a non-stories loop");
    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 0);
  });

  it("no-op on malformed loop_config JSON: 0 resets, no events", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedLoopStep(runId, { loopConfigRaw: "{not-json" });
    seedStory(runId, 0, "US-001", "failed", { retryCount: 4, output: "boom" });

    const result = resetFailedStoriesForResume(runId);

    assert.equal(result.resetCount, 0);
    assert.equal(storyRow(runId, "US-001").status, "failed");
    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 0);
  });

  it("no-op when the loop run has no failed stories: 0 resets, no events", async () => {
    const runId = newRunId();
    seedRun(runId);
    seedLoopStep(runId);
    seedStory(runId, 0, "US-001", "done", { output: "done output" });
    seedStory(runId, 1, "US-002", "pending");

    const result = resetFailedStoriesForResume(runId);

    assert.equal(result.resetCount, 0);
    const events = getRunEvents(runId).filter((e) => e.event === "story.reset_for_resume");
    assert.equal(events.length, 0, "no reset events when nothing failed");
  });
});

// ── CLI-level test (daemon-backed) ─────────────────────────────────────

describe("tamandua workflow resume re-queues failed loop stories (YSE)", { concurrency: 1 }, () => {
  it("prints the re-queue confirmation with the count, resets DB rows, and records story.reset_for_resume events", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    const th = createTempHome("tamandua-resume-requeue-cli-");
    const dbPath = path.join(th.tamanduaDir, "tamandua.db");

    const runId = crypto.randomUUID();
    const now = ts();

    // Seed a failed loop-over-stories run: all steps DONE (so nothing is
    // re-dispatched by the daemon after resume) with FAILED stories left in
    // the pool. This is the YSE regression shape: resume must re-queue the
    // failed stories even though the step pipeline needs no repair.
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS steps (
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
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS stories (
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
      resume_reset_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, ?, 'loop resume task', 'failed', ?, 0, ?, ?)`,
    ).run(runId, "feature-dev-merge", JSON.stringify({ working_directory_for_harness: th.root }), now, now);

    // Loop step (developer implement) — done. Other pipeline steps done too.
    const loopStepId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'implement', 'feature-dev-merge_developer', 3, 'Implement {{current_story}}', '', 'done', 0, 4, 'loop', ?, ?, ?)`,
    ).run(loopStepId, runId, JSON.stringify({ over: "stories", completion: "all_done" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, 'Plan', '', 'done', 0, 4, 'single', ?, ?)`,
    ).run(crypto.randomUUID(), runId, now, now);

    const storySeed = (index: number, storyId: string, status: string, retryCount: number, output: string | null) => {
      db.prepare(
        `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, retry_count, max_retries, resume_reset_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'desc', '[]', ?, ?, ?, 4, 0, ?, ?)`,
      ).run(crypto.randomUUID(), runId, index, storyId, `Story ${storyId}`, status, output, retryCount, now, now);
    };
    storySeed(0, "US-001", "failed", 4, "verification retries exhausted");
    storySeed(1, "US-002", "failed", 4, "verification retries exhausted");
    storySeed(2, "US-003", "done", 0, "done output");
    storySeed(3, "US-004", "pending", 0, null);
    db.close();

    // Copy the workflow directory so the daemon can register the run on resume.
    const srcWorkflowDir = path.resolve(__dirname, "..", "workflows", "feature-dev-merge");
    const dstWorkflowDir = path.join(th.tamanduaDir, "workflows", "feature-dev-merge");
    fs.mkdirSync(path.dirname(dstWorkflowDir), { recursive: true });
    fs.cpSync(srcWorkflowDir, dstWorkflowDir, { recursive: true });

    let daemon: ChildProcess | undefined;
    try {
      daemon = spawn("node", [DAEMON_SCRIPT], {
        env: cleanChildEnv({ HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout?.resume();
      daemon.stderr?.resume();

      await waitForControlUp(controlPort);

      const { stdout, stderr, exitCode } = await runCli(
        ["workflow", "resume", runId.slice(0, 8)],
        { HOME: th.homeDir, TAMANDUA_CONTROL_PORT: String(controlPort) },
      );

      assert.equal(exitCode, 0, `Should exit 0, got ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(
        stdout.includes("Resumed run"),
        `Expected "Resumed run" in stdout, got: ${stdout}`,
      );
      assert.ok(
        stdout.includes("Reset 2 failed stories to pending for resume."),
        `Expected re-queue confirmation with count in stdout, got: ${stdout}`,
      );

      // DB rows: failed stories re-queued; done/pending untouched.
      const checkDb = new DatabaseSync(dbPath);
      const rows = checkDb.prepare(
        "SELECT story_id, status, retry_count, output, resume_reset_count FROM stories WHERE run_id = ? ORDER BY story_index ASC",
      ).all(runId) as Array<{
        story_id: string; status: string; retry_count: number; output: string | null; resume_reset_count: number;
      }>;
      checkDb.close();

      assert.deepEqual(rows.map((r) => r.story_id), ["US-001", "US-002", "US-003", "US-004"]);
      for (const row of rows) {
        if (row.story_id === "US-001" || row.story_id === "US-002") {
          assert.equal(row.status, "pending", `${row.story_id} should be re-queued pending`);
          assert.equal(row.retry_count, 0, `${row.story_id} should have a fresh retry budget`);
          assert.equal(row.output, null, `${row.story_id} output should be cleared`);
          assert.equal(row.resume_reset_count, 1, `${row.story_id} resume_reset_count should be 1`);
        } else if (row.story_id === "US-003") {
          assert.equal(row.status, "done", "done story must stay done");
          assert.equal(row.resume_reset_count, 0);
        } else if (row.story_id === "US-004") {
          assert.equal(row.status, "pending", "pending story stays pending");
          assert.equal(row.resume_reset_count, 0, "pending story must not be counted as reset");
        }
      }

      // Event stream records the resets.
      const eventsPath = path.join(th.tamanduaDir, "events", `${runId}.jsonl`);
      const raw = fs.readFileSync(eventsPath, "utf-8");
      const events = raw.trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const resetEvents = events.filter((e) => e.event === "story.reset_for_resume");
      assert.equal(resetEvents.length, 2, "one story.reset_for_resume per reset story");
      assert.deepEqual(
        resetEvents.map((e) => e.storyId).sort(),
        ["US-001", "US-002"],
      );
      for (const evt of resetEvents) {
        assert.equal(evt.stepId, "implement", "reset event should carry the loop step id");
        assert.equal(evt.priorFailures, 1, "first reset carries priorFailures 1");
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.pid) {
        try { process.kill(daemon.pid, "SIGTERM"); } catch { /* ignore */ }
        await sleep(300);
      }
    }
  });
});
