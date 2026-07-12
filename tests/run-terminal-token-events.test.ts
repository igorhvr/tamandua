import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = tamanduaTempDir("tamandua-run-terminal-token-events-");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("run terminal lifecycle token events", () => {
  it("emits run.completed with final tokensSpent", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();

    try {
      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { getDb } from "./dist/db.js";
          import { advancePipeline } from "./dist/installer/step-ops.js";

          const db = getDb();
          const runId = ${JSON.stringify(runId)};
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 41, ?, ?)"
          ).run(runId, now, now);

          const outcome = advancePipeline(runId);

          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
          const events = fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const terminalEvent = events.find((evt) => evt.event === "run.completed");

          console.log(JSON.stringify({
            runCompleted: outcome.runCompleted,
            tokensSpent: terminalEvent?.tokensSpent ?? null,
          }));
        `,
        {
          HOME: temp.homeDir,
        },
      );

      assert.equal(result.runCompleted, true);
      assert.equal(result.tokensSpent, 41);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("emits run.failed with final tokensSpent on exhausted failStep", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { getDb } from "./dist/db.js";
          import { failStep } from "./dist/installer/step-ops.js";

          const db = getDb();
          const runId = ${JSON.stringify(runId)};
          const stepId = ${JSON.stringify(stepId)};
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 91, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, '', '', 'running', 2, 1, 'single', ?, ?)"
          ).run(stepId, runId, now, now);

          const failResult = await failStep(stepId, 'boom');

          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
          const events = fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const terminalEvent = events.find((evt) => evt.event === "run.failed");

          console.log(JSON.stringify({
            failStatus: failResult.status,
            tokensSpent: terminalEvent?.tokensSpent ?? null,
          }));
        `,
        {
          HOME: temp.homeDir,
        },
      );

      assert.equal(result.failStatus, "failed");
      assert.equal(result.tokensSpent, 91);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
