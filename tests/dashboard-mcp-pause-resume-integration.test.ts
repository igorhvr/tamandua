/**
 * US-011: Integration tests for dashboard API and MCP pause/resume
 *
 * Covers:
 *  - Dashboard API pause/resume for terminal runs (failed, canceled)
 *  - MCP pause/resume rejection for terminal runs (completed, failed, canceled)
 *  - Dashboard /api/runs shows paused runs with correct status
 *  - Kanban snapshot reflects paused status
 */
import fs from "node:fs";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

// We import from dist/ so typecheck is not required for test-run.
import { createDashboardServer } from "../dist/server/dashboard.js";
import { startTamanduaMcpServer, stopTamanduaMcpServer, type TamanduaMcpServer } from "../dist/server/mcp-server.js";

// ── Helpers ──────────────────────────────────────────────────────────


function runNodeScript(script: string, env: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });

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

// ── MCP protocol helpers (mirror mcp-server.test.ts) ──────────────────

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "tamandua-test-client",
        version: "0.0.0",
      },
    },
  };
}

function parseJsonRpcBody(text: string): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    const sseDataLine = trimmed
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));

    if (!sseDataLine) {
      throw new Error(`Unexpected response payload: ${trimmed}`);
    }

    return JSON.parse(sseDataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
}

async function postJsonRpc(
  port: number,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
  }

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = parseJsonRpcBody(text);

  return { status: response.status, headers: response.headers, body };
}

async function initializeSession(port: number): Promise<string> {
  const initialize = await postJsonRpc(port, initializeRequest(1));
  assert.equal(initialize.status, 200);
  assert.ok(initialize.body?.result, "initialize should return a result");
  assert.equal(initialize.body?.error, undefined);

  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize response should include mcp-session-id");

  const initialized = await postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    sessionId ?? undefined,
  );

  assert.ok(
    [200, 202, 204].includes(initialized.status),
    `unexpected initialized status ${initialized.status}`,
  );

  return sessionId as string;
}

async function callTool(
  port: number,
  sessionId: string,
  id: number,
  toolName: string,
  toolArguments?: unknown,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const params: Record<string, unknown> = { name: toolName };
  if (toolArguments !== undefined) {
    params.arguments = toolArguments;
  }

  return postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params,
    },
    sessionId,
  );
}

// ── Dashboard Server Helpers ─────────────────────────────────────────

async function startDashboardOnPort(
  port: number,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = createDashboardServer(port);
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

// ══════════════════════════════════════════════════════════════════════
// Dashboard API integration tests — terminal run rejection & runs listing
// ══════════════════════════════════════════════════════════════════════

describe("dashboard API terminal run rejection", () => {
  it("rejects pause for failed runs with 409", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const db = getDb();
          db.prepare("DELETE FROM runs").run();

          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-failed", "wf-a", "failed task", "failed", now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs/run-failed/pause", { method: "POST" });
            const body = await res.json();
            console.log(JSON.stringify({
              status: res.status,
              error: body.error ?? null,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 409);
    assert.match(result.error as string, /Cannot pause run in failed state/);
  });

  it("rejects pause for canceled runs with 409", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const db = getDb();
          db.prepare("DELETE FROM runs").run();

          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-canceled", "wf-a", "canceled task", "canceled", now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs/run-canceled/pause", { method: "POST" });
            const body = await res.json();
            console.log(JSON.stringify({
              status: res.status,
              error: body.error ?? null,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 409);
    assert.match(result.error as string, /Cannot pause run in canceled state/);
  });

  it("rejects resume for failed runs with 409", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const db = getDb();
          db.prepare("DELETE FROM runs").run();

          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-failed", "wf-a", "failed task", "failed", now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs/run-failed/resume", { method: "POST" });
            const body = await res.json();
            console.log(JSON.stringify({
              status: res.status,
              error: body.error ?? null,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 409);
    assert.match(result.error as string, /Cannot resume run in failed state/);
  });

  it("rejects resume for canceled runs with 409", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const db = getDb();
          db.prepare("DELETE FROM runs").run();

          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-canceled", "wf-a", "canceled task", "canceled", now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs/run-canceled/resume", { method: "POST" });
            const body = await res.json();
            console.log(JSON.stringify({
              status: res.status,
              error: body.error ?? null,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 409);
    assert.match(result.error as string, /Cannot resume run in canceled state/);
  });
});

describe("dashboard /api/runs includes paused runs with correct status", () => {
  it("lists paused runs alongside running and completed runs", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const db = getDb();
          db.prepare("DELETE FROM steps").run();
          db.prepare("DELETE FROM runs").run();

          const now = new Date().toISOString();
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-paused", "wf-a", "paused task", "paused", now, now);
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-running", "wf-b", "running task", "running", now, now);
          db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)")
            .run("run-completed", "wf-c", "completed task", "completed", now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs");
            const body = await res.json();
            const runs = body.runs || [];
            const pausedRun = runs.find(r => r.id === "run-paused");
            const runningRun = runs.find(r => r.id === "run-running");
            const completedRun = runs.find(r => r.id === "run-completed");

            console.log(JSON.stringify({
              status: res.status,
              runCount: runs.length,
              pausedStatus: pausedRun?.status ?? null,
              runningStatus: runningRun?.status ?? null,
              completedStatus: completedRun?.status ?? null,
              hasPausedRun: !!pausedRun,
              hasRunningRun: !!runningRun,
              hasCompletedRun: !!completedRun,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 200);
    assert.equal(result.runCount, 3);
    assert.equal(result.pausedStatus, "paused");
    assert.equal(result.runningStatus, "running");
    assert.equal(result.completedStatus, "completed");
    assert.equal(result.hasPausedRun, true);
    assert.equal(result.hasRunningRun, true);
    assert.equal(result.hasCompletedRun, true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Kanban snapshot reflects paused status
// ══════════════════════════════════════════════════════════════════════

describe("kanban snapshot paused status", () => {
  it("reflects paused run status in the kanban API snapshot", () => {
    const temp = createTempHome("tamandua-dashboard-mcp-pause-resume-");
    const result = runNodeScript(
        `
          import { createDashboardServer } from "./dist/server/dashboard.js";
          import { getDb } from "./dist/db.js";
          import { once } from "node:events";

          const runId = "run-kanban-paused";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 42, 'feature-dev-merge', 'paused kanban test', 'paused', '{}', 777, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, '', '', 'done', 'single', NULL, ?, ?)"
          ).run("step_kp_planner", runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'implement', 'feature-dev-merge_developer', 1, '', '', 'done', 'loop', NULL, ?, ?)"
          ).run("step_kp_dev", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const res = await fetch(baseUrl + "/api/runs/" + runId + "/kanban");
            const body = await res.json();

            console.log(JSON.stringify({
              status: res.status,
              runStatus: body.run?.status ?? null,
              runId: body.run?.id ?? null,
              runNumber: body.run?.run_number ?? null,
              tokensSpent: body.run?.tokens_spent ?? null,
              laneCount: (body.lanes || []).length,
              laneAgents: (body.lanes || []).map(l => l.agent),
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

    assert.equal(result.status, 200);
    assert.equal(result.runStatus, "paused");
    assert.equal(result.runId, "run-kanban-paused");
    assert.equal(result.runNumber, 42);
    assert.equal(result.tokensSpent, 777);
    assert.equal(result.laneCount, 2);
    assert.deepEqual(result.laneAgents, ["planner", "developer"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// MCP pause/resume integration tests — terminal run rejection
// ══════════════════════════════════════════════════════════════════════

describe("MCP pause/resume terminal run rejection", () => {
  async function startMcpWithMock(opts: {
    pauseRejection?: string;
    resumeRejection?: string;
  }): Promise<{ server: TamanduaMcpServer; port: number; sessionId: string }> {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({}) as any,
        runWorkflow: async () => ({
          runId: "x", runNumber: 1, workflowId: "x",
          taskTitle: "x", status: "running", stepCount: 0,
          workingDirectoryForHarness: "/x",
        }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => {
          if (opts.pauseRejection) throw new Error(opts.pauseRejection);
          return { runId: "x", status: "paused" };
        },
        resumeRun: async () => {
          if (opts.resumeRejection) throw new Error(opts.resumeRejection);
          return { runId: "x", status: "running" };
        },
      },
    });

    const sessionId = await initializeSession(server.port);
    return { server, port: server.port, sessionId };
  }

  it("rejects pause for completed runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      pauseRejection: "Run is terminal: completed",
    });

    try {
      const result = await callTool(port, sessionId, 10, "tamandua.run.pause", { runId: "run-a" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("rejects pause for failed runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      pauseRejection: "Run is terminal: failed",
    });

    try {
      const result = await callTool(port, sessionId, 11, "tamandua.run.pause", { runId: "run-b" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("rejects pause for canceled runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      pauseRejection: "Run is terminal: canceled",
    });

    try {
      const result = await callTool(port, sessionId, 12, "tamandua.run.pause", { runId: "run-c" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("rejects resume for completed runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      resumeRejection: "Cannot resume terminal run: completed",
    });

    try {
      const result = await callTool(port, sessionId, 13, "tamandua.run.resume", { runId: "run-d" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("rejects resume for failed runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      resumeRejection: "Cannot resume terminal run: failed",
    });

    try {
      const result = await callTool(port, sessionId, 14, "tamandua.run.resume", { runId: "run-e" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("rejects resume for canceled runs via MCP", async () => {
    const { server, port, sessionId } = await startMcpWithMock({
      resumeRejection: "Cannot resume terminal run: canceled",
    });

    try {
      const result = await callTool(port, sessionId, 15, "tamandua.run.resume", { runId: "run-f" });
    assert.equal(result.status, 200);
    assert.equal(result.body?.result, undefined);
    assert.equal(result.body?.error?.code, -32602);
    assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });
});
