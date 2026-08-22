/**
 * TATR US-011: integration tests — cancel-race and post-terminal token
 * ordering under load.
 *
 * Two contracts, proven end-to-end through the real scheduler (dist build)
 * against an isolated temp HOME/state dir with an instrumented fake pi
 * harness whose post-round token attribution is delayed (it claims a step,
 * writes an in-flight marker, sleeps 300ms, then emits pi-style message_end
 * usage metadata — the deterministic-motor-acceptance / status.test.ts
 * fake-pi seam):
 *
 *   1. Cancel-race (TATR facet 3 / US-006): canceling a run while a worker
 *      round is in flight settles the round's token attribution BEFORE the
 *      terminal run.canceled is emitted. Asserted from the on-disk
 *      events/<runId>.jsonl stream: exactly one run.tokens.updated, it
 *      precedes run.canceled, run.canceled is the FINAL event (nothing
 *      trails it), and the terminal event's tokensSpent includes the
 *      settled delta.
 *
 *   2. Post-terminal flush (TATR facet 4 / US-007): a token flush whose
 *      attribution lands after the run reached a terminal status is
 *      explicitly identified — the emitted run.tokens.updated carries
 *      postTerminal: true + terminalStatus and is readable AFTER the
 *      terminal event in the same stream (the C15 final-round gap).
 *      Attribution runs through the real post-round path (a full dispatch
 *      round whose run is flipped to 'failed' mid-harness), because
 *      attributeWorkRoundTokenUsage is module-private in agent-scheduler.
 *
 * Both scenarios run under a small load loop (5 iterations each) with a
 * fresh isolated temp HOME per iteration to exercise the race repeatedly.
 *
 * Each iteration runs in a subprocess (spawnSync + cleanChildEnv) so the
 * scheduler executes against real event files on disk with real temp
 * HOME/DB state — the deterministic-motor-acceptance pattern.
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();

/** Subprocess script output shapes (the JSON printed last by each script). */
interface TokenEventShape {
  tokenDelta: number;
  tokensSpent: number;
  postTerminal?: boolean;
  terminalStatus?: string;
}

interface CancelRaceResult {
  runId: string;
  ok: boolean;
  events: string[];
  canceledTokensSpent: number | null;
  tokenEvents: TokenEventShape[];
  tokensSpent: number;
  status: string;
}

interface PostTerminalResult {
  runId: string;
  events: string[];
  failedTokensSpent: number | null;
  tokenEvents: TokenEventShape[];
  tokensSpent: number;
  status: string;
}

function runNodeScript(script: string, env: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Script failed with exit ${result.status}`,
        `STDOUT:\n${result.stdout}`,
        `STDERR:\n${result.stderr}`,
      ].join("\n\n"),
    );
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }
  return JSON.parse(lastLine) as Record<string, unknown>;
}

/**
 * Fake pi lines shared by both scenarios: claim the pending step, write the
 * in-flight marker, sleep 300ms (so the parent can cancel / flip the run
 * mid-round), then emit a pi-shaped message_end with usage.totalTokens = 137
 * followed by a STATUS: done marker. 137 tokens match the TATR unit tests.
 */
const FAKE_PI_LINES = [
  "#!/usr/bin/env node",
  'import { DatabaseSync } from "node:sqlite";',
  'import fs from "node:fs";',
  "const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);",
  'db.exec("PRAGMA busy_timeout = 5000");',
  "db.prepare(\"UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'\").run(process.env.TAMANDUA_WORKER_JOB_ID);",
  'fs.writeFileSync(process.env.TAMANDUA_ROUND_MARKER, "inflight");',
  "await new Promise((resolve) => setTimeout(resolve, 300));",
  'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "STATUS: done", usage: { totalTokens: 137 } } }));',
  'console.log("STATUS: done");',
  "process.exit(0);",
].join("\n");

/**
 * Cancel-race iteration: seed a running run + pending step, register the
 * run's dispatch job, start a dispatch round whose attribution is delayed,
 * wait for the in-flight marker, then call stopWorkflow mid-round. Reports
 * the on-disk event stream, the terminal event's tokensSpent, and the DB.
 */
const CANCEL_RACE_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { executeDispatchRound, setupAgentCrons, shutdownAllCrons } from "./dist/installer/agent-scheduler.js";
import { stopWorkflow } from "./dist/installer/status.js";
import { getDb } from "./dist/db.js";

const db = getDb();
const runId = crypto.randomUUID();
const now = new Date().toISOString();
const workdir = path.join(process.env.HOME, "work");
fs.mkdirSync(workdir, { recursive: true });

db.prepare(
  "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at, tokens_spent) VALUES (?, 'wf-cancel-race', 'cancel race', 'running', ?, ?, ?, 0)"
).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
db.prepare(
  "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'wf-cancel-race_developer', 0, 'do work', 'STATUS', 'pending', ?, ?)"
).run(runId + "-step", runId, now, now);

const workflow = {
  id: "wf-cancel-race",
  agents: [{ id: "developer", model: "fake", workspace: { baseDir: "." } }],
  steps: [{ id: "step-1", agent: "developer", input: "do work", expects: "STATUS" }],
};
await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

const fakePi = path.join(process.env.HOME, "pi-mock");
const marker = path.join(process.env.HOME, "round.marker");
fs.writeFileSync(fakePi, ${JSON.stringify(FAKE_PI_LINES)}, { mode: 0o755 });

process.env.TAMANDUA_PI_BINARY = fakePi;
process.env.TAMANDUA_ROUND_MARKER = marker;

const jobId = "tamandua-wf-cancel-race-" + runId + "-developer";
const round = executeDispatchRound(
  {
    id: jobId,
    workflowId: "wf-cancel-race",
    runId,
    agentId: "wf-cancel-race_developer",
    harnessType: "pi",
    workingDirectoryForHarness: workdir,
    createdAt: "",
  },
  { id: "developer", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
);

const waitStarted = Date.now();
while (Date.now() - waitStarted < 5000) {
  if (fs.existsSync(marker)) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!fs.existsSync(marker)) {
  throw new Error("round never reached in-flight state");
}

const stopResult = await stopWorkflow(runId);
await round;
shutdownAllCrons();

const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
const raw = fs.readFileSync(eventsPath, "utf-8");
const events = raw.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
const runRow = db.prepare("SELECT tokens_spent, status FROM runs WHERE id = ?").get(runId);
const canceledEvent = events.find((e) => e.event === "run.canceled");
console.log(JSON.stringify({
  runId,
  ok: stopResult.ok,
  events: events.map((e) => e.event),
  canceledTokensSpent: canceledEvent ? canceledEvent.tokensSpent : null,
  tokenEvents: events
    .filter((e) => e.event === "run.tokens.updated")
    .map((e) => ({ tokenDelta: e.tokenDelta, tokensSpent: e.tokensSpent, postTerminal: e.postTerminal, terminalStatus: e.terminalStatus })),
  tokensSpent: runRow.tokens_spent,
  status: runRow.status,
}));
`;

/**
 * Post-terminal iteration: seed a running run + pending step, start a
 * dispatch round with the delayed-attribution fake pi, then mid-round flip
 * the run to terminal 'failed' AND emit the terminal run.failed event
 * (emitRunTerminalEvent — the C15 final-round gap). The round's
 * post-processing then attributes the 137-token usage against a terminal
 * run, which must produce a run.tokens.updated with postTerminal: true
 * readable AFTER run.failed in events/<runId>.jsonl.
 */
const POST_TERMINAL_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { executeDispatchRound, setupAgentCrons, shutdownAllCrons } from "./dist/installer/agent-scheduler.js";
import { getDb } from "./dist/db.js";

const db = getDb();
const runId = crypto.randomUUID();
const now = new Date().toISOString();
const workdir = path.join(process.env.HOME, "work");
fs.mkdirSync(workdir, { recursive: true });

db.prepare(
  "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at, tokens_spent) VALUES (?, 'wf-post-terminal', 'post-terminal flush', 'running', ?, ?, ?, 0)"
).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
db.prepare(
  "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'wf-post-terminal_developer', 0, 'do work', 'STATUS', 'pending', ?, ?)"
).run(runId + "-step", runId, now, now);

const workflow = {
  id: "wf-post-terminal",
  agents: [{ id: "developer", model: "fake", workspace: { baseDir: "." } }],
  steps: [{ id: "step-1", agent: "developer", input: "do work", expects: "STATUS" }],
};
await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: workdir });

const fakePi = path.join(process.env.HOME, "pi-mock");
const marker = path.join(process.env.HOME, "round.marker");
fs.writeFileSync(fakePi, ${JSON.stringify(FAKE_PI_LINES)}, { mode: 0o755 });

process.env.TAMANDUA_PI_BINARY = fakePi;
process.env.TAMANDUA_ROUND_MARKER = marker;

const jobId = "tamandua-wf-post-terminal-" + runId + "-developer";
const round = executeDispatchRound(
  {
    id: jobId,
    workflowId: "wf-post-terminal",
    runId,
    agentId: "wf-post-terminal_developer",
    harnessType: "pi",
    workingDirectoryForHarness: workdir,
    createdAt: "",
  },
  { id: "developer", model: "fake", workspace: { baseDir: "." }, timeoutSeconds: 10 },
);

const waitStarted = Date.now();
while (Date.now() - waitStarted < 5000) {
  if (fs.existsSync(marker)) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!fs.existsSync(marker)) {
  throw new Error("round never reached in-flight state");
}

// The run reaches a terminal status mid-harness (its final step's outcome
// already marked it failed) and the terminal event fires BEFORE this
// round's usage parses — the exact C15 final-round gap.
db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(runId);
const { emitRunTerminalEvent } = await import("./dist/installer/step-ops.js");
emitRunTerminalEvent({ event: "run.failed", runId, workflowId: "wf-post-terminal" });

await round;
shutdownAllCrons();

const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
const raw = fs.readFileSync(eventsPath, "utf-8");
const events = raw.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
const runRow = db.prepare("SELECT tokens_spent, status FROM runs WHERE id = ?").get(runId);
const failedEvent = events.find((e) => e.event === "run.failed");
console.log(JSON.stringify({
  runId,
  events: events.map((e) => e.event),
  failedTokensSpent: failedEvent ? failedEvent.tokensSpent : null,
  tokenEvents: events
    .filter((e) => e.event === "run.tokens.updated")
    .map((e) => ({ tokenDelta: e.tokenDelta, tokensSpent: e.tokensSpent, postTerminal: e.postTerminal, terminalStatus: e.terminalStatus })),
  tokensSpent: runRow.tokens_spent,
  status: runRow.status,
}));
`;

const LOAD_ITERATIONS = 5;

describe("TATR US-011: cancel-race and post-terminal token ordering under load", () => {
  it("cancel during an in-flight round settles token attribution before run.canceled (load loop)", () => {
    for (let i = 0; i < LOAD_ITERATIONS; i++) {
      const temp = createTempHome("tamandua-cancel-race-");
      try {
        const result = runNodeScript(CANCEL_RACE_SCRIPT, { HOME: temp.homeDir }) as unknown as CancelRaceResult;

        // Sanity: stopWorkflow succeeded and the run reached canceled.
        assert.equal(result.ok, true, `iteration ${i}: stopWorkflow must succeed`);
        assert.equal(result.status, "canceled", `iteration ${i}: run must be canceled in the DB`);

        // Ordering from events/<runId>.jsonl: exactly one settled
        // run.tokens.updated, it precedes run.canceled, and run.canceled
        // is the FINAL event — nothing trails it (US-006 contract).
        const events = result.events;
        assert.ok(events.includes("run.canceled"), `iteration ${i}: run.canceled must be present`);
        assert.equal(
          events.filter((e) => e === "run.tokens.updated").length,
          1,
          `iteration ${i}: exactly one run.tokens.updated must be present`,
        );
        const tokenIdx = events.indexOf("run.tokens.updated");
        const canceledIdx = events.lastIndexOf("run.canceled");
        assert.equal(canceledIdx, events.length - 1, `iteration ${i}: run.canceled must be the final event`);
        assert.ok(tokenIdx < canceledIdx, `iteration ${i}: token attribution must settle before run.canceled`);

        // The settled delta is reflected in the terminal event and the DB.
        assert.equal(result.canceledTokensSpent, 137, `iteration ${i}: run.canceled tokensSpent must include the settled delta`);
        assert.equal(result.tokenEvents[0]?.tokenDelta, 137, `iteration ${i}: the settled delta must be 137`);
        assert.equal(result.tokensSpent, 137, `iteration ${i}: DB tokens_spent must include the settled delta`);
      } finally {
        fs.rmSync(temp.root, { recursive: true, force: true });
      }
    }
  });

  it("post-terminal token flush carries postTerminal: true after the terminal event (load loop)", () => {
    for (let i = 0; i < LOAD_ITERATIONS; i++) {
      const temp = createTempHome("tamandua-postterminal-");
      try {
        const result = runNodeScript(POST_TERMINAL_SCRIPT, { HOME: temp.homeDir }) as unknown as PostTerminalResult;

        // Sanity: the run reached failed with the flush's delta.
        assert.equal(result.status, "failed", `iteration ${i}: run must be failed in the DB`);
        assert.equal(result.tokensSpent, 137, `iteration ${i}: DB tokens_spent must include the late flush`);

        // The terminal event fired BEFORE attribution (C15 gap): run.failed
        // is present and its tokensSpent predates the flush.
        const events = result.events;
        const failedIdx = events.indexOf("run.failed");
        assert.notEqual(failedIdx, -1, `iteration ${i}: run.failed must be present`);
        assert.equal(result.failedTokensSpent, 0, `iteration ${i}: run.failed must precede the flush (tokensSpent 0 at emit time)`);

        // The late flush is explicitly identified and readable AFTER the
        // terminal event in the same stream.
        const tokenEvents = result.tokenEvents;
        assert.equal(tokenEvents.length, 1, `iteration ${i}: exactly one run.tokens.updated must be present`);
        assert.equal(tokenEvents[0]?.tokenDelta, 137, `iteration ${i}: the late flush must carry the delta`);
        assert.equal(tokenEvents[0]?.postTerminal, true, `iteration ${i}: a flush on a terminal run must carry postTerminal: true`);
        assert.equal(tokenEvents[0]?.terminalStatus, "failed", `iteration ${i}: terminalStatus must name the terminal DB status`);

        const tokenIdx = events.indexOf("run.tokens.updated");
        assert.ok(tokenIdx > failedIdx, `iteration ${i}: the post-terminal flush must appear AFTER the terminal event`);
      } finally {
        fs.rmSync(temp.root, { recursive: true, force: true });
      }
    }
  });
});
