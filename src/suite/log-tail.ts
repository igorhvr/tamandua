/**
 * LEDGER-DIAG-2 US-004 — pure composer for the stored suite-evidence tail.
 *
 * The suite ledger stores a bounded (`LOG_TAIL_KB`) `log_tail` per execution.
 * A naive trailing slice loses the serial-lane failure text, because the
 * serial lane prints first and the parallel lane (usually much larger)
 * pushes it out of the window. `composeLogTail` instead arranges the stored
 * tail so a red result ALWAYS answers "which tests failed":
 *
 *   1. the lane-verdict/summary and per-lane `tests`/`pass`/`fail` counters
 *      (both the intermediate `>>> ... lane: FAILED/PASSED` form and the
 *      final `Serial lane:` / `Parallel lane:` summary form);
 *   2. the complete `✖ failing tests:` block(s), when present (when more
 *      than one lane produced a block and they cannot all fit, the remaining
 *      budget is split fairly across them so no lane's failures vanish);
 *   3. as much of the final raw output as still fits under the cap.
 *
 * Repeated lane markers/counters are deduped while lane order is preserved,
 * and the result never exceeds `capBytes`.
 *
 * This module deliberately imports NOTHING (no `node:child_process`, no
 * heavy dependency) so its test stays in the parallel lane and so the shim
 * can call it on a hot path without paying an import cost. `Buffer` is a
 * Node global and is used only for UTF-8 byte accounting.
 *
 * Nothing here deletes evidence: the full log is persisted separately at
 * `<state dir>/suite-logs/<row id>.log` (US-002/US-003); suites-log pruning is
 * covered later by the evidence-prune work (bead 6sy.69).
 */

/** True when `line` is a per-lane verdict, e.g. `>>> SERIAL lane: FAILED`. */
function isLaneVerdictLine(line: string): boolean {
  // Intermediate wrapper form: ">>> SERIAL lane: FAILED (exit code 1)" and
  // ">>> Serial lane FAILED: test-isolation violations detected".
  if (/^>>>\s+.*\blane\b.*\b(?:PASSED|FAILED)\b/.test(line)) return true;
  // Final summary form: "  Serial lane:   FAILED" / "  Parallel lane: PASSED".
  if (/^\s*(?:Serial|Parallel)\s+lane:\s+(?:PASSED|FAILED)\b/i.test(line)) {
    return true;
  }
  return false;
}

/**
 * True when `line` is a per-lane `tests`/`pass`/`fail` counter. Matches the
 * current `ℹ tests 4290` reporter form and the legacy TAP `# tests 5` form.
 */
function isLaneCounterLine(line: string): boolean {
  return /^\s*[ℹ#]\s*(?:tests|pass|fail)\s+\d+/.test(line);
}

/** True when `line` opens a node-test `✖ failing tests:` block. */
function isFailingTestsMarker(line: string): boolean {
  return /^\s*✖\s*failing tests:\s*$/.test(line);
}

/**
 * Line that terminates a captured failing-tests block. Anything a lane
 * wrapper prints after the node-test reporter's final section belongs to the
 * wrapper, not the block.
 */
function isBlockBoundary(line: string): boolean {
  if (isFailingTestsMarker(line)) return true; // next block starts here
  if (/^>>>/.test(line)) return true; // ">>> SERIAL lane: FAILED ..."
  if (/^={3,}/.test(line)) return true; // "====...", lane/guard separators
  if (/^\s*(?:Serial|Parallel)\s+lane:/.test(line)) return true; // final summary
  if (/^\s*PRLL Test Suite Summary/.test(line)) return true;
  if (/^TESTCMD_/.test(line)) return true;
  if (/^tamandua-test:/.test(line)) return true;
  if (/^TAMANDUA-TEST/.test(line)) return true;
  return false;
}

/** UTF-8 byte length of `s`. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Largest prefix of `s` whose UTF-8 encoding is at most `maxBytes`, never
 * splitting a multi-byte code point.
 */
function takePrefixByBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0 || s.length === 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Largest suffix of `s` whose UTF-8 encoding is at most `maxBytes`, never
 * starting in the middle of a multi-byte code point.
 */
function takeSuffixByBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0 || s.length === 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/**
 * Compose the bounded evidence tail for a suite execution.
 *
 * When `fullOutput` fits within `capBytes` it is returned unchanged (the
 * caller keeps the raw output). Otherwise the tail is composed in the strict
 * priority documented at the top of this file. The returned string never
 * exceeds `capBytes` bytes.
 *
 * @param fullOutput - The complete combined stdout+stderr of the execution.
 * @param capBytes - Maximum size in bytes of the stored tail.
 * @returns The composed tail (or the raw output when it fits).
 */
export function composeLogTail(fullOutput: string, capBytes: number): string {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return "";
  const cap = Math.floor(capBytes);
  if (byteLen(fullOutput) <= cap) return fullOutput;

  const lines = fullOutput.split("\n");
  const consumed = new Array<boolean>(lines.length).fill(false);

  // ── Priority 1: lane verdicts and counters, deduped, in source order ──
  const summaries: string[] = [];
  const seenSummaries = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isLaneVerdictLine(line) && !isLaneCounterLine(line)) continue;
    consumed[i] = true;
    const trimmed = line.trim();
    if (seenSummaries.has(trimmed)) continue;
    seenSummaries.add(trimmed);
    summaries.push(trimmed);
  }

  // ── Priority 2: every complete `✖ failing tests:` block ──
  const failingBlocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isFailingTestsMarker(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isBlockBoundary(lines[end])) end += 1;
    let blockEnd = end;
    while (blockEnd > i && lines[blockEnd - 1].trim() === "") blockEnd -= 1;
    if (blockEnd > i) {
      failingBlocks.push(lines.slice(i, blockEnd).join("\n"));
    }
    for (let k = i; k < end; k += 1) consumed[k] = true;
    i = end - 1;
  }

  // ── Priority 3: the final raw output that precedes the extracted
  // reporter/summary section (its tail, bounded by the byte budget below). ──
  // Taking the region before the first extracted line means the composed
  // tail never repeats an already-emitted lane marker, counter or failing
  // block. When the output has no lane markers at all (plain command output
  // over the cap), the whole output is the raw region and the tail applies.
  let firstConsumed = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed[i]) {
      firstConsumed = i;
      break;
    }
  }
  const rawRegion = firstConsumed === -1
    ? fullOutput
    : lines.slice(0, firstConsumed).join("\n");

  // ── Emit in strict priority order, never exceeding the cap ──
  let out = "";
  const append = (section: string, mode: "prefix" | "suffix"): void => {
    if (section.length === 0) return;
    const sep = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
    const budget = cap - byteLen(out + sep);
    if (budget <= 0) return;
    const sectionBytes = byteLen(section);
    if (sectionBytes <= budget) {
      out = out + sep + section;
      return;
    }
    out = out + sep + (mode === "suffix"
      ? takeSuffixByBytes(section, budget)
      : takePrefixByBytes(section, budget));
  };

  if (summaries.length > 0) append(summaries.join("\n"), "prefix");

  // A single oversized first block must not erase every other lane's block.
  // Split the remaining budget fairly across the captured blocks (water-
  // filling: smaller blocks take only what they need and the freed bytes go
  // to the larger ones). Each block still keeps its informative leading
  // entries, so the tail answers "which tests failed" for every lane.
  if (failingBlocks.length > 0) {
    const remainingForBlocks = Math.max(0, cap - byteLen(out));
    const budgets = allocateBudgets(
      failingBlocks.map((block) => byteLen(block)),
      remainingForBlocks,
    );
    for (let i = 0; i < failingBlocks.length; i += 1) {
      append(takePrefixByBytes(failingBlocks[i], budgets[i]), "prefix");
    }
  }

  if (rawRegion.length > 0) append(rawRegion, "suffix");

  return out;
}

/**
 * Water-filling allocation of `total` bytes across `sizes` consumers.
 * Consumers that fit within their equal share take exactly their size; the
 * remainder is re-split among the rest. When every remaining consumer exceeds
 * the equal share, the share is granted to each so no consumer is starved.
 */
function allocateBudgets(sizes: number[], total: number): number[] {
  const budgets = new Array<number>(sizes.length).fill(0);
  const settled = new Array<boolean>(sizes.length).fill(false);
  let remaining = total;
  let pending = sizes.length;

  while (pending > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending);
    let progressed = false;
    for (let i = 0; i < sizes.length; i += 1) {
      if (settled[i]) continue;
      if (sizes[i] <= share) {
        budgets[i] = sizes[i];
        remaining -= sizes[i];
        settled[i] = true;
        pending -= 1;
        progressed = true;
      }
    }
    if (!progressed) {
      for (let i = 0; i < sizes.length; i += 1) {
        if (!settled[i]) budgets[i] = share;
      }
      break;
    }
  }
  return budgets;
}