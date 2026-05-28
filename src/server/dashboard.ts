/**
 * Tamandua Dashboard HTTP Server
 *
 * Creates an HTTP server that serves the dashboard UI and API endpoints.
 *
 * Routes:
 *   GET /                        -> index.html (dashboard UI)
 *   GET /runs/:id/kanban         -> kanban.html (per-run swim-lane view)
 *   GET /api/autoresearch/runs   -> list workflow runs with AutoResearch state
 *   GET /api/runs                -> list all workflow runs
 *   GET /api/runs/:id            -> detail for a specific run
 *   GET /api/runs/:id/autoresearch -> AutoResearch progress for a run's harness cwd
 *   GET /api/runs/:id/kanban     -> lane-grouped snapshot for the kanban view
 *   GET /api/events              -> recent events (global)
 *   DELETE /api/runs/:id         -> permanently delete a run and all associated data
 *   GET /api/logs-tail           -> logs-tail formatted event lines (cursor based)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getSystemTokenSpend, getAutoresearchSessions, getAutoresearchSessionById, upsertAutoresearchSession } from "../db.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { getMcpStatus } from "./daemonctl.js";
import { buildKanbanSnapshot, buildKanbanCardDetail } from "./kanban-data.js";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "./control-client.js";
import { runWorkflow } from "../installer/run.js";
import { stopWorkflow, deleteWorkflow, getWorkflowStatus } from "../installer/status.js";
import { readVersionStatus } from "../lib/version-check.js";
import { getBuildVersion } from "../lib/version.js";
import {
  findAutoresearchSessionCwd,
  calculateAutoresearchConfidence,
  readAutoresearchLog,
  summarizeAutoresearch,
  type AutoresearchLogEntry,
  type AutoresearchRunEntry,
  type AutoresearchRunResultEntry,
} from "../autoresearch/autoresearch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");
const KANBAN_HTML = path.join(__dirname, "kanban.html");

// ── Helpers ─────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function htmlResponse(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function errorResponse(res: http.ServerResponse, message: string, status = 500): void {
  jsonResponse(res, { error: message }, status);
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      // Limit body size to 1MB
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

type RunContext = Record<string, unknown>;

function parseRunContext(context: unknown): RunContext {
  if (typeof context !== "string" || context.trim() === "") return {};
  try {
    const parsed = JSON.parse(context) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RunContext
      : {};
  } catch {
    return {};
  }
}

function stringFromContext(ctx: RunContext, key: string): string | undefined {
  const value = ctx[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveRunHarnessCwd(run: { context?: string | null }): string | undefined {
  const ctx = parseRunContext(run.context);
  return (
    stringFromContext(ctx, "working_directory_for_harness") ??
    stringFromContext(ctx, "worktree_path") ??
    stringFromContext(ctx, "cwd")
  );
}

function buildAutoresearchExperiments(entries: AutoresearchLogEntry[]) {
  const results = new Map<number, AutoresearchRunResultEntry>();
  for (const entry of entries) {
    if (entry.type === "run_result") results.set(entry.run, entry);
  }

  const cumulativeEntries: AutoresearchLogEntry[] = entries.filter((entry) => entry.type === "session");
  return entries
    .filter((entry): entry is AutoresearchRunEntry => entry.type === "run")
    .map((entry) => {
      const result = results.get(entry.run);
      cumulativeEntries.push(entry);
      const hasStoredConfidence = Object.prototype.hasOwnProperty.call(entry, "confidence_band");
      const confidence = !hasStoredConfidence
        ? calculateAutoresearchConfidence(cumulativeEntries, entry.direction)
        : {
            confidence_score: entry.confidence_score,
            confidence_band: entry.confidence_band,
            noise_floor_mad: entry.noise_floor_mad,
            confidence_sample_count: entry.confidence_sample_count,
          };
      return {
        run: entry.run,
        created_at: entry.created_at,
        status: entry.status,
        metric: entry.metric,
        best_metric: entry.best_metric,
        improvement_ratio: entry.improvement_ratio,
        confidence_score: confidence.confidence_score,
        confidence_band: confidence.confidence_band,
        noise_floor_mad: confidence.noise_floor_mad,
        confidence_sample_count: confidence.confidence_sample_count,
        duration_ms: entry.duration_ms ?? result?.duration_ms,
        description: entry.description,
        hypothesis: entry.asi?.hypothesis,
        learned: entry.asi?.learned,
        next_focus: entry.asi?.next_focus,
        command: entry.command ?? result?.command,
        commit_before: entry.commit_before ?? result?.commit_before,
        commit_after: entry.commit_after,
        measured_status: result?.status,
        exit_code: result?.exit_code,
        checks: result?.checks
          ? {
              command: result.checks.command,
              exit_code: result.checks.exit_code,
              duration_ms: result.checks.duration_ms,
            }
          : undefined,
      };
    });
}

// ── API Handlers ─────────────────────────────────────────────────────

function handleListRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();

    const rawRuns = db.prepare(`
      SELECT
        r.id,
        r.workflow_id,
        r.task,
        r.status,
        r.context,
        r.created_at,
        r.updated_at,
        r.run_number,
        r.tokens_spent,
        COUNT(s.id) AS total_steps,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS completed_steps,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed_steps,
        SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running_steps,
        SUM(CASE WHEN s.status = 'waiting' THEN 1 ELSE 0 END) AS waiting_steps
      FROM runs r
      LEFT JOIN steps s ON s.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>;

    const runs = rawRuns.map((row) => {
      let no_hurry = false;
      try {
        const ctx = JSON.parse(String(row.context ?? "{}"));
        no_hurry = ctx.no_hurry_save_tokens_mode === "true";
      } catch {
        // malformed context → no_hurry stays false
      }
      return { ...row, no_hurry };
    });

    jsonResponse(res, { runs });
  } catch (err) {
    errorResponse(res, `Failed to list runs: ${(err as Error).message}`);
  }
}

function handleRunDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const db = getDb();

    const run = db.prepare(`
      SELECT id, workflow_id, task, status, context, created_at, updated_at, run_number, tokens_spent
      FROM runs WHERE id = ?
    `).get(runId);

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const steps = db.prepare(`
      SELECT id, step_id, agent_id, step_index, status, output,
             retry_count, max_retries, type, created_at, updated_at
      FROM steps WHERE run_id = ?
      ORDER BY step_index ASC
    `).all(runId);

    const events = getRunEvents(runId);

    // Derive failure_reason from existing data (no new DB column)
    let failure_reason: string | null = null;
    const runStatus = (run as { status: string }).status;
    if (runStatus === "failed") {
      const failedStep = (steps as Array<{ status: string; output?: string | null }>).find(
        (s) => s.status === "failed",
      );
      failure_reason = failedStep?.output || "Run failed";
    } else if (runStatus === "canceled") {
      failure_reason = "Canceled";
    }

    // Enrich with worktree information
    let worktree: unknown = null;
    try {
      const ctx = JSON.parse((run as { context?: string }).context ?? "{}") as Record<string, string>;
      if (ctx.workspace_mode === "worktree") {
        worktree = db
          .prepare(
            "SELECT worktree_path, worktree_origin_repository, worktree_origin_ref, worktree_origin_sha, status AS wt_status, cleanup_policy FROM run_worktrees WHERE run_id = ?",
          )
          .get(runId) ?? null;
      }
    } catch {
      // context may be malformed
    }

    jsonResponse(res, { run, steps, events, worktree, failure_reason, prompt: (run as { task: string }).task });
  } catch (err) {
    errorResponse(res, `Failed to get run detail: ${(err as Error).message}`);
  }
}

function handleRunKanbanCardDetail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cardId = url.searchParams.get("cardId")?.trim();

    if (!cardId) {
      errorResponse(res, "Missing required query parameter: cardId", 400);
      return;
    }

    const db = getDb();
    const events = getRunEvents(runId);
    const detail = buildKanbanCardDetail(db, runId, cardId, events);

    if (!detail) {
      errorResponse(res, `Card not found: ${cardId} in run ${runId}`, 404);
      return;
    }

    jsonResponse(res, detail);
  } catch (err) {
    errorResponse(res, `Failed to build card detail: ${(err as Error).message}`);
  }
}

function handleRunKanban(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const snapshot = buildKanbanSnapshot(getDb(), runId);
    if (!snapshot) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }
    jsonResponse(res, snapshot);
  } catch (err) {
    errorResponse(res, `Failed to build kanban snapshot: ${(err as Error).message}`);
  }
}

function handleRunAutoresearch(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): void {
  try {
    const db = getDb();
    const run = db.prepare(`
      SELECT id, workflow_id, task, status, context, created_at, updated_at
      FROM runs WHERE id = ?
    `).get(runId) as
      | { id: string; workflow_id: string; task: string; status: string; context?: string | null; created_at: string; updated_at: string }
      | undefined;

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const cwd = resolveRunHarnessCwd(run);
    if (!cwd) {
      jsonResponse(res, {
        exists: false,
        run,
        reason: "Run has no working_directory_for_harness in its context.",
      });
      return;
    }

    const autoresearchCwd = findAutoresearchSessionCwd(cwd) ?? cwd;
    const summary = summarizeAutoresearch(autoresearchCwd);
    if (!summary.exists) {
      jsonResponse(res, {
        exists: false,
        run,
        cwd,
        reason: summary.nextPrompt,
      });
      return;
    }

    const entries = readAutoresearchLog(autoresearchCwd);
    const results = entries.filter((entry): entry is AutoresearchRunResultEntry => entry.type === "run_result");
    jsonResponse(res, {
      exists: true,
      run,
      cwd: autoresearchCwd,
      harnessCwd: cwd,
      summary,
      experiments: buildAutoresearchExperiments(entries),
      pendingResults: results.filter((result) => !entries.some((entry) => entry.type === "run" && entry.run === result.run)),
      entries: entries.slice(-100),
    });
  } catch (err) {
    errorResponse(res, `Failed to get AutoResearch progress: ${(err as Error).message}`);
  }
}

function handleAutoresearchRuns(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();

    const rawRuns = db.prepare(`
      SELECT
        r.id,
        r.workflow_id,
        r.task,
        r.status,
        r.context,
        r.created_at,
        r.updated_at,
        r.run_number,
        r.tokens_spent,
        COUNT(s.id) AS total_steps,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS completed_steps,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed_steps,
        SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running_steps,
        SUM(CASE WHEN s.status = 'waiting' THEN 1 ELSE 0 END) AS waiting_steps
      FROM runs r
      LEFT JOIN steps s ON s.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>;

    const filtered = rawRuns.filter((row) => {
      const cwd = resolveRunHarnessCwd({ context: row.context as string | null | undefined });
      if (!cwd) return false;
      try {
        const sessionCwd = findAutoresearchSessionCwd(cwd);
        return !!sessionCwd;
      } catch {
        return false;
      }
    });

    const runs = filtered.map((row) => {
      let no_hurry = false;
      try {
        const ctx = JSON.parse(String(row.context ?? "{}"));
        no_hurry = ctx.no_hurry_save_tokens_mode === "true";
      } catch {
        // malformed context → no_hurry stays false
      }
      return { ...row, no_hurry };
    });

    console.log(`[dashboard] GET /api/autoresearch/runs → ${runs.length} of ${rawRuns.length} total runs have AutoResearch state`);
    jsonResponse(res, { runs });
  } catch (err) {
    errorResponse(res, `Failed to list AutoResearch runs: ${(err as Error).message}`);
  }
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const events = getRecentEvents(Math.min(limit, 500));
    jsonResponse(res, { events });
  } catch (err) {
    errorResponse(res, `Failed to get events: ${(err as Error).message}`);
  }
}

function handleLogsTail(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const offsetParam = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const offset = Number.isFinite(offsetParam) ? offsetParam : 0;
    const runId = url.searchParams.get("runId")?.trim();

    const source: EventCursorSource = runId
      ? { kind: "run", runId }
      : { kind: "global" };

    const { events, nextOffset } = readEventsFromCursor(source, offset);
    const lines = formatLogsTailLines(events);

    jsonResponse(res, { lines, nextOffset });
  } catch (err) {
    errorResponse(res, `Failed to get logs-tail events: ${(err as Error).message}`);
  }
}

function handleStats(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();
    const systemTokensSpent = getSystemTokenSpend();

    let runTokensSpent = 0;
    try {
      const row = db.prepare("SELECT COALESCE(SUM(tokens_spent), 0) AS total FROM runs").get() as { total: number } | undefined;
      runTokensSpent = row?.total ?? 0;
    } catch {
      // runs table may not exist yet
      runTokensSpent = 0;
    }

    jsonResponse(res, {
      systemTokensSpent,
      totalTokensSpent: systemTokensSpent + runTokensSpent,
    });
  } catch (err) {
    errorResponse(res, `Failed to get stats: ${(err as Error).message}`);
  }
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const db = getDb();
    // Quick health check: can we query the DB?
    db.prepare("SELECT 1").get();
    jsonResponse(res, {
      status: "ok",
      uptime: process.uptime(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    errorResponse(res, `Health check failed: ${(err as Error).message}`, 503);
  }
}

// ── AutoResearch Session API Handlers ──────────────────────────────

function handleAutoresearchSessions(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const sessions = getAutoresearchSessions();
    const enriched = sessions.map((s) => {
      const summary = summarizeAutoresearch(s.cwd);
      return {
        id: s.id,
        cwd: s.cwd,
        goal: s.goal,
        metric_name: s.metric_name,
        metric_unit: s.metric_unit,
        direction: s.direction,
        command: s.command,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_seen_at: s.last_seen_at,
        last_run_at: s.last_run_at,
        total_runs: s.total_runs,
        baseline_metric: s.baseline_metric,
        best_metric: s.best_metric,
        best_run: s.best_run,
        files_missing: s.files_missing,
        summary: summary.exists ? summary : undefined,
      };
    });

    console.log(`[dashboard] GET /api/autoresearch/sessions → ${sessions.length} sessions`);
    jsonResponse(res, { sessions: enriched });
  } catch (err) {
    errorResponse(res, `Failed to list AutoResearch sessions: ${(err as Error).message}`);
  }
}

function handleAutoresearchSessionById(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
): void {
  try {
    const session = getAutoresearchSessionById(sessionId);
    if (!session) {
      errorResponse(res, `Session not found: ${sessionId}`, 404);
      return;
    }

    const cwd = session.cwd;
    const summary = summarizeAutoresearch(cwd);
    const entries = summary.exists ? readAutoresearchLog(cwd) : [];
    const results = entries.filter(
      (entry): entry is AutoresearchRunResultEntry => entry.type === "run_result",
    );

    jsonResponse(res, {
      session,
      exists: summary.exists,
      reason: summary.nextPrompt,
      summary,
      experiments: summary.exists ? buildAutoresearchExperiments(entries) : [],
      pendingResults: results.filter(
        (result) => !entries.some((entry) => entry.type === "run" && entry.run === result.run),
      ),
      entries: entries.slice(-100),
    });
  } catch (err) {
    errorResponse(res, `Failed to get AutoResearch session: ${(err as Error).message}`);
  }
}

// ── Backfill ────────────────────────────────────────────────────────

export function backfillAutoresearchSessions(): void {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT context FROM runs
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as Array<{ context: string }>;

    const seen = new Set<string>();
    let backfilled = 0;

    for (const row of rows) {
      const cwd = resolveRunHarnessCwd({ context: row.context });
      if (!cwd) continue;
      try {
        const sessionCwd = findAutoresearchSessionCwd(cwd);
        if (!sessionCwd || seen.has(sessionCwd)) continue;
        seen.add(sessionCwd);

        // Only upsert if the cwd isn't already tracked
        const sessionId = fs.existsSync(sessionCwd)
          ? (() => { try { return fs.realpathSync(sessionCwd); } catch { return path.resolve(sessionCwd); } })()
          : path.resolve(sessionCwd);
        const existing = getAutoresearchSessionById(sessionId);
        if (!existing) {
          upsertAutoresearchSession(sessionCwd);
          backfilled++;
        }
      } catch {
        // Skip malformed or inaccessible cwds
      }
    }

    if (backfilled > 0) {
      console.log(`[dashboard] backfill: inserted ${backfilled} missing AutoResearch sessions from recent runs`);
    }
  } catch (err) {
    console.error(`[dashboard] backfill error: ${(err as Error).message}`);
  }
}

async function handlePauseRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();

    // Parse drain query parameter
    const url = new URL(req.url ?? "/", "http://localhost");
    const drain = url.searchParams.get("drain") === "true";

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "running") {
      errorResponse(
        res,
        `Cannot pause run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await pauseRunWithDaemon(runId, drain);

    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }

    if (result.status === 200 || result.status === 202) {
      jsonResponse(res, { paused: true, runId });
      return;
    }

    // Forward daemon error
    errorResponse(
      res,
      (result.body.error as string) ?? "Failed to pause run",
      result.status >= 400 ? result.status : 500,
    );
  } catch (err) {
    errorResponse(res, `Failed to pause run: ${(err as Error).message}`);
  }
}

async function handleResumeRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "paused") {
      errorResponse(
        res,
        `Cannot resume run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await resumeRunWithDaemon(runId);

    if (result === null) {
      errorResponse(res, "Daemon unreachable", 502);
      return;
    }

    if (result.status === 200 || result.status === 202) {
      jsonResponse(res, { resumed: true, runId });
      return;
    }

    // Forward daemon error
    errorResponse(
      res,
      (result.body.error as string) ?? "Failed to resume run",
      result.status >= 400 ? result.status : 500,
    );
  } catch (err) {
    errorResponse(res, `Failed to resume run: ${(err as Error).message}`);
  }
}

async function handleCancelRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();

    const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
      | undefined;

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "running" && run.status !== "paused") {
      errorResponse(
        res,
        `Cannot cancel run in ${run.status} state`,
        409,
      );
      return;
    }

    const result = await stopWorkflow(runId);

    if (result.ok) {
      jsonResponse(res, { canceled: true, runId });
      return;
    }

    errorResponse(res, "Failed to cancel run", 500);
  } catch (err) {
    errorResponse(res, `Failed to cancel run: ${(err as Error).message}`);
  }
}

async function handleDeleteRun(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const url = new URL(_req.url ?? "/", "http://localhost");
    const force = url.searchParams.get("force") === "true";

    // Resolve prefix/id to full run ID
    let fullRunId: string;
    try {
      fullRunId = getWorkflowStatus(runId).id;
    } catch {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    const result = await deleteWorkflow(fullRunId, { force });
    jsonResponse(res, result);
  } catch (err) {
    const message = (err as Error).message;
    const status = message.includes("Use --force") ? 409 : 500;
    errorResponse(res, message, status);
  }
}

async function handleRelaunchRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();

    const run = db.prepare(
      "SELECT id, workflow_id, task, status, context, notify_url FROM runs WHERE id = ?",
    ).get(runId) as
      | { id: string; workflow_id: string; task: string; status: string; context: string; notify_url: string | null }
      | undefined;

    if (!run) {
      errorResponse(res, `Run not found: ${runId}`, 404);
      return;
    }

    if (run.status !== "failed" && run.status !== "canceled") {
      errorResponse(
        res,
        `Cannot relaunch run in ${run.status} state. Only failed or canceled runs can be relaunched.`,
        409,
      );
      return;
    }

    // Parse request body for optional task override
    const body = await parseBody(req);
    let taskOverride: string | undefined;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { task?: string };
        taskOverride = parsed.task?.trim() || undefined;
      } catch {
        errorResponse(res, "Invalid JSON body", 400);
        return;
      }
    }

    const taskTitle = taskOverride ?? run.task;

    // Parse original context to extract workspace settings
    let originalContext: Record<string, string> = {};
    try {
      originalContext = JSON.parse(run.context) as Record<string, string>;
    } catch {
      // context may be malformed — proceed with empty context
    }

    const workspaceMode = originalContext.workspace_mode ?? "direct";

    if (workspaceMode === "worktree") {
      const relaunched = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle,
        notifyUrl: run.notify_url ?? undefined,
        worktreeOriginRepository: originalContext.worktree_origin_repository,
        worktreeOriginRef: originalContext.worktree_origin_ref,
      });

      jsonResponse(res, {
        relaunched: true,
        originalRunId: runId,
        runId: relaunched.runId,
        runNumber: relaunched.runNumber,
      });
    } else {
      const relaunched = await runWorkflow({
        workflowId: run.workflow_id,
        taskTitle,
        notifyUrl: run.notify_url ?? undefined,
        workingDirectoryForHarness: originalContext.working_directory_for_harness,
      });

      jsonResponse(res, {
        relaunched: true,
        originalRunId: runId,
        runId: relaunched.runId,
        runNumber: relaunched.runNumber,
      });
    }
  } catch (err) {
    errorResponse(res, `Failed to relaunch run: ${(err as Error).message}`);
  }
}

function handleVersion(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const version = getBuildVersion();
    jsonResponse(res, { version });
  } catch (err) {
    errorResponse(res, `Failed to read build version: ${(err as Error).message}`);
  }
}

function handleVersionStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const status = readVersionStatus();
    jsonResponse(res, status);
  } catch (err) {
    errorResponse(res, `Failed to read version status: ${(err as Error).message}`);
  }
}

function handleMcpStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const status = getMcpStatus();
    jsonResponse(res, {
      running: status.running,
      port: status.port,
      path: status.endpoint,
    });
  } catch (err) {
    errorResponse(res, `Failed to get MCP status: ${(err as Error).message}`);
  }
}

// ── Router ───────────────────────────────────────────────────────────

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Parse URL path (strip query string)
  const pathname = url.split("?")[0];

  // GET /
  if (method === "GET" && pathname === "/") {
    try {
      const html = fs.readFileSync(INDEX_HTML, "utf-8");
      htmlResponse(res, html);
    } catch {
      htmlResponse(res, `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Tamandua Dashboard</title></head>
<body><h1>Tamandua Dashboard</h1><p>Dashboard HTML not found. Rebuild tamandua or check dist/server/index.html.</p></body>
</html>`, 200);
    }
    return;
  }

  // GET /runs/:id/kanban
  const kanbanHtmlMatch = pathname.match(/^\/runs\/([a-zA-Z0-9_-]+)\/kanban$/);
  if (method === "GET" && kanbanHtmlMatch) {
    try {
      const html = fs.readFileSync(KANBAN_HTML, "utf-8");
      htmlResponse(res, html);
    } catch {
      htmlResponse(res, `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Tamandua Kanban</title></head>
<body><h1>Tamandua Kanban</h1><p>Kanban HTML not found. Rebuild tamandua or check dist/server/kanban.html.</p></body>
</html>`, 200);
    }
    return;
  }

  // GET /api/runs/:id/kanban/card-detail (registered before /api/runs/:id/kanban and /api/runs/:id)
  const cardDetailMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/kanban\/card-detail$/);
  if (method === "GET" && cardDetailMatch) {
    handleRunKanbanCardDetail(req, res, cardDetailMatch[1]);
    return;
  }

  // GET /api/runs/:id/kanban (registered before /api/runs/:id below)
  const kanbanApiMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/kanban$/);
  if (method === "GET" && kanbanApiMatch) {
    handleRunKanban(req, res, kanbanApiMatch[1]);
    return;
  }

  // GET /api/runs/:id/autoresearch (registered before /api/runs/:id below)
  const autoresearchApiMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/autoresearch$/);
  if (method === "GET" && autoresearchApiMatch) {
    handleRunAutoresearch(req, res, autoresearchApiMatch[1]);
    return;
  }

  // GET /api/stats
  if (method === "GET" && pathname === "/api/stats") {
    handleStats(req, res);
    return;
  }

  // GET /api/health
  if (method === "GET" && pathname === "/api/health") {
    handleHealth(req, res);
    return;
  }

  // GET /api/autoresearch/sessions/:id (registered before /api/autoresearch/sessions to avoid prefix conflict)
  const sessionIdMatch = pathname.match(/^\/api\/autoresearch\/sessions\/([a-zA-Z0-9_\/.%~-]+)$/);
  if (method === "GET" && sessionIdMatch) {
    handleAutoresearchSessionById(req, res, decodeURIComponent(sessionIdMatch[1]));
    return;
  }

  // GET /api/autoresearch/sessions (registered before /api/autoresearch/runs)
  if (method === "GET" && pathname === "/api/autoresearch/sessions") {
    handleAutoresearchSessions(req, res);
    return;
  }

  // GET /api/autoresearch/runs (registered before /api/runs to avoid route conflict)
  if (method === "GET" && pathname === "/api/autoresearch/runs") {
    handleAutoresearchRuns(req, res);
    return;
  }

  // GET /api/runs
  if (method === "GET" && pathname === "/api/runs") {
    handleListRuns(req, res);
    return;
  }

  // GET /api/runs/:id
  const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
  if (method === "GET" && runMatch) {
    handleRunDetail(req, res, runMatch[1]);
    return;
  }

  // GET /api/events
  if (method === "GET" && pathname === "/api/events") {
    handleEvents(req, res);
    return;
  }

  // GET /api/logs-tail
  if (method === "GET" && pathname === "/api/logs-tail") {
    handleLogsTail(req, res);
    return;
  }

  // GET /api/version (registered before /api/version-status to avoid prefix conflict)
  if (method === "GET" && pathname === "/api/version") {
    handleVersion(req, res);
    return;
  }

  // GET /api/version-status
  if (method === "GET" && pathname === "/api/version-status") {
    handleVersionStatus(req, res);
    return;
  }

  // GET /api/mcp-status
  if (method === "GET" && pathname === "/api/mcp-status") {
    handleMcpStatus(req, res);
    return;
  }

  // POST /api/runs/:id/pause
  const pauseMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/pause$/);
  if (method === "POST" && pauseMatch) {
    handlePauseRun(req, res, pauseMatch[1]);
    return;
  }

  // POST /api/runs/:id/resume
  const resumeMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/resume$/);
  if (method === "POST" && resumeMatch) {
    handleResumeRun(req, res, resumeMatch[1]);
    return;
  }

  // POST /api/runs/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    handleCancelRun(req, res, cancelMatch[1]);
    return;
  }

  // DELETE /api/runs/:id (registered before POST /api/runs/:id/* to avoid prefix conflict)
  const deleteMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
  if (method === "DELETE" && deleteMatch) {
    handleDeleteRun(req, res, deleteMatch[1]);
    return;
  }

  // POST /api/runs/:id/relaunch
  const relaunchMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/relaunch$/);
  if (method === "POST" && relaunchMatch) {
    handleRelaunchRun(req, res, relaunchMatch[1]);
    return;
  }

  // 404
  errorResponse(res, `Not found: ${method} ${pathname}`, 404);
}

// ── Create Server ────────────────────────────────────────────────────

export interface DashboardServerOptions {
  onError?: (err: NodeJS.ErrnoException) => void;
}

export function createDashboardServer(port: number, options: DashboardServerOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      console.error("Unhandled dashboard error:", err);
      if (!res.headersSent) {
        errorResponse(res, "Internal server error", 500);
      }
    }
  });

  server.listen(port, () => {
    console.log(`Tamandua dashboard listening on http://localhost:${port}`);
    // Backfill AutoResearch sessions from recent workflow runs
    backfillAutoresearchSessions();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Is another daemon running?`);
    } else {
      console.error("Dashboard server error:", err);
    }

    if (options.onError) {
      options.onError(err);
      return;
    }

    process.exit(1);
  });

  return server;
}
