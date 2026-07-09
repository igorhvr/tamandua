import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-system-token-counter-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function createFakePi(root: string, stdoutPayload: string): string {
  const fakePi = path.join(root, "pi");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdoutPayload)});\n`,
    "utf-8",
  );
  fs.chmodSync(fakePi, 0o755);
  return fakePi;
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

describe("system token spend counter — e2e integration", () => {

  // ── Test 1: incrementSystemTokenSpend accuracy ──

  it("incrementSystemTokenSpend updates atomically and accumulatively", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { getSystemTokenSpend, incrementSystemTokenSpend } from "./dist/db.js";

          const initial = getSystemTokenSpend();
          if (initial !== 0) throw new Error("Expected initial system_tokens_spent to be 0");

          const v1 = incrementSystemTokenSpend(100);
          const v2 = incrementSystemTokenSpend(250);
          const v3 = incrementSystemTokenSpend(3);
          const final = getSystemTokenSpend();

          console.log(JSON.stringify({ initial, v1, v2, v3, final }));
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.initial, 0, "fresh DB should start at 0");
      assert.equal(result.v1, 100, "first increment should return 100");
      assert.equal(result.v2, 350, "second increment should return 350 (100+250)");
      assert.equal(result.v3, 353, "third increment should return 353");
      assert.equal(result.final, 353, "final read should match last increment");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  // ── Test 2: Dispatch round with unresolvable run/step IDs falls back to job.runId ──

  it("unresolvable tokens fall back to job.runId, system tokens_spent unchanged", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();

    try {
      // Polling round output with unresolvable run/step IDs
      const piOutput = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done\nCHANGES: n/a\nTESTS: n/a" }],
          usage: { totalTokens: 77 },
          stopReason: "stop",
        },
      });

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = ${JSON.stringify(runId)};
          const now = new Date().toISOString();

          // Insert a run with known tokens_spent (must be incremented by fallback)
          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 41, ?, ?)"
          ).run(runId, now, now);

          // Insert a pending step so peekStep returns HAS_WORK
          const stepId = "${crypto.randomUUID()}";
          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, '', '', 'pending', ?, ?)"
          ).run(stepId, runId, now, now);

          const job = {
            id: "job-system-integration",
            runId,
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workingDirectoryForHarness: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executeDispatchRound(job, agent);

          const runRow = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();

          console.log(JSON.stringify({
            runTokensSpent: runRow.tokens_spent,
            systemTokensSpent: systemTokens,
          }));
        `,
        { HOME: temp.homeDir, TAMANDUA_PI_BINARY: fakePi },
      );

      // The new scheduler falls back to job.runId, so run tokens should be 41 + 77 = 118
      assert.equal(result.runTokensSpent, 118, "run tokens_spent must be 118 (41 + 77 fallback)");
      // System tokens must remain 0 — dispatch never touches system_tokens_spent
      assert.equal(result.systemTokensSpent, 0, "system_tokens_spent must remain 0 for dispatch rounds");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  // ── Test 3: Attributable tokens go to run, system tokens_spent unchanged ──

  it("attributable tokens go to run, system tokens_spent unchanged", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const piOutput = [
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "bash",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ stepId, runId, input: "Implement task" }),
              },
            ],
          },
          isError: false,
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "STATUS: done\nCHANGES: implemented\nTESTS: passed" }],
            usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
          },
        }),
      ].join("\n");

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = ${JSON.stringify(runId)};
          const stepId = ${JSON.stringify(stepId)};
          const now = new Date().toISOString();

          // Pre-seed system tokens to verify they do NOT change
          db.prepare("UPDATE tamandua_stats SET system_tokens_spent = 50 WHERE id = 1").run();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 5, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, '', '', 'pending', ?, ?)"
          ).run(stepId, runId, now, now);

          const job = {
            id: "job-run-attribution-e2e",
            runId,
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workingDirectoryForHarness: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executeDispatchRound(job, agent);

          const runRow = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();

          console.log(JSON.stringify({
            runTokensSpent: runRow.tokens_spent,
            systemTokensSpent: systemTokens,
          }));
        `,
        { HOME: temp.homeDir, TAMANDUA_PI_BINARY: fakePi },
      );

      // 150 (120 input + 30 output) added to existing 5
      assert.equal(result.runTokensSpent, 155, "run tokens_spent should be 155 (5 + 150)");
      // System tokens must remain at the pre-seeded 50
      assert.equal(result.systemTokensSpent, 50, "system_tokens_spent must not change for attributable run");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  // ── Test 4: Dashboard /api/stats returns correct system + total ──

  it("GET /api/stats returns correct systemTokensSpent and totalTokensSpent", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb, incrementSystemTokenSpend } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const db = getDb();
          const now = new Date().toISOString();

          // Insert 3 runs with various token counts
          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, 1, 'wf-a', 'task a', 'done', 200, ?, ?)"
          ).run("run-e2e-1", now, now);
          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, 2, 'wf-b', 'task b', 'done', 350, ?, ?)"
          ).run("run-e2e-2", now, now);
          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at) VALUES (?, 3, 'wf-c', 'task c', 'running', 75, ?, ?)"
          ).run("run-e2e-3", now, now);

          // Add system tokens (e.g. from medic)
          incrementSystemTokenSpend(125);

          const server = createDashboardServer(0);
          if (!server.listening) {
            await once(server, "listening");
          }

          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Unexpected server address");
          }

          const baseUrl = "http://127.0.0.1:" + address.port;

          try {
            const res = await fetch(baseUrl + "/api/stats");
            const body = await res.json();

            console.log(JSON.stringify({
              status: res.status,
              systemTokensSpent: body.systemTokensSpent,
              totalTokensSpent: body.totalTokensSpent,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.status, 200);
      assert.equal(result.systemTokensSpent, 125);
      // Total = sum(runs: 200+350+75=625) + system(125) = 750
      assert.equal(result.totalTokensSpent, 750, "totalTokensSpent should be sum of run tokens + system tokens");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
