/**
 * Tamandua Daemon Control Plane Client
 *
 * Thin HTTP client used by the CLI / MCP / installer paths to talk to
 * the daemon's control plane on 127.0.0.1:3339 (or TAMANDUA_CONTROL_PORT).
 *
 * All operations are best-effort: if the daemon isn't running, the calling
 * path falls back to in-process scheduling so local development and test
 * paths keep working. Production deployments should always run the daemon.
 */
import http from "node:http";
import os from "node:os";
import pathModule from "node:path";
import { testGuardActive, assertStatePathIsolation } from "../lib/test-guard.js";
import { getControlPort, readDaemonSecret } from "./control-server.js";
import { startDaemon } from "./daemonctl.js";

export interface ControlPlaneResponse {
  status: number;
  body: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 1500;

async function controlRequest(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ControlPlaneResponse | null> {
  // Test-isolation guard: refuse to send requests to the production
  // control plane when the test guard is active. The production port
  // (3339) is indicated by the absence of TAMANDUA_CONTROL_PORT.
  // The production daemon secret is detected by resolving
  // ~/.tamandua/daemon-secret against the real user home.
  if (testGuardActive()) {
    if (!process.env.TAMANDUA_CONTROL_PORT) {
      return null;
    }
    const defaultSecretPath = pathModule.join(
      (process.env.HOME?.trim() || os.homedir()),
      ".tamandua",
      "daemon-secret",
    );
    try {
      assertStatePathIsolation(defaultSecretPath, "controlRequest(secret)");
    } catch {
      return null;
    }
  }

  const port = getControlPort();
  const secret = readDaemonSecret();
  const payload = body ? JSON.stringify(body) : "";

  const options: http.RequestOptions = {
    method,
    hostname: "127.0.0.1",
    port,
    path,
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-tamandua-secret": secret } : {}),
      ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
    },
  };

  return await new Promise<ControlPlaneResponse | null>((resolve) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed: Record<string, unknown> = {};
        if (raw.trim()) {
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parsed = { raw };
          }
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });

    req.on("error", () => resolve(null)); // daemon not running / unreachable
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("control plane timeout"));
      resolve(null);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** Quick liveness probe; returns true when the daemon control plane responds. */
export async function isDaemonControlReachable(timeoutMs: number = 500): Promise<boolean> {
  const r = await controlRequest("GET", "/control/health", undefined, timeoutMs);
  return r !== null && r.status === 200;
}

const PROBE_TIMEOUT_OVERRIDE_ENV = "TAMANDUA_CONTROL_PROBE_TIMEOUT_OVERRIDE";

function resolveProbeTimeout(defaultMs: number): number {
  const override = process.env[PROBE_TIMEOUT_OVERRIDE_ENV];
  if (override !== undefined) {
    const parsed = parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultMs;
}

export async function waitForDaemonControl(timeoutMs: number = 30_000): Promise<boolean> {
  const effectiveTimeout = resolveProbeTimeout(timeoutMs);
  const startedAt = Date.now();
  let delay = 100;
  const maxDelay = 2_000;
  while (Date.now() - startedAt < effectiveTimeout) {
    if (await isDaemonControlReachable(500)) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxDelay);
  }
  return false;
}

export async function ensureDaemonControlAvailable(timeoutMs: number = 30_000): Promise<void> {
  const effectiveTimeout = resolveProbeTimeout(timeoutMs);
  if (await isDaemonControlReachable(500)) return;

  await startDaemon();

  if (!(await waitForDaemonControl(effectiveTimeout))) {
    throw new Error(
      `Tamandua daemon started but control plane did not become reachable on port ${getControlPort()}.`,
    );
  }
}

/**
 * Notify the daemon that a new run has been created and should be admitted
 * into the scheduler. Returns the parsed response on success, null when the
 * daemon is unreachable (caller should fall back to in-process scheduling).
 */
export async function registerRunWithDaemon(runId: string, timeoutMs?: number): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/register-run", { runId }, timeoutMs);
}

/** Request termination of a run's scheduling state. */
export async function terminateRunWithDaemon(runId: string): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/terminate-run", { runId });
}

/** Pause a run (clears timers; sets status='paused'). Optionally drain first. */
export async function pauseRunWithDaemon(runId: string, drain = false, requestedBy?: string): Promise<ControlPlaneResponse | null> {
  const body: Record<string, unknown> = { runId };
  if (drain) body.drain = true;
  if (requestedBy) body.requestedBy = requestedBy;
  return controlRequest("POST", "/control/pause-run", body);
}

/** Resume a paused run (re-enters admission). */
export async function resumeRunWithDaemon(runId: string, requestedBy?: string): Promise<ControlPlaneResponse | null> {
  const body: Record<string, unknown> = { runId };
  if (requestedBy) body.requestedBy = requestedBy;
  return controlRequest("POST", "/control/resume-run", body);
}

/** Request the daemon to nudge all scheduled agents for all running runs. */
export async function nudgeWithDaemon(timeoutMs?: number): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/nudge", {}, timeoutMs);
}

// ── Suite ledger client functions ──────────────────────────────────────

/** Result of a suite lookup: the latest execution entry + pass/fail/flaky stats. */
export interface SuiteLookupResult {
  latest: Record<string, unknown> | null;
  passCount: number;
  failCount: number;
  flaky: boolean;
}

/** Parameters for recording a suite execution result. */
export interface SuiteRecordParams {
  origin_repo: string;
  tree_hash: string;
  cmd_hash: string;
  cmd_display: string;
  exit_code: number;
  duration_ms: number;
  log_tail?: string | null;
  run_id?: string | null;
  step_id?: string | null;
}

/** Result of a suite record operation. */
export interface SuiteRecordResult {
  id: number;
  created_at: string;
}

/** Result of a suite claim operation. */
export interface SuiteClaimResult {
  action: "run" | "wait";
  claimedAt?: string;
}

/** A single flaky key entry. */
export interface SuiteFlakyKey {
  tree_hash: string;
  cmd_hash: string;
  cmd_display: string;
  pass_count: number;
  fail_count: number;
}

/**
 * Look up the latest suite execution record for a given key.
 * Returns typed result on success, null when the daemon is unreachable.
 */
export async function lookupSuiteRecord(
  originRepo: string,
  treeHash: string,
  cmdHash: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SuiteLookupResult | null> {
  const qs = new URLSearchParams({ origin_repo: originRepo, tree_hash: treeHash, cmd_hash: cmdHash });
  const r = await controlRequest("GET", `/suite/lookup?${qs.toString()}`, undefined, timeoutMs);
  if (!r || r.status !== 200) return null;
  return r.body as unknown as SuiteLookupResult;
}

/**
 * Record a suite execution result.
 * Returns typed result on success, null when the daemon is unreachable.
 */
export async function recordSuiteResult(
  params: SuiteRecordParams,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SuiteRecordResult | null> {
  const body: Record<string, unknown> = {
    origin_repo: params.origin_repo,
    tree_hash: params.tree_hash,
    cmd_hash: params.cmd_hash,
    cmd_display: params.cmd_display,
    exit_code: params.exit_code,
    duration_ms: params.duration_ms,
  };
  if (params.log_tail != null) body.log_tail = params.log_tail;
  if (params.run_id != null) body.run_id = params.run_id;
  if (params.step_id != null) body.step_id = params.step_id;
  const r = await controlRequest("POST", "/suite/record", body, timeoutMs);
  if (!r || r.status !== 200) return null;
  return r.body as unknown as SuiteRecordResult;
}

/**
 * Claim a suite key for single-flight execution.
 * Returns { action: "run" } when the caller should execute,
 * { action: "wait" } when another caller is already executing.
 * Returns null when the daemon is unreachable.
 */
export async function claimSuiteKey(
  originRepo: string,
  treeHash: string,
  cmdHash: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SuiteClaimResult | null> {
  const r = await controlRequest(
    "POST",
    "/suite/claim",
    { origin_repo: originRepo, tree_hash: treeHash, cmd_hash: cmdHash },
    timeoutMs,
  );
  if (!r || r.status !== 200) return null;
  return r.body as unknown as SuiteClaimResult;
}

/** Parameters for emitting a suite event via the control plane. */
export interface SuiteEventParams {
  event: string;
  run_id: string;
  step_id?: string;
  tree_hash?: string;
  cmd_display?: string;
  cmd_hash?: string;
  saved_duration_ms?: number;
  duration_ms?: number;
  exit_code?: number;
  pass_count?: number;
  fail_count?: number;
  window?: string;
  waited_ms?: number;
}

/**
 * Emit a suite.* event to the event log via the control plane.
 * Best-effort: resolves successfully when the event was emitted,
 * rejects when the daemon is unreachable or returns an error.
 */
export async function emitSuiteEvent(
  params: SuiteEventParams,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    event: params.event,
    run_id: params.run_id,
  };
  if (params.step_id) body.step_id = params.step_id;
  if (params.tree_hash) body.tree_hash = params.tree_hash;
  if (params.cmd_display) body.cmd_display = params.cmd_display;
  if (params.cmd_hash) body.cmd_hash = params.cmd_hash;
  if (params.saved_duration_ms != null) body.saved_duration_ms = params.saved_duration_ms;
  if (params.duration_ms != null) body.duration_ms = params.duration_ms;
  if (params.exit_code != null) body.exit_code = params.exit_code;
  if (params.pass_count != null) body.pass_count = params.pass_count;
  if (params.fail_count != null) body.fail_count = params.fail_count;
  if (params.window) body.window = params.window;
  if (params.waited_ms != null) body.waited_ms = params.waited_ms;

  const r = await controlRequest("POST", "/suite/event", body, timeoutMs);
  return r !== null && r.status === 200;
}

/**
 * Query flaky keys for a given origin repository.
 * Returns array of flaky key entries, null when the daemon is unreachable.
 */
export async function getFlakyKeys(
  originRepo: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SuiteFlakyKey[] | null> {
  const qs = new URLSearchParams({ origin_repo: originRepo });
  const r = await controlRequest("GET", `/suite/flaky?${qs.toString()}`, undefined, timeoutMs);
  if (!r || r.status !== 200) return null;
  const body = r.body as { flaky_keys?: SuiteFlakyKey[] };
  return body.flaky_keys ?? [];
}
