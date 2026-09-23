/**
 * Pure classifier for harness stderr.
 *
 * Real harnesses legitimately write some noisy-but-benign lines to stderr:
 *
 *   - dsh prints `reasoning:` trace blocks. Real dsh 0.1.3-alpha.2 emits a
 *     `dsh: reasoning:` header followed by UNINDENTED body lines, so the
 *     static indentation heuristic cannot be the block boundary; a block
 *     runs until a genuine diagnostic closes it.
 *   - hermes prints a `session_id: <id>` trailer at session end by design
 *     (on both the normal-exit and KeyboardInterrupt paths).
 *
 * Logging those at WARN on every round floods the log with false alarms
 * (~958x on one host). The adapters use this classifier to demote
 * benign-only stderr to debug while keeping every genuine line (errors,
 * `fatal:`, truncation diagnostics, unknown text) at WARN.
 *
 * The classifier is pure: it never mutates its input, touches the
 * filesystem, or logs. It must not influence the returned `stderrTail`,
 * exit/signal classification, truncation handling, or hermes sessionRef
 * extraction — it only decides the log level.
 */

import type { HarnessType } from "./types.js";

/** Result of classifying an assembled stderr blob. */
export interface HarnessStderrClassification {
  /**
   * True when no genuine line was found (benign-only or empty/whitespace
   * stderr). Callers log benign stderr at debug.
   */
  benign: boolean;
  /** Non-blank lines carrying genuine signal (errors, diagnostics, unknown text). */
  genuineLines: string[];
  /** Non-blank lines recognized as known-benign harness noise. */
  benignLines: string[];
}

/**
 * A dsh reasoning-block header: `reasoning:` at the start of the line, with
 * an optional `dsh: ` prefix (real dsh 0.1.3-alpha.2 emits
 * `dsh: reasoning:` followed by UNINDENTED body lines). Leading whitespace
 * is tolerated so an indented block still opens.
 */
function isDshReasoningLine(trimmed: string): boolean {
  return /^(?:dsh:\s*)?reasoning:/.test(trimmed);
}

/** The explicit truncation marker the adapters insert between head and tail. */
const TRUNCATION_MARKER_LINE = "[…output truncated…]";

/**
 * A genuine dsh diagnostic: the line that ends an open reasoning block and
 * must stay at WARN. This intentionally covers only clear error signal —
 *   - the truncation marker,
 *   - a `dsh: <non-reasoning>` prefix (e.g. `dsh: E_CREDENTIALS: ...`),
 *   - a Python `Traceback`, an `Error` line, or `fatal:`.
 * Anything else while a reasoning block is open is treated as benign body
 * text, even when UNINDENTED.
 */
function isDshGenuineDiagnostic(trimmed: string): boolean {
  if (trimmed === TRUNCATION_MARKER_LINE) return true;
  if (/^dsh:\s*\S/.test(trimmed)) return true;
  return /^(?:Traceback\b|Error\b|fatal:)/.test(trimmed);
}

/** A hermes `session_id: <id>` trailer line. */
function isHermesSessionIdLine(trimmed: string): boolean {
  return /^session_id:\s*\S+/.test(trimmed);
}

/**
 * Classify the assembled stderr text for a given harness.
 *
 * Rules:
 *   - Empty/whitespace-only stderr => `{ benign: true, genuineLines: [],
 *     benignLines: [] }`.
 *   - dsh: a reasoning header (`reasoning:` or `dsh: reasoning:`) opens a
 *     block; every following non-blank line belongs to it — indented or
 *     not — until a genuine diagnostic (truncation marker, `dsh:`
 *     non-reasoning line, `Traceback`/`Error`/`fatal:`) closes it.
 *   - hermes: `session_id: <id>` trailer lines are benign.
 *   - Everything else (including pi stderr) is genuine.
 */
export function classifyHarnessStderr(
  harness: HarnessType,
  stderr: string,
): HarnessStderrClassification {
  const genuineLines: string[] = [];
  const benignLines: string[] = [];

  if (!stderr) {
    return { benign: true, genuineLines, benignLines };
  }

  let inDshReasoningBlock = false;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    // Blank lines carry no signal and never flip classification. They do
    // not close an open reasoning block (reasoning traces use blank lines
    // between paragraphs).
    if (trimmed === "") {
      continue;
    }

    if (harness === "dsh") {
      if (isDshReasoningLine(trimmed)) {
        benignLines.push(rawLine);
        inDshReasoningBlock = true;
        continue;
      }
      // While a reasoning block is open, only a genuine diagnostic ends
      // it; every other line (indented or not) is benign body text.
      if (inDshReasoningBlock && !isDshGenuineDiagnostic(trimmed)) {
        benignLines.push(rawLine);
        continue;
      }
      inDshReasoningBlock = false;
    }

    if (harness === "hermes" && isHermesSessionIdLine(trimmed)) {
      benignLines.push(rawLine);
      continue;
    }

    genuineLines.push(rawLine);
  }

  return {
    benign: genuineLines.length === 0,
    genuineLines,
    benignLines,
  };
}
