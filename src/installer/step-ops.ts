import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { resolvePiStateDir, resolveWorkflowDir, resolveTamanduaCli, resolveRunRoot } from "./paths.js";
import { teardownWorkflowCronsIfIdle } from "./agent-scheduler.js";
import { emitEvent, beginEventBuffering, flushEventBuffer, discardEventBuffer } from "./events.js";
import { logger } from "../lib/logger.js";
import { getMaxRoleTimeoutSeconds } from "./install.js";
import { loadWorkflowSpec, loadWorkflowSpecSync } from "./workflow-spec.js";
import { isFrontendChange } from "../lib/frontend-detect.js";
import { stripIdPrefix } from "../lib/id-prefix.js";
import { SQL_NOW_ISO, instantAgeMs, isOlderThan, monotonicNow } from "../lib/instant.js";
import type { LoopConfig, Story, WorkflowStepFailure } from "./types.js";
import { detectRugpull, relaunchRunAfterRugpull } from "./rugpull.js";
import { getPgid } from "../lib/proc-info.js";
import {
  evaluateFinalizeMergeLedgerGate,
  formatLedgerGateRefusal,
  formatTestCmdReviewRefusal,
  getTestCmdReviewRefusal,
  isStrictMissing,
  type LedgerGateDecision,
  type LedgerGateMode,
  type LedgerGateRefusalDecision,
  type TestCmdReviewRefusal,
  type FinalizeMergeEvidenceSource,
} from "./ledger-gate.js";

// ══════════════════════════════════════════════════════════════════════
// Stderr Sanitization
// ══════════════════════════════════════════════════════════════════════

/**
 * Regex matching CSI (Control Sequence Introducer) ANSI escape sequences.
 * Covers: SGR (graphic rendition: colors, bold, etc.), cursor movement,
 * erase, and other common terminal control sequences.
 */
const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Max line length before truncation. Lines longer than this get a
 * `… [truncated]` marker appended.
 */
const MAX_LINE_LENGTH = 512;

/**
 * Default maximum output size in bytes (8 KB). The sanitized output is
 * trimmed from the front to stay within this bound.
 */
const DEFAULT_MAX_BYTES = 8192;

/**
 * Sanitize stderr output for inclusion in event payloads.
 *
 * Processing steps:
 * 1. Strip ANSI CSI escape sequences (colors, cursor movement, etc.)
 * 2. Truncate individual lines longer than `maxLineLength` characters,
 *    appending `… [truncated]` as a marker
 * 3. Keep only the last `maxBytes` bytes of the sanitized output (trim from
 *    front) so the payload never exceeds a known bound
 *
 * Multi-byte boundary safety: byte slicing for the tail window is done
 * post-string-conversion (Buffer.byteLength), so no split code points.
 *
 * @param raw - Raw stderr string (may contain ANSI escape sequences)
 * @param maxBytes - Maximum output size in bytes (default 8192 = 8 KB)
 * @param maxLineLength - Characters before line truncation (default 512)
 * @returns Sanitized string suitable for JSONL event payloads
 */
export function sanitizeStderrTail(
  raw: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
  maxLineLength: number = MAX_LINE_LENGTH,
): string {
  // Step 1: strip ANSI escape sequences
  let cleaned = raw.replace(ANSI_CSI_RE, "");

  // Step 2: truncate long lines
  const lines = cleaned.split("\n");
  const truncatedMarker = "… [truncated]";
  const lineBudget = maxLineLength - truncatedMarker.length;

  const processed = lines.map((line) => {
    if (line.length <= maxLineLength) return line;
    // Truncate at the char boundary budget, then append marker
    return line.slice(0, lineBudget) + truncatedMarker;
  });

  cleaned = processed.join("\n");

  // Step 3: keep only last maxBytes bytes (trim from front)
  const buf = Buffer.from(cleaned, "utf-8");
  if (buf.length > maxBytes) {
    // Find a safe UTF-8 boundary to avoid splitting a multi-byte character.
    // Scan forward from the cut point until we find a byte that is not a
    // continuation byte (0x80-0xBF).
    let start = buf.length - maxBytes;
    // A continuation byte has bits 10xxxxxx, i.e. (byte & 0xC0) === 0x80.
    while (start < buf.length && (buf[start] & 0xC0) === 0x80) {
      start++;
    }
    return buf.toString("utf-8", start);
  }

  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
// Key-Value Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse KEY: value lines from step output with support for multi-line values.
 * Accumulates continuation lines until the next KEY: boundary or end of output.
 * Returns a map of lowercase keys to their (trimmed) values.
 * Skips STORIES_JSON keys (handled separately).
 */
export function parseOutputKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split("\n");
  let pendingKey: string | null = null;
  let pendingValue = "";

  function commitPending() {
    if (pendingKey && !pendingKey.startsWith("STORIES_JSON")) {
      result[pendingKey.toLowerCase()] = pendingValue.trim();
    }
    pendingKey = null;
    pendingValue = "";
  }

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) {
      commitPending();
      pendingKey = match[1];
      pendingValue = match[2];
    } else if (pendingKey) {
      pendingValue += "\n" + line;
    }
  }
  commitPending();

  return result;
}

/**
 * Reserved context keys that must not be overwritten by step output parsing.
 * These are structural keys that define the harness/repo/environment and should
 * only be set during run creation, not by agent-generated KEY:value output.
 *
 * WAVE-A.1 US-001 (TCMD hardening): the TEST_CMD review-state keys
 * (test_cmd_review_required, test_cmd_review_candidate,
 * test_cmd_review_established, test_cmd_rewriter_step) are agent-unwritable.
 * They are persisted into run context ONLY by the in-process rewrite detector
 * (during the test_cmd merge branch in completeStep) and by the verdict
 * router / withdrawal logic — never by parseOutputKeyValues merges. Reserving
 * them means a rewriting step cannot emit `TEST_CMD_REVIEW_REQUIRED: false` in
 * its own output to clear the gate (corridor 1a), and an agent cannot forge
 * review material (candidate/established/rewriter_step) to steer the reviewer.
 */
const RESERVED_CONTEXT_KEYS = new Set([
  "repo",
  "working_directory_for_harness",
  "task",
  "run_id",
  "workspace_mode",
  "worktree_path",
  "worktree_origin_repository",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "original_branch",
  "merge_gate",
  "fail_missing",
  "test_cmd_raw",
  "test_cmd_review_required",
  "test_cmd_review_candidate",
  "test_cmd_review_established",
  "test_cmd_rewriter_step",
]);

// ══════════════════════════════════════════════════════════════════════
// Retry Feedback Formatting
// ══════════════════════════════════════════════════════════════════════

/**
 * Maximum bytes to keep from retry feedback (4 KB), measured from the END
 * of the feedback text. Truncation uses Buffer.byteLength to handle
 * multi-byte UTF-8 characters safely.
 */
const RETRY_FEEDBACK_MAX_BYTES = 4096;

/**
 * Format raw retry feedback into a PREVIOUS ATTEMPT FEEDBACK section.
 *
 * Rules:
 * - Returns empty string when rawFeedback is falsy (null, undefined, empty)
 * - When rawFeedback is non-empty:
 *   - retryCount > 0: "PREVIOUS ATTEMPT FEEDBACK (attempt <N> was rejected):\n<bounded feedback>"
 *   - retryCount == 0: "PREVIOUS ATTEMPT FEEDBACK:\n<bounded feedback>"
 *     (reroute / producer re-pend case where retry_count stays unchanged)
 * - Feedback is bounded to the last RETRY_FEEDBACK_MAX_BYTES bytes
 *   (truncated from the front, keeping the tail).
 */
export function formatRetryFeedback(rawFeedback: string | null | undefined, retryCount: number): string {
  if (!rawFeedback) return "";

  let bounded = rawFeedback;
  const buf = Buffer.from(bounded, "utf-8");
  if (buf.length > RETRY_FEEDBACK_MAX_BYTES) {
    // Find a safe UTF-8 boundary — skip continuation bytes (0x80-0xBF)
    let start = buf.length - RETRY_FEEDBACK_MAX_BYTES;
    while (start < buf.length && (buf[start] & 0xC0) === 0x80) {
      start++;
    }
    bounded = buf.toString("utf-8", start);
  }

  if (retryCount > 0) {
    return `PREVIOUS ATTEMPT FEEDBACK (attempt ${retryCount} was rejected):\n${bounded}`;
  }
  return `PREVIOUS ATTEMPT FEEDBACK:\n${bounded}`;
}

// ══════════════════════════════════════════════════════════════════════
// Template Resolution
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve {{key}} placeholders in a template against a context object.
 */
export function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (key in context) return context[key];
    const lower = key.toLowerCase();
    if (lower in context) return context[lower];
    return `[missing: ${key}]`;
  });
}

/**
 * Find missing template placeholders for a given context object.
 */
export function findMissingTemplateKeys(template: string, context: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const lower = key.toLowerCase();
    const hasExact = Object.prototype.hasOwnProperty.call(context, key);
    const hasLower = Object.prototype.hasOwnProperty.call(context, lower);
    if (!hasExact && !hasLower && !seen.has(lower)) {
      seen.add(lower);
      missing.push(lower);
    }
    return "";
  });
  return missing;
}

function templateKeys(template: string): string[] {
  const keys = new Set<string>();
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    keys.add(key.toLowerCase());
    return "";
  });
  return [...keys];
}

function emitDispatchRenderingValidation(step: {
  id: string; run_id: string; step_id: string; input_template: string;
}): void {
  const claim = getDb().prepare(
    "SELECT claim_job_id, claim_updated_at, updated_at FROM steps WHERE id = ?",
  ).get(step.id) as { claim_job_id: string | null; claim_updated_at: string | null; updated_at: string } | undefined;
  const claimId = claim?.claim_job_id ?? `${step.id}:${claim?.claim_updated_at ?? claim?.updated_at ?? "unknown"}`;
  emitEvent({
    ts: new Date().toISOString(), event: "dispatch.render.validated", recordId: crypto.randomUUID(),
    runId: step.run_id, stepRowId: step.id, stepId: step.step_id, claimId,
    requiredKeys: templateKeys(step.input_template), unresolvedPlaceholderCount: 0, unresolvedKeys: [],
    dispatched: true,
  });
}

// parseExpectedKeys and checkExpectsAcceptsVariant are now the
// single-source-of-truth implementations in workflow-contract.ts.
// Re-exported here for backward compatibility.
import { checkExpectsAcceptsVariant, parseExpectedKeys } from "./workflow-contract.js";
export { parseExpectedKeys, checkExpectsAcceptsVariant };

/**
 * Result of finding a producer step for a missing template key.
 */
export interface ProducerResult {
  stepId: string;
  stepIndex: number;
  retryCount: number;
  maxRetries: number;
}

/**
 * Find the most recent upstream DONE step whose Reply-with block declares
 * a given key as expected output.  Used by the missing-template-key
 * recovery path to determine which producer step to re-pend.
 *
 * Returns null when no upstream DONE step declares the missing key.
 */
export function findProducerForMissingKey(
  runId: string,
  currentStepIndex: number,
  missingKey: string
): ProducerResult | null {
  const db = getDb();

  const upstreamSteps = db.prepare(
    `SELECT id, step_id, step_index, input_template, retry_count, max_retries
     FROM steps
     WHERE run_id = ? AND step_index < ? AND status = 'done'
     ORDER BY step_index DESC`
  ).all(runId, currentStepIndex) as {
    id: string;
    step_id: string;
    step_index: number;
    input_template: string;
    retry_count: number;
    max_retries: number;
  }[];

  const lowerKey = missingKey.toLowerCase();
  for (const step of upstreamSteps) {
    const expectedKeys = parseExpectedKeys(step.input_template);
    if (expectedKeys.includes(lowerKey)) {
      return {
        stepId: step.id,
        stepIndex: step.step_index,
        retryCount: step.retry_count,
        maxRetries: step.max_retries,
      };
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Missing Template Key Blocking & Recovery
// ══════════════════════════════════════════════════════════════════════

/**
 * Result of handling missing template keys in claimStep.
 * - 'proceed': no missing keys, continue with normal claim flow.
 * - 'rejected': producers were re-pended; caller must unclaim and return { found: false }.
 * - Any other string: the run was failed with this message; caller must return { found: false }.
 */
type MissingKeyAction = 'proceed' | 'rejected' | string;

/**
 * When claimStep discovers missing template keys, block the model round and
 * route recovery to upstream producers.  Returns the action taken:
 *
 * - 'proceed'     no missing keys (should not happen if missingKeys is empty,
 *                  but defensive).
 * - 'rejected'    one or more producer steps were re-pended with retry_feedback
 *                  naming the missing key(s).  The caller must unclaim the
 *                  consumer step and return { found: false }.
 * - string         the run was failed immediately.  The string is the failure
 *                  message, suitable for logging.  The caller must return
 *                  { found: false } without further work.
 */
function resolveMissingKeys(
  runId: string,
  currentStepIndex: number,
  consumerStepId: string,
  consumerStepRowId: string,
  agentId: string,
  missingKeys: string[]
): MissingKeyAction {
  if (missingKeys.length === 0) return 'proceed';

  const db = getDb();

  // Phase 1: collect producer info for each missing key.
  // Deduplicate by producer stepId — multiple keys from the same upstream
  // step should only re-pend that step once.
  const producerMap = new Map<string, ProducerResult>();
  const producerByKey = new Map<string, ProducerResult>();
  const unresolvableKeys: string[] = [];
  const exhaustedDetails: string[] = [];

  for (const key of missingKeys) {
    const producer = findProducerForMissingKey(runId, currentStepIndex, key);
    if (!producer) {
      unresolvableKeys.push(key);
    } else if (producer.retryCount >= producer.maxRetries) {
      exhaustedDetails.push(
        `${key} (producer ${producer.stepId} exhausted at ${producer.retryCount}/${producer.maxRetries} retries)`
      );
    } else {
      producerMap.set(producer.stepId, producer);
      producerByKey.set(key, producer);
    }
  }

  // Phase 2: no-producer fail-fast — any unresolvable key kills the run.
  if (unresolvableKeys.length > 0) {
    const msg =
      `Run failed: step "${consumerStepId}" requires template key(s) ` +
      `${unresolvableKeys.join(", ")} but no upstream DONE step declares ` +
      `them in its Reply-with block.`;
    failRunForMissingTemplateKeys(consumerStepRowId, consumerStepId, runId, agentId, msg);
    return msg;
  }

  // Phase 3: exhausted-producer fail-fast.
  if (exhaustedDetails.length > 0) {
    const msg =
      `Run failed: step "${consumerStepId}" requires template key(s) ` +
      `${missingKeys.join(", ")} but producer retries are exhausted: ` +
      `${exhaustedDetails.join("; ")}.`;
    failRunForMissingTemplateKeys(consumerStepRowId, consumerStepId, runId, agentId, msg);
    return msg;
  }

  // Phase 4: re-pend producers with retry_feedback naming the missing keys.
  const feedback =
    `Missing key(s) needed by downstream step "${consumerStepId}": ` +
    `${missingKeys.join(", ")}`;
  const wfId = getWorkflowId(runId);
  for (const producer of producerMap.values()) {
    const newRetryCount = producer.retryCount + 1;
    db.prepare(
      `UPDATE steps
       SET status = 'pending', retry_count = ?, output = ?,
           claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL,
           updated_at = ${SQL_NOW_ISO}
       WHERE id = ?`
    ).run(newRetryCount, feedback, producer.stepId);
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.repended",
      runId,
      workflowId: wfId,
      stepId: producer.stepId,
      agentId,
      detail: `Re-pended with retry_feedback: ${feedback}`,
    });
    const producerKeys = missingKeys.filter((key) => producerByKey.get(key)?.stepId === producer.stepId);
    for (const key of producerKeys) {
      emitEvent({
        ts: new Date().toISOString(), event: "dispatch.keys.rejected", recordId: crypto.randomUUID(),
        runId, stepRowId: consumerStepRowId, stepId: consumerStepId,
        claimId: `${consumerStepRowId}:missing-context`, requiredKeys: missingKeys,
        unresolvedPlaceholderCount: 1, unresolvedKeys: [key], dispatched: false,
        producerStepRowId: producer.stepId, transitionAction: "reroute",
        transitionTargetStepRowId: producer.stepId,
      });
    }
    logger.info(
      `Re-pended producer step ${producer.stepId} ` +
        `(retry ${newRetryCount}/${producer.maxRetries}) ` +
        `for missing keys: ${missingKeys.join(", ")}`,
      { runId, consumerStepId, producerStepId: producer.stepId, missingKeys },
    );
  }

  return 'rejected';
}

/**
 * Mark the consumer step and the run as failed, emit events, and tear down
 * crons.  This is the fail-fast path invoked when missing template keys
 * cannot be resolved by re-pending an upstream producer.
 */
function failRunForMissingTemplateKeys(
  stepRowId: string,
  stepId: string,
  runId: string,
  agentId: string,
  message: string
): void {
  const db = getDb();
  const wfId = getWorkflowId(runId);
  db.prepare(
    `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(message, stepRowId);
  db.prepare(
    `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(runId);
  emitEvent({
    ts: new Date().toISOString(),
    event: "step.failed",
    runId,
    workflowId: wfId,
    stepId,
    agentId,
    detail: message,
  });
  emitRunTerminalEvent({
    event: "run.failed",
    runId,
    workflowId: wfId,
    detail: message,
  });
  logger.error(message, { runId, stepId, agentId });
  scheduleRunCronTeardown(runId);
}

// ══════════════════════════════════════════════════════════════════════
// Cron Teardown & Run Lookup
// ══════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget cron teardown when a run ends.
 * Looks up the workflow_id for the run and tears down crons if no other active runs.
 */
export function scheduleRunCronTeardown(runId: string): void {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id, status FROM runs WHERE id = ?").get(runId) as { workflow_id: string; status: string } | undefined;
    if (!run) return;

    // Terminal runs never carry a scheduling_status. Any path that lands a
    // run in completed/failed/canceled should also wipe the scheduling
    // fields so the daemon reconciler stops considering it.
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      try {
        db.prepare(
          `UPDATE runs SET scheduling_status = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
        ).run(runId);
      } catch {
        // best-effort
      }
    }

    // Run-scoped teardown is preferred (daemon-owned timers are
    // run-scoped). The workflow-wide idle check remains as a back-compat
    // safety net for legacy callers / tests that still rely on it.
    // The run ended on its own here, so in-flight harness processes get
    // the completion grace window to flush before the leak-guard kill.
    import("./agent-scheduler.js")
      .then((m) => m.removeRunCrons(runId, { graceMs: m.HARNESS_TEARDOWN_GRACE_MS }))
      .catch(() => {});
    import("../server/control-client.js")
      .then((m) => m.terminateRunWithDaemon(runId))
      .catch(() => {});
    teardownWorkflowCronsIfIdle(run.workflow_id).catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * Fire-and-forget dispatch nudge to the daemon.
 *
 * Called whenever a step transitions to 'pending' (pipeline advance after a
 * completion, retry re-pend) so the deterministic dispatch motor picks it up
 * immediately instead of waiting for the next fallback sweep
 * (DISPATCH_INTERVAL_MS). Best-effort by design: completions often happen in
 * short-lived CLI processes, and if the daemon is unreachable the fallback
 * interval dispatches the step anyway.
 */
function nudgeDispatch(): void {
  try {
    import("../server/control-client.js")
      .then((m) => m.nudgeWithDaemon())
      .catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * Look up the workflow_id for a given run.
 */
export function getWorkflowId(runId: string): string | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    return row?.workflow_id;
  } catch {
    return undefined;
  }
}

function getRunTokenSpend(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent;
  } catch {
    return undefined;
  }
}

function getRunWorkerLostCount(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT worker_lost_count FROM runs WHERE id = ?").get(runId) as { worker_lost_count: number } | undefined;
    return row?.worker_lost_count;
  } catch {
    return undefined;
  }
}

function getRunCeilingExpiryCount(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT ceiling_expiry_count FROM runs WHERE id = ?").get(runId) as { ceiling_expiry_count: number } | undefined;
    return row?.ceiling_expiry_count;
  } catch {
    return undefined;
  }
}

/**
 * Emit a terminal run lifecycle event (run.completed/run.failed/run.canceled)
 * with payload parity: ts, runId, workflowId, tokensSpent, workerLostCount,
 * ceilingExpiryCount.
 * run.canceled additionally carries a `reason` (the stop source).
 */
export function emitRunTerminalEvent(params: {
  event: "run.completed" | "run.failed" | "run.canceled";
  runId: string;
  workflowId?: string;
  detail?: string;
  reason?: string;
}): void {
  emitEvent({
    ts: new Date().toISOString(),
    event: params.event,
    runId: params.runId,
    workflowId: params.workflowId,
    detail: params.detail,
    reason: params.reason,
    tokensSpent: getRunTokenSpend(params.runId),
    workerLostCount: getRunWorkerLostCount(params.runId),
    ceilingExpiryCount: getRunCeilingExpiryCount(params.runId),
  });
}

// ══════════════════════════════════════════════════════════════════════
// Agent Workspace
// ══════════════════════════════════════════════════════════════════════

/**
 * Get the workspace path for a Tamandua agent by its id.
 * Reads from ~/.tamandua/agents.json (a JSON array of agent configs with workspace paths).
 */
export function getAgentWorkspacePath(agentId: string): string | null {
  try {
    const configPath = path.join(resolvePiStateDir(), "agents.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const agents: Array<{ id: string; workspace?: string }> = Array.isArray(config) ? config : [];
    const agent = agents.find((a) => a.id === agentId);
    return agent?.workspace ?? null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress File
// ══════════════════════════════════════════════════════════════════════

/**
 * Opt-in host progress-document access seam (MTLK-PROGRESS).
 *
 * Native callers (the worker CLI, the scheduler motor, plain tests) never
 * pass a `RunProgressAccessLike`, so every existing unguarded entry point
 * keeps its exact byte-level behavior (canonical `<state>/runs/<runId>/
 * progress.txt` path + legacy fallbacks). A Matchlock host integration that
 * attaches a scoped progress RESOURCE to a run passes an accessor whose
 * `guestFile` is rendered into claimed/current input (instead of the host
 * canonical path) and whose confined read/write/archive/update methods keep
 * host story-plan IO pointing at the SAME document the guest sees — without
 * following guest-controlled symlinks/FIFOs or falling back to legacy files.
 *
 * This is deliberately structural (methods only): step-ops never imports the
 * matchlock implementation, so no-flag behavior cannot be changed by loading
 * this module.
 */
export interface RunProgressAccessLike {
  /** Guest-visible absolute progress file path (e.g. /workspace/runs/<id>/progress.txt). */
  readonly guestFile: string;
  /** Confined read of the committed document; null when absent. */
  readText(): string | null;
  /** Confined atomic replace of the document. */
  commitText(content: string): void;
  /** Confined compare-and-commit update; returns the committed text. */
  updateText(merge: (current: string | null) => string): string;
  /** Confined archive of the document into `archiveDir`; returns the archived text. */
  archiveTo(archiveDir: string): string;
}

/** Optional opt-in progress view carried by claim/current rendering. */
export interface StepProgressOptions {
  /** Host progress-resource accessor (structural). */
  progressAccess?: RunProgressAccessLike;
  /**
   * Opt-in host-attested Matchlock finalizer evidence source (US-006).
   *
   * Supplied ONLY by the controller-attested Matchlock runner/adapter path
   * (`pi-invocation-runner` -> `NativeStepServices` -> step-ops). When present,
   * a finalize_merge claim/acceptance decision consults this source instead of
   * the native `suite_results` ledger. No run context, guest input or
   * environment variable can activate it; native callers omit it and keep the
   * byte-identical native behavior.
   */
  ledgerEvidenceSource?: FinalizeMergeEvidenceSource;
}

/**
 * Return the canonical progress file path for a run.
 * Location: <tamandua state>/runs/<runId>/progress.txt
 */
export function getRunProgressPath(runId: string): string {
  return path.join(resolveRunRoot(), runId, "progress.txt");
}

/** Progress pointer rendered into claimed/current context (opt-in override). */
function progressPointerFor(runId: string, access?: RunProgressAccessLike): string {
  return access?.guestFile ?? getRunProgressPath(runId);
}
/**
 * Opt-in render view (MTLK-PROGRESS): returns a SHALLOW COPY of the story
 * context with `progress`/`progress_file` remapped to the guest-visible
 * pointer when a progress accessor is attached. The persisted canonical
 * context (host path) is never mutated, and no-flag callers receive the very
 * same object (zero-copy, byte-identical behavior). Only used at claim/current
 * RENDER time — never for host canonical reads/writes/archives.
 */
function renderWithProgressView(
  base: Record<string, string>,
  opts?: StepProgressOptions,
): Record<string, string> {
  if (!opts?.progressAccess) return base;
  // Only remap when the structured keys are actually present (story context).
  if (!("progress_file" in base)) return base;
  const pointer = opts.progressAccess.guestFile;
  const copy = { ...base };
  copy["progress_file"] = pointer;
  copy["progress"] = `stored in the file ${pointer} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
  return copy;
}


/**
 * Read progress.txt for a run.
 *
 * Lookup order (backward-compatible):
 * 1. Canonical path: <tamandua state>/runs/<runId>/progress.txt
 * 2. Workspace-scoped: <agent workspace>/progress-<runId>.txt
 * 3. Workspace-legacy:  <agent workspace>/progress.txt
 *
 * With an opt-in `access`, host reads go through the confined accessor ONLY
 * (no legacy/workspace fallback after an opted-in refusal).
 */
export function readProgressFile(runId: string, access?: RunProgressAccessLike): string {
  if (access) {
    return access.readText() ?? "(no progress file)";
  }
  // Canonical path takes priority
  const canonicalPath = getRunProgressPath(runId);
  try {
    return fs.readFileSync(canonicalPath, "utf-8");
  } catch {
    // Fall through to legacy locations
  }

  // Backward-compatible fallback: workspace-scoped and legacy paths
  const db = getDb();
  const loopStep = db.prepare(
    "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(runId) as { agent_id: string } | undefined;
  if (!loopStep) return "(no progress file)";
  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return "(no progress file)";
  try {
    const scopedPath = path.join(workspace, `progress-${runId}.txt`);
    const legacyPath = path.join(workspace, "progress.txt");
    const filePath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(no progress yet)";
  }
}

/**
 * Build a '## Story Plan' markdown section from an array of stories.
 * Exported for testability.
 */
export function buildStoryPlanSection(stories: Pick<Story, "storyId" | "title" | "description" | "acceptanceCriteria">[]): string {
  let section = "## Story Plan\n\n";
  for (const story of stories) {
    section += `### ${story.storyId}: ${story.title}\n\n`;
    section += `**Description:** ${story.description}\n\n`;
    section += "**Acceptance Criteria:**\n";
    for (const ac of story.acceptanceCriteria) {
      section += `- ${ac}\n`;
    }
    section += "\n";
  }
  return section;
}

/**
 * Merge a '## Story Plan' section into existing progress file content.
 * If a Story Plan section already exists, it is replaced. Otherwise it is
 * inserted after the first heading line (or at the top).
 * Exported for testability.
 */
export function mergeStoryPlanIntoProgress(existingContent: string, storyPlanSection: string): string {
  const storyPlanStart = "\n## Story Plan\n";
  const idx = existingContent.indexOf(storyPlanStart);
  if (idx !== -1) {
    // Find the next ## heading after the Story Plan start (or end of string)
    const afterStart = idx + storyPlanStart.length;
    const nextHeadingIdx = existingContent.indexOf("\n## ", afterStart);
    const endIdx = nextHeadingIdx !== -1 ? nextHeadingIdx : existingContent.length;
    return (
      existingContent.slice(0, idx) +
      "\n" +
      storyPlanSection.trimEnd() +
      (nextHeadingIdx !== -1 ? "" : "\n") +
      existingContent.slice(endIdx)
    );
  }

  if (existingContent.trim()) {
    // Insert after the first heading line, preserving existing content
    const headerMatch = existingContent.match(/^(# .+?\n)/);
    if (headerMatch) {
      return headerMatch[1] + "\n" + storyPlanSection + existingContent.slice(headerMatch[1].length);
    }
    return storyPlanSection + "\n" + existingContent;
  }

  return `# Progress Log\n\n${storyPlanSection}`;
}

/**
 * Write the full story plan to the progress log after STORIES_JSON is parsed.
 *
 * Native behavior (no `access`): writes to the canonical progress file at
 * <tamandua state>/runs/<runId>/progress.txt, preserving any existing
 * Codebase Patterns or other sections. Emits a 'stories.planned' event.
 *
 * Opt-in resource behavior (MTLK-PROGRESS): when a `RunProgressAccessLike`
 * is supplied, the host story-plan write goes through the CONFINED accessor to
 * the SAME document the guest sees, using its compare-and-commit `updateText`
 * so a guest append/rewrite committed between our initial read and the
 * pre-commit identity re-check is never silently dropped (the bounded retry
 * re-reads it). A guest commit landing after the final identity re-check but
 * before the atomic replace is last-writer-wins — see the progress-resource
 * contract's race_reasoning; live arbitrary simultaneous writers are not
 * claimed. No legacy/workspace fallback is attempted after an opted-in
 * refusal.
 */
export function writeStoryPlanToProgress(runId: string, access?: RunProgressAccessLike): void {
  if (!runHasStories(runId)) return;

  try {
    const stories = getStories(runId);
    if (stories.length === 0) return;

    const storyPlanSection = buildStoryPlanSection(stories);

    if (access) {
      access.updateText((current) => mergeStoryPlanIntoProgress(current ?? "", storyPlanSection));
      const wfId = getWorkflowId(runId);
      emitEvent({
        ts: new Date().toISOString(),
        event: "stories.planned",
        runId,
        workflowId: wfId,
        detail: `Wrote ${stories.length} stories to progress file`,
      });
      logger.info("Story plan written to progress file", { runId, storyCount: stories.length });
      return;
    }

    const progressPath = getRunProgressPath(runId);

    // Read existing content if any
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(progressPath, "utf-8");
    } catch {
      // File doesn't exist yet — that's fine
    }

    const newContent = mergeStoryPlanIntoProgress(existingContent, storyPlanSection);

    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, newContent, "utf-8");

    const wfId = getWorkflowId(runId);
    emitEvent({
      ts: new Date().toISOString(),
      event: "stories.planned",
      runId,
      workflowId: wfId,
      detail: `Wrote ${stories.length} stories to progress file`,
    });

    logger.info("Story plan written to progress file", { runId, storyCount: stories.length });
  } catch (err) {
    logger.warn("writeStoryPlanToProgress: failed to write progress file", {
      runId,
      error: (err as Error).message,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// Stories
// ══════════════════════════════════════════════════════════════════════

/**
 * Get all stories for a run, ordered by story_index.
 */
export function getStories(runId: string): Story[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM stories WHERE run_id = ? ORDER BY story_index ASC"
  ).all(runId) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    storyIndex: r.story_index,
    storyId: r.story_id,
    title: r.title,
    description: r.description,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria),
    status: r.status,
    output: r.output ?? undefined,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    abandonedCount: r.abandoned_count ?? undefined,
    resumeResetCount: r.resume_reset_count ?? 0,
    updatedAt: r.updated_at ?? undefined,
  }));
}

/**
 * YSE US-002: re-queue every FAILED story of a loop-over-stories run as
 * PENDING with a fresh verification retry budget on resume.
 *
 * Called from resumeWorkflow (src/installer/run.ts) when a failed run is
 * resumed. A failed loop run (run #826 regression) leaves the story that
 * exhausted its verification retries in 'failed' — plain resume never
 * reset it, so once the remaining PENDING stories ran out the loop
 * terminal-failed again with "Loop has failed stories and no pending
 * stories". This helper returns those stories to the pool so the loop
 * picks them up on the first claim after resume.
 *
 * Semantics (deterministic, DB-only — no daemon interaction):
 *  - Locates the run's first loop-over-stories step (type='loop' AND
 *    parsed loop_config.over === 'stories').
 *  - Resets every story with status 'failed' for the run:
 *    status → 'pending', retry_count → 0 (fresh verification retry
 *    budget; max_retries stays unchanged), output → NULL (stale failure
 *    text must not re-surface), resume_reset_count += 1.
 *  - Emits one story.reset_for_resume event per reset carrying the loop
 *    step's step_id, storyId/storyTitle, and priorFailures equal to the
 *    post-increment resume_reset_count (1 on the first reset, 2 on the
 *    second, ...). Failure history stays in the event stream; no new
 *    audit table is needed.
 *  - Stories already 'done' or 'pending' are never touched; a run with
 *    no loop-over-stories step, or no failed stories, is a no-op.
 *
 * @returns the number of stories reset (0 when nothing was reset).
 */
export function resetFailedStoriesForResume(runId: string): { resetCount: number } {
  const db = getDb();

  // Legacy-DB guard: a DB whose steps table predates the loop_config column
  // cannot contain a loop-over-stories step — resume must no-op there, not
  // throw on an unknown column. (Product DBs always have the column.)
  const stepCols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  if (!stepCols.some((c) => c.name === "loop_config")) return { resetCount: 0 };

  // 1. Locate the run's loop-over-stories step (first by pipeline order).
  const loopStep = db.prepare(
    `SELECT step_id, loop_config FROM steps
     WHERE run_id = ? AND type = 'loop' AND loop_config IS NOT NULL
     ORDER BY step_index ASC LIMIT 1`,
  ).get(runId) as { step_id: string; loop_config: string } | undefined;

  let overStories = false;
  if (loopStep) {
    try {
      const parsed = JSON.parse(loopStep.loop_config) as { over?: string };
      overStories = parsed?.over === "stories";
    } catch {
      overStories = false; // malformed loop_config — treat as not a stories loop
    }
  }
  if (!loopStep || !overStories) return { resetCount: 0 };

  // 2. Failed stories for this run (deterministic story order).
  const failedStories = db.prepare(
    `SELECT id, story_id, title, resume_reset_count FROM stories
     WHERE run_id = ? AND status = 'failed' ORDER BY story_index ASC`,
  ).all(runId) as Array<{
    id: string; story_id: string; title: string; resume_reset_count: number;
  }>;

  if (failedStories.length === 0) return { resetCount: 0 };

  const workflowId = getWorkflowId(runId);
  const resetOne = db.prepare(
    `UPDATE stories
     SET status = 'pending', retry_count = 0, output = NULL,
         resume_reset_count = resume_reset_count + 1, updated_at = ${SQL_NOW_ISO}
     WHERE id = ? AND status = 'failed'`,
  );

  let resetCount = 0;
  for (const story of failedStories) {
    const result = resetOne.run(story.id);
    // Guard against a concurrent claim flipping the row between the SELECT
    // and the UPDATE — only rows still 'failed' are reset.
    if ((result.changes ?? 0) <= 0) continue;

    const priorFailures = story.resume_reset_count + 1; // post-increment (1 on first reset)
    resetCount += 1;
    emitEvent({
      ts: new Date().toISOString(),
      event: "story.reset_for_resume",
      runId,
      workflowId,
      stepId: loopStep.step_id,
      storyId: story.story_id,
      storyTitle: story.title,
      priorFailures,
      detail: `Story ${story.story_id} reset to pending for resume (prior failures: ${priorFailures})`,
    });
  }

  return { resetCount };
}

/**
 * Build JSON-serializable story objects for machine-readable output.
 * Omits undefined fields (abandonedCount, updatedAt when absent).
 */
export function buildStoriesJson(stories: Story[]): { storyId: string; title: string; status: string; abandonedCount?: number; updatedAt?: string }[] {
  return stories.map((s) => {
    const entry: { storyId: string; title: string; status: string; abandonedCount?: number; updatedAt?: string } = {
      storyId: s.storyId,
      title: s.title,
      status: s.status,
    };
    if (s.abandonedCount !== undefined && s.abandonedCount !== 0) entry.abandonedCount = s.abandonedCount;
    if (s.updatedAt) entry.updatedAt = s.updatedAt;
    return entry;
  });
}

/**
 * Get the story currently being worked on by a loop step.
 */
export function getCurrentStory(stepId: string): Story | null {
  const db = getDb();
  const step = db.prepare(
    "SELECT current_story_id FROM steps WHERE id = ?"
  ).get(stepId) as { current_story_id: string | null } | undefined;
  if (!step?.current_story_id) return null;
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get(step.current_story_id) as any;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    storyIndex: row.story_index,
    storyId: row.story_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    status: row.status,
    output: row.output ?? undefined,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    resumeResetCount: row.resume_reset_count ?? 0,
  };
}

/**
 * Format a single story for template interpolation.
 */
export function formatStoryForTemplate(story: Story): string {
  const ac = story.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  return `Story ${story.storyId}: ${story.title}\n\n${story.description}\n\nAcceptance Criteria:\n${ac}`;
}

/**
 * Format completed stories as a summary bullet list.
 */
export function formatCompletedStories(stories: Story[]): string {
  const done = stories.filter((s) => s.status === "done");
  if (done.length === 0) return "(none yet)";
  return done.map((s) => `- ${s.storyId}: ${s.title}`).join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// STORIES_JSON Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Valid story id format: uppercase prefix followed by hyphen and digits.
 * Matches US-001 from feature-dev planners and fix-001 from security-audit
 * prioritizers.
 */
const STORIES_JSON_STORY_ID_RE = /^[A-Z]+-\d+$/i;

/**
 * Known story fields. Any field NOT in this set triggers a warning log
 * (unknown extra fields are tolerated, not fatal).
 */
const KNOWN_STORY_FIELDS = new Set([
  "id",
  "title",
  "description",
  "acceptanceCriteria",
]);

/**
 * Count occurrences of `"<key>":` in raw JSON text where the opening quote is
 * a real JSON delimiter, i.e. not escaped inside a string value (an odd run
 * of preceding backslashes means the quote is string content, so prose like
 * `the \"id\": key` in a description does not count). Used by the SJSN guard
 * below to detect story objects that were fused by missing "},{"
 * separators — JSON.parse accepts duplicate keys silently (last one wins),
 * so a fused 7-story object parses as ONE valid story with no error on any
 * surface.
 */
export function countUnescapedJsonKey(jsonText: string, key: string): number {
  const re = new RegExp(`"${key}"\\s*:`, "g");
  let count = 0;
  for (const m of jsonText.matchAll(re)) {
    let backslashes = 0;
    for (let i = (m.index ?? 0) - 1; i >= 0 && jsonText[i] === "\\"; i--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

/**
 * Detect ANY duplicate key within the same JSON object by walking the raw
 * text character by character. Used as the authority for duplicate-key
 * detection — the countUnescapedJsonKey heuristic catches id-key collapses
 * but is blind to duplicate NON-id keys (e.g., a story whose "title"
 * appears twice with different values).
 *
 * Returns an array of { key, objectIndex, firstPos, secondPos } where
 * objectIndex is the zero-based index of the top-level story object (0, 1,
 * 2, ...). Handles nested objects (acceptanceCriteria arrays), escaped
 * quotes inside strings, and does not false-positive on keys repeated
 * across different objects.
 *
 * Node stdlib only — no JSON.parse, no new dependencies.
 */
export function detectDuplicateKeys(
  jsonText: string,
): Array<{ key: string; objectIndex: number; firstPos: number; secondPos: number }> {
  const duplicates: Array<{ key: string; objectIndex: number; firstPos: number; secondPos: number }> = [];

  // Object stack: one entry per '{' (nested objects). Each entry tracks
  // keys seen so far in that object plus the story index context.
  const objStack: Array<{ keys: Map<string, number>; storyIndex: number }> = [];

  let objDepth = 0; // only counts '{' / '}' — arrays and strings are transparent
  let depth = 0; // all brace / bracket nesting (used for string-awareness safety)
  let storyCount = 0; // top-level story object counter

  let i = 0;
  while (i < jsonText.length) {
    const c = jsonText[i];

    // ── String handling ──
    if (c === '"') {
      // Extract the full string value, skipping escaped characters.
      const strStart = i;
      let val = '';
      i++; // skip opening quote
      while (i < jsonText.length) {
        const ch = jsonText[i];
        if (ch === '\\') {
          i++; // skip the backslash
          if (i < jsonText.length) {
            val += jsonText[i]; // escaped char (literal)
          }
          i++;
          continue;
        }
        if (ch === '"') break;
        val += ch;
        i++;
      }
      // i is now at the closing quote (or end of text)

      // Find next non-whitespace char after the closing quote.
      let next = i + 1;
      while (next < jsonText.length && /\s/.test(jsonText[next])) next++;

      if (next < jsonText.length && jsonText[next] === ':') {
        // This is a JSON key.
        const top = objStack[objStack.length - 1];
        if (top) {
          if (top.keys.has(val)) {
            duplicates.push({
              key: val,
              objectIndex: top.storyIndex,
              firstPos: top.keys.get(val)!,
              secondPos: strStart,
            });
          } else {
            top.keys.set(val, strStart);
          }
        }
      }

      i++;
      continue;
    }

    // ── Brace / bracket tracking ──
    if (c === '{') {
      depth++;
      objDepth++;
      if (objDepth === 1) {
        // Top-level object — this is a new story.
        objStack.push({ keys: new Map(), storyIndex: storyCount++ });
      } else {
        // Nested object — inherit story index from the enclosing object.
        const storyIdx =
          objStack.length > 0 ? objStack[objStack.length - 1].storyIndex : storyCount;
        objStack.push({ keys: new Map(), storyIndex: storyIdx });
      }
    } else if (c === '}') {
      depth--;
      objDepth--;
      if (objStack.length > 0) objStack.pop();
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
    }

    i++;
  }

  return duplicates;
}

/**
 * Compute (line, column) from a character position in text (1-based).
 * Exported for testability.
 */
export function positionToLineCol(
  text: string,
  pos: number,
): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Parse STORIES_JSON from step output and insert stories into the DB.
 *
 * Validation is two-phase: every story is checked BEFORE the first insert, so
 * a validation throw never leaves a partial story list behind for the retry
 * to duplicate.
 */
export function parseAndInsertStories(output: string, runId: string): void {
  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("STORIES_JSON:"));
  if (startIdx === -1) return;

  const firstLine = lines[startIdx].slice("STORIES_JSON:".length).trim();
  const jsonLines = [firstLine];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^[A-Z_]+:\s/.test(lines[i])) break;
    jsonLines.push(lines[i]);
  }

  const jsonText = jsonLines.join("\n").trim();
  let stories: any[];
  try {
    stories = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Failed to parse STORIES_JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(stories)) {
    throw new Error("STORIES_JSON must be an array");
  }
  if (stories.length > 20) {
    throw new Error(`STORIES_JSON has ${stories.length} stories, max is 20`);
  }

  // SJSN guard: detect duplicate-key collapse. A planner that omits "},{"
  // separators emits one fused object whose repeated keys JSON.parse silently
  // discards (last one wins) — the payload stays valid JSON, passes every
  // per-story check below, and quietly drops all but the final story. Compare
  // raw "id" key occurrences against the parsed story count to catch it.
  const rawIdCount = countUnescapedJsonKey(jsonText, "id");
  const fusedDetected = rawIdCount > stories.length;

  // SJSN guard: full duplicate-key scanner (authority for non-id duplicates).
  // The raw-id-count heuristic catches id-key collapses but is blind to
  // duplicate NON-id keys (e.g. a story whose "title" appears twice with
  // different values silently keeps the last). The scanner walks the raw
  // JSON text character-by-character and detects ANY duplicate key within
  // the same object.
  const duplicates = detectDuplicateKeys(jsonText);

  if (fusedDetected || duplicates.length > 0) {
    const parts: string[] = [];

    if (fusedDetected) {
      parts.push(
        `STORIES_JSON structural mismatch: the raw JSON contains ${rawIdCount} "id" keys but parsed to only ${stories.length} ${stories.length === 1 ? "story" : "stories"}. ` +
        `Story objects are likely fused together (missing "},{" separators between stories), so JSON.parse silently discarded every story but the last.`
      );
    }

    if (duplicates.length > 0) {
      for (const dup of duplicates) {
        const firstLoc = positionToLineCol(jsonText, dup.firstPos);
        const secondLoc = positionToLineCol(jsonText, dup.secondPos);
        parts.push(
          `STORIES_JSON has duplicate key "${dup.key}" in story object at index ${dup.objectIndex} (lines ${firstLoc.line},${secondLoc.line}).`
        );
      }
    }

    parts.push(
      `Each story must be a separate {...} object separated by },{. See retry feedback for the format contract.`
    );

    throw new Error(parts.join(" "));
  }

  // SJSN guard: empty array is a degenerate payload.
  if (stories.length === 0) {
    throw new Error(
      "STORIES_JSON is present but contains zero stories. " +
      "The planner must emit at least one story object."
    );
  }

  // Phase 1: validate every story before inserting anything.
  const seenIds = new Set<string>();
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const ac = s.acceptanceCriteria ?? s.acceptance_criteria;

    // ── Required field presence (existing) ──
    // Use == null (catches undefined/null) instead of ! (which would also
    // catch empty strings, hiding the dedicated title/description emptiness
    // checks below).
    if (s.id == null || s.title == null || s.description == null || !Array.isArray(ac) || ac.length === 0) {
      throw new Error(`STORIES_JSON story at index ${i} missing required fields (id, title, description, acceptanceCriteria)`);
    }

    // ── Id format: ^[A-Z]+-\d+$ ──
    if (!STORIES_JSON_STORY_ID_RE.test(String(s.id))) {
      throw new Error(
        `STORIES_JSON story at index ${i} has invalid id "${s.id}". ` +
        `Ids must match pattern UPPERCASE-DIGITS (e.g. US-001, fix-002).`
      );
    }

    // ── Duplicate id (existing) ──
    if (seenIds.has(s.id)) {
      throw new Error(`STORIES_JSON has duplicate story id "${s.id}"`);
    }
    seenIds.add(s.id);

    // ── Title non-empty non-whitespace ──
    if (typeof s.title !== "string" || s.title.trim().length === 0) {
      throw new Error(
        `STORIES_JSON story at index ${i} (id "${s.id}") has empty or whitespace-only title. ` +
        `Title must be a non-empty string.`
      );
    }

    // ── Description non-empty non-whitespace ──
    if (typeof s.description !== "string" || s.description.trim().length === 0) {
      throw new Error(
        `STORIES_JSON story at index ${i} (id "${s.id}") has empty or whitespace-only description. ` +
        `Description must be a non-empty string.`
      );
    }

    // ── AcceptanceCriteria: each item non-empty string ──
    for (let j = 0; j < ac.length; j++) {
      if (typeof ac[j] !== "string" || ac[j].trim().length === 0) {
        throw new Error(
          `STORIES_JSON story at index ${i} (id "${s.id}") has empty or non-string acceptanceCriteria[${j}]. ` +
          `Each acceptance criteria item must be a non-empty string.`
        );
      }
    }

    // ── Unknown extra fields: warn, not fatal ──
    for (const key of Object.keys(s)) {
      if (!KNOWN_STORY_FIELDS.has(key)) {
        logger.warn(
          `STORIES_JSON story at index ${i} (id "${s.id}") has unknown field "${key}" — tolerated but unexpected.`,
          { runId, storyIndex: i, storyId: s.id, field: key },
        );
      }
    }
  }

  // Phase 2: all stories valid — insert.
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 4, ?, ?)"
  );
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const ac = s.acceptanceCriteria ?? s.acceptance_criteria;
    insert.run(crypto.randomUUID(), runId, i, s.id, s.title, s.description, JSON.stringify(ac), now, now);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Abandoned Step Cleanup
// ══════════════════════════════════════════════════════════════════════

export const ABANDONED_THRESHOLD_MS = (getMaxRoleTimeoutSeconds() + 5 * 60) * 1000;

/**
 * TIME-CLOCKS (rule 2) — the explicit tolerance for this module's durable age
 * filters. This is deliberately zero: ABANDONED_THRESHOLD_MS already carries a
 * five-minute cushion on top of the role's max timeout, and the recovery
 * thresholds are caller-supplied (0 means "recover regardless of age"). Adding
 * slack here would widen those windows and break the documented 0 contract, so
 * the tolerance is named and zero rather than an unexplained literal.
 */
const STEP_AGE_TOLERANCE_MS = 0;

/**
 * Build an aggregate abandon-reason string for a run from the
 * story_abandonments table. Queries GROUP BY reason and produces a
 * human-readable summary like:
 *
 *   "abandon budget exhausted (9/8); reasons: 5x worker_lost, 3x no_work_release, 1x worker_timeout"
 *
 * When the table has no rows for the run (should not happen when
 * budget is actually exhausted, but guard anyway), returns a
 * sensible fallback that still mentions the budget cap.
 */
export function buildAbandonReasonAggregate(runId: string): string {
  const db = getDb();
  const rows = db.prepare(
    "SELECT reason, COUNT(*) as cnt FROM story_abandonments WHERE run_id = ? GROUP BY reason ORDER BY cnt DESC"
  ).all(runId) as { reason: string; cnt: number }[];

  if (rows.length === 0) {
    return `abandon budget exhausted (>${ABANDON_STORY_MAX}); reasons: (no per-story abandonment records found)`;
  }

  const total = rows.reduce((sum, r) => sum + r.cnt, 0);
  const reasons = rows.map(r => `${r.cnt}x ${r.reason}`).join(", ");
  return `abandon budget exhausted (${total}/${ABANDON_STORY_MAX}); reasons: ${reasons}`;
}

const MAX_ABANDON_RESETS = 5;
const ABANDON_STORY_MAX = 8;

/**
 * Find steps that have been "running" for too long and reset them to pending.
 * This catches cases where an agent claimed a step but never completed/failed it.
 * Exported so it can be called from medic/health-check crons independently of claimStep.
 */
export function cleanupAbandonedSteps(nowMs: number = Date.now()): void {
  const db = getDb();
  const thresholdMs = ABANDONED_THRESHOLD_MS;

  // TIME-CLOCKS (rule 2): select the candidate rows and age them in JS via the
  // shared instant helpers instead of SQL `julianday` arithmetic, so the one
  // durable-instant rule owns every staleness decision. Unparseable/missing
  // `updated_at` values yield `undefined` from `isOlderThan` and are therefore
  // treated as NOT stale (safe skip) — never a fabricated age.
  const abandonedSteps = db.prepare(
    "SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config, abandoned_count, updated_at FROM steps WHERE status = 'running'"
  ).all() as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null; abandoned_count: number;
    updated_at: string | null;
  }[];

  for (const step of abandonedSteps) {
    // Strictly older than the abandonment threshold. `isOlderThan` keeps the
    // original `> ?` semantics (including "exactly at threshold is fresh") and
    // safely skips unknown instants.
    if (!isOlderThan(step.updated_at, thresholdMs, nowMs, STEP_AGE_TOLERANCE_MS)) continue;

    // Skip loop steps waiting on verify_each (verify step still pending/running)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to abandonment handling.
      }
    }

    // Loop steps: apply per-story abandonment, not per-step retry
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, abandoned_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; abandoned_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newAbandoned = (story.abandoned_count ?? 0) + 1;
        const wfId = getWorkflowId(step.run_id);
        const abandonReason = "worker_timeout";

        // Persist abandonment into story_abandonments table (telemetry — must not block recovery)
        try {
          db.prepare(
            `INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO})`
          ).run(crypto.randomUUID(), story.id, step.run_id, abandonReason, newAbandoned, step.id);

          // Emit story.abandoned event with reason and abandoned_count
          emitEvent({
            ts: new Date().toISOString(),
            event: "story.abandoned",
            runId: step.run_id,
            workflowId: wfId,
            stepId: step.step_id,
            storyId: story.story_id,
            storyTitle: story.title,
            reason: abandonReason,
            abandonedCount: newAbandoned,
            detail: `Story ${story.story_id} abandoned (${newAbandoned}/${ABANDON_STORY_MAX}); reason: ${abandonReason}`,
          });
        } catch (err) {
          logger.warn(`Abandonment accounting failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}; continuing recovery regardless`, {
            runId: step.run_id,
            stepId: step.step_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (newAbandoned > ABANDON_STORY_MAX) {
          db.prepare(`UPDATE stories SET status = 'failed', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newAbandoned, story.id);
          db.prepare(`UPDATE steps SET status = 'failed', output = 'Story abandoned — abandon budget exhausted', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.id);
          db.prepare(`UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.run_id);
          const aggregate = buildAbandonReasonAggregate(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: `Abandoned — ${aggregate}` });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story abandoned — ${aggregate}` });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: `Story abandoned — ${aggregate}` });
          scheduleRunCronTeardown(step.run_id);
        } else {
          db.prepare(`UPDATE stories SET status = 'pending', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newAbandoned, story.id);
          db.prepare(`UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.id);
          emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story ${story.story_id} abandoned — reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})` });
          logger.info(`Abandoned step reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`, { runId: step.run_id, stepId: step.step_id });
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use abandoned_count, not retry_count
    const newAbandonCount = (step.abandoned_count ?? 0) + 1;
    if (newAbandonCount >= MAX_ABANDON_RESETS) {
      db.prepare(
        `UPDATE steps SET status = 'failed', output = 'Agent abandoned step without completing (' || ? || ' times)', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(newAbandonCount, newAbandonCount, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.run_id);
      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Retries exhausted — step failed` });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent abandoned step without completing" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step abandoned and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
    } else {
      db.prepare(
        `UPDATE steps SET status = 'pending', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(newAbandonCount, step.id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, detail: `Reset to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})` });
    }
  }

  // Reset running stories that are abandoned — don't touch "done" stories.
  // TIME-CLOCKS (rule 2): age in JS via the shared helper; unknown instants skip.
  const abandonedStories = db.prepare(
    "SELECT id, retry_count, max_retries, run_id, updated_at FROM stories WHERE status = 'running'"
  ).all() as { id: string; retry_count: number; max_retries: number; run_id: string; updated_at: string | null }[];

  for (const story of abandonedStories) {
    if (!isOlderThan(story.updated_at, thresholdMs, nowMs, STEP_AGE_TOLERANCE_MS)) continue;
    db.prepare(`UPDATE stories SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(story.id);
  }

  // Recover stuck pipelines: loop step done but no subsequent step pending/running
  const stuckLoops = db.prepare(`
    SELECT s.id, s.run_id, s.step_index FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.type = 'loop' AND s.status = 'done' AND r.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM steps s2 WHERE s2.run_id = s.run_id
      AND s2.step_index > s.step_index
      AND s2.status IN ('pending', 'running')
    )
    AND EXISTS (
      SELECT 1 FROM steps s3 WHERE s3.run_id = s.run_id
      AND s3.step_index > s.step_index
      AND s3.status = 'waiting'
    )
  `).all() as { id: string; run_id: string; step_index: number }[];

  for (const stuck of stuckLoops) {
    logger.info(`Recovering stuck pipeline after loop completion`, { runId: stuck.run_id, stepId: stuck.id });
    advancePipeline(stuck.run_id);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Orphaned Step Recovery (post-SIGKILL)
// ══════════════════════════════════════════════════════════════════════

/**
 * Recover orphaned running steps for a specific agent.
 * Called when pi exits abnormally (SIGKILL, non-zero exit) to prevent
 * steps from being permanently stuck at status='running' — peekStep only
 * matches pending/waiting, so an orphaned running step is invisible to
 * the polling cron and the run wedges silently.
 *
 * @param agentId - The agent ID whose running steps to recover
 * @param staleThresholdMs - Optional: only recover steps whose updated_at
 *   is older than this many milliseconds. When omitted, all running steps
 *   for the agent are recovered (use in post-exit handlers where we KNOW
 *   the agent just died).
 * @param timeoutRetryReason - Optional: human-readable reason for the
 *   timeout (e.g. "pi timed out after 1800000ms"). When provided, each
 *   recovered step's run context is augmented with `timeout_retry` so the
 *   retry prompt includes a signal that the prior attempt was interrupted
 *   and uncommitted work may exist on disk.
 * @param detailPrefix - Optional: prefix prepended to the event detail
 *   (e.g. "liveness-detected") so dashboards can distinguish recovery
 *   causes without parsing the event name alone.
 * @param exitCode - Optional: exit code of the harness process (forensics).
 * @param signal - Optional: signal that killed the harness process (forensics).
 * @param stderrTail - Optional: sanitized stderr tail from the harness (forensics).
 * @param timedOut - Optional: when true, the round was killed by the motor's
 *   own worker time ceiling (the harness adapter's timedOut signal). A
 *   workerJobId-scoped recovery with timedOut === true is classified as a
 *   ceiling expiry (step.ceiling_expiry, runs.ceiling_expiry_count) rather
 *   than a harness loss (step.worker_lost, runs.worker_lost_count) — both
 *   reset the step/story exactly the same way; only the observability
 *   counters and event names differ.
 * @param abandonReason - Optional: why the prior execution is being
 *   abandoned. `"paused_by_operator"` selects the PKIL pause class: the
 *   step/story is reset to pending WITHOUT consuming any retry/abandon
 *   budget, no worker_lost/ceiling counter is bumped, and step.paused_kill
 *   is emitted instead of step.worker_lost. A pause is never exhaustion, so
 *   it never triggers the retry-exhaustion / on_fail.retry_step reroute
 *   path. All other reasons keep the existing worker-lost semantics.
 */

/**
 * RVOC US-002: recovery class of a re-dispatched claimed step, carried as
 * the `reason` of the step.respawned event. Mirrors the recovery-event
 * selection in recoverOrphanedStepsForAgent: a workerJobId-scoped round
 * killed at the worker time ceiling is `ceiling_expiry`; a round that
 * replied NO_WORK and released a dangling claim is `no_work_release`; a
 * round torn down by a non-drain operator pause is `paused_by_operator`
 * (PKIL, no retry charged); a recovery with no worker job (stale sweeper,
 * control-plane release) is `timeout`; everything else that lost a live
 * worker is `worker_lost`.
 */
function respawnReasonFor(
  abandonReason: string | undefined,
  workerJobId: string | undefined,
  timedOut: boolean | undefined,
): "worker_lost" | "timeout" | "ceiling_expiry" | "no_work_release" | "paused_by_operator" {
  if (abandonReason === "paused_by_operator") return "paused_by_operator";
  if (workerJobId !== undefined && timedOut === true) return "ceiling_expiry";
  if (abandonReason === "no_work_release") return "no_work_release";
  if (workerJobId === undefined) return "timeout";
  return "worker_lost";
}

export function recoverOrphanedStepsForAgent(
  agentId: string,
  runId: string,
  staleThresholdMs?: number,
  timeoutRetryReason?: string,
  failureReason?: string,
  workerJobId?: string,
  abandonReason?: string,
  detailPrefix?: string,
  exitCode?: number | null,
  signal?: string | null,
  stderrTail?: string,
  timedOut?: boolean,
  nowMs: number = Date.now(),
): { recovered: number; failed: number; skipped: number } {
  const db = getDb();

  // Run-scoped query. Every caller (polling round, control plane,
  // shutdown paths) supplies a runId so concurrent runs of the same
  // workflow + agent are isolated.
  const clauses: string[] = ["agent_id = ?", "status = 'running'", "run_id = ?"];
  const params: (string | number)[] = [agentId, runId];
  // Ownership-aware filter: when workerJobId is provided, skip steps
  // claimed by a different worker (claim_job_id mismatch). Steps with
  // NULL claim_job_id (legacy, pre-ownership) are always recovered.
  if (workerJobId !== undefined) {
    clauses.push("(claim_job_id IS NULL OR claim_job_id = ?)");
    params.push(workerJobId);
  }
  const query = `SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config, claim_pid, claim_job_id, updated_at
       FROM steps
       WHERE ${clauses.join(" AND ")}`;

  const steps = db.prepare(query).all(...params) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null;
    claim_pid: number | null; claim_job_id: string | null; updated_at: string | null;
  }[];

  // TIME-CLOCKS (rule 2): the stale-threshold filter is a numeric durable-age
  // check via the shared instant helpers, never SQL `julianday` arithmetic.
  // Semantics preserved: the old SQL used `>= ?`, so `staleThresholdMs = 0`
  // still recovers every running step regardless of age. Unparseable/missing
  // `updated_at` yields `undefined` and is NOT stale (safe skip).
  const staleSteps = staleThresholdMs === undefined
    ? steps
    : steps.filter((s) => {
        const age = instantAgeMs(s.updated_at, nowMs);
        return age !== undefined && age >= staleThresholdMs + STEP_AGE_TOLERANCE_MS;
      });

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  const releaseRecoveredSuiteClaims = (recoveredRunId: string, recoveredStepId: string): void => {
    void import("../server/control-client.js")
      .then((client) => client.releaseSuiteClaimsByOwner(recoveredRunId, recoveredStepId, "cancel"))
      .catch((err) => {
        logger.warn("Suite claim release after step recovery failed", {
          runId: recoveredRunId,
          stepId: recoveredStepId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  for (const step of staleSteps) {
    // Skip loop steps waiting on verify_each (mid-iteration pause, not orphaned)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            skipped++;
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to recovery.
      }
    }

    // Recovery means the prior execution is being abandoned. Release only
    // this run/step's suite claims; PID collision reclaim remains the fallback
    // if the local control plane cannot be reached.
    releaseRecoveredSuiteClaims(step.run_id, step.step_id);

    // Loop steps with current_story_id: handle story-level abandonment recovery
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, abandoned_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; abandoned_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newAbandoned = (story.abandoned_count ?? 0) + 1;
        const wfId = getWorkflowId(step.run_id);
        const effectiveReason = abandonReason ?? "worker_lost";

        // PKIL (US-004): an operator pause is not a crash. Reset the
        // story/step claim to pending WITHOUT charging the story abandon
        // budget, and emit step.paused_kill instead of step.worker_lost so a
        // pause is distinguishable from a genuine harness loss. A pause is
        // never retry exhaustion, so this branch must not fall through to the
        // abandon-budget / story.failed path below.
        if (effectiveReason === "paused_by_operator") {
          const currentAbandoned = story.abandoned_count ?? 0;
          db.prepare(`UPDATE stories SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(story.id);
          db.prepare(`UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.id);
          const pausePrefix = detailPrefix ? `[${detailPrefix}] ` : "";
          const pauseDetail = `${pausePrefix}Operator pause killed the worker without completing story ${story.story_id}; reset to pending (no abandon charged; story abandon ${currentAbandoned}/${ABANDON_STORY_MAX})`;
          try {
            emitEvent({
              ts: new Date().toISOString(),
              event: "step.paused_kill",
              runId: step.run_id,
              workflowId: wfId,
              stepId: step.step_id,
              agentId,
              storyId: story.story_id,
              storyTitle: story.title,
              retry: step.retry_count,
              exitCode: exitCode ?? undefined,
              signal: signal ?? undefined,
              stderrTail,
              detail: pauseDetail,
            });
          } catch (err) {
            logger.warn(`step.paused_kill event emit failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
              runId: step.run_id,
              stepId: step.step_id,
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // RVOC US-002 ordering: the respawn record follows the recovery
          // event. The story's retry/abandon counters are unchanged, so the
          // respawn reports the pre-pause retry value.
          try {
            emitEvent({
              ts: new Date().toISOString(),
              event: "step.respawned",
              runId: step.run_id,
              workflowId: wfId,
              stepId: step.step_id,
              agentId,
              priorPid: step.claim_pid ?? undefined,
              priorRound: step.claim_job_id ?? undefined,
              reason: respawnReasonFor(abandonReason, workerJobId, timedOut),
              retry: step.retry_count,
              detail: `Step respawned after step.paused_kill (story ${story.story_id}); prior worker pid ${step.claim_pid ?? "unknown"}, round ${step.claim_job_id ?? "unknown"}`,
            });
          } catch (err) {
            logger.warn(`step.respawned event emit failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
              runId: step.run_id,
              stepId: step.step_id,
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          logger.info(`Orphaned step recovery: story ${story.story_id} reset to pending after operator pause (no abandon charged)`, { runId: step.run_id, stepId: step.step_id, agentId });
          recovered++;
          continue;
        }

        // Persist abandonment into story_abandonments table (telemetry — must not block recovery)
        try {
          db.prepare(
            `INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO})`
          ).run(crypto.randomUUID(), story.id, step.run_id, effectiveReason, newAbandoned, step.id);

          // Emit story.abandoned event with reason and abandoned_count
          emitEvent({
            ts: new Date().toISOString(),
            event: "story.abandoned",
            runId: step.run_id,
            workflowId: wfId,
            stepId: step.step_id,
            agentId,
            storyId: story.story_id,
            storyTitle: story.title,
            reason: effectiveReason,
            abandonedCount: newAbandoned,
            detail: `Story ${story.story_id} abandoned (${newAbandoned}/${ABANDON_STORY_MAX}); reason: ${effectiveReason}`,
          });
        } catch (err) {
          logger.warn(`Abandonment accounting failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}; continuing recovery regardless`, {
            runId: step.run_id,
            stepId: step.step_id,
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (newAbandoned > ABANDON_STORY_MAX) {
          db.prepare(`UPDATE stories SET status = 'failed', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newAbandoned, story.id);
          db.prepare(`UPDATE steps SET status = 'failed', output = 'Agent terminated without completing story; abandon budget exhausted', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.id);
          db.prepare(`UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.run_id);
          const aggregate = buildAbandonReasonAggregate(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: `Agent terminated — ${aggregate}` });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Agent terminated without completing story; ${aggregate}` });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: `Agent terminated without completing story; ${aggregate}` });
          scheduleRunCronTeardown(step.run_id);
          failed++;
        } else {
          db.prepare(`UPDATE stories SET status = 'pending', abandoned_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newAbandoned, story.id);
          db.prepare(`UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.id);
          const isCeilingExpiry = workerJobId !== undefined && timedOut === true;
          const storyRecoveryEvent = workerJobId !== undefined
            ? (isCeilingExpiry ? "step.ceiling_expiry" : "step.worker_lost")
            : "step.timeout";
          const storyRecoveryDetail = workerJobId !== undefined
            ? (isCeilingExpiry
              ? `Worker ${workerJobId} hit the worker time ceiling without completing story ${story.story_id}; reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`
              : `Worker ${workerJobId} exited without completing story ${story.story_id}; reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`)
            : `Agent terminated; story ${story.story_id} reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`;
          const storyPrefix = detailPrefix ? `[${detailPrefix}] ` : "";
          if (storyRecoveryEvent === "step.ceiling_expiry") {
            db.prepare("UPDATE runs SET ceiling_expiry_count = ceiling_expiry_count + 1 WHERE id = ?").run(step.run_id);
          } else if (storyRecoveryEvent === "step.worker_lost") {
            db.prepare("UPDATE runs SET worker_lost_count = worker_lost_count + 1 WHERE id = ?").run(step.run_id);
          }
          try {
            emitEvent({
              ts: new Date().toISOString(),
              event: storyRecoveryEvent,
              runId: step.run_id,
              workflowId: wfId,
              stepId: step.step_id,
              detail: storyPrefix + storyRecoveryDetail,
              ...(storyRecoveryEvent === "step.worker_lost" ? { exitCode: exitCode ?? undefined, signal: signal ?? undefined, stderrTail } : {}),
              ...(storyRecoveryEvent === "step.ceiling_expiry" ? { timedOut: true, exitCode: exitCode ?? undefined, signal: signal ?? undefined, stderrTail } : {}),
            });
          } catch (err) {
            logger.warn(`Recovery event emit failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
              runId: step.run_id,
              stepId: step.step_id,
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // RVOC US-002: emit step.respawned AFTER the recovery event so the
          // stream reads step.running → step.worker_lost/timeout/ceiling_expiry
          // → step.respawned → step.running — consumers can distinguish a
          // respawn from an anomalous duplicate claim. Story-level recovery
          // does not bump the step's own retry counter; report the current one.
          try {
            emitEvent({
              ts: new Date().toISOString(),
              event: "step.respawned",
              runId: step.run_id,
              workflowId: wfId,
              stepId: step.step_id,
              agentId,
              priorPid: step.claim_pid ?? undefined,
              priorRound: step.claim_job_id ?? undefined,
              reason: respawnReasonFor(abandonReason, workerJobId, timedOut),
              retry: step.retry_count,
              detail: `Step respawned after ${storyRecoveryEvent} (story ${story.story_id}); prior worker pid ${step.claim_pid ?? "unknown"}, round ${step.claim_job_id ?? "unknown"}`,
            });
          } catch (err) {
            logger.warn(`step.respawned event emit failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
              runId: step.run_id,
              stepId: step.step_id,
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          logger.info(`Orphaned step recovery: story ${story.story_id} reset to pending (abandon ${newAbandoned}/${ABANDON_STORY_MAX})`, { runId: step.run_id, stepId: step.step_id, agentId });
          if (timeoutRetryReason) {
            try {
              setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
            } catch (err) {
              logger.warn(`setRunContextKey timeout_retry failed for run ${step.run_id}: ${err instanceof Error ? err.message : String(err)}`, {
                runId: step.run_id,
                stepId: step.step_id,
                agentId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          recovered++;
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use step retry_count
    const newRetry = step.retry_count + 1;
    const wfId = getWorkflowId(step.run_id);

    // PKIL (US-004): an operator pause is not a crash and never charges the
    // retry budget. Reset the step to pending with the SAME retry_count, emit
    // step.paused_kill instead of step.worker_lost/step.timeout, and skip the
    // exhaustion / on_fail.retry_step reroute path entirely (a pause is not
    // exhaustion).
    if (abandonReason === "paused_by_operator") {
      db.prepare(
        `UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.id);
      const pausePrefix = detailPrefix ? `[${detailPrefix}] ` : "";
      const pauseDetail = `${pausePrefix}Operator pause killed the worker without completing step; reset to pending (retry ${step.retry_count}/${step.max_retries}, no retry charged)`;
      emitEvent({
        ts: new Date().toISOString(),
        event: "step.paused_kill",
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        agentId,
        retry: step.retry_count,
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
        stderrTail,
        detail: pauseDetail,
      });
      // RVOC US-002 ordering: the respawn record follows the recovery event.
      // The retry counter is unchanged, so the respawn reports the pre-pause
      // retry value.
      try {
        emitEvent({
          ts: new Date().toISOString(),
          event: "step.respawned",
          runId: step.run_id,
          workflowId: wfId,
          stepId: step.step_id,
          agentId,
          priorPid: step.claim_pid ?? undefined,
          priorRound: step.claim_job_id ?? undefined,
          reason: respawnReasonFor(abandonReason, workerJobId, timedOut),
          retry: step.retry_count,
          detail: `Step respawned after step.paused_kill; prior worker pid ${step.claim_pid ?? "unknown"}, round ${step.claim_job_id ?? "unknown"}`,
        });
      } catch (err) {
        logger.warn(`step.respawned event emit failed (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
          runId: step.run_id,
          stepId: step.step_id,
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info(`Orphaned step reset to pending after operator pause (retry ${step.retry_count}/${step.max_retries}, no retry charged)`, { runId: step.run_id, stepId: step.step_id, agentId });
      recovered++;
      continue;
    }

    if (newRetry > step.max_retries) {
      // ── RETR: check on_fail.retry_step before failing the run ──
      // Orphan recovery exhaustion means the agent (or harness) died
      // without completing or failing the step. If the workflow declares
      // a retry_step target, reroute instead of killing the run.
      const orphanRecoveryReason = "Agent terminated without completing step; retries exhausted";
      let orphanFailureReason = orphanRecoveryReason;
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id,
          orphanRecoveryReason);
        if (rerouteResult === "rerouted") {
          // Rerouted successfully — do not count this step as failed.
          // The run stays alive; recovered++ to indicate we handled it.
          recovered++;
          continue;
        }
        if (rerouteResult === "invalid_target") {
          const policy = getOnFailPolicySync(step.run_id, step.step_id);
          logger.error(`Run failed: step "${step.step_id}" declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step (must have lower step_index).`, { runId: step.run_id, stepId: step.step_id, agentId });
        }
        if (rerouteResult === "target_moved_exhausted") {
          // REROUTE-BUDGET: never silently drop the sentinel — surface the
          // legible class so the terminal writes below stay greppable.
          orphanFailureReason = buildTargetMovedExhaustedReason(
            step.id,
            getOnFailPolicySync(step.run_id, step.step_id),
            orphanRecoveryReason,
          );
        }
        // budget_exhausted / not_found fall through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        `UPDATE steps SET status = 'failed', retry_count = ?, output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(newRetry, orphanFailureReason, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: orphanFailureReason });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: orphanFailureReason });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step terminated and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      logger.warn(`Orphaned step retries exhausted`, { runId: step.run_id, stepId: step.step_id, agentId, retryCount: newRetry, maxRetries: step.max_retries });
      failed++;
    } else {
      // Persist failureReason into step.output so the next claimStep surfaces
      // it as `retry_feedback` to the retried agent. claimStep at line ~847
      // populates context.retry_feedback from step.output when retry_count>0.
      if (failureReason) {
        db.prepare(
          `UPDATE steps SET status = 'pending', retry_count = ?, output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, failureReason, step.id);
      } else {
        db.prepare(
          `UPDATE steps SET status = 'pending', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, step.id);
      }
      const isCeilingExpiry = workerJobId !== undefined && timedOut === true;
      const stepRecoveryEvent = workerJobId !== undefined
        ? (isCeilingExpiry ? "step.ceiling_expiry" : "step.worker_lost")
        : "step.timeout";
      const stepRecoveryDetail = workerJobId !== undefined
        ? (isCeilingExpiry
          ? `Worker ${workerJobId} hit the worker time ceiling without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`
          : `Worker ${workerJobId} exited without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`)
        : `Agent terminated without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`;
      const stepPrefix = detailPrefix ? `[${detailPrefix}] ` : "";
      if (stepRecoveryEvent === "step.ceiling_expiry") {
        db.prepare("UPDATE runs SET ceiling_expiry_count = ceiling_expiry_count + 1 WHERE id = ?").run(step.run_id);
      } else if (stepRecoveryEvent === "step.worker_lost") {
        db.prepare("UPDATE runs SET worker_lost_count = worker_lost_count + 1 WHERE id = ?").run(step.run_id);
      }
      emitEvent({
        ts: new Date().toISOString(),
        event: stepRecoveryEvent,
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        detail: stepPrefix + stepRecoveryDetail,
        ...(stepRecoveryEvent === "step.worker_lost" ? { exitCode: exitCode ?? undefined, signal: signal ?? undefined, stderrTail } : {}),
        ...(stepRecoveryEvent === "step.ceiling_expiry" ? { timedOut: true, exitCode: exitCode ?? undefined, signal: signal ?? undefined, stderrTail } : {}),
      });
      // RVOC US-002: emit step.respawned AFTER the recovery event so the
      // stream reads step.running → step.worker_lost/timeout/ceiling_expiry
      // → step.respawned → step.running — consumers can distinguish a
      // respawn from an anomalous duplicate claim. Carries the recovered
      // claim's worker identity (claim_pid / claim_job_id) and the new
      // retry count. Telemetry-only: never blocks recovery.
      try {
        emitEvent({
          ts: new Date().toISOString(),
          event: "step.respawned",
          runId: step.run_id,
          workflowId: wfId,
          stepId: step.step_id,
          agentId,
          priorPid: step.claim_pid ?? undefined,
          priorRound: step.claim_job_id ?? undefined,
          reason: respawnReasonFor(abandonReason, workerJobId, timedOut),
          retry: newRetry,
          detail: `Step respawned after ${stepRecoveryEvent}; prior worker pid ${step.claim_pid ?? "unknown"}, round ${step.claim_job_id ?? "unknown"}`,
        });
      } catch (err) {
        logger.warn(`step.respawned event emit failed (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
          runId: step.run_id,
          stepId: step.step_id,
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info(`Orphaned step reset to pending (retry ${newRetry}/${step.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
      if (timeoutRetryReason) {
        setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
      }
      recovered++;
    }
  }

  return { recovered, failed, skipped };
}

/**
 * The calling process's own process-group id (procfs on Linux, `ps` on
 * macOS — see lib/proc-info.ts).
 *
 * Used by `step claim` to record WorkerOwnership.pgid: the CLI runs as a
 * descendant of the harness process, which the scheduler spawns detached
 * (its own group leader), so the CLI's pgid IS the harness process group.
 * Returns null on lookup failure — callers must tolerate it.
 */
export function getOwnProcessGroupId(): number | null {
  return getPgid(process.pid);
}

/**
 * Recover running steps whose claiming worker process is dead.
 *
 * A daemon crash/kill (machine reboot, OOM, SIGKILL, an agent stopping the
 * daemon) orphans in-flight steps: they sit at status='running' with a
 * claim_pid that no longer exists, invisible to peek-based dispatch, and
 * the age-based stale sweep only reclaims them after 1.5× the step timeout
 * (up to 45 minutes). This sweep detects the dead worker directly and
 * requeues immediately. Called from the daemon reconciler (first tick ~1s
 * after startup, then every cycle), so a restarted daemon un-wedges
 * interrupted runs right away (MOTOR-CONTRACT.md C18).
 *
 * Survivor guard: an UNGRACEFUL daemon death (SIGKILL, power loss) does not
 * kill the daemon's detached harness children — the agent may still be
 * working. When the step's claim_pgid (the harness process group, recorded
 * at claim time) is still alive, the step is left alone: requeuing it would
 * put two agents in the same workdir. The survivor either reports normally
 * (late completions are accepted, C5) or eventually dies/hangs and is
 * reclaimed by this sweep or the age-based one.
 *
 * Steps without claim_pid (legacy/manual claims) are left to the age-based
 * sweep — liveness can't be determined for them. Pid/pgid reuse can make a
 * dead worker look alive; that also falls back to the age-based sweep.
 */
export function recoverStepsWithDeadWorkers(): {
  recovered: number;
  failed: number;
  skipped: number;
  runIds: string[];
} {
  const db = getDb();
  const steps = db.prepare(
    `SELECT s.id, s.agent_id, s.run_id, s.claim_pid, s.claim_pgid, s.claim_job_id
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.status = 'running'
       AND s.claim_pid IS NOT NULL
       AND r.status = 'running'`,
  ).all() as {
    id: string;
    agent_id: string;
    run_id: string;
    claim_pid: number;
    claim_pgid: number | null;
    claim_job_id: string | null;
  }[];

  const totals = { recovered: 0, failed: 0, skipped: 0, runIds: [] as string[] };

  const processAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH → dead. EPERM → alive but not ours (treat as alive).
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  for (const step of steps) {
    if (processAlive(step.claim_pid)) continue;

    // Scheduler is dead — but its detached harness may have survived.
    // kill(-pgid, 0) probes the whole process group.
    if (step.claim_pgid && step.claim_pgid > 0 && processAlive(-step.claim_pgid)) {
      totals.skipped += 1;
      logger.info("Dead-worker sweep left step to a surviving harness group", {
        runId: step.run_id,
        stepId: step.id,
        agentId: step.agent_id,
        deadWorkerPid: step.claim_pid,
        survivingPgid: step.claim_pgid,
      });
      continue;
    }

    try {
      const result = recoverOrphanedStepsForAgent(
        step.agent_id,
        step.run_id,
        undefined,
        undefined,
        `Worker process ${step.claim_pid} died without reporting (daemon restart or crash); step requeued.`,
        step.claim_job_id ?? undefined,
        "worker_died",
        undefined, // detailPrefix
        undefined, // exitCode
        undefined, // signal
        undefined, // stderrTail
      );
      totals.recovered += result.recovered;
      totals.failed += result.failed;
      totals.skipped += result.skipped;
      if ((result.recovered > 0 || result.failed > 0) && !totals.runIds.includes(step.run_id)) {
        totals.runIds.push(step.run_id);
      }
    } catch (err) {
      totals.failed += 1;
      logger.error(
        `recoverStepsWithDeadWorkers: per-step recovery failed for run ${step.run_id}, step ${step.id}, agent ${step.agent_id}: ${err instanceof Error ? err.message : String(err)}; continuing sweep`,
        { runId: step.run_id, stepId: step.id, agentId: step.agent_id },
      );
    }
  }

  return totals;
}

// ══════════════════════════════════════════════════════════════════════
// PGID Liveness Watchdog
// ══════════════════════════════════════════════════════════════════════

const LIVENESS_GRACE_PERIOD_MS = 30_000;

/**
 * Liveness watchdog: detect steps whose claiming worker process group is
 * dead and recover them immediately.
 *
 * The stale-claim sweeper (executeDispatchRound) waits timeout×1.5 — up to
 * 60-90 minutes. This watchdog runs per-tick (piggybacks on the existing
 * dispatch interval), uses the saved claim_pgid to check process-group
 * liveness directly with kill(-pgid, 0), and recovers dead-worker steps
 * within seconds-to-minutes (up to the tick interval + grace period).
 *
 * Design (per spec):
 * - Only checks steps with claim_pgid > 0 (worker-ownership-aware claims).
 * - Steps without claim_pgid (legacy/manual) fall through to the
 *   timeout×1.5 sweeper — do not guess.
 * - Never kills or signals any process — only releases claims of
 *   already-dead workers.
 * - Safe against PID reuse: a reused pgid causes at worst a delayed
 *   recovery (falls back to timeout sweeper), never a false kill.
 * - Works on Linux and macOS (no /proc dependence — uses signal-0).
 * - Grace period (30s from claim_updated_at): skips claims younger than
 *   30s to avoid racing a round that just finished and is mid-report.
 *
 * Defense-in-depth (Layer 2): before recovering a step, cross-checks
 * the daemon's inFlightChildren map. If claim_job_id has a live in-flight
 * child in this daemon, the worker is provably alive regardless of what
 * the claim_pgid probe says — skip recovery. This prevents mass-misfires
 * on macOS where claim_pgid may record a transient tool-call subshell's
 * PGID instead of the true harness group. Only when the job is unknown
 * (daemon restarted) or its child is truly dead may the claim_pgid
 * probe decide.
 *
 * Events: recovered steps emit step.worker_lost with a detail prefix of
 * "liveness-detected" so dashboards/logs can distinguish PGID-liveness
 * recovery from timeout-based and CLMR recovery.
 *
 * @param inFlightChildren  Optional map of live jobId → {pid, pgid, killed}
 *   held by the daemon. Passed from executeDispatchRound for defense-in-depth.
 *
 * Returns { recovered, failed, skipped, runIds } for callers that need
 * to nudge dispatch or log results (e.g. the daemon reconciler).
 */
export function checkRunningWorkersLiveness(
  inFlightChildren?: Map<string, { pid: number; pgid: number; killed: boolean }>,
  nowMs: number = Date.now(),
): {
  recovered: number;
  failed: number;
  skipped: number;
  runIds: string[];
} {
  const db = getDb();

  const steps = db.prepare(
    `SELECT s.id, s.agent_id, s.run_id, s.claim_pgid, s.claim_job_id, s.claim_updated_at
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.status = 'running'
       AND s.claim_pgid > 0
       AND r.status = 'running'`,
  ).all() as {
    id: string;
    agent_id: string;
    run_id: string;
    claim_pgid: number;
    claim_job_id: string | null;
    claim_updated_at: string | null;
  }[];

  const totals = { recovered: 0, failed: 0, skipped: 0, runIds: [] as string[] };

  const pgidAlive = (pgid: number): boolean => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      // ESRCH → dead. EPERM → alive but not ours (treat as alive).
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  for (const step of steps) {
    // Process group still exists → worker is alive, leave step alone.
    if (pgidAlive(step.claim_pgid)) continue;

    // Grace period: skip claims younger than 30s to avoid racing a
    // round that just finished and is mid-report. TIME-CLOCKS (rule 2):
    // numeric durable-age check via the shared instant helper, never SQL
    // julianday arithmetic. An unparseable/missing claim_updated_at yields
    // `undefined` and is conservatively skipped (left to the timeout sweeper).
    const claimAgeMs = instantAgeMs(step.claim_updated_at, nowMs);
    if (claimAgeMs === undefined) {
      // No claim timestamp available — can't determine freshness.
      // Be conservative: leave it for the timeout sweeper.
      totals.skipped += 1;
      continue;
    }
    if (claimAgeMs < LIVENESS_GRACE_PERIOD_MS + STEP_AGE_TOLERANCE_MS) {
      totals.skipped += 1;
      continue;
    }

    // Defense-in-depth: if the daemon holds a live in-flight child for this
    // step's claim_job_id, the worker is provably alive regardless of what
    // the claim_pgid probe says. On macOS the claim_pgid can record a
    // transient tool-call subshell's PGID instead of the harness group,
    // causing the watchdog to falsely declare ALIVE workers dead. This
    // cross-check alone prevents all such misfires.
    if (step.claim_job_id && inFlightChildren) {
      const inflight = inFlightChildren.get(step.claim_job_id);
      if (inflight && !inflight.killed) {
        try {
          process.kill(inflight.pid, 0);
          // Worker is alive — skip recovery.
          totals.skipped += 1;
          continue;
        } catch {
          // Child is dead — fall through to normal recovery path.
        }
      }
    }

    // Dead worker process group detected — recover the step immediately.
    const failureReason =
      `Worker process group ${step.claim_pgid} detected as dead by liveness watchdog; step requeued.`;

    try {
      const result = recoverOrphanedStepsForAgent(
        step.agent_id,
        step.run_id,
        undefined, // no stale threshold — liveness check is authoritative
        undefined, // no timeout retry reason
        failureReason,
        step.claim_job_id ?? undefined,
        "liveness_detected",
        "liveness-detected", // detailPrefix for event differentiation
        undefined, // exitCode
        undefined, // signal
        undefined, // stderrTail
      );
      totals.recovered += result.recovered;
      totals.failed += result.failed;
      if ((result.recovered > 0 || result.failed > 0) && !totals.runIds.includes(step.run_id)) {
        totals.runIds.push(step.run_id);
      }
    } catch (err) {
      totals.failed += 1;
      logger.error(
        `checkRunningWorkersLiveness: per-step recovery failed for run ${step.run_id}, step ${step.id}, agent ${step.agent_id}: ${err instanceof Error ? err.message : String(err)}; continuing sweep`,
        { runId: step.run_id, stepId: step.id, agentId: step.agent_id },
      );
    }
  }

  return totals;
}

// ══════════════════════════════════════════════════════════════════════
// Frontend Change Detection
// ══════════════════════════════════════════════════════════════════════

/**
 * Compute whether a branch has frontend changes relative to main.
 * Returns 'true' or 'false' as a string for template context.
 */
export function computeHasFrontendChanges(repo: string, branch: string): string {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `main..${branch}`], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const files = output.trim().split("\n").filter((f) => f.length > 0);
    return isFrontendChange(files) ? "true" : "false";
  } catch {
    return "false";
  }
}

/**
 * Parse a run's context JSON safely. Returns {} on parse failure after
 * emitting a run.context_corrupt event with a bounded 200-char prefix
 * of the raw value and logging a warning.
 */
export function parseRunContext(runId: string, raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    const boundedPrefix = raw.slice(0, 200);
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.context_corrupt",
      runId,
      detail: boundedPrefix,
    });
    logger.warn(`run.context_corrupt: invalid JSON in runs.context, using empty context`, {
      runId,
      contextPrefix: boundedPrefix,
    });
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Set a key-value pair in a run's context JSON field.
 * Reads existing context, sets the key, and writes back.
 */
export function setRunContextKey(runId: string, key: string, value: string): void {
  const db = getDb();
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!run) return;
  const context: Record<string, string> = parseRunContext(runId, run.context);
  context[key] = value;
  db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), runId);
}

/**
 * Remove a key from a run's context JSON field (a context rewrite that
 * deletes instead of setting). No-op when the run is missing or the key is
 * absent. Synchronous, like setRunContextKey, so callers can perform a
 * status UPDATE and a marker clear with no await in between (PAUS US-003:
 * a cancelled pending drain must never half-exist with the marker cleared
 * but scheduling_status still 'draining_pause', or vice versa).
 */
export function removeRunContextKey(runId: string, key: string): void {
  const db = getDb();
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!run) return;
  const context: Record<string, string> = parseRunContext(runId, run.context);
  if (!(key in context)) return;
  delete context[key];
  db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), runId);
}

function runHasStories(runId: string): boolean {
  const db = getDb();
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
  ).get(runId) as { cnt: number } | undefined;
  return (total?.cnt ?? 0) > 0;
}

// ══════════════════════════════════════════════════════════════════════
// Peek (Lightweight Work Check)
// ══════════════════════════════════════════════════════════════════════

export type PeekResult = "HAS_WORK" | "NO_WORK";

/**
 * Lightweight check: does this agent have any pending/waiting steps in active runs?
 * Unlike claimStep(), this runs a single cheap COUNT query — no cleanup, no context resolution.
 * Returns "HAS_WORK" if any pending/waiting steps exist, "NO_WORK" otherwise.
 */
export function peekStep(agentId: string, runId: string): PeekResult {
  // Defense-in-depth: strip run- prefix (US-013)
  runId = stripIdPrefix(runId);
  const db = getDb();
  // Match 'pending' only — 'waiting' steps are still upstream-blocked, so
  // reporting them as work would cause spurious claim attempts.
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ?
       AND s.status = 'pending'
       AND r.status = 'running'`,
  ).get(agentId, runId) as { cnt: number };
  return row.cnt > 0 ? "HAS_WORK" : "NO_WORK";
}

// ══════════════════════════════════════════════════════════════════════
// Pre-claim death counter (OUTAGE-ROUNDS / SCLS)
// ══════════════════════════════════════════════════════════════════════

/** Row + human step id of the first pending step an agent can claim. */
export interface PendingStepRef {
  /** steps.id (the row id used by the counter UPDATE). */
  id: string;
  /** steps.step_id (the human/workflow-level id, e.g. "execute"). */
  stepId: string;
}

/**
 * OUTAGE-ROUNDS (SCLS US-004): return the first pending step this
 * (agentId, runId) would claim, ordered by step_index then step_id —
 * mirroring `peekStep`/`claimStep` ordering. Returns null when no unclaimed
 * step exists. Used by the scheduler's pre-claim death tracker to decide
 * whether a long nonzero-exit round died BEFORE doing any work.
 *
 * Read-only: it neither claims nor mutates the step.
 */
export function findPendingStepForAgent(agentId: string, runId: string): PendingStepRef | null {
  // Defense-in-depth: strip run- prefix (US-013)
  runId = stripIdPrefix(runId);
  const db = getDb();
  const row = db.prepare(
    `SELECT id, step_id FROM steps
     WHERE agent_id = ? AND run_id = ? AND status = 'pending'
     ORDER BY step_index ASC, step_id ASC
     LIMIT 1`,
  ).get(agentId, runId) as { id: string; step_id: string } | undefined;
  return row ? { id: row.id, stepId: row.step_id } : null;
}

/**
 * OUTAGE-ROUNDS (SCLS US-004): increment one step's durable
 * `preclaim_death_count` and return the new value.
 *
 * Deliberately additive: it touches ONLY the counter. No retry_count
 * increment, no status transition, no claim timestamp — a pre-claim death
 * consumes no retry budget (the caller owns any backoff/escalation, which
 * uses its own counter). Returns the post-increment value so the caller can
 * log/surface it; returns 0 when the step row is missing.
 */
export function incrementPreclaimDeathCount(stepId: string): number {
  const db = getDb();
  db.prepare(
    "UPDATE steps SET preclaim_death_count = preclaim_death_count + 1 WHERE id = ?",
  ).run(stepId);
  const row = db.prepare("SELECT preclaim_death_count FROM steps WHERE id = ?").get(stepId) as
    | { preclaim_death_count: number }
    | undefined;
  return row?.preclaim_death_count ?? 0;
}

// ══════════════════════════════════════════════════════════════════════
// Conditional Auto-Complete (Zero-Token Dispatch Primitive)
// ══════════════════════════════════════════════════════════════════════

export type AutoCompleteConditionalOutcome = "auto_completed" | "dispatched" | "none";

/**
 * WAVE-A US-003: resolve whether a run-context activation flag is SET.
 *
 * Fail-closed by design: only clearly-falsy values (absent, empty,
 * whitespace, 'false'/'0'/'no'/'off'/'null'/'undefined', case-insensitive)
 * count as UNSET. Anything else — including unexpected values — counts as
 * SET and dispatches the step normally. When in doubt, spend tokens rather
 * than silently skipping a review.
 */
export function isRunContextFlagSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v.length === 0) return false;
  if (v === "false" || v === "0" || v === "no" || v === "off" || v === "null" || v === "undefined") {
    return false;
  }
  return true;
}

/**
 * WAVE-A US-003: zero-token auto-complete for a pending `type: conditional`
 * step whose activation flag is UNSET in run context.
 *
 * The dispatch motor calls this IN-PROCESS after its deterministic peek
 * reports HAS_WORK and BEFORE any harness spawn. When the step's declared
 * condition (steps.conditional_condition) is absent/empty/false in run
 * context, the step is atomically marked done with auto_completed=1 and
 * auto_complete_reason='condition_unset:<key>', a step.auto_completed event
 * is emitted, and the pipeline advances — no harness spawn, zero tokens.
 *
 * Fail-closed arms:
 *   - condition SET  → returns 'dispatched'; the step stays pending and the
 *     motor spawns the harness normally. A set condition can NEVER be
 *     auto-completed.
 *   - a deception_audit step (WAVE-A.1 always audit) → returns 'dispatched'
 *     regardless of any condition value: an audit is never auto-completed.
 *   - non-conditional steps (single/loop) are never auto-completed.
 *   - a conditional step with no declared condition (spec validation should
 *     have rejected it) is treated as 'dispatched', never auto-completed.
 *
 * @returns 'auto_completed' — the step was completed in-process;
 *          'dispatched' — a conditional step is pending with its flag SET;
 *          'none' — no pending conditional step for this (agentId, runId).
 */
export function autoCompleteConditionalStep(runId: string, agentId: string): AutoCompleteConditionalOutcome {
  // Defense-in-depth: strip run- prefix (US-013)
  runId = stripIdPrefix(runId);
  const db = getDb();

  // Select the pending conditional step for this (agentId, runId) in serial
  // order, mirroring claimStep's eligibility filter: no upstream step may be
  // incomplete (a pending step whose predecessors are not all done/skipped
  // is not actually claimable, so it must never be auto-completed either).
  // VEDL note (w4.35 / tamandua-6sy.19): claimStep gained a narrow exception
  // letting a paused verify_each loop's designated verifier claim past
  // *waiting* intermediates — that bypass is intentionally NOT mirrored here.
  // Auto-complete must stay fail-closed: it must never pre-empt a waiting
  // step, and conditional-verifier semantics are out of scope, so this query
  // keeps the plain paused-loop exemption only.
  const step = db.prepare(
    `SELECT s.id, s.step_id, s.conditional_condition, s.step_index
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ? AND s.status = 'pending' AND s.type = 'conditional'
       AND r.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM steps prev
         WHERE prev.run_id = s.run_id
           AND prev.step_index < s.step_index
           AND prev.status NOT IN ('done', 'skipped')
           AND NOT (prev.type = 'loop'
                    AND prev.status = 'running'
                    AND prev.current_story_id IS NULL)
       )
     ORDER BY s.step_index ASC, s.step_id ASC
     LIMIT 1`,
  ).get(agentId, runId) as {
    id: string;
    step_id: string;
    conditional_condition: string | null;
    step_index: number;
  } | undefined;

  if (!step) return "none";

  // WAVE-A.1 US-003 (always audit, fail closed): a deception_audit step is
  // NEVER auto-completed. New bug-* runs declare it as a plain single step
  // (which this primitive never touches), but a stale `type: conditional`
  // row surviving from a pre-always-audit spec must also dispatch rather
  // than auto-complete free on an unset condition.
  if (step.step_id === "deception_audit") return "dispatched";

  const conditionKey = step.conditional_condition;
  if (!conditionKey || conditionKey.trim().length === 0) {
    // A conditional step without a declared condition should never exist
    // (spec validation rejects it), but fail closed: dispatch rather than
    // silently auto-completing a step we cannot evaluate.
    return "dispatched";
  }

  // Resolve the activation flag against run context.
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  const context = run ? parseRunContext(runId, run.context) : {};
  if (isRunContextFlagSet(context[conditionKey])) {
    // Fail-closed: a SET condition can never be auto-completed.
    return "dispatched";
  }

  // Atomically mark done + emit events (same pattern as enforceClaimLedgerGate).
  beginEventBuffering();
  try {
    db.exec("BEGIN IMMEDIATE");
    // Re-read inside the transaction: only auto-complete a step that is
    // still pending in a still-running run (a concurrent claim/lifecycle
    // change makes this a no-op instead of clobbering state).
    const current = db.prepare(
      `SELECT s.status, r.status AS run_status
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE s.id = ?`,
    ).get(step.id) as { status: string; run_status: string } | undefined;
    if (!current || current.status !== "pending" || current.run_status !== "running") {
      db.exec("ROLLBACK");
      discardEventBuffer();
      return "none";
    }

    const reason = `condition_unset:${conditionKey}`;
    db.prepare(
      `UPDATE steps SET status = 'done', auto_completed = 1, auto_complete_reason = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(reason, step.id);

    const wfId = getWorkflowId(runId);
    // The specific marker: oracles/observers distinguish auto-completed
    // (condition unset, zero tokens) from agent-reviewed runs.
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.auto_completed",
      runId,
      workflowId: wfId,
      stepId: step.step_id,
      agentId,
      condition: conditionKey,
      reason,
    });
    // Parity with the normal single-step completion lifecycle: any observer
    // tracking step.done sees the step completed.
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.done",
      runId,
      workflowId: wfId,
      stepId: step.step_id,
      agentId,
    });

    db.exec("COMMIT");
    flushEventBuffer();
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    discardEventBuffer();
    throw error;
  }

  // Advance the pipeline so the next step becomes claimable (may complete
  // the run when this was the last step).
  advancePipeline(runId);
  return "auto_completed";
}

// ══════════════════════════════════════════════════════════════════════
// Claim
// ══════════════════════════════════════════════════════════════════════

export interface WorkerOwnership {
  jobId: string;
  pid: number;
  pgid?: number;
}

interface ClaimResult {
  found: boolean;
  stepId?: string;
  runId?: string;
  resolvedInput?: string;
}

/**
 * Throttle cleanupAbandonedSteps: run at most once every 5 minutes.
 *
 * TIME-CLOCKS (rule 1): this is an in-process interval, so it is measured on
 * the monotonic clock. `null` means "no cleanup yet in this process" so the
 * very first call always cleans up — a monotonic reading is process-relative
 * and starts near zero, so the old `Date.now() - 0` first-call behavior cannot
 * be reproduced with a zero sentinel.
 */
let lastCleanupTime: number | null = null;
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

/**
 * @internal Test seam for the cleanup-throttle boundary: returns true (and
 * records the reading) when a cleanup is due at the supplied monotonic `nowMs`.
 * A pure decision over an injected monotonic reading lets tests exercise the
 * first-call and throttle-window boundaries deterministically, without
 * sleeping and without a wall-clock jump.
 */
export function _shouldRunCleanupForTest(nowMs: number): boolean {
  if (lastCleanupTime === null || nowMs - lastCleanupTime >= CLEANUP_THROTTLE_MS) {
    lastCleanupTime = nowMs;
    return true;
  }
  return false;
}

/** @internal Reset the cleanup throttle between tests. */
export function _resetCleanupThrottleForTest(): void {
  lastCleanupTime = null;
}

/** POSIX single-argument quoting: wraps value in single quotes with embedded-quote escaping. */
function posixQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Pure builder: returns a shell-safe tamandua-test wrapper invocation.
 * Every dynamic value (repo, runId, stepId, raw) is quoted as a single shell argument.
 * Fixed literals (tamandua-test, --repo, --run, --step, --) need no quoting.
 */
function buildWrappedTestCommand(raw: string, repo: string, runId: string, stepId: string): string {
  const q = posixQuoteArg;
  return `tamandua-test --repo ${q(repo)} --run ${q(runId)} --step ${q(stepId)} -- ${q(raw)}`;
}

/**
 * Wrap test_cmd with the tamandua-test shim invocation if present in context.
 * Saves the original command as test_cmd_raw and returns a render context with
 * the wrapped shim invocation in test_cmd (R18, R19).
 *
 * The input context is the CANONICAL context (safe to persist): test_cmd is
 * left unchanged and test_cmd_raw is set to the raw command.  The returned
 * render context is a shallow copy with test_cmd replaced by the wrapper.
 *
 * Example: if test_cmd = "npm test", returns a render context where test_cmd is:
 *   tamandua-test --repo '<repo>' --run '<run_id>' --step '<step_id>' -- 'npm test'
 *
 * Does nothing and returns the input context unchanged if test_cmd is missing,
 * empty, whitespace-only, or repo is missing.
 */
function wrapTestCmdInContext(
  context: Record<string, string>,
  repo: string | undefined,
  runId: string,
  stepId: string,
): Record<string, string> {
  // Prefer test_cmd_raw (canonical) when available, else use test_cmd as raw
  const rawCmd = context["test_cmd_raw"] || context["test_cmd"];
  if (!rawCmd || rawCmd.trim().length === 0) return context;
  if (!repo) return context;

  // Canonical context: save raw command, leave test_cmd unchanged
  context["test_cmd_raw"] = rawCmd;

  // Render context: shallow copy with wrapper in test_cmd
  const renderContext = { ...context };
  renderContext["test_cmd"] = buildWrappedTestCommand(rawCmd, repo, runId, stepId);
  return renderContext;
}

/**
 * Query the currently held (claimed/running) step for an agent in a run.
 * Pure read-only query — no state mutation. Returns the step's claim JSON
 * ({ stepId, runId, input }) or null when the agent holds no in-flight step.
 */
export function stepCurrent(
  agentId: string,
  runId: string,
  /**
   * Opt-in progress options (MTLK-PROGRESS). `progressAccess` supplies the
   * guest-visible progress pointer rendered into the current-step input.
   * Native no-flag callers omit it (byte-identical behavior).
   */
  opts?: StepProgressOptions,
): { stepId: string; runId: string; input: string } | null {
  // Defense-in-depth: strip run- prefix (US-013)
  runId = stripIdPrefix(runId);
  const db = getDb();

  // Look for a step that is 'running' (claimed by this agent). The agent can
  // only hold one in-flight step at a time per (agent_id, run_id).
  const step = db.prepare(
    `SELECT s.id, s.run_id, s.input_template, s.step_index, s.type, s.loop_config, s.current_story_id
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ? AND s.status = 'running'
       AND r.status = 'running'
     LIMIT 1`,
  ).get(agentId, runId) as {
    id: string;
    run_id: string;
    input_template: string;
    step_index: number;
    type: string;
    loop_config: string | null;
    current_story_id: string | null;
  } | undefined;

  if (!step) return null;

  // Resolve the input template against the current run context.
  // For loop steps with a current story, include story context.
  let story: Story | undefined;
  if (step.type === "loop" && step.current_story_id) {
    const storyRow = db.prepare(
      "SELECT * FROM stories WHERE id = ?",
    ).get(step.current_story_id) as any;
    if (storyRow) {
      story = {
        id: storyRow.id,
        runId: storyRow.run_id,
        storyIndex: storyRow.story_index,
        storyId: storyRow.story_id,
        title: storyRow.title,
        description: storyRow.description,
        acceptanceCriteria: JSON.parse(storyRow.acceptance_criteria),
        status: storyRow.status,
        output: storyRow.output ?? undefined,
        retryCount: storyRow.retry_count,
        maxRetries: storyRow.max_retries,
      };
    }
  }

  const loopConfig: LoopConfig | undefined = step.loop_config ? JSON.parse(step.loop_config) : undefined;
  const context = resolveStepContext(
    step.run_id,
    step.step_index,
    loopConfig,
    story,
    opts?.progressAccess?.guestFile,
  );

  if (!context["verify_feedback"]) context["verify_feedback"] = "";
  if (!context["timeout_retry"]) context["timeout_retry"] = "";

  // Wrap test_cmd with tamandua-test shim (R18-R19)
  const renderContext = context["repo"]
    ? wrapTestCmdInContext(context, context["repo"], step.run_id, step.id)
    : context;

  const resolvedInput = resolveTemplate(
    step.input_template,
    renderWithProgressView(renderContext, opts),
  );

  return { stepId: step.id, runId: step.run_id, input: resolvedInput };
}

/**
 * Find and claim a pending step for an agent, returning the resolved input.
 */
function enforceClaimLedgerGate(
  step: { id: string; run_id: string; step_id: string },
  evidenceSource?: FinalizeMergeEvidenceSource,
): { eligible: boolean; decision: LedgerGateDecision | null } {
  const db = getDb();
  let decision: LedgerGateDecision | null = null;
  let eligible = true;

  // Duplicate pollers may both observe the candidate before reaching this
  // seam. BEGIN IMMEDIATE makes the loser re-check eligibility only after the
  // winning refusal commits. Events stay buffered until that commit so an
  // aborted mutation cannot leave a phantom refusal sequence on disk.
  beginEventBuffering();
  try {
    db.exec("BEGIN IMMEDIATE");
    const candidate = db.prepare(
      `SELECT s.status, s.output, r.status AS run_status
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE s.id = ?`,
    ).get(step.id) as { status: string; output: string | null; run_status: string } | undefined;

    if (!candidate || candidate.status !== "pending" || candidate.run_status !== "running") {
      eligible = false;
    } else {
      const alreadyLanded = candidate.output ? isAlreadyLanded(step.id, candidate.output) : false;
      // WAVE-A TCMD (US-007): refuse finalize_merge while a TEST_CMD review is
      // pending or was rejected — the contract is under review, so no suite
      // evidence can be trusted yet (fail closed). The refusal is recorded as
      // a machine-parseable merge.refused_review_pending event; the step stays
      // pending (not failed) so it becomes claimable once the review resolves
      // (ACCEPT or withdrawal clears the flag). Already-landed merges skip the
      // refusal (C24 parity).
      const reviewRefusal = alreadyLanded ? null : getTestCmdReviewRefusal(step.run_id);
      if (reviewRefusal) {
        emitTestCmdReviewRefusal(step, reviewRefusal);
        eligible = false;
      } else {
        decision = alreadyLanded ? null : evaluateFinalizeMergeLedgerGate(step.id, evidenceSource);
        if (decision) {
          const refusal = getLedgerGateRefusal(step.id, decision);
          if (refusal) {
            const refusalStatus = applyLedgerGateRefusalSync(
              step,
              formatLedgerGateRefusal(refusal, evidenceSource),
              refusal.status === "missing",
              usesLedgerConcessionAllowance(step.id, refusal),
            );
            eligible = refusalStatus === "conceded";
          }
        }
      }
    }

    db.exec("COMMIT");
    flushEventBuffer();
    return { eligible, decision };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    discardEventBuffer();
    throw error;
  }
}

export function claimStep(
  agentId: string,
  runId: string,
  workerOwnership?: WorkerOwnership,
  /**
   * Opt-in progress options (MTLK-PROGRESS). `progressAccess` supplies the
   * guest-visible progress pointer rendered into the claimed input.
   * Native no-flag callers omit it (byte-identical behavior).
   */
  opts?: StepProgressOptions,
): ClaimResult {
  // Defense-in-depth: strip run- prefix (US-013)
  runId = stripIdPrefix(runId);
  // Throttle cleanup: run at most once every 5 minutes across all agents.
  // TIME-CLOCKS (rule 1): monotonic reading — a wall-clock jump must neither
  // trigger an early cleanup nor suppress a due one.
  if (_shouldRunCleanupForTest(monotonicNow())) {
    cleanupAbandonedSteps();
  }

  // SCUR-1: Idempotent re-claim — if the calling agent already holds an
  // in-flight step in this run, re-return it instead of NO_WORK.
  // stepCurrent is a pure read-only query; it does not reset progress,
  // bump retry counts, or change claim timestamps.
  const heldStep = stepCurrent(agentId, runId, opts);
  if (heldStep) {
    return {
      found: true,
      stepId: heldStep.stepId,
      runId: heldStep.runId,
      resolvedInput: heldStep.input,
    };
  }

  const db = getDb();

  // Notes on the prev-step filter:
  //  - `prev.status NOT IN ('done', 'skipped')` enforces serial pipeline progression.
  //  - The extra exception lets verify_each work: while the loop step is "paused"
  //    waiting for verify (status = 'running' but current_story_id IS NULL), the
  //    verify step needs to be claimable. Without this exception, completeStep's
  //    verify_each branch sets verify=pending while the loop stays running, but
  //    claimStep refuses to claim verify because the loop isn't done — deadlock.
  //  - VEDL (w4.35 / tamandua-6sy.19): verify_each names its verifier by step id —
  //    adjacency is NOT required (the public verify_each/verify_step contract).
  //    A step declared between the loop and its named verifier (e.g. a
  //    deception_audit between a fix loop and verify) sits in 'waiting' and used
  //    to block the verifier forever: the audit waits for the loop to finish, so
  //    the verifier could never claim past it. The narrow exception below also
  //    ignores a *waiting* predecessor when it sits strictly between (step_index)
  //    a paused verify_each loop and that loop's explicitly designated verifier.
  //    Nothing else changes: the intermediate stays exactly 'waiting' (never
  //    dispatched/skipped/auto-completed/advanced) and runs in pipeline order
  //    after the whole loop finishes; non-waiting unfinished intermediates,
  //    earlier unfinished prerequisites, and any pending step that is not the
  //    designated verifier still block.
  // Run-scoped claim: concurrent runs of the same workflow + agent never
  // cross-claim because the WHERE clause pins to a specific run_id (and the
  // bypass below pins vloop.run_id = s.run_id, so a paused loop in another run
  // can never authorize a claim here).
  const step = db.prepare(
    `SELECT s.id, s.step_id, s.run_id, s.input_template, s.type, s.loop_config, s.step_index, s.retry_count, s.claim_invalidated_by, s.output
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ? AND s.status = 'pending'
       AND r.status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM steps prev
         WHERE prev.run_id = s.run_id
           AND prev.step_index < s.step_index
           AND prev.status NOT IN ('done', 'skipped')
           AND NOT (prev.type = 'loop'
                    AND prev.status = 'running'
                    AND prev.current_story_id IS NULL)
           AND NOT (
             -- VEDL bypass: the candidate step s is a paused verify_each loop's
             -- explicitly designated verifier, and prev is a waiting step
             -- strictly between that loop and s. The loop's loop_config is
             -- normalized the same way the rest of the file normalizes it
             -- (verifyEach ?? verify_each, verifyStep ?? verify_step — mirrored
             -- here with COALESCE over the two JSON keys).
             prev.status = 'waiting'
             AND EXISTS (
               SELECT 1 FROM steps vloop
               WHERE vloop.run_id = s.run_id
                 AND vloop.type = 'loop'
                 AND vloop.status = 'running'
                 AND vloop.current_story_id IS NULL
                 AND vloop.step_index < prev.step_index
                 AND COALESCE(json_extract(vloop.loop_config, '$.verifyEach'),
                              json_extract(vloop.loop_config, '$.verify_each'),
                              0) != 0
                 AND COALESCE(json_extract(vloop.loop_config, '$.verifyStep'),
                              json_extract(vloop.loop_config, '$.verify_step')) = s.step_id
             )
           )
       )
    ORDER BY s.step_index ASC, s.step_id ASC
     LIMIT 1`,
  ).get(agentId, runId) as {
    id: string; step_id: string; run_id: string; input_template: string; type: string;
    loop_config: string | null;
    step_index: number;
    retry_count: number;
    output: string | null;
    claim_invalidated_by: string | null;
  } | undefined;

  if (!step) return { found: false };

  let ledgerGateDecision: LedgerGateDecision | null = null;
  if (step.step_id === "finalize_merge") {
    const gateClaim = enforceClaimLedgerGate(step, opts?.ledgerEvidenceSource);
    ledgerGateDecision = gateClaim.decision;
    if (!gateClaim.eligible) return { found: false };
  } else {
    // Guard: don't claim work for a terminal/paused run.
    const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(step.run_id) as
      | { status: string }
      | undefined;
    if (runStatus?.status !== "running") return { found: false };
  }

  // Build context via resolveStepContext
  const context = resolveStepContext(step.run_id, step.step_index);

  // If this is a retry, surface the previous failure detail to the agent so
  // the second attempt can be more targeted than the first. The retry path
  // (e.g. the no-STORIES_JSON guard in completeStep) writes a human-readable
  // explanation into step.output before resetting the step to pending; pull
  // it into context as `retry_feedback` so workflow prompts can include it.
  // Format the feedback with a PREVIOUS ATTEMPT FEEDBACK wrapper and
  // 4 KB truncation via formatRetryFeedback.
  //
  // Covers three cases:
  //   - Fresh step (output=null, retry_count=0) → retry_feedback=""
  //   - Retried step (retry_count>0, output=error) → retry_feedback="PREVIOUS ATTEMPT FEEDBACK (attempt N was rejected):\n<error>"
  //   - Rerouted producer (retry_count=0, output=reroute feedback) → retry_feedback=""
  //     (retry_count stays 0 for reroutes, so formatRetryFeedback returns empty)
  context["retry_feedback"] = formatRetryFeedback(step.output, step.retry_count);

  // Compute has_frontend_changes from git diff when repo and branch are available
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  } else {
    context["has_frontend_changes"] = "false";
  }

  // Loop step claim logic
  if (step.type === "loop") {
    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;
    if (loopConfig?.over === "stories") {
      const claim = db.prepare(
        workerOwnership
          ? `UPDATE steps SET status = 'running', preclaim_death_count = 0, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = ${SQL_NOW_ISO}, updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'`
          : `UPDATE steps SET status = 'running', preclaim_death_count = 0, claim_invalidated_by = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'`
      ).run(
        ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
      );
      if ((claim.changes ?? 0) <= 0) return { found: false };

      try {
        // C19a: capture whether this step was rerouted BEFORE the claim
        // UPDATE clears claim_invalidated_by, so we can detect no-op bounces
        // in the auto-complete path below (all stories done → no agent runs).
        const wasRerouted = step.claim_invalidated_by === "reroute";

      if (!runHasStories(step.run_id)) {
        const message = "Loop cannot run because planning did not produce STORIES_JSON.";
        db.prepare(
          `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(message, step.id);
        db.prepare(
          `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, detail: message });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: message });
        scheduleRunCronTeardown(step.run_id);
        return { found: false };
      }

      // Find next pending story
      const nextStory = db.prepare(
        "SELECT * FROM stories WHERE run_id = ? AND status = 'pending' ORDER BY story_index ASC LIMIT 1"
      ).get(step.run_id) as any | undefined;

      if (!nextStory) {
        const failedStory = db.prepare(
          "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
        ).get(step.run_id) as { id: string } | undefined;

        if (failedStory) {
          db.prepare(
            `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          ).run("Loop cannot continue because one or more stories failed", step.id);
          db.prepare(
            `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          ).run(step.run_id);
          const wfId = getWorkflowId(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.id, agentId, detail: "Loop has failed stories and no pending stories" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
          scheduleRunCronTeardown(step.run_id);
          return { found: false };
        }

        // No pending or failed stories — mark step done and advance.
        // C19a: if this step was rerouted and now auto-completes without
        // any agent work, emit a step.reroute_noop event so operators can
        // see the reroute was wasted.
        if (wasRerouted) {
          const wfId = getWorkflowId(step.run_id);
          emitEvent({
            ts: new Date().toISOString(),
            event: "step.reroute_noop",
            runId: step.run_id,
            workflowId: wfId,
            stepId: step.step_id,
            detail: "Rerouted loop step auto-completed without agent work — all stories were already done",
          });
          logger.warn("Reroute no-op bounce: loop step auto-completed without agent claim", {
            runId: step.run_id,
            stepId: step.step_id,
          });
        }
        db.prepare(
          `UPDATE steps SET status = 'done', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.id);
        emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
        advancePipeline(step.run_id);
        return { found: false };
      }

      // Claim the story. If another duplicate poller won it first, undo this
      // loop claim and let the next polling round inspect current state.
      const storyClaim = db.prepare(
        `UPDATE stories SET status = 'running', updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'`
      ).run(nextStory.id);
      if ((storyClaim.changes ?? 0) <= 0) {
        db.prepare(
          `UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.id);
        return { found: false };
      }
      db.prepare(
        workerOwnership
          ? `UPDATE steps SET status = 'running', preclaim_death_count = 0, current_story_id = ?, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = ${SQL_NOW_ISO}, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          : `UPDATE steps SET status = 'running', preclaim_death_count = 0, current_story_id = ?, claim_invalidated_by = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(
        ...(workerOwnership ? [nextStory.id, workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [nextStory.id, step.id])
      );

      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId });
      emitEvent({ ts: new Date().toISOString(), event: "story.started", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, storyId: nextStory.story_id, storyTitle: nextStory.title });
      logger.info(`Story started: ${nextStory.story_id} — ${nextStory.title}`, { runId: step.run_id, stepId: step.step_id });

      // Build story template vars
      const story: Story = {
        id: nextStory.id,
        runId: nextStory.run_id,
        storyIndex: nextStory.story_index,
        storyId: nextStory.story_id,
        title: nextStory.title,
        description: nextStory.description,
        acceptanceCriteria: JSON.parse(nextStory.acceptance_criteria),
        status: nextStory.status,
        output: nextStory.output ?? undefined,
        retryCount: nextStory.retry_count,
        maxRetries: nextStory.max_retries,
      };

      const allStories = getStories(step.run_id);
      const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;

      context["current_story"] = formatStoryForTemplate(story);
      context["current_story_id"] = story.storyId;
      context["current_story_title"] = story.title;
      context["completed_stories"] = formatCompletedStories(allStories);
      context["stories_remaining"] = String(pendingCount);
      const claimProgressPointer = getRunProgressPath(step.run_id);
      context["progress"] = `stored in the file ${claimProgressPointer} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
      context["progress_file"] = claimProgressPointer;

      if (!context["verify_feedback"]) {
        context["verify_feedback"] = "";
      }

      if (!context["timeout_retry"]) {
        context["timeout_retry"] = "";
      }

      // Wrap test_cmd with tamandua-test shim (R18-R19)
      const renderContext = wrapTestCmdInContext(context, context["repo"], step.run_id, step.step_id);

      const missingKeys = findMissingTemplateKeys(step.input_template, context);
      const blockResult = resolveMissingKeys(
        step.run_id, step.step_index, step.step_id, step.id, agentId, missingKeys
      );
      if (blockResult !== 'proceed') {
        if (blockResult === 'rejected') {
          // Unclaim the story
          db.prepare(
            `UPDATE stories SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          ).run(nextStory.id);
          // Unclaim the loop step: reset to pending so the scheduler re-evaluates
          db.prepare(
            `UPDATE steps SET status = 'pending', current_story_id = NULL, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          ).run(step.id);
        }
        // blockResult is a string (fail message): failRunForMissingTemplateKeys
        // already marked step + run as failed; just bail.
        return { found: false };
      }

      // Clear one-shot timeout_retry so it doesn't leak into subsequent stories.
      // The resolved template must capture it first; delete only after resolution.
      const hasTimeoutRetryLoop = Boolean(renderContext["timeout_retry"]);

      // Persist canonical context (test_cmd is raw, not wrapped)
      db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), step.run_id);

      const resolvedInput = resolveTemplate(
        step.input_template,
        renderWithProgressView(renderContext, opts),
      );
      emitDispatchRenderingValidation(step);

      if (hasTimeoutRetryLoop) {
        delete context["timeout_retry"];
        delete renderContext["timeout_retry"];
        db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), step.run_id);
      }

        return { found: true, stepId: step.id, runId: step.run_id, resolvedInput };
      } catch (err) {
        // CLTX: post-claim work threw — undo the claim atomically.
        // Don't increment retry_count because the agent never saw the work.
        db.prepare(
          `UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.id);
        // Reset any running story for this run back to pending
        db.prepare(
          `UPDATE stories SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE run_id = ? AND status = 'running'`
        ).run(step.run_id);
        logger.warn(`Post-claim work failed for loop step, resetting step to pending: ${(err as Error).message}`, {
          runId: step.run_id,
          stepId: step.step_id,
          error: (err as Error).message,
        });
        return { found: false };
      }
    }
  }

  // Single step: existing logic
  const claim = db.prepare(
    workerOwnership
      ? `UPDATE steps SET status = 'running', preclaim_death_count = 0, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = ${SQL_NOW_ISO}, updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'`
      : `UPDATE steps SET status = 'running', preclaim_death_count = 0, claim_invalidated_by = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ? AND status = 'pending'`
  ).run(
    ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
  );
  if ((claim.changes ?? 0) <= 0) return { found: false };
  try {
    emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
    if (ledgerGateDecision?.status === "overridden") {
      const launch = db.prepare(
        "SELECT run_number, workflow_id, created_at FROM runs WHERE id = ?",
      ).get(step.run_id) as { run_number: number; workflow_id: string; created_at: string } | undefined;
      emitEvent({
        ts: new Date().toISOString(),
        event: "merge.gate_overridden",
        runId: step.run_id,
        workflowId: launch?.workflow_id ?? getWorkflowId(step.run_id),
        stepId: step.step_id,
        gateMode: ledgerGateDecision.gateMode,
        runNumber: launch?.run_number,
        launchTs: launch?.created_at,
        origin: ledgerGateDecision.originRepo,
        treeHash: ledgerGateDecision.treeHash,
        cmdHash: ledgerGateDecision.cmdHash,
      });
    }
    logger.info(`Step claimed by ${agentId}`, { runId: step.run_id, stepId: step.step_id });

    // Inject progress for any step in a run that has stories
    const hasStories = db.prepare(
      "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
    ).get(step.run_id) as { cnt: number };
    if (hasStories.cnt > 0) {
      const claimProgressPointer = getRunProgressPath(step.run_id);
      context["progress"] = `stored in the file ${claimProgressPointer} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
      context["progress_file"] = claimProgressPointer;
    }

    // Clear one-shot timeout_retry after the template has captured it.
    // For single (non-loop) steps the context isn't persisted here, so
    // remove the key from the DB explicitly to prevent it from leaking
    // into downstream steps.
    const hasTimeoutRetry = Boolean(context["timeout_retry"]);

    if (!context["verify_feedback"]) {
      context["verify_feedback"] = "";
    }
    if (!context["timeout_retry"]) {
      context["timeout_retry"] = "";
    }

    // Wrap test_cmd with tamandua-test shim (R18-R19)
    const renderContext = wrapTestCmdInContext(context, context["repo"], step.run_id, step.step_id);

    const missingKeys = findMissingTemplateKeys(step.input_template, context);
    const blockResult = resolveMissingKeys(
      step.run_id, step.step_index, step.step_id, step.id, agentId, missingKeys
    );
    if (blockResult !== 'proceed') {
      if (blockResult === 'rejected') {
        // Unclaim the step: reset to pending so the scheduler re-evaluates
        db.prepare(
          `UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.id);
      }
      // blockResult is a string (fail message): failRunForMissingTemplateKeys
      // already marked step + run as failed; just bail.
      return { found: false };
    }

    const resolvedInput = resolveTemplate(
      step.input_template,
      renderWithProgressView(renderContext, opts),
    );
    emitDispatchRenderingValidation(step);

    if (hasTimeoutRetry) {
      delete context["timeout_retry"];
      setRunContextKey(step.run_id, "timeout_retry", "");
    }

    return {
      found: true,
      stepId: step.id,
      runId: step.run_id,
      resolvedInput,
    };
  } catch (err) {
    // CLTX: post-claim work threw — undo the claim atomically.
    // Don't increment retry_count because the agent never saw the work.
    db.prepare(
      `UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(step.id);
    logger.warn(`Post-claim work failed for single step, resetting step to pending: ${(err as Error).message}`, {
      runId: step.run_id,
      stepId: step.step_id,
      error: (err as Error).message,
    });
    return { found: false };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Expects Validation
// ══════════════════════════════════════════════════════════════════════

/**
 * Validate step output against the `expects` specification.
 *
 * Supports two kinds of lines:
 *   - Literal lines: the exact text must appear as a substring in the output.
 *   - Regex lines: prefixed with `regex:`, the rest is a pattern tested
 *     against the output (flags: m for multiline).
 *
 * Returns null if output satisfies all expects lines, or an error message
 * describing the first failing line.
 */
export function validateExpects(output: string, expects: string): string | null {
  if (!expects || expects.trim() === "") return null;

  // US-002: Honest verdict check.  When the output carries a non-done
  // STATUS line (retry, failed, reboot, etc.) whose variant is accepted
  // by the step's expects contract, validation passes even if some
  // KEY: lines are absent — the agent provided an honest verdict.
  //
  // STATUS: done always goes through normal key validation to preserve
  // the existing gate behavior (e.g. PR URL regex, CHANGES:/TESTS: lines).
  const statusMatch = output.match(/^STATUS:\s*(\S+)/m);
  if (statusMatch) {
    const variant = statusMatch[1].trim();
    if (variant.toLowerCase() !== "done" && checkExpectsAcceptsVariant(expects, variant)) {
      return null;
    }
  }

  const lines = expects.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("regex:")) {
      const pattern = trimmed.slice("regex:".length);
      try {
        const re = new RegExp(pattern, "m");
        if (!re.test(output)) {
          return `Output does not match expects regex: ${pattern}`;
        }
      } catch {
        return `Invalid expects regex pattern: ${pattern}`;
      }
    } else {
      if (!output.includes(trimmed)) {
        return `Output missing expects string: "${trimmed}"`;
      }
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Draining Pause Finalization
// ══════════════════════════════════════════════════════════════════════

/**
 * When a run's scheduling_status is 'draining_pause', check whether all
 * running steps have completed; if so, finalize the pause by clearing
 * scheduler timers and setting status to 'paused'.
 */
export function finalizeDrainingPause(runId: string): void {
  const db = getDb();
  const run = db
    .prepare("SELECT status, scheduling_status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { status: string; scheduling_status: string; workflow_id: string } | undefined;
  if (!run || run.scheduling_status !== "draining_pause") return;

  // DRVP terminal guard: a completed/failed/canceled run is never flipped to
  // paused by any drain-finalization call. Terminal transitions normally wipe
  // scheduling_status via scheduleRunCronTeardown before finalize runs, but
  // the drain finalizer is invoked from many completion paths — this guard
  // keeps terminal outcomes safe regardless of call ordering.
  if (run.status === "completed" || run.status === "failed" || run.status === "canceled") return;

  const runningSteps = db
    .prepare("SELECT type, current_story_id, loop_config FROM steps WHERE run_id = ? AND status = 'running'")
    .all(runId) as Array<{ type: string; current_story_id: string | null; loop_config: string | null }>;
  const hasInFlightStep = runningSteps.some((step) => {
    if (step.type !== "loop" || step.current_story_id || !step.loop_config) return true;
    try {
      const loopConfig = JSON.parse(step.loop_config) as LoopConfig;
      return !(loopConfig.verifyEach ?? loopConfig.verify_each);
    } catch {
      return true;
    }
  });
  if (hasInFlightStep) return;

  // Finalize the pause: clear timers and set status to paused. The drain
  // exists to protect in-flight work, so let the just-finished harness
  // flush its output before the leak-guard kill.
  import("./agent-scheduler.js")
    .then((m) => m.removeRunCrons(runId, { graceMs: m.HARNESS_TEARDOWN_GRACE_MS }))
    .catch((err) => {
      logger.warn("finalizeDrainingPause: removeRunCrons failed", { runId, error: String(err) });
    });

  db.prepare(
    `UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(runId);

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.paused",
    runId,
    workflowId: run.workflow_id,
  });

  logger.info("Drain-before-pause completed — run now paused", { runId });
}

// ══════════════════════════════════════════════════════════════════════
// Complete Step
// ══════════════════════════════════════════════════════════════════════

/**
 * Authoritative claim-row snapshot handed to an optional mutation authority
 * guard. Carries exactly the fields the guard needs to bind a mutation to a
 * host invocation/claim without re-opening the database.
 */
export interface StepClaimEvidence {
  /** Steps table row id (bare uuid). */
  stepRowId: string;
  /** Public step id from the workflow (e.g. "plan"). */
  stepId: string;
  runId: string;
  status: string;
  claimJobId: string | null;
  claimPid: number | null;
  claimPgid: number | null;
  claimUpdatedAt: string | null;
  updatedAt: string;
  claimInvalidatedBy: string | null;
}

/**
 * Minimal explicit opt-in authority seam (MTLK-STEP).
 *
 * Native callers (the worker CLI, the scheduler motor, plain tests) never
 * pass `options`, so every existing unguarded entry point keeps its exact
 * behavior. A Matchlock broker integration that must bind a mutation to a
 * specific host invocation passes `authority`:
 *
 *   - completeStep: the callback is evaluated INSIDE the existing
 *     BEGIN IMMEDIATE mutation transaction, immediately after the row read
 *     and before any state change or event, so refusal is atomic with the
 *     serialized mutation boundary (an async precheck is NOT sufficient).
 *   - failStep: the callback is evaluated synchronously at entry and again
 *     AFTER the only await (getOnFailPolicy) on a FRESH row read, BEFORE any
 *     mutation in the retry-exhausted branch — the on_fail.retry_step
 *     reroute (rerouteWithPolicy) and the terminal run-failure transition
 *     are each preceded by an authorization re-check, so authority loss
 *     across the async boundary can never drive a reroute or run failure.
 *     No shared database transaction is held across asynchronous work.
 *
 * Returning null authorizes; returning a detail string refuses WITHOUT any
 * mutation and WITHOUT any event, and completeStep/failStep report the
 * refusal as `{ status: "blocked" }` (claim retained, retry budget
 * untouched). The guard must never throw.
 */
export interface StepMutationOptions {
  authority?: (evidence: StepClaimEvidence) => string | null;
  /**
   * Opt-in host progress-resource accessor (MTLK-PROGRESS). When present,
   * post-completion host story-plan writes (and the upstream completeStep
   * mutation path that archives progress) go through this confined accessor
   * to the SAME document the guest sees. Native callers pass no options ->
   * canonical `<state>/runs/<runId>/progress.txt` behavior, byte-identical.
   */
  progressAccess?: RunProgressAccessLike;
  /**
   * Opt-in host-attested Matchlock finalizer evidence source (US-006). When
   * present, the completion-time finalize_merge acceptance gate consults this
   * source instead of the native `suite_results` ledger. Supplied ONLY by the
   * controller-attested Matchlock runner/adapter path; native callers omit it
   * and keep byte-identical native behavior.
   */
  ledgerEvidenceSource?: FinalizeMergeEvidenceSource;
}

/**
 * Options for {@link completeStep}.
 *
 * `rejectPausedRun` is the scheduler's output-derived auto-completion guard
 * (PRAW US-003): when set, a run whose status is `paused` or whose
 * `scheduling_status` is `draining_pause` refuses the completion exactly as a
 * failed/canceled run does. It is opt-in so the agent-issued CLI
 * `tamandua step complete` path is untouched — a pause drain lets in-flight
 * work finish and report normally.
 */
export interface CompleteStepOptions extends StepMutationOptions {
  rejectPausedRun?: boolean;
}

/**
 * Complete a step: validate expects, save output, merge context, advance pipeline.
 */
export function completeStep(
  stepId: string,
  output: string,
  opts?: CompleteStepOptions,
): { status: string; detail?: string } {
  stepId = stripIdPrefix(stepId);
  const result = completeStepInternal(stepId, output, opts);

  // Write story plan to progress log after successful completion.
  // Hoisted out of completeStepInternal so that no file I/O executes
  // inside the upcoming database transaction (US-003).
  // writeStoryPlanToProgress is idempotent: it checks runHasStories()
  // and returns early if no stories exist.
  if (result.status === "advanced" || result.status === "completed" || result.status === "rerouted") {
    const runIdRow = getDb().prepare("SELECT run_id FROM steps WHERE id = ?").get(stepId) as { run_id: string } | undefined;
    if (runIdRow) {
      // Opt-in resource forwarding (MTLK-PROGRESS): when a host progress
      // accessor is supplied, the host story-plan write goes through the
      // confined resource accessor (same document the guest sees). Native
      // callers pass no options -> canonical path, byte-identical.
      writeStoryPlanToProgress(runIdRow.run_id, opts?.progressAccess);
    }
  }

  // The pipeline just moved: a downstream step may have been promoted to
  // 'pending' (advanced) or this step was re-pended for retry. Nudge the
  // daemon so the dispatch motor picks it up immediately.
  if (result.status === "advanced" || result.status === "retrying" || result.status === "rerouted") {
    nudgeDispatch();
  }
  return result;
}

function completeStepInternal(
  stepId: string,
  output: string,
  opts?: CompleteStepOptions,
): { status: string; detail?: string } {
  const db = getDb();

  const body = (): { status: string; detail?: string } => {
    const step = db.prepare(
    "SELECT id, run_id, step_id, step_index, type, loop_config, current_story_id, expects, input_template, status, agent_id, claim_job_id, claim_pid, claim_pgid, claim_updated_at, claim_invalidated_by, updated_at FROM steps WHERE id = ?"
  ).get(stepId) as {
    id: string; run_id: string; step_id: string; step_index: number; type: string;
    loop_config: string | null; current_story_id: string | null; expects: string;
    input_template: string | null; status: string; agent_id: string;
    claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null;
    claim_updated_at: string | null; claim_invalidated_by: string | null; updated_at: string;
  } | undefined;

  if (!step) {
    // Try to recover agent_id and run_id for the error hint
    const stepInfo = db.prepare("SELECT agent_id, run_id FROM steps WHERE id = ?").get(stepId) as { agent_id: string; run_id: string } | undefined;
    const hint = stepInfo
      ? `\nIf you lost your step id, run: tamandua step current ${stepInfo.agent_id} --run-id ${stepInfo.run_id}\nIf this is a run id, step complete expects a step id — you may have passed the wrong identifier.`
      : `\nIf you lost your step id, run: tamandua step current <agent-id> --run-id <run-id>\nIf this is a run id, step complete expects a step id — you may have passed the wrong identifier.`;
    logger.warn(`Rejected step complete: Step not found: ${stepId}`, { stepId });
    throw new Error(`Step not found: ${stepId}${hint}`);
  }

  // ── MTLK-STEP authority seam (opt-in) ──────────────────────────────
  // Evaluated INSIDE the BEGIN IMMEDIATE transaction, before the run/status
  // guards so a refused stale/foreign/revoked claim never emits a
  // side-channel event and never mutates. The guard closure decides from the
  // fresh authoritative row snapshot plus host-held invocation state.
  if (opts?.authority) {
    const refusal = opts.authority({
      stepRowId: step.id,
      stepId: step.step_id,
      runId: step.run_id,
      status: step.status,
      claimJobId: step.claim_job_id,
      claimPid: step.claim_pid,
      claimPgid: step.claim_pgid,
      claimUpdatedAt: step.claim_updated_at,
      updatedAt: step.updated_at,
      claimInvalidatedBy: step.claim_invalidated_by,
    });
    if (refusal !== null && refusal !== undefined) {
      return { status: "blocked", detail: refusal };
    }
  }

  // Guard: don't process completions for failed runs
  const runId = step.run_id;
  const runCheck = db
    .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
    .get(runId) as { status: string; scheduling_status: string | null } | undefined;
  if (runCheck?.status === "failed" || runCheck?.status === "canceled") {
    return { status: "blocked" };
  }

  // Guard: scheduler output-derived auto-completion must not land on a paused
  // or draining_pause run (PRAW US-003). A pause must protect an in-flight
  // step from the output fallback exactly as a failed/canceled run does. This
  // is opt-in (rejectPausedRun), so the agent-issued CLI `tamandua step
  // complete` path is unaffected: pause semantics drain the run by letting
  // in-flight agent work finish and report. An unconditional guard here would
  // break that drain contract.
  if (
    opts?.rejectPausedRun
    && (runCheck?.status === "paused" || runCheck?.scheduling_status === "draining_pause")
  ) {
    logger.info("Scheduler auto-complete refused: run is paused or draining", {
      runId,
      stepId,
      stepSlug: step.step_id,
      runStatus: runCheck?.status,
      schedulingStatus: runCheck?.scheduling_status ?? null,
    });
    return {
      status: "blocked",
      detail: `run is ${runCheck?.status}${runCheck?.scheduling_status ? ` (scheduling_status=${runCheck.scheduling_status})` : ""} — scheduler auto-complete refused`,
    };
  }

  // Guard: duplicate completion. Delivery is at-least-once (agent CLI
  // retries, orphan-recovery reclaim races, duplicate polling rounds), so a
  // completion can arrive for a step that already reached a terminal
  // status. Re-processing would re-merge context, re-insert STORIES_JSON
  // stories, and re-advance the pipeline. Steps still 'running' — or reset
  // to 'pending' by the stale-claim sweeper — ARE processed: late work is
  // valid work.
  //
  // 'canceled' steps are also blocked: a worker whose step was force-failed
  // (or whose run was canceled) must not land its late completion. The
  // run-status guard above is insufficient here because resumeWorkflow
  // resets the run to 'running' before such a late completion arrives —
  // without this entry a surviving worker's completion would resurrect a
  // canceled step and its advancePipeline call could complete the run.
  if (
    step.status === "waiting"
    || step.status === "done"
    || step.status === "failed"
    || step.status === "skipped"
    || step.status === "canceled"
  ) {
    return { status: "blocked", detail: `step already ${step.status}` };
  }

  // Guard: reject stale completions for steps whose claim was deliberately
  // invalidated by a reroute. The sweeper (recoverOrphanedStepsForAgent,
  // cleanupAbandonedSteps) clears claim fields but does NOT set
  // claim_invalidated_by — preserving C5 late-work acceptance. Only
  // rerouteStep/rerouteStepSync sets this marker, so this guard blocks
  // completions carrying claim details from before the reroute.
  //
  // C19a (no-op bounce detection): if claim_updated_at is NULL, no agent
  // ever claimed this step after the reroute — the completion is a no-op
  // bounce. Emit a step.reroute_noop event so operators can see the reroute
  // was wasted. This is defense-in-depth; the primary detection lives in
  // claimStep's auto-complete path for loop steps with all stories done.
  if (step.status === "pending" && step.claim_invalidated_by === "reroute") {
    if (step.claim_updated_at === null) {
      const wfId = getWorkflowId(step.run_id);
      emitEvent({
        ts: new Date().toISOString(),
        event: "step.reroute_noop",
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        detail: "Rerouted producer completed without agent work — no claim after reroute",
      });
      logger.warn("Reroute no-op bounce: step completed without agent claim after reroute", {
        runId: step.run_id,
        stepId: step.step_id,
      });
    }
    return { status: "blocked", detail: "stale completion blocked — step was rerouted" };
  }

  // Defense-in-depth at acceptance time. The normal motor blocks before
  // claim, but a completion from an older/in-flight claimant must not bypass
  // an obstructing decision that became visible meanwhile.
  //
  // WAVE-A TCMD (US-007): refuse finalize_merge landing while a TEST_CMD
  // review is pending or was rejected — the contract under review cannot be
  // evidenced. This mirrors the claim-time refusal in enforceClaimLedgerGate;
  // it only fires for a finalize_merge that was claimed before the review
  // flag became set. Already-landed merges skip the refusal (C24 parity:
  // refusing a merge that already happened would waste a tester reroute).
  const testCmdReviewRefusal =
    step.step_id === "finalize_merge" && !isAlreadyLanded(step.id, output)
      ? getTestCmdReviewRefusal(step.run_id)
      : null;
  if (testCmdReviewRefusal) {
    emitTestCmdReviewRefusal(step, testCmdReviewRefusal);
    return { status: "blocked", detail: formatTestCmdReviewRefusal(testCmdReviewRefusal) };
  }

  // C24 (already-landed guard): skip the acceptance-time refusal when the
  // target ref already advanced to the attested MERGED_COMMIT — refusing a
  // merge that already happened would waste a tester reroute.
  const acceptanceGateDecision = evaluateFinalizeMergeLedgerGate(step.id, opts?.ledgerEvidenceSource);
  const acceptanceGateRefusal = getLedgerGateRefusal(step.id, acceptanceGateDecision);
  if (acceptanceGateRefusal) {
    if (isAlreadyLanded(step.id, output)) {
      const wfId = getWorkflowId(step.run_id);
      emitEvent({
        ts: new Date().toISOString(),
        event: "merge.accepted_already_landed",
        runId: step.run_id,
        workflowId: wfId,
        stepId: step.step_id,
        detail: "Acceptance gate refusal skipped — target already at attested MERGED_COMMIT",
      });
      logger.info("Skipped acceptance gate refusal: target already at attested MERGED_COMMIT", {
        runId: step.run_id,
        stepId: step.step_id,
      });
      // Fall through to normal acceptance (expects validation, context merge, etc.)
    } else {
      const refusal = formatLedgerGateRefusal(acceptanceGateRefusal, opts?.ledgerEvidenceSource);
      const refusalStatus = applyLedgerGateRefusalSync(
        step,
        refusal,
        acceptanceGateRefusal.status === "missing",
        usesLedgerConcessionAllowance(step.id, acceptanceGateRefusal),
      );
      if (refusalStatus !== "conceded") {
        return { status: refusalStatus, detail: refusal };
      }
    }
  }

  // Validate output against the expects column before accepting the step
  const validationError = validateExpects(output, step.expects);
  if (validationError) {
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?"
    ).get(stepId) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const wfId = getWorkflowId(step.run_id);

    if (newRetry > maxRetries) {
      // ── RETR: check on_fail.retry_step before failing the run ──
      // Rerouting to an upstream producer allows the run to recover when
      // expects validation exhausts and the root cause is in producer output.
      let validationFailureReason = validationError;
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id, validationError);
        if (rerouteResult === "rerouted") {
          return { status: "rerouted", detail: `Rerouted to upstream producer via on_fail.retry_step` };
        }
        if (rerouteResult === "invalid_target") {
          const policy = getOnFailPolicySync(step.run_id, step.step_id);
          logger.error(`Run failed: step "${step.step_id}" declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step (must have lower step_index).`, { runId: step.run_id, stepId: step.step_id });
        }
        if (rerouteResult === "target_moved_exhausted") {
          // REROUTE-BUDGET: surface the legible class instead of dropping the
          // sentinel into the generic expects-validation failure.
          validationFailureReason = buildTargetMovedExhaustedReason(
            step.id,
            getOnFailPolicySync(step.run_id, step.step_id),
            validationError,
          );
        }
        // budget_exhausted / not_found fall through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(validationFailureReason, newRetry, stepId);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: validationFailureReason });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Expects validation failed and retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(validationError, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId, workflowId: wfId, stepId: step.step_id, detail: validationError });
    logger.warn(validationError, { runId, stepId: step.step_id });
    finalizeDrainingPause(runId);
    return { status: "retrying", detail: validationError };
  }

  // Merge KEY: value lines into run context
  const run = db.prepare(
    "SELECT context, run_number, test_cmd_established FROM runs WHERE id = ?",
  ).get(runId) as {
    context: string;
    run_number: number | null;
    test_cmd_established: string | null;
  };
  const context: Record<string, string> = parseRunContext(runId, run.context);

  const parsed = parseOutputKeyValues(output);
  for (const [key, value] of Object.entries(parsed)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) continue;

    if (key === "test_cmd") {
      // WAVE-A TCMD (US-004): TEST_CMD contract establishment + rewrite
      // detection. The contract is established exactly once — a launch-declared
      // `--context test_cmd=` (persisted at run creation, source 'launch') wins;
      // otherwise the FIRST step-emitted TEST_CMD marker establishes it (source
      // = step id). Any LATER differing marker is a rewrite: it NEVER replaces
      // the established value, records a test_cmd.rewrite_detected event
      // {old, new, step, round}, and sets the run-context review flag
      // test_cmd_review_required so the conditional review primitive dispatches.
      //
      // TSTX-PQ: reject test_cmd values that echo the tamandua-test shim wrapper
      // (a misbehaving persona echoing its already-wrapped input).
      if (value.startsWith("tamandua-test --repo")) {
        logger.warn(
          `Rejected TEST_CMD output that echoes the tamandua-test wrapper prefix (step ${step.step_id}), keeping existing context values unchanged.`,
          { runId: step.run_id, stepId: step.step_id }
        );
        continue;
      }

      // The current contract: the persisted established value, falling back to
      // the context values for runs created before the columns existed.
      const established = run.test_cmd_established ?? context["test_cmd_raw"] ?? context["test_cmd"] ?? null;
      if (established === null) {
        // First-write: no launch declaration and no prior establishment — this
        // marker establishes the contract (source = step id) and merges into
        // context exactly as before this feature.
        db.prepare(
          `UPDATE runs SET test_cmd_established = ?, test_cmd_source = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
        ).run(value, step.step_id, runId);
        context["test_cmd"] = value;
        context["test_cmd_raw"] = value;
      } else if (value === established) {
        // Re-emitting the identical contract is not a rewrite — merge as today.
        context["test_cmd"] = value;
        context["test_cmd_raw"] = value;
        // WAVE-A US-006: if a review is pending and the flagged rewriting step
        // now re-emits the established contract, the rewrite is WITHDRAWN —
        // clear the review state so the conditional test_cmd_review step
        // auto-completes free instead of re-reviewing stale material.
        if (
          context["test_cmd_review_required"] === "true" &&
          context["test_cmd_rewriter_step"] === step.step_id
        ) {
          delete context["test_cmd_review_required"];
          delete context["test_cmd_review_candidate"];
          delete context["test_cmd_review_established"];
          delete context["test_cmd_rewriter_step"];
          logger.info(
            `TEST_CMD rewrite withdrawn (step ${step.step_id} re-emitted the established contract) — review no longer required.`,
            { runId: step.run_id, stepId: step.step_id }
          );
        }
      } else {
        // Differing marker: record the rewrite and require review. Do NOT
        // overwrite context.test_cmd/test_cmd_raw with the new value.
        // Trivially-equivalent forms still trigger detection — the reviewer's
        // fast-path handles them; the detector builds no equivalence engine.
        // Persist the review material in run context so the conditional
        // test_cmd_review step's input can render both commands (US-005),
        // and record WHICH step proposed the rewrite so a REJECT verdict can
        // route the finding back to it (US-006).
        context["test_cmd_review_required"] = "true";
        context["test_cmd_review_candidate"] = value;
        context["test_cmd_review_established"] = established;
        context["test_cmd_rewriter_step"] = step.step_id;
        const stepMeta = db.prepare(
          "SELECT retry_count FROM steps WHERE id = ?",
        ).get(step.id) as { retry_count: number } | undefined;
        const round = (stepMeta?.retry_count ?? 0) + 1;
        const wfId = getWorkflowId(runId);
        emitEvent({
          ts: new Date().toISOString(),
          event: "test_cmd.rewrite_detected",
          runId,
          workflowId: wfId,
          stepId: step.step_id,
          oldTestCmd: established,
          newTestCmd: value,
          round,
          runNumber: run.run_number ?? undefined,
          detail: `TEST_CMD rewrite detected: '${established}' -> '${value}' (step ${step.step_id}, round ${round})`,
        });
        logger.warn(
          `TEST_CMD rewrite detected (step ${step.step_id}): established '${established}', attempted '${value}' — contract unchanged, review required.`,
          { runId: step.run_id, stepId: step.step_id }
        );
      }
      continue;
    }

    context[key] = value;
  }

  // WAVE-A.1 PHNT (US-003): always-audit — the deception_audit step in the
  // bug-* workflows is a plain single step that ALWAYS dispatches after the
  // fix, so no dispatch flag is set here. The fixer's either/or fourth key
  // (REPRO_EVIDENCE | CANNOT_REPRODUCE) is the honest account the auditor
  // checks, whichever branch was taken. Gated on the run actually declaring a
  // deception_audit step so other workflows' fix steps (e.g.
  // security-audit-merge) are untouched. The alternation keys are normalized
  // (absent one stored as '') so the auditor's input template can reference
  // both {{repro_evidence}} and {{cannot_reproduce}} without a claim-time MISS
  // deadlock — only one of the two is ever emitted, and an empty value is a
  // present key.
  if (step.step_id === "fix") {
    const hasAuditStep = db.prepare(
      "SELECT COUNT(*) AS cnt FROM steps WHERE run_id = ? AND step_id = 'deception_audit'",
    ).get(step.run_id) as { cnt: number } | undefined;
    if ((hasAuditStep?.cnt ?? 0) > 0) {
      if (typeof context["repro_evidence"] !== "string") context["repro_evidence"] = "";
      if (typeof context["cannot_reproduce"] !== "string") context["cannot_reproduce"] = "";
      logger.info(
        `Fix completion normalized the alternation keys (step ${step.step_id}); the deception_audit step always dispatches after the fix`,
        { runId: step.run_id, stepId: step.step_id },
      );
    }
  }

  db.prepare(
    `UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(JSON.stringify(context), runId);

  // Parse STORIES_JSON from output (any step, typically the planner).
  //
  // SJSN: a validation failure here (fused/duplicate-key collapse, malformed
  // JSON, duplicate story ids, missing fields) re-pends this step with the
  // reason as retry feedback, bounded by max_retries — mirroring the
  // no-STORIES_JSON guard below. Letting the throw propagate would crash the
  // completing CLI and leave the step running until the abandon sweep resets
  // it blind, with no feedback about what was wrong.
  //
  // Note: the run-context merge above already happened; keys from this
  // rejected output remain in context and are overwritten when the retry
  // re-emits them. parseAndInsertStories validates before inserting, so a
  // throw never leaves partial stories behind.
  try {
    parseAndInsertStories(output, runId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?"
    ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const errorDetail = `${reason} Resetting to pending for retry ${newRetry}/${maxRetries}.`;
    const wfId = getWorkflowId(step.run_id);
    if (newRetry > maxRetries) {
      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(errorDetail, newRetry, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "STORIES_JSON validation failed and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      finalizeDrainingPause(step.run_id);
      return { status: "failed" };
    }
    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(errorDetail, newRetry, step.id);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
    logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying", detail: errorDetail };
  }

  // Robustness: if there is a downstream loop-over-stories and this run still
  // has no stories, the story-producing step's output is incomplete. For steps
  // whose input template mentions STORIES_JSON (planners/story-producers),
  // search the entire downstream pipeline for a loop-over-stories, because an
  // intermediate step like setup may sit between the planner and the loop (as
  // in feature-dev-merge: plan → setup → implement). For other steps, only
  // check the immediately-following step to avoid blaming a non-producing step
  // when a later intermediate step is supposed to generate stories (e.g.
  // security-audit: scan → prioritize(produces stories) → fix(loop)).
  // Honor max_retries so a permanently-broken planner still fails.
  if (step.type !== "loop") {
    const stepMentionsStories = step.input_template?.includes("STORIES_JSON");
    let downstreamLoopExpectingStories: { id: string; step_id: string; loop_config: string | null } | undefined;

    // Always check the immediately-following step first
    downstreamLoopExpectingStories = db.prepare(
      "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index = ? AND type = 'loop'"
    ).get(step.run_id, step.step_index + 1) as { id: string; step_id: string; loop_config: string | null } | undefined;

    // If this step is a story producer and the immediate next is NOT a loop,
    // search further downstream — an intermediate step like setup may sit between
    if (!downstreamLoopExpectingStories && stepMentionsStories) {
      downstreamLoopExpectingStories = db.prepare(
        "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index > ? AND type = 'loop' ORDER BY step_index ASC LIMIT 1"
      ).get(step.run_id, step.step_index) as { id: string; step_id: string; loop_config: string | null } | undefined;
    }
    if (downstreamLoopExpectingStories?.loop_config) {
      try {
        const lc = JSON.parse(downstreamLoopExpectingStories.loop_config) as LoopConfig;
        if (lc.over === "stories" && !runHasStories(step.run_id)) {
          const meta = db.prepare(
            "SELECT retry_count, max_retries FROM steps WHERE id = ?"
          ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
          const newRetry = (meta?.retry_count ?? 0) + 1;
          const maxRetries = meta?.max_retries ?? 0;
          const errorDetail =
            `Step output had no STORIES_JSON block, but the next step (${downstreamLoopExpectingStories.step_id}) is a loop over stories. ` +
            `The agent must emit a literal "STORIES_JSON: [ ... ]" line with at least one story. Resetting to pending for retry ${newRetry}/${maxRetries}.`;
          const wfId = getWorkflowId(step.run_id);
          if (newRetry > maxRetries) {
            db.prepare(
              `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
            ).run(errorDetail, newRetry, step.id);
            db.prepare(
              `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
            ).run(step.run_id);
            emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
            emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Plan step never produced STORIES_JSON" });
            scheduleRunCronTeardown(step.run_id);
            finalizeDrainingPause(step.run_id);
            return { status: "failed" };
          }
          db.prepare(
            `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
          ).run(errorDetail, newRetry, step.id);
          logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
          finalizeDrainingPause(step.run_id);
          return { status: "retrying", detail: errorDetail };
        }
      } catch {
        // best-effort: if loop_config can't be parsed, don't block completion
      }
    }
  }

  // Loop step completion
  if (step.type === "loop" && step.current_story_id) {
    const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id) as { story_id: string; title: string } | undefined;

    // Mark current story done
    db.prepare(
      `UPDATE stories SET status = 'done', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(output, step.current_story_id);
    emitEvent({ ts: new Date().toISOString(), event: "story.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, storyId: storyRow?.story_id, storyTitle: storyRow?.title });
    logger.info(`Story done: ${storyRow?.story_id} — ${storyRow?.title}`, { runId: step.run_id, stepId: step.step_id });

    // Clear current_story_id, save output
    db.prepare(
      `UPDATE steps SET current_story_id = NULL, output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(output, step.id);

    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;

    // verify_each flow — set verify step to pending. YAML uses snake_case;
    // accept both casings for back-compat with the camelCase types.
    const verifyEachOn = loopConfig?.verifyEach ?? loopConfig?.verify_each;
    const verifyStepId = loopConfig?.verifyStep ?? loopConfig?.verify_step;
    if (verifyEachOn && verifyStepId) {
      const verifyStep = db.prepare(
        "SELECT id FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
      ).get(step.run_id, verifyStepId) as { id: string } | undefined;

      if (verifyStep) {
        db.prepare(
          `UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(verifyStep.id);
        // Loop step stays 'running'
        db.prepare(
          `UPDATE steps SET status = 'running', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(step.id);
        return { status: "advanced" };
      }
    }

    // No verify_each: check for more stories
    const loopResult = checkLoopContinuation(step.run_id, step.id);
    return { status: loopResult.runCompleted ? "completed" : "advanced" };
  }

  // Check if this is a verify step triggered by verify-each
  const loopStepRow = db.prepare(
    "SELECT id, loop_config, run_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(step.run_id) as { id: string; loop_config: string | null; run_id: string } | undefined;

  if (loopStepRow?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStepRow.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep === step.step_id) {
      // VSRP: the verifier's STATUS is an independent single-line verdict
      // control. Extract the verdict from the RAW output (never the
      // multi-line context merge that parseOutputKeyValues builds when
      // unrecognized headings such as "VERIFIED-OK:" or "ISSUES (...):"
      // follow the STATUS line). Validation and routing must agree on ONE
      // unambiguous 'done' (approve) or 'retry' (story reset). Missing,
      // invalid, or conflicting verdicts are rejected through the existing
      // bounded step-retry handling — never a silent story approval
      // (KHYG incident 2026-09-06: standalone 'STATUS: retry' followed by
      // VERIFIED-OK:/ISSUES (...) headings was treated as approval).
      const verdict = extractVerifierVerdict(output);
      if ("error" in verdict) {
        return rejectVerifyEachCompletionForInvalidVerdict(step, verdict.error);
      }
      const verifyResult = handleVerifyEachCompletion(step, loopStepRow.id, output, context, verdict.verdict);
      // DRVP (R4a drain-verify-pause): a successful verify_each completion can
      // end the drain's last in-flight work. handleVerifyEachCompletion →
      // checkLoopContinuation → advancePipeline finalize the drain pause only
      // on their failure/terminal paths; when the final story verifies and the
      // pipeline promotes a downstream waiting step (or re-pends the loop for
      // a story retry), the run would otherwise stay running/draining_pause
      // with zero running steps and a pending step the drain never dispatches.
      // finalizeDrainingPause is idempotent + self-guarding (draining_pause
      // only, terminal runs excluded, in-flight steps excluded) — same shape
      // as the single-step done branch below.
      finalizeDrainingPause(step.run_id);
      return { status: verifyResult.runCompleted ? "completed" : "advanced" };
    }
  }

  // ── RETRY VERDICT ROUTING ──────────────────────────────────────────
  // When a non-verify_each step's output passes expects AND parses to a
  // STATUS: retry verdict, route through retry/on_fail semantics instead of
  // silently marking the step done.
  //
  // This fixes the CATP phantom-success bug (run f7ed5ab7, 2026-07-06)
  // where finalize_merge replied STATUS: retry / REBASED: true, passed the
  // merge-family expects (regex:^STATUS:\s*(done|retry)\s*$), and was
  // silently marked done — zero merge, four stranded commits.
  //
  // The verify_each path (handleVerifyEachCompletion) already handles
  // STATUS: retry correctly for story-level retry/reset, and returns
  // before reaching this guard. This guard must NOT interfere with it.
  const verdictStatus = parsed["status"]?.toLowerCase();
  if (verdictStatus === "retry") {
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?"
    ).get(stepId) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const wfId = getWorkflowId(step.run_id);

    if (newRetry > maxRetries) {
      // ── RETR: check on_fail.retry_step before failing the run ──
      let verdictFailureReason = output;
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id, output);
        if (rerouteResult === "rerouted") {
          return { status: "rerouted", detail: `STATUS: retry verdict — rerouted to upstream producer via on_fail.retry_step` };
        }
        if (rerouteResult === "invalid_target") {
          const policy = getOnFailPolicySync(step.run_id, step.step_id);
          logger.error(`Run failed: step "${step.step_id}" returned STATUS: retry, retries exhausted, declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step.`, { runId: step.run_id, stepId: step.step_id });
        }
        if (rerouteResult === "target_moved_exhausted") {
          // REROUTE-BUDGET: a STATUS: retry verdict whose first line is a
          // target_moved refusal can exhaust the stale-tip budget. Surface the
          // legible class rather than emitting the raw verdict as the failure.
          verdictFailureReason = buildTargetMovedExhaustedReason(
            step.id,
            getOnFailPolicySync(step.run_id, step.step_id),
            output,
          );
        }
        // budget_exhausted / not_found fall through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(verdictFailureReason, newRetry, stepId);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `STATUS: retry verdict — retries exhausted (${newRetry}/${maxRetries})` });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "STATUS: retry verdict — retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    // Retries not exhausted: set step to pending, write full output as retry_feedback
    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(output, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `STATUS: retry verdict (retry ${newRetry}/${maxRetries})` });
    logger.info(`Step retrying due to STATUS: retry verdict (retry ${newRetry}/${maxRetries})`, { runId: step.run_id, stepId: step.step_id });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying", detail: `STATUS: retry verdict (retry ${newRetry}/${maxRetries})` };
  }

  // ── TCMD REVIEW VERDICT ROUTING (US-006) ──────────────────────────
  // When a dispatched test_cmd_review step completes with a verdict, route it:
  // ACCEPT adopts the reviewed command as the contract; REJECT re-pends the
  // rewriting step with the FINDING as bounded retry feedback. Returns null
  // (fall through to normal completion) for non-review steps, undispached
  // reviews, or a review whose flag was already resolved.
  const reviewRoute = routeTestCmdReviewVerdict(step, context, parsed);
  if (reviewRoute) {
    return reviewRoute;
  }

  // ── PHNT DECEPTION-AUDIT VERDICT ROUTING (US-010, WAVE-A.1 US-003) ─
  // Every completed deception_audit step with a verdict routes here (the step
  // is a plain single step that always dispatches after the fix — always
  // audit): HONEST (or DECEPTION without quotable evidence — DEFAULT HONEST)
  // emits deception_audit.passed and lets the run proceed to
  // verify/finalize; DECEPTION with quotable evidence re-pends the fix step
  // with the FINDING as bounded retry feedback. Returns null (fall through to
  // normal completion) for non-audit steps or a verdict that resolves HONEST.
  const auditRoute = routeDeceptionAuditVerdict(step, context, parsed);
  if (auditRoute) {
    return auditRoute;
  }

  // WAVE-A TCMD (US-007): when a reviewed rewrite occurred, the landing
  // annotations name the old + new commands. The review material keys are
  // persisted by the rewrite detector (US-004) and kept in context after an
  // ACCEPT verdict (US-006) precisely for these landing annotations.
  const landingContext = getRunContextForStep(step.id) ?? {};
  const reviewedOldCmd = typeof landingContext["test_cmd_review_established"] === "string"
    ? landingContext["test_cmd_review_established"]
    : undefined;
  const reviewedNewCmd = typeof landingContext["test_cmd_review_candidate"] === "string"
    ? landingContext["test_cmd_review_candidate"]
    : undefined;

  // Default-mode red evidence is informational. Persist its run-scoped
  // annotation only when finalize_merge is accepted as done.
  if (acceptanceGateDecision.status === "red" && acceptanceGateDecision.gateMode === "default") {
    emitEvent({
      ts: new Date().toISOString(),
      event: "merge.landed_over_red_suite",
      runId: step.run_id,
      workflowId: getWorkflowId(step.run_id),
      stepId: step.step_id,
      origin: acceptanceGateDecision.originRepo,
      treeHash: acceptanceGateDecision.treeHash,
      cmdHash: acceptanceGateDecision.cmdHash,
      ledgerRowId: acceptanceGateDecision.row.id,
      exitCode: acceptanceGateDecision.row.exitCode,
      ledgerCreatedAt: acceptanceGateDecision.row.createdAt,
      durationMs: acceptanceGateDecision.row.durationMs,
      ...(reviewedOldCmd !== undefined ? { oldTestCmd: reviewedOldCmd } : {}),
      ...(reviewedNewCmd !== undefined ? { newTestCmd: reviewedNewCmd } : {}),
    });
  }

  // EVERY missing-evidence landing is annotated — including strict-mode
  // (green / fail_missing) landings that reach completion via the
  // already-landed guard, and conceded landings — so the record is truthful
  // that no suite evidence exists for the CURRENT contract (US-007).
  if (acceptanceGateDecision.status === "missing") {
    emitEvent({
      ts: new Date().toISOString(),
      event: "merge.landed_without_suite_evidence",
      runId: step.run_id,
      workflowId: getWorkflowId(step.run_id),
      stepId: step.step_id,
      gateMode: acceptanceGateDecision.gateMode,
      origin: acceptanceGateDecision.originRepo,
      treeHash: acceptanceGateDecision.treeHash,
      cmdHash: acceptanceGateDecision.cmdHash,
      ...(reviewedOldCmd !== undefined ? { oldTestCmd: reviewedOldCmd } : {}),
      ...(reviewedNewCmd !== undefined ? { newTestCmd: reviewedNewCmd } : {}),
    });
  }

  // Single step: mark done and advance
  db.prepare(
    `UPDATE steps SET status = 'done', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(output, stepId);
  emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id });
  logger.info(`Step completed: ${step.step_id}`, { runId: step.run_id, stepId: step.step_id });

  const pipelineResult = advancePipeline(step.run_id);
  finalizeDrainingPause(step.run_id);
      return { status: pipelineResult.runCompleted ? "completed" : "advanced" };
  };

  beginEventBuffering();
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = body();
    db.exec("COMMIT");
    flushEventBuffer();
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    discardEventBuffer();
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════════
// TCMD Review Verdict Routing (US-006)
// ══════════════════════════════════════════════════════════════════════

/**
 * Route a dispatched `test_cmd_review` step's verdict (WAVE-A TCMD, US-006).
 *
 * ACCEPT — the reviewed command (the rewrite candidate the reviewer saw)
 * becomes the run's TEST_CMD contract: runs.test_cmd_established is updated
 * (test_cmd_source = 'reviewer'), run-context test_cmd/test_cmd_raw switch
 * to the reviewed command, the review flag (test_cmd_review_required) is
 * cleared so any later conditional pass auto-completes free, and a
 * test_cmd.review_accepted {old, new, step} event is emitted. The review
 * material keys (test_cmd_review_established/candidate) are kept in context
 * so US-007's landing annotations can name the old+new commands.
 *
 * REJECT — the rewriting step (recorded by the detector in context as
 * test_cmd_rewriter_step, falling back to the reviewer's declared
 * on_fail.retry_step) is re-pended with the FINDING as bounded retry
 * feedback via the shared reroute machinery (rerouteWithPolicy), which
 * resets the reviewer to waiting so the review re-runs after the rewrite is
 * fixed; test_cmd_review_required stays set. Accumulated rejections exhaust
 * the reroute budget (max_reroutes, default 2) and fail the run legibly —
 * no infinite loop. A test_cmd.review_rejected {old, new, step, finding}
 * event is emitted on every rejection.
 *
 * Returns null (fall through to normal single-step completion) when this
 * step is not a dispatched test_cmd_review with a verdict; otherwise an
 * outcome ({ status: "rerouted" | "retrying" | "failed" }).
 */
function routeTestCmdReviewVerdict(
  step: { id: string; run_id: string; step_id: string },
  context: Record<string, string>,
  parsed: Record<string, string>,
): { status: string; detail?: string } | null {
  // Only a genuinely dispatched review routes verdicts: the conditional
  // reviewer step is dispatched only when test_cmd_review_required is set
  // (the detector set it at rewrite time). A reviewer claimed/completed
  // without the flag (manual smoke flows, auto-complete-equivalent paths)
  // is a no-op that falls through to normal completion.
  if (step.step_id !== "test_cmd_review") return null;
  if (context["test_cmd_review_required"] !== "true") return null;
  const verdict = parsed["verdict"]?.toUpperCase();
  if (verdict !== "ACCEPT" && verdict !== "REJECT") return null;

  const db = getDb();
  const wfId = getWorkflowId(step.run_id);
  const run = db.prepare(
    "SELECT test_cmd_established FROM runs WHERE id = ?",
  ).get(step.run_id) as { test_cmd_established: string | null } | undefined;
  const oldCmd =
    context["test_cmd_review_established"] ??
    run?.test_cmd_established ??
    context["test_cmd_raw"] ??
    context["test_cmd"] ??
    null;
  const newCmd = context["test_cmd_review_candidate"] ?? null;

  if (verdict === "ACCEPT") {
    if (newCmd === null || newCmd.trim() === "") {
      // Fail closed: an ACCEPT cannot adopt a contract it cannot name. The
      // candidate is always persisted by the detector when the review flag
      // is set, so this indicates state corruption — refuse to proceed.
      const detail =
        "TEST_CMD review ACCEPT but no review candidate is recorded in run context — refusing to adopt an unknown contract";
      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(detail, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "TEST_CMD review accepted with no candidate" });
      scheduleRunCronTeardown(step.run_id);
      finalizeDrainingPause(step.run_id);
      return { status: "failed", detail };
    }
    // Adopt the reviewed command as the contract.
    db.prepare(
      `UPDATE runs SET test_cmd_established = ?, test_cmd_source = 'reviewer', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(newCmd, step.run_id);
    context["test_cmd"] = newCmd;
    context["test_cmd_raw"] = newCmd;
    delete context["test_cmd_review_required"];
    delete context["test_cmd_rewriter_step"];
    // Review material keys stay in context for US-007 landing annotations.
    db.prepare(
      `UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(JSON.stringify(context), step.run_id);
    emitEvent({
      ts: new Date().toISOString(),
      event: "test_cmd.review_accepted",
      runId: step.run_id,
      workflowId: wfId,
      stepId: step.step_id,
      oldTestCmd: oldCmd ?? undefined,
      newTestCmd: newCmd,
      detail: `TEST_CMD review ACCEPTED: '${oldCmd ?? ""}' -> '${newCmd}' (step ${step.step_id})`,
    });
    logger.info(`TEST_CMD review accepted: '${oldCmd ?? ""}' -> '${newCmd}'`, { runId: step.run_id, stepId: step.step_id });
    // Fall through to normal single-step completion (mark done + advance).
    return null;
  }

  // ── REJECT ──────────────────────────────────────────────────────────
  const finding = parsed["finding"]?.trim() || "(no FINDING provided)";
  const rewriterStepId = context["test_cmd_rewriter_step"];
  const declaredPolicy = getOnFailPolicySync(step.run_id, step.step_id);
  const targetStepId = rewriterStepId ?? declaredPolicy?.retry_step;
  const reviewReason =
    `TEST_CMD review REJECTED by ${step.step_id}` +
    (oldCmd !== null || newCmd !== null ? `: '${oldCmd ?? ""}' -> '${newCmd ?? ""}'` : "") +
    `. FINDING: ${finding}`;

  // Every REJECT verdict is recorded, whatever the routing outcome — the
  // rejection event names old+new commands, the reviewer step, and the
  // quoted FINDING that is transported back to the rewriting step.
  emitEvent({
    ts: new Date().toISOString(),
    event: "test_cmd.review_rejected",
    runId: step.run_id,
    workflowId: wfId,
    stepId: step.step_id,
    oldTestCmd: oldCmd ?? undefined,
    newTestCmd: newCmd ?? undefined,
    finding,
    detail: `TEST_CMD review REJECTED: '${oldCmd ?? ""}' -> '${newCmd ?? ""}' (step ${step.step_id})`,
  });

  if (!targetStepId) {
    // No rewriter recorded and no declared retry target: fail closed — the
    // reviewer itself retries with the finding, bounded by max_retries.
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?",
    ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const errorDetail = `TEST_CMD review REJECTED but no rewriting step is recorded in run context — retry ${newRetry}/${maxRetries}. FINDING: ${finding}`;
    if (newRetry > maxRetries) {
      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(errorDetail, newRetry, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "TEST_CMD review rejected with no rewriter target and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      finalizeDrainingPause(step.run_id);
      return { status: "failed", detail: errorDetail };
    }
    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(errorDetail, newRetry, step.id);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
    logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying", detail: errorDetail };
  }

  // Re-pend the rewriting step with the FINDING as bounded retry feedback
  // via the shared reroute machinery (budget-checked: max_reroutes, default
  // 2). The runtime-recorded rewriter wins over the declared retry_step —
  // whichever step actually proposed the rewrite gets the finding.
  const rerouteResult = rerouteWithPolicy(
    { retry_step: targetStepId, max_reroutes: declaredPolicy?.max_reroutes ?? 2 },
    step.run_id,
    step.step_id,
    step.id,
    reviewReason,
  );

  if (rerouteResult === "rerouted") {
    logger.warn(`TEST_CMD review rejected — rerouted ${targetStepId} with the finding`, { runId: step.run_id, stepId: step.step_id });
    return { status: "rerouted", detail: `TEST_CMD review REJECTED — rerouted to ${targetStepId} with the finding` };
  }

  // budget_exhausted / invalid_target / not_found: the review cannot make
  // progress — fail the run legibly so accumulated rejections terminate the
  // run (no infinite loop).
  const budgetDetail =
    rerouteResult === "budget_exhausted"
      ? `TEST_CMD review rejected and reroute budget exhausted (max_reroutes=${declaredPolicy?.max_reroutes ?? 2}) — rewrite never accepted. FINDING: ${finding}`
      : rerouteResult === "invalid_target"
        ? `TEST_CMD review rejected but reroute target "${targetStepId}" is not a valid upstream step — cannot retry the rewriting step. FINDING: ${finding}`
        : `TEST_CMD review rejected but the reroute could not be performed. FINDING: ${finding}`;
  db.prepare(
    `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(budgetDetail, step.id);
  db.prepare(
    `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(step.run_id);
  emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: budgetDetail });
  emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "TEST_CMD review rejected and retry budget exhausted" });
  scheduleRunCronTeardown(step.run_id);
  finalizeDrainingPause(step.run_id);
  return { status: "failed", detail: budgetDetail };
}

// ══════════════════════════════════════════════════════════════════════
// PHNT Deception-Audit Verdict Routing (US-010)
// ══════════════════════════════════════════════════════════════════════

/**
 * Mechanical proxy for the auditor persona's "DECEPTION requires quotable
 * evidence" rule (WAVE-A PHNT, US-010): a FINDING only counts when it is
 * non-empty AND contains at least one quotation character (", ', or `) — the
 * persona requires quoted report lines, account lines, and diff hunks for a
 * DECEPTION verdict. A DECEPTION verdict whose FINDING fails this check is
 * treated as DEFAULT HONEST (a verdict without quotable evidence is invalid).
 */
function hasQuotableAuditFinding(finding: string | undefined): boolean {
  if (!finding) return false;
  const trimmed = finding.trim();
  if (trimmed.length === 0) return false;
  return /["'`]/.test(trimmed);
}

/**
 * Route a dispatched `deception_audit` step's verdict (WAVE-A PHNT, US-010;
 * WAVE-A.1 US-003 always-audit).
 *
 * HONEST — or DECEPTION without quotable evidence (DEFAULT HONEST; the
 * auditor persona makes a verdict invalid without quoted evidence) — the
 * audit passed: a deception_audit.passed event is emitted and the run
 * proceeds to verify/finalize. Any stale `deception_audit_required` context
 * value left by an earlier conditional-era run is cleared so it cannot linger.
 *
 * DECEPTION with quotable evidence — the fix step (the producer of the
 * audited account; the audit step's declared on_fail.retry_step, falling
 * back to the run's fix step) is re-pended with the FINDING as bounded retry
 * feedback via the shared reroute machinery (rerouteWithPolicy), which resets
 * the auditor to waiting so the audit re-runs after the fix is corrected.
 * Accumulated rejections exhaust the reroute budget (max_reroutes, default 2)
 * and fail the run legibly — no infinite loop. A
 * deception_audit.deception_found event is emitted on every routed DECEPTION.
 *
 * Returns null (fall through to normal single-step completion) when this
 * step is not a deception_audit with a verdict; otherwise an outcome
 * ({ status: "rerouted" | "retrying" | "failed" }).
 */
function routeDeceptionAuditVerdict(
  step: { id: string; run_id: string; step_id: string },
  context: Record<string, string>,
  parsed: Record<string, string>,
): { status: string; detail?: string } | null {
  // WAVE-A.1 US-003: the deception_audit step is a plain single step that
  // always dispatches after the fix, so every completed deception_audit with a
  // verdict routes here — there is no activation flag to gate on. A step that
  // is not a deception_audit, or completes without a verdict, falls through to
  // normal completion (expects validation normally prevents the latter).
  if (step.step_id !== "deception_audit") return null;
  const verdict = parsed["verdict"]?.toUpperCase();
  if (verdict !== "HONEST" && verdict !== "DECEPTION") return null;

  const db = getDb();
  const wfId = getWorkflowId(step.run_id);
  const finding = parsed["finding"]?.trim() ?? "";
  const isDeception = verdict === "DECEPTION" && hasQuotableAuditFinding(finding);

  if (!isDeception) {
    // ── HONEST (incl. invalid DECEPTION → DEFAULT HONEST) ────────────
    // Record the pass and fall through to normal single-step completion
    // (mark done + advance — the run proceeds to verify/finalize). The
    // run context is updated purely to drop a stale conditional-era
    // deception_audit_required value if one survives from an older spec.
    delete context["deception_audit_required"];
    db.prepare(
      `UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(JSON.stringify(context), step.run_id);
    emitEvent({
      ts: new Date().toISOString(),
      event: "deception_audit.passed",
      runId: step.run_id,
      workflowId: wfId,
      stepId: step.step_id,
      detail: verdict === "DECEPTION"
        ? "Deception audit passed (DECEPTION verdict ignored — no quotable evidence)"
        : "Deception audit passed (VERDICT: HONEST)",
    });
    logger.info(`Deception audit passed (verdict ${verdict})`, { runId: step.run_id, stepId: step.step_id });
    return null;
  }

  // ── DECEPTION with quotable evidence ───────────────────────────────
  // Route the fix step to retry with the FINDING as bounded retry feedback,
  // mirroring the test_cmd_review REJECT handling (US-006). The audit step's
  // declared on_fail.retry_step wins; the fix-step lookup covers seeded runs
  // and workflows that predate the on_fail declaration. In the bug-* family
  // no upstream step of deception_audit attests TESTED_TREE, so routing to
  // fix is valid under the M4 attester rule (WAVE-A.1 US-003).
  const declaredPolicy = getOnFailPolicySync(step.run_id, step.step_id);
  let targetStepId = declaredPolicy?.retry_step ?? null;
  if (!targetStepId) {
    const fixStep = db.prepare(
      "SELECT step_id FROM steps WHERE run_id = ? AND step_id = 'fix' LIMIT 1",
    ).get(step.run_id) as { step_id: string } | undefined;
    if (fixStep) targetStepId = "fix";
  }
  const auditReason = `Deception audit DECEPTION found by ${step.step_id}. FINDING: ${finding}`;

  // Every DECEPTION verdict with quotable evidence is recorded, whatever the
  // routing outcome — the event carries the quoted FINDING that is
  // transported back to the fix step.
  emitEvent({
    ts: new Date().toISOString(),
    event: "deception_audit.deception_found",
    runId: step.run_id,
    workflowId: wfId,
    stepId: step.step_id,
    finding,
    detail: auditReason,
  });

  if (!targetStepId) {
    // No fix step and no declared retry target: fail closed — the auditor
    // itself retries with the finding, bounded by max_retries.
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?",
    ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const errorDetail = `Deception audit found deception but no fix step is recorded in run context — retry ${newRetry}/${maxRetries}. FINDING: ${finding}`;
    if (newRetry > maxRetries) {
      db.prepare(
        `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(errorDetail, newRetry, step.id);
      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Deception audit found deception with no fix target and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      finalizeDrainingPause(step.run_id);
      return { status: "failed", detail: errorDetail };
    }
    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(errorDetail, newRetry, step.id);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
    logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying", detail: errorDetail };
  }

  // Re-pend the fix step with the FINDING as bounded retry feedback via the
  // shared reroute machinery (budget-checked: max_reroutes, default 2). The
  // declared retry target wins; the fix-step fallback covers seeded runs.
  const rerouteResult = rerouteWithPolicy(
    { retry_step: targetStepId, max_reroutes: declaredPolicy?.max_reroutes ?? 2 },
    step.run_id,
    step.step_id,
    step.id,
    auditReason,
  );

  if (rerouteResult === "rerouted") {
    logger.warn(`Deception audit found deception — rerouted ${targetStepId} with the finding`, { runId: step.run_id, stepId: step.step_id });
    return { status: "rerouted", detail: `Deception audit DECEPTION — rerouted to ${targetStepId} with the finding` };
  }

  // budget_exhausted / invalid_target / not_found: the audit cannot make
  // progress — fail the run legibly so accumulated rejections terminate the
  // run (no infinite loop).
  const budgetDetail =
    rerouteResult === "budget_exhausted"
      ? `Deception audit found deception and reroute budget exhausted (max_reroutes=${declaredPolicy?.max_reroutes ?? 2}) — fix never accepted as honest. FINDING: ${finding}`
      : rerouteResult === "invalid_target"
        ? `Deception audit found deception but reroute target "${targetStepId}" is not a valid upstream step — cannot retry the fix step. FINDING: ${finding}`
        : `Deception audit found deception but the reroute could not be performed. FINDING: ${finding}`;
  db.prepare(
    `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(budgetDetail, step.id);
  db.prepare(
    `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(step.run_id);
  emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: budgetDetail });
  emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Deception audit found deception and retry budget exhausted" });
  scheduleRunCronTeardown(step.run_id);
  finalizeDrainingPause(step.run_id);
  return { status: "failed", detail: budgetDetail };
}

/**
 * VSRP: verifier verdict extraction for the verify_each completion path.
 *
 * The verifier's STATUS line is an INDEPENDENT single-line control field:
 * validation (validateExpects' honest-verdict shortcut and the step's expects
 * regex) and routing must agree on one unambiguous verdict read from an
 * anchored full-line 'STATUS: <variant>' in the RAW output — never from the
 * context['status'] merge, which parseOutputKeyValues pollutes by appending
 * unrecognized continuation headings (e.g. 'VERIFIED-OK:' or 'ISSUES (...):')
 * to the pending STATUS value (KHYG incident 2026-09-06).
 *
 * Verifier verdicts are exactly 'done' (approve: story.verified + normal
 * continuation) and 'retry' (story retry/reset within the existing story
 * retry budget). A missing STATUS line, an invalid/unknown variant, or
 * conflicting verdicts (multiple differing full-line STATUS values in one
 * output) yield { error } so the caller can reject through the existing
 * bounded step-retry handling instead of silently approving a story.
 */
type VerifierVerdict = "done" | "retry";

function extractVerifierVerdict(output: string): { verdict: VerifierVerdict } | { error: string } {
  const variants: VerifierVerdict[] = [];
  for (const rawLine of output.split("\n")) {
    // Tolerate CRLF line endings from Windows-authored reports.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = line.match(/^STATUS:[ \t]*([A-Za-z0-9_]+)[ \t]*$/);
    if (match) {
      const variant = match[1]!.toLowerCase();
      if (variant !== "done" && variant !== "retry") {
        return {
          error: `invalid verifier STATUS verdict "${variant}" — the full-line STATUS control must be exactly 'done' or 'retry'`,
        };
      }
      variants.push(variant as VerifierVerdict);
    }
  }

  if (variants.length === 0) {
    return {
      error:
        "missing verifier STATUS verdict — the output must carry exactly one full-line 'STATUS: done' or 'STATUS: retry' control field",
    };
  }

  const distinct = [...new Set(variants)];
  if (distinct.length > 1) {
    return {
      error: `conflicting verifier STATUS verdicts (${distinct.join(", ")}) — the output must carry exactly one unambiguous full-line 'STATUS: done' or 'STATUS: retry' control field`,
    };
  }

  return { verdict: distinct[0]! };
}

/**
 * Bounded rejection for a verify_each completion whose STATUS verdict is
 * missing, invalid, or conflicting. The verify step itself is re-pended with
 * the reason as retry feedback, bounded by the step's own max_retries; when
 * retries exhaust, the run fails. The story is NEVER verified or advanced by
 * an unusable verdict (VSRP), and no lifecycle event claims otherwise.
 */
function rejectVerifyEachCompletionForInvalidVerdict(
  verifyStep: { id: string; run_id: string; step_id: string },
  reason: string,
): { status: string; detail?: string } {
  const db = getDb();
  const meta = db.prepare(
    "SELECT retry_count, max_retries FROM steps WHERE id = ?",
  ).get(verifyStep.id) as { retry_count: number; max_retries: number } | undefined;
  const newRetry = (meta?.retry_count ?? 0) + 1;
  const maxRetries = meta?.max_retries ?? 0;
  const wfId = getWorkflowId(verifyStep.run_id);
  const errorDetail =
    `Verifier verdict rejected: ${reason}. The story was NOT verified — resubmit with exactly one full-line "STATUS: done" or "STATUS: retry" verdict (retry ${newRetry}/${maxRetries}).`;

  if (newRetry > maxRetries) {
    db.prepare(
      `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(errorDetail, newRetry, verifyStep.id);
    db.prepare(
      `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
    ).run(verifyStep.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id, detail: errorDetail });
    emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verifier STATUS verdict missing/invalid/conflicting and retries exhausted" });
    scheduleRunCronTeardown(verifyStep.run_id);
    finalizeDrainingPause(verifyStep.run_id);
    return { status: "failed", detail: errorDetail };
  }

  db.prepare(
    `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(errorDetail, newRetry, verifyStep.id);
  emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id, detail: errorDetail });
  logger.warn(errorDetail, { runId: verifyStep.run_id, stepId: verifyStep.step_id });
  finalizeDrainingPause(verifyStep.run_id);
  return { status: "retrying", detail: errorDetail };
}

/**
 * Handle verify-each completion: pass or fail the story.
 *
 * `verdict` is the caller-extracted single-line STATUS verdict ('done' or
 * 'retry') from the RAW output (VSRP) — never the polluted context['status']
 * multi-line merge.
 */
function handleVerifyEachCompletion(
  verifyStep: { id: string; run_id: string; step_id: string; step_index: number },
  loopStepId: string,
  output: string,
  context: Record<string, string>,
  verdict: VerifierVerdict
): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();

  // Reset verify step to waiting for next use, with a fresh retry budget.
  // Each story gets its own verify retry budget — retry_count is story-scoped.
  db.prepare(
    `UPDATE steps SET status = 'waiting', retry_count = 0, output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(output, verifyStep.id);

  if (verdict !== "retry") {
    emitEvent({ ts: new Date().toISOString(), event: "story.verified", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id });
  }

  if (verdict === "retry") {
    const lastDoneStory = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE run_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1"
    ).get(verifyStep.run_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        db.prepare(`UPDATE stories SET status = 'failed', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newRetry, lastDoneStory.id);
        db.prepare(`UPDATE steps SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(loopStepId);
        db.prepare(`UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(verifyStep.run_id);
        const wfId = getWorkflowId(verifyStep.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id });
        emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verification retries exhausted" });
        scheduleRunCronTeardown(verifyStep.run_id);
        finalizeDrainingPause(verifyStep.run_id);
        return { advanced: false, runCompleted: false };
      }

      db.prepare(`UPDATE stories SET status = 'pending', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newRetry, lastDoneStory.id);

      const issues = context["issues"] ?? output;
      context["verify_feedback"] = issues;
      emitEvent({ ts: new Date().toISOString(), event: "story.retry", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id, detail: issues });
      db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), verifyStep.run_id);
    }

    db.prepare(`UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  // Verify passed — clear feedback and continue
  delete context["verify_feedback"];
  db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(JSON.stringify(context), verifyStep.run_id);

  try {
    return checkLoopContinuation(verifyStep.run_id, loopStepId);
  } catch (err) {
    logger.error(`checkLoopContinuation failed, recovering: ${String(err)}`, { runId: verifyStep.run_id });
    db.prepare(`UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }
}

/**
 * Check if the loop has more stories; if so set loop step pending, otherwise done + advance.
 */
function checkLoopContinuation(runId: string, loopStepId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const pendingStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'pending' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  const loopStatus = db.prepare(
    "SELECT status FROM steps WHERE id = ?"
  ).get(loopStepId) as { status: string } | undefined;

  if (pendingStory) {
    if (loopStatus?.status === "failed") {
      return { advanced: false, runCompleted: false };
    }
    db.prepare(
      `UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  const failedStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (failedStory) {
    db.prepare(
      `UPDATE steps SET status = 'failed', output = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run("Loop cannot continue because one or more stories failed", loopStepId);
    db.prepare(
      `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(runId);
    const wfId = getWorkflowId(runId);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId, workflowId: wfId, stepId: loopStepId, detail: "Loop has failed stories and no pending stories" });
    emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: false };
  }

  // All stories done — mark loop step done
  db.prepare(
    `UPDATE steps SET status = 'done', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(loopStepId);

  // Also mark verify step done if it exists
  const loopStep = db.prepare("SELECT loop_config, run_id FROM steps WHERE id = ?").get(loopStepId) as { loop_config: string | null; run_id: string } | undefined;
  if (loopStep?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStep.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep) {
      db.prepare(
        `UPDATE steps SET status = 'done', updated_at = ${SQL_NOW_ISO} WHERE run_id = ? AND step_id = ?`
      ).run(runId, lcVerifyStep);
    }
  }

  return advancePipeline(runId);
}

// ══════════════════════════════════════════════════════════════════════
// Advance Pipeline
// ══════════════════════════════════════════════════════════════════════

/**
 * Advance the pipeline: find the next waiting step and make it pending, or complete the run.
 * Respects terminal run states — a failed run cannot be advanced or completed.
 */
export function advancePipeline(runId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();

  // Guard: don't advance or complete a run that's already failed/cancelled
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runStatus?.status === "failed" || runStatus?.status === "canceled") {
    return { advanced: false, runCompleted: false };
  }

  const runningStep = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status = 'running' LIMIT 1"
  ).get(runId) as { id: string } | undefined;
  if (runningStep) {
    return { advanced: false, runCompleted: false };
  }

  const next = db.prepare(
    "SELECT id, step_id FROM steps WHERE run_id = ? AND status = 'waiting' ORDER BY step_index ASC LIMIT 1"
  ).get(runId) as { id: string; step_id: string } | undefined;

  // 'canceled' steps are an interrupted-pipeline marker (force-fail /
  // cancel shapes): a run whose steps were canceled has NOT satisfied its
  // pipeline, even though no step is waiting/failed/pending/running. Without
  // this, the completion branch below would spuriously mark such a run
  // 'completed' and emit run.completed — a false terminal event that also
  // blocks resume (the daemon's register gate rejects the "completed" row).
  // advancePipeline is the only emitter of run.completed in the product
  // code, so this gate is the single choke point for the false event.
  const incomplete = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status IN ('failed', 'pending', 'running', 'canceled') LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (!next && incomplete) {
    return { advanced: false, runCompleted: false };
  }

  const wfId = getWorkflowId(runId);
  if (next) {
    db.prepare(
      `UPDATE steps SET status = 'pending', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(next.id);
    emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId, workflowId: wfId, stepId: next.step_id });
    emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId, workflowId: wfId, stepId: next.step_id });
    return { advanced: true, runCompleted: false };
  } else {
    db.prepare(
      `UPDATE runs SET status = 'completed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(runId);
    emitRunTerminalEvent({ event: "run.completed", runId, workflowId: wfId });
    logger.info("Run completed", { runId, workflowId: wfId });
    archiveRunProgress(runId);
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: true };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress Archiving
// ══════════════════════════════════════════════════════════════════════

/**
 * Archive the run's progress file from the canonical location to the
 * workspace archive directory (backward-compatible with old workspace paths).
 */
export function archiveRunProgress(runId: string, access?: RunProgressAccessLike): void {
  // Opt-in resource route (MTLK-PROGRESS): archive the confined resource
  // document into the host run archive dir and clear the resource doc. No
  // legacy/workspace fallback after an opted-in refusal.
  if (access) {
    const archiveDir = path.join(resolveRunRoot(), runId, "archive");
    access.archiveTo(archiveDir);
    return;
  }
  // Archive from canonical path first
  const canonicalPath = getRunProgressPath(runId);
  if (fs.existsSync(canonicalPath)) {
    const archiveDir = path.join(resolveRunRoot(), runId, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(canonicalPath, path.join(archiveDir, "progress.txt"));
    fs.unlinkSync(canonicalPath);
    return;
  }

  // Backward-compatible: archive from workspace paths
  const db = getDb();
  const loopStep = db.prepare(
    "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(runId) as { agent_id: string } | undefined;
  if (!loopStep) return;

  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return;

  const scopedPath = path.join(workspace, `progress-${runId}.txt`);
  const legacyPath = path.join(workspace, "progress.txt");
  const progressPath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
  if (!fs.existsSync(progressPath)) return;

  const archiveDir = path.join(workspace, "archive", runId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(progressPath, path.join(archiveDir, "progress.txt"));
  fs.unlinkSync(progressPath);
}

// ══════════════════════════════════════════════════════════════════════
// Fail Step
// ══════════════════════════════════════════════════════════════════════

const FAILURE_CLASS_VOCABULARY: Record<string, "transient" | "terminal"> = {
  target_moved: "transient",
  conflicts: "transient",
  tree_dirty: "transient",
  refused_permanent: "terminal",
};

type FailureRerouteMode = "legacy" | "declared_retryable" | "terminal";

/** Read the first class line without normalizing the caller-owned reason. */
function parseFailureClass(reason: string): string | null {
  const firstLine = reason.split(/\r?\n/, 1)[0] ?? "";
  const match = /^FAILURE_CLASS:[ \t]+(\S+)[ \t]*$/.exec(firstLine);
  return match?.[1] ?? null;
}

/**
 * REROUTE-BUDGET (NPF-3): terminal failure reason used when a consumer's
 * target_moved reroute budget is exhausted. The FIRST line is exactly
 * `FAILURE_CLASS: target_moved_exhausted` so operators can grep the class
 * (and distinguish contention exhaustion from ordinary reroute exhaustion);
 * the remainder is a bounded explanation naming the consumed count, the
 * effective cap and the declared retry_step target. The count/cap are read
 * from the consumer row at call time, which is exactly the value the
 * target_moved budget check refused, so the reason can never drift.
 */
function buildTargetMovedExhaustedReason(
  consumerRowId: string,
  policy: WorkflowStepFailure | null | undefined,
  consumerFailure: string,
): string {
  const db = getDb();
  const row = db.prepare(
    "SELECT target_moved_reroute_count FROM steps WHERE id = ?",
  ).get(consumerRowId) as { target_moved_reroute_count: number | null } | undefined;
  const count = row?.target_moved_reroute_count ?? 0;
  const cap = policy?.max_target_moved_reroutes ?? 16;
  const target = policy?.retry_step ?? "?";
  const bounded =
    consumerFailure.length > 200 ? consumerFailure.slice(0, 197) + "..." : consumerFailure;
  return (
    "FAILURE_CLASS: target_moved_exhausted\n" +
    `Target-moved reroute budget exhausted: ${count}/${cap} stale-tip reroutes to "${target}". ` +
    `Consumer failure: ${bounded}`
  );
}

/** Unknown and undeclared nonterminal classes retain legacy behavior. */
function getFailureRerouteMode(
  reason: string,
  policy: WorkflowStepFailure | null,
): FailureRerouteMode {
  const failureClass = parseFailureClass(reason);
  if (!failureClass) return "legacy";

  const disposition = FAILURE_CLASS_VOCABULARY[failureClass];
  if (!disposition) return "legacy";
  if (disposition === "terminal") return "terminal";
  return policy?.retry_on?.includes(failureClass) ? "declared_retryable" : "legacy";
}

async function getOnFailPolicy(runId: string, stepId: string): Promise<WorkflowStepFailure | null> {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    if (!run) return null;

    const workflowDir = resolveWorkflowDir(run.workflow_id);
    const workflow = await loadWorkflowSpec(workflowDir);
    const step = workflow.steps.find((s) => s.id === stepId);
    return step?.on_fail ?? null;
  } catch {
    return null;
  }
}

/**
 * Synchronous variant of getOnFailPolicy. Reads the workflow spec
 * synchronously from disk for use in sync contexts (completeStep, orphan recovery).
 */
function getOnFailPolicySync(runId: string, stepId: string): WorkflowStepFailure | null {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    if (!run) return null;

    const workflowDir = resolveWorkflowDir(run.workflow_id);
    const workflow = loadWorkflowSpecSync(workflowDir);
    const step = workflow.steps.find((s) => s.id === stepId);
    return step?.on_fail ?? null;
  } catch {
    return null;
  }
}

/**
 * Shared core for async step-failure reroutes and rerouteStepSync.
 * Takes a pre-resolved policy object and performs all reroute logic:
 * validation, budget check, DB updates, story reset, event emission.
 *
 * terminal_reroute_count is a GATE CONTROL: it counts only terminal-CLASS
 * reroutes (rerouteMode === "terminal" — FAILURE_CLASS terminal decisions
 * such as refused_permanent, and ledger-gate terminal refusals) and drives
 * the consumer's one-shot terminal allowance. Ordinary consumer
 * retry-exhaustion reroutes (expects-validation, retry-verdict,
 * orphan-recovery) increment reroute_count only; the step.rerouted event
 * carries terminal:false + rerouteMode so the counters reconcile against
 * the event stream.
 *
 * REROUTE-BUDGET (NPF-3): target_moved reroutes (stale-tip landing refusals)
 * get their OWN budget and never consume max_reroutes. reroute_count stays
 * the TOTAL reroute counter (reroute_count == count(step.rerouted)), while
 * target_moved_reroute_count is a class-specific SUBSET counter incremented
 * only for target_moved reroutes. Shared-budget consumption is therefore
 * effectiveShared = max(0, reroute_count - target_moved_reroute_count),
 * compared against max_reroutes for every non-target_moved reroute.
 * target_moved reroutes instead compare target_moved_reroute_count against
 * on_fail.max_target_moved_reroutes (default 16). This keeps 8-way landing
 * contention from terminally exhausting an otherwise healthy merge run.
 *
 * Returns "rerouted" on success, "budget_exhausted" when the shared
 * max_reroutes budget is reached by a non-target_moved reroute,
 * "target_moved_exhausted" when the target_moved budget is reached,
 * "invalid_target" when the declared retry_step target doesn't exist or
 * isn't upstream, or "not_found" when the consumer step isn't found in the
 * database.
 */
function rerouteWithPolicy(
  policy: WorkflowStepFailure,
  runId: string,
  consumerStepId: string,
  consumerRowId: string,
  error: string,
  hasIndependentGateAllowance = false,
): "rerouted" | "budget_exhausted" | "target_moved_exhausted" | "invalid_target" | "not_found" {
  const db = getDb();
  const targetStepId = policy.retry_step!;

  // Integrity-gate terminal refusals carry the durable ledger evidence needed
  // to diagnose and recover the run. RAMP transports those mechanically
  // generated reasons verbatim; ordinary agent-authored feedback remains
  // bounded to keep prompts and event records small. A bounded reason keeps
  // its leading FAILURE_CLASS line intact (the first line is short), so the
  // verbatim class line survives truncation.
  const boundedReason = error.length > 200 ? error.slice(0, 197) + "..." : error;
  const rerouteReason = /^FAILURE_CLASS: refused_permanent$/m.test(error) ? error : boundedReason;

  // Look up the consumer step metadata
  const consumerStep = db.prepare(
    "SELECT step_id, step_index, reroute_count, terminal_reroute_count, target_moved_reroute_count FROM steps WHERE id = ?"
  ).get(consumerRowId) as
    {
      step_id: string;
      step_index: number;
      reroute_count: number | null;
      terminal_reroute_count: number | null;
      target_moved_reroute_count: number | null;
    } | undefined;
  if (!consumerStep) return "not_found";

  // Look up the target (producer) step in the same run (include type + loop_config for story reset)
  const targetStep = db.prepare(
    "SELECT id, step_id, step_index, type, loop_config FROM steps WHERE run_id = ? AND step_id = ?"
  ).get(runId, targetStepId) as
    { id: string; step_id: string; step_index: number; type: string; loop_config: string | null } | undefined;

  // Validate: target must exist and have a lower step_index than consumer
  if (!targetStep) return "invalid_target";
  if (targetStep.step_index >= consumerStep.step_index) return "invalid_target";

  const rerouteMode = getFailureRerouteMode(error, policy);
  const failureClass = parseFailureClass(error);
  const isTargetMoved = failureClass === "target_moved";
  const hasIndependentTerminalAllowance = rerouteMode === "terminal" && (
    (consumerStep.terminal_reroute_count ?? 0) < 1 || hasIndependentGateAllowance
  );

  // Shared reroute budget (default 2 when not declared in YAML). REROUTE-BUDGET:
  // target_moved reroutes are excluded from the shared budget entirely and get
  // their own cap below, so landing contention cannot exhaust max_reroutes.
  // A terminal refusal with an unspent durable allowance can cross an exhausted
  // shared budget without charging it again.
  const maxReroutes = policy.max_reroutes ?? 2;
  const maxTargetMovedReroutes = policy.max_target_moved_reroutes ?? 16;
  const currentReroutes = consumerStep.reroute_count ?? 0;
  const currentTargetMovedReroutes = consumerStep.target_moved_reroute_count ?? 0;
  // Shared-budget consumption excludes the target_moved subset counter.
  const effectiveShared = Math.max(0, currentReroutes - currentTargetMovedReroutes);

  if (isTargetMoved) {
    if (currentTargetMovedReroutes >= maxTargetMovedReroutes) {
      emitEvent({
        ts: new Date().toISOString(),
        event: "step.target_moved_reroute_exhausted",
        runId,
        workflowId: getWorkflowId(runId),
        stepId: consumerStepId,
        detail:
          `Target-moved reroute budget exhausted: ${currentTargetMovedReroutes}/${maxTargetMovedReroutes} to ${targetStepId}. ` +
          `Consumer failure: ${rerouteReason}`,
        failureClass,
        targetMovedRerouteCount: currentTargetMovedReroutes,
        targetMovedBudget: maxTargetMovedReroutes,
      });
      logger.warn("Target-moved reroute budget exhausted", {
        runId, fromStep: consumerStepId, toStep: targetStepId,
        targetMovedRerouteCount: currentTargetMovedReroutes,
        targetMovedBudget: maxTargetMovedReroutes, reason: rerouteReason,
      });
      return "target_moved_exhausted";
    }
  } else if (effectiveShared >= maxReroutes && !hasIndependentTerminalAllowance) {
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.reroute_budget_exhausted",
      runId,
      workflowId: getWorkflowId(runId),
      stepId: consumerStepId,
      detail:
        `Reroute budget exhausted: ${effectiveShared}/${maxReroutes} to ${targetStepId}. Consumer failure: ${rerouteReason}`,
      failureClass,
      targetMovedRerouteCount: currentTargetMovedReroutes,
      targetMovedBudget: maxTargetMovedReroutes,
    });
    logger.warn("Reroute budget exhausted", {
      runId, fromStep: consumerStepId, toStep: targetStepId,
      rerouteCount: effectiveShared, budget: maxReroutes, reason: rerouteReason,
    });
    return "budget_exhausted";
  }

  const usesBudgetIndependentAllowance =
    effectiveShared >= maxReroutes && hasIndependentTerminalAllowance;
  const newRerouteCount = currentReroutes + (usesBudgetIndependentAllowance ? 0 : 1);
  // WAVE-B.1: terminal_reroute_count is a GATE CONTROL counting only
  // terminal-CLASS reroutes (rerouteMode === "terminal"). Ordinary
  // consumer retry-exhaustion reroutes (expects-validation, retry-verdict,
  // orphan-recovery) increment reroute_count only — inflating
  // terminal_reroute_count on them would consume the consumer's one-shot
  // terminal allowance before any terminal refusal occurs. reroute_count
  // counts every reroute and reconciles with the step.rerouted event
  // stream, whose terminal field flags the class of each reroute.
  const newTerminalRerouteCount =
    (consumerStep.terminal_reroute_count ?? 0) +
    (rerouteMode === "terminal" ? 1 : 0);
  // REROUTE-BUDGET: target_moved_reroute_count is a class-specific SUBSET
  // counter (incremented only when the driving failure class is target_moved).
  // It reconciles against the step.rerouted event stream's failureClass field,
  // and is unchanged by every other reroute class.
  const newTargetMovedRerouteCount =
    currentTargetMovedReroutes + (isTargetMoved ? 1 : 0);

  // Build bounded feedback for the producer. The budget label reflects the
  // class being charged: target_moved reroutes read "(target-moved reroute
  // N/<cap>)"; every other class keeps the shared "(reroute N/<max>)" label.
  const budgetLabel = isTargetMoved
    ? `target-moved reroute ${newTargetMovedRerouteCount}/${maxTargetMovedReroutes}`
    : `reroute ${newRerouteCount}/${maxReroutes}`;
  const feedback =
    `Reroute from "${consumerStep.step_id}" (${budgetLabel}). ` +
    `Consumer failure: ${boundedReason}`;

  // (a) Re-pend producer: status=pending, retry_count UNCHANGED.
  //     Write retry_feedback into output so claimStep surfaces it.
  //     Clear claim ownership and set invalidation marker to prevent
  //     stale completions from re-completing the producer with old output.
  //     Also NULL claim_updated_at so the no-op bounce guard (C19a) can
  //     detect that no agent claimed this step after the reroute.
  db.prepare(
    `UPDATE steps SET status = 'pending', output = ?, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, claim_invalidated_by = 'reroute', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(feedback, targetStep.id);

  // (a.2) Story reset on reroute: when the reroute target is a loop-over-stories step,
  //        reset the story/stories cited in the consumer's failure text to pending.
  resetStoriesOnReroute(db, runId, targetStep, error, getWorkflowId(runId));

  // (a.3) Write verify_feedback into run context when reroute target is a
  //        loop-over-stories step, so the developer agent sees the feedback
  //        on the next claim (unconditional — even when no stories were reset).
  writeRerouteFeedbackContext(db, runId, targetStep, error);

  // (b) Reset consumer: status=waiting, retry_count=0, increment the general
  //     counter and the class-specific subset counters. All counters update in
  //     the SAME statement as the step.rerouted event's synchronous unit —
  //     atomic by construction. Clear output and ownership so it looks like a
  //     fresh step.
  db.prepare(
    `UPDATE steps SET status = 'waiting', retry_count = 0, reroute_count = ?, terminal_reroute_count = ?, target_moved_reroute_count = ?, output = NULL, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
  ).run(newRerouteCount, newTerminalRerouteCount, newTargetMovedRerouteCount, consumerRowId);

  // (c) Intermediate done steps are left untouched — advancePipeline will
  //     naturally re-pend the consumer after the producer completes.

  // Emit event. The event flags the reroute's class so consumers reconcile
  // reroute_count == count(step.rerouted), terminal_reroute_count ==
  // count(step.rerouted where terminal === true), and
  // target_moved_reroute_count == count(step.rerouted where failureClass ===
  // 'target_moved'). targetMovedRerouteCount/targetMovedBudget are always
  // present so the counter and its effective cap are auditable.
  const wfId = getWorkflowId(runId);
  emitEvent({
    ts: new Date().toISOString(),
    event: "step.rerouted",
    runId,
    workflowId: wfId,
    stepId: consumerStepId,
    detail:
      `Rerouted to ${targetStepId} (${budgetLabel}). ` +
      `Consumer failure: ${rerouteReason}`,
    rerouteMode,
    terminal: rerouteMode === "terminal",
    failureClass,
    targetMovedRerouteCount: newTargetMovedRerouteCount,
    targetMovedBudget: maxTargetMovedReroutes,
  });

  logger.info(
    `Step rerouted: ${consumerStepId} → ${targetStepId} (${budgetLabel})`,
    {
      runId,
      fromStep: consumerStepId,
      toStep: targetStepId,
      rerouteCount: newRerouteCount,
      budget: maxReroutes,
      targetMovedRerouteCount: newTargetMovedRerouteCount,
      targetMovedBudget: maxTargetMovedReroutes,
      failureClass,
      reason: rerouteReason,
    },
  );

  return "rerouted";
}

/**
 * Route a motor-generated LGAT refusal through RAMP's existing policy core.
 * Terminal refusals receive the RAMP-wide one-reroute allowance regardless
 * of the workflow's larger transient reroute budget.
 */
/**
 * Check whether the merge attested by the finalize_merge output's
 * MERGED_COMMIT has already landed on the target ref. When this
 * returns true at acceptance time, the gate refusal is skipped —
 * refusing a merge that already happened would waste a tester reroute.
 *
 * Exported so it can be tested independently.
 */
export function isAlreadyLanded(stepId: string, output: string): boolean {
  const parsed = parseOutputKeyValues(output);
  const mergedCommit = parsed["merged_commit"];
  if (!mergedCommit) return false;

  const db = getDb();
  const step = db.prepare(
    "SELECT run_id FROM steps WHERE id = ?",
  ).get(stepId) as { run_id: string } | undefined;
  if (!step) return false;

  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(step.run_id) as
    | { context: string }
    | undefined;
  if (!run) return false;

  const context = parseRunContext(step.run_id, run.context);
  const targetBranch = context.original_branch;
  const repo = context.worktree_origin_repository || context.repo || context.working_directory_for_harness;
  if (!targetBranch || !repo) return false;

  try {
    const targetRef = `refs/heads/${targetBranch}`;
    const tip = execFileSync("git", ["rev-parse", targetRef], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    return tip === mergedCommit;
  } catch {
    return false;
  }
}

/**
 * Check whether the ledger gate's concession valve has been consumed for a step.
 *
 * Only a successful default-mode missing-evidence gate reroute consumes this
 * counter. Generic terminal reroutes retain their separate RAMP accounting.
 */
export function hasLedgerGateConcession(stepId: string): boolean {
  const db = getDb();
  const step = db.prepare(
    "SELECT ledger_concession_count FROM steps WHERE id = ?",
  ).get(stepId) as { ledger_concession_count: number | null } | undefined;
  return (step?.ledger_concession_count ?? 0) >= 1;
}

/**
 * Look up the run context for a step.
 */
function getRunContextForStep(stepId: string): Record<string, string> | null {
  const db = getDb();
  const stepRow = db.prepare(
    "SELECT run_id FROM steps WHERE id = ?",
  ).get(stepId) as { run_id: string } | undefined;
  if (!stepRow) return null;
  const run = db.prepare(
    "SELECT context FROM runs WHERE id = ?",
  ).get(stepRow.run_id) as { context: string } | undefined;
  if (!run) return null;
  try {
    return JSON.parse(run.context);
  } catch {
    return {};
  }
}

/**
 * WAVE-A TCMD (US-007): record a finalize_merge refusal caused by a pending
 * or rejected TEST_CMD review. Emits a machine-parseable
 * merge.refused_review_pending event (FAILURE_CLASS: refused_review_pending
 * in the detail, old/new commands when known) and logs a warning. The step
 * is deliberately left pending — the refusal is a gate, not a failure; the
 * step becomes claimable once the review resolves.
 */
function emitTestCmdReviewRefusal(
  step: { id: string; run_id: string; step_id: string },
  refusal: TestCmdReviewRefusal,
): void {
  const refusalText = formatTestCmdReviewRefusal(refusal);
  emitEvent({
    ts: new Date().toISOString(),
    event: "merge.refused_review_pending",
    runId: step.run_id,
    workflowId: getWorkflowId(step.run_id),
    stepId: step.step_id,
    oldTestCmd: refusal.oldTestCmd,
    newTestCmd: refusal.newTestCmd,
    detail: refusalText,
  });
  logger.warn(
    `finalize_merge refused: TEST_CMD review pending or rejected (step ${step.step_id})`,
    { runId: step.run_id, stepId: step.step_id, ...refusal },
  );
}

function getLedgerGateRefusal(
  stepId: string,
  decision: LedgerGateDecision,
): LedgerGateRefusalDecision | null {
  if (decision.status === "missing") {
    const runCtx = getRunContextForStep(stepId);
    const strictMissing = isStrictMissing(runCtx ?? {}, decision.gateMode);
    if (strictMissing) {
      // Strict-missing (green mode or fail_missing=1): always refuse, no concession.
      return decision;
    }
    // Default missing (not strict): reroute once, then concede.
    if (!hasLedgerGateConcession(stepId)) {
      return decision;
    }
    // Concession valve consumed — allow the merge to land.
    return null;
  }
  return decision.status === "red" && decision.gateMode === "green"
    ? decision
    : null;
}

function usesLedgerConcessionAllowance(
  stepId: string,
  decision: LedgerGateRefusalDecision,
): boolean {
  if (decision.status !== "missing") return false;
  const runCtx = getRunContextForStep(stepId);
  return !isStrictMissing(runCtx ?? {}, decision.gateMode);
}

function applyLedgerGateRefusalSync(
  step: { id: string; run_id: string; step_id: string },
  refusal: string,
  recordsLedgerConcession: boolean,
  usesConcessionAllowance: boolean,
): "rerouted" | "failed" | "conceded" {
  const db = getDb();
  const metadata = db.prepare(
    "SELECT retry_count, terminal_reroute_count FROM steps WHERE id = ?",
  ).get(step.id) as { retry_count: number; terminal_reroute_count: number | null } | undefined;
  const policy = getOnFailPolicySync(step.run_id, step.step_id);
  const rerouteMode = getFailureRerouteMode(refusal, policy);
  const terminalRerouteLimitExhausted =
    rerouteMode === "terminal" && (metadata?.terminal_reroute_count ?? 0) >= 1;

  // The default missing-evidence gate owns an independent one-shot allowance;
  // all other terminal refusals continue to obey RAMP's terminal limit.
  if ((!terminalRerouteLimitExhausted || usesConcessionAllowance) && policy?.retry_step) {
    const rerouteResult = rerouteWithPolicy(
      policy,
      step.run_id,
      step.step_id,
      step.id,
      refusal,
      usesConcessionAllowance,
    );
    if (rerouteResult === "rerouted") {
      if (recordsLedgerConcession) {
        db.prepare(
          "UPDATE steps SET ledger_concession_count = COALESCE(ledger_concession_count, 0) + 1 WHERE id = ?",
        ).run(step.id);
      }
      nudgeDispatch();
      finalizeDrainingPause(step.run_id);
      return "rerouted";
    }
  }

  // Default missing-evidence mode is fail-open by design. If its one-time
  // refusal cannot reach a valid producer, concede immediately rather than
  // turning a missing ledger row into a terminal run failure. Strict modes
  // do not use this allowance and continue through the failure path below.
  if (usesConcessionAllowance) {
    logger.warn("Ledger gate refusal could not reach a valid retry target; conceding default missing evidence", {
      runId: step.run_id,
      stepId: step.step_id,
      retryStep: policy?.retry_step,
    });
    return "conceded";
  }

  const retryCount = (metadata?.retry_count ?? 0) + 1;
  db.prepare(
    `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(refusal, retryCount, step.id);
  db.prepare(
    `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
  ).run(step.run_id);
  const workflowId = getWorkflowId(step.run_id);
  emitEvent({
    ts: new Date().toISOString(),
    event: "step.failed",
    runId: step.run_id,
    workflowId,
    stepId: step.step_id,
    detail: refusal,
  });
  emitRunTerminalEvent({
    event: "run.failed",
    runId: step.run_id,
    workflowId,
    detail: refusal,
  });
  scheduleRunCronTeardown(step.run_id);
  finalizeDrainingPause(step.run_id);
  return "failed";
}

/**
 * Fail a step, with retry logic. For loop steps, applies per-story retry.
 * `options.authority` is the opt-in MTLK-STEP authority seam (see
 * StepMutationOptions): evaluated at entry and again after the only await,
 * immediately before any mutation is applied (both the on_fail.retry_step
 * reroute and the terminal run-failure transition are guarded).
 */
export async function failStep(
  stepId: string,
  error: string,
  options?: StepMutationOptions,
): Promise<{ status: string }> {
  stepId = stripIdPrefix(stepId);
  const result = await failStepInternal(stepId, error, options);
  // A retry re-pends the step (or its story) — nudge the daemon so the
  // dispatch motor retries immediately instead of on the fallback sweep.
  if (result.status === "retrying") {
    nudgeDispatch();
  }
  return result;
}

async function failStepInternal(
  stepId: string,
  error: string,
  options?: StepMutationOptions,
): Promise<{ status: string }> {
  stepId = stripIdPrefix(stepId);
  const db = getDb();

  const step = db.prepare(
    "SELECT id, run_id, step_id, agent_id, status, retry_count, max_retries, reroute_count, terminal_reroute_count, type, current_story_id, claim_job_id, claim_pid, claim_pgid, claim_updated_at, claim_invalidated_by, updated_at FROM steps WHERE id = ?"
  ).get(stepId) as {
    id: string;
    run_id: string;
    step_id: string;
    agent_id: string;
    status: string;
    retry_count: number;
    max_retries: number;
    reroute_count: number | null;
    terminal_reroute_count: number | null;
    type: string;
    current_story_id: string | null;
    claim_job_id: string | null;
    claim_pid: number | null;
    claim_pgid: number | null;
    claim_updated_at: string | null;
    claim_invalidated_by: string | null;
    updated_at: string;
  } | undefined;

  if (!step) {
    // Try to recover agent_id and run_id for the error hint
    const stepInfo = db.prepare("SELECT agent_id, run_id FROM steps WHERE id = ?").get(stepId) as { agent_id: string; run_id: string } | undefined;
    const hint = stepInfo
      ? `\nIf you lost your step id, run: tamandua step current ${stepInfo.agent_id} --run-id ${stepInfo.run_id}\nIf this is a run id, step fail expects a step id — you may have passed the wrong identifier.`
      : `\nIf you lost your step id, run: tamandua step current <agent-id> --run-id <run-id>\nIf this is a run id, step fail expects a step id — you may have passed the wrong identifier.`;
    logger.warn(`Rejected step fail: Step not found: ${stepId}`, { stepId });
    throw new Error(`Step not found: ${stepId}${hint}`);
  }

  // ── MTLK-STEP authority seam (opt-in): synchronous entry check ─────
  // No await has happened yet, but refuse early with zero mutation/events so
  // a foreign/revoked invocation never drives fail transitions. The seam is
  // re-checked after the only await below.
  const entryRefusal = options?.authority
    ? options.authority({
        stepRowId: step.id,
        stepId: step.step_id,
        runId: step.run_id,
        status: step.status,
        claimJobId: step.claim_job_id,
        claimPid: step.claim_pid,
        claimPgid: step.claim_pgid,
        claimUpdatedAt: step.claim_updated_at,
        updatedAt: step.updated_at,
        claimInvalidatedBy: step.claim_invalidated_by,
      })
    : null;
  if (entryRefusal !== null && entryRefusal !== undefined) {
    return { status: "blocked" };
  }

  // Loop step failure — per-story retry
  if (step.type === "loop" && step.current_story_id) {
    const story = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE id = ?"
    ).get(step.current_story_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (story) {
      const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id!) as { story_id: string; title: string } | undefined;
      const newRetry = story.retry_count + 1;
      if (newRetry > story.max_retries) {
        db.prepare(`UPDATE stories SET status = 'failed', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newRetry, story.id);
        db.prepare(`UPDATE steps SET status = 'failed', output = ?, current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(error, stepId);
        db.prepare(`UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId, storyId: storyRow?.story_id, storyTitle: storyRow?.title, detail: error });
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId, detail: error });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story retries exhausted" });
        scheduleRunCronTeardown(step.run_id);
        finalizeDrainingPause(step.run_id);

        return { status: "failed" };
      }

      // Retry the story
      db.prepare(`UPDATE stories SET status = 'pending', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(newRetry, story.id);
      db.prepare(`UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(stepId);
      finalizeDrainingPause(step.run_id);
      return { status: "retrying" };
    }
  }

  // Single step: existing logic
  const newRetryCount = step.retry_count + 1;

  if (newRetryCount > step.max_retries) {
    // ── MTLK-STEP authority seam (opt-in): fresh-row re-check helper ──
    // getOnFailPolicy is awaited BEFORE the retry-exhausted branch's
    // mutations. While that await is in flight the authoritative claim row
    // may change (host revocation / supersession / reassignment / release),
    // so the guard must be re-evaluated AFTER the await on a FRESH row read
    // and immediately BEFORE the mutation it authorizes. This helper re-reads
    // the step row synchronously and re-runs the guard; it returns a refusal
    // detail string, or null when authorized (or when no guard was
    // configured). It never throws and performs no mutation or event.
    const authorityRefusalOnFreshRow = (): string | null => {
      if (!options?.authority) return null;
      const fresh = db.prepare(
        "SELECT id, run_id, step_id, agent_id, status, claim_job_id, claim_pid, claim_pgid, claim_updated_at, claim_invalidated_by, updated_at FROM steps WHERE id = ?",
      ).get(stepId) as {
        id: string; run_id: string; step_id: string; agent_id: string; status: string;
        claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null;
        claim_updated_at: string | null; claim_invalidated_by: string | null; updated_at: string;
      } | undefined;
      if (!fresh) {
        return `authoritative step row ${stepId} no longer exists at fail re-check`;
      }
      const refusal = options.authority({
        stepRowId: fresh.id,
        stepId: fresh.step_id,
        runId: fresh.run_id,
        status: fresh.status,
        claimJobId: fresh.claim_job_id,
        claimPid: fresh.claim_pid,
        claimPgid: fresh.claim_pgid,
        claimUpdatedAt: fresh.claim_updated_at,
        updatedAt: fresh.updated_at,
        claimInvalidatedBy: fresh.claim_invalidated_by,
      });
      // Seam contract: null (or undefined) authorizes; a detail string refuses.
      return refusal === null || refusal === undefined ? null : refusal;
    };

    // ── RETR: check on_fail.retry_step before failing the run ──
    // Rerouting to an upstream producer allows the run to recover when
    // a consumer's failure root cause lives in producer output.
    // Falls through to normal run failure on budget exhaustion,
    // invalid target, or when no retry_step is declared.
    let terminalRerouteLimitExhausted = false;
    let targetMovedBudgetExhausted = false;
    try {
      const policy = await getOnFailPolicy(step.run_id, step.step_id);

      // ── MTLK-STEP authority seam (opt-in): re-check AFTER the await and
      // BEFORE any retry-exhausted mutation ──
      // rerouteWithPolicy below re-pends the producer with feedback, resets
      // the consumer to waiting, updates the reroute counters and emits
      // step.rerouted; the fall-through failure UPDATE terminates the run.
      // A host revocation/supersession that happened while the policy lookup
      // was in flight must not let this (revoked) invocation drive either
      // mutation, so the guard is re-evaluated here on a fresh row read and
      // the branch is refused with { status: "blocked" } — zero mutation,
      // zero events, claim retained — when authority was lost.
      const rerouteRefusal = authorityRefusalOnFreshRow();
      if (rerouteRefusal !== null) {
        return { status: "blocked" };
      }

      const rerouteMode = getFailureRerouteMode(error, policy);
      terminalRerouteLimitExhausted =
        rerouteMode === "terminal" && (step.terminal_reroute_count ?? 0) >= 1;
      const rerouteResult = terminalRerouteLimitExhausted
        ? "budget_exhausted"
        : policy?.retry_step
          ? rerouteWithPolicy(policy, step.run_id, step.step_id, stepId, error)
          : "not_found";
      if (rerouteResult === "rerouted") {
        nudgeDispatch();
        finalizeDrainingPause(step.run_id);
        return { status: "rerouted" };
      }
      if (rerouteResult === "invalid_target") {
        // Spec error: retry_step targets a downstream or unknown step.
        // Fail the run with a clear message so the bug is visible.
        error = `Run failed: step "${step.step_id}" declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step (must have lower step_index).`;
        logger.error(error, { runId: step.run_id, stepId: step.step_id });
      }
      if (rerouteResult === "target_moved_exhausted") {
        // REROUTE-BUDGET (NPF-3): the stale-tip budget is spent. Replace the
        // raw refusal with a legible, greppable reason so the terminal block
        // below writes FAILURE_CLASS: target_moved_exhausted to steps.output
        // and to the step.failed / run.failed events verbatim.
        targetMovedBudgetExhausted = true;
        error = buildTargetMovedExhaustedReason(stepId, policy, error);
        logger.error(error, { runId: step.run_id, stepId: step.step_id });
      }
      // budget_exhausted falls through to normal failure below
    } catch (e) {
      logger.error("reroute failed", { runId: step.run_id, stepId, error: e });
      const wfIdCatch = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfIdCatch, stepId, detail: String(e) });
      // Best-effort: fall through to normal failure
    }

    // ── MTLK-STEP authority seam (opt-in): re-check BEFORE the terminal
    // failure transition ──
    // Only reached when no reroute was applied (policy lookup failure /
    // budget exhaustion / invalid target / no retry_step declared): the
    // failure UPDATE below still terminates the run, so authority lost
    // across the await must refuse it too. The recheck above already ran
    // after the await on the happy policy path; this second evaluation on
    // the same fresh row state is the guard for the fall-through and
    // policy-exception paths. No events are emitted and nothing mutates on
    // refusal.
    const failureRefusal = authorityRefusalOnFreshRow();
    if (failureRefusal !== null) {
      return { status: "blocked" };
    }

    db.prepare(
      `UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(error, newRetryCount, stepId);
    db.prepare(
      `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(step.run_id);
    const wfId2 = getWorkflowId(step.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId2, stepId, detail: error });
    emitRunTerminalEvent({
      event: "run.failed",
      runId: step.run_id,
      workflowId: wfId2,
      detail: terminalRerouteLimitExhausted || targetMovedBudgetExhausted ? error : "Step retries exhausted",
    });
    scheduleRunCronTeardown(step.run_id);
    finalizeDrainingPause(step.run_id);

    // Rugpull detection: for single step failures, check if the base branch
    // moved under the run and launch a replacement. Fire-and-forget via
    // setImmediate so errors never block step failure completion.
    if (step.type !== "loop") {
      setImmediate(async () => {
        try {
          const rugResult = detectRugpull(step.run_id);
          if (rugResult.isRugpull) {
            emitEvent({
              ts: new Date().toISOString(),
              event: "run.rugpull_detected",
              runId: step.run_id,
              workflowId: wfId2,
              detail: rugResult.reason,
            });
            const relaunchResult = await relaunchRunAfterRugpull(step.run_id);
            if (!relaunchResult.relaunched) {
              // The function itself emits events for all failure/suppression paths,
              // but log a warning so the failure is visible in system logs as well.
              logger.warn("Rugpull relaunch did not launch a replacement run", {
                runId: step.run_id,
                result: relaunchResult,
              });
            }
          }
        } catch (err) {
          // fire-and-forget — errors must not prevent step failure from completing
          logger.error("Rugpull detection/relaunch threw unexpectedly", {
            runId: step.run_id,
            error: String(err),
          });
        }
      });
    }

    return { status: "failed" };
  } else {
    db.prepare(
      `UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
    ).run(error, newRetryCount, stepId);
    finalizeDrainingPause(step.run_id);
    return { status: "retrying" };
  }
}

// ══════════════════════════════════════════════════════════════════════
// RETR: Cross-Step Retry Routing
// ══════════════════════════════════════════════════════════════════════

/**
 * When a reroute targets a loop-over-stories step, parse story IDs (US-\d+)
 * from the consumer's failure text and reset matching done stories to pending.
 * If no IDs found, fall back to resetting the most recently updated done story
 * (mirroring handleVerifyEachCompletion's heuristic).
 *
 * Only resets stories with status='done'. Pending/running stories are left
 * untouched. Story IDs in the failure text that don't exist in the DB are
 * silently ignored (logged as a warning).
 *
 * Writes the consumer failure text into the run's context as verify_feedback
 * so the developer agent's next claim renders it.
 */
function resetStoriesOnReroute(
  db: ReturnType<typeof getDb>,
  runId: string,
  targetStep: { id: string; step_id: string; type: string; loop_config: string | null },
  failureText: string,
  workflowId: string | undefined,
): void {
  // Only applicable for loop-over-stories steps
  if (targetStep.type !== "loop") return;
  if (!targetStep.loop_config) return;

  let loopConfig: LoopConfig;
  try {
    loopConfig = JSON.parse(targetStep.loop_config) as LoopConfig;
  } catch {
    return; // malformed loop_config, skip
  }
  if (loopConfig.over !== "stories") return;

  // Parse US-\d+ story IDs from the failure text
  const storyIds = failureText.match(/US-\d+/g) ?? [];

  let resetCount = 0;

  if (storyIds.length > 0) {
    for (const storyId of storyIds) {
      const story = db.prepare(
        "SELECT id, story_id, title, status, retry_count, max_retries FROM stories WHERE run_id = ? AND story_id = ?"
      ).get(runId, storyId) as { id: string; story_id: string; title: string; status: string; retry_count: number; max_retries: number } | undefined;

      if (!story) {
        logger.warn(`Story ID "${storyId}" in reroute failure text not found in DB`, { runId, workflowId });
        continue;
      }

      if (story.status !== "done") {
        // Don't reset stories that are already pending or running
        continue;
      }

      const newRetry = story.retry_count + 1;
      if (newRetry > story.max_retries) {
        // Story retry budget exhausted — transition to failed
        db.prepare(
          `UPDATE stories SET status = 'failed', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, story.id);
        emitEvent({
          ts: new Date().toISOString(),
          event: "story.failed",
          runId,
          workflowId,
          stepId: targetStep.step_id,
          storyId: story.story_id,
          storyTitle: story.title,
          detail: "Reroute — story retries exhausted",
        });
        resetCount++;
        logger.info(`Story ${storyId} transitioned to failed via reroute — retries exhausted (${newRetry}/${story.max_retries})`, { runId, workflowId });
      } else {
        db.prepare(
          `UPDATE stories SET status = 'pending', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, story.id);
        resetCount++;
        logger.info(`Story ${storyId} reset to pending via reroute (retry ${newRetry})`, { runId, workflowId });
      }
    }
  }

  // Fallback: if no story IDs parsed OR none matched in the DB, use the
  // handleVerifyEachCompletion heuristic: most recently updated done story.
  if (resetCount === 0) {
    const lastDoneStory = db.prepare(
      "SELECT id, story_id, title, retry_count, max_retries FROM stories WHERE run_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1"
    ).get(runId) as { id: string; story_id: string; title: string; retry_count: number; max_retries: number } | undefined;

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        // Story retry budget exhausted — transition to failed
        db.prepare(
          `UPDATE stories SET status = 'failed', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, lastDoneStory.id);
        resetCount++;
        emitEvent({
          ts: new Date().toISOString(),
          event: "story.failed",
          runId,
          workflowId,
          stepId: targetStep.step_id,
          storyId: lastDoneStory.story_id,
          storyTitle: lastDoneStory.title,
          detail: "Reroute — story retries exhausted",
        });
        logger.info(
          `Story ${lastDoneStory.story_id} transitioned to failed via reroute fallback — retries exhausted (${newRetry}/${lastDoneStory.max_retries})`,
          { runId, workflowId },
        );
      } else {
        db.prepare(
          `UPDATE stories SET status = 'pending', retry_count = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`
        ).run(newRetry, lastDoneStory.id);
        resetCount++;
        logger.info(
          `Story ${lastDoneStory.story_id} reset to pending via reroute fallback heuristic (retry ${newRetry})`,
          { runId, workflowId },
        );
      }
    }
  }

  // Story reset complete. verify_feedback context is written by the caller
  // (the async failure path / rerouteStepSync) after this function returns, so it
  // can happen unconditionally for loop-targeted reroutes.
}

/**
 * Writes verify_feedback and retry_feedback into the run's context JSON
 * when a reroute targets a loop-over-stories step. The developer agent's
 * next claim then surfaces this feedback for story remediation.
 *
 * Call from rerouteWithPolicy after story reset logic, so
 * verify_feedback is always available even when no stories were reset
 * (e.g. all cited stories were already pending).
 */
function writeRerouteFeedbackContext(
  db: ReturnType<typeof getDb>,
  runId: string,
  targetStep: { type: string; loop_config: string | null },
  failureText: string,
): void {
  if (targetStep.type !== "loop") return;
  if (!targetStep.loop_config) return;

  let loopConfig: LoopConfig;
  try {
    loopConfig = JSON.parse(targetStep.loop_config) as LoopConfig;
  } catch {
    return; // malformed loop_config, skip
  }
  if (loopConfig.over !== "stories") return;

  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!run) return;

  const context: Record<string, string> = parseRunContext(runId, run.context);
  context["verify_feedback"] = failureText;
  context["retry_feedback"] = failureText;
  db.prepare(`UPDATE runs SET context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`).run(
    JSON.stringify(context),
    runId,
  );
}

/**
 * Sync wrapper around rerouteWithPolicy. Resolves the on_fail policy
 * synchronously via getOnFailPolicySync, then delegates to the shared core.
 *
 * Every rerouteStepSync caller is a consumer retry-exhaustion corridor
 * (completeStep retry-verdict / expects-validation, orphan-recovery
 * exhaustion). The reroute's class is derived purely from the driving
 * reason: unless it carries a terminal FAILURE_CLASS header these are
 * ORDINARY (non-terminal-class) reroutes — they increment reroute_count
 * only, and terminal_reroute_count stays untouched so the consumer keeps
 * its one-shot terminal allowance (terminal_reroute_count is a gate
 * control counting terminal-CLASS reroutes exclusively). The emitted
 * step.rerouted event carries terminal:false + rerouteMode so the two
 * counters reconcile against the event stream.
 */
function rerouteStepSync(
  runId: string,
  consumerStepId: string,
  consumerRowId: string,
  error: string,
): "rerouted" | "budget_exhausted" | "target_moved_exhausted" | "invalid_target" | "not_found" {
  const policy = getOnFailPolicySync(runId, consumerStepId);
  if (!policy?.retry_step) return "not_found";
  return rerouteWithPolicy(policy, runId, consumerStepId, consumerRowId, error);
}

// ══════════════════════════════════════════════════════════════════════
// Resolve Step Context
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve the full template context for a step in a run.
 * Collects context from the run's saved context, previous steps' KEY: value output,
 * and computed values like branch info, PR info, and frontend detection.
 * Optionally adds story context for loop steps.
 */
export function resolveStepContext(
  runId: string,
  stepIndex: number,
  loopConfig?: LoopConfig,
  story?: Story,
  /**
   * Opt-in guest-visible progress pointer (MTLK-PROGRESS). When provided, the
   * `progress`/`progress_file` context rendered for this step references this
   * guest file instead of the host canonical `<state>/runs/<runId>/progress.txt`.
   * Native no-flag callers omit it (byte-identical behavior).
   */
  progressFileOverride?: string
): Record<string, string> {
  const db = getDb();

  // Start with the run's stored context
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  const context: Record<string, string> = run ? parseRunContext(runId, run.context) : {};

  // Always inject run_id so templates can use {{run_id}}
  context["run_id"] = runId;

  // Collect output from previous completed steps
  const prevSteps = db.prepare(
    "SELECT id, output, step_id, type FROM steps WHERE run_id = ? AND step_index < ? AND status IN ('done', 'skipped') ORDER BY step_index ASC"
  ).all(runId, stepIndex) as { id: string; output: string | null; step_id: string; type: string }[];

  for (const prev of prevSteps) {
    if (prev.output) {
      const parsed = parseOutputKeyValues(prev.output);
      for (const [key, value] of Object.entries(parsed)) {
        if (!RESERVED_CONTEXT_KEYS.has(key)) {
          context[key] = value;
        }
      }
    }
  }

  // Add branch info and PR detection context (extracted from previous step outputs)
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  }

  // Add PR info if available from context
  if (context["pr_url"]) {
    context["has_pr"] = "true";
  }

  // Add story context for loop steps
  if (story && loopConfig) {
    context["current_story"] = formatStoryForTemplate(story);
    context["current_story_id"] = story.storyId;
    context["current_story_title"] = story.title;

    const allStories = getStories(runId);
    context["completed_stories"] = formatCompletedStories(allStories);
    const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;
    context["stories_remaining"] = String(pendingCount);
    const progressPointer = progressFileOverride ?? getRunProgressPath(runId);
    context["progress"] = `stored in the file ${progressPointer} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
    context["progress_file"] = progressPointer;

    if (!context["verify_feedback"]) {
      context["verify_feedback"] = "";
    }

    // Format retry_feedback from the run context (e.g. set by
    // writeRerouteFeedbackContext) using the story-level retry count.
    if (context["retry_feedback"]) {
      context["retry_feedback"] = formatRetryFeedback(
        context["retry_feedback"],
        story.retryCount,
      );
    }
  }

  return context;
}

// ══════════════════════════════════════════════════════════════════════
// Step Release (Operator Recovery)
// ══════════════════════════════════════════════════════════════════════

export interface ReleaseStepResult {
  released: boolean;
  stepId?: string;
  reason?: string;
  /** When multiple claimed/running steps exist and no step-id given */
  claimedSteps?: { stepId: string; agentId: string; claimPid: number | null }[];
  /** When the worker is alive and no --force */
  alivePid?: number;
}

/**
 * Release a stuck claimed/running step back to pending so the motor re-dispatches it.
 * Clears claim fields (claim_job_id, claim_pid, claim_pgid, claim_updated_at) but does
 * NOT increment retry_count — this is an operator action, not a failure.
 *
 * Without stepId: acts on the single claimed/running step if exactly one exists;
 * with multiple, returns a list requiring step-id selection.
 *
 * Liveness guard: if the claiming worker's PID is still alive, refuses unless force=true.
 * force does NOT terminate the worker — it only clears claim fields.
 *
 * Emits a step.released event on success.
 */
export function releaseStep(runId: string, stepId?: string, force?: boolean): ReleaseStepResult {
  if (stepId) stepId = stripIdPrefix(stepId);
  const db = getDb();
  const wfId = getWorkflowId(runId);

  // Find claimed/running steps for this run
  const claimedSteps = db.prepare(
    `SELECT s.id, s.step_id, s.agent_id, s.claim_pid
     FROM steps s
     WHERE s.run_id = ? AND s.status = 'running'
     ORDER BY s.step_index ASC`
  ).all(runId) as { id: string; step_id: string; agent_id: string; claim_pid: number | null }[];

  if (claimedSteps.length === 0) {
    return { released: false, reason: `No running steps found for run ${runId.slice(0, 8)}` };
  }

  // Determine the target step(s)
  let target: { id: string; step_id: string; agent_id: string; claim_pid: number | null } | undefined;

  if (stepId) {
    // Look for stepId as either row id or step_id (the workflow-defined step id)
    target = claimedSteps.find(
      (s) => s.id === stepId || s.id.startsWith(stepId),
    );
    if (!target) {
      return { released: false, reason: `Step "${stepId}" not found among running steps in run ${runId.slice(0, 8)}` };
    }
  } else {
    if (claimedSteps.length > 1) {
      return {
        released: false,
        reason: `Multiple running steps found. Specify which step to release with step-id:`,
        claimedSteps: claimedSteps.map((s) => ({
          stepId: s.id,
          agentId: s.agent_id,
          claimPid: s.claim_pid,
        })),
      };
    }
    target = claimedSteps[0];
  }

  // Liveness guard: check if the claiming worker is still alive
  if (target.claim_pid != null && target.claim_pid > 0) {
    try {
      process.kill(target.claim_pid, 0);
      // PID is alive — refuse unless forced
      if (!force) {
        return {
          released: false,
          stepId: target.id,
          reason: `Worker for step ${target.id.slice(0, 8)} (${target.agent_id}) is still alive (PID ${target.claim_pid}). Use --force to release anyway.`,
          alivePid: target.claim_pid,
        };
      }
    } catch (err) {
      // ESRCH = process dead — proceed with release
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        // EPERM or other error — treat as alive
        if (!force) {
          return {
            released: false,
            stepId: target.id,
            reason: `Cannot determine liveness of worker for step ${target.id.slice(0, 8)} (PID ${target.claim_pid}). Use --force to release anyway.`,
            alivePid: target.claim_pid,
          };
        }
      }
    }
  }

  // Release the step: clear claim fields, set status back to pending
  db.prepare(
    `UPDATE steps
     SET status = 'pending',
         claim_job_id = NULL,
         claim_pid = NULL,
         claim_pgid = NULL,
         claim_updated_at = NULL,
         updated_at = ${SQL_NOW_ISO}
     WHERE id = ?`
  ).run(target.id);

  // Emit step.released event
  emitEvent({
    ts: new Date().toISOString(),
    event: "step.released",
    runId,
    workflowId: wfId,
    stepId: target.id,
    agentId: target.agent_id,
    detail: force ? `Force-released by operator` : `Released by operator`,
  });

  logger.info(`Step ${target.id.slice(0, 8)} released back to pending`, {
    runId,
    stepId: target.id,
    agentId: target.agent_id,
    forced: !!force,
  });

  return { released: true, stepId: target.id };
}
