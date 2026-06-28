// ══════════════════════════════════════════════════════════════════════
// dashboard-types.ts — Types shared between server API and React frontend
// ══════════════════════════════════════════════════════════════════════

// ── ML Kanban (per-agent lane view, Tela 2) ──────────────────────────

export type AgentStatus = "idle" | "running" | "completed" | "failed" | "timed_out";

export interface MLKanbanCard {
  /** Unique card id (experiment_id or round-phase key). */
  id: string;
  /** Agent persona name (data-analyst, feature-engineer, etc.). */
  agentName: string;
  /** Short display title. */
  title: string;
  status: AgentStatus;
  /** Subtitle line — e.g. "cvMean: 0.85" or "Round 3/5". */
  sub: string;
  /** When this card was last updated (ISO 8601). */
  updatedAt: string;
}

export interface MLKanbanLane {
  agent: string;
  label: string;
  status: AgentStatus;
  cards: MLKanbanCard[];
  summary: { done: number; failed: number; running: number; total: number };
}

export interface MLKanbanSnapshot {
  runId: string;
  roundNumber: number;
  status: string;
  lanes: MLKanbanLane[];
  generatedAt: string;
}

// ── Leaderboard (Tela 3) ─────────────────────────────────────────────

export interface LeaderboardEntry {
  id: string;
  runId: string;
  roundNumber: number;
  agentName: string;
  modelId: string;
  modelType: string;
  status: string;
  cvMean: number;
  cvStd: number;
  trainMean: number;
  trainValGap: number;
  hyperparameters: Record<string, unknown> | null;
  featureImportancesTop10: Array<[string, number]> | null;
  trainTimeSeconds: number | null;
  inferenceTimeMsPer1k: number | null;
  createdAt: string;
  promotedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
}

export interface CompareResponse {
  entries: LeaderboardEntry[];
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total: number;
  bestCvMean: number | null;
  filters: {
    agentName?: string;
    roundNumber?: number;
    status?: string;
  };
}

// ── Pipeline status (Tela 1) ─────────────────────────────────────────

export type PipelinePhase = "idle" | "data_analysis" | "feature_engineering" | "modeling" | "audit" | "complete";

export interface PipelineStatus {
  runId: string | null;
  status: "idle" | "running" | "paused" | "completed" | "failed";
  currentPhase: PipelinePhase;
  currentRound: number;
  maxRounds: number;
  startedAt: string | null;
  updatedAt: string | null;
  phaseStats: {
    dataAnalyst: AgentStatus;
    featureEngineer: AgentStatus;
    modelerClassic: AgentStatus;
    modelerAdvanced: AgentStatus;
    mlCritic: AgentStatus;
  };
  quickStats: {
    totalExperiments: number;
    bestCvMean: number | null;
    roundsCompleted: number;
    tokensSpent: number;
  };
}

// ── Agent detail (Tela 4) ────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  label: string;
  description: string;
  tools: string[];
  model: string;
  /** Logical ML phase this agent belongs to */
  phase: PipelinePhase;
  /** Step ID in the steps table */
  stepId: string;
}

export interface AgentDetail {
  agent: AgentInfo;
  currentStatus: AgentStatus;
  totalTrials: number;
  lastOutput: string | null;
  lastError: string | null;
  rounds: Array<{
    roundNumber: number;
    status: string;
    cvMean: number | null;
    modelType: string | null;
  }>;
}

export interface AgentLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AgentLogsResponse {
  agentName: string;
  entries: AgentLogEntry[];
  total: number;
  offset: number;
  limit: number;
}

// ── Rounds ───────────────────────────────────────────────────────────

export interface RoundSummary {
  runId: string;
  roundNumber: number;
  status: string;
  experimentsRegistered: number;
  experimentsRejected: number;
  startedAt: string;
  completedAt: string | null;
}

// ── Cross-findings ───────────────────────────────────────────────────

export interface CrossFinding {
  id: string;
  runId: string;
  roundNumber: number;
  fromAgent: string;
  toAgent: string;
  content: string;
  createdAt: string;
}

// ── Agent info registry (used by /api/agents) ────────────────────────

export const AGENT_INFO_REGISTRY: Record<string, AgentInfo> = {
  "data-analyst": {
    name: "data-analyst",
    label: "Data Analyst",
    description: "Performs exploratory data analysis: distributions, correlations, missing values, outlier detection, and generates hypotheses.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "data_analysis",
    stepId: "eda",
  },
  "feature-engineer": {
    name: "feature-engineer",
    label: "Feature Engineer",
    description: "Engineers features, creates train/test split, trains a baseline model. Ensures zero data leakage and deterministic splits.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "feature_engineering",
    stepId: "features",
  },
  "modeler-classic": {
    name: "modeler-classic",
    label: "Modeler (Classic)",
    description: "Trains classical ML models: GBM, Linear, RF, SVM, Stacking. Minimum 4 model families, 50+ trials. Plan mode on first round.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "modeling",
    stepId: "model-classic",
  },
  "modeler-advanced": {
    name: "modeler-advanced",
    label: "Modeler (Advanced)",
    description: "Trains advanced models: Neural Networks, TabNet, FT-Transformer, AutoML. CUDA detection, early stopping, torch seed determinism.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "modeling",
    stepId: "model-advanced",
  },
  "ml-critic": {
    name: "ml-critic",
    label: "ML Critic",
    description: "Adversarial auditor: validates model outputs with 8 audit checks. Read-only access — no Write tool. Can reject models from leaderboard.",
    tools: ["Read", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "audit",
    stepId: "audit",
  },
};

// ── Actions, decisions & UX primitives (front-specs §9) ──────────────

export type SpecAction = "approve" | "reject" | "edit";

export interface Action {
  id: string;
  label: string;
  primary?: boolean;
  variant?: "default" | "destructive" | "success";
}

export interface DecisionAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  required: boolean;
}

export interface ChecklistState {
  runId: string;
  phase: string;
  items: ChecklistItem[];
  updatedAt: string;
}


export interface DiffHunk {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

export interface SpecDiff {
  before: string;
  after: string;
  changes: DiffHunk[];
}

// ── Kanban Card Detail (enriched panel data) ──────────────────────────

export interface KanbanCardDetail {
  runId: string;
  cardId: string;
  title: string;
  status: string;
  storyId?: string;
  description?: string;
  acceptanceCriteria?: string[];
  input_template: string;
  /** Agent raw output text (summary / result). */
  output?: string;
  task: string;
  events: Array<Record<string, unknown>>;
  timing?: {
    firstEvent: string;
    lastEvent: string;
    durationMs: number;
  };
  tokens?: {
    total: number;
    deltas: number[];
  };
  failureDetail?: string;
  retryCount: number;
  maxRetries: number;
}

// ── Trace ────────────────────────────────────────────────────────────

export interface TraceEntry {
  timestamp: string;
  event: string;
  detail?: string;
  level: "info" | "warn" | "error";
}

export type PhaseStatus = "done" | "running" | "pending" | "failed";

export interface PhaseInfo {
  id: string;
  label: string;
  status: PhaseStatus;
  elapsedMs: number;
  estimatedMs: number;
}

export type PendingDecisionType =
  | "spec_approval"
  | "overfitting_warning";

export interface PendingDecision {
  id: string;
  type: PendingDecisionType;
  title: string;
  description: string;
  actions: DecisionAction[];
  createdAt: string;
}

// ── Spec approvals (persisted) ───────────────────────────────────────

export type SpecApprovalStatus = "pending" | "approved" | "rejected";

export interface SpecApproval {
  id: string;
  runId: string;
  phase: string;
  status: SpecApprovalStatus;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  updatedAt: string;
}

// ── Command Center aggregate (front-specs §3.1) ──────────────────────

export interface AgentStripItem {
  name: string;
  label: string;
  status: AgentStatus;
  bestCvMean: number | null;
  trials: number;
}

export interface CommandCenterSnapshot {
  run: {
    runId: string | null;
    status: PipelineStatus["status"];
    currentPhase: PipelinePhase;
    currentRound: number;
    maxRounds: number;
    startedAt: string | null;
    updatedAt: string | null;
  };
  phases: PhaseInfo[];
  pendingDecisions: PendingDecision[];
  bestModel: LeaderboardEntry | null;
  bestModelTrend: number[];
  agentStrip: AgentStripItem[];
  quickStats: PipelineStatus["quickStats"];
}
