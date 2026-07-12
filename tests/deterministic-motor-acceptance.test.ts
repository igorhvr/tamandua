/**
 * Deterministic-motor acceptance (N1–N3 in tests/MOTOR-CONTRACT.md).
 *
 * The motor is deterministic dispatch: executeDispatchRound peeks for work
 * with an in-process SQL COUNT and spawns a harness ONLY when a pending
 * step exists. These tests drive real dispatch rounds against an isolated
 * DB with an instrumented fake pi (a shell script that journals every
 * invocation), proving:
 *
 *   N1 — idle dispatch invokes no model and spends zero system tokens
 *   N2 — harness invocations == executed work rounds (no model-driven peeks)
 *   N3 — work-token attribution still holds (C14): runs.tokens_spent rises
 *        from message_end usage and run.tokens.updated events fire
 *
 * The scripted e2e tier (e2e-tests/workflows-scripted.test.ts) asserts the
 * same criteria through the full daemon → scheduler → pipeline path.
 */

import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { cleanChildEnv } from "./helpers/test-env.ts";

const repoRoot = process.cwd();

function createTempHome() {
  const root = tamanduaTempDir("tamandua-motor-acceptance-");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

/**
 * Fake pi executable that appends one line per invocation to a journal
 * file, then emits a pi-shaped tool_execution_end (run/step ids for
 * attribution) + message_end (usage.totalTokens = 4242) and exits 0.
 */
function createJournalingFakePi(rootDir: string, runId: string, stepId: string): {
  binPath: string;
  journalPath: string;
} {
  const binPath = path.join(rootDir, "fake-pi");
  const journalPath = path.join(rootDir, "invocations.log");

  const toolEvent = JSON.stringify({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: JSON.stringify({ stepId, runId }) }] },
    isError: false,
  });
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "STATUS: done\nCHANGES: fixed stuff\nTESTS: tested" }],
      api: "fake",
      provider: "fake",
      model: "fake-pi",
      usage: {
        input: 121,
        output: 25,
        cacheRead: 4096,
        cacheWrite: 0,
        totalTokens: 4242,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1777829458436,
      responseId: crypto.randomUUID(),
    },
  });

  const script = [
    "#!/usr/bin/env bash",
    // One journal line per invocation (the prompt argument is multi-line —
    // never echo it into a line-counted journal).
    `echo "invoked" >> "${journalPath}"`,
    "cat << 'JSON'",
    toolEvent,
    messageEnd,
    "JSON",
    "",
  ].join("\n");

  fs.writeFileSync(binPath, script, "utf-8");
  fs.chmodSync(binPath, 0o755);
  return { binPath, journalPath };
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [`Script failed with exit ${result.status}`, `STDOUT:\n${result.stdout}`, `STDERR:\n${result.stderr}`].join("\n\n"),
    );
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }
  return JSON.parse(lastLine) as Record<string, unknown>;
}

/**
 * In-process dispatch harness: seeds a run (+ optional pending step),
 * executes `rounds` dispatch rounds sequentially, and reports the fake-pi
 * invocation count, token totals, events, and matching daemon-log lines.
 */
function runDispatchRounds(opts: {
  homeDir: string;
  fakePiPath: string;
  runId: string;
  stepId: string;
  stepStatus: "pending" | "done";
  rounds: number;
  journalPath: string;
}) {
  return runNodeScript(
    `
      import fs from "node:fs";
      import path from "node:path";
      import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
      import { getDb } from "./dist/db.js";

      const db = getDb();
      const runId = ${JSON.stringify(opts.runId)};
      const stepId = ${JSON.stringify(opts.stepId)};
      const now = new Date().toISOString();

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-acceptance', 'Prove the motor', 'running', '{}', 0, ?, ?)"
      ).run(runId, now, now);
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'the-step', 'wf-acceptance_dev', 0, 'do the thing', '', ?, ?, ?)"
      ).run(stepId, runId, ${JSON.stringify(opts.stepStatus)}, now, now);

      const job = {
        id: "job-motor-acceptance",
        workflowId: "wf-acceptance",
        agentId: "wf-acceptance_dev",
        runId,
        timeoutSeconds: 30,
        workingDirectoryForHarness: process.cwd(),
        createdAt: now,
      };
      const agent = { id: "dev", role: "coding", workspace: { baseDir: process.cwd(), files: {} } };

      for (let i = 0; i < ${opts.rounds}; i++) {
        await executeDispatchRound(job, agent);
        // After the first work round the step may have been consumed by the
        // fake pi's canned output — leave state as-is; later rounds peek.
      }

      const run = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
      const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get();

      const journalPath = ${JSON.stringify(opts.journalPath)};
      const invocations = fs.existsSync(journalPath)
        ? fs.readFileSync(journalPath, "utf-8").split(/\\r?\\n/).filter(Boolean).length
        : 0;

      const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
      const events = fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l))
        : [];
      const tokenEvents = events.filter((e) => e.event === "run.tokens.updated");

      const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

      console.log(JSON.stringify({
        invocations,
        tokensSpent: run.tokens_spent,
        systemTokensSpent: stats?.system_tokens_spent ?? 0,
        tokenEventCount: tokenEvents.length,
        tokenEventDelta: tokenEvents[0]?.tokenDelta ?? null,
        idleLogLines: (log.match(/Dispatch round idle/g) ?? []).length,
        workCompleteLogLines: (log.match(/Work round complete/g) ?? []).length,
      }));
    `,
    {
      HOME: opts.homeDir,
      TAMANDUA_PI_BINARY: opts.fakePiPath,
      // The N1 assertion counts "Dispatch round idle" lines as its probe
      // that each idle round ran; those lines are debug-level and dropped
      // unless TAMANDUA_DEBUG is set.
      TAMANDUA_DEBUG: "1",
    },
  );
}

describe("deterministic motor acceptance (MOTOR-CONTRACT.md N1–N3)", () => {
  it("N1: idle dispatch rounds invoke no model and spend zero system tokens", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const fakePi = createJournalingFakePi(temp.root, runId, stepId);

      // The run's only step is already done — every round peeks NO_WORK.
      const result = runDispatchRounds({
        homeDir: temp.homeDir,
        fakePiPath: fakePi.binPath,
        runId,
        stepId,
        stepStatus: "done",
        rounds: 5,
        journalPath: fakePi.journalPath,
      });

      assert.equal(result.invocations, 0, "idle rounds must NEVER spawn the harness binary");
      assert.equal(result.systemTokensSpent, 0, "idle dispatch must spend zero system tokens");
      assert.equal(result.tokensSpent, 0, "idle dispatch must not attribute run tokens");
      assert.equal(result.idleLogLines, 5, "each idle round should log 'Dispatch round idle'");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("N2: harness invocations equal executed work rounds — no model-driven peeks", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const fakePi = createJournalingFakePi(temp.root, runId, stepId);

      // One pending step, five dispatch rounds. Round 1 spawns the harness
      // (work round); the fake pi does not claim, so autoCompleteStepIfRunning
      // skips a non-running step and the sweep/peek see the step still
      // pending — but the fake pi keeps "doing" the work each round it is
      // spawned. The invariant under test: EVERY invocation corresponds to a
      // round where the peek said HAS_WORK. Mark the step done after the
      // first round via the second script run below.
      const first = runDispatchRounds({
        homeDir: temp.homeDir,
        fakePiPath: fakePi.binPath,
        runId,
        stepId,
        stepStatus: "pending",
        rounds: 1,
        journalPath: fakePi.journalPath,
      });
      assert.equal(first.invocations, 1, "one pending step + one round = exactly one harness spawn");
      assert.equal(first.workCompleteLogLines, 1, "the work round should log 'Work round complete'");

      // Second isolated environment: the step is done — repeated rounds must
      // add zero further invocations regardless of how many ticks fire.
      const temp2 = createTempHome();
      const runId2 = crypto.randomUUID();
      const stepId2 = crypto.randomUUID();
      try {
        const fakePi2 = createJournalingFakePi(temp2.root, runId2, stepId2);
        const second = runDispatchRounds({
          homeDir: temp2.homeDir,
          fakePiPath: fakePi2.binPath,
          runId: runId2,
          stepId: stepId2,
          stepStatus: "done",
          rounds: 4,
          journalPath: fakePi2.journalPath,
        });
        assert.equal(second.invocations, 0, "rounds without pending work must not spawn");
      } finally {
        fs.rmSync(temp2.root, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("N3: work-token attribution holds — tokens_spent rises and run.tokens.updated fires", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const fakePi = createJournalingFakePi(temp.root, runId, stepId);

      const result = runDispatchRounds({
        homeDir: temp.homeDir,
        fakePiPath: fakePi.binPath,
        runId,
        stepId,
        stepStatus: "pending",
        rounds: 1,
        journalPath: fakePi.journalPath,
      });

      assert.equal(result.tokensSpent, 4242, `work usage should land on runs.tokens_spent, got ${result.tokensSpent}`);
      assert.equal(result.tokenEventCount, 1, "one run.tokens.updated event should fire");
      assert.equal(result.tokenEventDelta, 4242, "the event should carry the usage delta");
      assert.equal(result.systemTokensSpent, 0, "work rounds never touch the system-token ledger");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
