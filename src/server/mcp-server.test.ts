import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MCP_PORT,
  createTamanduaMcpServer,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "../../dist/server/mcp-server.js";

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

describe("mcp-server bootstrap", () => {
  it("exports the fixed default MCP port", () => {
    assert.equal(DEFAULT_MCP_PORT, 3338);
  });

  it("supports initialize, tools/list, and tools/call over HTTP", async () => {
    const runListCalls: number[] = [];
    const runStatusCalls: string[] = [];
    const runStartCalls: Array<{ workflowId: string; taskTitle: string; workingDirectoryForHarness: string; noHurrySaveTokensMode?: boolean }> = [];
    const eventCalls: number[] = [];
    const sourcePathCalls: string[] = [];

    const expectedRuns = [
      {
        id: "run-abc",
        workflowId: "feature-dev",
        task: "Implement MCP tools",
        status: "running",
        createdAt: "2026-05-02T15:00:00.000Z",
        updatedAt: "2026-05-02T15:05:00.000Z",
        stepSummary: "running:1",
        tokensSpent: 0,
      },
    ];

    const expectedRunDetail = {
      ...expectedRuns[0],
      steps: [
        {
          stepId: "story",
          agentId: "feature-dev_developer",
          status: "running",
          type: "single",
          retryCount: 0,
        },
      ],
    };

    const expectedEvents = [
      {
        ts: "2026-05-02T15:05:01.000Z",
        event: "step.started",
        runId: "run-abc",
      },
    ];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: (limit = 50) => {
          runListCalls.push(limit);
          return expectedRuns;
        },
        getWorkflowStatus: (query) => {
          runStatusCalls.push(query);
          return expectedRunDetail;
        },
        runWorkflow: async ({ workflowId, taskTitle, workingDirectoryForHarness, noHurrySaveTokensMode }) => {
          runStartCalls.push({ workflowId, taskTitle, workingDirectoryForHarness: workingDirectoryForHarness ?? "", noHurrySaveTokensMode });
          return {
            runId: "run-new",
            runNumber: 9,
            workflowId,
            taskTitle,
            status: "running",
            stepCount: 1,
            workingDirectoryForHarness: workingDirectoryForHarness ?? "",
          };
        },
        getRecentEvents: (limit = 50) => {
          eventCalls.push(limit);
          return expectedEvents;
        },
        getSourcePath: () => {
          sourcePathCalls.push("called");
          return "/tmp/tamandua-source";
        },
        pauseRun: async (runId, _drain) => {
          return { runId, status: "paused" };
        },
        resumeRun: async (runId) => {
          return { runId, status: "running" };
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const toolsList = await postJsonRpc(
        server.port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );

      assert.equal(toolsList.status, 200);
      assert.equal(toolsList.body?.error, undefined);

      const tools = (toolsList.body?.result?.tools ?? []) as Array<Record<string, unknown>>;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [
          "tamandua.runs.list",
          "tamandua.run.status",
          "tamandua.run.start",
          "tamandua.events.recent",
          "tamandua.run.pause",
          "tamandua.run.resume",
          "tamandua.run.delete",
          "tamandua.skill.path",
          "tamandua.source.path",
          "tamandua.update.command",
          "tamandua.autoresearch.init",
          "tamandua.autoresearch.run_experiment",
          "tamandua.autoresearch.log_experiment",
          "tamandua.autoresearch.status",
        ],
      );
      assert.deepEqual((tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties?.limit, {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum number of runs to return (default 50).",
      });
      assert.deepEqual((tools[1]?.inputSchema as { required?: string[] }).required, ["query"]);
      assert.deepEqual((tools[2]?.inputSchema as { required?: string[] }).required, ["workflowId", "taskTitle"]);

      const runsList = await callTool(server.port, sessionId, 3, "tamandua.runs.list", { limit: 10 });
      assert.equal(runsList.status, 200);
      assert.equal(runsList.body?.error, undefined);
      assert.deepEqual(runsList.body?.result?.structuredContent, { runs: expectedRuns });
      assert.deepEqual(runListCalls, [10]);

      const runStatus = await callTool(server.port, sessionId, 4, "tamandua.run.status", { query: "run-ab" });
      assert.equal(runStatus.status, 200);
      assert.equal(runStatus.body?.error, undefined);
      assert.deepEqual(runStatus.body?.result?.structuredContent, { run: expectedRunDetail });
      assert.deepEqual(runStatusCalls, ["run-ab"]);

      const runStart = await callTool(server.port, sessionId, 5, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "Implement MCP start",
        workingDirectoryForHarness: "/tmp/remote-harness",
      });
      assert.equal(runStart.status, 200);
      assert.equal(runStart.body?.error, undefined);
      assert.deepEqual(runStart.body?.result?.structuredContent, {
        run: {
          runId: "run-new",
          runNumber: 9,
          workflowId: "feature-dev",
          taskTitle: "Implement MCP start",
          status: "running",
          stepCount: 1,
          workingDirectoryForHarness: "/tmp/remote-harness",
        },
      });
      assert.deepEqual(runStartCalls, [{
        workflowId: "feature-dev",
        taskTitle: "Implement MCP start",
        workingDirectoryForHarness: "/tmp/remote-harness",
        noHurrySaveTokensMode: undefined,
      }]);

      // Verify inputSchema properties include worktree fields and noHurrySaveTokensMode
      const runStartSchema = tools[2]?.inputSchema as { properties?: Record<string, unknown> };
      assert.ok(runStartSchema.properties?.worktreeOriginRepository, "should have worktreeOriginRepository property");
      assert.ok(runStartSchema.properties?.worktreeOriginRef, "should have worktreeOriginRef property");
      assert.deepEqual(runStartSchema.properties?.noHurrySaveTokensMode, {
        type: "boolean",
        description: "When true, work spawns prefer a <harness>-token-saver command from PATH over the plain harness binary (looked up per invocation; falls back to the harness binary when absent). Idle dispatch is free either way. Optional, defaults to false.",
      });

      const eventsRecent = await callTool(server.port, sessionId, 6, "tamandua.events.recent", { limit: 7 });
      assert.equal(eventsRecent.status, 200);
      assert.equal(eventsRecent.body?.error, undefined);
      assert.deepEqual(eventsRecent.body?.result?.structuredContent, { events: expectedEvents });
      assert.deepEqual(eventCalls, [7]);

      const sourcePath = await callTool(server.port, sessionId, 7, "tamandua.source.path", {});
      assert.equal(sourcePath.status, 200);
      assert.equal(sourcePath.body?.error, undefined);
      assert.deepEqual(sourcePath.body?.result?.structuredContent, { sourcePath: "/tmp/tamandua-source" });
      assert.deepEqual(sourcePathCalls, ["called"]);

      const updateCommand = await callTool(server.port, sessionId, 8, "tamandua.update.command", {});
      assert.equal(updateCommand.status, 200);
      assert.equal(updateCommand.body?.error, undefined);
      assert.match(updateCommand.body?.result?.structuredContent?.command, /tamandua update/);
      assert.match(updateCommand.body?.result?.structuredContent?.safety, /local CLI/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("returns MCP invalid-params errors for bad tool arguments without crashing the session", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => {
          throw new Error("should not be called for invalid args");
        },
        runWorkflow: async () => {
          throw new Error("should not be called for invalid args");
        },
        getRecentEvents: () => [],
        pauseRun: async () => {
          throw new Error("should not be called for invalid args");
        },
        resumeRun: async () => {
          throw new Error("should not be called for invalid args");
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const missingQuery = await callTool(server.port, sessionId, 10, "tamandua.run.status", {});
      assert.equal(missingQuery.status, 200);
      assert.equal(missingQuery.body?.result, undefined);
      assert.equal(missingQuery.body?.error?.code, -32602);
      assert.match(missingQuery.body?.error?.message ?? "", /query/);

      const badLimitType = await callTool(server.port, sessionId, 11, "tamandua.runs.list", { limit: "25" });
      assert.equal(badLimitType.status, 200);
      assert.equal(badLimitType.body?.result, undefined);
      assert.equal(badLimitType.body?.error?.code, -32602);
      assert.match(badLimitType.body?.error?.message ?? "", /limit/);

      const missingHarnessDir = await callTool(server.port, sessionId, 12, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "remote run",
      });
      assert.equal(missingHarnessDir.status, 200);
      assert.equal(missingHarnessDir.body?.result, undefined);
      assert.equal(missingHarnessDir.body?.error?.code, -32602);
      assert.match(missingHarnessDir.body?.error?.message ?? "", /workingDirectoryForHarness/);

      const validAfterErrors = await callTool(server.port, sessionId, 13, "tamandua.events.recent", { limit: 3 });
      assert.equal(validAfterErrors.status, 200);
      assert.equal(validAfterErrors.body?.error, undefined);
      assert.deepEqual(validAfterErrors.body?.result?.structuredContent, { events: [] });
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("supports tamandua.run.pause and tamandua.run.resume tools", async () => {
    const pauseCalls: Array<{ runId: string; drain: boolean }> = [];
    const resumeCalls: string[] = [];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async (runId, drain = false) => {
          pauseCalls.push({ runId, drain });
          return { runId, status: drain ? "draining_pause" : "paused" };
        },
        resumeRun: async (runId) => {
          resumeCalls.push(runId);
          return { runId, status: "running" };
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Test pause (immediate)
      const pauseResult = await callTool(server.port, sessionId, 20, "tamandua.run.pause", { runId: "run-abc" });
      assert.equal(pauseResult.status, 200);
      assert.equal(pauseResult.body?.error, undefined);
      assert.deepEqual(pauseResult.body?.result?.structuredContent, { runId: "run-abc", status: "paused" });
      assert.deepEqual(pauseCalls, [{ runId: "run-abc", drain: false }]);

      // Test pause with drain
      const pauseDrainResult = await callTool(server.port, sessionId, 21, "tamandua.run.pause", { runId: "run-def", drain: true });
      assert.equal(pauseDrainResult.status, 200);
      assert.equal(pauseDrainResult.body?.error, undefined);
      assert.deepEqual(pauseDrainResult.body?.result?.structuredContent, { runId: "run-def", status: "draining_pause" });
      assert.deepEqual(pauseCalls, [{ runId: "run-abc", drain: false }, { runId: "run-def", drain: true }]);

      // Test resume
      const resumeResult = await callTool(server.port, sessionId, 22, "tamandua.run.resume", { runId: "run-abc" });
      assert.equal(resumeResult.status, 200);
      assert.equal(resumeResult.body?.error, undefined);
      assert.deepEqual(resumeResult.body?.result?.structuredContent, { runId: "run-abc", status: "running" });
      assert.deepEqual(resumeCalls, ["run-abc"]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("supports tamandua.run.delete tool", async () => {
    const deleteCalls: Array<{ runId: string; force: boolean }> = [];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        deleteRun: async (runId, force = false) => {
          deleteCalls.push({ runId, force });
          return { ok: true, runId, status: "deleted" };
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const deleteResult = await callTool(server.port, sessionId, 23, "tamandua.run.delete", { runId: "run-abc", force: true });
      assert.equal(deleteResult.status, 200);
      assert.equal(deleteResult.body?.error, undefined);
      assert.deepEqual(deleteResult.body?.result?.structuredContent, { ok: true, runId: "run-abc", status: "deleted" });
      assert.deepEqual(deleteCalls, [{ runId: "run-abc", force: true }]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("pause run rejects terminal runs with MCP error", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => {
          throw new Error("Run is terminal: completed");
        },
        resumeRun: async () => {
          throw new Error("should not be called");
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 30, "tamandua.run.pause", { runId: "run-terminal" });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("pause and resume tools require runId argument", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => {
          throw new Error("should not be called");
        },
        resumeRun: async () => {
          throw new Error("should not be called");
        },
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const missingRunIdPause = await callTool(server.port, sessionId, 40, "tamandua.run.pause", {});
      assert.equal(missingRunIdPause.status, 200);
      assert.equal(missingRunIdPause.body?.result, undefined);
      assert.equal(missingRunIdPause.body?.error?.code, -32602);
      assert.match(missingRunIdPause.body?.error?.message ?? "", /runId/);

      const missingRunIdResume = await callTool(server.port, sessionId, 41, "tamandua.run.resume", {});
      assert.equal(missingRunIdResume.status, 200);
      assert.equal(missingRunIdResume.body?.result, undefined);
      assert.equal(missingRunIdResume.body?.error?.code, -32602);
      assert.match(missingRunIdResume.body?.error?.message ?? "", /runId/);

      const missingRunIdDelete = await callTool(server.port, sessionId, 42, "tamandua.run.delete", {});
      assert.equal(missingRunIdDelete.status, 200);
      assert.equal(missingRunIdDelete.body?.result, undefined);
      assert.equal(missingRunIdDelete.body?.error?.code, -32602);
      assert.match(missingRunIdDelete.body?.error?.message ?? "", /runId/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("factory creates start/stop capable server handles", async () => {
    const server: TamanduaMcpServer = createTamanduaMcpServer(0);
    await server.start();
    assert.equal(server.server.listening, true);

    await server.stop();
    assert.equal(server.server.listening, false);
  });

  it("MCP run-start rejects worktree args for direct workflows", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => {
          throw new Error("should not be called");
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Reject worktreeOriginRepository for direct workflow
      const result = await callTool(server.port, sessionId, 50, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "test",
        workingDirectoryForHarness: "/tmp/harness",
        worktreeOriginRepository: "/tmp/repo",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /worktreeOriginRepository.*only valid.*worktree/);

      // Reject worktreeOriginRef for direct workflow
      const result2 = await callTool(server.port, sessionId, 51, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "test",
        workingDirectoryForHarness: "/tmp/harness",
        worktreeOriginRef: "main",
      });
      assert.equal(result2.status, 200);
      assert.equal(result2.body?.result, undefined);
      assert.equal(result2.body?.error?.code, -32602);
      assert.match(result2.body?.error?.message ?? "", /worktreeOriginRef.*only valid.*worktree/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start requires worktreeOriginRepository for worktree workflows (no default)", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => {
          throw new Error("should not be called");
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "worktree",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 60, "tamandua.run.start", {
        workflowId: "feature-dev-merge-worktree",
        taskTitle: "worktree test",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /worktreeOriginRepository.*required.*worktree/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start rejects workingDirectoryForHarness for worktree workflows", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => {
          throw new Error("should not be called");
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "worktree",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 70, "tamandua.run.start", {
        workflowId: "feature-dev-merge-worktree",
        taskTitle: "worktree test",
        worktreeOriginRepository: "/tmp/repo",
        workingDirectoryForHarness: "/tmp/harness",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /workingDirectoryForHarness.*not valid.*worktree/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start dispatches worktree params to runWorkflow", async () => {
    const runStartCalls: Array<Record<string, unknown>> = [];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async (params) => {
          runStartCalls.push({ ...params });
          return {
            runId: "run-wt",
            runNumber: 10,
            workflowId: params.workflowId,
            taskTitle: params.taskTitle,
            status: "running",
            stepCount: 3,
            workingDirectoryForHarness: "/tmp/worktree/path",
          };
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "worktree",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 80, "tamandua.run.start", {
        workflowId: "feature-dev-merge-worktree",
        taskTitle: "worktree run",
        worktreeOriginRepository: "/tmp/origin-repo",
        worktreeOriginRef: "feature/my-branch",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.error, undefined);
      assert.deepEqual(result.body?.result?.structuredContent, {
        run: {
          runId: "run-wt",
          runNumber: 10,
          workflowId: "feature-dev-merge-worktree",
          taskTitle: "worktree run",
          status: "running",
          stepCount: 3,
          workingDirectoryForHarness: "/tmp/worktree/path",
        },
      });
      assert.deepEqual(runStartCalls, [{
        workflowId: "feature-dev-merge-worktree",
        taskTitle: "worktree run",
        workingDirectoryForHarness: undefined,
        worktreeOriginRepository: "/tmp/origin-repo",
        worktreeOriginRef: "feature/my-branch",
        noHurrySaveTokensMode: undefined,
      }]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start accepts and forwards noHurrySaveTokensMode argument", async () => {
    const runStartCalls: Array<{ noHurrySaveTokensMode?: boolean }> = [];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async (params) => {
          runStartCalls.push({ noHurrySaveTokensMode: params.noHurrySaveTokensMode });
          return {
            runId: "run-hurry",
            runNumber: 11,
            workflowId: params.workflowId,
            taskTitle: params.taskTitle,
            status: "running",
            stepCount: 2,
            workingDirectoryForHarness: params.workingDirectoryForHarness ?? "",
          };
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Test with noHurrySaveTokensMode: true
      const resultTrue = await callTool(server.port, sessionId, 95, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "save tokens run",
        workingDirectoryForHarness: "/tmp/harness",
        noHurrySaveTokensMode: true,
      });
      assert.equal(resultTrue.status, 200);
      assert.equal(resultTrue.body?.error, undefined);
      assert.deepEqual(runStartCalls, [{ noHurrySaveTokensMode: true }]);

      // Test with noHurrySaveTokensMode: false
      runStartCalls.length = 0;
      const resultFalse = await callTool(server.port, sessionId, 96, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "normal run",
        workingDirectoryForHarness: "/tmp/harness",
        noHurrySaveTokensMode: false,
      });
      assert.equal(resultFalse.status, 200);
      assert.equal(resultFalse.body?.error, undefined);
      assert.deepEqual(runStartCalls, [{ noHurrySaveTokensMode: false }]);

      // Test without noHurrySaveTokensMode (should pass undefined)
      runStartCalls.length = 0;
      const resultMissing = await callTool(server.port, sessionId, 97, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "default run",
        workingDirectoryForHarness: "/tmp/harness",
      });
      assert.equal(resultMissing.status, 200);
      assert.equal(resultMissing.body?.error, undefined);
      assert.deepEqual(runStartCalls, [{ noHurrySaveTokensMode: undefined }]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start requires workingDirectoryForHarness for direct workflows", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => {
          throw new Error("should not be called");
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "direct",
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 90, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "no harness dir",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /workingDirectoryForHarness.*required.*direct/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("MCP run-start handles invalid workflow id gracefully", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => {
          throw new Error("should not be called");
        },
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => {
          throw new Error("Unknown workflow: nonexistent-workflow");
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 100, "tamandua.run.start", {
        workflowId: "nonexistent-workflow",
        taskTitle: "test",
        workingDirectoryForHarness: "/tmp/harness",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /Unknown workflow/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("supports autoresearch init and status tools over HTTP", async () => {
    const initCalls: Array<{
      cwd: string;
      goal: string;
      metricName: string;
      direction: string;
      command: string;
    }> = [];
    const statusCalls: string[] = [];

    const mockSession: Record<string, unknown> = {
      type: "session",
      created_at: "2026-07-03T12:00:00.000Z",
      goal: "Optimize JSON parsing performance",
      metric_name: "req_per_sec",
      metric_unit: "req/s",
      direction: "higher",
      command: "npm run bench",
      metric_regex: "([0-9.]+) req/s",
      checks_command: "npm test",
    };

    const mockSummary: Record<string, unknown> = {
      exists: true,
      goal: "Optimize JSON parsing performance",
      metricName: "req_per_sec",
      metricUnit: "req/s",
      direction: "higher",
      command: "npm run bench",
      totalRuns: 5,
      measuredRuns: 5,
      keptRuns: 3,
      discardedRuns: 2,
      crashedRuns: 0,
      checksFailedRuns: 0,
      baselineMetric: 1000,
      bestMetric: 1250,
      bestRun: 3,
      confidence_score: 0.85,
      confidence_band: "high",
      noise_floor_mad: 12.5,
      confidence_sample_count: 5,
      nextPrompt: "Next: try X approach",
    };

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({
          runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x",
          status: "running", stepCount: 0, workingDirectoryForHarness: "/x",
        }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "direct",
        initAutoresearch: (opts) => {
          initCalls.push({
            cwd: opts.cwd ?? "",
            goal: opts.goal,
            metricName: opts.metricName,
            direction: opts.direction,
            command: opts.command,
          });
          return mockSession as any;
        },
        summarizeAutoresearch: (cwd: string) => {
          statusCalls.push(cwd);
          return mockSummary as any;
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Call tamandua.autoresearch.init
      const initResult = await callTool(server.port, sessionId, 110, "tamandua.autoresearch.init", {
        cwd: "/tmp/test-project",
        goal: "Optimize JSON parsing performance",
        metricName: "req_per_sec",
        metricUnit: "req/s",
        direction: "higher",
        command: "npm run bench",
        metricRegex: "([0-9.]+) req/s",
        checksCommand: "npm test",
      });
      assert.equal(initResult.status, 200);
      assert.equal(initResult.body?.error, undefined);
      const session = initResult.body?.result?.structuredContent?.session as Record<string, unknown> | undefined;
      assert.ok(session, "session should be present");
      assert.equal(session?.goal, "Optimize JSON parsing performance");
      assert.equal(session?.metric_name, "req_per_sec");
      assert.equal(session?.direction, "higher");
      assert.deepEqual(initCalls, [{
        cwd: "/tmp/test-project",
        goal: "Optimize JSON parsing performance",
        metricName: "req_per_sec",
        direction: "higher",
        command: "npm run bench",
      }]);

      // Call tamandua.autoresearch.status
      const statusResult = await callTool(server.port, sessionId, 111, "tamandua.autoresearch.status", {
        cwd: "/tmp/test-project",
      });
      assert.equal(statusResult.status, 200);
      assert.equal(statusResult.body?.error, undefined);
      const summary = statusResult.body?.result?.structuredContent?.summary as Record<string, unknown> | undefined;
      assert.ok(summary, "summary should be present");
      assert.equal(summary?.exists, true);
      assert.equal(summary?.totalRuns, 5);
      assert.equal(summary?.bestMetric, 1250);
      assert.equal(summary?.goal, "Optimize JSON parsing performance");
      assert.deepEqual(statusCalls, ["/tmp/test-project"]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("supports autoresearch run and log tools over HTTP", async () => {
    const runCalls: Array<{ cwd: string; command?: string }> = [];
    const logCalls: Array<{ cwd: string; description: string }> = [];

    const mockRunResult: Record<string, unknown> = {
      type: "run_result",
      run: 1,
      created_at: "2026-07-03T12:01:00.000Z",
      status: "measured",
      metric: 1050,
      metric_name: "req_per_sec",
      metric_unit: "req/s",
      direction: "higher",
      duration_ms: 1523,
      exit_code: 0,
      command: "npm run bench",
      output_tail: "1050 req/s",
      error_tail: "",
    };

    const mockLogEntry: Record<string, unknown> = {
      type: "run",
      run: 1,
      created_at: "2026-07-03T12:02:00.000Z",
      status: "keep",
      metric: 1050,
      metric_name: "req_per_sec",
      metric_unit: "req/s",
      direction: "higher",
      duration_ms: 1523,
      command: "npm run bench",
      description: "Added caching layer",
      baseline_metric: 1000,
      best_metric: 1050,
      improvement_ratio: 1.05,
      confidence_score: 0.5,
      confidence_band: "unknown",
      noise_floor_mad: null,
      confidence_sample_count: 1,
      asi: {
        hypothesis: "Caching reduces parse time",
        learned: "10% improvement observed",
        next_focus: "Try larger cache",
      },
    };

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({
          runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x",
          status: "running", stepCount: 0, workingDirectoryForHarness: "/x",
        }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => ({ runId: "x", status: "paused" }),
        resumeRun: async () => ({ runId: "x", status: "running" }),
        resolveWorkspaceMode: async () => "direct",
        runAutoresearchExperiment: async (opts) => {
          runCalls.push({ cwd: opts.cwd ?? "", command: opts.command });
          return mockRunResult as any;
        },
        logAutoresearchExperiment: async (opts) => {
          logCalls.push({ cwd: opts.cwd ?? "", description: opts.description });
          return mockLogEntry as any;
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Call tamandua.autoresearch.run_experiment
      const runResult = await callTool(server.port, sessionId, 120, "tamandua.autoresearch.run_experiment", {
        cwd: "/tmp/test-project",
        command: "npm run bench -- --iterations=10",
        timeoutMs: 30000,
      });
      assert.equal(runResult.status, 200);
      assert.equal(runResult.body?.error, undefined);
      const result = runResult.body?.result?.structuredContent?.result as Record<string, unknown> | undefined;
      assert.ok(result, "result should be present");
      assert.equal(result?.type, "run_result");
      assert.equal(result?.metric, 1050);
      assert.equal(result?.duration_ms, 1523);
      assert.equal(result?.command, "npm run bench");
      assert.deepEqual(runCalls, [{
        cwd: "/tmp/test-project",
        command: "npm run bench -- --iterations=10",
      }]);

      // Call tamandua.autoresearch.log_experiment
      const logResult = await callTool(server.port, sessionId, 121, "tamandua.autoresearch.log_experiment", {
        cwd: "/tmp/test-project",
        description: "Added caching layer",
        status: "keep",
        hypothesis: "Caching reduces parse time",
        learned: "10% improvement observed",
        nextFocus: "Try larger cache",
      });
      assert.equal(logResult.status, 200);
      assert.equal(logResult.body?.error, undefined);
      const entry = logResult.body?.result?.structuredContent?.entry as Record<string, unknown> | undefined;
      assert.ok(entry, "entry should be present");
      assert.equal(entry?.type, "run");
      assert.equal(entry?.status, "keep");
      assert.equal(entry?.description, "Added caching layer");
      assert.deepEqual(entry?.asi, {
        hypothesis: "Caching reduces parse time",
        learned: "10% improvement observed",
        next_focus: "Try larger cache",
      });
      assert.deepEqual(logCalls, [{
        cwd: "/tmp/test-project",
        description: "Added caching layer",
      }]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  describe("mcp-server bind host", () => {
    it("binds to 127.0.0.1 by default", async () => {
      const previousBindHost = process.env.TAMANDUA_BIND_HOST;
      delete process.env.TAMANDUA_BIND_HOST;

      const server = createTamanduaMcpServer(0);
      await server.start();

      try {
        const addr = server.server.address();
        assert.ok(addr && typeof addr !== "string");
        assert.equal(addr.address, "127.0.0.1");
      } finally {
        await server.stop();
        if (previousBindHost === undefined) delete process.env.TAMANDUA_BIND_HOST;
        else process.env.TAMANDUA_BIND_HOST = previousBindHost;
      }
    });

    it("honors TAMANDUA_BIND_HOST override", async () => {
      const previousBindHost = process.env.TAMANDUA_BIND_HOST;
      process.env.TAMANDUA_BIND_HOST = "0.0.0.0";

      const server = createTamanduaMcpServer(0);
      await server.start();

      try {
        const addr = server.server.address();
        assert.ok(addr && typeof addr !== "string");
        // On macOS/iOS, binding to 0.0.0.0 may report as '::' (IPv6 dual-stack)
        const allowed = ["0.0.0.0", "::"];
        assert.ok(allowed.includes(addr.address as string), `expected 0.0.0.0 or ::, got ${addr.address}`);
      } finally {
        await server.stop();
        if (previousBindHost === undefined) delete process.env.TAMANDUA_BIND_HOST;
        else process.env.TAMANDUA_BIND_HOST = previousBindHost;
      }
    });
  });
});
