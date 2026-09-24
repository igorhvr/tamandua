/**
 * Run event stream collector (DIAG-PRUNE US-004).
 *
 * Assembles everything the event stream knows about ONE run so a bug report
 * can carry an ordered timeline: the run-scoped file plus the matching lines
 * that survived in the shared global file (`all.jsonl`) and its rotations.
 *
 * Contract:
 *
 *  1. READ-ONLY. No file is created, truncated or re-written; no daemon is
 *     contacted. The collector works while the daemon is running and while it
 *     is stopped.
 *  2. Sources are read in chronological order: first
 *     `<stateDir>/events/<bareRunId>.jsonl`, then the global file oldest
 *     rotation to newest (`all.jsonl.<MAX>`, …, `all.jsonl.1`, `all.jsonl`).
 *  3. Global lines are filtered to events whose `runId` matches the bare id or
 *     its `run-`-prefixed spelling — the shared file holds every run.
 *  4. Duplicate lines are dropped by exact raw line (an event is written to
 *     both the run-scoped and the global file, so it must appear once).
 *  5. Classification is delegated to the canonical
 *     {@link parseJsonlEventBuffer}; corrupt interior lines are reported,
 *     torn trailing lines are ignored, and nothing is ever thrown.
 *  6. A missing source is `status: 'absent'`, a source with no run events is
 *     `'empty'`; both are explicit and never exceptions.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_ROTATED_EVENTS_FILES,
  parseJsonlEventBuffer,
  type CorruptEventLine,
  type TamanduaEvent,
} from "../installer/events.js";
import { stripIdPrefix } from "../lib/id-prefix.js";
import type {
  CorruptEventRecord,
  RunEventsCollection,
  SourceStatus,
} from "./types.js";

export interface CollectRunEventsOptions {
  /** Effective tamandua state dir (contains `events/`). */
  stateDir: string;
  /** Run id as stored on disk (the `run-` prefix is tolerated and stripped). */
  bareRunId: string;
}

/** The events dir name under the state dir (mirrors `src/installer/events.ts`). */
const EVENTS_DIR_NAME = "events";
/** Basename of the shared global event file. */
const GLOBAL_EVENTS_BASENAME = "all.jsonl";

/** One complete newline-terminated line of a source file. */
interface RawLine {
  /** Exact bytes of the line, excluding its terminating newline. */
  raw: string;
  /** Byte offset of the line start within its file. */
  start: number;
}

/**
 * Enumerate the complete newline-terminated lines of a buffer, in file order.
 * The final unterminated segment (a torn write) is deliberately not yielded.
 */
function* completeLines(buf: Buffer): Generator<RawLine> {
  let cursor = 0;
  while (cursor < buf.length) {
    const newline = buf.indexOf(0x0a, cursor);
    if (newline === -1) break;
    yield { raw: buf.toString("utf-8", cursor, newline), start: cursor };
    cursor = newline + 1;
  }
}

/**
 * True for the lines {@link parseJsonlEventBuffer} skips silently: an empty
 * line or a bare CR. Those carry no event and must not consume an event slot
 * while walking the parsed result.
 */
function isSkippedLine(raw: string): boolean {
  return raw.length === 0 || raw === "\r";
}

/** Candidate source files, in read order (run-scoped, then global oldest→newest). */
function candidateSourceFiles(stateDir: string, bare: string): {
  runFile: string;
  globalFiles: string[];
} {
  const eventsDir = path.join(stateDir, EVENTS_DIR_NAME);
  const globalFiles: string[] = [];
  for (let i = MAX_ROTATED_EVENTS_FILES; i >= 1; i--) {
    globalFiles.push(path.join(eventsDir, `${GLOBAL_EVENTS_BASENAME}.${i}`));
  }
  globalFiles.push(path.join(eventsDir, GLOBAL_EVENTS_BASENAME));
  return {
    runFile: path.join(eventsDir, `${bare}.jsonl`),
    globalFiles,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collect one run's event stream across the run-scoped file and the rotated
 * global files. Read-only and total: every failure mode is reported in the
 * result, never thrown.
 */
export function collectRunEvents(
  options: CollectRunEventsOptions,
): RunEventsCollection {
  const stateDir = options.stateDir ?? "";
  const bare = stripIdPrefix(String(options.bareRunId ?? "").trim());
  const prefixed = `run-${bare}`;

  const events: TamanduaEvent[] = [];
  const corrupt: CorruptEventRecord[] = [];
  const files: string[] = [];
  const reasons: string[] = [];
  const seenLines = new Set<string>();

  const { runFile, globalFiles } = candidateSourceFiles(stateDir, bare);

  const matchesRun = (event: TamanduaEvent): boolean => {
    const runId = (event as { runId?: unknown }).runId;
    return typeof runId === "string" && (runId === bare || runId === prefixed);
  };

  const readSource = (filePath: string, isGlobal: boolean): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") reasons.push(`${filePath}: ${errorMessage(error)}`);
      return;
    }
    if (!stat.isFile()) return;

    files.push(filePath);

    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch (error) {
      reasons.push(`${filePath}: ${errorMessage(error)}`);
      return;
    }
    if (buf.length === 0) return;

    // The canonical parser decides exactly which lines are valid events,
    // which are interior corrupt lines, and which final segment is a torn
    // partial. Matching its corrupt offsets back to the raw line walk keeps
    // the classification in one place.
    const parsed = parseJsonlEventBuffer(buf, 0);
    const corruptByOffset = new Map<number, CorruptEventLine>();
    for (const line of parsed.corrupt) corruptByOffset.set(line.offset, line);

    let eventIndex = 0;
    for (const line of completeLines(buf)) {
      if (isSkippedLine(line.raw)) continue;

      const corruptLine = corruptByOffset.get(line.start);
      if (corruptLine !== undefined) {
        if (seenLines.has(line.raw)) continue;
        seenLines.add(line.raw);
        corrupt.push({
          file: filePath,
          offset: corruptLine.offset,
          length: corruptLine.length,
          preview: corruptLine.preview,
        });
        continue;
      }

      const event = parsed.events[eventIndex++];
      if (event === undefined) continue;

      // The shared global file carries every run's events; keep only ours.
      if (isGlobal && !matchesRun(event)) continue;

      if (seenLines.has(line.raw)) continue;
      seenLines.add(line.raw);
      events.push(event);
    }
  };

  readSource(runFile, false);
  for (const globalFile of globalFiles) readSource(globalFile, true);

  const status: SourceStatus =
    files.length === 0 ? "absent" : events.length === 0 ? "empty" : "present";

  if (files.length === 0) {
    reasons.push(
      `no event source files present under ${path.join(stateDir, EVENTS_DIR_NAME)}`,
    );
  }

  return {
    status,
    ...(reasons.length > 0 ? { absenceReason: reasons.join("; ") } : {}),
    files,
    events,
    corrupt,
  };
}