// O7 — event-train reading primitives (torture-test only; STORM-O7).
//
// Read-only, dependency-free helpers for parsing native tamandua JSONL event
// streams (the global `all.jsonl` train with its rotated archives, per-run
// `<runId>.jsonl` streams, and the empty-runId `events/.jsonl` stream) while
// preserving original bytes, line identity, and stream order. Every helper
// here treats the stream as IMMUTABLE evidence: nothing is written, nothing
// is reordered, malformed lines are surfaced with their exact byte hash, and
// no line is ever "repaired".
//
// Line identity is the pair (sourceFileId, lineIndex) — 1-based line number
// within one captured file. The global train is the ordered concatenation
// oldest-archive → newest-archive → live file (all.jsonl.N … all.jsonl.1 →
// all.jsonl), which reconstructs the physical append order the native emitter
// produced across rotations.

import { createHash } from 'node:crypto';

export const NOISE_EVENTS = Object.freeze(['run.nudged', 'agent.nudged', 'agent.nudge.skipped']);

export const RUN_TERMINAL_EVENTS = Object.freeze([
  'run.completed',
  'run.failed',
  'run.canceled',
  'run.deleted',
  'run.force_failed',
]);

export const CLAIM_MARKER_EVENTS = Object.freeze(['step.running', 'dispatch.render.validated']);

export const RESUME_MARKER_EVENTS = Object.freeze([
  'run.resumed',
  'run.resume_requested',
  'run.drain_cancelled_by_resume',
]);

export const RETRY_MARKER_EVENTS = Object.freeze([
  'step.retry',
  'step.pending',
  'step.repended',
  'step.respawned',
  'step.rerouted',
  'story.started',
  'story.done',
]);

/**
 * Hash a raw byte slice as lowercase hex sha256.
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse one captured JSONL file into an ordered event list.
 *
 * @param {string} sourceId - stable identity of the captured file
 * @param {Buffer|string} bytes - exact original bytes of the captured file
 * @returns {{events: Array, malformed: Array, lineCount: number, byteLength: number,
 *            endsWithNewline: boolean, lastLineLength: number}}
 *
 * Every line is classified as either a valid event (parsed object) or a
 * malformed record. `events[i]` carries `{event, lineIndex, byteLength,
 * rawSha256}` provenance; `malformed[i]` carries `{lineIndex, byteLength,
 * rawSha256, reason}`. A non-empty final line without a trailing newline is
 * reported through `endsWithNewline`/`lastLineLength` so callers can decide
 * (the native emitter always terminates lines with "\n", so a missing final
 * newline is a partial-write / truncation signal).
 */
export function parseEventStream(sourceId, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const events = [];
  const malformed = [];
  let lineCount = 0;
  let lastLineLength = 0;
  let endsWithNewline = buf.length === 0 || buf[buf.length - 1] === 0x0a;
  let cursor = 0;
  while (cursor < buf.length) {
    const newlineIndex = buf.indexOf(0x0a, cursor);
    let end;
    if (newlineIndex === -1) {
      end = buf.length;
    } else {
      end = newlineIndex;
    }
    const slice = buf.subarray(cursor, end);
    lineCount += 1;
    lastLineLength = slice.length;
    // Tolerate a trailing \r (the native cursor reader strips \r before parse).
    const text = slice.length > 0 && slice[slice.length - 1] === 0x0d
      ? slice.subarray(0, slice.length - 1).toString('utf8')
      : slice.toString('utf8');
    if (text.trim().length > 0) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const record = {
        sourceId,
        lineIndex: lineCount,
        byteLength: slice.length,
        rawSha256: sha256Hex(slice),
      };
      const isNativeShape = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof parsed.event === 'string' && parsed.event.length > 0
        && typeof parsed.ts === 'string' && parsed.ts.length > 0
        && typeof parsed.runId === 'string';
      if (isNativeShape) {
        events.push({ event: parsed, ...record });
      } else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        malformed.push({ ...record, reason: 'not-a-native-event' });
      } else {
        malformed.push({ ...record, reason: 'not-a-json-object' });
      }
    } else if (text.length > 0) {
      // Whitespace-only line: native emitter never writes these; surface as
      // malformed so the caller can decide (gate evidence is written by the
      // native emitter, so this is a tamper/foreign-write signal).
      malformed.push({
        sourceId,
        lineIndex: lineCount,
        byteLength: slice.length,
        rawSha256: sha256Hex(slice),
        reason: 'blank-line',
      });
    }
    if (newlineIndex === -1) break;
    cursor = newlineIndex + 1;
  }
  return { events, malformed, lineCount, byteLength: buf.length, endsWithNewline, lastLineLength };
}

/**
 * Assemble the ordered global train from captured members.
 *
 * @param {Array<{fileId: string, kind: 'archive'|'live', archiveIndex?: number,
 *                parsed: ReturnType<typeof parseEventStream>}>} segments
 * @returns {{events: Array, malformed: Array}} ordered oldest → newest
 *
 * `events` entries additionally carry `segment` (the segment kind/index) and
 * the original per-file line index, so downstream checks can name exactly
 * where in the train a record lives.
 */
export function assembleGlobalTrain(segments) {
  const sorted = [...segments].sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === 'archive' ? -1 : 1; // archives before live
  });
  // Archives: higher index = older (all.jsonl.3 is older than all.jsonl.1).
  const ordered = [...sorted.filter((s) => s.kind === 'archive')].sort((a, b) => (b.archiveIndex ?? 0) - (a.archiveIndex ?? 0));
  ordered.push(...sorted.filter((s) => s.kind === 'live'));
  const events = [];
  const malformed = [];
  for (const segment of ordered) {
    for (const entry of segment.parsed.events) {
      events.push({ ...entry, segment: segment.kind === 'archive' ? `archive:${segment.archiveIndex}` : 'live' });
    }
    for (const entry of segment.parsed.malformed) {
      malformed.push({ ...entry, segment: segment.kind === 'archive' ? `archive:${segment.archiveIndex}` : 'live' });
    }
  }
  return { events, malformed };
}

/**
 * Verify that `subsequence` lines appear in `train` in the same relative
 * order (a per-run stream must be a subsequence of the global train because
 * the native emitter appends the per-run copy and the global copy for each
 * event in the same process order).
 *
 * Returns the list of indices into `train` matched for each subsequence line
 * (strictly increasing), or null when the subsequence cannot be matched
 * (missing member or reordered stream). Lines are compared on their raw
 * sha256 to preserve byte fidelity; when the same line legitimately appears
 * more than once in the train (byte-identical duplicate records — itself an
 * anomaly), greedy left-to-right matching is used.
 */
export function subsequenceMatch(subsequence, train) {
  // Build a map from rawSha256 → queue of train indices.
  const byHash = new Map();
  train.forEach((entry, index) => {
    if (!byHash.has(entry.rawSha256)) byHash.set(entry.rawSha256, []);
    byHash.get(entry.rawSha256).push(index);
  });
  const matched = [];
  let cursor = -1;
  for (const entry of subsequence) {
    const queue = byHash.get(entry.rawSha256);
    if (!queue) return null;
    let chosen = -1;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate > cursor) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === -1) return null;
    cursor = chosen;
    matched.push(chosen);
  }
  return matched;
}

/**
 * Detect byte-identical duplicate lines WITHIN one stream file (the physical
 * copies a single append should never repeat). Returns the duplicates as
 * pairs [{lineIndex}, {lineIndex}] in first-seen order.
 */
export function duplicateLinesWithin(parsed) {
  const seen = new Map(); // rawSha256 → first event/malformed entry
  const duplicates = [];
  for (const entry of [...parsed.events, ...parsed.malformed]) {
    const key = entry.rawSha256;
    if (seen.has(key)) {
      duplicates.push({ firstLineIndex: seen.get(key), secondLineIndex: entry.lineIndex, rawSha256: key });
    } else {
      seen.set(key, entry.lineIndex);
    }
  }
  return duplicates;
}

/**
 * True when the parsed value carries a `runId` field that is a non-empty
 * string.
 */
export function hasBoundRunId(event) {
  return typeof event.runId === 'string' && event.runId.length > 0;
}

export function eventRunId(event) {
  return typeof event.runId === 'string' ? event.runId : '';
}
