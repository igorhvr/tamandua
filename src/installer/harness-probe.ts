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
import { isOlderThan } from "../lib/instant.js";
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

/** IMAGE / IMAGE_DIGEST value cap (characters) in the failure keyline block. */
export const HARNESS_PROBE_IMAGE_MAX_CHARS = 200;

/** HINT value cap (characters) in the failure keyline block. */
export const HARNESS_PROBE_HINT_MAX_CHARS = 512;

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
  /**
   * MTLK-DIAG: the operator-requested image tag of the Matchlock round the
   * probe failed on. Set ONLY by the Matchlock probe paths (pi/hermes/dsh);
   * a native (non-Matchlock) probe never sets it, so its block stays
   * byte-identical.
   */
  imageName?: string;
  /**
   * MTLK-DIAG: the immutable resolved image digest from the pinned policy.
   * Rendered only when non-empty — omitted (never fabricated) for legacy
   * policies that carry no `resolvedImageDigest`.
   */
  imageDigest?: string;
  /**
   * MTLK-DIAG: bounded, evidence-confidenced single-line guidance
   * (matchlockProbeHint). Optional: an unclassified failure renders none.
   */
  hint?: string;
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
 *
 * MTLK-DIAG: a Matchlock probe failure additionally renders IMAGE,
 * IMAGE_DIGEST (only when the pinned policy carries a resolved digest) and
 * HINT (only when the captured evidence classifies — see matchlockProbeHint)
 * between DURATION_MS and the final STDERR_TAIL key. A native probe never sets
 * those fields, so its block is byte-identical to before.
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
    ...matchlockIdentityKeyLines(fields),
    `STDERR_TAIL: ${stderrTail}`,
  ];
  return lines.join("\n");
}

/**
 * Render the optional MTLK-DIAG keylines (IMAGE / IMAGE_DIGEST / HINT) that
 * precede the final STDERR_TAIL key. Every value passes the single-line,
 * control-character-free sanitizer and its own cap; an absent/empty value
 * renders NO line at all (never an empty `IMAGE:` placeholder, never a
 * fabricated digest).
 */
function matchlockIdentityKeyLines(fields: HarnessProbeFailureFields): string[] {
  const out: string[] = [];
  const imageName = harnessProbeKeyValueDisplay(fields.imageName, HARNESS_PROBE_IMAGE_MAX_CHARS);
  if (imageName.length > 0) out.push(`IMAGE: ${imageName}`);
  const imageDigest = harnessProbeKeyValueDisplay(fields.imageDigest, HARNESS_PROBE_IMAGE_MAX_CHARS);
  if (imageDigest.length > 0) out.push(`IMAGE_DIGEST: ${imageDigest}`);
  const hint = harnessProbeKeyValueDisplay(fields.hint, HARNESS_PROBE_HINT_MAX_CHARS);
  if (hint.length > 0) out.push(`HINT: ${hint}`);
  return out;
}

/**
 * Sanitize one optional keyline VALUE: strip ANSI escapes and control
 * characters, collapse any whitespace run (incl. newlines) to a single space,
 * trim, and cap. `undefined`/absent yields the empty string.
 */
function harnessProbeKeyValueDisplay(text: string | undefined, maxChars: number): string {
  if (text === undefined) return "";
  const controlFree = stripAnsi(text).replace(CONTROL_CHARS_RE, " ");
  return singleLine(controlFree).slice(0, maxChars);
}

// ── Matchlock probe guidance (MTLK-DIAG) ────────────────────────────

/**
 * guest-init's exact-destination-mount error family (the ErrExactMountPrep
 * sentinel in cmd/guest-init/errors.go, rendered by errx.With as
 * `<family> <detail>`).
 */
const EXACT_MOUNT_PREP_FAMILY = "prepare exact destination mount";

/** The non-empty-leaf detail guest-init appends for the shadowing refusal. */
const EXACT_MOUNT_NON_EMPTY_MARKER = " already exists and is not empty";

/**
 * Shortest contiguous PREFIX of the family string that still counts as
 * evidence of the family. The recorded interleaved captures retain only
 * `prepare e` (9 chars); the floor keeps an unrelated word from qualifying.
 */
const MIN_INTERLEAVED_FAMILY_PREFIX_CHARS = 4;

/**
 * guest-init's `fatal()` prints `FATAL: %v` then os.Exit(1); an init exit
 * panics the kernel with this marker (1 << 8 == the recorded 0x100 exit
 * code). Corroborating evidence only — never a diagnosis on its own.
 */
const INIT_PANIC_MARKER = "Attempted to kill init";

/** Inputs for the bounded Matchlock probe guidance classifier. */
export interface MatchlockProbeHintInput {
  /** The selected harness (pi | hermes | dsh). */
  harness: string;
  /** The operator-requested image tag from the pinned policy. */
  imageName: string;
  /** The resolved image digest when the pinned policy carries one. */
  imageDigest?: string;
  /** The captured failure text available at the probe call site (pre-display-cap). */
  stderrTail: string;
  /** The round's exit code, when one was observed (corroboration only). */
  exitCode?: number | null;
}

/**
 * Classify a Matchlock probe failure's captured evidence into ONE bounded,
 * already-sanitized single-line HINT, or `undefined` when the evidence
 * supports no guidance.
 *
 * Confidence tiers (never assert a definitive cause without complete
 * evidence):
 *  - COMPLETE Case A (`FATAL:` + the full exact-destination-mount family
 *    string + `already exists and is not empty` on one line): the guest
 *    refused the exact-destination mount over a non-empty destination; the
 *    hint names the captured path and the remedy.
 *  - INTERLEAVED/PARTIAL Case A (a `FATAL:` line carrying only a contiguous
 *    PREFIX of the family string, plus the init-panic marker): the guest
 *    failed at boot during exact-destination-mount preparation and the console
 *    is interleaved/truncated, so the specific cause is NOT established. A
 *    non-empty-leaf collision is mentioned strictly conditionally.
 *  - Complete-evidence family members WITHOUT the non-empty leaf (symlink /
 *    not-a-directory / protected guest-runtime root): NO hint.
 *  - Case B (the guest shell's `<harness>: not found` for the SELECTED
 *    harness): the harness did not start in the named image; the remedy is
 *    phrased conditionally. A different missing command gets no hint.
 *  - Everything else (other guest-init FATAL families, a prepare-looking
 *    fragment without the FATAL marker, wall timeouts, wrong output,
 *    signatureless invocation failures): NO hint.
 */
export function matchlockProbeHint(input: MatchlockProbeHintInput): string | undefined {
  const raw = input.stderrTail ?? "";
  if (raw.length === 0) return undefined;
  // Case A hints name the image only (the IMAGE_DIGEST keyline right above the
  // hint already carries the digest, and repeating it would eat the hint cap);
  // Case B names the image AND its digest.
  const imagePhrase = describeProbeImageName(input.imageName);
  const lines = raw.split(/\r\n|\n|\r/);

  if (raw.includes(EXACT_MOUNT_PREP_FAMILY)) {
    // COMPLETE evidence: the refusal sentence survived intact.
    for (const line of lines) {
      if (!line.includes("FATAL:")) continue;
      if (!line.includes(EXACT_MOUNT_NON_EMPTY_MARKER.trim())) continue;
      const afterFamily = line.slice(
        line.indexOf(EXACT_MOUNT_PREP_FAMILY) + EXACT_MOUNT_PREP_FAMILY.length,
      );
      const markerAt = afterFamily.indexOf(EXACT_MOUNT_NON_EMPTY_MARKER);
      const path = (markerAt >= 0 ? afterFamily.slice(0, markerAt) : afterFamily).trim();
      return harnessProbeKeyValueDisplay(
        path.length > 0
          ? `guest init refused the exact destination mount ${path}: that destination already exists and is not empty inside the image, so it would shadow baked guest content; use a working directory that does not exist inside ${imagePhrase} (e.g. a per-topic clone) or an image that does not bake that path`
          : `guest init refused an exact destination mount because the destination already exists and is not empty inside the image; use a working directory that does not exist inside ${imagePhrase} (e.g. a per-topic clone) or an image that does not bake that path`,
        HARNESS_PROBE_HINT_MAX_CHARS,
      );
    }
    // The full family string is present but this member is not the
    // non-empty-leaf refusal (symlink component / not-a-directory /
    // protected guest-runtime root / non-absolute path): no hint to give.
    return undefined;
  }

  // INTERLEAVED/PARTIAL evidence: only a contiguous prefix of the refusal
  // sentence survived the two interleaved console writers.
  for (const line of lines) {
    if (!line.includes("FATAL:")) continue;
    if (!hasContiguousFamilyPrefix(line)) continue;
    if (!raw.includes(INIT_PANIC_MARKER)) continue;
    return harnessProbeKeyValueDisplay(
      `guest initialization failed at boot and the captured console is interleaved/truncated, so the specific cause is NOT established from this evidence; the FATAL fragment matches the exact-destination-mount preparation error family, and if the round path collides with a non-empty path baked into ${imagePhrase}, use a working directory that does not exist inside the image (e.g. a per-topic clone) or an image that does not bake that path`,
      HARNESS_PROBE_HINT_MAX_CHARS,
    );
  }

  // Case B: the guest shell could not exec the SELECTED harness. The harness
  // token is bounded on both sides so another missing command (e.g.
  // `sh: 1: wget: not found`) never matches.
  const harness = input.harness.trim();
  if (harness.length > 0) {
    const notFound = raw.match(
      new RegExp(`sh:\\s*\\d+:\\s*${escapeRegExp(harness)}:\\s*not found`),
    );
    if (notFound) {
      const exitNote = input.exitCode === 127 ? " (exit 127)" : "";
      return harnessProbeKeyValueDisplay(
        `the selected harness "${harness}" did not start in ${describeProbeImage(input.imageName, input.imageDigest)}${exitNote}: the guest shell reported "${notFound[0]}"; if this image does not ship ${harness}, use one that does (e.g. igorhvr/tamandua)`,
        HARNESS_PROBE_HINT_MAX_CHARS,
      );
    }
  }

  return undefined;
}

/**
 * True when `line` carries a CONTIGUOUS PREFIX of the exact-destination-mount
 * family string that is SHORTER than the whole string — i.e. the sentence was
 * cut off mid-word by the interleaved console writers. The occurrence must sit
 * on a token boundary so a prefix-looking run inside an unrelated word cannot
 * qualify. Callers must only use this when the FULL family string is absent.
 */
function hasContiguousFamilyPrefix(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && /[A-Za-z0-9_]/.test(line[i - 1])) continue;
    if (line[i] !== EXACT_MOUNT_PREP_FAMILY[0]) continue;
    let n = 0;
    while (n < EXACT_MOUNT_PREP_FAMILY.length && line[i + n] === EXACT_MOUNT_PREP_FAMILY[n]) n++;
    if (n >= MIN_INTERLEAVED_FAMILY_PREFIX_CHARS && n < EXACT_MOUNT_PREP_FAMILY.length) return true;
  }
  return false;
}

/** `image "<tag>"` — the Case A hints name the image only (IMAGE_DIGEST is its own keyline). */
function describeProbeImageName(imageName: string): string {
  const name = (imageName ?? "").trim();
  return name.length > 0 ? `image "${name}"` : "the selected image";
}

/** `image "<tag>" (digest <digest>)`, degrading honestly when either is absent. */
function describeProbeImage(imageName: string, imageDigest: string | undefined): string {
  const name = (imageName ?? "").trim();
  const digest = (imageDigest ?? "").trim();
  const digestPhrase = digest.length > 0 ? ` (digest ${digest})` : "";
  if (name.length === 0) return digest.length > 0 ? `the selected image${digestPhrase}` : "the selected image";
  return `image "${name}"${digestPhrase}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * Tolerance for the in-flight 'probing' reservation staleness comparison
 * (TIME-CLOCKS rule 2). The reservation wall (default 180s) is an explicit
 * crash-recovery budget and `harness_probe_at` is written with millisecond
 * ISO-Z precision by the same process that reads it, so no slack is
 * warranted. Zero is the documented explicit tolerance and keeps the exact
 * prior strict boundary (`age > wallMs`).
 */
const HARNESS_PROBE_STALENESS_TOLERANCE_MS = 0;

/**
 * Atomically claim the once-per-run probe for a run: the claim only succeeds
 * when the row is still unprobed (`harness_probe_status IS NULL`) or its
 * in-flight 'probing' reservation is stale (older than the probe wall — a
 * daemon crash mid-probe must not wedge the run). Exactly one caller wins per
 * run; 'ok'/'failed' rows never match, so a passed (or definitively failed)
 * run is never re-probed. Returns true when this caller won the reservation.
 *
 * US-011: the staleness decision is computed numerically via `isOlderThan`
 * with the documented tolerance instead of the old
 * `harness_probe_at < staleBeforeIso` SQL string comparison. Atomic
 * single-winner semantics are preserved: the unprobed case is one conditional
 * UPDATE, and the stale case reads the reservation stamp and then re-updates
 * with the exact prior stamp as a compare-and-swap guard, so only the first
 * racer can replace a given reservation. An unparseable/unreadable stamp is
 * never treated as stale.
 */
export function reserveHarnessProbe(
  runId: string,
  opts?: HarnessProbeReserveOptions,
): boolean {
  const db = getDb();
  const wallMs = opts?.wallMs ?? getHarnessProbeWallMs();
  const nowMs = opts?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Fast path: an unprobed run is claimed by a single atomic UPDATE, exactly
  // as before (no read, no race window).
  const freshClaim = db
    .prepare(
      `UPDATE runs
       SET harness_probe_status = 'probing', harness_probe_at = ?
       WHERE id = ? AND harness_probe_status IS NULL`,
    )
    .run(nowIso, runId);
  if (freshClaim.changes > 0) return true;

  // Slow path: a 'probing' reservation may be stale. Read the stamp, decide
  // its age in JS, then CAS on the exact value read so a racing caller cannot
  // double-claim the same reservation.
  const row = db
    .prepare("SELECT harness_probe_status, harness_probe_at FROM runs WHERE id = ?")
    .get(runId) as { harness_probe_status: string | null; harness_probe_at: string | null } | undefined;
  if (!row || row.harness_probe_status !== "probing" || row.harness_probe_at == null) {
    // Row absent, or already 'ok'/'failed' — never re-probe.
    return false;
  }
  if (!isOlderThan(row.harness_probe_at, wallMs, nowMs, HARNESS_PROBE_STALENESS_TOLERANCE_MS)) {
    return false;
  }

  const staleClaim = db
    .prepare(
      `UPDATE runs
       SET harness_probe_status = 'probing', harness_probe_at = ?
       WHERE id = ? AND harness_probe_status = 'probing' AND harness_probe_at = ?`,
    )
    .run(nowIso, runId, row.harness_probe_at);
  return staleClaim.changes > 0;
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

/**
 * RPRB (6sy.37): clear a DEFINITIVE 'failed' harness-probe outcome so an
 * explicit `tamandua workflow resume` re-probes a repaired harness.
 *
 * The conditional WHERE is the whole safety contract:
 *  - only `harness_probe_status = 'failed'` matches, so a passed ('ok') run
 *    is never re-probed ("passed stays passed");
 *  - an in-flight 'probing' reservation is left untouched — the existing
 *    staleness CAS in reserveHarnessProbe() is the only way to reclaim it;
 *  - a NULL row (never probed) is a no-op.
 *
 * Returns true when a failed row was actually cleared. Callers must invoke
 * this ONLY from the explicit resume path; the daemon's automatic recovery
 * paths (rugpull replacement, worker-loss recovery, registration retries)
 * must never reset the probe.
 */
export function resetFailedHarnessProbeForResume(runId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE runs
       SET harness_probe_status = NULL, harness_probe_at = NULL
       WHERE id = ? AND harness_probe_status = 'failed'`,
    )
    .run(runId);
  return result.changes > 0;
}

// ── Small text helpers ──────────────────────────────────────────────

const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Control characters that `\s` does NOT cover (C0 minus \t/\n/\r/\f/\v, plus
 * DEL). The optional keyline values (IMAGE/IMAGE_DIGEST/HINT) must be free of
 * them: console captures carry stray CR/LF/NUL/BEL bytes that would otherwise
 * survive into a single-line key.
 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

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
