/**
 * Launch-time harness probe policy (IFLB).
 *
 * The dispatch motor used to discover a launch-broken harness only through
 * consecutive instant-fail rounds (RSPN): pi exiting in ~300ms with
 * "No API key found for the selected model" after the scenario invalidated
 * the copied credentials, dsh exiting in 100–500ms with a boot error under
 * the contained daemon — and then backed off forever, leaving the run
 * `running` with its first step `pending` and no legible failure. This
 * module owns the launch-time PROBE that replaces that blind loop: at a
 * run's first real dispatch the harness is asked to run the exact command
 * `<launcher> skill-path` and reply with the PATH; the daemon computes the
 * expected value itself by running the same command, and the probe passes
 * only when the harness's final message contains that path as a whole line
 * or token. Anything else (wrong output, non-zero exit, signal death, wall
 * exceeded) fails the run immediately and legibly through the mechanical
 * keyline block produced by buildHarnessProbeFailureBlock().
 *
 * This module is deliberately pure and self-contained — policy constants,
 * prompt building, config getters, expected-value computation, message
 * normalization, pass evaluation, the round evaluator, the failure keyline
 * block, and the once-per-run DB helpers — mirroring the conventions of
 * src/installer/instant-fail.ts and src/installer/paths.ts, so the
 * dispatch-motor wiring story stays thin and every edge case is testable
 * without spawning harnesses.
 *
 * Exactly ONE probe runs per run (never per step or per agent): the DB
 * helpers below persist the outcome on the runs row
 * (harness_probe_status / harness_probe_at) so a daemon restart does not
 * re-probe a run that already passed.
 */

import { spawnSync } from "node:child_process";
import { getDb } from "../db.js";
import { resolveTamanduaCli } from "./paths.js";

// ── Probe contract constants ────────────────────────────────────────

/**
 * Stable marker line that opens every probe prompt. Harness-facing
 * runtimes (scripted fakes and real model harnesses) recognize this exact
 * first line and answer with the requested path.
 */
export const HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path";

/**
 * Default wall-clock budget for one probe round (ms). Exceeding it is a
 * probe failure. Override: TAMANDUA_HARNESS_PROBE_WALL_MS.
 */
export const DEFAULT_HARNESS_PROBE_WALL_MS = 180_000;

/** OBSERVED value cap (characters) in the failure keyline block. */
export const HARNESS_PROBE_OBSERVED_MAX_CHARS = 400;

/** STDERR_TAIL value cap (characters) in the failure keyline block. */
export const HARNESS_PROBE_STDERR_TAIL_MAX_CHARS = 2000;

/** Persisted once-per-run probe status on the runs row (runs.harness_probe_status). */
export type HarnessProbeStatus = "probing" | "ok" | "failed";

// ── Config getters (env overrides for tests/ops) ────────────────────

function readEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Whether the launch-time harness probe is enabled. Default enabled; the
 * operator escape hatch `TAMANDUA_HARNESS_PROBE=0` disables it.
 */
export function isHarnessProbeEnabled(): boolean {
  return process.env.TAMANDUA_HARNESS_PROBE?.trim() !== "0";
}

/** Probe wall budget (ms). Override: TAMANDUA_HARNESS_PROBE_WALL_MS (positive int, fallback on invalid). */
export function getHarnessProbeWallMs(): number {
  return readEnvPositiveInt("TAMANDUA_HARNESS_PROBE_WALL_MS", DEFAULT_HARNESS_PROBE_WALL_MS);
}

// ── Probe prompt / command ──────────────────────────────────────────

/**
 * The exact command the harness must run: the absolute CLI launcher (never
 * a bare `tamandua` that depends on the agent shell's PATH) followed by
 * `skill-path`.
 */
export function buildHarnessProbeCommand(): string {
  return `${resolveTamanduaCli()} skill-path`;
}

/**
 * Build the probe prompt. Line 1 is the stable marker; line 2 instructs
 * the harness to run the exact `<launcher> skill-path` command and reply
 * with the PATH and nothing else.
 */
export function buildHarnessProbePrompt(): string {
  return `${HARNESS_PROBE_MARKER}\nRun the exact command "${buildHarnessProbeCommand()}" and reply with the PATH and nothing else.`;
}

// ── Expected-value computation ──────────────────────────────────────

export interface ExpectedHarnessProbePathResult {
  /** True when the command exited 0 and produced a non-empty trimmed stdout path. */
  ok: boolean;
  /** The trimmed stdout path when ok; absent otherwise. */
  path?: string;
  /** Exit code of the child (null when killed by a signal or never launched). */
  exitCode?: number | null;
  /** Signal that killed the child, if any. */
  signal?: string | null;
  /** True when the child was killed by the probe wall budget. */
  timedOut?: boolean;
  /** Best-effort sanitized stderr tail (capped at HARNESS_PROBE_STDERR_TAIL_MAX_CHARS). */
  stderrTail?: string;
}

/**
 * Compute the expected probe path by executing the very same command the
 * harness must run (`<launcher> skill-path`) as a child process with the
 * same environment the harness receives. Non-zero exit (or a launch
 * failure) makes the probe impossible — the result is a failure the caller
 * must surface (ok: false).
 */
export function computeExpectedHarnessProbePath(
  env: Record<string, string | undefined>,
  cwd: string,
): ExpectedHarnessProbePathResult {
  const launcher = resolveTamanduaCli();
  let result;
  try {
    result = spawnSync(launcher, ["skill-path"], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: getHarnessProbeWallMs(),
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stderrTail: `launch failed: ${String(err)}`,
    };
  }

  const exitCode = result.status;
  const signal = result.signal;
  const spawnError = result.error as (Error & { killed?: boolean; code?: string }) | undefined;
  const timedOut = Boolean(spawnError?.killed) || spawnError?.code === "ETIMEDOUT";
  const stderrTail = tailChars(stripAnsi(result.stderr ?? ""), HARNESS_PROBE_STDERR_TAIL_MAX_CHARS);

  if (exitCode !== 0) {
    return { ok: false, exitCode: exitCode ?? null, signal: signal ?? null, timedOut, stderrTail };
  }

  const stdout = String(result.stdout ?? "").trim();
  if (stdout.length === 0) {
    return {
      ok: false,
      exitCode,
      signal: signal ?? null,
      timedOut,
      stderrTail: stderrTail || "no stdout from <launcher> skill-path",
    };
  }
  return { ok: true, path: stdout, exitCode: exitCode ?? null, signal: signal ?? null, timedOut };
}

// ── Message normalization and pass evaluation ───────────────────────

/**
 * Normalize the harness's final message before pass evaluation and for the
 * OBSERVED failure field: trim surrounding whitespace and strip markdown
 * code fences / backticks so a fence- or backtick-wrapped path is directly
 * comparable.
 */
export function normalizeHarnessProbeMessage(text: string): string {
  let out = text.trim();
  // Strip a leading code fence (optionally carrying a language tag) …
  out = out.replace(/^\s*```[^\n]*\n?/, "");
  // … and a trailing code fence.
  out = out.replace(/\n?```\s*$/, "");
  // Strip any remaining inline/isolated backticks.
  out = out.replace(/`/g, "");
  return out.trim();
}

/**
 * Pass evaluation: the expected path must appear in the (already
 * normalized) final message as a WHOLE line or a WHOLE token (delimited by
 * line or whitespace). A path glued to other characters (e.g. `…/x.` or
 * `/x-suffix`) never matches — anything else fails.
 */
export function passesHarnessProbe(normalizedMessage: string, expectedPath: string): boolean {
  if (expectedPath.length === 0) return false;
  const lines = normalizedMessage.split(/\r?\n/);
  if (lines.some((line) => line === expectedPath)) return true;
  for (const line of lines) {
    for (const token of line.split(/\s+/)) {
      if (token === expectedPath) return true;
    }
  }
  return false;
}

// ── Round evaluator ─────────────────────────────────────────────────

/** Adapter-shaped result of one probe round (what a harness run produces). */
export interface HarnessProbeAdapterResult {
  /** Raw final output / assistant message of the harness round. */
  output: string;
  /** Sanitized tail of stderr, when the adapter captured one. */
  stderrTail?: string;
  /** Exit code of the harness process (null when killed by a signal). */
  exitCode?: number | null;
  /** Signal that killed the harness process, if any. */
  signal?: string | null;
  /** True when the round was terminated by the wall budget timeout. */
  timedOut?: boolean;
  /** Wall-clock duration of the round in ms, when the adapter measured it. */
  durationMs?: number;
}

/** Everything buildHarnessProbeFailureBlock needs for one failed probe. */
export interface HarnessProbeFailureFields {
  /** The run's harness: pi | hermes | dsh. */
  harness: string;
  /** The exact probe command the harness was asked to run. */
  probeCmd: string;
  /** The expected path (what `<launcher> skill-path` must print). */
  expected: string;
  /** The normalized final message actually observed (capped in the block builder). */
  observed: string;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  durationMs: number | undefined;
  stderrTail: string;
}

export interface HarnessProbeEvalInput {
  harness: string;
  probeCmd: string;
  expectedPath: string;
  /** Wall budget in ms the round was granted (getHarnessProbeWallMs() at the call site). */
  wallMs: number;
  adapter: HarnessProbeAdapterResult;
}

export interface HarnessProbeOutcome {
  passed: boolean;
  /** Present when passed === false: the exact fields for the failure keyline block. */
  failure?: HarnessProbeFailureFields;
}

/**
 * Turn one adapter result plus the wall budget into a pass/fail verdict.
 * Non-zero exit, signal death, wall exceeded (timedOut or durationMs over
 * budget), and wrong output all fail. On failure the returned `failure`
 * fields carry the observed message already normalized.
 */
export function evaluateHarnessProbe(input: HarnessProbeEvalInput): HarnessProbeOutcome {
  const { harness, probeCmd, expectedPath, wallMs, adapter } = input;
  const exitCode = adapter.exitCode ?? null;
  const signal = adapter.signal ?? null;
  const durationMs = adapter.durationMs;
  const observed = normalizeHarnessProbeMessage(adapter.output);

  const failure: HarnessProbeFailureFields = {
    harness,
    probeCmd,
    expected: expectedPath,
    observed,
    exitCode,
    signal,
    durationMs,
    stderrTail: adapter.stderrTail ?? "",
  };

  if (adapter.timedOut === true) return { passed: false, failure };
  if (durationMs !== undefined && durationMs > wallMs) return { passed: false, failure };
  if (exitCode !== null && exitCode !== 0) return { passed: false, failure };
  if (exitCode === null && signal) return { passed: false, failure };
  if (!passesHarnessProbe(observed, expectedPath)) return { passed: false, failure };
  return { passed: true };
}

// ── Failure keyline block ───────────────────────────────────────────

/**
 * Collapse an observed probe message to a single line and cap it at
 * HARNESS_PROBE_OBSERVED_MAX_CHARS. The display form used both inside the
 * mechanical failure keyline block and on run.harness_probe_failed event
 * payloads, so the two never diverge.
 */
export function harnessProbeObservedDisplay(text: string): string {
  return singleLine(text).slice(0, HARNESS_PROBE_OBSERVED_MAX_CHARS);
}

/**
 * Cap a probe stderr tail to the final HARNESS_PROBE_STDERR_TAIL_MAX_CHARS
 * characters (front-trimmed). The display form used both inside the
 * mechanical failure keyline block (as its LAST key) and on
 * run.harness_probe_failed event payloads.
 */
export function harnessProbeStderrTailDisplay(text: string): string {
  return tailChars(text, HARNESS_PROBE_STDERR_TAIL_MAX_CHARS);
}

/**
 * Build the mechanical failure keyline block (GDIA refusal-block
 * convention: one key per line, no prose after the last key). Every key is
 * present in order — FAILURE_CLASS first, STDERR_TAIL last. OBSERVED is
 * collapsed to a single line and capped at HARNESS_PROBE_OBSERVED_MAX_CHARS;
 * STDERR_TAIL (the final key) may stay multi-line and is capped at
 * HARNESS_PROBE_STDERR_TAIL_MAX_CHARS.
 */
export function buildHarnessProbeFailureBlock(fields: HarnessProbeFailureFields): string {
  const observed = harnessProbeObservedDisplay(fields.observed);
  const stderrTail = harnessProbeStderrTailDisplay(fields.stderrTail);
  const lines = [
    "FAILURE_CLASS: harness_unavailable",
    `HARNESS: ${fields.harness}`,
    `PROBE_CMD: ${fields.probeCmd}`,
    `EXPECTED: ${fields.expected}`,
    `OBSERVED: ${observed}`,
    `EXIT_CODE: ${fields.exitCode ?? ""}`,
    `SIGNAL: ${fields.signal ?? ""}`,
    `DURATION_MS: ${fields.durationMs ?? ""}`,
    `STDERR_TAIL: ${stderrTail}`,
  ];
  return lines.join("\n");
}

// ── Once-per-run DB helpers (runs.harness_probe_status / _at) ───────

export interface HarnessProbeReserveOptions {
  /**
   * Wall in ms used to decide when an in-flight 'probing' reservation is
   * stale. Defaults to getHarnessProbeWallMs(). Injectable so tests can
   * exercise staleness without a real 180s wait.
   */
  wallMs?: number;
  /** Epoch-ms clock for the staleness cutoff and reservation stamp. Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Atomically claim the once-per-run probe for a run: the UPDATE only
 * matches rows that are still unprobed (harness_probe_status IS NULL) or
 * whose in-flight 'probing' reservation is stale (older than the probe
 * wall — a daemon crash mid-probe must not wedge the run). Exactly one
 * caller wins per run; 'ok'/'failed' rows never match, so a passed (or
 * definitively failed) run is never re-probed. Returns true when this
 * caller won the reservation.
 */
export function reserveHarnessProbe(
  runId: string,
  opts?: HarnessProbeReserveOptions,
): boolean {
  const db = getDb();
  const wallMs = opts?.wallMs ?? getHarnessProbeWallMs();
  const nowMs = opts?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleBeforeIso = new Date(nowMs - wallMs).toISOString();
  const result = db
    .prepare(
      `UPDATE runs
       SET harness_probe_status = 'probing', harness_probe_at = ?
       WHERE id = ?
         AND (
           harness_probe_status IS NULL
           OR (harness_probe_status = 'probing' AND harness_probe_at IS NOT NULL AND harness_probe_at < ?)
         )`,
    )
    .run(nowIso, runId, staleBeforeIso);
  return result.changes > 0;
}

export interface HarnessProbeRecordOptions {
  /** Epoch-ms clock for the outcome timestamp. Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Record the probe outcome ('ok' | 'failed') on the run with an ISO
 * timestamp. After an 'ok' record the run is never re-probed (reserve will
 * no longer match).
 */
export function recordHarnessProbeResult(
  runId: string,
  status: Exclude<HarnessProbeStatus, "probing">,
  opts?: HarnessProbeRecordOptions,
): void {
  const db = getDb();
  const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();
  db.prepare("UPDATE runs SET harness_probe_status = ?, harness_probe_at = ? WHERE id = ?").run(
    status,
    nowIso,
    runId,
  );
}

/**
 * Read the run's persisted probe status: 'probing' | 'ok' | 'failed', or
 * null when the run has never been probed (or does not exist).
 */
export function readHarnessProbeStatus(runId: string): HarnessProbeStatus | null {
  const row = getDb()
    .prepare("SELECT harness_probe_status FROM runs WHERE id = ?")
    .get(runId) as { harness_probe_status: string | null } | undefined;
  const status = row?.harness_probe_status ?? null;
  return status as HarnessProbeStatus | null;
}

// ── Small text helpers ──────────────────────────────────────────────

const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

/** Collapse any whitespace run (incl. newlines) to a single space and trim. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keep the last `maxChars` characters of `text` (front-trimmed). */
function tailChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}
