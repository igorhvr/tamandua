import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { getWorkflowStatus, listRuns, deleteWorkflow, type RunDetail, type RunInfo } from "../installer/status.js";
import { runWorkflow, type RunWorkflowResult } from "../installer/run.js";
import { getRecentEvents, type TamanduaEvent } from "../installer/events.js";
import { resolveSourcePath, resolveSkillPath, resolveWorkflowDir } from "../installer/paths.js";
import { loadWorkflowSpec } from "../installer/workflow-spec.js";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "./control-client.js";
import {
  initExperiment,
  runExperiment,
  logExperiment,
  summarizeAutoresearch,
  type AutoresearchDecision,
  type AutoresearchDirection,
} from "../autoresearch/autoresearch.js";

export const DEFAULT_MCP_PORT = 3338;
export const MCP_ENDPOINT_PATH = "/mcp";

const MCP_TOOL_RUNS_LIST = "tamandua.runs.list";
const MCP_TOOL_RUN_STATUS = "tamandua.run.status";
const MCP_TOOL_RUN_START = "tamandua.run.start";
const MCP_TOOL_RUN_PAUSE = "tamandua.run.pause";
const MCP_TOOL_RUN_RESUME = "tamandua.run.resume";
const MCP_TOOL_RUN_DELETE = "tamandua.run.delete";
const MCP_TOOL_EVENTS_RECENT = "tamandua.events.recent";
const MCP_TOOL_SKILL_PATH = "tamandua.skill.path";
const MCP_TOOL_SOURCE_PATH = "tamandua.source.path";
const MCP_TOOL_UPDATE_COMMAND = "tamandua.update.command";
const MCP_TOOL_AUTORESEARCH_INIT = "tamandua.autoresearch.init";
const MCP_TOOL_AUTORESEARCH_RUN = "tamandua.autoresearch.run_experiment";
const MCP_TOOL_AUTORESEARCH_LOG = "tamandua.autoresearch.log_experiment";
const MCP_TOOL_AUTORESEARCH_STATUS = "tamandua.autoresearch.status";

type McpSession = {
  protocolServer: Server;
  transport: StreamableHTTPServerTransport;
};

export interface TamanduaMcpToolServices {
  listRuns: (limit?: number) => RunInfo[];
  getWorkflowStatus: (query: string) => RunDetail;
  runWorkflow: (params: {
    workflowId: string;
    taskTitle: string;
    workingDirectoryForHarness?: string;
    worktreeOriginRepository?: string;
    worktreeOriginRef?: string;
    noHurrySaveTokensMode?: boolean;
  }) => Promise<RunWorkflowResult>;
  getRecentEvents: (limit?: number) => TamanduaEvent[];
  getSourcePath: () => string;
  getSkillPath: () => string;
  pauseRun: (runId: string, drain?: boolean) => Promise<{ runId: string; status: string }>;
  resumeRun: (runId: string) => Promise<{ runId: string; status: string }>;
  deleteRun: (runId: string, force?: boolean) => Promise<{ ok: boolean; runId: string; status: string }>;
  resolveWorkspaceMode: (workflowId: string) => Promise<"direct" | "worktree">;
  initAutoresearch: typeof initExperiment;
  runAutoresearchExperiment: typeof runExperiment;
  logAutoresearchExperiment: typeof logExperiment;
  summarizeAutoresearch: typeof summarizeAutoresearch;
}

export type TamanduaMcpServerOptions = {
  services?: Partial<TamanduaMcpToolServices>;
};

export type TamanduaMcpServer = {
  readonly server: http.Server;
  readonly port: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const defaultToolServices: TamanduaMcpToolServices = {
  listRuns,
  getWorkflowStatus,
  runWorkflow,
  getRecentEvents,
  getSourcePath: resolveSourcePath,
  getSkillPath: resolveSkillPath,
  async pauseRun(runId, drain = false) {
    const r = await pauseRunWithDaemon(runId, drain);
    if (!r) throw new Error("Daemon control plane unreachable");
    if (r.body.error) throw new Error(String(r.body.error));
    return { runId, status: String(r.body.state ?? r.status) };
  },
  async resumeRun(runId) {
    const r = await resumeRunWithDaemon(runId);
    if (!r) throw new Error("Daemon control plane unreachable");
    if (r.body.error) throw new Error(String(r.body.error));
    return { runId, status: String(r.body.state ?? r.status) };
  },
  async deleteRun(runId, force = false) {
    return deleteWorkflow(runId, { force });
  },
  async resolveWorkspaceMode(workflowId) {
    const workflowDir = resolveWorkflowDir(workflowId);
    const spec = await loadWorkflowSpec(workflowDir);
    return spec.run?.workspace ?? "direct";
  },
  initAutoresearch: initExperiment,
  runAutoresearchExperiment: runExperiment,
  logAutoresearchExperiment: logExperiment,
  summarizeAutoresearch,
};

const mcpTools: Array<Record<string, unknown>> = [
  {
    name: MCP_TOOL_RUNS_LIST,
    title: "List Tamandua Runs",
    description: "List recent Tamandua workflow runs.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of runs to return (default 50).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runs"],
      properties: {
        runs: {
          type: "array",
          description: "Run metadata returned by listRuns().",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_STATUS,
    title: "Get Tamandua Run Status",
    description: "Fetch detailed status for a run by id, prefix, or task query.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Run id, run id prefix, or task substring.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["run"],
      properties: {
        run: {
          type: "object",
          description: "Detailed run status returned by getWorkflowStatus().",
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_START,
    title: "Start Tamandua Run",
    description: "Start a workflow run. For direct workflows, workingDirectoryForHarness is required. For worktree workflows, worktreeOriginRepository is required.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workflowId", "taskTitle"],
      properties: {
        workflowId: {
          type: "string",
          minLength: 1,
          description: "Workflow id to run.",
        },
        taskTitle: {
          type: "string",
          minLength: 1,
          description: "Task description for the workflow run.",
        },
        workingDirectoryForHarness: {
          type: "string",
          minLength: 1,
          description: "Harness working directory for remote MCP runs. Required for direct workflows, invalid for worktree workflows.",
        },
        worktreeOriginRepository: {
          type: "string",
          minLength: 1,
          description: "Repository path to create the worktree from. Required for worktree workflows, invalid for direct workflows.",
        },
        worktreeOriginRef: {
          type: "string",
          description: "Git ref (branch, tag, SHA) for the worktree. Optional. Only valid for worktree workflows.",
        },
        noHurrySaveTokensMode: {
          type: "boolean",
          description: "When true, reduces polling frequency to save tokens (15-min floor, 15-min default instead of 1-min floor, 5-min default). Optional, defaults to false.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["run"],
      properties: {
        run: {
          type: "object",
          description: "Run metadata returned by runWorkflow().",
        },
      },
    },
  },
  {
    name: MCP_TOOL_EVENTS_RECENT,
    title: "Get Recent Tamandua Events",
    description: "List recent global Tamandua events.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum number of events to return (default 50).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          description: "Event records returned by getRecentEvents().",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_PAUSE,
    title: "Pause Tamandua Run",
    description: "Pause a running Tamandua workflow run. Optionally drain in-flight work before pausing.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Run id to pause.",
        },
        drain: {
          type: "boolean",
          description: "If true, wait for in-flight work to complete before pausing (default false).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runId", "status"],
      properties: {
        runId: { type: "string", description: "Run id that was paused." },
        status: { type: "string", description: "New run status after pause." },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_RESUME,
    title: "Resume Tamandua Run",
    description: "Resume a paused Tamandua workflow run.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Run id to resume.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runId", "status"],
      properties: {
        runId: { type: "string", description: "Run id that was resumed." },
        status: { type: "string", description: "New run status after resume." },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_DELETE,
    title: "Delete Tamandua Run",
    description: "Permanently delete a Tamandua workflow run and all associated data (steps, stories, worktrees). Active runs can be force-deleted.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Run id to delete.",
        },
        force: {
          type: "boolean",
          description: "If true, cancel and delete even if the run is currently running or paused (default false).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ok", "runId", "status"],
      properties: {
        ok: { type: "boolean", description: "Whether the deletion succeeded." },
        runId: { type: "string", description: "Run id that was deleted." },
        status: { type: "string", description: "Final status (deleted)." },
      },
    },
  },
  {
    name: MCP_TOOL_SKILL_PATH,
    title: "Get Tamandua Skill Path",
    description: "Return the path to the bundled tamandua-agents skill that teaches agents how to operate Tamandua.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["skillPath"],
      properties: {
        skillPath: {
          type: "string",
          description: "Absolute path to the bundled tamandua-agents skill file.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_SOURCE_PATH,
    title: "Get Tamandua Source Path",
    description: "Return the local Tamandua source checkout path.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["sourcePath"],
      properties: {
        sourcePath: {
          type: "string",
          description: "Tamandua source checkout path.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_UPDATE_COMMAND,
    title: "Get Tamandua Update Command",
    description: "Return local CLI guidance for updating Tamandua safely.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["command", "description", "safety"],
      properties: {
        command: {
          type: "string",
          description: "The local CLI command.",
        },
        description: {
          type: "string",
          description: "What the command does.",
        },
        safety: {
          type: "string",
          description: "Important service lifecycle guidance.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_AUTORESEARCH_INIT,
    title: "Initialize AutoResearch",
    description: "Create project-local AutoResearch state files from a goal, metric, direction, and benchmark command.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cwd", "goal", "metricName", "direction", "command"],
      properties: {
        cwd: { type: "string", minLength: 1, description: "Project directory." },
        goal: { type: "string", minLength: 1, description: "Optimization objective." },
        metricName: { type: "string", minLength: 1, description: "Metric name to parse and optimize." },
        metricUnit: { type: "string", description: "Optional metric unit." },
        direction: { type: "string", enum: ["lower", "higher"], description: "Whether lower or higher metric values are better." },
        command: { type: "string", minLength: 1, description: "Shell command that runs the experiment." },
        metricRegex: { type: "string", description: "Optional regex with metric value in capture group 1." },
        checksCommand: { type: "string", description: "Optional correctness checks command." },
        overwrite: { type: "boolean", description: "Replace existing AutoResearch files." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["session"],
      properties: {
        session: { type: "object", description: "Created AutoResearch session entry." },
      },
    },
  },
  {
    name: MCP_TOOL_AUTORESEARCH_RUN,
    title: "Run AutoResearch Experiment",
    description: "Run the configured experiment command, parse the metric, run checks, and append a run_result entry.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cwd"],
      properties: {
        cwd: { type: "string", minLength: 1, description: "Project directory." },
        command: { type: "string", description: "Optional command override for this run." },
        metricRegex: { type: "string", description: "Optional metric regex override." },
        checksCommand: { type: "string", description: "Optional checks command override." },
        timeoutMs: { type: "integer", minimum: 1, description: "Experiment timeout in milliseconds." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["result"],
      properties: {
        result: { type: "object", description: "Measured run result entry." },
      },
    },
  },
  {
    name: MCP_TOOL_AUTORESEARCH_LOG,
    title: "Log AutoResearch Experiment",
    description: "Append the evidence-based experiment decision and learning that drives the next iteration.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cwd", "description"],
      properties: {
        cwd: { type: "string", minLength: 1, description: "Project directory." },
        metric: { type: "number", description: "Optional metric override." },
        status: { type: "string", enum: ["auto", "baseline", "keep", "discard", "crash", "checks_failed"], description: "Decision. Defaults to auto." },
        description: { type: "string", minLength: 1, description: "What changed in this experiment." },
        hypothesis: { type: "string", description: "Hypothesis tested." },
        learned: { type: "string", description: "Evidence learned from the result." },
        nextFocus: { type: "string", description: "Next experiment direction." },
        commit: { type: "boolean", description: "Commit kept/baseline results with git." },
        revertDiscard: { type: "boolean", description: "Revert non-autoresearch tracked files when decision is discard." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["entry"],
      properties: {
        entry: { type: "object", description: "Logged experiment decision." },
      },
    },
  },
  {
    name: MCP_TOOL_AUTORESEARCH_STATUS,
    title: "Get AutoResearch Status",
    description: "Summarize baseline, best result, failures, and the next ratchet prompt for a project.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cwd"],
      properties: {
        cwd: { type: "string", minLength: 1, description: "Project directory." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "object", description: "AutoResearch session summary." },
      },
    },
  },
];

function invalidParams(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalidParams("Tool arguments must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function readLimitArgument(args: Record<string, unknown>, defaultValue: number, max: number): number {
  const rawLimit = args.limit;
  if (rawLimit === undefined) return defaultValue;
  if (!Number.isInteger(rawLimit)) {
    invalidParams('Argument "limit" must be an integer');
  }

  const limit = Number(rawLimit);
  if (limit < 1 || limit > max) {
    invalidParams(`Argument "limit" must be between 1 and ${max}`);
  }

  return limit;
}

function readRequiredStringArgument(args: Record<string, unknown>, key: string): string {
  const rawValue = args[key];
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    invalidParams(`Argument "${key}" must be a non-empty string`);
  }
  return rawValue.trim();
}

function readRequiredQuery(args: Record<string, unknown>): string {
  return readRequiredStringArgument(args, "query");
}

function readOptionalStringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const rawValue = args[key];
  if (rawValue === undefined) return undefined;
  if (typeof rawValue !== "string") {
    invalidParams(`Argument "${key}" must be a string`);
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumberArgument(args: Record<string, unknown>, key: string): number | undefined {
  const rawValue = args[key];
  if (rawValue === undefined) return undefined;
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    invalidParams(`Argument "${key}" must be a finite number`);
  }
  return rawValue;
}

function readOptionalIntegerArgument(args: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumberArgument(args, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    invalidParams(`Argument "${key}" must be an integer`);
  }
  return value;
}

function readDirectionArgument(args: Record<string, unknown>): AutoresearchDirection {
  const value = readRequiredStringArgument(args, "direction");
  if (value === "lower" || value === "higher") return value;
  invalidParams('Argument "direction" must be "lower" or "higher"');
}

function readAutoresearchStatusArgument(args: Record<string, unknown>): AutoresearchDecision | "auto" | undefined {
  const value = readOptionalStringArgument(args, "status");
  if (!value) return undefined;
  if (value === "auto" || value === "baseline" || value === "keep" || value === "discard" || value === "crash" || value === "checks_failed") return value;
  invalidParams('Argument "status" must be auto, baseline, keep, discard, crash, or checks_failed');
}

function createToolResult(payload: Record<string, unknown>): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function createProtocolServer(services: TamanduaMcpToolServices): Server {
  const server = new Server(
    {
      name: "tamandua-remote-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = parseToolArguments(request.params.arguments);

    if (name === MCP_TOOL_RUNS_LIST) {
      const limit = readLimitArgument(args, 50, 200);
      return createToolResult({ runs: services.listRuns(limit) });
    }

    if (name === MCP_TOOL_RUN_STATUS) {
      const query = readRequiredQuery(args);
      try {
        return createToolResult({ run: services.getWorkflowStatus(query) });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_RUN_START) {
      const workflowId = readRequiredStringArgument(args, "workflowId");
      const taskTitle = readRequiredStringArgument(args, "taskTitle");
      const workingDirectoryForHarness: string | undefined =
        typeof args.workingDirectoryForHarness === "string" && args.workingDirectoryForHarness.trim().length > 0
          ? args.workingDirectoryForHarness.trim()
          : undefined;
      const worktreeOriginRepository: string | undefined =
        typeof args.worktreeOriginRepository === "string" && args.worktreeOriginRepository.trim().length > 0
          ? args.worktreeOriginRepository.trim()
          : undefined;
      const worktreeOriginRef: string | undefined =
        typeof args.worktreeOriginRef === "string" && args.worktreeOriginRef.trim().length > 0
          ? args.worktreeOriginRef.trim()
          : undefined;
      const noHurrySaveTokensMode: boolean | undefined =
        typeof args.noHurrySaveTokensMode === "boolean" ? args.noHurrySaveTokensMode : undefined;

      try {
        const workspaceMode = await services.resolveWorkspaceMode(workflowId);

        if (workspaceMode === "direct") {
          if (!workingDirectoryForHarness) {
            invalidParams("workingDirectoryForHarness is required for direct workflows");
          }
          if (worktreeOriginRepository) {
            invalidParams("worktreeOriginRepository is only valid for workflows with run.workspace: worktree");
          }
          if (worktreeOriginRef) {
            invalidParams("worktreeOriginRef is only valid for workflows with run.workspace: worktree");
          }
        } else {
          if (!worktreeOriginRepository) {
            invalidParams("worktreeOriginRepository is required for worktree workflows");
          }
          if (workingDirectoryForHarness) {
            invalidParams("workingDirectoryForHarness is not valid for worktree workflows. Use worktreeOriginRepository instead.");
          }
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }

      try {
        const run = await services.runWorkflow({
          workflowId,
          taskTitle,
          workingDirectoryForHarness,
          worktreeOriginRepository,
          worktreeOriginRef,
          noHurrySaveTokensMode,
        });
        return createToolResult({ run });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_EVENTS_RECENT) {
      const limit = readLimitArgument(args, 50, 500);
      return createToolResult({ events: services.getRecentEvents(limit) });
    }

    if (name === MCP_TOOL_RUN_PAUSE) {
      const runId = readRequiredStringArgument(args, "runId");
      const drain = args.drain === true;
      try {
        const result = await services.pauseRun(runId, drain);
        return createToolResult({ runId: result.runId, status: result.status });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_RUN_RESUME) {
      const runId = readRequiredStringArgument(args, "runId");
      try {
        const result = await services.resumeRun(runId);
        return createToolResult({ runId: result.runId, status: result.status });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_RUN_DELETE) {
      const runId = readRequiredStringArgument(args, "runId");
      const force = args.force === true;
      try {
        const result = await services.deleteRun(runId, force);
        return createToolResult({ ok: result.ok, runId: result.runId, status: result.status });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_SKILL_PATH) {
      return createToolResult({ skillPath: services.getSkillPath() });
    }

    if (name === MCP_TOOL_SOURCE_PATH) {
      return createToolResult({ sourcePath: services.getSourcePath() });
    }

    if (name === MCP_TOOL_UPDATE_COMMAND) {
      return createToolResult({
        command: "tamandua update [--force]",
        description:
          "Runs git pull in the Tamandua source checkout, rebuilds when the pulled HEAD changes, reinstalls bundled workflows, and restarts previously running Tamandua services when safe.",
        safety:
          "Run this command through the local CLI. The update process manages dashboard, MCP, and control-plane lifecycle; without --force it refuses the service reinstall/restart step while Tamandua runs are active.",
      });
    }

    if (name === MCP_TOOL_AUTORESEARCH_INIT) {
      try {
        const session = services.initAutoresearch({
          cwd: readRequiredStringArgument(args, "cwd"),
          goal: readRequiredStringArgument(args, "goal"),
          metricName: readRequiredStringArgument(args, "metricName"),
          metricUnit: readOptionalStringArgument(args, "metricUnit"),
          direction: readDirectionArgument(args),
          command: readRequiredStringArgument(args, "command"),
          metricRegex: readOptionalStringArgument(args, "metricRegex"),
          checksCommand: readOptionalStringArgument(args, "checksCommand"),
          overwrite: args.overwrite === true,
        });
        return createToolResult({ session });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_AUTORESEARCH_RUN) {
      try {
        const result = await services.runAutoresearchExperiment({
          cwd: readRequiredStringArgument(args, "cwd"),
          command: readOptionalStringArgument(args, "command"),
          metricRegex: readOptionalStringArgument(args, "metricRegex"),
          checksCommand: readOptionalStringArgument(args, "checksCommand"),
          timeoutMs: readOptionalIntegerArgument(args, "timeoutMs"),
        });
        return createToolResult({ result });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_AUTORESEARCH_LOG) {
      try {
        const entry = await services.logAutoresearchExperiment({
          cwd: readRequiredStringArgument(args, "cwd"),
          metric: readOptionalNumberArgument(args, "metric"),
          status: readAutoresearchStatusArgument(args) ?? "auto",
          description: readRequiredStringArgument(args, "description"),
          hypothesis: readOptionalStringArgument(args, "hypothesis"),
          learned: readOptionalStringArgument(args, "learned"),
          nextFocus: readOptionalStringArgument(args, "nextFocus"),
          commit: args.commit === true,
          revertDiscard: args.revertDiscard === true,
        });
        return createToolResult({ entry });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_AUTORESEARCH_STATUS) {
      try {
        const summary = services.summarizeAutoresearch(readRequiredStringArgument(args, "cwd"));
        return createToolResult({ summary });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  });

  return server;
}

function getSessionId(req: http.IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function respondJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id,
    }),
  );
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of req) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(piece);
    totalLength += piece.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Request body too large");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("Missing JSON-RPC request body");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function createTamanduaMcpServer(port = DEFAULT_MCP_PORT, options: TamanduaMcpServerOptions = {}): TamanduaMcpServer {
  const sessions = new Map<string, McpSession>();
  const services: TamanduaMcpToolServices = {
    ...defaultToolServices,
    ...options.services,
  };

  const httpServer = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname !== MCP_ENDPOINT_PATH) {
      respondJsonRpcError(res, 404, -32601, `Not found: ${method} ${pathname}`);
      return;
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      respondJsonRpcError(res, 405, -32600, `Unsupported method: ${method}`);
      return;
    }

    try {
      if (method === "POST") {
        const body = await parseJsonBody(req);
        const sessionId = getSessionId(req);

        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            respondJsonRpcError(res, 404, -32001, "Unknown MCP session", null);
            return;
          }

          await session.transport.handleRequest(req, res, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          respondJsonRpcError(res, 400, -32600, "Expected initialize request for new MCP session", null);
          return;
        }

        const protocolServer = createProtocolServer(services);
        let transport: StreamableHTTPServerTransport;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { protocolServer, transport });
          },
        });

        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (activeSessionId) {
            sessions.delete(activeSessionId);
          }
        };

        await protocolServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      const sessionId = getSessionId(req);
      if (!sessionId) {
        respondJsonRpcError(res, 400, -32600, "Missing mcp-session-id header", null);
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        respondJsonRpcError(res, 404, -32001, "Unknown MCP session", null);
        return;
      }

      await session.transport.handleRequest(req, res);
    } catch (err) {
      respondJsonRpcError(res, 500, -32603, (err as Error).message, null);
    }
  });

  let activePort = port;

  async function start(): Promise<void> {
    if (httpServer.listening) return;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };

      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port);
    });

    const address = httpServer.address();
    if (address && typeof address !== "string") {
      activePort = address.port;
    }
  }

  async function stop(): Promise<void> {
    const snapshot = Array.from(sessions.values());
    sessions.clear();

    await Promise.allSettled(
      snapshot.map(async (session) => {
        await session.transport.close();
        await session.protocolServer.close();
      }),
    );

    if (httpServer.listening) {
      await closeHttpServer(httpServer);
    }
  }

  return {
    server: httpServer,
    get port() {
      return activePort;
    },
    start,
    stop,
  };
}

export async function startTamanduaMcpServer(
  port = DEFAULT_MCP_PORT,
  options: TamanduaMcpServerOptions = {},
): Promise<TamanduaMcpServer> {
  const server = createTamanduaMcpServer(port, options);
  await server.start();
  return server;
}

export async function stopTamanduaMcpServer(server: TamanduaMcpServer): Promise<void> {
  await server.stop();
}
