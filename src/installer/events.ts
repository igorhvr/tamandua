import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePiStateDir } from "./paths.js";
import { logger } from "../lib/logger.js";
import { formatInstant, nowIso } from "../lib/instant.js";
import { assertStatePathIsolation } from "../lib/test-guard.js";

// ── Rotation constants (global events file) ────────────────────────

/**
 * Maximum size (20 MB) of the global events file (all.jsonl) before
 * rotation is triggered. Mirrors the logger.ts rotation pattern:
 * when emitEvent would push the file past this cap, the file is
 * rotated to numbered archives.
 */
export const MAX_EVENTS_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Number of rotated archive files to keep (all.jsonl.1 … all.jsonl.N).
 * When rotation occurs, the oldest archive is deleted before shifting.
 */
export const MAX_ROTATED_EVENTS_FILES = 3;

// ── Types ────────────────────────────────────────────────────────────

/**
 * NPF-1 (REROUTE-BUDGET): the landing report states only what was actually
 * verified about a checkout of the target branch.
 *
 * - `refreshed`                 a clean attached owner was advanced in place
 * - `already-coherent`          a live owner HEAD was read and equals the target tip
 * - `checkout-not-at-tip`       a live owner HEAD was read and differs from the target tip
 * - `no-checkout-to-refresh`    no usable owner checkout exists to verify
 * - `parked:<branch>`           the landing parked the prior checkout on <branch>
 *
 * The old unverified label is gone: it claimed a checkout state without
 * inspecting one (a no-op could report it while, in fact, a stale-metadata
 * owner checkout existed).
 */
export type CheckoutRefreshOutcome =
  | "refreshed"
  | "already-coherent"
  | "no-checkout-to-refresh"
  | "checkout-not-at-tip"
  | `parked:${string}`;

export interface TamanduaEvent {
  ts: string;
  event: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  storyId?: string;
  storyTitle?: string;
  agentId?: string;
  detail?: string;
  reason?: string;
  /**
   * WAVE-A: the run-context activation flag key for a conditional step.
   * Present on step.auto_completed events (the condition that was unset).
   */
  condition?: string;
  /**
   * TCMD (US-004): the established TEST_CMD contract at the moment a rewrite
   * was detected. Present on test_cmd.rewrite_detected events.
   */
  oldTestCmd?: string;
  /**
   * TCMD (US-004): the newly attempted TEST_CMD marker that differs from the
   * established contract. Present on test_cmd.rewrite_detected events.
   */
  newTestCmd?: string;
  /**
   * TCMD (US-004): the step round (1-based attempt) whose output carried the
   * TEST_CMD marker (step retry_count + 1). Present on test_cmd.rewrite_detected
   * events alongside runNumber (the run's number).
   */
  round?: number;
  /**
   * TCMD (US-006): the reviewer's file-grounded FINDING quoted on a REJECT
   * verdict. Present on test_cmd.review_rejected events; the rewriting step
   * receives it as bounded retry feedback.
   */
  finding?: string;
  abandonedCount?: number;
  /**
   * YSE US-002: how many failed episodes preceded a resume re-queue —
   * equal to the story's post-increment stories.resume_reset_count (1 on
   * the first reset, 2 on the second, ...). Present on
   * story.reset_for_resume events.
   */
  priorFailures?: number;
  tokenDelta?: number;
  tokensSpent?: number;
  /**
   * IFLB: the launch-time harness probe round's token spend, attributed to
   * the run through the per-round path. Present on run.harness_probe_ok so
   * operators see the probe's one-tiny-turn cost per run.
   */
  tokens?: number;
  /**
   * TATR US-007: explicit post-terminal flush identity. True when the
   * run's DB status was already terminal ('completed'/'failed'/'canceled')
   * at the moment this token flush was attributed — i.e. the flush landed
   * after the run's terminal event, or in a settle path where the run was
   * marked terminal before the flush. Consumers that stop reading at the
   * terminal event may subscribe to post-terminal events instead; see
   * tests/MOTOR-CONTRACT.md (token accounting, C15).
   */
  postTerminal?: boolean;
  /** The run's terminal DB status at attribution time ('completed'/'failed'/'canceled'); present iff postTerminal is true. */
  terminalStatus?: string;
  /**
   * TATR US-008: the dispatch round (job) that actually spent the tokens
   * attributed by a run.tokens.updated event. Always present on token
   * events emitted by the scheduler — it names the round whose harness
   * invocation produced the usage, so consumers can trace a delta to the
   * exact worker round that spent it.
   */
  roundId?: string;
  /**
   * TATR US-009: the run id of the run that spawned this child run (parent
   * linkage). Present on run.started (and any other event that carries it)
   * when the run was launched inside a parent run's worker round — the
   * workflow CLI derives it from the TAMANDUA_RUN_ID env var the scheduler
   * sets. Runs launched without a parent omit the field entirely; see
   * tests/MOTOR-CONTRACT.md (run identity, parent linkage).
   */
  parentRunId?: string;
  /**
   * GIDN US-002: the ONE commit identity resolved for this run at launch
   * (env GIT_USER_NAME/GIT_USER_EMAIL -> working repo local config -> global
   * config -> Tamandua fallback). Carried on run.started so the run's event
   * stream records exactly who its commits are authored/committed by and
   * where that identity came from (`source` is one of
   * env|repo-local|global|fallback). The same identity is persisted into the
   * run context as git_identity_name/git_identity_email/git_identity_source.
   * The resolver always returns an identity, so run.started always carries
   * this field.
   */
  gitIdentity?: { name: string; email: string; source: string };
  // Suite-specific fields (US-009)
  treeHash?: string;
  cmdDisplay?: string;
  cmdHash?: string;
  savedDurationMs?: number;
  durationMs?: number;
  exitCode?: number;
  signal?: string;
  stderrTail?: string;
  workerLostCount?: number;
  /** Rounds the motor itself killed at the worker time ceiling (step.ceiling_expiry). */
  ceilingExpiryCount?: number;
  /** Consecutive instant-fail worker rounds at the time a run.instant_fail_loop alert fires. */
  consecutiveInstantFails?: number;
  /**
   * IFLB launch-time harness probe fields. `harness` names the run's
   * harness (pi | hermes | dsh); `probeCmd` the exact command the probe
   * asked the harness to run (`<launcher> skill-path`); `expected` the
   * daemon-computed expected path; `observed` the normalized final message
   * actually observed (capped at HARNESS_PROBE_OBSERVED_MAX_CHARS).
   * Present on run.harness_probe_ok (harness/durationMs/tokens) and
   * run.harness_probe_failed (all of the above plus exitCode/signal/
   * durationMs/stderrTail — the mechanical keyline-block fields).
   */
  harness?: string;
  /**
   * KHYG US-002: the effective native signal-isolation mode of one harness
   * execution — 'landlock' | 'seatbelt' | 'unprotected-fallback'. Present on
   * run.harness_isolation records along with the run/execution identity,
   * `harness`, and (for fallback) `reason`; `detail` may carry the READY
   * record's extra tokens (e.g. `abi=8`).
   */
  mode?: string;
  probeCmd?: string;
  expected?: string;
  observed?: string;
  passCount?: number;
  failCount?: number;
  window?: string;
  waitedMs?: number;
  preTreeHash?: string;
  postTreeHash?: string;
  force?: boolean;
  originRepo?: string;
  ownerRunId?: string;
  ownerStepId?: string;
  ownerPid?: number;
  reclaimerRunId?: string;
  reclaimerStepId?: string;
  reclaimerPid?: number;
  releaseReason?: string;
  /**
   * RVOC US-002: identity of the dead/recovered worker whose claimed step was
   * re-dispatched (step.respawned). priorPid is the recovered step's
   * claim_pid (the prior worker's pid), priorRound its claim_job_id (the
   * prior dispatch round). Present only on step.respawned events.
   */
  priorPid?: number;
  priorRound?: string;
  /** RVOC US-002: the step's retry_count after a respawn re-dispatch (step.respawned). Informational only. */
  retry?: number;
  startedAt?: string;
  shimExitCode?: number;
  commandExitCode?: number | null;
  interrupted?: boolean;
  trackedDirty?: boolean;
  junkProbePath?: string;
  junkProbeTracked?: boolean;
  // Plumbing merge fields
  origin?: string;
  branch?: string;
  target?: string;
  expectedTip?: string;
  actualTip?: string;
  mergedTree?: string;
  mergedCommit?: string;
  /**
   * NPF-1 (US-007): the verified CAS tip (the caller's --expect-tip) the
   * landed result was based on. Present on merge.landed events.
   */
  targetTipBefore?: string;
  /**
   * NPF-1 (US-007): the live refs/heads/<target> tip re-read immediately
   * before the landed result was reported. Present on merge.landed events.
   */
  targetTipAfter?: string;
  noop?: boolean;
  checkoutRefresh?: CheckoutRefreshOutcome;
  parkedBranch?: string;
  parkedReason?: string;
  // Finalize-merge ledger gate fields
  ledgerRowId?: number;
  ledgerCreatedAt?: string;
  gateMode?: string;
  runNumber?: number;
  launchTs?: string;
  /**
   * WAVE-B.1: present on step.rerouted events — the reroute class
   * ('legacy' | 'declared_retryable' | 'terminal') returned by the
   * failure-classification logic for the driving reason, and terminal ===
   * (rerouteMode === 'terminal'). Consumers reconcile reroute_count ==
   * count(step.rerouted) and terminal_reroute_count == count(step.rerouted
   * where terminal === true).
   */
  rerouteMode?: string;
  terminal?: boolean;
  /**
   * REROUTE-BUDGET (NPF-3): present on step.rerouted and the reroute-budget
   * exhaustion events. failureClass is the parsed FAILURE_CLASS of the driving
   * reason (or null when the reason carries none). targetMovedRerouteCount is
   * the durable steps.target_moved_reroute_count AFTER the reroute (the
   * class-specific subset counter), and targetMovedBudget is the effective cap
   * it is compared against (on_fail.max_target_moved_reroutes, default 16).
   * These fields let consumers reconcile target_moved_reroute_count ==
   * count(step.rerouted where failureClass === 'target_moved').
   */
  failureClass?: string | null;
  targetMovedRerouteCount?: number;
  targetMovedBudget?: number;
  // Mechanical output-contract evidence (O11). These fields describe the
  // validator/lifecycle decision only; submitted output and rendered prompts
  // are deliberately excluded.
  recordId?: string;
  stepRowId?: string;
  claimId?: string;
  attemptNumber?: number;
  validationCode?: string;
  diagnosticCode?: string;
  outcome?: string;
  verdict?: string | null;
  expectsRequired?: boolean;
  requiredKeys?: string[];
  missingKeys?: string[];
  invalidKeys?: string[];
  producerStepRowId?: string | null;
  transitionAction?: string;
  transitionTargetStepRowId?: string;
  unresolvedPlaceholderCount?: number;
  unresolvedKeys?: string[];
  dispatched?: boolean;
}

/**
 * Canonical run-level lifecycle event vocabulary.
 *
 * `run.started` opens a run's event stream; the remaining five are the
 * terminal records that close it. This list is the product contract for
 * run lifecycle events and is pinned by
 * src/installer/events-vocabulary.test.ts (CNEV US-004): removing an
 * entry here — or dropping a required payload field from the matching
 * emitter — fails that test. Keep in sync with the emitters (run.ts,
 * step-ops.ts emitRunTerminalEvent, status.ts deleteWorkflow /
 * forceFailRun) and with the terminal-event consumer audit in
 * tests/MOTOR-CONTRACT.md.
 */
export const RUN_LIFECYCLE_EVENTS: readonly string[] = Object.freeze([
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "run.deleted",
  "run.force_failed",
]);

/**
 * Run-level alert event vocabulary — non-terminal diagnostics emitted
 * while a run is still active, signaling a pathology consumers should
 * surface before it becomes fatal (the DDTH pattern).
 *
 * `run.instant_fail_loop` fires when the dispatch motor escalates a
 * worker instant-fail loop (K+ consecutive sub-threshold zero-output
 * nonzero-exit rounds) toward run failure; the terminal run.force_failed
 * event follows immediately after with the precise reason. Pinned by
 * src/installer/events-vocabulary.test.ts.
 */
export const RUN_ALERT_EVENTS: readonly string[] = Object.freeze([
  "run.instant_fail_loop",
]);

/**
 * Run-level launch-time harness probe / per-execution isolation diagnostic
 * vocabulary (IFLB + KHYG US-002).
 *
 * `run.harness_probe_ok` fires when the probe round passes (the run's
 * harness answered the exact `<launcher> skill-path` command with the
 * expected PATH) and carries `harness`, `durationMs`, and `tokens` (the
 * probe round's attributed token spend). `run.harness_probe_failed` fires
 * when the probe fails (wrong output, non-zero exit, signal death, wall
 * exceeded, or an uncomputable expectation) and carries the mechanical
 * keyline-block fields HARNESS / PROBE_CMD / EXPECTED / OBSERVED (≤400
 * chars) / EXIT_CODE / SIGNAL / DURATION_MS / STDERR_TAIL (≤2000 chars)
 * plus the full block in `reason`/`detail`; the run is force-failed
 * immediately afterwards (run.force_failed).
 *
 * `run.harness_isolation` (KHYG US-002) records the effective
 * signal-isolation `mode` ('landlock' | 'seatbelt' | 'unprotected-fallback')
 * with the run/execution identity and `harness`, for harness executions
 * (work rounds AND the launch-time probe round) through the shared launch
 * mechanism in src/installer/harness-launch.ts. Protected records (landlock /
 * seatbelt) fire once per harness execution. When the backend was unavailable
 * or setup failed before release and the execution fell back to an
 * unprotected run, `mode` is 'unprotected-fallback' and `reason` names the
 * exact fallback cause — the prominent durable warning operators see on the
 * run event stream. Because the fallback condition is a run/host property,
 * the unprotected-fallback record is written ONCE PER RUN PER DAEMON START
 * (on the first fallback execution): later fallback rounds in the same run
 * are logged at debug and emit no further event, so a run with many rounds
 * does not flood the stream with duplicates. Pinned by
 * src/installer/events-vocabulary.test.ts.
 */
export const RUN_DIAGNOSTIC_EVENTS: readonly string[] = Object.freeze([
  "run.harness_probe_ok",
  "run.harness_probe_failed",
  "run.harness_isolation",
]);

export type EventCursorSource =
  | { kind: "global" }
  | { kind: "run"; runId: string };

export interface EventCursorReadResult {
  events: TamanduaEvent[];
  nextOffset: number;
  /**
   * Monotonic rotation generation counter for the global events file.
   * Always 0 for run-specific sources.  Callers should store this and
   * pass it back on the next poll so readEventsFromCursor can detect
   * rotation (generation mismatch → stale byte offset → safe reset).
   */
  generation: number;
}

// ── Paths ────────────────────────────────────────────────────────────

function getEventsDir(): string {
  return path.join(resolvePiStateDir(), "events");
}

function getEventsFile(runId: string): string {
  return path.join(getEventsDir(), `${runId}.jsonl`);
}

function getGlobalEventsFile(): string {
  return path.join(getEventsDir(), "all.jsonl");
}

function getGenerationFilePath(): string {
  return path.join(getEventsDir(), "all.jsonl.generation");
}

function getEventsFileForSource(source: EventCursorSource): string {
  if (source.kind === "global") return getGlobalEventsFile();
  return getEventsFile(source.runId);
}

// ── Generation tracking ────────────────────────────────────────────

/**
 * Return the current monotonic rotation generation counter for the
 * global events file.  Persisted in a companion .generation file
 * alongside all.jsonl.  Returns 0 when no generation file exists yet.
 *
 * Callers can compare a previously-stored generation against the
 * current value to detect rotation: a mismatch means the cursor's
 * byte offsets into the old all.jsonl are stale.
 */
export function getGlobalEventsGeneration(): number {
  const genFile = getGenerationFilePath();
  try {
    const raw = fs.readFileSync(genFile, "utf-8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Increment the generation counter and persist it to the .generation
 * companion file.  Called internally by rotateGlobalEventsFile.
 */
function incrementGeneration(): void {
  const genFile = getGenerationFilePath();
  const next = getGlobalEventsGeneration() + 1;
  fs.mkdirSync(path.dirname(genFile), { recursive: true });
  fs.writeFileSync(genFile, String(next), "utf-8");
}

// ── Global events file rotation ─────────────────────────────────────

/**
 * Rotate the global events file (all.jsonl) when it exceeds
 * MAX_EVENTS_FILE_SIZE.  Follows the same archive-shifting pattern as
 * logger.ts rotateIfNeeded:
 *
 *   1. Delete the oldest archive (all.jsonl.MAX_ROTATED_EVENTS_FILES)
 *   2. Shift existing archives: .(N-1) → .N  …  .1 → .2
 *   3. Rename the current file to all.jsonl.1
 *   4. Increment the rotation generation counter
 *
 * The live file (all.jsonl) is NOT re-created here — the next
 * emitEvent appendEventLine (O_APPEND open) will implicitly create it.
 *
 * Callers on the shared all.jsonl path hold the per-file advisory lock
 * (see emitEventCore); direct callers must respect that themselves.
 *
 * This function is idempotent: if the global file doesn't exist or
 * is below the cap, it returns without side effects.
 */
export function rotateGlobalEventsFile(): void {
  const globalFile = getGlobalEventsFile();
  try {
    const stats = fs.statSync(globalFile);
    if (stats.size <= MAX_EVENTS_FILE_SIZE) {
      globalFileSizeEstimate = stats.size;
      return; // below cap
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
    globalFileSizeEstimate = 0;
    return;
  }

  // Delete oldest archive
  const oldest = `${globalFile}.${MAX_ROTATED_EVENTS_FILES}`;
  try {
    fs.unlinkSync(oldest);
  } catch {
    // oldest may not exist — fine
  }

  // Shift archives: .(N-1) → .N, …, .1 → .2
  for (let i = MAX_ROTATED_EVENTS_FILES - 1; i >= 1; i--) {
    const src = `${globalFile}.${i}`;
    const dst = `${globalFile}.${i + 1}`;
    try {
      fs.renameSync(src, dst);
    } catch {
      // race / missing archive — acceptable
    }
  }

  // Rename current → .1
  fs.renameSync(globalFile, `${globalFile}.1`);

  // Increment the rotation generation so cursor consumers can detect staleness
  incrementGeneration();

  // No live file remains after rotation — reset the size estimate
  globalFileSizeEstimate = 0;
}

// ── Atomic event-line appends (EVTA US-008) ─────────────────────────
//
// The vaivm incident (beads tamandua-6sy.64): a `step.worker_lost` line was
// written truncated at column 1333 with the following event concatenated onto
// it, in BOTH the run-scoped file and all.jsonl. The cause was a multi-write
// append (fs.appendFileSync) racing across writer processes: a JS string append
// is not guaranteed to reach the kernel as one write, and separate processes
// can interleave their write(2) calls. Readers then saw one corrupt line.
//
// The fix below writes every event line as ONE buffer containing its own
// trailing '\n', through ONE fs.writeSync on an O_APPEND descriptor. POSIX
// only guarantees that appends are atomic for a single write at or below
// PIPE_BUF, so for a file that may have several writer processes (all.jsonl)
// writers additionally serialize through a per-file advisory lock. Run-scoped
// files have exactly ONE writer process by contract (the process that owns the
// run emits that run's events), so they need only the in-process queue.

/**
 * Upper bound (ms) for acquiring the cross-process append lock on a shared
 * event file. Overridable with `TAMANDUA_EVENT_LOCK_TIMEOUT_MS` (defensive
 * parse + clamp; invalid/blank/non-positive falls back to the default).
 */
export const DEFAULT_EVENT_LOCK_TIMEOUT_MS = 5000;

/**
 * A lock file whose mtime is older than this is presumed abandoned (the
 * holder crashed without unlinking it) and is taken over. Appends take
 * microseconds, so a lock held this long can only be a corpse. Tests can
 * simulate staleness by back-dating the lock file's mtime with utimesSync.
 */
export const EVENT_LOCK_STALE_MS = 30_000;

/** Retry cadence (ms) while another process holds the lock. */
const EVENT_LOCK_RETRY_MS = 5;

/** Parse + clamp `TAMANDUA_EVENT_LOCK_TIMEOUT_MS`, defaulting to 5000. */
export function parseEventLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TAMANDUA_EVENT_LOCK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_EVENT_LOCK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVENT_LOCK_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(n)), 60_000);
}

/** Synchronous sleep without busy-spinning (Atomics.wait blocks the thread). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Append `line` to `filePath` as exactly one O_APPEND write.
 *
 * The input is serialized to a single Buffer whose last byte is '\n' — never
 * a JS string handed to a multi-call append helper — and planted with
 * `fs.writeSync` on an `fs.openSync(filePath, "a")` (O_APPEND) descriptor.
 * On the (exceptional) short write only the unwritten remainder is retried;
 * because the descriptor is O_APPEND every retry still lands at EOF, so no
 * retry can overwrite or interleave with another writer's bytes. The fd is
 * always closed in `finally`.
 *
 * Returns the number of bytes appended (includes the trailing newline).
 */
export function appendEventLine(filePath: string, line: string): number {
  const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf-8");
  const fd = fs.openSync(filePath, "a");
  try {
    let written = 0;
    while (written < buf.length) {
      // No position argument: an O_APPEND fd always writes at current EOF,
      // which is what makes each write atomic with respect to other appenders.
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) {
        throw new Error(`short write appending event line to ${filePath}`);
      }
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buf.length;
}

interface EventFileQueueState {
  active: boolean;
  pending: Array<() => void>;
}

/**
 * Per-file in-process serializers. Node's JS execution is single-threaded, so
 * a synchronous append cannot be preempted mid-call; the queue's `active`
 * state can therefore only be observed through REENTRANCY (an append invoked
 * from inside another operation on the same file). Reentrant calls are parked
 * on a FIFO and drained by the active writer before it returns, so two
 * in-process appends to one file can never interleave their buffers and the
 * FIFO order is preserved.
 */
const eventFileQueues = new Map<string, EventFileQueueState>();

function withEventFileQueue(filePath: string, operation: () => void): void {
  const key = path.resolve(filePath);
  let state = eventFileQueues.get(key);
  if (!state) {
    state = { active: false, pending: [] };
    eventFileQueues.set(key, state);
  }
  if (state.active) {
    // Reentrant append: defer until the in-flight writer drains the queue.
    state.pending.push(operation);
    return;
  }
  state.active = true;
  try {
    operation();
  } finally {
    try {
      while (state.pending.length > 0) {
        const next = state.pending.shift()!;
        try {
          next();
        } catch (err) {
          logger.warn("Deferred event append failed", { file: key, error: String(err) });
        }
      }
    } finally {
      state.active = false;
      if (state.pending.length === 0) eventFileQueues.delete(key);
    }
  }
}

/**
 * Acquire the per-file advisory lock for a shared event file by exclusively
 * creating `<file>.lock` (O_CREAT|O_EXCL). Retries with a bounded deadline
 * (`TAMANDUA_EVENT_LOCK_TIMEOUT_MS`) and takes over a lock older than
 * `EVENT_LOCK_STALE_MS`. Returns the lock fd, or null when the lock could not
 * be acquired within the deadline. The lock file is intentionally left empty:
 * its existence plus mtime are the whole protocol state.
 */
function acquireEventFileLock(lockPath: string, timeoutMs: number): number | null {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(lockPath, "wx"); // O_CREAT | O_EXCL
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        logger.warn("Failed to create event lock file", { lockPath, error: String(err) });
        return null;
      }
    }

    // Lock exists — take it over if it looks abandoned, otherwise wait.
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > EVENT_LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another waiter took it over first — fall through to retry.
        }
        continue;
      }
    } catch {
      // Lock vanished between open and stat — retry immediately.
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    sleepSync(Math.min(EVENT_LOCK_RETRY_MS, remaining));
  }
}

/** Release a lock acquired by acquireEventFileLock (close fd, unlink file). */
function releaseEventFileLock(lockPath: string, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already removed (stale takeover / external cleanup)
  }
}

// ── Event Emission ───────────────────────────────────────────────────

/**
 * Dispatch-nudge bookkeeping events. Every nudge fans out to all agents of
 * all running runs, so at steady state these are ~99% of all.jsonl volume
 * (observed: 464k of 467k events, 92MB) — and the dashboard re-reads that
 * file on every poll. Dropped unless TAMANDUA_DEBUG_EVENTS is set.
 */
const NOISE_EVENTS: ReadonlySet<string> = new Set([
  "run.nudged",
  "agent.nudged",
  "agent.nudge.skipped",
]);

function isEnvFlagEnabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/**
 * Module-level cached estimate of the global all.jsonl file size (bytes).
 * Initialised at module load via statSync and incremented on each
 * successful global append.  When the estimate reaches MAX_EVENTS_FILE_SIZE
 * rotation is triggered before the next write, and the cache is reset to
 * include only bytes written to the fresh (post-rotation) live file.
 *
 * Using a cache avoids a statSync on every emitEvent call (99% of events
 * are nudge noise and are dropped before this path, so the check is only
 * paid for real events).  The estimate may diverge from the true size
 * after external writes or concurrent processes; that's acceptable — the
 * rotation check is a size-based guard, not a precision accounting tool.
 */
let globalFileSizeEstimate = 0;

// Initialise the size cache at module load so restarted processes pick up
// an existing all.jsonl file size.
(function initGlobalFileSizeEstimate(): void {
  try {
    const stats = fs.statSync(getGlobalEventsFile());
    globalFileSizeEstimate = stats.size;
  } catch {
    // File doesn't exist yet — keep estimate at 0
  }
})();

/**
 * Rescan the global events file and update the module-level size
 * estimate.  Useful when the file is written outside emitEvent (e.g.
 * in tests that pre-seed a large all.jsonl to exercise rotation).
 */
export function _refreshSizeEstimate(): void {
  try {
    const stats = fs.statSync(getGlobalEventsFile());
    globalFileSizeEstimate = stats.size;
  } catch {
    globalFileSizeEstimate = 0;
  }
}

let isolationViolationReported = false;

// ── Event Buffering ──────────────────────────────────────────────────

/**
 * Module-level in-memory event buffer. When non-null, emitEvent
 * redirects events into this array instead of writing to disk.
 * Used to defer event emission inside a database transaction so that
 * events are only written after commit (or discarded on rollback).
 */
let eventBuffer: TamanduaEvent[] | null = null;

/**
 * Activate event buffering. After this call, all emitEvent calls
 * append to an in-memory array instead of writing to disk.
 */
export function beginEventBuffering(): void {
  eventBuffer = [];
}

/**
 * Write all buffered events to disk in order, then deactivate
 * buffering. Must only be called when eventBuffer is non-null.
 * Each buffered event is written via emitEventCore (the raw disk
 * path), bypassing the buffer.
 */
export function flushEventBuffer(): void {
  const buf = eventBuffer;
  eventBuffer = null;
  if (buf) {
    for (const evt of buf) {
      emitEventCore(evt);
    }
  }
}

/**
 * Discard all buffered events without writing them and deactivate
 * buffering. Call on transaction rollback so no phantom events are
 * emitted for an aborted attempt.
 */
export function discardEventBuffer(): void {
  eventBuffer = null;
}

/**
 * Core event emission logic — writes to files and fires webhook.
 * This is the raw path that bypasses buffer checks; callers that
 * already decided NOT to buffer (or are flushing) use this directly.
 */
function emitEventCore(evt: TamanduaEvent): void {
  if (NOISE_EVENTS.has(evt.event) && !isEnvFlagEnabled(process.env.TAMANDUA_DEBUG_EVENTS)) {
    return;
  }
  // TIME-OUTPUT (US-007): every persisted event carries a canonical ISO-8601
  // UTC `ts` with an explicit Z. A legacy naive or offset-carrying value is
  // normalized through the shared serializer; a missing/unparseable one falls
  // back to a fresh canonical now — never raw, never a garbage string.
  const normalized: TamanduaEvent = {
    ...evt,
    ts: formatInstant(evt.ts, { style: "iso" }) ?? nowIso(),
  };
  const line = JSON.stringify(normalized) + "\n";

  // Test-isolation guard: refuse to write events into the real production
  // state dir. Guarded test processes must never pollute production event
  // files. Follow the logger.ts pattern: catch the guard error, drop the
  // event silently, report once to stderr, and do NOT throw — event emission
  // must never crash execution (late timers fire after test env is restored).
  try {
    assertStatePathIsolation(getEventsFile(evt.runId), "emitEvent(run)");
    assertStatePathIsolation(getGlobalEventsFile(), "emitEvent(global)");
  } catch (err) {
    if (!isolationViolationReported) {
      isolationViolationReported = true;
      process.stderr.write(
        `[events] ${String(err instanceof Error ? err.message : err)} — event dropped (reported once)\n`,
      );
    }
    return;
  }

  // Ensure events directory exists
  const eventsDir = getEventsDir();
  fs.mkdirSync(eventsDir, { recursive: true });

  // Write to the run-specific events file. CONTRACT: a run's events file has
  // exactly ONE writer process — the process that owns the run. No
  // cross-process lock is needed; the in-process queue still serializes
  // reentrant appends so the file cannot interleave buffers.
  const runFile = getEventsFile(evt.runId);
  try {
    withEventFileQueue(runFile, () => {
      appendEventLine(runFile, line);
    });
  } catch (err) {
    logger.warn("Failed to write run event", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  }

  // Write to global events file — rotate after if the file now exceeds the cap.
  // CONTRACT: all.jsonl MAY have several writer processes (every process that
  // emits any event appends here), so the append+rotation critical section is
  // serialized with the per-file advisory lock. If the lock cannot be
  // acquired within the deadline the global append is SKIPPED (the run-scoped
  // line is still durable) — dropping one global copy is preferable to
  // corrupting the shared log for every reader.
  const globalFile = getGlobalEventsFile();
  try {
    withEventFileQueue(globalFile, () => {
      const lockPath = `${globalFile}.lock`;
      const lockFd = acquireEventFileLock(lockPath, parseEventLockTimeoutMs());
      if (lockFd === null) {
        logger.warn("Failed to acquire global event lock; skipping global append", {
          event: evt.event,
          file: globalFile,
        });
        return;
      }
      try {
        globalFileSizeEstimate += appendEventLine(globalFile, line);
        if (globalFileSizeEstimate > MAX_EVENTS_FILE_SIZE) {
          rotateGlobalEventsFile();
          // rotateGlobalEventsFile now correctly updates the estimate on
          // all branches (no-op: sets to actual stat size; rotated: 0;
          // ENOENT: 0). No need to reset here.
        }
      } finally {
        releaseEventFileLock(lockPath, lockFd);
      }
    });
  } catch (err) {
    logger.warn("Failed to write global event", {
      event: evt.event,
      error: String(err),
    });
  }

  // Fire-and-forget webhook if applicable
  fireWebhook(normalized).catch((err) => {
    logger.warn("Webhook delivery failed", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  });
}

/**
 * Emit a Tamandua event.
 *
 * Writes:
 * 1. To the run-specific JSONL file (~/.tamandua/events/<runId>.jsonl)
 * 2. To the global JSONL file (~/.tamandua/events/all.jsonl)
 * 3. Fires a webhook if a notify URL is configured for the run (fire-and-forget)
 *
 * High-volume nudge bookkeeping events (NOISE_EVENTS) are dropped unless
 * TAMANDUA_DEBUG_EVENTS is set.
 *
 * When buffering is active (eventBuffer !== null), events are appended to
 * the in-memory buffer and no disk I/O occurs. Callers must flush or discard
 * the buffer after the transaction boundary.
 */
export function emitEvent(evt: TamanduaEvent): void {
  if (eventBuffer !== null) {
    eventBuffer.push(evt);
    return;
  }
  emitEventCore(evt);
}

// ── Tail-window reading constants ───────────────────────────────────

const TAIL_CHUNK_SIZE = 256 * 1024; // 256 KB
const MAX_TAIL_READ = 4 * 1024 * 1024; // 4 MB

// ── Event Reading ────────────────────────────────────────────────────
//
// Reader-side counterpart to the atomic-append contract above (EVTA US-009).
// Even with single-write O_APPEND appends, a writer can die mid-write and
// leave a TORN final line (no trailing newline), and an older/corrupt writer
// can leave a newline-terminated garbage line. The shared parser below
// classifies both without ever throwing, so every reader (cursor, run, tail,
// recent) behaves identically:
//
//   - complete newline-terminated lines that parse to a JSON object → events
//   - complete newline-terminated lines that fail JSON.parse or are not
//     objects → `corrupt` entries (reported with an absolute byte offset)
//   - the final unterminated segment → `trailingPartial` (never corrupt,
//     never returned as an event; a cursor must stay at its start so the
//     line is re-read once the writer completes it)
//   - empty / CR-only lines are silently skipped (they carry no event)

/** A newline-terminated event line that could not be parsed as a JSON object. */
export interface CorruptEventLine {
  /** Absolute byte offset (from the start of the underlying file) of the line. */
  offset: number;
  /** Byte length of the corrupt line, excluding its terminating newline. */
  length: number;
  /** Bounded UTF-8 preview of the line, for operator diagnostics. */
  preview: string;
}

/** The final, newline-less segment of a buffer — an in-progress/torn write. */
export interface TrailingPartialEventLine {
  /** Absolute byte offset of the segment's first byte. */
  offset: number;
  /** Byte length of the segment. */
  length: number;
}

/** Result of classifying one raw JSONL buffer. */
export interface ParsedJsonlEventBuffer {
  /** Every valid event, in file order. */
  events: TamanduaEvent[];
  /** Every interior corrupt line, in file order, with its byte offset. */
  corrupt: CorruptEventLine[];
  /** The trailing unterminated segment, or null when the buffer ends with '\n'. */
  trailingPartial: TrailingPartialEventLine | null;
}

/** Cap on the `preview` string carried by a corrupt-line entry. */
export const CORRUPT_EVENT_PREVIEW_MAX_CHARS = 200;

function corruptLinePreview(line: string): string {
  if (line.length <= CORRUPT_EVENT_PREVIEW_MAX_CHARS) return line;
  return `${line.slice(0, CORRUPT_EVENT_PREVIEW_MAX_CHARS)}…`;
}

/**
 * Classify a raw JSONL buffer into valid events, interior corrupt lines, and a
 * potentially-torn trailing partial. Pure and total: it never throws, never
 * drops a valid line, and never returns the final unterminated segment as an
 * event (a torn write must be re-read once complete).
 *
 * `baseOffset` is added to every reported offset so callers reading a slice of
 * a file (a tail window, or a cursor read starting past byte 0) can report
 * offsets relative to the real file.
 */
export function parseJsonlEventBuffer(buf: Buffer, baseOffset = 0): ParsedJsonlEventBuffer {
  const events: TamanduaEvent[] = [];
  const corrupt: CorruptEventLine[] = [];
  let cursor = 0;

  while (cursor < buf.length) {
    const newlineIndex = buf.indexOf(0x0A, cursor);
    if (newlineIndex === -1) break; // trailing partial line — classified below

    const lineStart = cursor;
    const lineBuffer = buf.subarray(cursor, newlineIndex);
    cursor = newlineIndex + 1;

    // Skip empty lines and CR-only lines silently — they carry no event.
    let contentEnd = lineBuffer.length;
    if (contentEnd > 0 && lineBuffer[contentEnd - 1] === 0x0D) contentEnd -= 1;
    if (contentEnd === 0) continue;

    const line = lineBuffer.toString("utf-8", 0, contentEnd);
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseFailed = true;
    }

    if (!parseFailed && parsed !== null && typeof parsed === "object") {
      events.push(parsed as TamanduaEvent);
    } else {
      corrupt.push({
        offset: baseOffset + lineStart,
        length: lineBuffer.length,
        preview: corruptLinePreview(line),
      });
    }
  }

  const trailingPartial = cursor < buf.length
    ? { offset: baseOffset + cursor, length: buf.length - cursor }
    : null;

  return { events, corrupt, trailingPartial };
}

/**
 * Report interior corrupt event lines without ever throwing. Reporting is
 * best-effort diagnostics: the valid events surrounding a corrupt line are
 * still returned to the caller.
 */
function reportCorruptEventLines(file: string, corrupt: CorruptEventLine[]): void {
  for (const line of corrupt) {
    try {
      logger.warn("Corrupt event line", {
        file,
        offset: line.offset,
        length: line.length,
      });
    } catch {
      // Reporting must never take down a reader.
    }
  }
}

/**
 * Read events appended after a byte offset from either:
 * - ~/.tamandua/events/all.jsonl (global)
 * - ~/.tamandua/events/<runId>.jsonl (per-run)
 *
 * Returns only complete newline-terminated records and the next cursor offset.
 * A torn final line (no trailing newline) is ignored and the returned
 * nextOffset stays at its start so the line is re-read once the writer
 * completes it. Interior corrupt lines are reported through logger.warn with
 * the file path and byte offset, and never prevent valid events from being
 * returned.
 */
export function readEventsFromCursor(
  source: EventCursorSource,
  offset = 0,
  generation?: number,
): EventCursorReadResult {
  const eventsFile = getEventsFileForSource(source);

  // For global source: if the caller's generation is stale (rotation
  // happened since the cursor was obtained), reset to offset 0 so we read
  // the new live file from the beginning instead of pointing at bytes in
  // the old (now-archived) file — which would be at best empty, at worst
  // silently returning bytes from a different file that reused the inode.
  const currentGeneration = source.kind === "global"
    ? getGlobalEventsGeneration()
    : 0;
  const isGlobalSource = source.kind === "global";
  let safeOffset = Math.max(0, Math.floor(offset));
  if (isGlobalSource && generation !== undefined && generation !== currentGeneration) {
    safeOffset = 0;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(eventsFile, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    const effectiveOffset = safeOffset > fileSize ? 0 : safeOffset;
    const readLength = fileSize - effectiveOffset;

    if (readLength === 0) return { events: [], nextOffset: effectiveOffset, generation: currentGeneration };

    const fileBuffer = Buffer.alloc(readLength);
    fs.readSync(fd, fileBuffer, 0, readLength, effectiveOffset);

    const parsed = parseJsonlEventBuffer(fileBuffer, effectiveOffset);
    reportCorruptEventLines(eventsFile, parsed.corrupt);

    const nextOffset = parsed.trailingPartial
      ? parsed.trailingPartial.offset
      : effectiveOffset + fileBuffer.length;

    return { events: parsed.events, nextOffset, generation: currentGeneration };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { events: [], nextOffset: 0, generation: currentGeneration };

    logger.warn("Failed to read event cursor source", {
      source: source.kind,
      runId: source.kind === "run" ? source.runId : undefined,
      error: String(err),
    });
    return { events: [], nextOffset: safeOffset, generation: currentGeneration };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read the most recent N events from the global events file.
 *
 * Uses fd-based tail-window reading instead of readFileSync so that
 * reading the last ~40 events from a 92 MB file takes constant time.
 * Reads chunks backward from EOF (256 KB at a time) up to a 4 MB cap,
 * stopping early once enough valid JSONL records have been found.
 *
 * Classification matches every other reader (parseJsonlEventBuffer): a torn
 * final line is skipped, a pre-window partial (the window started mid-line)
 * is skipped without being reported, and interior corrupt lines are reported
 * with their absolute file offset while all valid events are still returned.
 */
export function getRecentEvents(limit = 50): TamanduaEvent[] {
  const globalFile = getGlobalEventsFile();
  let fd: number | undefined;
  try {
    fd = fs.openSync(globalFile, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) return [];

    let windowStart = fileSize;
    const chunks: Buffer[] = [];
    let totalRead = 0;

    // Parse the accumulated window. When the window does not begin at byte 0
    // it starts mid-line; the bytes before the first newline are a
    // pre-window partial, never a corrupt line, so the parse is aligned to
    // the first complete line.
    const evaluate = (): ParsedJsonlEventBuffer | null => {
      const buffer = Buffer.concat(chunks);
      let regionStart = 0;
      if (windowStart > 0) {
        const firstNewline = buffer.indexOf(0x0A);
        if (firstNewline === -1) return null; // no complete line yet
        regionStart = firstNewline + 1;
      }
      return parseJsonlEventBuffer(buffer.subarray(regionStart), windowStart + regionStart);
    };

    let parsed: ParsedJsonlEventBuffer | null = null;
    // Read backwards in TAIL_CHUNK_SIZE chunks until we have at least
    // `limit` valid JSONL events, we hit the file start, or we reach
    // the MAX_TAIL_READ cap.
    while (totalRead < MAX_TAIL_READ && windowStart > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, windowStart);
      const readStart = windowStart - readSize;

      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, readStart);
      chunks.unshift(buf);
      windowStart = readStart;
      totalRead += readSize;

      parsed = evaluate();
      if (parsed && parsed.events.length >= limit) break;
    }

    // Final classification of the complete window.
    parsed = evaluate();
    if (!parsed) return [];
    reportCorruptEventLines(globalFile, parsed.corrupt);

    return parsed.events.slice(-limit);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read global events", { error: String(err) });
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // fd may already be closed
      }
    }
  }
}

/**
 * Read events for a specific run.
 *
 * When limit is provided, reads only the last N valid JSON lines from the
 * per-run events file using an efficient byte-offset scan from end-of-file,
 * without reading and parsing the entire file.
 *
 * When limit is omitted, reads all events (unchanged behaviour).
 *
 * Both paths classify through parseJsonlEventBuffer: a torn final line is
 * ignored (an in-progress write is re-read once complete) and interior
 * corrupt lines are reported with their file offset while every valid event
 * is still returned.
 */
export function getRunEvents(runId: string, limit?: number): TamanduaEvent[] {
  const runFile = getEventsFile(runId);

  // Bounded tail-read path
  if (limit !== undefined && limit > 0) {
    return tailRunEvents(runFile, limit);
  }

  // Unbounded full-read path — existing behaviour
  try {
    const fileBuffer = fs.readFileSync(runFile);
    const parsed = parseJsonlEventBuffer(fileBuffer, 0);
    reportCorruptEventLines(runFile, parsed.corrupt);
    return parsed.events;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read run events", { runId, error: String(err) });
    return [];
  }
}

/**
 * Read the last `limit` valid JSON events from a JSONL file using a
 * byte-offset tail scan.  This avoids parsing the entire file.
 *
 * The window is line-aligned (it starts just after a newline), so the only
 * segments the parser can classify are real complete lines plus — when the
 * writer died mid-write — the torn final line, which is skipped and reported
 * as a trailing partial rather than a corrupt line. Interior corrupt lines
 * inside the window are reported with their absolute file offset.
 */
function tailRunEvents(filePath: string, limit: number): TamanduaEvent[] {
  let fileBuffer: Buffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    // EISDIR or anything else — return empty
    return [];
  }

  if (fileBuffer.length === 0) return [];

  // Find the byte offset at which a window holding at least `limit` complete
  // lines begins by counting newlines backwards from EOF. Landing just after
  // a newline keeps the window line-aligned, so no correct line is ever
  // sliced in half and mistaken for a corrupt one.
  let windowStart = 0;
  let newlines = 0;
  for (let i = fileBuffer.length - 1; i >= 0; i--) {
    if (fileBuffer[i] === 0x0A) {
      newlines++;
      if (newlines > limit) {
        windowStart = i + 1;
        break;
      }
    }
  }

  const parsed = parseJsonlEventBuffer(fileBuffer.subarray(windowStart), windowStart);
  reportCorruptEventLines(filePath, parsed.corrupt);
  return parsed.events.slice(-limit);
}

/**
 * Fast-count non-empty lines in the per-run events file without JSON-parsing
 * every line. Returns 0 for nonexistent / empty / directory files.
 */
export function countRunEvents(runId: string): number {
  const runFile = getEventsFile(runId);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(runFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return 0;
    return 0;
  }

  // Directory instead of file
  if (stats.isDirectory()) return 0;

  // Empty file
  if (stats.size === 0) return 0;

  let content: string;
  try {
    content = fs.readFileSync(runFile, "utf-8");
  } catch {
    return 0;
  }

  // Count non-empty lines — the same filter used by getRunEvents (trim + filter Boolean)
  return content.trim().split("\n").filter(Boolean).length;
}

/**
 * Get the path to the events directory.
 */
export function getEventsPath(): string {
  return getEventsDir();
}

// ── Webhook Support ──────────────────────────────────────────────────

/**
 * Fire-and-forget POST to the webhook URL configured for a run.
 * Looks up the notify_url from the runs table.
 * Does not throw — webhook failures are logged and swallowed.
 */
async function fireWebhook(evt: TamanduaEvent): Promise<void> {
  // Only notify on significant events to avoid flooding
  const significantEvents = new Set([
    "run.started",
    "run.completed",
    "run.failed",
    "run.canceled",
    "step.failed",
    "step.worker_lost",
    "step.ceiling_expiry",
    "pipeline.advanced",
  ]);

  if (!significantEvents.has(evt.event)) return;

  let notifyUrl: string | undefined;

  // Try to look up notify_url from the DB
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT notify_url FROM runs WHERE id = ?")
      .get(evt.runId) as { notify_url: string | null } | undefined;
    notifyUrl = row?.notify_url ?? undefined;
  } catch {
    // DB might not be available — skip webhook
    return;
  }

  if (!notifyUrl) return;

  const payload = JSON.stringify(evt);

  // Use global fetch (Node 18+)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);
  } catch (err) {
    // Fire-and-forget: log and move on
    logger.warn("Webhook POST failed", {
      url: notifyUrl,
      event: evt.event,
      runId: evt.runId,
      error: String(err),
    });
  }
}
