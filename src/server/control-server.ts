/**
 * Tamandua Daemon Control Plane
 *
 * Provides idempotent HTTP endpoints for run-scoped scheduling. Bound to a
 * separate localhost port (default 3339; overridable via TAMANDUA_CONTROL_PORT).
 *
 * Endpoints:
 *   GET  /control/health          – liveness
 *   GET  /control/jobs            – currently scheduled jobs
 *   GET  /control/limits          – effective MAX_ACTIVE_TIMERS
 *   POST /control/register-run    – admit a run for scheduling
 *   POST /control/terminate-run   – tear down a run's scheduling
 *   POST /control/pause-run       – pause a run (clear timers, set paused)
 *   POST /control/resume-run      – resume a paused run
 *   POST /control/nudge           – nudge all scheduled agents for running runs
 *
 * Authentication: header `x-tamandua-secret: <token>` matches the token in
 * `~/.tamandua/daemon-secret` (mode 0600). Localhost-only binding is the
 * primary defense; the secret is a defense-in-depth measure.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { getBuildVersion } from "../lib/version.js";
import { assertPortIsolation, assertStatePathIsolation, testGuardActive } from "../lib/test-guard.js";
import { getDb } from "../db.js";
import { emitEvent } from "../installer/events.js";
import type { TamanduaEvent } from "../installer/events.js";
import { validateRunHarnessForScheduling } from "../installer/run-harness.js";
import { parseRunContext } from "../installer/step-ops.js";

export const DEFAULT_CONTROL_PORT = 3339;
const DEFAULT_MAX_ACTIVE_TIMERS = 50;

// Read at module load so dist/version is sampled once at daemon startup,
// not on every health request.
const buildVersion = getBuildVersion();

function defaultDaemonSecretFile(): string {
  return path.join(process.env.HOME?.trim() || os.homedir(), ".tamandua", "daemon-secret");
}

export function getControlPort(): number {
  const raw = process.env.TAMANDUA_CONTROL_PORT;
  if (!raw) return DEFAULT_CONTROL_PORT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_CONTROL_PORT;
  return n;
}

export function getMaxActiveTimers(): number {
  const raw = process.env.TAMANDUA_MAX_ACTIVE_TIMERS;
  if (!raw) return DEFAULT_MAX_ACTIVE_TIMERS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ACTIVE_TIMERS;
  return n;
}

/** Race-safe secret creation. The first process to create the file wins. */
export function ensureDaemonSecret(secretPath: string = defaultDaemonSecretFile()): string {
  if (testGuardActive()) {
    assertStatePathIsolation(secretPath, "ensureDaemonSecret()");
  }
  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fs.readFileSync(secretPath, "utf-8").trim();
  } catch {
    // Fall through to creation
  }
  const token = crypto.randomBytes(32).toString("hex");
  let fd: number | null = null;
  try {
    fd = fs.openSync(secretPath, "wx", 0o600);
    fs.writeFileSync(fd, token);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
    throw err;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    /* best-effort */
  }
  return token;
}

export function readDaemonSecret(secretPath: string = defaultDaemonSecretFile()): string | null {
  if (testGuardActive()) {
    try {
      assertStatePathIsolation(secretPath, "readDaemonSecret()");
    } catch {
      return null;
    }
  }
  try {
    const value = fs.readFileSync(secretPath, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function ok(body: Record<string, unknown> = {}, status = 200): JsonResponse {
  return { status, body };
}

function notFound(message: string): JsonResponse {
  return { status: 404, body: { error: message } };
}

function conflict(message: string): JsonResponse {
  return { status: 409, body: { error: message } };
}

function unprocessable(message: string): JsonResponse {
  return { status: 422, body: { error: message } };
}

export interface RunRow {
  id: string;
  workflow_id: string;
  status: string;
  scheduling_status: string | null;
  context: string;
  created_at?: string;
}

function getRun(runId: string): RunRow | null {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT id, workflow_id, status, scheduling_status, context, created_at FROM runs WHERE id = ?",
      )
      .get(runId) as RunRow | undefined;
    return row ?? null;
  } catch (err) {
    logger.warn("control-server: getRun failed", { runId, error: String(err) });
    return null;
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function requiredTimersForRun(runId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(DISTINCT agent_id) AS cnt FROM steps WHERE run_id = ?")
    .get(runId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

async function admitOrQueueRun(run: RunRow): Promise<JsonResponse> {
  const requiredTimers = requiredTimersForRun(run.id);
  const maxActiveTimers = getMaxActiveTimers();

  const {
    _scheduledJobCount,
    _scheduledJobCountForRun,
    _runIdForScheduledHarnessWorkdir,
    removeRunCrons,
    setupAgentCrons,
  } = await import("../installer/agent-scheduler.js");

  const harness = await validateRunHarnessForScheduling(run.id, run.context);

  const contextParsed = parseRunContext(run.id, run.context);
  const isSaveTokensMode = contextParsed.no_hurry_save_tokens_mode === 'true';

  const duplicateRunId = _runIdForScheduledHarnessWorkdir(
    harness.workingDirectoryForHarness,
    run.id,
  );
  if (duplicateRunId && process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR !== "1") {
    throw new Error(
      `Run ${run.id} harness workdir is already scheduled for run ${duplicateRunId}: ${harness.workingDirectoryForHarness}`,
    );
  }

  const existingForRun = _scheduledJobCountForRun(run.id);
  if (requiredTimers > 0 && existingForRun >= requiredTimers) {
    getDb()
      .prepare(
        "UPDATE runs SET scheduling_status = 'active', scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
      )
      .run(run.id);
    return ok({ state: "active", requiredTimers, maxActiveTimers });
  }

  if (existingForRun > 0 && existingForRun < requiredTimers) {
    await removeRunCrons(run.id);
  }

  if (requiredTimers > maxActiveTimers) {
    const message =
      `Run requires ${requiredTimers} scheduler timer(s), but TAMANDUA_MAX_ACTIVE_TIMERS is ${maxActiveTimers}.`;
    getDb()
      .prepare(
        "UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(message, run.id);
    logger.error("control-server: register-run unschedulable", {
      runId: run.id,
      requiredTimers,
      maxActiveTimers,
    });
    return unprocessable(message);
  }

  const freeSlots = maxActiveTimers - _scheduledJobCount();
  if (requiredTimers > freeSlots) {
    getDb()
      .prepare(
        `UPDATE runs
         SET scheduling_status = 'queued',
             scheduling_requested_at = COALESCE(scheduling_requested_at, ?),
             scheduling_error = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), run.id);
    logger.info("control-server: register-run queued", {
      runId: run.id,
      requiredTimers,
      freeSlots,
      maxActiveTimers,
    });
    return ok({ state: "queued", requiredTimers, freeSlots, maxActiveTimers }, 202);
  }

  const { loadWorkflowSpec } = await import("../installer/workflow-spec.js");
  const { resolveWorkflowDir } = await import("../installer/paths.js");
  const workflow = await loadWorkflowSpec(resolveWorkflowDir(run.workflow_id));

  try {
    await setupAgentCrons(workflow, run.id, {
      workingDirectoryForHarness: harness.workingDirectoryForHarness,
      noHurrySaveTokensMode: isSaveTokensMode,
    });
    const scheduledForRun = _scheduledJobCountForRun(run.id);
    if (scheduledForRun < requiredTimers) {
      await removeRunCrons(run.id);
      throw new Error(
        `Only scheduled ${scheduledForRun}/${requiredTimers} timer(s) for run ${run.id}.`,
      );
    }
  } catch (err) {
    await removeRunCrons(run.id);
    throw err;
  }

  getDb()
    .prepare(
      "UPDATE runs SET scheduling_status = 'active', scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
    )
    .run(run.id);

  logger.info("control-server: register-run admitted", { runId: run.id, requiredTimers });
  return ok({ state: "active", requiredTimers, maxActiveTimers }, 202);
}

async function admitQueuedRuns(): Promise<void> {
  const db = getDb();
  const queued = db
    .prepare(
      `SELECT id, workflow_id, status, scheduling_status, context, created_at
       FROM runs
       WHERE status = 'running' AND scheduling_status = 'queued'
       ORDER BY scheduling_requested_at ASC, created_at ASC`,
    )
    .all() as unknown as RunRow[];

  for (const run of queued) {
    const result = await admitOrQueueRun(run).catch((err) => {
      logger.warn("control-server: queued admission failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (!result) continue;
    if (result.body.state === "queued") break;
  }
}

// ── TSTX suite endpoints ──────────────────────────────────────────────

import { FLAKE_WINDOW_MS, CLAIM_TIMEOUT_MS } from "../suite/config.js";

interface SuiteClaim {
  claimedAt: number;
}

const suiteClaims = new Map<string, SuiteClaim>();

function suiteClaimKey(originRepo: string, treeHash: string, cmdHash: string): string {
  return `${originRepo}:${treeHash}:${cmdHash}`;
}

function cleanStaleClaims(): void {
  const now = Date.now();
  for (const [key, claim] of suiteClaims) {
    if (now - claim.claimedAt > CLAIM_TIMEOUT_MS) {
      suiteClaims.delete(key);
    }
  }
}

async function handleSuiteLookup(url: string): Promise<JsonResponse> {
  const parsed = new URL(url, "http://localhost");
  const originRepo = parsed.searchParams.get("origin_repo");
  const treeHash = parsed.searchParams.get("tree_hash");
  const cmdHash = parsed.searchParams.get("cmd_hash");

  if (!originRepo || !treeHash || !cmdHash) {
    return { status: 400, body: { error: "Missing required query params: origin_repo, tree_hash, cmd_hash" } };
  }

  try {
    const db = getDb();
    const flakeCutoff = new Date(Date.now() - FLAKE_WINDOW_MS).toISOString();

    const latest = db.prepare(
      `SELECT id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at
       FROM suite_results
       WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(originRepo, treeHash, cmdHash) as Record<string, unknown> | undefined;

    const passCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM suite_results
       WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ? AND exit_code = 0 AND created_at >= ?`,
    ).get(originRepo, treeHash, cmdHash, flakeCutoff) as { cnt: number }).cnt;

    const failCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM suite_results
       WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ? AND exit_code != 0 AND created_at >= ?`,
    ).get(originRepo, treeHash, cmdHash, flakeCutoff) as { cnt: number }).cnt;

    return ok({
      latest: latest ?? null,
      passCount,
      failCount,
      flaky: passCount > 0 && failCount > 0,
    });
  } catch (err) {
    logger.warn("control-server: suite lookup failed", { error: String(err) });
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleSuiteRecord(body: Record<string, unknown>): Promise<JsonResponse> {
  const originRepo = typeof body.origin_repo === "string" ? body.origin_repo : "";
  const treeHash = typeof body.tree_hash === "string" ? body.tree_hash : "";
  const cmdHash = typeof body.cmd_hash === "string" ? body.cmd_hash : "";
  const cmdDisplay = typeof body.cmd_display === "string" ? body.cmd_display : "";
  const exitCode = typeof body.exit_code === "number" ? body.exit_code : null;
  const durationMs = typeof body.duration_ms === "number" ? body.duration_ms : null;
  const logTail = typeof body.log_tail === "string" ? body.log_tail : null;
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  const stepId = typeof body.step_id === "string" ? body.step_id : null;

  if (!originRepo || !treeHash || !cmdHash || !cmdDisplay || exitCode === null || durationMs === null) {
    return { status: 400, body: { error: "Missing required fields: origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms" } };
  }

  try {
    const db = getDb();
    const created_at = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(originRepo, treeHash, cmdHash, cmdDisplay, exitCode, durationMs, logTail, runId, stepId, created_at);

    // Emit suite.executed event for observability (US-009).
    const eventRunId = runId || "";
    emitEvent({
      ts: created_at,
      event: "suite.executed",
      runId: eventRunId,
      stepId: stepId || undefined,
      treeHash,
      cmdDisplay,
      durationMs,
      exitCode,
    });

    // Clear any pending claim so waiters can pick up the result.
    const claimKey = suiteClaimKey(originRepo, treeHash, cmdHash);
    suiteClaims.delete(claimKey);

    return ok({ id: Number(result.lastInsertRowid), created_at });
  } catch (err) {
    logger.warn("control-server: suite record failed", { error: String(err) });
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleSuiteClaim(body: Record<string, unknown>): Promise<JsonResponse> {
  const originRepo = typeof body.origin_repo === "string" ? body.origin_repo : "";
  const treeHash = typeof body.tree_hash === "string" ? body.tree_hash : "";
  const cmdHash = typeof body.cmd_hash === "string" ? body.cmd_hash : "";

  if (!originRepo || !treeHash || !cmdHash) {
    return { status: 400, body: { error: "Missing required fields: origin_repo, tree_hash, cmd_hash" } };
  }

  cleanStaleClaims();

  const key = suiteClaimKey(originRepo, treeHash, cmdHash);
  const existing = suiteClaims.get(key);

  if (existing) {
    return ok({ action: "wait", claimedAt: new Date(existing.claimedAt).toISOString() });
  }

  suiteClaims.set(key, { claimedAt: Date.now() });
  return ok({ action: "run" });
}

async function handleSuiteEvent(body: Record<string, unknown>): Promise<JsonResponse> {
  const event = typeof body.event === "string" ? body.event : "";
  if (!event) {
    return { status: 400, body: { error: "Missing required field: event" } };
  }

  const runId = typeof body.run_id === "string" ? body.run_id : "";
  const stepId = typeof body.step_id === "string" ? body.step_id : undefined;

  // Build a TamanduaEvent with only the fields that are present.
  const evt: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    runId,
  };
  if (stepId) evt.stepId = stepId;
  if (typeof body.tree_hash === "string") evt.treeHash = body.tree_hash;
  if (typeof body.cmd_display === "string") evt.cmdDisplay = body.cmd_display;
  if (typeof body.cmd_hash === "string") evt.cmdHash = body.cmd_hash;
  if (typeof body.saved_duration_ms === "number") evt.savedDurationMs = body.saved_duration_ms;
  if (typeof body.duration_ms === "number") evt.durationMs = body.duration_ms;
  if (typeof body.exit_code === "number") evt.exitCode = body.exit_code;
  if (typeof body.pass_count === "number") evt.passCount = body.pass_count;
  if (typeof body.fail_count === "number") evt.failCount = body.fail_count;
  if (typeof body.window === "string") evt.window = body.window;
  if (typeof body.waited_ms === "number") evt.waitedMs = body.waited_ms;

  try {
    emitEvent(evt as unknown as TamanduaEvent);
    return ok({});
  } catch (err) {
    logger.warn("control-server: suite event emission failed", { event, error: String(err) });
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleSuiteFlaky(url: string): Promise<JsonResponse> {
  const parsed = new URL(url, "http://localhost");
  const originRepo = parsed.searchParams.get("origin_repo");

  if (!originRepo) {
    return { status: 400, body: { error: "Missing required query param: origin_repo" } };
  }

  try {
    const db = getDb();
    const flakeCutoff = new Date(Date.now() - FLAKE_WINDOW_MS).toISOString();

    // Find keys that have both pass (exit_code=0) and fail (exit_code!=0) within the window.
    const rows = db.prepare(
      `SELECT tree_hash, cmd_hash, cmd_display,
              SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as pass_count,
              SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) as fail_count
       FROM suite_results
       WHERE origin_repo = ? AND created_at >= ?
       GROUP BY tree_hash, cmd_hash
       HAVING pass_count > 0 AND fail_count > 0
       ORDER BY (pass_count + fail_count) DESC`,
    ).all(originRepo, flakeCutoff) as Array<Record<string, unknown>>;

    return ok({ flaky_keys: rows });
  } catch (err) {
    logger.warn("control-server: suite flaky query failed", { error: String(err) });
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

// ── Run scheduling handlers ──────────────────────────────────────────

async function handleRegisterRun(runId: string): Promise<JsonResponse> {
  const run = getRun(runId);
  if (!run) return notFound(`Run not found: ${runId}`);
  if (isTerminal(run.status)) return conflict(`Run is terminal: ${run.status}`);
  if (run.status === "paused" || run.scheduling_status === "paused") {
    return ok({ state: "paused" });
  }
  if (run.scheduling_status === "active") {
    const { _scheduledJobCountForRun } = await import("../installer/agent-scheduler.js");
    if (_scheduledJobCountForRun(run.id) >= requiredTimersForRun(run.id)) {
      return ok({ state: "active" });
    }
  }

  // pending_register / null / error → attempt admission
  try {
    return await admitOrQueueRun(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      getDb()
        .prepare(
          "UPDATE runs SET scheduling_status = 'error', scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(message, runId);
    } catch {
      /* best-effort */
    }
    logger.error("control-server: register-run failed", { runId, error: message });
    return unprocessable(`Failed to register run: ${message}`);
  }
}

async function handleTerminateRun(runId: string): Promise<JsonResponse> {
  const run = getRun(runId);
  if (!run) return notFound(`Run not found: ${runId}`);

  try {
    const { removeRunCrons, HARNESS_TEARDOWN_GRACE_MS } = await import(
      "../installer/agent-scheduler.js"
    );
    // Terminate-run is called both for user-initiated termination of an
    // ACTIVE run (kill in-flight work immediately) and as cleanup after a
    // run reached a terminal state on its own (the harness that reported
    // the final step is still flushing its output — give it the grace
    // window so the final round's token usage is not lost).
    const graceMs = isTerminal(run.status) ? HARNESS_TEARDOWN_GRACE_MS : 0;
    await removeRunCrons(runId, { graceMs });
  } catch (err) {
    logger.warn("control-server: removeRunCrons threw", { runId, error: String(err) });
  }

  try {
    getDb()
      .prepare(
        "UPDATE runs SET scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
      )
      .run(runId);
  } catch {
    /* best-effort */
  }
  await admitQueuedRuns().catch((err) => {
    logger.warn("control-server: queued admission after terminate failed", {
      runId,
      error: String(err),
    });
  });
  return ok({ terminated: true });
}

async function handlePauseRun(runId: string, drain = false): Promise<JsonResponse> {
  const run = getRun(runId);
  if (!run) return notFound(`Run not found: ${runId}`);
  if (isTerminal(run.status)) return conflict(`Run is terminal: ${run.status}`);
  if (run.status === "paused") return ok({ state: "paused" });

  if (drain) {
    try {
      getDb()
        .prepare(
          "UPDATE runs SET scheduling_status = 'draining_pause', updated_at = datetime('now') WHERE id = ?",
        )
        .run(runId);
    } catch (err) {
      logger.warn("control-server: drain pause db update failed", { runId, error: String(err) });
      return notFound(`Run not found: ${runId}`);
    }
    try {
      const { finalizeDrainingPause } = await import("../installer/step-ops.js");
      finalizeDrainingPause(runId);
    } catch (err) {
      logger.warn("control-server: drain pause finalization check failed", { runId, error: String(err) });
    }
    logger.info("control-server: drain pause requested", { runId });
    const updated = getRun(runId);
    return ok({ state: updated?.scheduling_status ?? "draining_pause", drained: true });
  }

  try {
    const { removeRunCrons } = await import("../installer/agent-scheduler.js");
    await removeRunCrons(runId);
  } catch (err) {
    logger.warn("control-server: pause removeRunCrons threw", { runId, error: String(err) });
  }
  try {
    getDb()
      .prepare(
        "UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now') WHERE id = ?",
      )
      .run(runId);
  } catch (err) {
    logger.warn("control-server: pause db update failed", { runId, error: String(err) });
  }
  await admitQueuedRuns().catch((err) => {
    logger.warn("control-server: queued admission after pause failed", {
      runId,
      error: String(err),
    });
  });

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.paused",
    runId: run.id,
    workflowId: run.workflow_id,
  });

  return ok({ state: "paused" });
}

async function handleResumeRun(runId: string): Promise<JsonResponse> {
  const run = getRun(runId);
  if (!run) return notFound(`Run not found: ${runId}`);
  if (isTerminal(run.status)) return conflict(`Run is terminal: ${run.status}`);
  if (run.status === "running" && run.scheduling_status === "active") {
    return ok({ state: "active" });
  }
  try {
    await validateRunHarnessForScheduling(run.id, run.context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      getDb()
        .prepare(
          "UPDATE runs SET scheduling_status = 'error', scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(message, runId);
    } catch {
      /* best-effort */
    }
    return unprocessable(`Cannot resume run: ${message}`);
  }
  try {
    getDb()
      .prepare(
        "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
      )
      .run(new Date().toISOString(), runId);
  } catch {
    /* best-effort */
  }

  // Determine the workflow_id for the event. When the run was previously
  // paused, status=paused and getRun already loaded workflow_id. When
  // resume follows a failed/canceled path (future use), include whatever
  // workflow_id we have.
  const wfId = run.workflow_id ||
    (getRun(runId)?.workflow_id ?? undefined);

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.resumed",
    runId,
    workflowId: wfId,
  });

  // US-002: Recover orphaned running steps before re-creating scheduler timers.
  // Pause-without-drain kills the pi process, leaving steps status='running'.
  // On resume, reset those to 'pending' so peekStep finds them.
  try {
    const orphanedAgents = getDb()
      .prepare("SELECT DISTINCT agent_id FROM steps WHERE run_id = ? AND status = 'running'")
      .all(runId) as { agent_id: string }[];
    if (orphanedAgents.length > 0) {
      const { recoverOrphanedStepsForAgent } = await import("../installer/step-ops.js");
      for (const { agent_id } of orphanedAgents) {
        recoverOrphanedStepsForAgent(agent_id, runId);
      }
      logger.info("control-server: resume orphan recovery complete", {
        runId,
        agents: orphanedAgents.map((a) => a.agent_id),
      });
    }
  } catch (err) {
    logger.warn("control-server: resume orphan recovery failed", {
      runId,
      error: String(err),
    });
  }

  return handleRegisterRun(runId);
}

async function handleNudge(): Promise<JsonResponse> {
  const db = getDb();

  // Query SQLite for running runs only — excludes paused and terminal.
  const runningRuns = db
    .prepare(
      `SELECT id, workflow_id, status, scheduling_status, context, created_at
       FROM runs WHERE status = 'running'`,
    )
    .all() as unknown as RunRow[];

  if (runningRuns.length === 0) {
    return ok({
      runningRuns: 0,
      scheduledRuns: 0,
      launched: 0,
      skippedInFlight: 0,
      skippedPaused: 0,
      runs: [],
      errors: [],
    });
  }

  const { nudgeScheduledRuns } = await import("../installer/agent-scheduler.js");

  const scheduledRunIds: string[] = [];
  const admissionErrors: Array<{ runId: string; error: string }> = [];

  // For each running run, attempt admission (idempotent via handleRegisterRun).
  // Skipped runs (paused/queued) are not nudged.
  for (const run of runningRuns) {
    try {
      const result = await handleRegisterRun(run.id);
      const state = result.body.state as string | undefined;
      if (state === "active") {
        scheduledRunIds.push(run.id);
      }
    } catch (err) {
      admissionErrors.push({
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Call nudgeScheduledRuns with the admitted run IDs.
  const nudgeResult = await nudgeScheduledRuns(scheduledRunIds);

  // Build per-run detail and emit events.
  const runsDetail: Array<Record<string, unknown>> = [];

  for (const runId of scheduledRunIds) {
    const runJobs = nudgeResult.jobs.filter((j) => j.runId === runId);
    const runLaunched = runJobs.filter((j) => j.status === "launched").length;
    const runSkipped = runJobs.filter((j) => j.status === "skipped_in_flight").length;
    const runErrors = nudgeResult.errors.filter((e) => e.runId === runId);

    const run = runningRuns.find((r) => r.id === runId);

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.nudged",
      runId,
      workflowId: run?.workflow_id,
      detail: `Launched ${runLaunched}; skipped ${runSkipped} in-flight`,
    });

    for (const job of runJobs) {
      if (job.status === "launched") {
        emitEvent({
          ts: new Date().toISOString(),
          event: "agent.nudged",
          runId: job.runId,
          agentId: job.agentId,
          workflowId: run?.workflow_id,
        });
      } else if (job.status === "skipped_in_flight") {
        emitEvent({
          ts: new Date().toISOString(),
          event: "agent.nudge.skipped",
          runId: job.runId,
          agentId: job.agentId,
          workflowId: run?.workflow_id,
          detail: "Previous polling round still in flight",
        });
      }
    }

    runsDetail.push({
      runId,
      workflowId: run?.workflow_id,
      launched: runLaunched,
      skippedInFlight: runSkipped,
      errors: runErrors.map((e) => e.error),
    });
  }

  return ok({
    runningRuns: runningRuns.length,
    scheduledRuns: scheduledRunIds.length,
    launched: nudgeResult.launched,
    skippedInFlight: nudgeResult.skippedInFlight,
    skippedPaused: 0,
    runs: runsDetail,
    errors: [
      ...admissionErrors.map((e) => e.error),
      ...nudgeResult.errors.map((e) => e.error),
    ],
  });
}

async function handleJobs(): Promise<JsonResponse> {
  try {
    const { listCronJobs } = await import("../installer/agent-scheduler.js");
    const jobs = await listCronJobs();
    return ok({ jobs: jobs.jobs ?? [] });
  } catch (err) {
    return ok({ jobs: [], error: String(err) });
  }
}

function parseRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 65536) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export interface ControlServerOptions {
  port?: number;
  secret?: string;
  onError?: (err: NodeJS.ErrnoException) => void;
  listen?: boolean;
}

export function createControlServer(options: ControlServerOptions = {}): http.Server {
  const expectedSecret = options.secret;

  const server = http.createServer(async (req, res) => {
    const respond = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const pathname = url.split("?")[0];

    // Health is exempt from auth so daemonctl liveness probes don't need
    // the secret to succeed.
    if (pathname === "/control/health" && method === "GET") {
      respond(200, { status: "ok", pid: process.pid, timestamp: new Date().toISOString(), buildVersion });
      return;
    }

    if (expectedSecret) {
      const provided = req.headers["x-tamandua-secret"];
      const got = Array.isArray(provided) ? provided[0] : provided;
      if (got !== expectedSecret) {
        respond(401, { error: "Unauthorized" });
        return;
      }
    }

    try {
      if (pathname === "/control/limits" && method === "GET") {
        respond(200, { maxActiveTimers: getMaxActiveTimers() });
        return;
      }
      if (pathname === "/control/jobs" && method === "GET") {
        const r = await handleJobs();
        respond(r.status, r.body);
        return;
      }
      if (pathname === "/suite/lookup" && method === "GET") {
        const r = await handleSuiteLookup(url);
        respond(r.status, r.body);
        return;
      }
      if (pathname === "/suite/flaky" && method === "GET") {
        const r = await handleSuiteFlaky(url);
        respond(r.status, r.body);
        return;
      }
      if (method === "POST") {
        const body = await parseRequestBody(req);
        const runId = typeof body.runId === "string" ? body.runId.trim() : "";

        if (pathname === "/suite/event") {
          const r = await handleSuiteEvent(body);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/suite/record") {
          const r = await handleSuiteRecord(body);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/suite/claim") {
          const r = await handleSuiteClaim(body);
          respond(r.status, r.body);
          return;
        }
        if (
          (pathname === "/control/register-run"
            || pathname === "/control/terminate-run"
            || pathname === "/control/pause-run"
            || pathname === "/control/resume-run") && !runId
        ) {
          respond(400, { error: "Missing or empty 'runId' in request body" });
          return;
        }
        if (pathname === "/control/register-run") {
          const r = await handleRegisterRun(runId);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/control/terminate-run") {
          const r = await handleTerminateRun(runId);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/control/pause-run") {
          const drain = typeof body.drain === "boolean" ? body.drain : false;
          const r = await handlePauseRun(runId, drain);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/control/resume-run") {
          const r = await handleResumeRun(runId);
          respond(r.status, r.body);
          return;
        }
        if (pathname === "/control/nudge") {
          const r = await handleNudge();
          respond(r.status, r.body);
          return;
        }
      }
      respond(404, { error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      respond(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.error("control-server: error", { code: err.code, message: err.message });
    if (options.onError) options.onError(err);
  });

  if (options.listen !== false) {
    const listenPort = options.port ?? getControlPort();
    assertPortIsolation(listenPort, "control plane");
    server.listen(listenPort, "127.0.0.1", () => {
      logger.info("control-server: listening", { port: listenPort });
    });
  }

  return server;
}

export async function startControlServer(options: ControlServerOptions = {}): Promise<http.Server> {
  const server = createControlServer({ ...options, listen: false });
  const port = options.port ?? getControlPort();
  assertPortIsolation(port, "control plane");

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      logger.info("control-server: listening", { port });
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  return server;
}

// ────────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────────

const RECONCILER_INTERVAL_MS = 30_000;

/**
 * Periodically inspects DB scheduling state and reconciles in-memory job
 * maps. Runs at startup and every 30s thereafter. Survives missed control
 * notifications and transient errors.
 */
/** @internal — exposed for tests to verify context flag → setupAgentCrons wiring. */
export async function _admitOrQueueRun(run: RunRow): Promise<JsonResponse> {
  return admitOrQueueRun(run);
}

export function startReconciler(): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const db = getDb();

      // ── Dead-worker sweep (MOTOR-CONTRACT.md C18) ────────────────
      // A previous daemon may have died (crash, reboot, kill) with work
      // rounds in flight, leaving steps 'running' under dead workers.
      // Requeue them now instead of waiting out the age-based stale
      // threshold (up to 45 minutes). First tick runs ~1s after startup.
      let deadWorkerRunIds: string[] = [];
      try {
        const { recoverStepsWithDeadWorkers } = await import("../installer/step-ops.js");
        const sweep = recoverStepsWithDeadWorkers();
        if (sweep.recovered > 0 || sweep.failed > 0) {
          deadWorkerRunIds = sweep.runIds;
          logger.info("control-server: recovered steps claimed by dead workers", {
            recovered: sweep.recovered,
            failed: sweep.failed,
            skipped: sweep.skipped,
            runIds: sweep.runIds,
          });
        }
      } catch (err) {
        logger.warn("control-server: dead-worker sweep failed", { error: String(err) });
      }

      const desired = db
        .prepare(
          `SELECT id, workflow_id, status, scheduling_status, context, created_at
           FROM runs
           WHERE status IN ('running')
             AND (scheduling_status IS NULL OR scheduling_status IN ('pending_register', 'active', 'error'))
           ORDER BY scheduling_requested_at ASC, created_at ASC`,
        )
        .all() as unknown as RunRow[];

      const { _hasRunScheduled, removeRunCrons } = await import(
        "../installer/agent-scheduler.js"
      );

      for (const run of desired) {
        if (run.scheduling_status === "active" && _hasRunScheduled(run.id)) continue;
        // Re-admit pending/error/missing runs.
        await handleRegisterRun(run.id).catch(() => {});
      }

      // Dispatch requeued steps immediately — their runs' jobs exist now
      // that admission ran above.
      if (deadWorkerRunIds.length > 0) {
        const { nudgeScheduledRuns } = await import("../installer/agent-scheduler.js");
        await nudgeScheduledRuns(deadWorkerRunIds).catch(() => {});
      }

      // Clean up jobs for runs that are no longer active.
      const { _scheduledRunIds } = await import("../installer/agent-scheduler.js");
      const scheduledIds = _scheduledRunIds();
      for (const runId of scheduledIds) {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        if (!row || row.status !== "running") {
          await removeRunCrons(runId);
        }
      }

      // ── TSTX ledger retention pruning ──
      // Remove suite_results rows older than LEDGER_RETENTION (14d).
      try {
        const { pruneOldSuiteResults } = await import("../db.js");
        const pruned = pruneOldSuiteResults();
        if (pruned > 0) {
          logger.info("control-server: pruned old suite_results rows", { pruned });
        }
      } catch (err) {
        logger.warn("control-server: suite_results pruning failed", { error: String(err) });
      }

      await admitQueuedRuns();
    } catch (err) {
      logger.warn("control-server: reconciler tick failed", { error: String(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), RECONCILER_INTERVAL_MS);
        timer.unref();
      }
    }
  }

  // Fire first tick on next event-loop turn so server bootstrap settles.
  timer = setTimeout(() => void tick(), 1000);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
