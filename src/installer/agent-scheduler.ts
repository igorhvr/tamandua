import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { resolveTamanduaCli, resolveWorkflowDir, resolveWorkflowWorkspaceDir } from "./paths.js";
import type { WorkflowSpec, WorkflowAgent, HarnessType } from "./types.js";
import { logger } from "../lib/logger.js";
import { getRoleTimeoutSeconds, inferRole } from "./install.js";
import { formatPiCommandPreview } from "./pi-command-preview.js";
import { emitEvent } from "./events.js";
import { parseRunContext } from "./step-ops.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";
import { getHarnessAdapter, type HarnessRoundResult } from "./harness-adapter.js";
import { lookupHermesSessionTokens } from "./hermes-usage.js";

// ──────────────────────────────────────────────────────────────────────
// Run-Scoped Deterministic Dispatch
//
// Job identity:  tamandua-${workflowId}-${runId}-${agentId}
// Scope:         every job is tied to ONE (runId, agentId) tuple
// Ownership:    timers + in-flight pi children are owned by whatever
//               process invokes the scheduler (daemon in production;
//               occasionally direct callers in tests).
// State:        no on-disk persistence (cron-jobs.json removed). The DB
//               is the source of truth; the daemon's reconciler restores
//               in-memory job maps from runs.scheduling_status.
//
// Dispatch model: the scheduler decides "is there work?" itself with a
// direct DB peek (peekStep) and spawns a harness (pi/hermes) ONLY when a
// pending step exists. Checking for work never invokes a model, so idle
// dispatch rounds cost zero tokens. The interval tick is a fallback sweep
// (it also drives stale-claim recovery); step completions nudge the daemon
// for immediate dispatch of downstream steps.
// ──────────────────────────────────────────────────────────────────────

/**
 * Fallback dispatch sweep interval. Dispatch rounds are deterministic DB
 * peeks — no process spawn, no model, no tokens — so this can be seconds
 * where the model-driven poller needed minutes. Completion-triggered nudges
 * make step-to-step latency near zero; this tick is only the safety net
 * (missed nudge, daemon restart, stale-claim recovery).
 */
export const DISPATCH_INTERVAL_MS = 15_000;

/** Maps job id → active setInterval handle. */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Maps job id → delayed first-start timeout handle. */
const pendingStartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Maps job id → persistent metadata. */
const jobMetadata = new Map<string, CronJobInfo>();

/**
 * Set of job ids whose dispatch round is currently running. Used to skip a
 * tick when the previous round for the same (run, agent) hasn't finished —
 * without this guard, setInterval would keep spawning new harness processes
 * every interval even though work rounds can take 10–30 minutes.
 */
const inFlightJobs = new Set<string>();

// ── Nudge types ─────────────────────────────────────────────────────

export interface NudgeJobDetail {
  runId: string;
  agentId: string;
  status: "launched" | "skipped_in_flight" | "error";
  error?: string;
}

export interface NudgeResult {
  runIds: string[];
  launched: number;
  skippedInFlight: number;
  errors: Array<{ runId?: string; agentId?: string; error: string }>;
  jobs: NudgeJobDetail[];
}

/**
 * Atomically check and mark a job as in-flight.
 *
 * Returns `true` if the job was not already in flight (caller should
 * proceed) and `false` if it was (caller should skip).  The check-and-add
 * is synchronous to close the TOCTOU window between the guard and the
 * first `await` inside `executeDispatchRound`.
 */
export function tryMarkJobInFlight(jobId: string): boolean {
  if (inFlightJobs.has(jobId)) return false;
  inFlightJobs.add(jobId);
  return true;
}

/**
 * Maps job id → in-flight child handle, exposing pid + pgid. Used by
 * `removeRunCrons` and daemon shutdown to terminate process groups.
 */
interface InFlightChild {
  pid: number;
  pgid: number;
  killed: boolean;
}
const inFlightChildren = new Map<string, InFlightChild>();

/**
 * Pending post-grace process-cleanup sweep timers keyed by runId.
 * At most one timer per run: `removeRunCrons` schedules a one-shot
 * unref-ed timer at HARNESS_TEARDOWN_GRACE_MS + 2s after the last
 * crons-teardown call for the run. When the timer fires it sweep-kills
 * surviving leaked processes tied to the run's worktree. The timer is
 * unref-ed so a process with an empty event loop exits without waiting.
 *
 * Cleared on fire and in `shutdownAllCrons` for test isolation.
 *
 * @internal — exposed for test introspection via `_pendingSweepTimerCount`.
 */
const pendingSweepTimers = new Map<string, NodeJS.Timeout>();

const AGENT_PERSONA_FILES = ["AGENTS.md", "IDENTITY.md", "SOUL.md"] as const;

export interface CronJobInfo {
  /** tamandua-${workflowId}-${runId}-${agentId} */
  id: string;
  workflowId: string;
  runId: string;
  agentId: string;
  model?: string;
  workModel?: string;
  sessionLabel?: string;
  timeoutSeconds?: number;
  /** Working directory used as cwd for `pi --print` invocations. */
  workingDirectoryForHarness?: string;
  /** Harness binary to use for agent invocations ("pi" or "hermes"). */
  harnessType?: HarnessType;
  createdAt: string;
}

export interface CreateCronJobParams {
  workflowId: string;
  runId: string;
  agent: WorkflowAgent;
  workflow?: WorkflowSpec;
  staggerOffsetMs?: number;
  workingDirectoryForHarness?: string;
}

export interface SetupAgentCronsOptions {
  workingDirectoryForHarness?: string;
  /**
   * Accepted for signature back-compat (`--no-hurry-please-save-tokens-mode`).
   * The flag does not affect scheduling — dispatch rounds are free either
   * way. Its effect lives in the work spawn: no-hurry runs prefer a
   * `<harness>-token-saver` wrapper when one is installed on PATH (e.g.,
   * `pi-token-saver` or `hermes-token-saver`, matched to whichever harness
   * the run uses; the dispatch round reads the flag from run context, not
   * from this option).
   */
  noHurrySaveTokensMode?: boolean;
}

// ── pi binary discovery ────────────────────────────────────────────

export interface FindPiBinaryOptions {
  /**
   * When true (runs launched with --no-hurry-please-save-tokens-mode),
   * prefer a `<harness>-token-saver` command from PATH over the plain
   * harness binary (e.g., `pi-token-saver` over `pi`, or `hermes-token-saver`
   * over `hermes`). Resolution happens per invocation, so installing the
   * wrapper mid-run takes effect on the next work round; when it is absent,
   * the plain harness binary is used as usual. The per-harness env override
   * (TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY) still wins over both —
   * that is the explicit config/test seam.
   */
  preferTokenSaver?: boolean;
}

/**
 * Thin wrapper around {@link PiHarnessAdapter.findBinary} so existing
 * imports from this module stay unbroken.
 */
export async function findPiBinary(options: FindPiBinaryOptions = {}): Promise<string> {
  const adapter = getHarnessAdapter("pi");
  return adapter.findBinary({ preferTokenSaver: options.preferTokenSaver });
}

// ── hermes binary discovery ───────────────────────────────────────

import { resolveHermesBinary, resolveHermesViaLoginShell } from "./hermes-resolver.js";

// Re-export resolveHermesViaLoginShell from the shared resolver module.
// Doctor, run-harness, and harness-adapter all import from hermes-resolver.js
// directly; kept here for any external consumers that resolve via agent-scheduler.
export { resolveHermesViaLoginShell };

/**
 * Thin async wrapper around {@link resolveHermesBinary} from the shared
 * Hermes resolver module. Discovery is entirely side-effect-free — no
 * filesystem mutation (no symlink creation, no file deletion, no chmod).
 *
 * Resolution precedence:
 *   1. TAMANDUA_HERMES_BINARY env var (must be X_OK)
 *   2. Process PATH lookup
 *   3. Login-shell fallback (zsh -lic 'command -v hermes')
 */
export async function findHermesBinary(): Promise<string> {
  return resolveHermesBinary();
}

// ── Low-level pi execution ─────────────────────────────────────────

export interface RunPiOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
  /**
   * Optional callback invoked once the child process is spawned. Used by
   * `executeDispatchRound` to register the child + pgid in `inFlightChildren`
   * so termination paths can kill the process group.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  /** See FindPiBinaryOptions.preferTokenSaver (no-hurry runs prefer a token-saver wrapper from PATH). */
  preferTokenSaver?: boolean;
}

const MAX_LOG_STREAM_PREVIEW = 200;

interface StreamLogMetadata {
  bytes: number;
  preview: string;
  truncated: boolean;
}

function buildStreamLogMetadata(stream: string): StreamLogMetadata {
  const normalized = stream.trim();
  const truncated = normalized.length > MAX_LOG_STREAM_PREVIEW;
  const preview = truncated ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…` : normalized;

  return {
    bytes: Buffer.byteLength(stream, "utf-8"),
    preview,
    truncated,
  };
}

function safeKillPgid(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative PID => kill the entire process group.
    process.kill(-pgid, signal);
  } catch {
    // Group may already be gone.
  }
}

/**
 * Thin wrapper around {@link PiHarnessAdapter.runRound} so existing
 * imports from this module stay unbroken.  The prompt is always the last
 * argument in `--print` mode invocations.
 */
export async function runPi(
  args: string[],
  options: RunPiOptions = {},
): Promise<string> {
  const prompt = args.length > 0 ? args[args.length - 1] : "";
  const adapter = getHarnessAdapter("pi");
  const result = await adapter.runRound(prompt, options);
  return result.output;
}

// ── Hermes execution ──────────────────────────────────────────────

/**
 * Thin wrapper around {@link HermesHarnessAdapter.runRound} so existing
 * imports from this module stay unbroken.
 */
export async function runHermes(
  prompt: string,
  options: RunPiOptions = {},
): Promise<string> {
  const adapter = getHarnessAdapter("hermes");
  const result = await adapter.runRound(prompt, options);
  return result.output;
}

// ── Prompt builders ─────────────────────────────────────────────────

async function readOptionalPersonaFile(
  workspaceDir: string,
  fileName: typeof AGENT_PERSONA_FILES[number],
): Promise<string | null> {
  const filePath = path.join(workspaceDir, fileName);
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    return content.trimEnd();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function buildAgentPersonaInstructions(agentId: string): Promise<string> {
  const workspaceDir = resolveWorkflowWorkspaceDir(agentId);
  const sections: string[] = [];

  for (const fileName of AGENT_PERSONA_FILES) {
    const content = await readOptionalPersonaFile(workspaceDir, fileName);
    if (!content) continue;
    sections.push(`### ${fileName}\n\n${content}`);
  }

  if (sections.length === 0) return "";

  return [
    "The following files are the provisioned Tamandua persona instructions for this workflow agent.",
    "Follow them when executing claimed work. Repository-level instructions from the harness working directory still apply for repository-specific conventions.",
    "",
    ...sections,
  ].join("\n\n");
}

/**
 * Build the work prompt — a claim-and-execute script run by `pi --print`.
 *
 * The scheduler already verified (via a deterministic `peekStep`) that a
 * pending step exists before spawning this prompt, so there is no peek
 * phase: the agent claims, executes, and reports. Claim + report are scoped
 * to a specific runId so concurrent runs of the same workflow can't
 * cross-claim each other's steps.
 */
export function buildWorkPrompt(
  workflowId: string,
  agentId: string,
  runId: string,
  agentPersonaInstructions = "",
  jobId?: string,
  runNumber?: number,
): string {
  const cli = resolveTamanduaCli();

  const persona = agentPersonaInstructions.trim();
  const prompt: string[] = [];

  // Traceability header: inert bracketed metadata prepended to every dispatched
  // work prompt so persisted sessions are greppable to their exact step via the DB.
  if (jobId && runNumber !== undefined) {
    prompt.push(
      `[tamandua traceability - metadata only, no action needed] run=run-${runId} run_number=${runNumber} agent=${agentId} job=${jobId} ts=${new Date().toISOString()}`,
      "",
    );
  }

  prompt.push(
    `You are the work agent for workflow "${workflowId}", agent "${agentId}", run "run-${runId}".`,
    `You run in --print mode. A pending step is waiting for you: claim it, execute it, report.`,
  );

  if (persona.length > 0) {
    prompt.push(
      ``,
      `─── PROVISIONED AGENT PERSONA ───`,
      persona,
      `─── END PROVISIONED AGENT PERSONA ───`,
    );
  }

  prompt.push(
    ``,
    `─── CLAIM ───`,
    `1. Claim the step and capture the JSON response:`,
    `   "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `   The output is JSON: {"stepId":"step-<UUID>", "runId":"run-<UUID>", "input":"<task description>"}`,
    `   SAVE the stepId — you MUST use it when reporting results.`,
    ``,
    `   If the claim output contains NO_WORK, another worker already took the step.`,
    `   Reply exactly: NO_WORK_AVAILABLE`,
    `   Then STOP. Do nothing else.`,
    ``,
    `─── EXECUTE ───`,
    `2. Read the "input" field carefully. It describes the actual work you must do.`,
    ``,
    `3. Execute the work using all available tools and capabilities.`,
    ``,
    `─── REPORT ───`,
    `4. When finished, report using the SAVED stepId (NOT the agent ID):`,
    `   - Preferred: create a unique temporary report outside the repository/worktree, then submit its quoted path:`,
    `     report_file="$(mktemp "\${TMPDIR:-/tmp}/tamandua-report.XXXXXX")"`,
    `     "${cli}" step complete "step-<uuid>" --file "$report_file"`,
    `     The report must follow EXACTLY the reply format from the task's "Reply with:" section.`,
    `     It always begins with "STATUS: done" and lists the KEY: lines this step must produce —`,
    `     downstream steps consume those keys, and omitting one forces a retry.`,
    `   - Only if the task has NO "Reply with:" section, write: STATUS: done`,
    `     CHANGES: <what you did>`,
    `     TESTS: <tests you ran>`,
    `     then invoke: "${cli}" step complete "step-<uuid>" --file "$report_file"`,
    `   - Alternative (stdin pipe): echo '<your report>' | "${cli}" step complete "step-<uuid>"`,
    `   - If step complete responds with 'REJECTED', you still hold the step —`,
    `     retain the same "$report_file", fix the output format, and resubmit it in the same round.`,
    `     Run rm -f -- "$report_file" only after the completion is accepted.`,
    `   - Failure: "${cli}" step fail "step-<uuid>" "clear reason for failure"`,
    `     Or create an external reason file: reason_file="$(mktemp "\${TMPDIR:-/tmp}/tamandua-reason.XXXXXX")"`,
    `     Then run: "${cli}" step fail "step-<uuid>" --reason-file "$reason_file"`,
    `     After step fail succeeds, run rm -f -- "$reason_file".`,
    ``,
    `─── RULES ───`,
    `- ALWAYS report results. Never exit without calling step complete or step fail.`,
    `- Use --file (preferred) for step complete reports to avoid shell quoting issues.`,
    `- Never create report, reason, or story transport files in the repository/worktree.`,
    `- Use a securely-created unique path below \${TMPDIR:-/tmp}; always quote it and clean it only after success.`,
    `- If you see 'REJECTED' from step complete, you still hold the step — fix the format and resubmit.`,
    `- If you cannot complete the work, use step fail — do not hang.`,
    `- Keep responses concise; you are a background agent.`,
    `- If something is unclear, use step fail with an explanation of what is missing.`,
  );

  return prompt.join("\n");
}

// ── Work-round output parsing ───────────────────────────────────────

const MAX_WORK_OUTPUT_PREVIEW = 240;
const MAX_WORK_ERROR_PREVIEW = 240;

interface BoundedPreviewMetadata {
  preview: string;
  bytes: number;
  truncated: boolean;
}

function buildBoundedPreview(value: string, maxChars: number): BoundedPreviewMetadata {
  const truncated = value.length > maxChars;
  const preview = truncated ? `${value.slice(0, maxChars)}…` : value;

  return {
    preview,
    bytes: Buffer.byteLength(value, "utf-8"),
    truncated,
  };
}

// ── Work-round (dispatch) output classification ─────────────────────

export type WorkRoundOutcome =
  | "no_work"
  | "work_done"
  | "work_failed"
  | "empty_output"
  | "other_output";

interface WorkRoundOutputSummary extends BoundedPreviewMetadata {
  outcome: WorkRoundOutcome;
  lines: number;
}

/**
 * Classify the assistant output of a work round. The scheduler only spawns
 * a harness when a pending step exists, so `no_work` (the claim raced
 * another round) is rare; STATUS markers drive the completion/recovery
 * paths exactly as before.
 *
 * @internal exported for regression tests
 */
export function classifyWorkRoundOutcome(output: string): WorkRoundOutcome {
  if (output.length === 0) return "empty_output";
  if (/\bNO_WORK_AVAILABLE\b/.test(output)) return "no_work";
  if (/STATUS:\s*(fail|failed|error)/i.test(output)) return "work_failed";
  if (/STATUS:\s*done/i.test(output)) return "work_done";
  return "other_output";
}

function summarizeWorkRoundOutput(output: string): WorkRoundOutputSummary {
  const normalized = output.trim();
  const bounded = buildBoundedPreview(normalized, MAX_WORK_OUTPUT_PREVIEW);

  return {
    ...bounded,
    outcome: classifyWorkRoundOutcome(normalized),
    lines: normalized ? normalized.split(/\r?\n/).length : 0,
  };
}

const UUID_CAPTURE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const RUN_ID_FIELD_REGEX = new RegExp(`["']?run(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");
const STEP_ID_FIELD_REGEX = new RegExp(`["']?step(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");

export interface WorkRoundMetadata {
  assistantOutput: string;
  tokenUsage: number | null;
  runId: string | null;
  stepId: string | null;
  jsonMetadataDetected: boolean;
}

interface WorkRoundIdentifierHints {
  runId: string | null;
  stepId: string | null;
}

type RunIdSource = "metadata_run_id" | "step_lookup" | "none";

interface ResolvedRunId {
  runId: string | null;
  source: RunIdSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTokenUsage(value: number): number {
  return Math.max(0, Math.round(value));
}

function firstNumeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseNumeric(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractTokenUsage(usageLike: unknown): number | null {
  const usage = asRecord(usageLike);
  if (!usage) return null;

  const directTotal = firstNumeric(usage, ["totalTokens", "total_tokens", "total"]);
  if (directTotal !== null) return normalizeTokenUsage(directTotal);

  const parts: Array<number | null> = [
    firstNumeric(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
    firstNumeric(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
    firstNumeric(usage, ["cacheRead", "cache_read", "cache_read_tokens"]),
    firstNumeric(usage, ["cacheWrite", "cache_write", "cache_write_tokens"]),
  ];

  if (!parts.some((value) => value !== null)) return null;

  const total = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return normalizeTokenUsage(total);
}

function collectTextFragments(value: unknown, sink: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.trim().length > 0) sink.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, sink, depth + 1);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const nested of Object.values(record)) {
    collectTextFragments(nested, sink, depth + 1);
  }
}

function extractAssistantText(messageLike: unknown): string {
  const message = asRecord(messageLike);
  if (!message) return "";

  const content = message.content;
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const textSegments: string[] = [];
  for (const item of content) {
    const contentRecord = asRecord(item);
    if (!contentRecord) continue;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      textSegments.push(contentRecord.text);
    }
  }

  return textSegments.join("\n");
}

function extractIdentifierHints(text: string): WorkRoundIdentifierHints {
  const runMatch = text.match(RUN_ID_FIELD_REGEX);
  const stepMatch = text.match(STEP_ID_FIELD_REGEX);

  return {
    runId: runMatch?.[1] ?? null,
    stepId: stepMatch?.[1] ?? null,
  };
}

export function parseWorkRoundMetadata(output: string): WorkRoundMetadata {
  const normalized = output.trim();
  if (normalized.length === 0) {
    return {
      assistantOutput: "",
      tokenUsage: null,
      runId: null,
      stepId: null,
      jsonMetadataDetected: false,
    };
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (record) events.push(record);
    } catch {
      // best-effort parsing; ignore malformed/non-JSON lines
    }
  }

  if (events.length === 0) {
    const hints = extractIdentifierHints(normalized);
    return {
      assistantOutput: normalized,
      tokenUsage: null,
      runId: hints.runId,
      stepId: hints.stepId,
      jsonMetadataDetected: false,
    };
  }

  let assistantOutput = "";
  let tokenUsage: number | null = null;
  const toolTextFragments: string[] = [];

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role === "assistant") {
        const assistantText = extractAssistantText(message).trim();
        if (assistantText.length > 0) assistantOutput = assistantText;

        const extractedUsage = extractTokenUsage(message.usage);
        if (extractedUsage !== null) tokenUsage = extractedUsage;
      }
    }

    if (type.startsWith("tool_execution")) {
      collectTextFragments(event, toolTextFragments);
    }
  }

  if (!assistantOutput) {
    assistantOutput = normalized;
  }

  const hintsFromToolData = extractIdentifierHints(toolTextFragments.join("\n"));
  const fallbackHints = extractIdentifierHints(`${assistantOutput}\n${normalized}`);

  return {
    assistantOutput,
    tokenUsage,
    runId: hintsFromToolData.runId ?? fallbackHints.runId,
    stepId: hintsFromToolData.stepId ?? fallbackHints.stepId,
    jsonMetadataDetected: true,
  };
}

async function resolveRunIdForAttribution(metadata: WorkRoundMetadata): Promise<ResolvedRunId> {
  if (metadata.runId) {
    return { runId: metadata.runId, source: "metadata_run_id" };
  }

  if (!metadata.stepId) {
    return { runId: null, source: "none" };
  }

  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db.prepare("SELECT run_id FROM steps WHERE id = ?").get(metadata.stepId) as { run_id: string } | undefined;
    if (!row?.run_id) return { runId: null, source: "none" };
    return { runId: row.run_id, source: "step_lookup" };
  } catch {
    return { runId: null, source: "none" };
  }
}

interface TokenSpendUpdate {
  workflowId?: string;
  tokensSpent: number;
}

async function incrementRunTokenSpend(runId: string, tokenUsage: number): Promise<TokenSpendUpdate | null> {
  const { getDb } = await import("../db.js");
  const db = getDb();
  const result = db
    .prepare("UPDATE runs SET tokens_spent = tokens_spent + ?, updated_at = datetime('now') WHERE id = ?")
    .run(tokenUsage, runId);

  if ((result.changes ?? 0) <= 0) return null;

  const row = db
    .prepare("SELECT workflow_id, tokens_spent FROM runs WHERE id = ?")
    .get(runId) as { workflow_id: string; tokens_spent: number } | undefined;

  if (!row) return null;

  return {
    workflowId: row.workflow_id,
    tokensSpent: row.tokens_spent,
  };
}

/**
 * Auto-complete fallback. See original implementation comments.
 *
 * In the run-scoped world we still pass the run id through so orphan
 * recovery is run-scoped on failures.
 */
export async function autoCompleteStepIfRunning(
  context: Record<string, unknown>,
  metadata: WorkRoundMetadata,
): Promise<void> {
  const jobId = typeof context.jobId === "string" ? context.jobId : null;
  if (!jobId) {
    logger.warn("Auto-complete fallback skipped — no jobId in context", { ...context });
    return;
  }

  const { getDb } = await import("../db.js");
  const { completeStep } = await import("./step-ops.js");
  const db = getDb();

  const row = db
    .prepare("SELECT id, status, type, current_story_id, run_id FROM steps WHERE claim_job_id = ? AND status IN ('claimed', 'running')")
    .get(jobId) as { id: string; status: string; type: string; current_story_id: string | null; run_id: string } | undefined;

  if (!row) {
    logger.debug("Auto-complete fallback skipped — no step claimed by this job", {
      ...context,
      jobId,
    });
    return;
  }

  const stepId = row.id;

  logger.info("Auto-complete via claim_job_id for step", {
    ...context,
    stepId,
    stepStatus: row.status,
    stepType: row.type,
  });

  if (row.type === "loop" && row.current_story_id === null) {
    logger.debug("Auto-complete fallback skipped — loop step mid-iteration (agent already advanced via CLI)", {
      ...context,
      stepId,
      stepStatus: row.status,
    });
    return;
  }

  if (row.status !== "running" && row.status !== "claimed") {
    logger.debug("Auto-complete fallback skipped — step not running or claimed (agent likely reported via CLI)", {
      ...context,
      stepId,
      stepStatus: row.status,
    });
    return;
  }

  const recoveryRunId =
    typeof context.runId === "string" && context.runId
      ? (context.runId as string)
      : row.run_id;

  try {
    const result = completeStep(stepId, metadata.assistantOutput);
    logger.info("Auto-complete via claim_job_id completed step", {
      ...context,
      stepId,
      result: result.status,
      outputBytes: Buffer.byteLength(metadata.assistantOutput, "utf-8"),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Auto-complete via claim_job_id completeStep threw", {
      ...context,
      stepId,
      error: errorMessage,
    });

    const failureReason =
      `Previous attempt produced output that could not be auto-completed: ${errorMessage}. ` +
      `If this involved STORIES_JSON, ensure the STORIES_JSON line ends with a literal "]" and ` +
      `is followed by no trailing prose, comments, or markdown — only blank lines or another KEY: line.`;
    try {
      const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
      const workerJobId = typeof context.jobId === "string" ? context.jobId : undefined;
      const recoveryResult = recoverOrphanedStepsForAgent(
        context.agentId as string,
        recoveryRunId,
        undefined,
        undefined,
        failureReason,
        workerJobId,
        "worker_lost",
        undefined, // detailPrefix
        undefined, // exitCode
        undefined, // signal
        undefined, // stderrTail
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after auto-complete throw", {
          ...context,
          stepId,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          autoCompleteError: errorMessage,
        });
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery after auto-complete throw failed", {
        ...context,
        stepId,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  }
}

// ── Deterministic dispatch round ────────────────────────────────────

export function buildDispatchRoundContext(
  job: CronJobInfo,
  agent: WorkflowAgent,
  timeoutSeconds: number,
  workingDirectoryForHarness: string | undefined,
): Record<string, unknown> {
  return {
    jobId: job.id,
    runId: job.runId,
    workflowId: job.workflowId,
    agentId: job.agentId,
    role: agent.role ?? inferRole(agent.id),
    timeoutSeconds,
    workdir: workingDirectoryForHarness,
    workingDirectoryForHarness,
    model: agent.model ?? job.workModel ?? job.model,
    harnessType: job.harnessType ?? "pi",
  };
}

/**
 * Attribute a work round's token usage to its run.
 *
 * The dispatch round always knows which run it spawned work for, so even
 * when the pi stream carries no resolvable run/step ids the usage falls
 * back to `job.runId` instead of being dumped on a system counter. Nothing
 * in the dispatch path ever touches `system_tokens_spent` — that counter
 * only measured model-driven polling overhead, which no longer exists.
 */
async function attributeWorkRoundTokenUsage(
  context: Record<string, unknown>,
  job: CronJobInfo,
  outputSummary: WorkRoundOutputSummary,
  metadata: WorkRoundMetadata,
): Promise<void> {
  if (metadata.tokenUsage === null) {
    if (metadata.jsonMetadataDetected) {
      logger.debug("Work round token usage unavailable — usage metadata missing", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "usage_metadata_missing",
      });
    } else {
      logger.warn("Work round token usage unavailable — --mode json may be off", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "non_json_output",
      });
    }
    return;
  }

  if (metadata.tokenUsage <= 0) {
    logger.debug("Work round token usage not attributed", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "non_positive_usage",
      tokenUsage: metadata.tokenUsage,
    });
    return;
  }

  const resolved = await resolveRunIdForAttribution(metadata);
  const runId = resolved.runId ?? job.runId;
  const runIdSource = resolved.runId ? resolved.source : "dispatch_job";

  try {
    const updated = await incrementRunTokenSpend(runId, metadata.tokenUsage);

    if (!updated) {
      logger.warn("Work round token usage not attributed — run missing", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        runId,
        runIdSource,
      });
      return;
    }

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId,
      workflowId: updated.workflowId,
      tokenDelta: metadata.tokenUsage,
      tokensSpent: updated.tokensSpent,
    });

    logger.debug("Work round token usage attributed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      runId,
      runIdSource,
      tokensSpent: updated.tokensSpent,
    });
  } catch (err) {
    logger.warn("Work round token attribution failed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      error: String(err),
    });
  }
}

/**
 * One dispatch round for a (runId, agentId) job:
 *
 *   1. in-flight guard (one round per job at a time)
 *   2. run-status check (terminal → graceful teardown; paused/draining → skip)
 *   3. stale-claim sweep (recover steps whose worker silently died)
 *   4. deterministic peek — `peekStep` IN-PROCESS. No spawn, no model, no
 *      tokens when idle. This is the entire point of the dispatch motor.
 *   5. work spawn — only on HAS_WORK: pi/hermes runs the work prompt
 *      (claim → execute → report)
 *   6. post-round processing — token attribution to the run, STATUS
 *      classification, auto-complete fallback, orphaned-step recovery
 */
export async function executeDispatchRound(
  job: CronJobInfo,
  agent: WorkflowAgent,
  _workflow?: WorkflowSpec,
): Promise<void> {
  const role = agent.role ?? inferRole(agent.id);
  const timeout = agent.timeoutSeconds ?? job.timeoutSeconds ?? getRoleTimeoutSeconds(role);
  const legacyJobWorkdir = (job as CronJobInfo & { workdir?: string }).workdir;
  const workingDirectoryForHarness = job.workingDirectoryForHarness ?? legacyJobWorkdir;
  const context = buildDispatchRoundContext(job, agent, timeout, workingDirectoryForHarness);

  if (!workingDirectoryForHarness) {
    logger.error("Dispatch round refused — missing harness workdir", {
      ...context,
      reason: "missing_working_directory_for_harness",
    });
    await removeRunCrons(job.runId);
    return;
  }

  // ── Race-safe in-flight guard ───────────────────────────────────
  // Must happen synchronously *before* any awaited async work so
  // concurrent nudge + timer tick invocations cannot launch duplicate
  // harness processes.
  if (!tryMarkJobInFlight(job.id)) {
    logger.debug("Dispatch round skipped — previous round still in flight", {
      ...context,
      reason: "previous_round_in_flight",
    });
    return;
  }

  // No-hurry runs prefer a <harness>-token-saver wrapper when installed on PATH;
  // resolved from run context alongside the status check below.
  let preferTokenSaver = false;

  // Determine harness type outside the try block so catch handlers can
  // access it for error-path token attribution.
  const harnessType = job.harnessType ?? "pi";

  // Declared outside try so catch/post-round handlers can access exit diagnostics
  let result: HarnessRoundResult | undefined;
  // Captured from the run-status DB query so the traceability header can
  // include run_number without a second DB trip.
  let runNumber: number | undefined;

  try {
    // ── Run-scoped status check ────────────────────────────────────
    // If this run is no longer 'running' (terminal/paused) tear down the
    // job and skip. Without this check, timers leaked from previous CLI
    // processes would keep dispatching for completed runs.
    try {
      const { getDb } = await import("../db.js");
      const db = getDb();
      const row = db
        .prepare("SELECT status, scheduling_status, context, run_number FROM runs WHERE id = ?")
        .get(job.runId) as { status: string; scheduling_status: string | null; context: string; run_number: number | null } | undefined;
      if (row?.run_number !== null && row?.run_number !== undefined) {
        runNumber = row.run_number;
      }
      if (row?.context) {
        const runContext = parseRunContext(job.runId, row.context);
        preferTokenSaver = runContext.no_hurry_save_tokens_mode === "true";
      }
      if (!row || (row.status !== "running" && row.status !== "paused")) {
        logger.info("Dispatch round skipped — run no longer running; tearing down job", {
          ...context,
          runStatus: row?.status ?? "missing",
          reason: "run_not_running",
        });
        await removeRunCrons(job.runId, {
          graceMs: getRunTeardownGraceMs(row?.status),
        });
        return;
      }
      if (row.status === "paused") {
        logger.debug("Dispatch round skipped — run paused", { ...context });
        return;
      }
      if (row.scheduling_status === "draining_pause") {
        logger.debug("Dispatch round skipped — run draining before pause (in-flight work can complete)", { ...context });
        return;
      }
    } catch (err) {
      logger.warn("Run status check failed; continuing dispatch round", {
        ...context,
        error: String(err),
      });
    }

    // ── PGID liveness watchdog (global sweep) ───────────────────
    // Runs BEFORE the stale-claim sweeper so liveness detection fires first.
    // A worker that dies without the round tracker noticing (kill -9, daemon
    // restart orphan, machine sleep) leaves its claim held until the slow
    // timeout×1.5 sweeper; this check recovers it within one tick (~15s).
    try {
      const { checkRunningWorkersLiveness } = await import("./step-ops.js");
      const livenessResult = checkRunningWorkersLiveness(inFlightChildren);
      if (livenessResult.recovered > 0 || livenessResult.failed > 0 || livenessResult.skipped > 0) {
        logger.info("PGID liveness watchdog sweep completed", {
          ...context,
          recovered: livenessResult.recovered,
          failed: livenessResult.failed,
          skipped: livenessResult.skipped,
        });
      }
      // Nudge affected runs so recovered steps are dispatched immediately.
      if (livenessResult.runIds.length > 0) {
        nudgeScheduledRuns(livenessResult.runIds).catch((nudgeErr) => {
          logger.warn("Liveness watchdog nudge failed", {
            ...context,
            runIds: livenessResult.runIds,
            error: nudgeErr instanceof Error ? nudgeErr.message : String(nudgeErr),
          });
        });
      }
    } catch (livenessErr) {
      logger.warn("PGID liveness watchdog sweep failed", {
        ...context,
        error: livenessErr instanceof Error ? livenessErr.message : String(livenessErr),
      });
    }

    // ── Stale-claim sweeper (run-scoped) ───────────────────────────
    try {
      const staleThresholdMs = timeout * 1.5 * 1000;
      const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
      const staleResult = recoverOrphanedStepsForAgent(
        job.agentId,
        job.runId,
        staleThresholdMs,
        undefined, // timeoutRetryReason
        undefined, // failureReason
        undefined, // workerJobId
        "worker_timeout",
        undefined, // detailPrefix
        undefined, // exitCode
        undefined, // signal
        undefined, // stderrTail
      );
      if (staleResult.recovered > 0 || staleResult.failed > 0) {
        logger.info("Stale-claim sweeper ran", {
          ...context,
          recovered: staleResult.recovered,
          failed: staleResult.failed,
          skipped: staleResult.skipped,
          staleThresholdMs,
        });
      }
    } catch (sweepErr) {
      logger.warn("Stale-claim sweeper failed", {
        ...context,
        error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      });
    }

    // ── Deterministic peek ─────────────────────────────────────────
    // A cheap in-process SQL COUNT decides whether to spawn a harness.
    // Idle rounds end here: no process spawn, no model, no tokens.
    try {
      const { peekStep } = await import("./step-ops.js");
      if (peekStep(job.agentId, job.runId) === "NO_WORK") {
        logger.debug("Dispatch round idle — no pending step", {
          ...context,
          reason: "no_pending_step",
        });
        return;
      }
    } catch (err) {
      logger.warn("Dispatch peek failed; skipping round", {
        ...context,
        error: String(err),
      });
      return;
    }

    // ── Work spawn ─────────────────────────────────────────────────
    let agentPersonaInstructions = "";
    try {
      agentPersonaInstructions = await buildAgentPersonaInstructions(job.agentId);
    } catch (err) {
      logger.warn("Agent persona instructions unavailable", {
        ...context,
        workspaceDir: resolveWorkflowWorkspaceDir(job.agentId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const workPrompt = buildWorkPrompt(
      job.workflowId,
      job.agentId,
      job.runId,
      agentPersonaInstructions,
      job.id,
      runNumber,
    );

    logger.info("Work round start", context);

    const onSpawn = ({ pid, pgid }: { pid: number; pgid: number }) => {
      inFlightChildren.set(job.id, { pid, pgid, killed: false });
    };

    let output: string;
    const adapter = getHarnessAdapter(harnessType);
    // Pre-resolve the binary path. For hermes, this goes through the
    // same shared resolver that admission validation uses, guaranteeing
    // single-source dispatch — no disagreement between validation and
    // invocation. The resolved path is passed in options.binaryPath so
    // runRound skips its own redundant findBinary() call.
    const binaryPath = await adapter.findBinary({ preferTokenSaver });
    const harnessEnv: Record<string, string> = {
      TAMANDUA_WORKER_JOB_ID: job.id,
      TAMANDUA_WORKER_PID: String(process.pid),
    };
    if (harnessType === "hermes") {
      harnessEnv.TAMANDUA_HERMES_BINARY = binaryPath;
    }
    // Prepend the binary's directory to the child PATH so nested
    // hermes/pi invocations within the agent session can find the
    // same binary, even when the daemon's own PATH lacked it (e.g.
    // login-shell-discovered hermes). The original PATH is preserved
    // as a suffix so standard system tools remain reachable.
    const binaryDir = path.dirname(binaryPath);
    const currentPathDirs = (process.env.PATH ?? "").split(path.delimiter);
    if (!currentPathDirs.includes(binaryDir)) {
      harnessEnv.PATH = `${binaryDir}${path.delimiter}${process.env.PATH ?? ""}`;
    }
    result = await adapter.runRound(workPrompt, {
      timeout,
      workdir: workingDirectoryForHarness,
      env: harnessEnv,
      onSpawn,
      preferTokenSaver,
      binaryPath,
    });
    output = result.output;

    // ── Post-round processing ──────────────────────────────────────
    const metadata = parseWorkRoundMetadata(output);
    const outputSummary = summarizeWorkRoundOutput(metadata.assistantOutput || output);

    logger.info("Work round complete", {
      ...context,
      outcome: outputSummary.outcome,
      outputBytes: outputSummary.bytes,
      outputLines: outputSummary.lines,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
      tokenUsage: metadata.tokenUsage,
      metadataFormat: metadata.jsonMetadataDetected ? "json" : "text",
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    });

    // Guard: hermes stdout carries no token usage by contract.
    // Any usage parsed from it is contamination (e.g. agent echoing
    // pi-style JSON) that would double count on top of the state.db
    // attribution. This also stops the misleading "--mode json may
    // be off" warning for hermes rounds.
    if (harnessType !== "hermes") {
      await attributeWorkRoundTokenUsage(context, job, outputSummary, metadata);
    }

    // ── Hermes token lookup ──────────────────────────────────────
    // When the round ran through hermes and a session id was captured,
    // look up token usage from hermes' own state.db and attribute it
    // exactly like pi rounds (reuses attributeWorkRoundTokenUsage).
    if (harnessType === "hermes" && result.sessionRef) {
      const hermesTokens = await lookupHermesSessionTokens(result.sessionRef);
      if (hermesTokens !== null && hermesTokens > 0) {
        const hermesMetadata: WorkRoundMetadata = {
          assistantOutput: output,
          tokenUsage: hermesTokens,
          runId: null,
          stepId: null,
          jsonMetadataDetected: false,
        };
        await attributeWorkRoundTokenUsage(context, job, outputSummary, hermesMetadata);
      }
    }

    if (outputSummary.outcome === "work_done") {
      await autoCompleteStepIfRunning(context, metadata);
    } else if (outputSummary.outcome === "other_output" || outputSummary.outcome === "empty_output") {
      // The harness exited cleanly but never emitted a STATUS marker: the
      // agent may have claimed a step and died silently. Recovery is
      // jobId-scoped, so it only touches steps claimed by THIS round's
      // worker — a `no_work` claim race recovers nothing.
      try {
        const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
        const recoveryResult = recoverOrphanedStepsForAgent(
          job.agentId,
          job.runId,
          undefined,
          undefined,
          undefined,
          job.id,
          "worker_lost",
          undefined, // detailPrefix
          result?.exitCode,
          result?.signal,
          result?.stderrTail,
        );
        if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
          logger.info("Orphaned step recovery after clean harness exit without STATUS", {
            ...context,
            outcome: outputSummary.outcome,
            recovered: recoveryResult.recovered,
            failed: recoveryResult.failed,
            skipped: recoveryResult.skipped,
          });
        }
      } catch (recoveryErr) {
        logger.error("Orphaned step recovery after clean harness exit failed", {
          ...context,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
      }
    } else if (outputSummary.outcome === "no_work") {
      // The round replied NO_WORK_AVAILABLE — the agent may have left a
      // dangling claim (e.g. CLTX-type claimStep failure) that blocks its
      // own step. Check and immediately release any step still held by
      // this job's claim_job_id. staleThresholdMs=0 means immediate
      // release (no waiting). Recovery is jobId-scoped so it only touches
      // steps claimed by THIS round's worker.
      try {
        const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
        const recoveryResult = recoverOrphanedStepsForAgent(
          job.agentId,
          job.runId,
          0, // staleThresholdMs=0: immediate release, no wait
          undefined, // no timeout retry reason (not a timeout)
          undefined, // no failure reason
          job.id, // workerJobId scoping
          "no_work_release",
          undefined, // detailPrefix
          result?.exitCode,
          result?.signal,
          result?.stderrTail,
        );
        if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
          logger.info("Immediate claim release after no_work round (dangling claim detected)", {
            ...context,
            outcome: outputSummary.outcome,
            recovered: recoveryResult.recovered,
            failed: recoveryResult.failed,
            skipped: recoveryResult.skipped,
            reason: "dangling_claim_no_work",
          });
        }
      } catch (recoveryErr) {
        logger.error("Immediate claim release after no_work round failed", {
          ...context,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = buildBoundedPreview(errorMessage, MAX_WORK_ERROR_PREVIEW);

    logger.error("Work round failed", {
      ...context,
      errorBytes: errorSummary.bytes,
      errorPreview: errorSummary.preview,
      errorTruncated: errorSummary.truncated,
    });

    try {
      const isTimeout = errorMessage.includes("timed out");
      const timeoutRetryReason = isTimeout
        ? `previous attempt was killed by the ${Math.round(timeout / 60)}-minute harness timeout — plan the work to fit, or split it.`
        : undefined;

      const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
      const recoveryResult = recoverOrphanedStepsForAgent(
        job.agentId,
        job.runId,
        undefined,
        timeoutRetryReason,
        undefined,
        job.id,
        "worker_lost",
        undefined, // detailPrefix
        result?.exitCode,
        result?.signal,
        result?.stderrTail,
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after harness failure", {
          ...context,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          harnessExitError: errorMessage,
          isTimeout,
        });
      }

      // ── Hermes token lookup on adapter rejection ──────────────
      // When the hermes adapter could not even resolve (e.g. spawn error),
      // attempt to extract sessionRef from the error's stderr suffix and
      // run hermes token attribution if found.
      if (harnessType === "hermes") {
        const stderrMatch = errorMessage.match(/\nstderr:\s*(.*)/s);
        if (stderrMatch) {
          const stderrText = stderrMatch[1];
          const sessionIdRegex = /^session_id:\s*(\S+)/m;
          const sessionMatch = stderrText.match(sessionIdRegex);
          if (sessionMatch) {
            const sessionRef = sessionMatch[1];
            const { lookupHermesSessionTokens } = await import("./hermes-usage.js");
            const hermesTokens = await lookupHermesSessionTokens(sessionRef);
            if (hermesTokens !== null && hermesTokens > 0) {
              const hermesMetadata: WorkRoundMetadata = {
                assistantOutput: "",
                tokenUsage: hermesTokens,
                runId: null,
                stepId: null,
                jsonMetadataDetected: false,
              };
              const outputSummary = summarizeWorkRoundOutput("");
              await attributeWorkRoundTokenUsage(context, job, outputSummary, hermesMetadata);
              logger.info("Hermes token attribution from error-path stderr", {
                ...context,
                sessionRef,
                tokenDelta: hermesTokens,
              });
            }
          }
        }
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery failed", {
        ...context,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  } finally {
    inFlightJobs.delete(job.id);
    inFlightChildren.delete(job.id);
  }
}

// ── Public API: run-scoped scheduling ──────────────────────────────

function buildJobId(workflowId: string, runId: string, agentId: string): string {
  // The agent id may already be `${workflowId}_${rawAgentId}` if it was
  // resolved through claimStep paths. Strip the workflow prefix for a clean
  // job id; the full prefixed id is still what we use for DB queries.
  const shortAgent = agentId.startsWith(`${workflowId}_`)
    ? agentId.slice(workflowId.length + 1)
    : agentId;
  return `tamandua-${workflowId}-${runId}-${shortAgent}`;
}

/**
 * Create a single run-scoped dispatch job (one per (runId, agentId)).
 */
export async function createAgentCronJob(
  params: CreateCronJobParams,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const {
    workflowId,
    runId,
    agent,
    workflow,
    workingDirectoryForHarness,
  } = params;
  const staggerMs = params.staggerOffsetMs ?? 0;

  const id = buildJobId(workflowId, runId, agent.id);

  if (jobMetadata.has(id) || activeTimers.has(id) || pendingStartTimers.has(id)) {
    return { ok: true, id };
  }

  const role = agent.role ?? inferRole(agent.id);
  const timeoutSeconds = agent.timeoutSeconds ?? getRoleTimeoutSeconds(role);

  const fullAgentId = agent.id.startsWith(`${workflowId}_`) ? agent.id : `${workflowId}_${agent.id}`;

  // Read harness_type from run context; default to "pi" if not set.
  let harnessType: HarnessType = "pi";
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
    if (runRow) {
      const ctx = parseRunContext(runId, runRow.context);
      if (ctx.harness_type === "hermes") {
        harnessType = "hermes";
      }
    }
  } catch {
    // If we can't read the context, default to "pi"
  }

  const jobInfo: CronJobInfo = {
    id,
    workflowId,
    runId,
    agentId: fullAgentId,
    sessionLabel: `${agent.id}-cron`,
    timeoutSeconds,
    workingDirectoryForHarness,
    harnessType,
    createdAt: new Date().toISOString(),
  };

  jobMetadata.set(id, jobInfo);

  const startDispatch = () => {
    pendingStartTimers.delete(id);
    if (!jobMetadata.has(id)) return;
    if (activeTimers.has(id)) return;

    const timer = setInterval(() => {
      executeDispatchRound(jobInfo, agent, workflow).catch((err) => {
        logger.error("Unhandled dispatch error", { jobId: id, runId, error: String(err) });
      });
    }, DISPATCH_INTERVAL_MS);

    activeTimers.set(id, timer);

    logger.info("Dispatch job created", {
      id,
      runId,
      agentId: agent.id,
      dispatchIntervalMs: DISPATCH_INTERVAL_MS,
      staggerMs,
      workingDirectoryForHarness,
    });
  };

  if (staggerMs > 0) {
    const pending = setTimeout(startDispatch, staggerMs);
    pendingStartTimers.set(id, pending);
    logger.info("Dispatch job scheduled with stagger", { id, runId, staggerMs });
  } else {
    startDispatch();
  }

  return { ok: true, id };
}

/**
 * Set up dispatch jobs for every agent in a workflow, scoped to a single run.
 *
 * Dispatch rounds are free (in-process DB peeks), so all jobs start
 * immediately with the same constant interval — no stagger, no per-workflow
 * interval math, and `noHurrySaveTokensMode` no longer changes anything
 * (it existed to stretch the model-driven polling interval).
 *
 * @param workflow – the workflow spec
 * @param runId    – the run owning these jobs
 * @param options  – workingDirectoryForHarness for the run
 */
export async function setupAgentCrons(
  workflow: WorkflowSpec,
  runId: string,
  options: SetupAgentCronsOptions = {},
): Promise<void> {
  for (const agent of workflow.agents) {
    const jobId = buildJobId(workflow.id, runId, agent.id);
    if (jobMetadata.has(jobId)) {
      logger.info("Run-scoped dispatch job already exists; skipping", {
        jobId,
        runId,
        agentId: agent.id,
      });
      continue;
    }

    const result = await createAgentCronJob({
      workflowId: workflow.id,
      runId,
      agent,
      workflow,
      workingDirectoryForHarness: options.workingDirectoryForHarness,
    });

    if (!result.ok) {
      logger.warn("Failed to set up dispatch job for agent", {
        agentId: agent.id,
        runId,
        error: result.error,
      });
    }
  }
}

/**
 * Grace window before an in-flight harness process group is killed when a
 * run is torn down after reaching a terminal state ON ITS OWN. The harness
 * that reported the final step is usually still alive at that moment, and
 * pi emits its final assistant message (message_end with token usage) AFTER
 * the tool call that runs `step complete` — killing the process immediately
 * loses the final round's token usage and any post-report bookkeeping.
 */
export const HARNESS_TEARDOWN_GRACE_MS = 10_000;

/**
 * Return the teardown grace for a run status. Only runs that reached a
 * terminal state naturally may keep their final harness round alive long
 * enough to flush usage/session metadata; all user-directed, missing, and
 * invalid states tear down immediately.
 */
export function getRunTeardownGraceMs(status: string | undefined): number {
  return status === "completed" || status === "failed"
    ? HARNESS_TEARDOWN_GRACE_MS
    : 0;
}

export interface RemoveRunCronsOptions {
  /**
   * Milliseconds to let in-flight harness processes exit on their own
   * before the SIGTERM/SIGKILL leak guard fires. 0 (default) kills
   * immediately — correct for user-initiated terminate/pause/cancel of an
   * active run. Teardown triggered by natural run completion should pass
   * HARNESS_TEARDOWN_GRACE_MS.
   */
  graceMs?: number;
}

/**
 * Schedule a one-shot post-grace sweep timer for a run. Deduplicated: at
 * most one pending timer per runId. The timer is unref-ed so a process
 * with an empty event loop exits without waiting. Called from
 * `removeRunCrons` so every run teardown path (control-plane terminate,
 * dispatch-round run_not_running) gets a sweep scheduled.
 */
function scheduleSweepTimer(runId: string): void {
  if (pendingSweepTimers.has(runId)) return;

  const delayMs = HARNESS_TEARDOWN_GRACE_MS + 2_000;
  const timer = setTimeout(async () => {
    pendingSweepTimers.delete(runId);
    try {
      const { getRunWorktree } = await import("./worktree-manager.js");
      const wt = getRunWorktree(runId);
      if (!wt) {
        logger.info("Sweep timer: no worktree found for run (already removed?)", { runId });
        return;
      }

      const { sweepRunProcesses } = await import("./run-cleanup.js");
      const result = sweepRunProcesses(runId, wt.worktreePath, {
        daemonPid: process.pid,
        // After grace, the leak guard already killed harness groups;
        // survivors ARE leaks — no exclusions.
      });

      if (result.killedPids.length > 0) {
        logger.info("Post-grace sweep killed leaked processes", {
          runId,
          killedPids: result.killedPids,
          evidence: result.evidence,
        });
      } else {
        logger.debug("Post-grace sweep found no leaked processes", { runId });
      }
    } catch (err) {
      logger.warn("Post-grace sweep timer callback failed", {
        runId,
        error: (err as Error).message,
      });
    }
  }, delayMs);

  timer.unref();
  pendingSweepTimers.set(runId, timer);

  logger.debug("Scheduled post-grace sweep timer", { runId, delayMs });
}

/**
 * Remove all dispatch jobs for a given runId. Terminates any in-flight
 * pi process group for the run as well (after `options.graceMs`, if set).
 */
export async function removeRunCrons(
  runId: string,
  options: RemoveRunCronsOptions = {},
): Promise<void> {
  const graceMs = options.graceMs ?? 0;
  const removed: string[] = [];

  for (const [id, info] of jobMetadata) {
    if (info.runId !== runId) continue;

    const pending = pendingStartTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      pendingStartTimers.delete(id);
    }

    const timer = activeTimers.get(id);
    if (timer) {
      clearInterval(timer);
      activeTimers.delete(id);
    }

    const child = inFlightChildren.get(id);
    if (child && !child.killed) {
      child.killed = true;
      if (child.pgid) {
        const pgid = child.pgid;
        // Terminate the entire process group: SIGTERM, then SIGKILL after 5s.
        const terminate = () => {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        };
        if (graceMs > 0) {
          // Graceful teardown: the run ended on its own, so let the harness
          // finish flushing its output stream and exit naturally; the
          // delayed kill is only a leak guard for hung processes.
          setTimeout(terminate, graceMs).unref();
        } else {
          terminate();
        }
      }
    }
    inFlightChildren.delete(id);
    inFlightJobs.delete(id);
    jobMetadata.delete(id);
    removed.push(id);
  }

  if (removed.length > 0) {
    logger.info("Removed run-scoped crons", { runId, count: removed.length, jobIds: removed, graceMs });
  }

  // ── Post-grace process cleanup sweep ────────────────────────────
  // After harness processes exit (or the leak guard kills them), sweep
  // for any surviving leaked processes tied to the run's worktree.
  // Daemon-resident: only fires when the daemon tears down a run's
  // crons. One-shot, deduplicated per runId, unref-ed so empty event
  // loops exit without waiting.
  scheduleSweepTimer(runId);
}

/**
 * Workflow-wide teardown: remove all jobs for any run of this workflow.
 * Used by tests / shutdown paths. Run-scoped removal is preferred.
 */
export async function removeAgentCrons(
  workflowId: string,
  options: RemoveRunCronsOptions = {},
): Promise<void> {
  const seenRunIds = new Set<string>();
  for (const info of jobMetadata.values()) {
    if (info.workflowId === workflowId) seenRunIds.add(info.runId);
  }
  for (const runId of seenRunIds) {
    await removeRunCrons(runId, options);
  }
}

/**
 * @deprecated The new run-scoped scheduler tears down via removeRunCrons.
 * This thin wrapper exists for back-compat with step-ops fire-and-forget calls.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const activeRuns = db
      .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')")
      .get(workflowId) as { cnt: number } | undefined;

    const count = activeRuns?.cnt ?? 0;
    if (count === 0) {
      logger.info("Workflow idle — tearing down crons", { workflowId });
      // Only fires when every run of the workflow is terminal, so give
      // in-flight harness processes the completion grace window.
      await removeAgentCrons(workflowId, { graceMs: HARNESS_TEARDOWN_GRACE_MS });
    }
  } catch (err) {
    logger.warn("Failed to check idle status for teardown", {
      workflowId,
      error: String(err),
    });
  }
}

/**
 * List all active cron jobs.
 */
export async function listCronJobs(): Promise<{
  ok: boolean;
  jobs?: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }>;
}> {
  const jobs: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }> = [];
  for (const [id, info] of jobMetadata) {
    jobs.push({
      id,
      runId: info.runId,
      agentId: info.agentId,
      workingDirectoryForHarness: info.workingDirectoryForHarness,
    });
  }
  return { ok: true, jobs };
}

/**
 * Gracefully shut down all cron jobs (and terminate any in-flight pi
 * process groups). Used by tests and daemon SIGTERM.
 */
export function shutdownAllCrons(): void {
  let count = 0;
  for (const [id, timer] of activeTimers) {
    clearInterval(timer);
    activeTimers.delete(id);
    count++;
  }
  for (const [id, timer] of pendingStartTimers) {
    clearTimeout(timer);
    pendingStartTimers.delete(id);
    count++;
  }
  for (const [id, child] of inFlightChildren) {
    if (!child.killed && child.pgid) {
      child.killed = true;
      safeKillPgid(child.pgid, "SIGTERM");
      setTimeout(() => safeKillPgid(child.pgid, "SIGKILL"), 5000).unref();
    }
  }
  for (const [runId, timer] of pendingSweepTimers) {
    clearTimeout(timer);
    pendingSweepTimers.delete(runId);
  }
  inFlightChildren.clear();
  inFlightJobs.clear();
  jobMetadata.clear();
  if (count > 0) {
    logger.info("Shut down all cron jobs", { count });
  }
}

// ── Nudge ─────────────────────────────────────────────────────────────

/**
 * Trigger an immediate dispatch round for all scheduled jobs in the given runs.
 *
 * Jobs currently in flight are skipped. Pending-start timers are
 * converted to active interval timers after launch. Active timers are
 * cleared and recreated from now after a launched dispatch round.
 *
 * The function loads workflow specs from disk via
 * `loadWorkflowSpec(resolveWorkflowDir(…))` to find matching agents.
 */
export async function nudgeScheduledRuns(
  runIds: string[],
  opts?: {
    /** Override for tests — defaults to loadWorkflowSpec from workflow-spec.js. */
    loadWorkflowSpec?: (workflowDir: string) => Promise<WorkflowSpec>;
  },
): Promise<NudgeResult> {
  const runIdSet = new Set(runIds);
  const result: NudgeResult = {
    runIds: [...runIds],
    launched: 0,
    skippedInFlight: 0,
    errors: [],
    jobs: [],
  };

  // Resolve spec loader — lazy-import to avoid circular dep at module
  // init and to allow test overrides.
  const loadSpec: (workflowDir: string) => Promise<WorkflowSpec> =
    opts?.loadWorkflowSpec ??
    (await import("./workflow-spec.js")).loadWorkflowSpec;

  // Collect matching jobs from jobMetadata.
  const matchingJobs: Array<{ info: CronJobInfo; id: string }> = [];
  for (const [id, info] of jobMetadata) {
    if (runIdSet.has(info.runId)) {
      matchingJobs.push({ info, id });
    }
  }

  // Process each job.
  for (const { info, id: jobId } of matchingJobs) {
    // ── In-flight guard ──────────────────────────────────────────
    if (inFlightJobs.has(jobId)) {
      result.skippedInFlight++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "skipped_in_flight",
      });
      continue;
    }

    try {
      // Load workflow spec from disk.
      const flowDir = resolveWorkflowDir(info.workflowId);
      const workflow = await loadSpec(flowDir);

      // Find matching agent.
      // jobMetadata stores agentId as the full prefixed form
      //   e.g. "feature-dev-merge-worktree_developer"
      // Workflow agents use the short id (e.g. "developer").
      const shortAgentId = info.agentId.startsWith(`${info.workflowId}_`)
        ? info.agentId.slice(info.workflowId.length + 1)
        : info.agentId;

      const agent = workflow.agents.find(
        (a) =>
          a.id === shortAgentId ||
          `${info.workflowId}_${a.id}` === info.agentId,
      );

      if (!agent) {
        const errMsg = `Agent ${info.agentId} not found in workflow ${info.workflowId}`;
        result.errors.push({
          runId: info.runId,
          agentId: info.agentId,
          error: errMsg,
        });
        result.jobs.push({
          runId: info.runId,
          agentId: info.agentId,
          status: "error",
          error: errMsg,
        });
        continue;
      }

      // ── Launch dispatch round (fire-and-forget) ────────────────
      // tryMarkJobInFlight inside executeDispatchRound prevents
      // duplicate launches with near-simultaneous timer ticks.
      executeDispatchRound(info, agent, workflow).catch((err) => {
        logger.error("Nudge-launched dispatch round failed", {
          jobId,
          runId: info.runId,
          agentId: info.agentId,
          error: String(err),
        });
      });

      // ── Timer reset ───────────────────────────────────────────
      const activeTimer = activeTimers.get(jobId);
      const pendingTimer = pendingStartTimers.get(jobId);

      if (activeTimer) {
        // Clear existing interval, recreate from now.
        clearInterval(activeTimer);
        activeTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executeDispatchRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled dispatch error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, DISPATCH_INTERVAL_MS);
        activeTimers.set(jobId, newTimer);
      } else if (pendingTimer) {
        // Convert pending-start to active interval.
        clearTimeout(pendingTimer);
        pendingStartTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executeDispatchRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled dispatch error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, DISPATCH_INTERVAL_MS);
        activeTimers.set(jobId, newTimer);
      }
      // If neither timer exists, the job's own startDispatch() already
      // created a timer — we leave it alone.

      result.launched++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "launched",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        runId: info.runId,
        agentId: info.agentId,
        error: errorMsg,
      });
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "error",
        error: errorMsg,
      });
    }
  }

  return result;
}

// ── Internal helpers (exposed for daemon reconciler + tests) ─────────

/** @internal — exposed for tests to introspect pending sweep timers. */
export function _pendingSweepTimerCount(): number {
  return pendingSweepTimers.size;
}

/** @internal — exposed for tests to check whether a timer is pending for a runId. */
export function _hasPendingSweepTimer(runId: string): boolean {
  return pendingSweepTimers.has(runId);
}

/** @internal — exposed for daemon reconciler. */
export function _scheduledRunIds(): Set<string> {
  const ids = new Set<string>();
  for (const info of jobMetadata.values()) ids.add(info.runId);
  return ids;
}

/** @internal — exposed for daemon reconciler. */
export function _hasRunScheduled(runId: string): boolean {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) return true;
  }
  return false;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCount(): number {
  return jobMetadata.size;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCountForRun(runId: string): number {
  let count = 0;
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) count++;
  }
  return count;
}

/** @internal — exposed for daemon admission safety checks. */
export function _runIdForScheduledHarnessWorkdir(
  workingDirectoryForHarness: string,
  excludingRunId?: string,
): string | null {
  let requested = path.resolve(workingDirectoryForHarness);
  try {
    requested = fs.realpathSync(requested);
  } catch {
    /* admission validates existence before calling this */
  }

  for (const info of jobMetadata.values()) {
    if (excludingRunId && info.runId === excludingRunId) continue;
    if (!info.workingDirectoryForHarness) continue;

    let scheduled = path.resolve(info.workingDirectoryForHarness);
    try {
      scheduled = fs.realpathSync(scheduled);
    } catch {
      /* stale job metadata should not block scheduling by itself */
    }

    if (scheduled === requested) return info.runId;
  }

  return null;
}
