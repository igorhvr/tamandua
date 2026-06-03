/**
 * Kanban data shaping
 *
 * Reads steps + stories for a single run and returns a lane-grouped snapshot
 * for the kanban view. Lanes are derived dynamically from the run's steps so
 * any workflow shape renders correctly, not just the canonical
 * planner→setup→developer→verifier→tester→merger pipeline.
 *
 * Status normalisation collapses the storage statuses (waiting/pending/
 * running/done/failed/canceled) into four visual buckets:
 *
 *   - "todo"    → waiting, pending
 *   - "running" → running
 *   - "done"    → done, completed
 *   - "failed"  → failed, canceled, cancelled
 *
 * For loop steps (e.g. the developer step that iterates over user stories),
 * the lane's cards are the stories. For single steps, the lane has one card
 * representing the step itself.
 */
import type { DatabaseSync } from "node:sqlite";
import type { TamanduaEvent } from "../installer/events.js";

export type VisualStatus = "todo" | "running" | "done" | "failed";

export interface KanbanCard {
  /** Card identifier shown in the chip (story_id for stories, step_id for steps). */
  id: string;
  /** Card body title. */
  title: string;
  /** Collapsed visual status. */
  status: VisualStatus;
  /** Short supplementary line — e.g. "retry 2/4" or last-updated time. */
  sub: string;
}

export interface KanbanLane {
  /** Agent role suffix (e.g. "developer"). Stable across workflows. */
  agent: string;
  /** Display label (e.g. "Developer"). */
  label: string;
  /** The step_id this lane represents in the workflow. */
  stepId: string;
  /** Step type — "single" or "loop". */
  stepType: string;
  /** Collapsed status for the lane as a whole. */
  status: VisualStatus;
  cards: KanbanCard[];
  summary: { done: number; failed: number; running: number; total: number };
}

export interface KanbanRunMeta {
  id: string;
  run_number: number | null;
  workflow_id: string;
  task: string;
  status: string;
  tokens_spent: number;
  created_at: string;
  updated_at: string;
  /**
   * Pre-computed elapsed seconds (frozen when run is terminal).
   * Fixes the kanban header showing elapsed time that kept increasing after the workflow finished
   * (the UI previously used Date.now() - created_at on every poll).
   */
  elapsed_seconds: number | null;
}

export interface KanbanSnapshot {
  run: KanbanRunMeta;
  lanes: KanbanLane[];
  currentStoryId: string | null;
  /** Server-side wall clock, for client elapsed/skew calculations. */
  generatedAt: string;
}

export interface KanbanCardDetail {
  runId: string;
  cardId: string;
  title: string;
  status: string;
  /** Present for story cards (loop step children). */
  storyId?: string;
  /** Story description (story cards only). */
  description?: string;
  /** Story acceptance criteria (story cards only). */
  acceptanceCriteria?: string[];
  /** The input template (prompt) sent to the agent for this step. */
  input_template: string;
  /** Step/story output text. */
  output?: string;
  /** Run task description. */
  task: string;
  /** Events filtered to the relevant step/story. */
  events: TamanduaEvent[];
  /** Timing computed from first and last relevant event. */
  timing?: {
    firstEvent: string;
    lastEvent: string;
    durationMs: number;
  };
  /** Token spend from run.tokens.updated events (total and per-delta). */
  tokens?: {
    total: number;
    deltas: number[];
  };
  /** Failure detail from step.failed / story.failed events. */
  failureDetail?: string;
  retryCount: number;
  maxRetries: number;
}

interface StepRow {
  id: string;
  step_id: string;
  agent_id: string;
  step_index: number;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  type: string;
  current_story_id: string | null;
  updated_at: string;
}

interface StoryRow {
  story_id: string;
  story_index: number;
  title: string;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  updated_at: string;
}

interface RunRow {
  id: string;
  run_number: number | null;
  workflow_id: string;
  task: string;
  status: string;
  tokens_spent: number;
  created_at: string;
  updated_at: string;
}

const RUNNING_STATUSES = new Set(["running"]);
const DONE_STATUSES = new Set(["done", "completed"]);
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled"]);
const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "canceled", "cancelled"]);

export function normaliseStatus(raw: string | null | undefined): VisualStatus {
  if (!raw) return "todo";
  const s = String(raw).toLowerCase();
  if (RUNNING_STATUSES.has(s)) return "running";
  if (DONE_STATUSES.has(s)) return "done";
  if (FAILED_STATUSES.has(s)) return "failed";
  return "todo";
}

export function laneAgentSuffix(agentId: string): string {
  const idx = agentId.lastIndexOf("_");
  return idx >= 0 ? agentId.slice(idx + 1) : agentId;
}

function humanLabel(agent: string): string {
  if (!agent) return "Step";
  return agent.charAt(0).toUpperCase() + agent.slice(1).replace(/[-_]/g, " ");
}

function summarise(cards: KanbanCard[]): KanbanLane["summary"] {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const c of cards) {
    if (c.status === "done") done++;
    else if (c.status === "failed") failed++;
    else if (c.status === "running") running++;
  }
  return { done, failed, running, total: cards.length };
}

function laneStatusFromStepAndCards(
  stepStatus: VisualStatus,
  cards: KanbanCard[],
): VisualStatus {
  // The step itself is the source of truth, but for a loop step we may want to
  // surface "running" while the step row still says "pending" between story
  // claim cycles. Mirror what the cards collectively show in that case.
  if (stepStatus !== "todo") return stepStatus;
  if (cards.some((c) => c.status === "running")) return "running";
  if (cards.length > 0 && cards.every((c) => c.status === "done")) return "done";
  if (cards.some((c) => c.status === "failed")) return "failed";
  return "todo";
}

function storyCardSub(story: StoryRow): string {
  if ((story.retry_count ?? 0) > 0) {
    return `retry ${story.retry_count}/${story.max_retries ?? "?"}`;
  }
  return `updated ${story.updated_at}`;
}

function stepCardSub(step: StepRow): string {
  if ((step.retry_count ?? 0) > 0) {
    return `retry ${step.retry_count}/${step.max_retries ?? "?"}`;
  }
  return `updated ${step.updated_at}`;
}

// ── Helpers for buildKanbanCardDetail ──────────────────────────────

function parseEventIsoMs(ts: string | undefined): number {
  if (!ts) return 0;
  // SQLite datetime('now') returns space-separated UTC without timezone.
  // Normalize to ISO-8601 so JS parses as UTC, not local time.
  // Matches parseTimestamp logic in kanban.html.
  const iso = /Z$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function computeElapsed(status: string, created_at: string, updated_at: string): number | null {
  const createdMs = parseEventIsoMs(created_at);
  const updatedMs = parseEventIsoMs(updated_at);
  if (!createdMs || !updatedMs) return null;
  const statusKey = String(status).toLowerCase();
  // Terminal runs: freeze duration so the dashboard does not keep counting after completion.
  // Active runs: return null so the client uses its own clock between polls.
  if (TERMINAL_STATUSES.has(statusKey)) return Math.max(0, (updatedMs - createdMs) / 1000);
  return null;
}

function extractFailureDetail(events: TamanduaEvent[]): string | undefined {
  // Prefer story.failed then step.failed, most recent first.
  const sorted = [...events].sort(
    (a, b) => parseEventIsoMs(b.ts) - parseEventIsoMs(a.ts),
  );
  for (const e of sorted) {
    if (e.event === "story.failed" && e.detail) return e.detail;
  }
  for (const e of sorted) {
    if (e.event === "step.failed" && e.detail) return e.detail;
  }
  return undefined;
}

function aggregateTokens(events: TamanduaEvent[]): NonNullable<KanbanCardDetail["tokens"]> | undefined {
  const deltas: number[] = [];
  let lastTotal = 0;
  for (const e of events) {
    if (e.event === "run.tokens.updated") {
      if (typeof e.tokenDelta === "number") deltas.push(e.tokenDelta);
      if (typeof e.tokensSpent === "number") lastTotal = e.tokensSpent;
    }
  }
  if (deltas.length === 0 && lastTotal === 0) return undefined;
  return { total: lastTotal, deltas };
}

/**
 * Build enriched detail for a single kanban card (story or step).
 * Returns null if the run doesn't exist or the cardId doesn't match
 * any story or step in the run.
 *
 * Visible for testing: takes a DatabaseSync handle + event list so
 * tests can inject in-memory data.
 */
export function buildKanbanCardDetail(
  db: DatabaseSync,
  runId: string,
  cardId: string,
  runEvents?: TamanduaEvent[],
): KanbanCardDetail | null {
  // ── run existence check ─────────────────────────────────────────
  const run = db.prepare(
    "SELECT id, task FROM runs WHERE id = ?",
  ).get(runId) as unknown as { id: string; task: string } | undefined;
  if (!run) return null;

  // ── try matching a story first ─────────────────────────────────
  const story = db.prepare(`
    SELECT story_id, story_index, title, description, acceptance_criteria,
           status, output, retry_count, max_retries
    FROM stories WHERE run_id = ? AND story_id = ?
  `).get(runId, cardId) as unknown as {
    story_id: string; story_index: number; title: string;
    description: string; acceptance_criteria: string;
    status: string; output: string | null;
    retry_count: number; max_retries: number;
  } | undefined;

  if (story) {
    // Find the loop step that holds this story.
    const loopStep = db.prepare(`
      SELECT step_id, input_template, output, retry_count, max_retries
      FROM steps WHERE run_id = ? AND type = 'loop'
      ORDER BY step_index ASC LIMIT 1
    `).get(runId) as unknown as {
      step_id: string; input_template: string; output: string | null;
      retry_count: number; max_retries: number;
    } | undefined;

    const events = (runEvents ?? []).filter(
      (e) =>
        e.storyId === cardId ||
        (loopStep &&
          e.stepId === loopStep.step_id &&
          !e.storyId),
    );
    const timing = buildTiming(events);
    return {
      runId,
      cardId,
      title: story.title,
      status: story.status,
      storyId: story.story_id,
      description: story.description || undefined,
      acceptanceCriteria: safeParseJsonArray(story.acceptance_criteria),
      input_template: loopStep?.input_template ?? "",
      output: story.output ?? loopStep?.output ?? undefined,
      task: run.task,
      events,
      timing,
      tokens: aggregateTokens(events),
      failureDetail: extractFailureDetail(events),
      retryCount: story.retry_count ?? 0,
      maxRetries: story.max_retries ?? 4,
    };
  }

  // ── try matching a step ────────────────────────────────────────
  const step = db.prepare(`
    SELECT step_id, agent_id, input_template, output, status,
           retry_count, max_retries
    FROM steps WHERE run_id = ? AND step_id = ?
  `).get(runId, cardId) as unknown as {
    step_id: string; agent_id: string; input_template: string;
    output: string | null; status: string;
    retry_count: number; max_retries: number;
  } | undefined;

  if (!step) return null;

  const events = (runEvents ?? []).filter((e) => e.stepId === cardId);
  const timing = buildTiming(events);
  return {
    runId,
    cardId,
    title: `${step.agent_id.split("_").pop() ?? step.agent_id} step`,
    status: step.status,
    input_template: step.input_template ?? "",
    output: step.output ?? undefined,
    task: run.task,
    events,
    timing,
    tokens: aggregateTokens(events),
    failureDetail: extractFailureDetail(events),
    retryCount: step.retry_count ?? 0,
    maxRetries: step.max_retries ?? 4,
  };
}

function buildTiming(events: TamanduaEvent[]): KanbanCardDetail["timing"] {
  if (events.length === 0) return undefined;
  const sorted = [...events].sort(
    (a, b) => parseEventIsoMs(a.ts) - parseEventIsoMs(b.ts),
  );
  const first = parseEventIsoMs(sorted[0].ts);
  const last = parseEventIsoMs(sorted[sorted.length - 1].ts);
  if (first === 0 || last === 0) return undefined;
  const durationMs = last - first;
  return {
    firstEvent: sorted[0].ts,
    lastEvent: sorted[sorted.length - 1].ts,
    durationMs: Math.max(0, durationMs),
  };
}

function safeParseJsonArray(raw: string): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
  } catch {
    // malformed JSON — treat as missing
  }
  return undefined;
}

/**
 * Build a kanban snapshot for one run. Returns null if the run does not exist.
 *
 * Visible for testing: takes a DatabaseSync handle directly so tests can pass
 * a temp-home db without monkey-patching getDb().
 */
export function buildKanbanSnapshot(
  db: DatabaseSync,
  runId: string,
): KanbanSnapshot | null {
  const run = db.prepare(`
    SELECT id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at
    FROM runs WHERE id = ?
  `).get(runId) as unknown as RunRow | undefined;

  if (!run) return null;

  const steps = db.prepare(`
    SELECT id, step_id, agent_id, step_index, status, retry_count, max_retries,
           type, current_story_id, updated_at
    FROM steps WHERE run_id = ?
    ORDER BY step_index ASC
  `).all(runId) as unknown as StepRow[];

  const stories = db.prepare(`
    SELECT story_id, story_index, title, status, retry_count, max_retries, updated_at
    FROM stories WHERE run_id = ?
    ORDER BY story_index ASC
  `).all(runId) as unknown as StoryRow[];

  // The current story is whichever story the (single) loop step claims.
  const loopStep = steps.find((s) => s.type === "loop");
  const currentStoryId = loopStep?.current_story_id ?? null;

  const lanes: KanbanLane[] = steps.map((step) => {
    const agent = laneAgentSuffix(step.agent_id);
    const label = humanLabel(agent);
    let cards: KanbanCard[];
    if (step.type === "loop") {
      cards = stories.map((story) => {
        let cardStatus = normaliseStatus(story.status);
        // Promote the claimed story to "running" while the loop step is alive.
        if (
          cardStatus === "todo" &&
          currentStoryId &&
          story.story_id === currentStoryId &&
          normaliseStatus(step.status) !== "done" &&
          normaliseStatus(step.status) !== "failed"
        ) {
          cardStatus = "running";
        }
        return {
          id: story.story_id,
          title: story.title,
          status: cardStatus,
          sub: storyCardSub(story),
        };
      });
    } else {
      cards = [{
        id: step.step_id,
        title: `${label} step`,
        status: normaliseStatus(step.status),
        sub: stepCardSub(step),
      }];
    }

    const stepStatus = normaliseStatus(step.status);
    return {
      agent,
      label,
      stepId: step.step_id,
      stepType: step.type,
      status: laneStatusFromStepAndCards(stepStatus, cards),
      cards,
      summary: summarise(cards),
    };
  });

  return {
    run: {
      id: run.id,
      run_number: run.run_number,
      workflow_id: run.workflow_id,
      task: run.task,
      status: run.status,
      tokens_spent: run.tokens_spent ?? 0,
      created_at: run.created_at,
      updated_at: run.updated_at,
      elapsed_seconds: computeElapsed(run.status, run.created_at, run.updated_at),
    },
    lanes,
    currentStoryId,
    generatedAt: new Date().toISOString(),
  };
}
