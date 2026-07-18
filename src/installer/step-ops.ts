import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { resolvePiStateDir, resolveWorkflowDir, resolveTamanduaCli, resolveRunRoot } from "./paths.js";
import { teardownWorkflowCronsIfIdle } from "./agent-scheduler.js";
import { emitEvent, beginEventBuffering, flushEventBuffer, discardEventBuffer } from "./events.js";
import { logger } from "../lib/logger.js";
import { getMaxRoleTimeoutSeconds } from "./install.js";
import { loadWorkflowSpec, loadWorkflowSpecSync } from "./workflow-spec.js";
import { isFrontendChange } from "../lib/frontend-detect.js";
import type { LoopConfig, Story, WorkflowStepFailure } from "./types.js";
import { detectRugpull, relaunchRunAfterRugpull } from "./rugpull.js";
import { getPgid } from "../lib/proc-info.js";

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
           updated_at = datetime('now')
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
    "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(message, stepRowId);
  db.prepare(
    "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE runs SET scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
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

function emitRunTerminalEvent(params: {
  event: "run.completed" | "run.failed";
  runId: string;
  workflowId?: string;
  detail?: string;
}): void {
  emitEvent({
    ts: new Date().toISOString(),
    event: params.event,
    runId: params.runId,
    workflowId: params.workflowId,
    detail: params.detail,
    tokensSpent: getRunTokenSpend(params.runId),
    workerLostCount: getRunWorkerLostCount(params.runId),
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
 * Return the canonical progress file path for a run.
 * Location: <tamandua state>/runs/<runId>/progress.txt
 */
export function getRunProgressPath(runId: string): string {
  return path.join(resolveRunRoot(), runId, "progress.txt");
}

/**
 * Read progress.txt for a run.
 *
 * Lookup order (backward-compatible):
 * 1. Canonical path: <tamandua state>/runs/<runId>/progress.txt
 * 2. Workspace-scoped: <agent workspace>/progress-<runId>.txt
 * 3. Workspace-legacy:  <agent workspace>/progress.txt
 */
export function readProgressFile(runId: string): string {
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
 * Writes to the canonical progress file at <tamandua state>/runs/<runId>/progress.txt,
 * preserving any existing Codebase Patterns or other sections.
 * Emits a 'stories.planned' event on success.
 */
export function writeStoryPlanToProgress(runId: string): void {
  if (!runHasStories(runId)) return;

  try {
    const stories = getStories(runId);
    if (stories.length === 0) return;

    const storyPlanSection = buildStoryPlanSection(stories);
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
    updatedAt: r.updated_at ?? undefined,
  }));
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
export function cleanupAbandonedSteps(): void {
  const db = getDb();
  const thresholdMs = ABANDONED_THRESHOLD_MS;

  const abandonedSteps = db.prepare(
    "SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config, abandoned_count FROM steps WHERE status = 'running' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null; abandoned_count: number;
  }[];

  for (const step of abandonedSteps) {
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
            "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
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
          db.prepare("UPDATE stories SET status = 'failed', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?").run(newAbandoned, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Story abandoned — abandon budget exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          const aggregate = buildAbandonReasonAggregate(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: `Abandoned — ${aggregate}` });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story abandoned — ${aggregate}` });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: `Story abandoned — ${aggregate}` });
          scheduleRunCronTeardown(step.run_id);
        } else {
          db.prepare("UPDATE stories SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?").run(newAbandoned, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
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
        "UPDATE steps SET status = 'failed', output = 'Agent abandoned step without completing (' || ? || ' times)', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, newAbandonCount, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Retries exhausted — step failed` });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent abandoned step without completing" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step abandoned and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
    } else {
      db.prepare(
        "UPDATE steps SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, step.id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, detail: `Reset to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})` });
    }
  }

  // Reset running stories that are abandoned — don't touch "done" stories
  const abandonedStories = db.prepare(
    "SELECT id, retry_count, max_retries, run_id FROM stories WHERE status = 'running' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as { id: string; retry_count: number; max_retries: number; run_id: string }[];

  for (const story of abandonedStories) {
    db.prepare("UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(story.id);
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
 */
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
): { recovered: number; failed: number; skipped: number } {
  const db = getDb();

  // Run-scoped query. Every caller (polling round, control plane,
  // shutdown paths) supplies a runId so concurrent runs of the same
  // workflow + agent are isolated.
  const clauses: string[] = ["agent_id = ?", "status = 'running'", "run_id = ?"];
  const params: (string | number)[] = [agentId, runId];
  if (staleThresholdMs !== undefined) {
    clauses.push("(julianday('now') - julianday(updated_at)) * 86400000 >= ?");
    params.push(staleThresholdMs);
  }
  // Ownership-aware filter: when workerJobId is provided, skip steps
  // claimed by a different worker (claim_job_id mismatch). Steps with
  // NULL claim_job_id (legacy, pre-ownership) are always recovered.
  if (workerJobId !== undefined) {
    clauses.push("(claim_job_id IS NULL OR claim_job_id = ?)");
    params.push(workerJobId);
  }
  const query = `SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config
       FROM steps
       WHERE ${clauses.join(" AND ")}`;

  const steps = db.prepare(query).all(...params) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null;
  }[];

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const step of steps) {
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

        // Persist abandonment into story_abandonments table (telemetry — must not block recovery)
        try {
          db.prepare(
            "INSERT INTO story_abandonments (id, story_id, run_id, reason, abandoned_count, step_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
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
          db.prepare("UPDATE stories SET status = 'failed', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?").run(newAbandoned, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Agent terminated without completing story; abandon budget exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          const aggregate = buildAbandonReasonAggregate(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: `Agent terminated — ${aggregate}` });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Agent terminated without completing story; ${aggregate}` });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: `Agent terminated without completing story; ${aggregate}` });
          scheduleRunCronTeardown(step.run_id);
          failed++;
        } else {
          db.prepare("UPDATE stories SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?").run(newAbandoned, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          const storyRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
          const storyRecoveryDetail = workerJobId !== undefined
            ? `Worker ${workerJobId} exited without completing story ${story.story_id}; reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`
            : `Agent terminated; story ${story.story_id} reset to pending (story abandon ${newAbandoned}/${ABANDON_STORY_MAX})`;
          const storyPrefix = detailPrefix ? `[${detailPrefix}] ` : "";
          if (storyRecoveryEvent === "step.worker_lost") {
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
            });
          } catch (err) {
            logger.warn(`Recovery event emit failed for story ${story.story_id} (run ${step.run_id}, step ${step.step_id}): ${err instanceof Error ? err.message : String(err)}`, {
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
    if (newRetry > step.max_retries) {
      // ── RETR: check on_fail.retry_step before failing the run ──
      // Orphan recovery exhaustion means the agent (or harness) died
      // without completing or failing the step. If the workflow declares
      // a retry_step target, reroute instead of killing the run.
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id,
          "Agent terminated without completing step; retries exhausted");
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
        // budget_exhausted / not_found falls through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        "UPDATE steps SET status = 'failed', retry_count = ?, output = 'Agent terminated without completing step; retries exhausted', updated_at = datetime('now') WHERE id = ?"
      ).run(newRetry, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
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
          "UPDATE steps SET status = 'pending', retry_count = ?, output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, failureReason, step.id);
      } else {
        db.prepare(
          "UPDATE steps SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, step.id);
      }
      const stepRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
      const stepRecoveryDetail = workerJobId !== undefined
        ? `Worker ${workerJobId} exited without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`
        : `Agent terminated without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`;
      const stepPrefix = detailPrefix ? `[${detailPrefix}] ` : "";
      if (stepRecoveryEvent === "step.worker_lost") {
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
      });
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
): {
  recovered: number;
  failed: number;
  skipped: number;
  runIds: string[];
} {
  const db = getDb();

  const steps = db.prepare(
    `SELECT s.id, s.agent_id, s.run_id, s.claim_pgid, s.claim_job_id
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
    // round that just finished and is mid-report.
    const claimAge = db.prepare(
      `SELECT (julianday('now') - julianday(claim_updated_at)) * 86400000 AS age_ms
       FROM steps WHERE id = ?`
    ).get(step.id) as { age_ms: number | null } | undefined;
    if (!claimAge || claimAge.age_ms === null) {
      // No claim timestamp available — can't determine freshness.
      // Be conservative: leave it for the timeout sweeper.
      totals.skipped += 1;
      continue;
    }
    if (claimAge.age_ms < LIVENESS_GRACE_PERIOD_MS) {
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
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), runId);
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
 */
let lastCleanupTime = 0;
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Wrap test_cmd with the tamandua-test shim invocation if present in context.
 * Saves the original command as test_cmd_raw and replaces test_cmd with the
 * wrapped shim invocation (R18, R19).
 *
 * Example: if test_cmd = "npm test", replaces it with:
 *   tamandua-test --repo <repo> --run <run_id> --step <step_id> -- 'npm test'
 *
 * SHSH: The command is single-quoted (with embedded single quotes
 * properly escaped) so that shell operators (&&, |, env prefixes, etc.)
 * survive the agent's shell and reach the shim as a single argv element.
 *
 * Does nothing if test_cmd is missing, empty, or whitespace-only.
 */
function wrapTestCmdInContext(
  context: Record<string, string>,
  repo: string | undefined,
  runId: string,
  stepId: string,
): void {
  const testCmd = context["test_cmd"];
  if (!testCmd || testCmd.trim().length === 0) return;
  if (!repo) return;

  context["test_cmd_raw"] = testCmd;
  // SHSH: single-quote the command with proper escaping of embedded
  // single quotes so it arrives as a single argv element when the
  // agent's shell parses the wrapped line.
  const escaped = testCmd.replace(/'/g, "'\\''");
  context["test_cmd"] = `tamandua-test --repo ${repo} --run ${runId} --step ${stepId} -- '${escaped}'`;
}

/**
 * Query the currently held (claimed/running) step for an agent in a run.
 * Pure read-only query — no state mutation. Returns the step's claim JSON
 * ({ stepId, runId, input }) or null when the agent holds no in-flight step.
 */
export function stepCurrent(agentId: string, runId: string): { stepId: string; runId: string; input: string } | null {
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
  const context = resolveStepContext(step.run_id, step.step_index, loopConfig, story);

  if (!context["verify_feedback"]) context["verify_feedback"] = "";
  if (!context["timeout_retry"]) context["timeout_retry"] = "";

  // Wrap test_cmd with tamandua-test shim (R18-R19)
  if (context["repo"]) {
    wrapTestCmdInContext(context, context["repo"], step.run_id, step.id);
  }

  const resolvedInput = resolveTemplate(step.input_template, context);

  return { stepId: step.id, runId: step.run_id, input: resolvedInput };
}

/**
 * Find and claim a pending step for an agent, returning the resolved input.
 */
export function claimStep(agentId: string, runId: string, workerOwnership?: WorkerOwnership): ClaimResult {
  // Throttle cleanup: run at most once every 5 minutes across all agents
  const now = Date.now();
  if (now - lastCleanupTime >= CLEANUP_THROTTLE_MS) {
    cleanupAbandonedSteps();
    lastCleanupTime = now;
  }

  // SCUR-1: Idempotent re-claim — if the calling agent already holds an
  // in-flight step in this run, re-return it instead of NO_WORK.
  // stepCurrent is a pure read-only query; it does not reset progress,
  // bump retry counts, or change claim timestamps.
  const heldStep = stepCurrent(agentId, runId);
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
  // Run-scoped claim: concurrent runs of the same workflow + agent never
  // cross-claim because the WHERE clause pins to a specific run_id.
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

  // Guard: don't claim work for a terminal/paused run
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(step.run_id) as { status: string } | undefined;
  if (runStatus?.status !== "running") return { found: false };

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
          ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
          : "UPDATE steps SET status = 'running', claim_invalidated_by = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
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
          "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(message, step.id);
        db.prepare(
          "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
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
            "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
          ).run("Loop cannot continue because one or more stories failed", step.id);
          db.prepare(
            "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
        advancePipeline(step.run_id);
        return { found: false };
      }

      // Claim the story. If another duplicate poller won it first, undo this
      // loop claim and let the next polling round inspect current state.
      const storyClaim = db.prepare(
        "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(nextStory.id);
      if ((storyClaim.changes ?? 0) <= 0) {
        db.prepare(
          "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        return { found: false };
      }
      db.prepare(
        workerOwnership
          ? "UPDATE steps SET status = 'running', current_story_id = ?, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          : "UPDATE steps SET status = 'running', current_story_id = ?, claim_invalidated_by = NULL, updated_at = datetime('now') WHERE id = ?"
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
      context["progress"] = `stored in the file ${getRunProgressPath(step.run_id)} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
      context["progress_file"] = getRunProgressPath(step.run_id);

      if (!context["verify_feedback"]) {
        context["verify_feedback"] = "";
      }

      if (!context["timeout_retry"]) {
        context["timeout_retry"] = "";
      }

      // Wrap test_cmd with tamandua-test shim (R18-R19)
      wrapTestCmdInContext(context, context["repo"], step.run_id, step.step_id);

      const missingKeys = findMissingTemplateKeys(step.input_template, context);
      const blockResult = resolveMissingKeys(
        step.run_id, step.step_index, step.step_id, step.id, agentId, missingKeys
      );
      if (blockResult !== 'proceed') {
        if (blockResult === 'rejected') {
          // Unclaim the story
          db.prepare(
            "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
          ).run(nextStory.id);
          // Unclaim the loop step: reset to pending so the scheduler re-evaluates
          db.prepare(
            "UPDATE steps SET status = 'pending', current_story_id = NULL, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = datetime('now') WHERE id = ?"
          ).run(step.id);
        }
        // blockResult is a string (fail message): failRunForMissingTemplateKeys
        // already marked step + run as failed; just bail.
        return { found: false };
      }

      // Clear one-shot timeout_retry so it doesn't leak into subsequent stories.
      // The resolved template must capture it first; delete only after resolution.
      const hasTimeoutRetryLoop = Boolean(context["timeout_retry"]);

      // Persist story context vars to DB so verify_each steps can access them
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);

      const resolvedInput = resolveTemplate(step.input_template, context);

      if (hasTimeoutRetryLoop) {
        delete context["timeout_retry"];
        db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);
      }

        return { found: true, stepId: step.id, runId: step.run_id, resolvedInput };
      } catch (err) {
        // CLTX: post-claim work threw — undo the claim atomically.
        // Don't increment retry_count because the agent never saw the work.
        db.prepare(
          "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        // Reset any running story for this run back to pending
        db.prepare(
          "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE run_id = ? AND status = 'running'"
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
      ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_invalidated_by = NULL, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      : "UPDATE steps SET status = 'running', claim_invalidated_by = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(
    ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
  );
  if ((claim.changes ?? 0) <= 0) return { found: false };
  try {
    emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
    logger.info(`Step claimed by ${agentId}`, { runId: step.run_id, stepId: step.step_id });

    // Inject progress for any step in a run that has stories
    const hasStories = db.prepare(
      "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
    ).get(step.run_id) as { cnt: number };
    if (hasStories.cnt > 0) {
      context["progress"] = `stored in the file ${getRunProgressPath(step.run_id)} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
      context["progress_file"] = getRunProgressPath(step.run_id);
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
    wrapTestCmdInContext(context, context["repo"], step.run_id, step.step_id);

    const missingKeys = findMissingTemplateKeys(step.input_template, context);
    const blockResult = resolveMissingKeys(
      step.run_id, step.step_index, step.step_id, step.id, agentId, missingKeys
    );
    if (blockResult !== 'proceed') {
      if (blockResult === 'rejected') {
        // Unclaim the step: reset to pending so the scheduler re-evaluates
        db.prepare(
          "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
      }
      // blockResult is a string (fail message): failRunForMissingTemplateKeys
      // already marked step + run as failed; just bail.
      return { found: false };
    }

    const resolvedInput = resolveTemplate(step.input_template, context);

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
      "UPDATE steps SET status = 'pending', claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = datetime('now') WHERE id = ?"
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
    .prepare("SELECT scheduling_status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { scheduling_status: string; workflow_id: string } | undefined;
  if (!run || run.scheduling_status !== "draining_pause") return;

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
    "UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now') WHERE id = ?",
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
 * Complete a step: validate expects, save output, merge context, advance pipeline.
 */
export function completeStep(stepId: string, output: string): { status: string; detail?: string } {
  const result = completeStepInternal(stepId, output);

  // Write story plan to progress log after successful completion.
  // Hoisted out of completeStepInternal so that no file I/O executes
  // inside the upcoming database transaction (US-003).
  // writeStoryPlanToProgress is idempotent: it checks runHasStories()
  // and returns early if no stories exist.
  if (result.status === "advanced" || result.status === "completed" || result.status === "rerouted") {
    const runIdRow = getDb().prepare("SELECT run_id FROM steps WHERE id = ?").get(stepId) as { run_id: string } | undefined;
    if (runIdRow) {
      writeStoryPlanToProgress(runIdRow.run_id);
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

function completeStepInternal(stepId: string, output: string): { status: string; detail?: string } {
  const db = getDb();

  const body = (): { status: string; detail?: string } => {
    const step = db.prepare(
    "SELECT id, run_id, step_id, step_index, type, loop_config, current_story_id, expects, input_template, status, claim_invalidated_by, claim_updated_at, updated_at FROM steps WHERE id = ?"
  ).get(stepId) as {
    id: string; run_id: string; step_id: string; step_index: number; type: string;
    loop_config: string | null; current_story_id: string | null; expects: string;
    input_template: string | null; status: string; claim_invalidated_by: string | null;
    claim_updated_at: string | null; updated_at: string;
  } | undefined;

  if (!step) {
    // Try to recover agent_id and run_id for the error hint
    const stepInfo = db.prepare("SELECT agent_id, run_id FROM steps WHERE id = ?").get(stepId) as { agent_id: string; run_id: string } | undefined;
    const hint = stepInfo
      ? `\nIf you lost your step id, run: tamandua step current ${stepInfo.agent_id} --run-id ${stepInfo.run_id}`
      : `\nIf you lost your step id, run: tamandua step current <agent-id> --run-id <run-id>`;
    logger.warn(`Rejected step complete: Step not found: ${stepId}`, { stepId });
    throw new Error(`Step not found: ${stepId}${hint}`);
  }

  // Guard: don't process completions for failed runs
  const runId = step.run_id;
  const runCheck = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runCheck?.status === "failed" || runCheck?.status === "canceled") {
    return { status: "blocked" };
  }

  // Guard: duplicate completion. Delivery is at-least-once (agent CLI
  // retries, orphan-recovery reclaim races, duplicate polling rounds), so a
  // completion can arrive for a step that already reached a terminal
  // status. Re-processing would re-merge context, re-insert STORIES_JSON
  // stories, and re-advance the pipeline. Steps still 'running' — or reset
  // to 'pending' by the stale-claim sweeper — ARE processed: late work is
  // valid work.
  if (step.status === "done" || step.status === "failed" || step.status === "skipped") {
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
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id, validationError);
        if (rerouteResult === "rerouted") {
          return { status: "rerouted", detail: `Rerouted to upstream producer via on_fail.retry_step` };
        }
        if (rerouteResult === "invalid_target") {
          const policy = getOnFailPolicySync(step.run_id, step.step_id);
          logger.error(`Run failed: step "${step.step_id}" declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step (must have lower step_index).`, { runId: step.run_id, stepId: step.step_id });
        }
        // budget_exhausted / not_found falls through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(validationError, newRetry, stepId);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: validationError });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Expects validation failed and retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(validationError, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId, workflowId: wfId, stepId: step.step_id, detail: validationError });
    logger.warn(validationError, { runId, stepId: step.step_id });
    finalizeDrainingPause(runId);
    return { status: "retrying", detail: validationError };
  }

  // Merge KEY: value lines into run context
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const context: Record<string, string> = parseRunContext(runId, run.context);

  const parsed = parseOutputKeyValues(output);
  for (const [key, value] of Object.entries(parsed)) {
    if (!RESERVED_CONTEXT_KEYS.has(key)) {
      context[key] = value;
    }
  }

  db.prepare(
    "UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?"
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
        "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(errorDetail, newRetry, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "STORIES_JSON validation failed and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      finalizeDrainingPause(step.run_id);
      return { status: "failed" };
    }
    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
              "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(errorDetail, newRetry, step.id);
            db.prepare(
              "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
            ).run(step.run_id);
            emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
            emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Plan step never produced STORIES_JSON" });
            scheduleRunCronTeardown(step.run_id);
            finalizeDrainingPause(step.run_id);
            return { status: "failed" };
          }
          db.prepare(
            "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
      "UPDATE stories SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, step.current_story_id);
    emitEvent({ ts: new Date().toISOString(), event: "story.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, storyId: storyRow?.story_id, storyTitle: storyRow?.title });
    logger.info(`Story done: ${storyRow?.story_id} — ${storyRow?.title}`, { runId: step.run_id, stepId: step.step_id });

    // Clear current_story_id, save output
    db.prepare(
      "UPDATE steps SET current_story_id = NULL, output = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
        ).run(verifyStep.id);
        // Loop step stays 'running'
        db.prepare(
          "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
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
      const verifyResult = handleVerifyEachCompletion(step, loopStepRow.id, output, context);
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
      try {
        const rerouteResult = rerouteStepSync(step.run_id, step.step_id, step.id, output);
        if (rerouteResult === "rerouted") {
          return { status: "rerouted", detail: `STATUS: retry verdict — rerouted to upstream producer via on_fail.retry_step` };
        }
        if (rerouteResult === "invalid_target") {
          const policy = getOnFailPolicySync(step.run_id, step.step_id);
          logger.error(`Run failed: step "${step.step_id}" returned STATUS: retry, retries exhausted, declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step.`, { runId: step.run_id, stepId: step.step_id });
        }
        // budget_exhausted / not_found falls through to normal failure below
      } catch (e) {
        logger.error("reroute failed", { runId: step.run_id, stepId: step.step_id, error: e });
        emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: String(e) });
        /* fall through to normal failure */
      }

      db.prepare(
        "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(output, newRetry, stepId);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `STATUS: retry verdict — retries exhausted (${newRetry}/${maxRetries})` });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "STATUS: retry verdict — retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    // Retries not exhausted: set step to pending, write full output as retry_feedback
    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `STATUS: retry verdict (retry ${newRetry}/${maxRetries})` });
    logger.info(`Step retrying due to STATUS: retry verdict (retry ${newRetry}/${maxRetries})`, { runId: step.run_id, stepId: step.step_id });
    finalizeDrainingPause(step.run_id);
    return { status: "retrying", detail: `STATUS: retry verdict (retry ${newRetry}/${maxRetries})` };
  }

  // Single step: mark done and advance
  db.prepare(
    "UPDATE steps SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
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

/**
 * Handle verify-each completion: pass or fail the story.
 */
function handleVerifyEachCompletion(
  verifyStep: { id: string; run_id: string; step_id: string; step_index: number },
  loopStepId: string,
  output: string,
  context: Record<string, string>
): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const status = context["status"]?.toLowerCase();

  // Reset verify step to waiting for next use, with a fresh retry budget.
  // Each story gets its own verify retry budget — retry_count is story-scoped.
  db.prepare(
    "UPDATE steps SET status = 'waiting', retry_count = 0, output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(output, verifyStep.id);

  if (status !== "retry") {
    emitEvent({ ts: new Date().toISOString(), event: "story.verified", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id });
  }

  if (status === "retry") {
    const lastDoneStory = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE run_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1"
    ).get(verifyStep.run_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);
        db.prepare("UPDATE steps SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(verifyStep.run_id);
        const wfId = getWorkflowId(verifyStep.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id });
        emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verification retries exhausted" });
        scheduleRunCronTeardown(verifyStep.run_id);
        finalizeDrainingPause(verifyStep.run_id);
        return { advanced: false, runCompleted: false };
      }

      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);

      const issues = context["issues"] ?? output;
      context["verify_feedback"] = issues;
      emitEvent({ ts: new Date().toISOString(), event: "story.retry", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id, detail: issues });
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);
    }

    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  // Verify passed — clear feedback and continue
  delete context["verify_feedback"];
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);

  try {
    return checkLoopContinuation(verifyStep.run_id, loopStepId);
  } catch (err) {
    logger.error(`checkLoopContinuation failed, recovering: ${String(err)}`, { runId: verifyStep.run_id });
    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
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
      "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  const failedStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (failedStory) {
    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run("Loop cannot continue because one or more stories failed", loopStepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
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
    "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
  ).run(loopStepId);

  // Also mark verify step done if it exists
  const loopStep = db.prepare("SELECT loop_config, run_id FROM steps WHERE id = ?").get(loopStepId) as { loop_config: string | null; run_id: string } | undefined;
  if (loopStep?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStep.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep) {
      db.prepare(
        "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE run_id = ? AND step_id = ?"
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

  const incomplete = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status IN ('failed', 'pending', 'running') LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (!next && incomplete) {
    return { advanced: false, runCompleted: false };
  }

  const wfId = getWorkflowId(runId);
  if (next) {
    db.prepare(
      "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).run(next.id);
    emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId, workflowId: wfId, stepId: next.step_id });
    emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId, workflowId: wfId, stepId: next.step_id });
    return { advanced: true, runCompleted: false };
  } else {
    db.prepare(
      "UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
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
export function archiveRunProgress(runId: string): void {
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
 * Shared core of rerouteStep and rerouteStepSync.
 * Takes a pre-resolved policy object and performs all reroute logic:
 * validation, budget check, DB updates, story reset, event emission.
 *
 * Returns "rerouted" on success, "budget_exhausted" when max_reroutes
 * is reached, "invalid_target" when the declared retry_step target
 * doesn't exist or isn't upstream, or "not_found" when the consumer
 * step isn't found in the database.
 */
function rerouteWithPolicy(
  policy: WorkflowStepFailure,
  runId: string,
  consumerStepId: string,
  consumerRowId: string,
  error: string,
): "rerouted" | "budget_exhausted" | "invalid_target" | "not_found" {
  const db = getDb();
  const targetStepId = policy.retry_step!;

  // Look up the consumer step metadata
  const consumerStep = db.prepare(
    "SELECT step_id, step_index, reroute_count FROM steps WHERE id = ?"
  ).get(consumerRowId) as
    { step_id: string; step_index: number; reroute_count: number | null } | undefined;
  if (!consumerStep) return "not_found";

  // Look up the target (producer) step in the same run (include type + loop_config for story reset)
  const targetStep = db.prepare(
    "SELECT id, step_id, step_index, type, loop_config FROM steps WHERE run_id = ? AND step_id = ?"
  ).get(runId, targetStepId) as
    { id: string; step_id: string; step_index: number; type: string; loop_config: string | null } | undefined;

  // Validate: target must exist and have a lower step_index than consumer
  if (!targetStep) return "invalid_target";
  if (targetStep.step_index >= consumerStep.step_index) return "invalid_target";

  // Check reroute budget (default 2 when not declared in YAML)
  const maxReroutes = policy.max_reroutes ?? 2;
  const currentReroutes = consumerStep.reroute_count ?? 0;
  if (currentReroutes >= maxReroutes) {
    const boundedReasonPre =
      error.length > 200 ? error.slice(0, 197) + "..." : error;
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.reroute_budget_exhausted",
      runId,
      workflowId: getWorkflowId(runId),
      stepId: consumerStepId,
      detail: `Reroute budget exhausted: ${currentReroutes}/${maxReroutes} to ${targetStepId}. Consumer failure: ${boundedReasonPre}`,
    });
    logger.warn("Reroute budget exhausted", {
      runId, fromStep: consumerStepId, toStep: targetStepId,
      rerouteCount: currentReroutes, budget: maxReroutes, reason: boundedReasonPre,
    });
    return "budget_exhausted";
  }

  const newRerouteCount = currentReroutes + 1;

  // Build bounded feedback for the producer
  const boundedReason =
    error.length > 200 ? error.slice(0, 197) + "..." : error;
  const feedback =
    `Reroute from "${consumerStep.step_id}" (reroute ${newRerouteCount}/${maxReroutes}). ` +
    `Consumer failure: ${boundedReason}`;

  // (a) Re-pend producer: status=pending, retry_count UNCHANGED.
  //     Write retry_feedback into output so claimStep surfaces it.
  //     Clear claim ownership and set invalidation marker to prevent
  //     stale completions from re-completing the producer with old output.
  //     Also NULL claim_updated_at so the no-op bounce guard (C19a) can
  //     detect that no agent claimed this step after the reroute.
  db.prepare(
    "UPDATE steps SET status = 'pending', output = ?, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, claim_updated_at = NULL, claim_invalidated_by = 'reroute', updated_at = datetime('now') WHERE id = ?"
  ).run(feedback, targetStep.id);

  // (a.2) Story reset on reroute: when the reroute target is a loop-over-stories step,
  //        reset the story/stories cited in the consumer's failure text to pending.
  resetStoriesOnReroute(db, runId, targetStep, error, getWorkflowId(runId));

  // (a.3) Write verify_feedback into run context when reroute target is a
  //        loop-over-stories step, so the developer agent sees the feedback
  //        on the next claim (unconditional — even when no stories were reset).
  writeRerouteFeedbackContext(db, runId, targetStep, error);

  // (b) Reset consumer: status=waiting, retry_count=0, increment reroute_count.
  //     Clear output and ownership so it looks like a fresh step.
  db.prepare(
    "UPDATE steps SET status = 'waiting', retry_count = 0, reroute_count = ?, output = NULL, claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(newRerouteCount, consumerRowId);

  // (c) Intermediate done steps are left untouched — advancePipeline will
  //     naturally re-pend the consumer after the producer completes.

  // Emit event
  const wfId = getWorkflowId(runId);
  emitEvent({
    ts: new Date().toISOString(),
    event: "step.rerouted",
    runId,
    workflowId: wfId,
    stepId: consumerStepId,
    detail:
      `Rerouted to ${targetStepId} (${newRerouteCount}/${maxReroutes}). ` +
      `Consumer failure: ${boundedReason}`,
  });

  logger.info(
    `Step rerouted: ${consumerStepId} → ${targetStepId} (${newRerouteCount}/${maxReroutes})`,
    {
      runId,
      fromStep: consumerStepId,
      toStep: targetStepId,
      rerouteCount: newRerouteCount,
      budget: maxReroutes,
      reason: boundedReason,
    },
  );

  return "rerouted";
}

/**
 * Fail a step, with retry logic. For loop steps, applies per-story retry.
 */
export async function failStep(stepId: string, error: string): Promise<{ status: string }> {
  const result = await failStepInternal(stepId, error);
  // A retry re-pends the step (or its story) — nudge the daemon so the
  // dispatch motor retries immediately instead of on the fallback sweep.
  if (result.status === "retrying") {
    nudgeDispatch();
  }
  return result;
}

async function failStepInternal(stepId: string, error: string): Promise<{ status: string }> {
  const db = getDb();

  const step = db.prepare(
    "SELECT run_id, step_id, retry_count, max_retries, type, current_story_id FROM steps WHERE id = ?"
  ).get(stepId) as {
    run_id: string;
    step_id: string;
    retry_count: number;
    max_retries: number;
    type: string;
    current_story_id: string | null;
  } | undefined;

  if (!step) {
    // Try to recover agent_id and run_id for the error hint
    const stepInfo = db.prepare("SELECT agent_id, run_id FROM steps WHERE id = ?").get(stepId) as { agent_id: string; run_id: string } | undefined;
    const hint = stepInfo
      ? `\nIf you lost your step id, run: tamandua step current ${stepInfo.agent_id} --run-id ${stepInfo.run_id}`
      : `\nIf you lost your step id, run: tamandua step current <agent-id> --run-id <run-id>`;
    logger.warn(`Rejected step fail: Step not found: ${stepId}`, { stepId });
    throw new Error(`Step not found: ${stepId}${hint}`);
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
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
        db.prepare("UPDATE steps SET status = 'failed', output = ?, current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(error, stepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId, storyId: storyRow?.story_id, storyTitle: storyRow?.title, detail: error });
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId, detail: error });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story retries exhausted" });
        scheduleRunCronTeardown(step.run_id);
        finalizeDrainingPause(step.run_id);

        return { status: "failed" };
      }

      // Retry the story
      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
      db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(stepId);
      finalizeDrainingPause(step.run_id);
      return { status: "retrying" };
    }
  }

  // Single step: existing logic
  const newRetryCount = step.retry_count + 1;

  if (newRetryCount > step.max_retries) {
    // ── RETR: check on_fail.retry_step before failing the run ──
    // Rerouting to an upstream producer allows the run to recover when
    // a consumer's failure root cause lives in producer output.
    // Falls through to normal run failure on budget exhaustion,
    // invalid target, or when no retry_step is declared.
    try {
      const rerouteResult = await rerouteStep(step.run_id, step.step_id, stepId, error);
      if (rerouteResult === "rerouted") {
        nudgeDispatch();
        finalizeDrainingPause(step.run_id);
        return { status: "rerouted" };
      }
      if (rerouteResult === "invalid_target") {
        // Spec error: retry_step targets a downstream or unknown step.
        // Fail the run with a clear message so the bug is visible.
        const policy = await getOnFailPolicy(step.run_id, step.step_id);
        error = `Run failed: step "${step.step_id}" declares on_fail.retry_step "${policy?.retry_step ?? "?"}" which is not a valid upstream step (must have lower step_index).`;
        logger.error(error, { runId: step.run_id, stepId: step.step_id });
      }
      // budget_exhausted falls through to normal failure below
    } catch (e) {
      logger.error("reroute failed", { runId: step.run_id, stepId, error: e });
      const wfIdCatch = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.reroute_error", runId: step.run_id, workflowId: wfIdCatch, stepId, detail: String(e) });
      // Best-effort: fall through to normal failure
    }

    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(error, newRetryCount, stepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).run(step.run_id);
    const wfId2 = getWorkflowId(step.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId2, stepId, detail: error });
    emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId2, detail: "Step retries exhausted" });
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
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
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
  // (rerouteStep / rerouteStepSync) after this function returns, so it
  // can happen unconditionally for loop-targeted reroutes.
}

/**
 * Async wrapper around rerouteWithPolicy. Resolves the on_fail policy
 * asynchronously via getOnFailPolicy, then delegates to the shared core.
 *
 * Returns:
 * - "rerouted" on success
 * - "budget_exhausted" when reroute_count >= max_reroutes (caller falls through to fail)
 * - "invalid_target" when retry_step names a downstream/unknown step
 * - "not_found" when no on_fail.retry_step is declared
 */
async function rerouteStep(
  runId: string,
  consumerStepId: string,
  consumerRowId: string,
  error: string,
): Promise<"rerouted" | "budget_exhausted" | "invalid_target" | "not_found"> {
  const policy = await getOnFailPolicy(runId, consumerStepId);
  if (!policy?.retry_step) return "not_found";
  return rerouteWithPolicy(policy, runId, consumerStepId, consumerRowId, error);
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
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(context),
    runId,
  );
}

/**
 * Sync wrapper around rerouteWithPolicy. Resolves the on_fail policy
 * synchronously via getOnFailPolicySync, then delegates to the shared core.
 */
function rerouteStepSync(
  runId: string,
  consumerStepId: string,
  consumerRowId: string,
  error: string,
): "rerouted" | "budget_exhausted" | "invalid_target" | "not_found" {
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
  story?: Story
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
    context["progress"] = `stored in the file ${getRunProgressPath(runId)} — read only what you need (grep for story ids; the Codebase Patterns section is at the top)`;
    context["progress_file"] = getRunProgressPath(runId);

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
         updated_at = datetime('now')
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
