/**
 * Pure classifier for harness stderr.
 *
 * Real harnesses legitimately write some noisy-but-benign lines to stderr:
 *
 *   - dsh prints `reasoning:` trace blocks (the reasoning line plus its
 *     indented continuation/body lines).
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
 * A dsh reasoning-block header: `reasoning:` at the start of the line
 * (leading whitespace tolerated so an indented block still opens).
 */
function isDshReasoningLine(trimmed: string): boolean {
  return trimmed.startsWith("reasoning:");
}

/**
 * A continuation/body line inside a dsh reasoning block: an indented,
 * non-empty line.
 */
function isIndentedContinuation(line: string): boolean {
  return /^\s+\S/.test(line);
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
 *   - dsh: `reasoning:` headers and the indented body lines that belong to
 *     the open reasoning block are benign.
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
      if (inDshReasoningBlock && isIndentedContinuation(rawLine)) {
        benignLines.push(rawLine);
        continue;
      }
      // Any other line ends the reasoning block.
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
