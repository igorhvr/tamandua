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


/** Fake pi emitting a message_end with usage but configurable tool events. */
function createFakePi(rootDir: string, opts: { toolEventText?: string; totalTokens: number }): string {
  const binPath = path.join(rootDir, "fake-pi");
  const lines: string[] = ["#!/usr/bin/env bash", "cat << 'JSON'"];
  if (opts.toolEventText !== undefined) {
    lines.push(
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "bash",
        result: { content: [{ type: "text", text: opts.toolEventText }] },
        isError: false,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "STATUS: done\nCHANGES: did the thing" }],
        api: "fake",
        provider: "fake",
        model: "fake-pi",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: opts.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1777829458436,
        responseId: crypto.randomUUID(),
      },
    }),
    "JSON",
    "",
  );
  fs.writeFileSync(binPath, lines.join("\n"), "utf-8");
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

    const run = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
    const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get();
    const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
    const events = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const tokenEvent = events.find((e) => e.event === "run.tokens.updated");
    console.log(JSON.stringify({
      tokensSpent: run.tokens_spent,
      systemTokensSpent: stats?.system_tokens_spent ?? 0,
      tokenEventDelta: tokenEvent?.tokenDelta ?? null,
    }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv({ HOME: homeDir, TAMANDUA_PI_BINARY: fakePi }),
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
});
