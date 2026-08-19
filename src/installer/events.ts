import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePiStateDir } from "./paths.js";
import { logger } from "../lib/logger.js";
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

export type CheckoutRefreshOutcome =
  | "refreshed"
  | "already-coherent"
  | "not-applicable"
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
  abandonedCount?: number;
  tokenDelta?: number;
  tokensSpent?: number;
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
 * emitEvent appendFileSync call will implicitly create it.
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
  const line = JSON.stringify(evt) + "\n";

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

  // Write to run-specific events file
  const runFile = getEventsFile(evt.runId);
  try {
    fs.appendFileSync(runFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write run event", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  }

  // Write to global events file — rotate after if the file now exceeds the cap
  const globalFile = getGlobalEventsFile();
  try {
    fs.appendFileSync(globalFile, line, "utf-8");
    globalFileSizeEstimate += Buffer.byteLength(line);
    if (globalFileSizeEstimate > MAX_EVENTS_FILE_SIZE) {
      rotateGlobalEventsFile();
      // rotateGlobalEventsFile now correctly updates the estimate on
      // all branches (no-op: sets to actual stat size; rotated: 0;
      // ENOENT: 0). No need to reset here.
    }
  } catch (err) {
    logger.warn("Failed to write global event", {
      event: evt.event,
      error: String(err),
    });
  }

  // Fire-and-forget webhook if applicable
  fireWebhook(evt).catch((err) => {
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

/**
 * Read events appended after a byte offset from either:
 * - ~/.tamandua/events/all.jsonl (global)
 * - ~/.tamandua/events/<runId>.jsonl (per-run)
 *
 * Returns only complete newline-terminated records and the next cursor offset.
 * Malformed JSON lines are skipped safely.
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

    let cursor = 0;
    const events: TamanduaEvent[] = [];

    while (cursor < fileBuffer.length) {
      const newlineIndex = fileBuffer.indexOf(0x0A, cursor);
      if (newlineIndex === -1) break; // trailing partial line

      const lineBuffer = fileBuffer.subarray(cursor, newlineIndex);
      cursor = newlineIndex + 1;

      if (lineBuffer.length === 0) continue;

      const line = lineBuffer.toString("utf-8").replace(/\r$/, "");
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          events.push(parsed as TamanduaEvent);
        }
      } catch {
        // Ignore malformed JSONL rows so later valid events still stream.
      }
    }

    return { events, nextOffset: effectiveOffset + cursor, generation: currentGeneration };
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
 * stopping early once enough complete JSONL records have been found.
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
    let buffer = "";
    let totalRead = 0;

    // Read backwards in TAIL_CHUNK_SIZE chunks until we have at least
    // `limit` valid JSONL events, we hit the file start, or we reach
    // the MAX_TAIL_READ cap.
    while (totalRead < MAX_TAIL_READ && windowStart > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, windowStart);
      windowStart -= readSize;

      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, windowStart);
      buffer = buf.toString("utf-8") + buffer;
      totalRead += readSize;

      // If the window starts after byte 0 the first line in `buffer`
      // may be a partial line (we read starting mid-line).  Skip it.
      let parseStart = 0;
      if (windowStart > 0) {
        const firstNewline = buffer.indexOf("\n");
        if (firstNewline === -1) continue; // still no complete line
        parseStart = firstNewline + 1;
      }

      const parseable = buffer.slice(parseStart);
      const lines = parseable.split("\n").filter((l) => l.length > 0);

      let validCount = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") validCount++;
        } catch {
          // skip malformed lines
        }
      }

      if (validCount >= limit) break;
    }

    // Final parse: skip initial partial line, extract valid events,
    // and return the last `limit`.
    let parseStart = 0;
    if (windowStart > 0) {
      const firstNewline = buffer.indexOf("\n");
      if (firstNewline !== -1) parseStart = firstNewline + 1;
    }

    const eventLines = buffer.slice(parseStart).split("\n").filter((l) => l.length > 0);
    const events: TamanduaEvent[] = [];
    for (const line of eventLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          events.push(parsed as TamanduaEvent);
        }
      } catch {
        // skip malformed lines
      }
    }

    return events.slice(-limit);
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
 */
export function getRunEvents(runId: string, limit?: number): TamanduaEvent[] {
  const runFile = getEventsFile(runId);

  // Bounded tail-read path
  if (limit !== undefined && limit > 0) {
    return tailRunEvents(runFile, limit);
  }

  // Unbounded full-read path — existing behaviour
  try {
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as TamanduaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is TamanduaEvent => e !== null);
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

  // Scan backwards from EOF to collect at most `limit` complete lines.
  const lines: string[] = [];
  let end = fileBuffer.length;

  while (lines.length < limit && end > 0) {
    // Find the start of the next newline-terminated segment going backwards.
    let nl = end - 1;
    while (nl >= 0 && fileBuffer[nl] !== 0x0A) nl--;

    let line: string;
    if (nl < 0) {
      // Reached beginning of file — extract the first (non-\n-prefixed) line.
      line = fileBuffer.toString("utf-8", 0, end).replace(/\r$/, "");
    } else if (nl + 1 < end) {
      line = fileBuffer.toString("utf-8", nl + 1, end).replace(/\r$/, "");
    } else {
      // Empty line (consecutive newlines) — skip.
      end = nl;
      continue;
    }

    if (line) lines.unshift(line);

    if (nl < 0) break; // exhausted the file

    end = nl;
  }

  // Parse and filter out malformed lines.
  const result: TamanduaEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        result.push(parsed as TamanduaEvent);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return result;
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
