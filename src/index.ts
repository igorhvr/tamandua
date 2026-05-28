// Installer
export { installWorkflow, getMaxRoleTimeoutSeconds, inferRole } from "./installer/install.js";
export { fetchWorkflow, listBundledWorkflows } from "./installer/workflow-fetch.js";
export { loadWorkflowSpec } from "./installer/workflow-spec.js";
export { writeWorkflowFile, writeWorkflowFiles } from "./installer/workspace-files.js";
export { provisionAgents } from "./installer/agent-provision.js";
export { uninstallWorkflow, uninstallAllWorkflows, checkActiveRuns } from "./installer/uninstall.js";
export { getWorkflowStatus, listRuns, stopWorkflow } from "./installer/status.js";
export { runWorkflow } from "./installer/run.js";
export { emitEvent, getRecentEvents, getRunEvents, getEventsPath } from "./installer/events.js";
export { ensureCliSymlink, isCliSymlinked, removeCliSymlink } from "./installer/symlink.js";

// Agent scheduler
export {
  setupAgentCrons,
  removeAgentCrons,
  removeRunCrons,
  teardownWorkflowCronsIfIdle,
  createAgentCronJob,
  shutdownAllCrons,
} from "./installer/agent-scheduler.js";

// Step ops
export {
  peekStep,
  claimStep,
  WorkerOwnership,
  completeStep,
  failStep,
  advancePipeline,
  cleanupAbandonedSteps,
} from "./installer/step-ops.js";

// Paths
export {
  resolvePiStateDir,
  resolveTamanduaCli,
  resolveWorkflowDir,
  resolveWorkflowRoot,
  resolveWorkflowWorkspaceDir,
  resolveWorkflowWorkspaceRoot,
  resolveBundledWorkflowsDir,
  resolveBundledWorkflowDir,
  resolveSourcePath,
} from "./installer/paths.js";

export {
  createDefaultUpdateServices,
  defaultRunCommand,
  installAllBundledWorkflowsForUpdate,
  runUpdate,
} from "./cli/update.js";

export {
  getAutoresearchPaths,
  hasDirtyNonAutoresearchFiles,
  isAutoresearchProtectedFile,
  PROTECTED_AUTORESEARCH_FILE_NAMES,
  initExperiment,
  runExperiment,
  logExperiment,
  summarizeAutoresearch,
  readAutoresearchLog,
  readSessionConfig,
  parseMetric,
  decideStatus,
  calculateAutoresearchConfidence,
  commitAutoresearchResult,
  runLoopIteration,
} from "./autoresearch/autoresearch.js";

// Database
export { getDb, nextRunNumber, getDbPath } from "./db.js";

// MCP server
export {
  DEFAULT_MCP_PORT,
  createTamanduaMcpServer,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
} from "./server/mcp-server.js";

// Types
export type {
  WorkflowSpec,
  WorkflowAgent,
  WorkflowAgentFiles,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowRunRecord,
  WorkflowInstallResult,
  StepResult,
  Story,
  AgentRole,
  PollingConfig,
  LoopConfig,
} from "./installer/types.js";

export type { ProvisionedAgent, ProvisionAgentsParams } from "./installer/agent-provision.js";
export type { TamanduaEvent } from "./installer/events.js";
export type { UninstallResult, ActiveRunInfo } from "./installer/uninstall.js";
export type { RunWorkflowParams, RunWorkflowResult } from "./installer/run.js";
export type { RunInfo, RunDetail, StepInfo, StoryInfo } from "./installer/status.js";
export type { WriteFileStatus, WriteWorkflowFileParams, WriteWorkflowFileResult } from "./installer/workspace-files.js";
export type { CronJobInfo, CreateCronJobParams } from "./installer/agent-scheduler.js";
export type { TamanduaMcpServer, TamanduaMcpServerOptions, TamanduaMcpToolServices } from "./server/mcp-server.js";
export type {
  AutoresearchDecision,
  AutoresearchConfidence,
  AutoresearchConfidenceBand,
  AutoresearchDirection,
  AutoresearchLogEntry,
  AutoresearchRunEntry,
  AutoresearchRunResultEntry,
  AutoresearchSessionConfig,
  AutoresearchSummary,
  RunLoopIterationOptions,
  RunLoopIterationResult,
} from "./autoresearch/autoresearch.js";
