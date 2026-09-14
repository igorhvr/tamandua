/**
 * Work-round token attribution (MOTOR-CONTRACT.md C14).
 *
 * The dispatch motor always knows which run it spawned work for, so token
 * usage from the pi stream lands on that run even when the stream carries
 * no resolvable run/step ids — the old motor dumped unresolvable usage on
 * the system-token counter; the new one falls back to job.runId. Nothing
 * in the dispatch path ever increments system_tokens_spent.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();


interface FakePiOptions {
  /** Text of an optional tool_execution event (emitted before message_end). */
  toolEventText?: string;
  /** Total policy tokens carried by the message_end usage object. */
  totalTokens: number;
  /**
   * Emit an EMPTY assistant content array while keeping the usage object —
   * the PRAW run-49 shape: a JSON round with usage but no assistant text.
   */
  omitAssistantText?: boolean;
  /** Override the assistant text. Defaults to a line-start STATUS: done report. */
  assistantText?: string;
  /**
   * Claim the pending step for this round's worker job id (status ->
   * 'running', claim_job_id -> TAMANDUA_WORKER_JOB_ID) before emitting output.
   * Mirrors an agent that claimed via the CLI mid-round; without it the
   * scheduler's output-derived auto-completion has no claimed step to touch.
   */
  claimStep?: boolean;
}

/** Fake pi emitting a message_end with usage but configurable tool events. */
function createFakePi(rootDir: string, opts: FakePiOptions): string {
  const assistantContent = opts.omitAssistantText === true
    ? []
    : [{ type: "text", text: opts.assistantText ?? "STATUS: done\nCHANGES: did the thing" }];

  // Config is embedded as a JSON literal so arbitrary tool text escapes safely.
  const cfg = JSON.stringify({
    toolEventText: opts.toolEventText ?? null,
    totalTokens: opts.totalTokens,
    assistantContent,
    claimStep: opts.claimStep === true,
  });

  const script = `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
const cfg = ${cfg};
if (cfg.claimStep) {
  const db = new DatabaseSync(process.env.TAMANDUA_DB_PATH);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE steps SET status = 'running', claim_job_id = ? WHERE status = 'pending'").run(process.env.TAMANDUA_WORKER_JOB_ID);
  db.close();
}
if (cfg.toolEventText !== null) {
  console.log(JSON.stringify({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: cfg.toolEventText }] },
    isError: false,
  }));
}
console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: cfg.assistantContent,
    api: "fake",
    provider: "fake",
    model: "fake-pi",
    usage: {
      // Components chosen so the shared policy (input + output +
      // cache_write, cache_read excluded) equals opts.totalTokens.
      input: Math.max(0, cfg.totalTokens - 4),
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: cfg.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1777829458436,
    responseId: "fake-pi",
  },
}));
`;

  const binPath = path.join(rootDir, "fake-pi");
  fs.writeFileSync(binPath, script, "utf-8");
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function runDispatchRound(homeDir: string, fakePi: string, runId: string, stepId: string) {
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
    import { getDb } from "./dist/db.js";

    const db = getDb();
    const runId = ${JSON.stringify(runId)};
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-attr', 'attribute me', 'running', '{}', 0, ?, ?)"
    ).run(runId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'work', 'wf-attr_dev', 0, 'work', '', 'pending', ?, ?)"
    ).run(${JSON.stringify(stepId)}, runId, now, now);

    const job = {
      id: "job-attr",
      workflowId: "wf-attr",
      agentId: "wf-attr_dev",
      runId,
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      createdAt: now,
    };
    await executeDispatchRound(job, { id: "dev", role: "coding", workspace: { baseDir: process.cwd(), files: {} } });

    const run = db.prepare("SELECT tokens_spent, status FROM runs WHERE id = ?").get(runId);
    const step = db.prepare("SELECT status, retry_count, claim_job_id FROM steps WHERE id = ?").get(${JSON.stringify(stepId)});
    const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get();
    const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
    const events = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const tokenEvent = events.find((e) => e.event === "run.tokens.updated");
    const count = (name) => events.filter((e) => e.event === name).length;

    // The dispatch round logs its classification ("Work round complete" with
    // an "outcome" field) to the isolated state-dir log.
    const logPath = path.join(process.env.TAMANDUA_STATE_DIR ?? path.join(process.env.HOME, ".tamandua"), "tamandua.log");
    const workOutcomes = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf-8").split(/\\r?\\n/)
          .filter((l) => l.includes("Work round complete"))
          .map((l) => { const i = l.indexOf("{"); return i >= 0 ? JSON.parse(l.slice(i)).outcome : null; })
      : [];

    fs.writeSync(1, JSON.stringify({
      tokensSpent: run.tokens_spent,
      runStatus: run.status,
      systemTokensSpent: stats?.system_tokens_spent ?? 0,
      tokenEventDelta: tokenEvent?.tokenDelta ?? null,
      tokenEventStepId: tokenEvent?.stepId ?? null,
      tokenEventRoundId: tokenEvent?.roundId ?? null,
      stepStatus: step?.status ?? null,
      stepRetryCount: step?.retry_count ?? null,
      stepClaimJobId: step?.claim_job_id ?? null,
      doneEvents: count("step.done"),
      autoCompletedEvents: count("step.auto_completed"),
      workerLostEvents: count("step.worker_lost"),
      respawnedEvents: count("step.respawned"),
      workOutcomes,
    }) + "\\n");
    // Synchronous write above; exit explicitly so fire-and-forget teardown
    // timers scheduled by a run-completing round cannot keep this script alive.
    process.exit(0);
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_PI_BINARY: fakePi,
      // The canned fake pi never answers a launch-time harness probe
      // prompt — disable the probe so work-token attribution is the
      // behavior under test.
      TAMANDUA_HARNESS_PROBE: "0",
    }),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`script failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as Record<string, unknown>;
}

describe("work-round token attribution (C14)", () => {
  it("attributes usage via run/step ids from tool events", () => {
    const temp = createTempHome("tamandua-work-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    try {
      const fakePi = createFakePi(temp.root, {
        toolEventText: JSON.stringify({ stepId, runId }),
        totalTokens: 1234,
      });
      const result = runDispatchRound(temp.homeDir, fakePi, runId, stepId);
      assert.equal(result.tokensSpent, 1234);
      assert.equal(result.tokenEventDelta, 1234);
      assert.equal(result.systemTokensSpent, 0);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("falls back to the dispatch job's runId when the stream has no ids", () => {
    const temp = createTempHome("tamandua-work-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    try {
      // No tool event at all: the old motor would have dumped this usage on
      // the system counter; the dispatch motor knows the run it spawned for.
      const fakePi = createFakePi(temp.root, { totalTokens: 777 });
      const result = runDispatchRound(temp.homeDir, fakePi, runId, stepId);
      assert.equal(
        result.tokensSpent,
        777,
        "usage without stream ids must fall back to job.runId, not the system ledger",
      );
      assert.equal(result.systemTokensSpent, 0, "the system-token ledger must stay untouched");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("keeps attribution and identifier hints for a no-text run-49 round and never auto-completes", () => {
    const temp = createTempHome("tamandua-work-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    try {
      // Run-49 shape: the worker claims the step, then produces a message_end
      // with a usage object but NO assistant text, plus a tool result that
      // echoes the task instructions (including the literal "STATUS: done").
      // The tool payload must never be mistaken for the agent's own report.
      const fakePi = createFakePi(temp.root, {
        omitAssistantText: true,
        claimStep: true,
        toolEventText: JSON.stringify({
          stepId,
          runId,
          instructions: "Complete the task and reply with:\nSTATUS: done",
        }),
        totalTokens: 1234,
      });
      const result = runDispatchRound(temp.homeDir, fakePi, runId, stepId);

      // AC1 / requirement 5g: usage is still attributed under the shared
      // policy and the identifier hints still resolve from the tool payload.
      assert.equal(result.tokensSpent, 1234, "a no-text round must still attribute its usage");
      assert.equal(result.tokenEventDelta, 1234);
      assert.equal(result.systemTokensSpent, 0);
      assert.equal(
        result.tokenEventStepId,
        stepId,
        "identifier hints must still resolve from the tool_execution payload",
      );
      assert.equal(result.tokenEventRoundId, "job-attr");

      // Requirement 5a: a JSON round with no assistant text is empty_output —
      // there is no raw-transcript fallback.
      assert.ok(
        (result.workOutcomes as string[]).includes("empty_output"),
        `no-text round must classify as empty_output, got ${JSON.stringify(result.workOutcomes)}`,
      );

      // AC3: never auto-completed. The empty_output branch runs the
      // pre-existing orphan-recovery path, which may reset the claimed step to
      // pending, so assert "not done" rather than "still running".
      assert.notEqual(result.stepStatus, "done", "the run-49 round must never complete the step");
      assert.equal(result.doneEvents, 0, "no step.done event may be emitted");
      assert.equal(result.autoCompletedEvents, 0, "no step.auto_completed event may be emitted");
      assert.ok(
        Number(result.workerLostEvents) >= 1,
        "empty_output must flow through orphan recovery (step.worker_lost), not completion",
      );
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("auto-completes a claimed step when the assistant text carries a line-start STATUS: done", () => {
    const temp = createTempHome("tamandua-work-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    try {
      // Control case (requirement 5b): the SAME dispatch path with a genuine
      // assistant report still classifies work_done and auto-completes.
      const fakePi = createFakePi(temp.root, {
        claimStep: true,
        assistantText: "STATUS: done\nCHANGES: did the thing",
        toolEventText: JSON.stringify({ stepId, runId }),
        totalTokens: 777,
      });
      const result = runDispatchRound(temp.homeDir, fakePi, runId, stepId);

      assert.ok(
        (result.workOutcomes as string[]).includes("work_done"),
        `line-start STATUS: done must classify work_done, got ${JSON.stringify(result.workOutcomes)}`,
      );
      assert.equal(result.stepStatus, "done", "a work_done round auto-completes the claimed step");
      assert.ok(Number(result.doneEvents) >= 1, "auto-completion emits step.done");
      assert.equal(
        result.autoCompletedEvents,
        0,
        "the scheduler fallback emits step.done, not the conditional step.auto_completed",
      );
      assert.equal(result.runStatus, "completed", "the single-step run completes on advance");
      assert.equal(result.tokensSpent, 777);
      assert.equal(result.tokenEventDelta, 777);
      assert.equal(result.tokenEventStepId, stepId);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
