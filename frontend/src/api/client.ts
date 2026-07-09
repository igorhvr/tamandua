const BASE = "";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Types ───────────────────────────────────────────────────────────

export interface Run {
  id: string;
  workflow_id: string;
  task: string;
  status: string;
  context: string;
  created_at: string;
  updated_at: string;
  run_number: number | null;
  tokens_spent: number;
  total_steps: number;
  completed_steps: number;
  failed_steps: number;
  running_steps: number;
  waiting_steps: number;
  no_hurry?: boolean;
}

export interface RunDetail {
  run: {
    id: string;
    workflow_id: string;
    task: string;
    status: string;
    context: string;
    created_at: string;
    updated_at: string;
    run_number: number | null;
    tokens_spent: number;
  };
  steps: Step[];
  events: TamanduaEvent[];
  worktree: unknown;
  failure_reason: string | null;
  prompt: string;
}

export interface Step {
  id: string;
  step_id: string;
  agent_id: string;
  step_index: number;
  status: string;
  output: string | null;
  retry_count: number;
  max_retries: number;
  type: string;
  created_at: string;
  updated_at: string;
}

export interface TamanduaEvent {
  ts: string;
  event: string;
  detail?: string;
  stepId?: string;
  storyId?: string;
  tokenDelta?: number;
  tokensSpent?: number;
}

export interface KanbanSnapshot {
  run: {
    id: string;
    run_number: number | null;
    workflow_id: string;
    task: string;
    status: string;
    tokens_spent: number;
    created_at: string;
    updated_at: string;
    elapsed_seconds: number | null;
  };
  lanes: KanbanLane[];
  currentStoryId: string | null;
  generatedAt: string;
}

export interface KanbanLane {
  agent: string;
  label: string;
  stepId: string;
  stepType: string;
  status: "todo" | "running" | "done" | "failed";
  cards: KanbanCard[];
  summary: { done: number; failed: number; running: number; total: number };
}

export interface KanbanCard {
  id: string;
  title: string;
  status: "todo" | "running" | "done" | "failed";
  sub: string;
}

export interface KanbanCardDetail {
  runId: string;
  cardId: string;
  title: string;
  status: string;
  storyId?: string;
  description?: string;
  acceptanceCriteria?: string[];
  input_template: string;
  output?: string;
  task: string;
  events: TamanduaEvent[];
  timing?: { firstEvent: string; lastEvent: string; durationMs: number };
  tokens?: { total: number; deltas: number[] };
  failureDetail?: string;
  retryCount: number;
  maxRetries: number;
}

export interface Stats {
  systemTokensSpent: number;
  totalTokensSpent: number;
}

export interface McpStatus {
  running: boolean;
  port: number;
  path: string;
}

export interface VersionInfo {
  version: string;
}

export interface VersionStatus {
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion?: string;
}

export interface AutoresearchSession {
  id: string;
  cwd: string;
  goal: string;
  metric_name: string;
  metric_unit: string;
  direction: string;
  command: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_run_at: string;
  total_runs: number;
  baseline_metric: number | null;
  best_metric: number | null;
  best_run: number | null;
  files_missing: string[];
  summary?: { exists: boolean; nextPrompt?: string };
}

// ── API Functions ────────────────────────────────────────────────────

export async function fetchRuns(): Promise<Run[]> {
  const data = await apiFetch<{ runs: Run[] }>("/api/runs");
  return data.runs;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function fetchKanban(runId: string): Promise<KanbanSnapshot> {
  return apiFetch<KanbanSnapshot>(`/api/runs/${encodeURIComponent(runId)}/kanban`);
}

export async function fetchKanbanCardDetail(
  runId: string,
  cardId: string,
): Promise<KanbanCardDetail> {
  return apiFetch<KanbanCardDetail>(
    `/api/runs/${encodeURIComponent(runId)}/kanban/card-detail?cardId=${encodeURIComponent(cardId)}`,
  );
}

export async function fetchEvents(limit = 40): Promise<TamanduaEvent[]> {
  const data = await apiFetch<{ events: TamanduaEvent[] }>(
    `/api/events?limit=${limit}`,
  );
  return data.events;
}

export async function fetchRunEvents(
  runId: string,
): Promise<TamanduaEvent[]> {
  const data = await apiFetch<{ events: TamanduaEvent[] }>(
    `/api/runs/${encodeURIComponent(runId)}/events`,
  );
  return data.events;
}

export async function fetchLogsTail(
  offset = 0,
  runId?: string,
): Promise<{ lines: string[]; nextOffset: number }> {
  const params = new URLSearchParams({ offset: String(offset) });
  if (runId) params.set("runId", runId);
  return apiFetch(`/api/logs-tail?${params}`);
}

export async function fetchStats(): Promise<Stats> {
  return apiFetch<Stats>("/api/stats");
}

export async function fetchMcpStatus(): Promise<McpStatus> {
  return apiFetch<McpStatus>("/api/mcp-status");
}

export async function fetchVersion(): Promise<VersionInfo> {
  return apiFetch<VersionInfo>("/api/version");
}

export async function fetchVersionStatus(): Promise<VersionStatus> {
  return apiFetch<VersionStatus>("/api/version-status");
}

export async function fetchAutoresearchSessions(): Promise<AutoresearchSession[]> {
  const data = await apiFetch<{ sessions: AutoresearchSession[] }>(
    "/api/autoresearch/sessions",
  );
  return data.sessions;
}

export async function pauseRun(
  runId: string,
  drain = false,
): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/pause?drain=${drain}`, {
    method: "POST",
  });
}

export async function resumeRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
  });
}

export async function cancelRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}

export async function deleteRun(runId: string, force = false): Promise<void> {
  await apiFetch(
    `/api/runs/${encodeURIComponent(runId)}?force=${force}`,
    { method: "DELETE" },
  );
}

export async function relaunchRun(
  runId: string,
  taskOverride?: string,
): Promise<{ relaunched: boolean; runId: string }> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}/relaunch`, {
    method: "POST",
    body: taskOverride ? JSON.stringify({ task: taskOverride }) : undefined,
  });
}
