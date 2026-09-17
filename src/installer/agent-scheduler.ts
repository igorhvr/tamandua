import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { resolveTamanduaCli, resolveWorkflowDir, resolveWorkflowWorkspaceDir } from "./paths.js";
import type { WorkflowSpec, WorkflowAgent, HarnessType } from "./types.js";
import { logger } from "../lib/logger.js";
import { SQL_NOW_ISO, monotonicNow, Stopwatch } from "../lib/instant.js";
import { getRoleTimeoutSeconds, inferRole } from "./install.js";
import { formatPiCommandPreview } from "./pi-command-preview.js";
import { emitEvent, getRunEvents, type TamanduaEvent } from "./events.js";
import { parseRunContext, sanitizeStderrTail, type PendingStepRef } from "./step-ops.js";
import { gitIdentityEnv, readGitIdentityFromContext } from "./git-identity.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";
import { getHarnessAdapter, type HarnessRoundResult } from "./harness-adapter.js";
import {
  isInstantFailRound,
  isPreclaimDeathRound,
  instantFailBackoffDelayMs,
  formatInstantFailReason,
  formatPreclaimDeathReason,
  getInstantFailBackoffThreshold,
  getInstantFailEscalationThreshold,
  resolveHarnessWallMs,
  type InstantFailRoundSignals,
} from "./instant-fail.js";
import {
  buildHarnessProbeCommand,
  buildHarnessProbeFailureBlock,
  buildHarnessProbePrompt,
  computeExpectedHarnessProbePath,
  evaluateHarnessProbe,
  getHarnessProbeWallMs,
  harnessProbeObservedDisplay,
  harnessProbeStderrTailDisplay,
  isHarnessProbeEnabled,
  readHarnessProbeStatus,
  recordHarnessProbeResult,
  reserveHarnessProbe,
  type HarnessProbeFailureFields,
} from "./harness-probe.js";
import { lookupHermesSessionTokens } from "./hermes-usage.js";
import { lookupDshSessionTokens } from "./dsh-usage.js";
import { extractPerCallTokenTotal } from "./token-usage-policy.js";

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
// direct DB peek (peekStep) and spawns a harness (pi/hermes/dsh) ONLY when a
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

/**
 * WAVE-A US-003: per-round cap on in-process conditional auto-completes.
 * A single dispatch round may auto-complete at most this many conditional
 * steps (condition unset) before falling through to the harness spawn;
 * any remainder is picked up by the next tick/nudge. The bound keeps a
 * pathological chain of auto-completable steps from monopolizing a round.
 */
export const MAX_CONDITIONAL_AUTO_COMPLETES_PER_ROUND = 16;

/** Maps job id → active setInterval handle. */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Maps job id → delayed first-start timeout handle. */
const pendingStartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Maps job id → persistent metadata. */
const jobMetadata = new Map<string, CronJobInfo>();

/**
 * Per-job consecutive instant-fail tracking (RSPN).
 *
 * An instant-fail round is one whose harness exited nonzero with zero
 * output below the wall-time threshold before claiming any step (broken
 * or deleted harness binary, revoked credential, bad PATH). Such rounds
 * claim nothing, so WLST5's worker_lost/ceiling_expiry counters — which
 * only tick when a step/story is actually recovered — never see them and
 * the fixed dispatch tick would relaunch the broken harness forever.
 *
 * The streak is per (run, agent) dispatch job, incremented on each
 * classified instant-fail round and reset on any non-instant-fail harness
 * round (timed-out rounds belong to the ceiling-expiry class and never
 * touch it). At K consecutive rounds the motor starts backing off the
 * relaunch (see {@link instantFailBackoffDelayMs}); at N it force-fails
 * the run through the sanctioned forceFailRun path.
 *
 * Entries are cleared by `removeRunCrons` (run teardown) and
 * `shutdownAllCrons`.
 *
 * @internal — exposed for test introspection via `_instantFailStreakFor`.
 */
interface InstantFailStreak {
  /** Consecutive classified instant-fail rounds for this job. */
  consecutive: number;
  /**
   * Monotonic ms (TIME-CLOCKS rule 1) before which the job's next dispatch
   * round is skipped (backoff). 0 when no backoff is active. This is an
   * in-process deadline — it never survives a restart and must never be
   * mixed with `Date.now()`/epoch instants, so a wall-clock jump cannot
   * release or extend the backoff.
   */
  nextAllowedDispatchAt: number;
}
const instantFailStreaks = new Map<string, InstantFailStreak>();

/**
 * OUTAGE-ROUNDS (SCLS) pre-claim death streak, per (run, agent) dispatch job.
 *
 * An instant fail is a FAST zero-output nonzero-exit round (below the wall
 * threshold) that claims nothing; a pre-claim death is its slow complement:
 * the harness ran at least the wall threshold and then exited nonzero or was
 * killed by a signal WITHOUT claiming a pending step (vaivm evidence: a
 * verifier dying 8 times with STREAM_CLOSED before claiming, invisible for
 * two hours). The counter is per-step in the DB (`steps.preclaim_death_count`,
 * reset by any successful claim) and this in-memory streak drives the US-005
 * backoff/cap — it is reset by every non-matching round.
 *
 * Like {@link InstantFailStreak}, the streak carries its own MONOTONIC
 * relaunch deadline (`nextAllowedDispatchAt`): at K consecutive deaths the
 * motor arms an escalating delay (see {@link instantFailBackoffDelayMs}) and
 * at N it force-fails the run with a distinct `run.preclaim_death_loop` alert.
 * No retry budget is charged — a pre-claim death is not a step failure.
 *
 * Entries are cleared by `removeRunCrons` (run teardown) and
 * `shutdownAllCrons`.
 *
 * @internal — exposed for test introspection via `_preclaimDeathStreakFor`.
 */
interface PreclaimDeathStreak {
  /** Consecutive pre-claim death rounds for this job. */
  consecutive: number;
  /**
   * Monotonic ms (TIME-CLOCKS rule 1) before which the job's next dispatch
   * round is skipped (pre-claim-death backoff). 0 when no backoff is active.
   * This is an in-process deadline — it never survives a restart and must
   * never be mixed with `Date.now()`/epoch instants, so a wall-clock jump
   * cannot release or extend the backoff.
   */
  nextAllowedDispatchAt: number;
}
const preclaimDeathStreaks = new Map<string, PreclaimDeathStreak>();

/**
 * Set of job ids whose dispatch round is currently running. Used to skip a
 * tick when the previous round for the same (run, agent) hasn't finished —
 * without this guard, setInterval would keep spawning new harness processes
 * every interval even though work rounds can take 10–30 minutes.
 */
const inFlightJobs = new Set<string>();

/**
 * Per-job completion signal for an in-flight dispatch round.
 *
 * Registered when a round passes the in-flight guard and resolved in the
 * round's `finally` AFTER all post-round processing (token attribution via
 * `attributeWorkRoundTokenUsage`, orphan recovery, auto-complete) has
 * completed. `settleRunInFlightRounds` awaits these so the cancel path can
 * guarantee a round's token attribution lands before a terminal event is
 * emitted (TATR facet 3).
 *
 * Entries deliberately survive `removeRunCrons` — which wipes
 * `jobMetadata`/`inFlightJobs` but must NOT wipe attribution in progress —
 * so a settle that runs after timer removal still finds the in-flight round
 * and waits for its attribution. Entries are removed only when the round
 * itself completes (its `finally`) or `shutdownAllCrons` clears the
 * scheduler.
 */
interface RoundCompletionSignal {
  runId: string;
  done: Promise<void>;
  resolve: () => void;
}
const roundCompletionSignals = new Map<string, RoundCompletionSignal>();

/**
 * F3: per-run delta of the most recently attributed worker round.
 *
 * Updated by `attributeWorkRoundTokenUsage` after a successful DB
 * increment; read by the once-per-run `run.tokens.final` emitter at run
 * teardown so the closing event can carry the last settled round's delta
 * (omitted entirely when no usage ever landed — never fabricated).
 */
const lastRoundTokenDeltas = new Map<string, number>();

/**
 * F3: run ids whose closing `run.tokens.final` has already been
 * scheduled. The entry is added before any timer/wait is armed so
 * repeated `removeRunCrons`/settle calls for the same run can never
 * schedule (or emit) a second final event.
 */
const finalizedTokenRuns = new Set<string>();

/**
 * F3: run ids with an in-progress `run.tokens.final` wait/timer. Cleared
 * per run once the closing event settles, and wholesale by
 * `shutdownAllCrons` (which also cancels the timers) so a late callback
 * cannot emit after the scheduler has shut down.
 */
const activeTokenFinalizations = new Set<string>();

/** F3: pending `run.tokens.final` grace timers, keyed by runId. */
const tokenFinalTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
 * KHYG US-002: per-dispatch-round cancellation controllers, keyed by job
 * id. The dispatch round passes its controller's signal to the adapter's
 * launch boundary (runRound options.signal → harness-launch.ts), and the
 * teardown/cancel paths (removeRunCrons, shutdownAllCrons) abort it when
 * they mark an in-flight child killed. Unlike `inFlightChildren` (cleared
 * during teardown), this registry survives until the round's own finally
 * so an explicit cancellation recorded mid-setup can veto release and any
 * fresh fallback at the launch boundary — signalCode alone cannot tell a
 * canceled run from the setup wall's own SIGKILL.
 */
const roundAbortControllers = new Map<string, AbortController>();

/** Abort the dispatch round's launch-cancellation signal, if registered. */
function abortDispatchRound(jobId: string): void {
  try {
    roundAbortControllers.get(jobId)?.abort();
  } catch {
    /* abort is idempotent — ignore */
  }
}

/**
 * PKIL (US-005): job ids whose in-flight dispatch round is being torn down
 * by a NON-DRAIN operator `run pause`.
 *
 * `removeRunCrons({ pausedByOperator: true })` records every in-flight round
 * for the run BEFORE it aborts the round controller / SIGTERMs the harness
 * pgid, so the round can read the mark after it settles and classify its exit
 * as `paused_by_operator` (PKIL recovery class, US-004) instead of
 * `worker_lost` — an operator pause must never charge a retry.
 *
 * The mark is consumed (read + deleted) once by the round that owns it, and
 * unconditionally deleted in the round's `finally`, so a stale mark can never
 * leak into a later round that reuses the deterministic job id. Only rounds
 * that are genuinely in flight (`inFlightJobs.has(id)`) are marked, so a
 * teardown of an idle job cannot strand an entry.
 *
 * Cleared by `shutdownAllCrons` for test isolation.
 *
 * @internal — exposed for test introspection via `_operatorPausedRoundIds`.
 */
const operatorPausedRounds = new Set<string>();

/**
 * Read-and-clear the PKIL operator-pause mark for a dispatch round.
 * Returns `true` only when a non-drain pause marked this exact job id before
 * tearing it down.
 */
function consumeOperatorPausedRound(jobId: string): boolean {
  if (!operatorPausedRounds.has(jobId)) return false;
  operatorPausedRounds.delete(jobId);
  return true;
}

/** @internal test introspection for the PKIL operator-pause mark. */
export function _operatorPausedRoundIds(): string[] {
  return [...operatorPausedRounds];
}

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

/**
 * Captured sweep target per runId (working directory + in-flight pgids at
 * teardown time). Set when the sweep timer is scheduled, deleted when the
 * timer fires, and cleared by `shutdownAllCrons`. Exposed for tests via
 * `_pendingSweepTarget` so the `removeRunCrons` capture path is assertable
 * without waiting out the grace window.
 *
 * @internal
 */
const pendingSweepTargets = new Map<string, PostGraceSweepTarget>();

/**
 * Monotonic scheduler generation/epoch counter.
 *
 * Bumped on every `shutdownAllCrons()` call. A dispatch round captures
 * the current generation before its first await; if the generation has
 * moved by the time the round resolves, teardown happened while the
 * round was in flight and the round must not revive timer state.
 *
 * @internal — exposed for test introspection via `_schedulerGeneration`.
 */
let schedulerGeneration = 0;

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
  /** Harness binary to use for agent invocations ("pi", "hermes", or "dsh"). */
  harnessType?: HarnessType;
  /**
   * Resolved commit identity for this run (GIDN US-003), captured from the
   * run context (`git_identity_name`/`git_identity_email`) when the dispatch
   * job is created. Every harness round child env carries it as
   * GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL. Left undefined when
   * the run context carries no identity — the four variables are then simply
   * not set, never fabricated.
   */
  gitIdentity?: { name: string; email: string };
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
   * harness binary (e.g., `pi-token-saver` over `pi`, `hermes-token-saver`
   * over `hermes`, or `dsh-token-saver` over `dsh`). Resolution happens per
   * invocation, so installing the wrapper mid-run takes effect on the next
   * work round; when it is absent, the plain harness binary is used as
   * usual. The per-harness env override (TAMANDUA_PI_BINARY /
   * TAMANDUA_HERMES_BINARY / TAMANDUA_DSH_BINARY) still wins over all —
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

// ── dsh binary discovery ──────────────────────────────────────────

import { resolveDshBinary, resolveDshViaLoginShell } from "./dsh-resolver.js";

// Re-export resolveDshViaLoginShell from the shared resolver module.
// Doctor and harness-adapter import from dsh-resolver.js directly; kept
// here for any external consumers that resolve via agent-scheduler (mirrors
// the hermes re-export above).
export { resolveDshViaLoginShell };

/**
 * Thin async wrapper around {@link resolveDshBinary} from the shared
 * dsh resolver module. Discovery is entirely side-effect-free — no
 * filesystem mutation (no symlink creation, no file deletion, no chmod).
 *
 * Resolution precedence:
 *   1. TAMANDUA_DSH_BINARY env var (must be X_OK)
 *   2. Process PATH lookup (preferring `dsh-token-saver` when requested)
 *   3. Login-shell fallback (zsh -lic 'command -v dsh')
 */
export async function findDshBinary(): Promise<string> {
  return resolveDshBinary();
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
  // Markers are recognized ONLY at the START of a line in the assistant's own
  // final text (leading whitespace allowed), never embedded mid-line and never
  // inside a tool_execution payload. The `m` (multiline) flag makes `^` match
  // at every line start — the anchor required by PRAW requirement 2
  // (`^\s*STATUS:\s*(done|fail|failed|error)\b`, multiline). A STATUS/NO_WORK
  // marker echoed back in a tool result, a cat'ed file, or a command echo is
  // NOT the agent's report and must never drive completion.
  if (/^\s*NO_WORK_AVAILABLE\b/m.test(output)) return "no_work";
  if (/^\s*STATUS:\s*(fail|failed|error)\b/im.test(output)) return "work_failed";
  if (/^\s*STATUS:\s*done\b/im.test(output)) return "work_done";
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

/**
 * Per-call token total for one pi `message.usage` object.
 *
 * Historical name for the shared extractor (`extractPerCallTokenTotal` in
 * `token-usage-policy.ts`): field aliasing and the aggregate-only
 * `totalTokens` fallback live THERE so the pi round parser and the
 * real-canary session-store audit cannot drift. Applies the shared harness
 * policy — input + output + cache_write, cache_read EXCLUDED (matching
 * hermes and dsh); pi's cache-inclusive `totalTokens` is ignored whenever a
 * component field is present, and used only as a last-resort per-call
 * fallback (never a fabricated zero).
 */
export function extractTokenUsage(usageLike: unknown): number | null {
  return extractPerCallTokenTotal(usageLike);
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

        // pi reports usage PER API CALL, so a tool-using round emits one
        // assistant message_end per call. SUM every assistant message's
        // per-call usage (shared policy: input + output + cache_write,
        // cache_read excluded) — never the last value alone.
        const extractedUsage = extractTokenUsage(message.usage);
        if (extractedUsage !== null) {
          tokenUsage = (tokenUsage ?? 0) + extractedUsage;
        }
      }
    }

    if (type.startsWith("tool_execution")) {
      collectTextFragments(event, toolTextFragments);
    }
  }

  // PRAW requirement 1: a JSON round with no assistant text yields
  // assistantOutput "" — NOT the raw JSONL transcript. The transcript is
  // full of tool payloads that may echo the task instructions (including a
  // literal "STATUS: done"), so treating it as the round's output let a
  // tool result masquerade as the agent's report. There is no fallback:
  // an empty assistant text classifies as empty_output. Identifier hints
  // are still harvested from tool data below (token attribution and
  // cross-run hijack detection depend on them).
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

/**
 * Resolve a run id from a round's parsed metadata (tool output run id, or
 * a step lookup by the tool-output step id).
 *
 * TATR US-008: the result is ADVISORY ONLY. In the dispatch path the
 * authoritative run is `job.runId` — the run this round was spawned for —
 * so a metadata id that names a sibling/nested run must never redirect
 * attribution. This resolver is used (a) to detect such disagreements (the
 * cross-run metadata hijack signal) and (b) as a fallback for genuinely
 * runless invocations where `job.runId` is unavailable.
 */
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
  /** The run's DB status at attribution time (TATR US-007 post-terminal flush identity). */
  status: string;
}

/**
 * Terminal run statuses. When a token flush is attributed to a run that
 * already reached one of these, the emitted run.tokens.updated is marked
 * post-terminal (postTerminal: true + terminalStatus) so consumers that
 * stop reading at the terminal event can subscribe to the late flush
 * instead of missing the delta (TATR US-007).
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "canceled"]);

function isTerminalRunStatus(status: string | undefined): status is string {
  return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

async function incrementRunTokenSpend(runId: string, tokenUsage: number): Promise<TokenSpendUpdate | null> {
  const { getDb } = await import("../db.js");
  const db = getDb();
  const result = db
    .prepare(`UPDATE runs SET tokens_spent = tokens_spent + ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`)
    .run(tokenUsage, runId);

  if ((result.changes ?? 0) <= 0) return null;

  const row = db
    .prepare("SELECT workflow_id, tokens_spent, status FROM runs WHERE id = ?")
    .get(runId) as { workflow_id: string; tokens_spent: number; status: string } | undefined;

  if (!row) return null;

  return {
    workflowId: row.workflow_id,
    tokensSpent: row.tokens_spent,
    status: row.status,
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
    const result = completeStep(stepId, metadata.assistantOutput, { rejectPausedRun: true });
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
        undefined, // timedOut — no adapter result on the auto-complete throw path; classify as harness_lost
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

  // TATR US-008: the dispatch job's run is authoritative — it is the run
  // this round was spawned for, and therefore the run that actually spent
  // the tokens. A run id parsed from the worker's tool output
  // (metadata_run_id) or resolved from a step lookup is advisory only: a
  // nested/sibling run's metadata can leak into this round's stream and
  // would hijack attribution onto the wrong run. job.runId is always
  // present in the dispatch path; the resolved id is used only for
  // genuinely runless invocations and never redirects attribution.
  const dispatchRunId = job.runId;
  let runId = dispatchRunId;
  let runIdSource: RunIdSource | "dispatch_job" = "dispatch_job";

  if (!dispatchRunId) {
    // Genuinely runless invocation (job.runId unavailable — never happens
    // in the dispatch path): fall back to the resolved id.
    runId = resolved.runId ?? "";
    runIdSource = resolved.runId ? resolved.source : "none";
  } else if (resolved.runId && resolved.runId !== dispatchRunId) {
    // The worker's stream names a different (sibling/nested) run. Log the
    // disagreement — the cross-run metadata hijack signal — and attribute
    // to the dispatch run anyway.
    logger.warn("Work round token attribution overrides metadata run id", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "cross_run_metadata_hijack",
      metadataRunId: resolved.runId,
      metadataRunIdSource: resolved.source,
      dispatchRunId,
      tokenUsage: metadata.tokenUsage,
    });
  }

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

    // F3: remember the last settled round's delta for this run so the
    // closing run.tokens.final emitted at teardown can carry it (omitted
    // when no usage ever landed).
    lastRoundTokenDeltas.set(runId, metadata.tokenUsage);

    // TATR US-007: explicit post-terminal flush identity. A round's token
    // attribution can land after the run already reached a terminal DB
    // status — e.g. a round that outlived the settle grace window, or the
    // final round of a completed/failed run whose usage parsed after the
    // terminal event fired (C15). Mark such flushes explicitly so
    // consumers that stop reading at the terminal event can subscribe to
    // them instead of missing the delta. Non-terminal updates carry
    // neither field (omitted from the serialized event).
    const evt: TamanduaEvent = {
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId,
      workflowId: updated.workflowId,
      tokenDelta: metadata.tokenUsage,
      tokensSpent: updated.tokensSpent,
    };
    // TATR US-008: step/round identity on the token event. stepId comes
    // from the round's stream metadata when known; roundId is always the
    // dispatch job id — the round that actually spent the tokens.
    if (metadata.stepId) evt.stepId = metadata.stepId;
    evt.roundId = job.id;
    if (isTerminalRunStatus(updated.status)) {
      evt.postTerminal = true;
      evt.terminalStatus = updated.status;
    }
    emitEvent(evt);

    logger.debug("Work round token usage attributed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      runId,
      runIdSource,
      stepId: metadata.stepId ?? undefined,
      roundId: job.id,
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

// ── Instant-fail round tracking (RSPN) ───────────────────────────────

/**
 * Monotonic elapsed ms for a round-start {@link Stopwatch}.
 *
 * The watch is created in the work-spawn section, after the launch-time
 * probe and immediately before binary resolution. If the round throws
 * before that point there is no duration signal at all, so return a
 * sentinel FAR above any instant-fail threshold: an unmeasurable round must
 * never be classified as an instant fail on a duration it never measured
 * (the pre-TIME-CLOCKS code produced the same "not an instant fail"
 * outcome via an epoch-sized `Date.now()` difference against a zero
 * round-start). Never reads the wall clock.
 */
function roundElapsedMs(watch: Stopwatch | undefined): number {
  return watch ? watch.elapsedMs() : Number.POSITIVE_INFINITY;
}

/**
 * Arm the instant-fail relaunch backoff as a MONOTONIC deadline (TIME-CLOCKS
 * rule 1): `nextAllowedDispatchAt` is an opaque `monotonicNow()` reading plus
 * the backoff delay, never an epoch instant, so a wall-clock jump (NTP step,
 * suspend/resume) can neither release the gate early nor extend the backoff.
 *
 * `now` is injectable for the cross-cutting wall-jump regression suite; the
 * default is the production monotonic clock.
 *
 * @returns the armed monotonic deadline.
 */
export function armInstantFailBackoff(
  jobId: string,
  consecutive: number,
  delayMs: number,
  now: number = monotonicNow(),
): number {
  const nextAllowedDispatchAt = now + delayMs;
  instantFailStreaks.set(jobId, { consecutive, nextAllowedDispatchAt });
  return nextAllowedDispatchAt;
}

/**
 * True while a job's instant-fail backoff deadline has not yet passed.
 *
 * TIME-CLOCKS rule 1: `now` defaults to `monotonicNow()` and the stored
 * `nextAllowedDispatchAt` is monotonic, so the gate cannot be released (or
 * extended) by a forward/backward wall-clock jump. Exported so the
 * cross-cutting wall-jump suite can exercise the gate without a live harness;
 * `executeDispatchRound` passes its own `monotonicNow()` reading explicitly.
 */
export function isInstantFailBackoffActive(
  streak: { nextAllowedDispatchAt: number } | undefined,
  now: number = monotonicNow(),
): boolean {
  return streak !== undefined && streak.nextAllowedDispatchAt > now;
}

/**
 * Arm the PRE-CLAIM-DEATH relaunch backoff as a MONOTONIC deadline
 * (TIME-CLOCKS rule 1), the exact discipline of
 * {@link armInstantFailBackoff}: `nextAllowedDispatchAt` is an opaque
 * `monotonicNow()` reading plus the backoff delay, never an epoch instant, so
 * a wall-clock jump can neither release the gate early nor extend the
 * backoff. `now` is injectable for the cross-cutting wall-jump suite.
 *
 * @returns the armed monotonic deadline.
 */
export function armPreclaimDeathBackoff(
  jobId: string,
  consecutive: number,
  delayMs: number,
  now: number = monotonicNow(),
): number {
  const nextAllowedDispatchAt = now + delayMs;
  preclaimDeathStreaks.set(jobId, { consecutive, nextAllowedDispatchAt });
  return nextAllowedDispatchAt;
}

/**
 * True while a job's pre-claim-death backoff deadline has not yet passed.
 *
 * TIME-CLOCKS rule 1: `now` defaults to `monotonicNow()` and the stored
 * `nextAllowedDispatchAt` is monotonic, so the gate cannot be released (or
 * extended) by a forward/backward wall-clock jump. Exported so the
 * cross-cutting wall-jump suite can exercise the gate without a live
 * harness; `executeDispatchRound` passes its own `monotonicNow()` reading
 * explicitly.
 */
export function isPreclaimDeathBackoffActive(
  streak: { nextAllowedDispatchAt: number } | undefined,
  now: number = monotonicNow(),
): boolean {
  return streak !== undefined && streak.nextAllowedDispatchAt > now;
}

/**
 * Classify a completed dispatch round as an instant fail (conservatively:
 * wall time below the threshold AND zero TRIMMED output bytes AND nonzero
 * exit or signal-death) and update the per-job consecutive streak:
 * increment on instant-fail, reset on any other harness round, never
 * touch on timed-out rounds (ceiling-expiry class) or when no duration
 * signal exists.
 *
 * At the backoff threshold K the next relaunch is delayed by an
 * escalating amount (see {@link instantFailBackoffDelayMs}); at the
 * escalation threshold N the run is force-failed through the sanctioned
 * forceFailRun path with a precise reason, preceded by a distinct
 * run.instant_fail_loop alert event. WLST5 counters are untouched — this
 * is a third, additive class (the run's instant_fail_count column).
 */
async function trackInstantFailRound(
  job: CronJobInfo,
  context: Record<string, unknown>,
  signals: InstantFailRoundSignals,
): Promise<void> {
  // Classification resolves on the harness-wall-time seam: the harness
  // process time when the runner reported it (excluding VM setup), else the
  // whole-round fallback. Native rounds set harnessWallMs === wallMs, so
  // their behavior is unchanged; adapter-throw rounds have no harnessWallMs
  // and fall back to the monotonic round elapsed time.
  const resolvedWallMs = resolveHarnessWallMs({
    harnessWallMs: signals.harnessWallMs,
    roundWallMs: signals.wallMs,
  });
  if (resolvedWallMs === undefined) return; // no duration signal — cannot classify
  if (signals.result?.timedOut) return; // ceiling-expiry class — never an instant fail

  const isInstantFail = isInstantFailRound(signals);
  const previous = instantFailStreaks.get(job.id);

  if (!isInstantFail) {
    // Any other harness round (exit 0, output produced, slow) is a
    // legitimate round — reset the streak so a single hiccup does not
    // accumulate toward backoff/escalation.
    if (previous) instantFailStreaks.delete(job.id);
    return;
  }

  const consecutive = (previous?.consecutive ?? 0) + 1;
  instantFailStreaks.set(job.id, { consecutive, nextAllowedDispatchAt: 0 });

  // Persist the additive run counter (surfaced by workflow status / runs).
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    db.prepare("UPDATE runs SET instant_fail_count = instant_fail_count + 1 WHERE id = ?").run(job.runId);
  } catch (err) {
    logger.warn("Failed to increment runs.instant_fail_count", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const k = getInstantFailBackoffThreshold();
  const n = getInstantFailEscalationThreshold();

  logger.warn("Worker round classified as instant fail", {
    ...context,
    consecutiveInstantFails: consecutive,
    // wallMs is the whole-round wall time; harnessWallMs is the harness
    // process time the predicate classified on; vmSetupMs is the separate
    // VM setup time (0 native, null when the runner reported none).
    wallMs: signals.wallMs,
    harnessWallMs: signals.harnessWallMs ?? resolvedWallMs,
    vmSetupMs: signals.vmSetupMs ?? null,
    outputBytes: signals.result ? Buffer.byteLength(signals.result.output, "utf-8") : 0,
    exitCode: signals.result?.exitCode ?? null,
    backoffThreshold: k,
    escalationThreshold: n,
  });

  if (consecutive >= n) {
    await escalateInstantFailLoop(job, context, consecutive, signals.result?.commandPreview);
    return;
  }

  if (consecutive >= k) {
    const delayMs = instantFailBackoffDelayMs(consecutive);
    // TIME-CLOCKS rule 1: the backoff window is an in-process deadline, so
    // it is armed and gated on the monotonic clock — a wall-clock jump
    // (NTP step, suspend/resume) can neither release the gate early nor
    // extend the backoff.
    const nextAllowedDispatchAt = armInstantFailBackoff(job.id, consecutive, delayMs);
    logger.warn("Instant-fail loop detected — backing off relaunch", {
      ...context,
      consecutiveInstantFails: consecutive,
      backoffDelayMs: delayMs,
      nextAllowedDispatchAt,
    });
  }
}

/**
 * Escalate an instant-fail loop at the N-round threshold: emit the
 * distinct run.instant_fail_loop alert event, then force-fail the run
 * through the existing forceFailRun path with a precise reason. The
 * force-fail teardown internals are NOT modified — this is the sanctioned
 * call site the RSPN designates. force=true is passed so escalation is
 * guaranteed even when another agent's worker is mid-flight: one broken
 * agent fails the run.
 */
async function escalateInstantFailLoop(
  job: CronJobInfo,
  context: Record<string, unknown>,
  consecutive: number,
  commandPreview?: string,
): Promise<void> {
  const reason = formatInstantFailReason(consecutive, commandPreview ?? job.agentId);
  logger.error("Escalating instant-fail loop — force-failing run", {
    ...context,
    consecutiveInstantFails: consecutive,
    reason,
  });

  // Alert event FIRST, before the terminal force-fail event, so consumers
  // see the loop diagnosis before the run goes terminal.
  try {
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.instant_fail_loop",
      runId: job.runId,
      workflowId: job.workflowId,
      consecutiveInstantFails: consecutive,
      detail: reason,
      reason,
    });
  } catch (err) {
    logger.warn("Failed to emit run.instant_fail_loop event", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { forceFailRun } = await import("./status.js");
    const result = await forceFailRun(job.runId, reason, true);
    if (!result.ok) {
      logger.warn("Instant-fail escalation force-fail refused", {
        ...context,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger.error("Instant-fail escalation force-fail failed", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * OUTAGE-ROUNDS (SCLS US-004): detect a pre-claim death round and increment
 * the step's durable counter.
 *
 * A pre-claim death is the slow complement of an instant fail: the harness
 * PASSED the launch-time harness probe (work rounds only spawn after the
 * probe passed — or the probe was explicitly disabled — so no separate probe
 * gate is needed here), then ran at least the instant-fail wall threshold and
 * exited nonzero or died by signal WITHOUT claiming a pending step.
 *
 * Detection is TIMING AND CLAIM STATE ONLY — exit code, signal, resolved
 * harness wall time, operator-pause/timeout/orphan-recovery exclusions, and
 * whether an unclaimed pending step exists. It NEVER parses provider-error
 * taxonomy out of stdout/stderr, so the behavior is identical for pi, hermes
 * and dsh.
 *
 * The counter increment is strictly additive: no retry_count change and no
 * step status transition — a pre-claim death consumes no retry budget (the
 * US-005 backoff/cap uses its own counter). Any successful claim resets the
 * persisted counter (see the claimStep UPDATEs in step-ops.ts). Every
 * non-matching round resets the in-memory streak, so only CONSECUTIVE
 * pre-claim deaths accumulate.
 *
 * At the backoff threshold K the next relaunch is delayed by an escalating
 * amount (see {@link instantFailBackoffDelayMs}); at the escalation threshold
 * N the run is force-failed through the sanctioned forceFailRun path with a
 * precise reason, preceded by exactly one distinct `run.preclaim_death_loop`
 * alert event (emitted AFTER the N-th `step.preclaim_round_died` record so the
 * alert immediately precedes the terminal event).
 */
async function trackPreclaimDeathRound(
  job: CronJobInfo,
  context: Record<string, unknown>,
  signals: {
    wallMs?: number;
    harnessWallMs?: number;
    vmSetupMs?: number;
    result?: HarnessRoundResult;
    recoveredOrphans?: boolean;
    operatorPaused?: boolean;
  },
): Promise<void> {
  let pending: PendingStepRef | null = null;
  try {
    const { findPendingStepForAgent } = await import("./step-ops.js");
    pending = findPendingStepForAgent(job.agentId, job.runId);
  } catch (err) {
    logger.warn("Pre-claim death pending-step lookup failed", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const isPreclaimDeath = isPreclaimDeathRound({
    wallMs: signals.wallMs,
    harnessWallMs: signals.harnessWallMs,
    timedOut: signals.result?.timedOut,
    operatorPaused: signals.operatorPaused,
    recoveredOrphans: signals.recoveredOrphans,
    hasPendingStep: pending !== null,
    exitCode: signals.result?.exitCode,
    signal: signals.result?.signal,
  });

  if (!isPreclaimDeath || pending === null) {
    // Any other round (fast instant fail, clean exit, claimed-then-died,
    // timed out, operator-paused, no pending step) breaks the streak.
    if (preclaimDeathStreaks.has(job.id)) preclaimDeathStreaks.delete(job.id);
    return;
  }

  const previous = preclaimDeathStreaks.get(job.id);
  const consecutive = (previous?.consecutive ?? 0) + 1;
  preclaimDeathStreaks.set(job.id, { consecutive, nextAllowedDispatchAt: 0 });

  // Persist the additive per-step counter (surfaced by workflow status).
  let preclaimDeathCount: number | null = null;
  try {
    const { incrementPreclaimDeathCount } = await import("./step-ops.js");
    preclaimDeathCount = incrementPreclaimDeathCount(pending.id);
  } catch (err) {
    logger.warn("Failed to increment steps.preclaim_death_count", {
      ...context,
      stepId: pending.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const resolvedHarnessWallMs = resolveHarnessWallMs({
    harnessWallMs: signals.harnessWallMs,
    roundWallMs: signals.wallMs,
  });
  const stderrTail = sanitizeStderrTail(signals.result?.stderrTail ?? "");

  logger.warn("Worker round died before claiming a step (pre-claim death)", {
    ...context,
    consecutivePreclaimDeaths: consecutive,
    stepId: pending.stepId,
    stepRowId: pending.id,
    preclaimDeathCount,
    // wallMs is the whole-round wall time; harnessWallMs is the harness
    // process time the predicate classified on; vmSetupMs is the separate
    // VM setup time (0 native, null when the runner reported none).
    wallMs: signals.wallMs,
    harnessWallMs: resolvedHarnessWallMs,
    vmSetupMs: signals.vmSetupMs ?? null,
    exitCode: signals.result?.exitCode ?? null,
    signal: signals.result?.signal ?? null,
  });

  try {
    emitEvent({
      ts: new Date().toISOString(),
      event: "step.preclaim_round_died",
      runId: job.runId,
      workflowId: job.workflowId,
      stepId: pending.stepId,
      stepRowId: pending.id,
      agentId: job.agentId,
      exitCode: signals.result?.exitCode ?? undefined,
      signal: signals.result?.signal ?? undefined,
      harnessWallMs: resolvedHarnessWallMs,
      vmSetupMs: signals.vmSetupMs,
      wallMs: signals.wallMs,
      stderrTail,
      consecutivePreclaimDeaths: consecutive,
    });
  } catch (err) {
    logger.warn("Failed to emit step.preclaim_round_died event", {
      ...context,
      stepId: pending.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Escalating backoff (K) and run cap (N) ──────────────────────
  // The pre-claim death streak uses the SAME K/N policy as instant fails
  // (shared getters + shared delay curve), with its own monotonic deadline
  // and its own distinct alert/reason so operators can tell the slow
  // claim-less death loop apart from the fast one.
  const k = getInstantFailBackoffThreshold();
  const n = getInstantFailEscalationThreshold();

  if (consecutive >= n) {
    await escalatePreclaimDeathLoop(job, context, consecutive, signals.result?.commandPreview);
    return;
  }

  if (consecutive >= k) {
    const delayMs = instantFailBackoffDelayMs(consecutive);
    // TIME-CLOCKS rule 1: the backoff window is an in-process deadline, so
    // it is armed and gated on the monotonic clock — a wall-clock jump
    // (NTP step, suspend/resume) can neither release the gate early nor
    // extend the backoff.
    const nextAllowedDispatchAt = armPreclaimDeathBackoff(job.id, consecutive, delayMs);
    logger.warn("Pre-claim death loop detected — backing off relaunch", {
      ...context,
      consecutivePreclaimDeaths: consecutive,
      backoffDelayMs: delayMs,
      nextAllowedDispatchAt,
    });
  }
}

/**
 * Escalate a pre-claim death loop at the N-round threshold: emit the
 * distinct `run.preclaim_death_loop` alert event, then force-fail the run
 * through the existing forceFailRun path with the pre-claim reason. This
 * mirrors {@link escalateInstantFailLoop} exactly — alert FIRST, then the
 * sanctioned terminal path — and charges NO retry budget (pre-claim deaths
 * are not step failures). force=true guarantees escalation even when another
 * agent's worker is mid-flight: one broken agent fails the run.
 */
async function escalatePreclaimDeathLoop(
  job: CronJobInfo,
  context: Record<string, unknown>,
  consecutive: number,
  commandPreview?: string,
): Promise<void> {
  const reason = formatPreclaimDeathReason(consecutive, commandPreview ?? job.agentId);
  logger.error("Escalating pre-claim death loop — force-failing run", {
    ...context,
    consecutivePreclaimDeaths: consecutive,
    reason,
  });

  // Alert event FIRST, before the terminal force-fail event, so consumers
  // see the loop diagnosis before the run goes terminal.
  try {
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.preclaim_death_loop",
      runId: job.runId,
      workflowId: job.workflowId,
      consecutivePreclaimDeaths: consecutive,
      detail: reason,
      reason,
    });
  } catch (err) {
    logger.warn("Failed to emit run.preclaim_death_loop event", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { forceFailRun } = await import("./status.js");
    const result = await forceFailRun(job.runId, reason, true);
    if (!result.ok) {
      logger.warn("Pre-claim death escalation force-fail refused", {
        ...context,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger.error("Pre-claim death escalation force-fail failed", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One dispatch round for a (runId, agentId) job:
 *
 *   1. backoff gate (pre-claim-death then instant-fail): skip the tick while
 *      either backoff window is open — evaluated BEFORE the in-flight mark so
 *      a gated tick leaks nothing; see the gate comment for the race-safety
 *      argument
 *   2. in-flight guard (one round per job at a time)
 *   3. run-status check (terminal → graceful teardown; paused/draining → skip)
 *   4. stale-claim sweep (recover steps whose worker silently died)
 *   5. deterministic peek — `peekStep` IN-PROCESS. No spawn, no model, no
 *      tokens when idle. This is the entire point of the dispatch motor.
 *   6. work spawn — only on HAS_WORK: pi/hermes/dsh runs the work prompt
 *      (claim → execute → report)
 *   7. post-round processing — token attribution to the run, STATUS
 *      classification, auto-complete fallback, orphaned-step recovery
 *   8. instant-fail + pre-claim-death classification — streak/backoff/
 *      escalation (RSPN + OUTAGE-ROUNDS SCLS)
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

  // Capture the scheduler epoch BEFORE any await. If shutdownAllCrons()
  // runs while this round is in flight, schedulerGeneration will have
  // moved on by the time our teardown removeRunCrons calls resolve; we
  // pass this captured value so a stale round cannot re-populate
  // pendingSweepTimers after teardown.
  const roundGeneration = schedulerGeneration;

  if (!workingDirectoryForHarness) {
    logger.error("Dispatch round refused — missing harness workdir", {
      ...context,
      reason: "missing_working_directory_for_harness",
    });
    await removeRunCrons(job.runId, { schedulerGeneration: roundGeneration });
    return;
  }

  // ── Instant-fail / pre-claim-death backoff gate (RSPN + SCLS) ───
  // After K consecutive instant-fail (or pre-claim death) rounds the motor
  // backs off the broken harness's relaunch: subsequent ticks are skipped
  // until nextAllowedDispatchAt passes, instead of respawning every 15s
  // forever. Idle peeks are never delayed by this — a streak is only
  // recorded for rounds that actually spawned a harness and failed.
  //
  // The gate runs BEFORE the in-flight mark on purpose: it reads only the
  // synchronous streak maps and awaits nothing, so the race-safety invariant
  // below (the mark must happen synchronously before any awaited async work)
  // still holds. Marking first would leak the mark on this early return —
  // the round try's `finally` (the only place the mark is released) never
  // runs for a gated tick, so every later tick would be skipped as
  // previous_round_in_flight: no relaunch after the window elapses, N
  // unreachable, run idle with a pending step (IFLB-mid regression).
  //
  // TIME-CLOCKS rule 1: both `nextAllowedDispatchAt` values are monotonic
  // deadlines, so the gate and its remaining-time readout must use
  // `monotonicNow()` — comparing them to `Date.now()` would mix clocks and
  // let a wall jump release the backoff (or report a nonsensical remaining
  // time).
  const nowMonotonic = monotonicNow();
  // Pre-claim-death gate first so a slow claim-less death loop reports its own
  // skip reason; otherwise fall through to the fast instant-fail gate.
  const preclaimBackoff = preclaimDeathStreaks.get(job.id);
  if (preclaimBackoff && isPreclaimDeathBackoffActive(preclaimBackoff, nowMonotonic)) {
    logger.debug("Dispatch round skipped — preclaim-death backoff", {
      ...context,
      reason: "preclaim_death_backoff",
      consecutivePreclaimDeaths: preclaimBackoff.consecutive,
      backoffUntilMs: preclaimBackoff.nextAllowedDispatchAt,
      backoffRemainingMs: preclaimBackoff.nextAllowedDispatchAt - nowMonotonic,
    });
    return;
  }
  const backoff = instantFailStreaks.get(job.id);
  if (backoff && isInstantFailBackoffActive(backoff, nowMonotonic)) {
    logger.debug("Dispatch round skipped — instant-fail backoff", {
      ...context,
      reason: "instant_fail_backoff",
      consecutiveInstantFails: backoff.consecutive,
      backoffUntilMs: backoff.nextAllowedDispatchAt,
      backoffRemainingMs: backoff.nextAllowedDispatchAt - nowMonotonic,
    });
    return;
  }

  // ── Race-safe in-flight guard ───────────────────────────────────
  // Must happen synchronously *before* any awaited async work so
  // concurrent nudge + timer tick invocations cannot launch duplicate
  // harness processes. Between this mark and the round `try` below there
  // is intentionally NO early return (and no await): the only pre-try
  // exit after marking is via the `try`'s own `finally`.
  if (!tryMarkJobInFlight(job.id)) {
    logger.debug("Dispatch round skipped — previous round still in flight", {
      ...context,
      reason: "previous_round_in_flight",
    });
    return;
  }

  // ── Round completion signal (TATR US-005) ───────────────────────
  // Registered synchronously after the in-flight guard, BEFORE the first
  // await, so a concurrent settleRunInFlightRounds (the cancel path) can
  // observe this in-flight round and wait for its post-round token
  // attribution. Resolved in the `finally` below, after attribution and
  // recovery have completed.
  let resolveRoundCompletion: () => void = () => {};
  const roundCompletionDone = new Promise<void>((resolve) => {
    resolveRoundCompletion = resolve;
  });
  roundCompletionSignals.set(job.id, {
    runId: job.runId,
    done: roundCompletionDone,
    resolve: resolveRoundCompletion,
  });

  // No-hurry runs prefer a <harness>-token-saver wrapper when installed on PATH;
  // resolved from run context alongside the status check below.
  let preferTokenSaver = false;

  // Determine harness type outside the try block so catch handlers can
  // access it for error-path token attribution.
  const harnessType = job.harnessType ?? "pi";

  // Declared outside try so catch/post-round handlers can access exit diagnostics
  let result: HarnessRoundResult | undefined;
  // Round-start stopwatch for instant-fail classification (RSPN). The
  // adapters now report their own durationMs on resolved rounds; this
  // capture covers the adapter-throw path (deleted/broken harness binary
  // — findBinary/spawn failure), where no result ever exists to carry a
  // duration. Created in the work-spawn section BEFORE binary resolution so
  // the throw path can still be classified. TIME-CLOCKS rule 1: it is a
  // Stopwatch over the MONOTONIC clock — a wall-clock jump during the round
  // must not shrink or inflate the measured duration (which would flip the
  // instant-fail classification).
  let roundStartWatch: Stopwatch | undefined;
  // Set when this round's orphan recovery actually recovered a claimed
  // step (the worker claimed and died). Such rounds are worker_lost, not
  // instant-fail (RSPN) — the classifier must never count them toward the
  // instant-fail streak.
  let roundRecoveredOrphans = false;
  // PKIL (US-005): set when a non-drain operator pause marked this round
  // before tearing it down. Read (and cleared) once the round settles, then
  // threaded into the recovery paths so their abandonReason is
  // 'paused_by_operator' (no retry charge) instead of 'worker_lost'.
  let operatorPaused = false;
  // Round-start timestamp captured for dsh token accounting. dsh never
  // prints usage; tokens are read from $DSH_HOME session files keyed on
  // the workdir + a "created since this time" scan. Captured BEFORE
  // binary resolution so the error path (e.g. a dispatch-time resolution
  // failure) can still attempt the best-effort session lookup.
  let dshRoundStartedAtMs: number | undefined;
  // Captured from the run-status DB query so the traceability header can
  // include run_number without a second DB trip.
  let runNumber: number | undefined;

  // KHYG US-002: this round's explicit launch-cancellation signal. The
  // teardown/cancel paths abort it (abortDispatchRound) when they kill the
  // in-flight child; the launch boundary vetoes release/fallback once
  // aborted. Registered for the whole round (probe + work) and cleared in
  // the round's finally below — survives inFlightChildren map clearing.
  const roundAbort = new AbortController();
  roundAbortControllers.set(job.id, roundAbort);

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
          schedulerGeneration: roundGeneration,
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

    // ── Conditional auto-complete sweep (WAVE-A US-003) ────────────
    // A pending `type: conditional` step whose activation flag is UNSET in
    // run context is completed IN-PROCESS with zero tokens — no harness
    // spawn, same free path as the idle peek. Loop (bounded) so a round
    // that only auto-completes never spawns a harness: after each
    // auto-complete the pipeline may have advanced to another conditional
    // step or to a real dispatchable step, so we re-peek and re-attempt.
    // The loop exits when a step must dispatch (flag SET — fail-closed:
    // never auto-complete a set condition) or no conditional step remains,
    // falling through to the normal harness spawn below.
    try {
      const { autoCompleteConditionalStep, peekStep } = await import("./step-ops.js");
      for (let i = 0; i < MAX_CONDITIONAL_AUTO_COMPLETES_PER_ROUND; i++) {
        const outcome = autoCompleteConditionalStep(job.runId, job.agentId);
        if (outcome === "auto_completed") {
          logger.info("Conditional step auto-completed (zero tokens)", {
            ...context,
            reason: "condition_unset",
          });
          if (peekStep(job.agentId, job.runId) === "NO_WORK") {
            logger.debug("Dispatch round idle after conditional auto-complete — no remaining pending step", {
              ...context,
              reason: "no_pending_step_after_auto_complete",
            });
            return;
          }
        } else {
          // 'dispatched' (conditional step pending with flag SET) or 'none'
          // (no pending conditional step) — proceed to the harness spawn.
          break;
        }
      }
    } catch (err) {
      logger.warn("Conditional auto-complete sweep failed; falling through to normal dispatch", {
        ...context,
        error: String(err),
      });
    }

    // ── Launch-time harness probe gate (IFLB US-003) ───────────────
    // At a run's FIRST real dispatch (after the peek confirmed HAS_WORK and
    // any zero-token auto-completes, BEFORE any step is claimed), the run's
    // harness is asked to run the exact command `<launcher> skill-path` and
    // reply with the PATH — a real tool call that fails fast when the
    // harness cannot work at all (pi with invalidated credentials, dsh boot
    // failure under a contained daemon). Without it, a launch-broken
    // harness used to strand the run in consecutive instant-fail backoff
    // rounds (RSPN) that never escalated. Exactly ONE probe runs per run: the DB
    // reserve below is atomic across the run's dispatch jobs and a recorded
    // 'ok'/'failed' row survives a daemon restart, so a passed run is never
    // re-probed. The probe round is NOT a work round: it never claims a
    // step and is never classified by the instant-fail (RSPN) tracker nor
    // ticks worker_lost/ceiling_expiry counters (trackInstantFailRound is
    // not called for it).
    if (isHarnessProbeEnabled()) {
      const probeWallMs = getHarnessProbeWallMs();
      const probeStatus = readHarnessProbeStatus(job.runId);
      if (probeStatus === "ok") {
        // Already probed (daemon-restart safe) — proceed to the work spawn.
        logger.debug("Dispatch round proceeds — run already harness-probed", {
          ...context,
          reason: "harness_probe_ok",
        });
      } else if (probeStatus === "failed") {
        // A probe round recorded a definitive failure; the winning round
        // force-failed the run right after. If a crash or force-fail hiccup
        // left the run alive, re-surface the durable keyline block and
        // force-fail now (otherwise the run-status check tears the job down
        // on the next tick).
        logger.warn("Dispatch round skipped — run harness probe previously failed", {
          ...context,
          reason: "harness_probe_failed",
        });
        const durableReason = readLastHarnessProbeFailureBlock(job.runId)
          ?? "Launch-time harness probe failed (see run.harness_probe_failed event)";
        try {
          const { forceFailRun } = await import("./status.js");
          const forceResult = await forceFailRun(job.runId, durableReason, true);
          if (!forceResult.ok) {
            logger.warn("Harness-probe re-force-fail refused", {
              ...context,
              reason: forceResult.reason,
            });
          }
        } catch (err) {
          // Run already terminal — the normal run_not_running path handles
          // the teardown; nothing else to do here.
          logger.debug("Harness-probe re-force-fail skipped (run terminal)", {
            ...context,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      } else {
        // NULL (never probed) or 'probing' (an in-flight reservation that
        // may be stale after a daemon crash mid-probe). Attempt the atomic
        // once-per-run reservation — exactly one caller wins; losers and
        // rounds that see a fresh in-flight probe defer to the next tick.
        if (!reserveHarnessProbe(job.runId, { wallMs: probeWallMs })) {
          logger.debug("Dispatch round deferred — harness probe in flight for the run", {
            ...context,
            reason: "harness_probe_in_flight",
          });
          return;
        }

        const probeOutcome = await runLaunchTimeHarnessProbe({
          job,
          context,
          workdir: workingDirectoryForHarness,
          preferTokenSaver,
          wallMs: probeWallMs,
          signal: roundAbort.signal,
          onSpawn: ({ pid, pgid }: { pid: number; pgid: number }) => {
            inFlightChildren.set(job.id, { pid, pgid, killed: false });
          },
        });

        if (!probeOutcome.passed) {
          // ── Probe failure: fail the run fast and legibly ────────
          recordHarnessProbeResult(job.runId, "failed");
          emitEvent({
            ts: new Date().toISOString(),
            event: "run.harness_probe_failed",
            runId: job.runId,
            workflowId: job.workflowId,
            detail: probeOutcome.failureBlock,
            reason: probeOutcome.failureBlock,
            harness: probeOutcome.harness,
            probeCmd: probeOutcome.probeCmd,
            expected: probeOutcome.expected,
            observed: probeOutcome.observed,
            exitCode: probeOutcome.exitCode ?? undefined,
            signal: probeOutcome.signal ?? undefined,
            durationMs: probeOutcome.durationMs,
            stderrTail: probeOutcome.stderrTail,
          });
          logger.error("Launch-time harness probe failed — force-failing run", {
            ...context,
            reason: probeOutcome.failureBlock,
            durationMs: probeOutcome.durationMs,
          });
          try {
            const { forceFailRun } = await import("./status.js");
            const forceResult = await forceFailRun(job.runId, probeOutcome.failureBlock, true);
            if (!forceResult.ok) {
              logger.warn("Harness-probe force-fail refused", {
                ...context,
                reason: forceResult.reason,
              });
            }
          } catch (err) {
            logger.error("Harness-probe force-fail failed", {
              ...context,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // Return WITHOUT spawning the work round: no step is claimed or
          // started. Other dispatch jobs tear down on their next round via
          // the existing run_not_running path.
          return;
        }

        // ── Probe success: record once, then dispatch normally ────
        recordHarnessProbeResult(job.runId, "ok");
        emitEvent({
          ts: new Date().toISOString(),
          event: "run.harness_probe_ok",
          runId: job.runId,
          workflowId: job.workflowId,
          harness: probeOutcome.harness,
          durationMs: probeOutcome.durationMs,
          tokens: probeOutcome.tokens,
        });
        logger.info("Launch-time harness probe passed", {
          ...context,
          harness: probeOutcome.harness,
          durationMs: probeOutcome.durationMs,
          probeTokens: probeOutcome.tokens,
        });
        // Fall through — this round continues as the run's first real work
        // round, dispatching normally below.
      }
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
    if (harnessType === "dsh") {
      // TIME-CLOCKS allow-list (rule 3): dsh session attribution compares
      // this round-start stamp against OS file mtimes ($DSH_HOME session
      // files), so it stays an epoch-ms instant and MUST NOT be switched to
      // monotonic time. US-010 routes that comparison through the shared
      // instant helpers/tolerance (dsh-usage's `createdSinceSpawn` /
      // `instantAgeMs` with `DSH_SESSION_MTIME_TOLERANCE_MS`).
      dshRoundStartedAtMs = Date.now();
    }
    // Round-start stopwatch for instant-fail classification (RSPN). The
    // adapters now report their own durationMs on resolved rounds; this
    // capture covers the adapter-throw path (deleted/broken harness binary
    // — findBinary/spawn failure), where no result ever exists to carry a
    // duration. Created BEFORE binary resolution (see roundElapsedMs).
    roundStartWatch = new Stopwatch();
    // Pre-resolve the binary path. For hermes and dsh, this goes through
    // the same shared resolvers that admission validation uses,
    // guaranteeing single-source dispatch — no disagreement between
    // validation and invocation. The resolved path is passed in
    // options.binaryPath so runRound skips its own redundant findBinary()
    // call.
    const binaryPath = await adapter.findBinary({ preferTokenSaver });
    const harnessEnv = buildHarnessChildEnv(job, binaryPath);
    result = await adapter.runRound(workPrompt, {
      timeout,
      workdir: workingDirectoryForHarness,
      env: harnessEnv,
      onSpawn,
      preferTokenSaver,
      binaryPath,
      // KHYG US-002: run/execution identity for the per-launch
      // isolation-mode records (run.harness_isolation), and this round's
      // explicit cancellation signal (aborted on teardown/cancel).
      execution: {
        runId: job.runId,
        agentId: job.agentId,
        workflowId: job.workflowId,
        roundId: job.id,
      },
      signal: roundAbort.signal,
    });
    output = result.output;

    // ── Post-round processing ──────────────────────────────────────
    const metadata = parseWorkRoundMetadata(output);
    // PRAW requirement 1/2: classify the assistant's OWN text only. Text-mode
    // rounds already carry their normalized text in `assistantOutput`; a JSON
    // round with no assistant text is empty_output and must NOT fall back to
    // the raw JSONL transcript (tool payloads can contain a literal STATUS).
    const outputSummary = summarizeWorkRoundOutput(metadata.assistantOutput);

    // PKIL (US-005): the round has settled. Read (and clear) the operator-pause
    // mark so the recovery branches below classify this exit as
    // paused_by_operator rather than worker_lost. A SIGTERM (exit 143) or a
    // clean exit after the pause both land here.
    operatorPaused = consumeOperatorPausedRound(job.id);

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

    // Guard: pi is the ONLY harness whose stdout carries token usage
    // (--mode json message_end metadata). hermes and dsh stdout carry
    // none by contract — any usage parsed from them is contamination
    // (e.g. an agent echoing pi-style JSON) that would double count on
    // top of the real state.db / session-file attribution. This also
    // stops the misleading "--mode json may be off" warning for
    // hermes/dsh rounds.
    if (harnessType === "pi") {
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

    // ── dsh token lookup ─────────────────────────────────────────
    // dsh prints no session id and no usage — usage lives in the session
    // file under $DSH_HOME/sessions/<escaped-workdir>/session-<uuid>/.
    // The lookup scans session dirs created since the round-start
    // timestamp and reads the newest (this includes timed-out rounds,
    // which resolve through the normal post-round path). Best-effort:
    // an unavailable lookup falls back to 0 tokens with a warning —
    // never an error, never blocks the round.
    if (harnessType === "dsh" && dshRoundStartedAtMs !== undefined && workingDirectoryForHarness) {
      const dshUsage = await lookupDshSessionTokens({
        spawnedAtMs: dshRoundStartedAtMs,
        workdir: workingDirectoryForHarness,
      });
      if (dshUsage !== null && dshUsage.totalTokens > 0) {
        const dshMetadata: WorkRoundMetadata = {
          assistantOutput: output,
          tokenUsage: dshUsage.totalTokens,
          runId: null,
          stepId: null,
          jsonMetadataDetected: false,
        };
        await attributeWorkRoundTokenUsage(context, job, outputSummary, dshMetadata);
        logger.info("dsh token attribution from session file", {
          ...context,
          sessionRef: dshUsage.sessionRef,
          tokenDelta: dshUsage.totalTokens,
        });
      } else {
        // Zero-token fallback: warn (with round context) so operators can
        // see WHY the run reads 0 tokens — never an error, never a retry.
        logger.warn("dsh session token lookup unavailable — tokens will read 0", {
          ...context,
          reason: "no_session_since_round_start_or_unreadable",
        });
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
          operatorPaused ? "paused_by_operator" : "worker_lost",
          undefined, // detailPrefix
          result?.exitCode,
          result?.signal,
          result?.stderrTail,
          result?.timedOut,
        );
        if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
          logger.info("Orphaned step recovery after clean harness exit without STATUS", {
            ...context,
            outcome: outputSummary.outcome,
            recovered: recoveryResult.recovered,
            failed: recoveryResult.failed,
            skipped: recoveryResult.skipped,
            timedOut: result?.timedOut,
          });
        }
        if (recoveryResult.recovered > 0) roundRecoveredOrphans = true;
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
        if (recoveryResult.recovered > 0) roundRecoveredOrphans = true;
      } catch (recoveryErr) {
        logger.error("Immediate claim release after no_work round failed", {
          ...context,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
      }
    }

    // ── Instant-fail classification (RSPN) ────────────────────────
    // Runs AFTER the normal post-round processing (token attribution,
    // orphan recovery) so a genuinely claimed-but-died worker still goes
    // through the existing worker_lost recovery path unchanged. An
    // instant-fail round — harness exited nonzero with zero output below
    // the wall threshold before claiming any step — increments the
    // per-job streak, applies escalating backoff at K consecutive rounds,
    // and force-fails the run at N (with a distinct alert event). The
    // adapter's durationMs is the round's wall time; the monotonic
    // roundStartWatch fallback covers rounds where the adapter never
    // returned one.
    await trackInstantFailRound(job, context, {
      wallMs: result?.durationMs ?? roundElapsedMs(roundStartWatch),
      harnessWallMs: result?.harnessWallMs,
      vmSetupMs: result?.vmSetupMs,
      result,
      recoveredOrphans: roundRecoveredOrphans,
    });
    // OUTAGE-ROUNDS (SCLS US-004): a long nonzero-exit/signal round that
    // never claimed a pending step is a pre-claim death. Detection is timing
    // + claim state only (never provider-error text).
    await trackPreclaimDeathRound(job, context, {
      wallMs: result?.durationMs ?? roundElapsedMs(roundStartWatch),
      harnessWallMs: result?.harnessWallMs,
      vmSetupMs: result?.vmSetupMs,
      result,
      recoveredOrphans: roundRecoveredOrphans,
      operatorPaused,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = buildBoundedPreview(errorMessage, MAX_WORK_ERROR_PREVIEW);

    // PKIL (US-005): the adapter threw (e.g. the cancellation signal aborted
    // the launch, or the SIGTERM'd process rejected). Read (and clear) the
    // operator-pause mark so the recovery below classifies this as a pause
    // (step.paused_kill, no retry charge) rather than a worker loss. Keep a
    // mark the clean path already consumed before a later post-round throw —
    // re-consuming would erase the pause classification.
    if (!operatorPaused) {
      operatorPaused = consumeOperatorPausedRound(job.id);
    }

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
        operatorPaused ? "paused_by_operator" : "worker_lost",
        undefined, // detailPrefix
        result?.exitCode,
        result?.signal,
        result?.stderrTail,
        result?.timedOut,
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
      if (recoveryResult.recovered > 0) roundRecoveredOrphans = true;

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

      // ── dsh token lookup on round failure ──────────────────────
      // When a dsh round fails before it ever resolved (dispatch-time
      // binary-resolution failure, spawn rejection), a session may still
      // exist for the workdir. Scan by the captured round-start timestamp
      // and attribute when a session is found — the same best-effort
      // lookup as the success path (null → 0 tokens with a warning, never
      // an error, never blocks the failure handling). `result ===
      // undefined` keeps this complementary to the success path: a round
      // that DID resolve already ran its lookup there, so re-running it
      // here on a later post-round throw would double count.
      if (
        harnessType === "dsh" &&
        result === undefined &&
        dshRoundStartedAtMs !== undefined &&
        workingDirectoryForHarness
      ) {
        const dshUsage = await lookupDshSessionTokens({
          spawnedAtMs: dshRoundStartedAtMs,
          workdir: workingDirectoryForHarness,
        });
        if (dshUsage !== null && dshUsage.totalTokens > 0) {
          const dshMetadata: WorkRoundMetadata = {
            assistantOutput: "",
            tokenUsage: dshUsage.totalTokens,
            runId: null,
            stepId: null,
            jsonMetadataDetected: false,
          };
          const outputSummary = summarizeWorkRoundOutput("");
          await attributeWorkRoundTokenUsage(context, job, outputSummary, dshMetadata);
          logger.info("dsh token attribution from error-path session lookup", {
            ...context,
            sessionRef: dshUsage.sessionRef,
            tokenDelta: dshUsage.totalTokens,
          });
        }
      }

      // ── Instant-fail classification on adapter throw (RSPN) ──
      // The harness never resolved (deleted/broken binary — spawn
      // ENOENT, dispatch-time resolution failure): zero output by
      // construction and no clean exit, so when it happened within the
      // wall threshold it is classified the same way as a resolved
      // zero-output exit-1 round. The recovery above already ran the
      // existing worker_lost path (which recovers nothing for unclaimed
      // steps); this adds the streak/backoff/escalation handling.
      await trackInstantFailRound(job, context, {
        wallMs: roundElapsedMs(roundStartWatch),
        // No resolved HarnessRoundResult on an adapter throw, so there is no
        // harness-wall-time signal: the predicate falls back to the monotonic
        // round elapsed time (native semantics — the launch attempt IS the
        // whole round).
        harnessWallMs: undefined,
        vmSetupMs: undefined,
        adapterThrew: true,
        recoveredOrphans: roundRecoveredOrphans,
      });
      // OUTAGE-ROUNDS (SCLS US-004): an adapter throw has no exit code and no
      // signal, so it can never be a pre-claim death; the call still runs so
      // any prior streak is reset (a launch failure breaks consecutiveness).
      await trackPreclaimDeathRound(job, context, {
        wallMs: roundElapsedMs(roundStartWatch),
        harnessWallMs: undefined,
        vmSetupMs: undefined,
        result: undefined,
        recoveredOrphans: roundRecoveredOrphans,
        operatorPaused,
      });
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery failed", {
        ...context,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  } finally {
    inFlightJobs.delete(job.id);
    inFlightChildren.delete(job.id);
    // PKIL (US-005): drop any operator-pause mark for this round. The normal
    // paths consume it before recovery; this unconditional clear covers early
    // returns (idle peek, probe failure) so a stale mark can never leak into
    // a later round that reuses the deterministic job id.
    operatorPausedRounds.delete(job.id);
    // KHYG US-002: the round's launch-cancellation signal lives for the
    // whole round (teardown may abort it while inFlightChildren is being
    // cleared); drop it only once the round itself is finished. The delete
    // is identity-safe: after a pause/resume a replacement round may have
    // registered a NEW controller under the same job id, and this old
    // round's finally must not erase the replacement's cancellation
    // controller. A map-entry identity check is sufficient.
    if (roundAbortControllers.get(job.id) === roundAbort) {
      roundAbortControllers.delete(job.id);
    }
    // Resolve the round's completion signal AFTER the map entry is gone:
    // settleRunInFlightRounds wakes on `done`, then recomputes what is
    // still in flight and must not find this round anymore.
    const signal = roundCompletionSignals.get(job.id);
    if (signal) {
      roundCompletionSignals.delete(job.id);
      signal.resolve();
    }
  }
}

// ── Launch-time harness probe helpers (IFLB US-003) ─────────────────

/**
 * Build the child environment for one harness invocation of a dispatch job:
 * the standard worker identity vars (job id / daemon pid / run id), the
 * run's resolved git commit identity (GIT_AUTHOR_NAME/EMAIL and
 * GIT_COMMITTER_NAME/EMAIL, GIDN US-003), the per-harness binary env
 * override, and a PATH that prepends the resolved binary's directory so
 * nested pi/hermes/dsh invocations inside the agent session resolve to the
 * same binary even when the daemon's own PATH lacks it. Shared by the work
 * round and the launch-time harness probe round so the probe exercises the
 * exact environment a real work round receives.
 *
 * CPID2: `TAMANDUA_DAEMON_PID` carries the SCHEDULING DAEMON's pid (used by
 * the daemonctl self-stop guard). The WORKER pid is deliberately NOT set
 * here — the harness launch wrapper exports its own `$$` into
 * `TAMANDUA_WORKER_PID`, so `step claim` records the actual harness process
 * (pid === pgid for the detached group leader) rather than the daemon pid.
 *
 * The four identity variables are set AFTER the TAMANDUA_* vars so they
 * override any GIT_AUTHOR / GIT_COMMITTER values inherited from the daemon
 * process env (the adapter merges this object over `process.env`). When the
 * job carries no resolved identity, the variables are left unset rather than
 * fabricated.
 *
 * ── Matchlock guest env projection contract ──────────────────────────────
 * A Matchlock-backed (in-VM) round receives this same environment, but only
 * the projected variables cross the guest boundary: the guest env projection
 * MUST forward exactly GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME,
 * and GIT_COMMITTER_EMAIL, and MUST NEVER mount or copy a gitconfig into the
 * guest. Mounting a gitconfig would reintroduce a second, divergent identity
 * source inside the VM.
 */
function buildHarnessChildEnv(job: CronJobInfo, binaryPath: string): Record<string, string> {
  const harnessType = job.harnessType ?? "pi";
  const harnessEnv: Record<string, string> = {
    TAMANDUA_WORKER_JOB_ID: job.id,
    TAMANDUA_DAEMON_PID: String(process.pid),
    // Run identity for the worker subprocess: nested CLI invocations
    // (tamandua merge-branch, tamandua workflow run) read this to
    // attribute themselves to the run that spawned them (TATR facets 1
    // and 5). Mirrors the env-inheritance mechanism step claim/complete
    // already rely on.
    TAMANDUA_RUN_ID: job.runId,
  };
  // GIDN US-003: the run's resolved commit identity, so no agent commit can
  // fall back to an improvised identity or the daemon's ambient git config.
  if (job.gitIdentity) {
    Object.assign(harnessEnv, gitIdentityEnv(job.gitIdentity));
  }
  if (harnessType === "hermes") {
    harnessEnv.TAMANDUA_HERMES_BINARY = binaryPath;
  } else if (harnessType === "dsh") {
    harnessEnv.TAMANDUA_DSH_BINARY = binaryPath;
  }
  // Prepend the binary's directory to the child PATH so nested
  // hermes/pi/dsh invocations within the agent session can find the
  // same binary, even when the daemon's own PATH lacked it (e.g.
  // login-shell-discovered hermes/dsh). The original PATH is preserved
  // as a suffix so standard system tools remain reachable.
  const binaryDir = path.dirname(binaryPath);
  const currentPathDirs = (process.env.PATH ?? "").split(path.delimiter);
  if (!currentPathDirs.includes(binaryDir)) {
    harnessEnv.PATH = `${binaryDir}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  return harnessEnv;
}

/** Outcome of one launch-time harness probe round (IFLB US-003). */
interface LaunchTimeProbeOutcome {
  passed: boolean;
  /** The run's harness: pi | hermes | dsh. */
  harness: string;
  /** The exact probe command the harness was asked to run. */
  probeCmd: string;
  /** The expected path ('<launcher> skill-path' stdout); '' when it could not be computed. */
  expected: string;
  /** Wall-clock duration of the probe round in ms. */
  durationMs: number;
  /** Probe tokens attributed to the run through the per-round path (0 when none/not parseable). */
  tokens: number;
  /** Present when passed === false: the mechanical failure keyline block. */
  failureBlock: string;
  /** Present when passed === false: capped single-line observed message (≤400 chars). */
  observed: string;
  /** Present when passed === false: harness process exit code (null when killed by signal). */
  exitCode: number | null;
  /** Present when passed === false: signal that killed the harness process, if any. */
  signal: string | null;
  /** Present when passed === false: capped stderr tail (≤2000 chars). */
  stderrTail: string;
}

/**
 * Run one launch-time harness probe round through the run's OWN harness
 * (pi / hermes / dsh — whichever the run was launched with), using the
 * same adapter, working directory, child environment, in-flight child
 * tracking, token-saver preference, pre-resolved binary path, and
 * round-start/duration capture as a normal work round — the only
 * differences are the probe prompt and the probe wall budget.
 *
 * The probe NEVER throws to the caller: every failure shape (expected path
 * uncomputable, binary resolution failure, spawn failure, adapter result
 * with wrong output / non-zero exit / signal death / wall exceeded) is
 * converted into a `passed: false` outcome carrying the mechanical keyline
 * failure block, so the caller can record + force-fail without the round
 * ever being classified by the instant-fail (RSPN) tracker.
 */
async function runLaunchTimeHarnessProbe(params: {
  job: CronJobInfo;
  context: Record<string, unknown>;
  workdir: string;
  preferTokenSaver: boolean;
  wallMs: number;
  /** KHYG US-002: the round's launch-cancellation signal. */
  signal: AbortSignal;
  onSpawn: (handle: { pid: number; pgid: number }) => void;
}): Promise<LaunchTimeProbeOutcome> {
  const { job, context, workdir, preferTokenSaver, wallMs, signal, onSpawn } = params;
  const harnessType = job.harnessType ?? "pi";
  const probeCmd = buildHarnessProbeCommand();
  const prompt = buildHarnessProbePrompt();
  // TIME-CLOCKS rule 1: the probe's duration fallback is an in-process
  // interval, measured by a monotonic Stopwatch so a wall-clock jump cannot
  // produce a negative or inflated probe duration.
  const probeWatch = new Stopwatch();
  // dsh probe rounds need a round-start timestamp for the session-file
  // token scan (dsh prints no session id; usage lives in $DSH_HOME files).
  let dshProbeStartedAtMs: number | undefined;

  const fail = (fields: HarnessProbeFailureFields): LaunchTimeProbeOutcome => ({
    passed: false,
    harness: fields.harness,
    probeCmd: fields.probeCmd,
    expected: fields.expected,
    durationMs: fields.durationMs ?? Math.max(0, probeWatch.elapsedMs()),
    tokens: 0,
    failureBlock: buildHarnessProbeFailureBlock(fields),
    observed: harnessProbeObservedDisplay(fields.observed),
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    stderrTail: harnessProbeStderrTailDisplay(fields.stderrTail),
  });

  const adapter = getHarnessAdapter(harnessType);

  // Resolve the binary exactly like a work round (token-saver preference
  // honored); a resolution failure is itself a probe failure.
  let binaryPath: string;
  try {
    binaryPath = await adapter.findBinary({ preferTokenSaver });
  } catch (err) {
    return fail({
      harness: harnessType,
      probeCmd,
      expected: "",
      observed: "",
      exitCode: null,
      signal: null,
      durationMs: undefined,
      stderrTail: `harness binary resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (harnessType === "dsh") {
    // TIME-CLOCKS allow-list (rule 3): the dsh probe's session scan
    // compares this stamp against OS file mtimes, so it stays epoch ms and
    // MUST NOT be switched to monotonic time. US-010 routes that comparison
    // through the shared instant helpers (dsh-usage's `createdSinceSpawn` /
    // `instantAgeMs` with `DSH_SESSION_MTIME_TOLERANCE_MS`).
    dshProbeStartedAtMs = Date.now();
  }
  const harnessEnv = buildHarnessChildEnv(job, binaryPath);
  // The adapter merges options.env over process.env for real rounds; give
  // the daemon-side expected-value computation the SAME full child env so
  // both sides resolve the command identically.
  const fullChildEnv: Record<string, string | undefined> = {
    ...process.env,
    ...harnessEnv,
  };

  // Daemon-side expected value: run the very command the harness must run.
  // When the daemon itself cannot run it, the probe cannot pass — surface
  // the daemon-side forensics as the probe failure.
  const expectedResult = computeExpectedHarnessProbePath(fullChildEnv, workdir);
  if (!expectedResult.ok) {
    return fail({
      harness: harnessType,
      probeCmd,
      expected: "",
      observed: "",
      exitCode: expectedResult.exitCode ?? null,
      signal: expectedResult.signal ?? null,
      durationMs: undefined,
      stderrTail:
        expectedResult.stderrTail ??
        `expected path could not be computed: '<launcher> skill-path' exited ${expectedResult.exitCode ?? "with a signal"}`,
    });
  }
  const expectedPath = expectedResult.path ?? "";

  // Run the probe round through the run's own harness.
  let result: HarnessRoundResult;
  try {
    result = await adapter.runRound(prompt, {
      timeout: Math.max(1, Math.ceil(wallMs / 1000)),
      workdir,
      env: harnessEnv,
      onSpawn,
      preferTokenSaver,
      binaryPath,
      // KHYG US-002: the launch-time probe round is a harness execution
      // too — give it run/execution identity for the per-launch
      // isolation-mode records (run.harness_isolation) plus this round's
      // explicit cancellation signal.
      execution: {
        runId: job.runId,
        agentId: job.agentId,
        workflowId: job.workflowId,
        roundId: job.id,
      },
      signal,
    });
  } catch (err) {
    return fail({
      harness: harnessType,
      probeCmd,
      expected: expectedPath,
      observed: "",
      exitCode: null,
      signal: null,
      durationMs: undefined,
      stderrTail: `harness probe spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const durationMs = result.durationMs ?? Math.max(0, probeWatch.elapsedMs());

  // The observed message is the harness's final assistant message — for pi
  // (--mode json) that is the message_end assistant text, for text-only
  // harnesses the normalized whole output.
  const metadata = parseWorkRoundMetadata(result.output);
  const observedMessage =
    metadata.assistantOutput.length > 0 ? metadata.assistantOutput : result.output;

  // Attribute probe tokens through the existing per-round path so they land
  // on runs.tokens_spent exactly once (pi usage from --mode json; hermes and
  // dsh best-effort like normal rounds). Best-effort: an attribution hiccup
  // must never flip a passing probe into a failed run.
  let tokens = 0;
  try {
    const outputSummary = summarizeWorkRoundOutput(result.output);
    if (harnessType === "pi") {
      if (metadata.tokenUsage !== null && metadata.tokenUsage > 0) {
        await attributeWorkRoundTokenUsage(context, job, outputSummary, metadata);
        tokens = metadata.tokenUsage;
      }
    } else if (harnessType === "hermes" && result.sessionRef) {
      const hermesTokens = await lookupHermesSessionTokens(result.sessionRef);
      if (hermesTokens !== null && hermesTokens > 0) {
        const hermesMetadata: WorkRoundMetadata = {
          assistantOutput: result.output,
          tokenUsage: hermesTokens,
          runId: null,
          stepId: null,
          jsonMetadataDetected: false,
        };
        await attributeWorkRoundTokenUsage(context, job, outputSummary, hermesMetadata);
        tokens = hermesTokens;
      }
    } else if (harnessType === "dsh" && dshProbeStartedAtMs !== undefined) {
      const dshUsage = await lookupDshSessionTokens({
        spawnedAtMs: dshProbeStartedAtMs,
        workdir,
      });
      if (dshUsage !== null && dshUsage.totalTokens > 0) {
        const dshMetadata: WorkRoundMetadata = {
          assistantOutput: result.output,
          tokenUsage: dshUsage.totalTokens,
          runId: null,
          stepId: null,
          jsonMetadataDetected: false,
        };
        await attributeWorkRoundTokenUsage(context, job, outputSummary, dshMetadata);
        tokens = dshUsage.totalTokens;
      }
    }
  } catch (err) {
    logger.warn("Launch-time harness probe token attribution failed", {
      ...context,
      harness: harnessType,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const outcome = evaluateHarnessProbe({
    harness: harnessType,
    probeCmd,
    expectedPath,
    wallMs,
    adapter: {
      output: observedMessage,
      stderrTail: result.stderrTail,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  });

  if (outcome.passed) {
    return {
      passed: true,
      harness: harnessType,
      probeCmd,
      expected: expectedPath,
      durationMs,
      tokens,
      failureBlock: "",
      observed: "",
      exitCode: null,
      signal: null,
      stderrTail: "",
    };
  }
  return fail({ ...(outcome.failure as HarnessProbeFailureFields), durationMs });
}

/**
 * Read the last durable run.harness_probe_failed keyline block from the
 * run's per-run events file (the emitting round wrote the full block to
 * reason/detail BEFORE force-failing). Used by the defensive re-force-fail
 * path when a probe-failed run is somehow still alive (daemon crash between
 * the record and the force-fail).
 */
function readLastHarnessProbeFailureBlock(runId: string): string | undefined {
  try {
    const events = getRunEvents(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.event === "run.harness_probe_failed") {
        return evt.reason ?? evt.detail;
      }
    }
  } catch (err) {
    logger.warn("Failed to read durable harness-probe failure reason", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
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

  // Read harness_type (and the run's resolved git commit identity) from the
  // run context; default the harness to "pi" if not set.
  let harnessType: HarnessType = "pi";
  let gitIdentity: { name: string; email: string } | undefined;
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
    if (runRow) {
      const ctx = parseRunContext(runId, runRow.context);
      if (ctx.harness_type === "hermes") {
        harnessType = "hermes";
      } else if (ctx.harness_type === "dsh") {
        harnessType = "dsh";
      }
      // GIDN US-003: carry the identity resolved at launch (US-002) into
      // every round this job dispatches. readGitIdentityFromContext returns
      // null for a partial/absent record — never fabricate an identity.
      const resolved = readGitIdentityFromContext(ctx);
      if (resolved) {
        gitIdentity = { name: resolved.name, email: resolved.email };
      }
    }
  } catch {
    // If we can't read the context, default to "pi" and no identity.
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
    gitIdentity,
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
  /**
   * The scheduler epoch captured at the top of the dispatch round that
   * issued this teardown. When provided AND it no longer matches the
   * current module-level `schedulerGeneration`, the round is stale (a
   * `shutdownAllCrons()` ran while it was in flight): the trailing
   * `scheduleSweepTimer` is skipped so a late fire-and-forget round
   * cannot re-populate `pendingSweepTimers` after teardown. Absent for
   * legitimate external callers (control-plane terminate, explicit
   * tear-down), which behave exactly as before.
   */
  schedulerGeneration?: number;
  /**
   * PKIL (US-005): set by the NON-DRAIN operator `run pause` teardown. When
   * true, every in-flight dispatch round for the run is marked (PKIL
   * operator-pause registry) BEFORE it is aborted/killed, so its post-round
   * recovery classifies the exit as `paused_by_operator` — `step.paused_kill`
   * with no retry charge — rather than `worker_lost`. Draining pause,
   * terminate, cancel, and natural completion pass no flag, so their
   * worker-lost semantics are unchanged.
   */
  pausedByOperator?: boolean;
}

/**
 * Teardown-time target for a run's post-grace sweep.
 *
 * Both fields are optional. Direct-mode runs have no managed worktree row,
 * so the sweep cannot rely on `getRunWorktree`; the scheduler captures the
 * run's harness working directory and in-flight child pgids while it still
 * has them (`removeRunCrons`) and threads them through to the timer.
 */
export interface PostGraceSweepTarget {
  /** `workingDirectoryForHarness` captured from the run's dispatch jobs. */
  workingDirectory?: string;
  /** pgids captured from the run's in-flight harness children at teardown. */
  pgids?: number[];
}

/**
 * Execute the post-grace process sweep for a run.
 *
 * Direct-mode runs never get a `run_worktrees` row, so the sweep no longer
 * requires a worktree (the old "no worktree found" early return skipped
 * every direct-mode run). The sweep directory is resolved in order:
 *
 *   1. the working directory captured at teardown (`removeRunCrons`),
 *   2. the run's managed worktree path (`getRunWorktree`), when one exists,
 *   3. `working_directory_for_harness`, then `repo`, from the run's DB context.
 *
 * Owned pgids are the captured in-flight children PLUS every distinct
 * non-null `steps.claim_pgid` recorded for the run (CPID2). When neither a
 * directory nor any pgid resolves, the sweep still runs with a null path so
 * the `TAMANDUA_RUN_ID` marker channel can reap run-owned children.
 *
 * Exported so tests can invoke the sweep directly without waiting for the
 * `HARNESS_TEARDOWN_GRACE_MS + 2 s` timer.
 */
export async function runPostGraceSweep(
  runId: string,
  target: PostGraceSweepTarget = {},
): Promise<void> {
  try {
    let dir: string | null = target.workingDirectory?.trim() || null;

    if (!dir) {
      try {
        const { getRunWorktree } = await import("./worktree-manager.js");
        dir = getRunWorktree(runId)?.worktreePath ?? null;
      } catch (err) {
        logger.debug("Post-grace sweep: worktree lookup failed", {
          runId,
          error: String(err),
        });
      }
    }

    const ownedPgids = new Set<number>(target.pgids ?? []);

    // Resolve the run context (fallback directory) and the recorded claim
    // pgids from the DB. A DB failure degrades to the captured target
    // rather than aborting the sweep.
    try {
      const { getDb } = await import("../db.js");
      const db = getDb();

      if (!dir) {
        const runRow = db
          .prepare("SELECT context FROM runs WHERE id = ?")
          .get(runId) as { context: string } | undefined;
        if (runRow) {
          const ctx = parseRunContext(runId, runRow.context || "{}");
          const candidate = ctx.working_directory_for_harness || ctx.repo;
          if (typeof candidate === "string" && candidate.trim()) {
            dir = candidate.trim();
          }
        }
      }

      const rows = db
        .prepare(
          "SELECT DISTINCT claim_pgid FROM steps WHERE run_id = ? AND claim_pgid IS NOT NULL",
        )
        .all(runId) as Array<{ claim_pgid: number | bigint | null }>;
      for (const row of rows) {
        const pgid = Number(row.claim_pgid);
        if (Number.isFinite(pgid) && pgid > 0) ownedPgids.add(pgid);
      }
    } catch (err) {
      logger.debug("Post-grace sweep: DB resolution failed", { runId, error: String(err) });
    }

    if (!dir && ownedPgids.size === 0) {
      logger.debug(
        "Post-grace sweep: no directory or pgids resolved; running run-marker sweep",
        { runId },
      );
    }

    const { sweepRunProcesses } = await import("./run-cleanup.js");
    const result = sweepRunProcesses(runId, dir, {
      daemonPid: process.pid,
      // After grace, the leak guard already killed harness groups;
      // survivors ARE leaks — no exclusions.
      pgids: [...ownedPgids],
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
    logger.warn("Post-grace sweep failed", {
      runId,
      error: (err as Error).message,
    });
  }
}

/**
 * Schedule a one-shot post-grace sweep timer for a run. Deduplicated: at
 * most one pending timer per runId. The timer is unref-ed so a process
 * with an empty event loop exits without waiting. Called from
 * `removeRunCrons` so every run teardown path (control-plane terminate,
 * dispatch-round run_not_running) gets a sweep scheduled.
 */
function scheduleSweepTimer(runId: string, target: PostGraceSweepTarget = {}): void {
  if (pendingSweepTimers.has(runId)) return;

  const delayMs = HARNESS_TEARDOWN_GRACE_MS + 2_000;
  const timer = setTimeout(() => {
    pendingSweepTimers.delete(runId);
    pendingSweepTargets.delete(runId);
    void runPostGraceSweep(runId, target);
  }, delayMs);

  timer.unref();
  pendingSweepTimers.set(runId, timer);
  pendingSweepTargets.set(runId, target);

  logger.debug("Scheduled post-grace sweep timer", { runId, delayMs });
}

/**
 * F3: emit the run's closing `run.tokens.final` event.
 *
 * Reads the run row at emit time: `tokensSpent` is the authoritative
 * accumulated total and `workflowId` names the run. `tokenDelta` is
 * included only when the run has a settled worker-round attribution (the
 * last settled round's delta); it is never fabricated. No-ops when the row
 * is gone, the run is not terminal completed/failed, or the finalization
 * was cancelled by a scheduler shutdown.
 */
async function finalizeRunTokenSpend(runId: string): Promise<void> {
  if (!activeTokenFinalizations.has(runId)) return;
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT workflow_id, tokens_spent, status FROM runs WHERE id = ?")
      .get(runId) as { workflow_id: string; tokens_spent: number; status: string } | undefined;
    if (!row) return;
    // Canceled runs settle their attribution before run.canceled (TATR
    // US-006), so run.canceled is already authoritative and gets no final.
    if (row.status !== "completed" && row.status !== "failed") return;

    const delta = lastRoundTokenDeltas.get(runId);
    const evt: TamanduaEvent = {
      ts: new Date().toISOString(),
      event: "run.tokens.final",
      runId,
      workflowId: row.workflow_id,
      tokensSpent: row.tokens_spent,
    };
    if (delta !== undefined) evt.tokenDelta = delta;
    emitEvent(evt);
    lastRoundTokenDeltas.delete(runId);

    logger.debug("Emitted run.tokens.final", {
      runId,
      workflowId: row.workflow_id,
      tokensSpent: row.tokens_spent,
      tokenDelta: delta ?? null,
    });
  } catch (err) {
    logger.warn("run.tokens.final emit failed", { runId, error: String(err) });
  } finally {
    activeTokenFinalizations.delete(runId);
    tokenFinalTimers.delete(runId);
  }
}

/**
 * F3: schedule the once-per-run closing `run.tokens.final` event.
 *
 * step-ops emits the terminal run.completed/run.failed at the instant the
 * run reaches a terminal status, but the harness that reported the final
 * step emits its message_end usage AFTER the tool call that ran
 * `step complete`. The scheduler keeps that round alive for the teardown
 * grace window so the usage can land as a post-terminal
 * run.tokens.updated; this helper closes the gap without delaying or
 * reordering the terminal event. Once the last in-flight round's
 * attribution has settled (or the grace window expires with no usage), it
 * emits run.tokens.final carrying the runs row total and, when usage
 * landed, the last round's delta.
 *
 * Exactly once per run: the runId is recorded in `finalizedTokenRuns`
 * before any timer/wait is armed, so repeated removeRunCrons/settle calls
 * cannot schedule a second final.
 *
 * @param graceMs injectable teardown grace (HARNESS_TEARDOWN_GRACE_MS in
 *   production; tens of milliseconds in tests).
 */
function scheduleRunTokenFinalization(runId: string, graceMs: number): void {
  if (finalizedTokenRuns.has(runId)) return;
  finalizedTokenRuns.add(runId);
  activeTokenFinalizations.add(runId);

  const signals = inFlightJobIdsForRun(runId)
    .map((jobId) => roundCompletionSignals.get(jobId)?.done)
    .filter((done): done is Promise<void> => done !== undefined);

  if (signals.length > 0) {
    // Wait for the in-flight round(s) to settle — the round's `finally`
    // resolves the signal AFTER attributeWorkRoundTokenUsage — bounded by
    // the teardown grace; whichever comes first, emit the closing figure.
    // Exactly one finalize call: the race settles once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      timer.unref();
    });
    if (timer) tokenFinalTimers.set(runId, timer);
    void Promise.race([
      Promise.all(signals).then(() => undefined),
      timeout,
    ]).then(() => {
      const pending = tokenFinalTimers.get(runId);
      if (pending) {
        clearTimeout(pending);
        tokenFinalTimers.delete(runId);
      }
      return finalizeRunTokenSpend(runId);
    });
    return;
  }

  // Nothing in flight: give any late usage the grace window, then emit the
  // closing figure (with the last settled delta when one exists).
  const timer = setTimeout(() => {
    void finalizeRunTokenSpend(runId);
  }, graceMs);
  timer.unref();
  tokenFinalTimers.set(runId, timer);
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

  // DSWP (US-003): capture the run's harness working directory and in-flight
  // child pgids BEFORE the loop deletes jobMetadata/inFlightChildren. The
  // post-grace sweep needs them to identify a direct-mode run's processes
  // (direct runs have no managed worktree row for the sweep to resolve).
  let sweepWorkingDirectory: string | undefined;
  const sweepPgids = new Set<number>();

  for (const [id, info] of jobMetadata) {
    if (info.runId !== runId) continue;

    if (!sweepWorkingDirectory && info.workingDirectoryForHarness) {
      sweepWorkingDirectory = info.workingDirectoryForHarness;
    }

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

    // PKIL (US-005): a non-drain operator pause marks each genuinely
    // in-flight round for the run BEFORE aborting/killing it, so the round's
    // post-round recovery classifies the exit as paused_by_operator and never
    // books a retry. Only in-flight rounds are marked (an idle job in
    // jobMetadata has no round to classify), and the round's own finally
    // clears the mark, so a stale entry cannot leak into a later round.
    if (options.pausedByOperator && inFlightJobs.has(id)) {
      operatorPausedRounds.add(id);
    }

    // KHYG US-002: record explicit cancellation intent for EVERY round
    // torn down with this run, REGARDLESS of child presence — a registered
    // round can be awaiting binary resolution with no published child yet,
    // and its controller must still be aborted so a post-teardown launch
    // can never release or fall back. The group signal below (when a live
    // child exists) then terminates the process group exactly as before.
    abortDispatchRound(id);
    const child = inFlightChildren.get(id);
    // Capture the harness pgid even when the child was already marked
    // killed: the sweep must know every group this run owns.
    if (child?.pgid) sweepPgids.add(child.pgid);
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
    // Drop the run's instant-fail streaks with the jobs — a torn-down run
    // must not leave stale backoff/escalation state behind.
    instantFailStreaks.delete(id);
    // OUTAGE-ROUNDS (SCLS): drop the run's pre-claim death streaks too.
    preclaimDeathStreaks.delete(id);
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
  //
  // Guard: only schedule a sweep when we actually tore down dispatch
  // jobs for this run. This prevents late-arriving fire-and-forget
  // executeDispatchRound calls (e.g. from nudgeScheduledRuns) from
  // re-populating pendingSweepTimers after shutdownAllCrons has
  // already cleared it — the source of an environment-dependent
  // sweep-timer leak into downstream tests. All legitimate callers
  // (explicit tear-down, dispatch-round run_not_running, control-plane
  // terminate) have the run's jobs in jobMetadata at call time, so
  // this condition always holds for them.
  //
  // Epoch guard (US-002): when the caller passed the round's captured
  // schedulerGeneration and it no longer equals the current epoch, the
  // round outlived a shutdownAllCrons() — skip the sweep entirely so a
  // stale round cannot revive pendingSweepTimers after teardown. When
  // the option is absent, behave exactly as before.
  const epoch = options.schedulerGeneration;
  const epochStale = epoch !== undefined && epoch !== schedulerGeneration;
  if (removed.length > 0 && !epochStale) {
    scheduleSweepTimer(runId, {
      workingDirectory: sweepWorkingDirectory,
      pgids: [...sweepPgids],
    });
  }

  // ── F3: closing run.tokens.final ────────────────────────────────
  // A run that reached completed/failed on its own keeps its final
  // harness round alive for the grace window so the round's message_end
  // usage can land after the terminal event. Emit the authoritative
  // closing total once that attribution settles (or the grace expires).
  // Canceled runs are excluded: the cancel path settles in-flight
  // attribution before run.canceled (TATR US-006), so run.canceled is
  // already authoritative. graceMs=0 (user-directed teardown) never
  // finalizes. The epoch guard mirrors the sweep-timer guard so a stale
  // round cannot finalize after shutdownAllCrons.
  if (removed.length > 0 && !epochStale && graceMs > 0) {
    try {
      const { getDb } = await import("../db.js");
      const row = getDb()
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(runId) as { status: string } | undefined;
      if (row && (row.status === "completed" || row.status === "failed")) {
        scheduleRunTokenFinalization(runId, graceMs);
      }
    } catch (err) {
      logger.warn("run.tokens.final scheduling check failed", { runId, error: String(err) });
    }
  }
}

/**
 * Job ids whose dispatch round is currently in flight for the given run.
 *
 * Consults `inFlightJobs`/`jobMetadata` AND `roundCompletionSignals`: a
 * round whose bookkeeping `removeRunCrons` already wiped (timer removal)
 * but whose post-round processing has not finished is still reported as in
 * flight via its completion signal.
 */
function inFlightJobIdsForRun(runId: string): string[] {
  const ids: string[] = [];
  for (const jobId of inFlightJobs) {
    const info = jobMetadata.get(jobId);
    if (info?.runId === runId) ids.push(jobId);
  }
  for (const [jobId, signal] of roundCompletionSignals) {
    if (signal.runId === runId && !ids.includes(jobId)) ids.push(jobId);
  }
  return ids;
}

export interface SettleRunInFlightRoundsOptions {
  /**
   * Milliseconds to wait for in-flight rounds' post-round processing
   * (token attribution) to finish. Defaults to HARNESS_TEARDOWN_GRACE_MS.
   * 0 returns immediately, reporting every in-flight round as still in
   * flight (mirrors removeRunCrons' graceMs=0 kill-immediately semantic).
   */
  graceMs?: number;
}

export interface SettleRunInFlightRoundsResult {
  /** Job ids still in flight after the grace window (empty = all settled). */
  stillInFlight: string[];
}

/**
 * Settle a run's in-flight worker rounds' token attribution (TATR facet 3).
 *
 * For each in-flight dispatch round belonging to the run, waits up to
 * `graceMs` for the round's post-round processing — token attribution via
 * `attributeWorkRoundTokenUsage` — to complete. Resolves as soon as every
 * targeted round has finished (its completion signal fires in the round's
 * `finally`, AFTER attribution), or when the grace window expires,
 * whichever comes first, reporting which job ids (if any) were still in
 * flight.
 *
 * The cancel path calls this AFTER `removeRunCrons` so no new rounds
 * dispatch while attribution settles; the completion signals survive the
 * timer removal, so this helper still finds the in-flight rounds.
 */
export async function settleRunInFlightRounds(
  runId: string,
  options: SettleRunInFlightRoundsOptions = {},
): Promise<SettleRunInFlightRoundsResult> {
  const graceMs = options.graceMs ?? HARNESS_TEARDOWN_GRACE_MS;
  const targets = inFlightJobIdsForRun(runId);
  if (targets.length === 0) return { stillInFlight: [] };
  if (graceMs <= 0) return { stillInFlight: targets };

  const signals = targets
    .map((jobId) => roundCompletionSignals.get(jobId)?.done)
    .filter((done): done is Promise<void> => done !== undefined);

  if (signals.length > 0) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), graceMs);
    });
    await Promise.race([Promise.all(signals), timeoutPromise]);
    if (timeout) clearTimeout(timeout);
  } else {
    // In-flight markers without registered completion signals (guard-only
    // callers, e.g. tests): wait out the window so any late registration
    // settles, then report what is still in flight.
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  }

  return { stillInFlight: inFlightJobIdsForRun(runId) };
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
  // KHYG US-002: abort EVERY registered round controller before clearing
  // the registry — a registered round can be awaiting binary resolution
  // with no in-flight child yet, and its controller must still be aborted
  // so a round that outlives shutdown can never release or fall back.
  // Abort is idempotent, so controllers already aborted via the child
  // loop below are unaffected.
  for (const id of [...roundAbortControllers.keys()]) {
    abortDispatchRound(id);
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
  pendingSweepTargets.clear();
  // F3: cancel pending run.tokens.final timers and mark their runs as no
  // longer active so a late race callback cannot emit after shutdown.
  // `finalizedTokenRuns` is intentionally left intact: a shut-down scheduler
  // must not re-finalize a run it already closed.
  for (const [runId, timer] of tokenFinalTimers) {
    clearTimeout(timer);
    tokenFinalTimers.delete(runId);
  }
  activeTokenFinalizations.clear();
  // Unblock any settleRunInFlightRounds waiters and drop the round
  // completion signals: after a full scheduler shutdown nothing is in
  // flight, so every waiter reports fully settled.
  for (const [, signal] of roundCompletionSignals) {
    signal.resolve();
  }
  roundCompletionSignals.clear();
  inFlightChildren.clear();
  inFlightJobs.clear();
  jobMetadata.clear();
  instantFailStreaks.clear();
  // OUTAGE-ROUNDS (SCLS): a full shutdown leaves no round to classify — drop
  // the pre-claim death streaks too.
  preclaimDeathStreaks.clear();
  // PKIL (US-005): a full shutdown leaves no round to classify — drop the
  // operator-pause marks so they cannot survive into a later test/run.
  operatorPausedRounds.clear();
  // KHYG US-002: every round's cancellation controller was aborted above
  // (or belongs to a round that already finished); a full scheduler
  // shutdown leaves nothing in flight, so drop the registry too.
  roundAbortControllers.clear();
  schedulerGeneration++;
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

/** @internal — exposed for tests to inspect a run's captured sweep target. */
export function _pendingSweepTarget(runId: string): PostGraceSweepTarget | undefined {
  const target = pendingSweepTargets.get(runId);
  return target ? { ...target, pgids: target.pgids ? [...target.pgids] : undefined } : undefined;
}

/** @internal — exposed for tests to observe scheduler generation/epoch bumps. */
export function _schedulerGeneration(): number {
  return schedulerGeneration;
}

/** @internal — exposed for tests to introspect the instant-fail streak for a job. */
export function _instantFailStreakFor(jobId: string): { consecutive: number; nextAllowedDispatchAt: number } | undefined {
  const streak = instantFailStreaks.get(jobId);
  return streak ? { ...streak } : undefined;
}

/** @internal — exposed for tests to introspect the pre-claim death streak for a job. */
export function _preclaimDeathStreakFor(jobId: string): { consecutive: number; nextAllowedDispatchAt: number } | undefined {
  const streak = preclaimDeathStreaks.get(jobId);
  return streak ? { ...streak } : undefined;
}

/** @internal — exposed for tests to clear all instant-fail streaks between cases. */
export function _resetInstantFailStreaks(): void {
  instantFailStreaks.clear();
}

/** @internal — exposed for tests to clear all pre-claim death streaks between cases. */
export function _resetPreclaimDeathStreaks(): void {
  preclaimDeathStreaks.clear();
}

/** @internal — exposed for tests to introspect scheduled job metadata. */
export function _scheduledJobHarnessType(runId: string): string | undefined {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) return info.harnessType ?? "pi";
  }
  return undefined;
}

/** @internal — exposed for tests to introspect a scheduled job's resolved git identity (GIDN US-003). */
export function _scheduledJobGitIdentity(runId: string): { name: string; email: string } | undefined {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) return info.gitIdentity ? { ...info.gitIdentity } : undefined;
  }
  return undefined;
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
