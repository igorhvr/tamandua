import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { HarnessType } from "./types.js";
import { logger } from "../lib/logger.js";
import { formatPiCommandPreview, findPromptArgvIndices, formatCommandPreview } from "./pi-command-preview.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";
import { sanitizeStderrTail } from "./step-ops.js";
import { classifyHarnessStderr } from "./harness-stderr.js";
import { resolveHermesBinary } from "./hermes-resolver.js";
import { resolveDshBinary } from "./dsh-resolver.js";
import { monotonicNow, Stopwatch } from "../lib/instant.js";
import {
  launchHarnessExecution,
  type HarnessLaunchMode,
  type HarnessLaunchSeams,
  type HarnessRoundIdentity,
} from "./harness-launch.js";

// ── Harness round result ───────────────────────────────────────────

export interface HarnessRoundResult {
  /** Full output from the harness round (stdout). */
  output: string;
  /**
   * Optional session reference populated by harnesses that track
   * session continuity (e.g. hermes `session_id` trailer).
   * Placeholder for future use — not populated in this phase.
   */
  sessionRef?: string;
  /** Exit code of the harness process, or null if killed by signal. */
  exitCode?: number | null;
  /** Signal that killed the harness process, or null. */
  signal?: string | null;
  /** True when the stdout or stderr stream was truncated due to exceeding the 10MB budget. */
  truncated?: boolean;
  /** Redacted command preview string (hermes argv redaction). */
  commandPreview?: string;
  /** Indices of redacted prompt arguments in argv. */
  redactedIndices?: number[];
  /** True when the command preview had prompt arguments elided. */
  promptElided?: boolean;
  /** Sanitized tail of stderr output (last ~8KB, ANSI-stripped, lines truncated), or an empty string. */
  stderrTail: string;
  /** True when the round was terminated by a timeout guard (exitCode will be null, signal SIGTERM). */
  timedOut?: boolean;
  /**
   * Wall-clock duration of the round in milliseconds, measured from just
   * before the harness process spawn through process close (the same
   * value the adapters already log as `durationMs`). Previously computed
   * internally but never returned — round completion had no duration
   * signal, so the scheduler could not tell a 3ms instant-fail from a
   * 30-minute legitimate round. Now surfaced so the dispatch round can
   * classify instant-fail rounds (see src/installer/instant-fail.ts).
   */
  durationMs?: number;
  /**
   * Time the harness PROCESS ITSELF ran, from guest exec start to process
   * exit, EXCLUDING any VM setup. Native adapters (pi/hermes/dsh) run the
   * harness directly, so they set this to `durationMs` and `vmSetupMs` to 0
   * — for them round time == harness time. A Matchlock/in-VM runner MUST
   * report the guest exec→exit interval here and the VM setup time
   * separately in `vmSetupMs`, and must NEVER fold setup into this value:
   * the instant-fail predicate classifies on harness wall time (not
   * whole-round wall time), so a refusal that dies after a short in-VM
   * round must still be counted even when VM boot took tens of seconds.
   * The Matchlock branch adopts this contract in its union follow-up.
   */
  harnessWallMs?: number;
  /**
   * VM setup time (ms) that elapsed BEFORE the harness exec, kept separate
   * from `harnessWallMs`. Always 0 for native rounds (no VM); a
   * Matchlock/in-VM runner reports its real setup time here. Never add it
   * into `harnessWallMs` — see that field's contract.
   */
  vmSetupMs?: number;
  /**
   * KHYG US-002: the effective native signal-isolation mode of this
   * launch ('landlock' | 'seatbelt' | 'unprotected-fallback'), as decided
   * by the shared launch mechanism (src/installer/harness-launch.ts).
   */
  launchMode?: HarnessLaunchMode;
  /** KHYG US-002: the fallback reason when launchMode === 'unprotected-fallback'. */
  launchReason?: string;
}

// ── Run options shared across harnesses ────────────────────────────

export interface RunHarnessOptions {
  timeout?: number; // seconds, default 10m (600s)
  workdir?: string;
  /**
   * Env entries merged OVER `process.env` for the harness child. A key whose
   * value is `undefined` is explicitly DROPPED from the child environment
   * (Node's spawn omits undefined values); this is how the scheduler strips
   * an inherited `TAMANDUA_WORKER_PID` (SWEEP-SCOPE US-002).
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional callback invoked once the child process is spawned.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  /**
   * When true (runs launched with --no-hurry-please-save-tokens-mode),
   * prefer a `<harness>-token-saver` command from PATH over the plain
   * harness binary (e.g. `pi-token-saver` for pi, `hermes-token-saver`
   * for hermes). Falls back silently when the wrapper is absent.
   */
  preferTokenSaver?: boolean;
  /**
   * Pre-resolved absolute path to the harness binary. When provided,
   * runRound skips its own findBinary() call and uses this path directly.
   * This guarantees that admission validation and actual dispatch use the
   * same resolved binary — no re-resolution, no disagreement.
   */
  binaryPath?: string;
  /**
   * KHYG US-002: run/execution identity for the per-launch isolation-mode
   * records (run.harness_isolation events + logs). Set by the scheduler
   * for work rounds and the launch-time probe round; optional — records
   * are logger-only when omitted.
   */
  execution?: HarnessRoundIdentity;
  /**
   * KHYG US-002: internal test-only launch seams passed through to the
   * shared launch mechanism (backend probe overrides, forced fallback,
   * readiness wall). Never a user-facing CLI knob.
   */
  launch?: HarnessLaunchSeams;
  /**
   * KHYG US-002: explicit cancellation signal — the scheduler aborts the
   * dispatch round's controller on run teardown/pause/cancel. The launch
   * mechanism vetoes release and any fresh fallback once it is aborted, so
   * a canceled run never starts a harness even when the setup child's final
   * signal is ambiguous. Optional; round cancels without a signal fall back
   * to the group-signal heuristic.
   */
  signal?: AbortSignal;
}

// ── Adapter interface ──────────────────────────────────────────────

export interface HarnessAdapter {
  readonly type: HarnessType;

  /**
   * Resolve the harness binary path.
   * For pi: honors TAMANDUA_PI_BINARY env, pi-token-saver preference,
   * and PATH search.
   * For hermes: honors TAMANDUA_HERMES_BINARY env and PATH search.
   * For dsh: honors TAMANDUA_DSH_BINARY env, dsh-token-saver preference,
   * PATH search, and a login-shell fallback.
   */
  findBinary(options?: { preferTokenSaver?: boolean }): Promise<string>;

  /**
   * Run a single work round from `prompt` through the harness binary,
   * returning the complete output and any session metadata.
   */
  runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult>;
}

// ── Shared helpers (minimally duplicated from agent-scheduler) ─────

function searchPathForExecutable(name: string): string | null {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }
  return null;
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
  const preview = truncated
    ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…`
    : normalized;

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

// ── Shared per-execution launch (KHYG US-002) ──────────────────────
// All three adapters launch their harness through ONE shared mechanism
// (harness-launch.ts): a FRESH native signal domain per launch (Linux
// landlock helper / macOS sandbox-exec + Seatbelt), a private READY/release
// handshake that releases the harness exactly once, and a single safe
// fallback to an unprotected run when the backend is unavailable or setup
// fails BEFORE release. This helper runs the mechanism, converts a launch
// aborted during setup (e.g. cancellation) into an empty round result, and
// hands the live child + effective mode back to the adapter, whose argv,
// cwd, env, stdio, parsing, wall-limit and cancellation handling are
// otherwise unchanged.

interface LaunchedRoundProcess {
  child: ChildProcess;
  pid: number | undefined;
  pgid: number;
  mode: HarnessLaunchMode;
  reason?: string;
}

async function launchRoundProcess(params: {
  harness: string;
  command: string[];
  workdir?: string;
  env: Record<string, string | undefined>;
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  execution?: HarnessRoundIdentity;
  seams?: HarnessLaunchSeams;
  signal?: AbortSignal;
  /**
   * The round's monotonic Stopwatch, started by the adapter when the round
   * began. It is the SAME time base used to derive the whole-round deadline
   * below — never mixed with an epoch instant (TIME-CLOCKS rule 1).
   */
  roundWatch: Stopwatch;
  /** Overall round wall budget in ms, measured on the round's monotonic watch. */
  timeoutMs: number;
}): Promise<
  | { status: "launched"; process: LaunchedRoundProcess }
  | { status: "aborted"; result: HarnessRoundResult }
> {
  const outcome = await launchHarnessExecution({
    harness: params.harness,
    command: params.command,
    cwd: params.workdir ?? process.cwd(),
    env: params.env,
    identity: params.execution,
    seams: params.seams,
    signal: params.signal,
    // The whole launch (native setup + any fallback) runs INSIDE the
    // adapter's overall wall budget: once it expires, no fresh harness
    // work may begin. The deadline is derived on the monotonic clock from
    // the round stopwatch's elapsed time (monotonicNow() + remaining), so
    // it shares the adapters' time base and a wall-clock jump cannot shift
    // it. A budget that is already exhausted yields a deadline in the past
    // and aborts at entry (see harness-launch.ts expiredAtEntry).
    wallDeadlineMs: monotonicNow() + (params.timeoutMs - params.roundWatch.elapsedMs()),
    onSpawn: params.onSpawn
      ? ({ pid, pgid }: { pid: number; pgid: number }) => {
          try {
            params.onSpawn!({ pid, pgid });
          } catch (err) {
            logger.warn(`${params.harness} onSpawn callback threw`, { error: String(err) });
          }
        }
      : undefined,
  });

  if (outcome.status === "aborted") {
    // The launch was cancelled/aborted during native setup: no harness ever
    // started, no fallback ran. Resolve an empty round result carrying the
    // setup-child exit/signal forensics — the same shape a signal-killed
    // round produces, so the scheduler handles it through the normal path.
    // A budget-exhausted abort reports the round's timedOut convention.
    // Duration is the round watch's monotonic elapsed time (rule 1).
    const durationMs = params.roundWatch.elapsedMs();
    logger.warn(`${params.harness} launch aborted before harness start (native setup)`, {
      pid: outcome.pid ?? null,
      pgid: outcome.pgid,
      reason: outcome.reason,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut === true,
      durationMs,
    });
    return {
      status: "aborted",
      result: {
        output: "",
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? undefined,
        stderrTail: outcome.stderrTail,
        timedOut: outcome.timedOut === true ? true : undefined,
        durationMs,
        // No harness ever exec'd (the abort happened during native setup), so
        // the harness-process wall time equals the round watch's elapsed time
        // and there was no VM setup layer. Native semantics: round time ==
        // harness time, vmSetupMs 0.
        harnessWallMs: durationMs,
        vmSetupMs: 0,
      },
    };
  }

  return {
    status: "launched",
    process: {
      child: outcome.child,
      pid: outcome.pid,
      pgid: outcome.pgid,
      mode: outcome.mode,
      reason: outcome.reason,
    },
  };
}

// ── PiHarnessAdapter ───────────────────────────────────────────────

class PiHarnessAdapter implements HarnessAdapter {
  readonly type: HarnessType = "pi";

  async findBinary(
    options?: { preferTokenSaver?: boolean },
  ): Promise<string> {
    // Prefer explicit env override
    const envPi = process.env.TAMANDUA_PI_BINARY?.trim();
    if (envPi) {
      try {
        fs.accessSync(envPi, fs.constants.X_OK);
        return envPi;
      } catch {
        throw new Error(
          `TAMANDUA_PI_BINARY set but not executable: ${envPi}`,
        );
      }
    }

    if (options?.preferTokenSaver) {
      const tokenSaver = searchPathForExecutable("pi-token-saver");
      if (tokenSaver) return tokenSaver;
      // Not installed (yet) — fall through to normal pi resolution.
    }

    const pi = searchPathForExecutable("pi");
    if (pi) return pi;

    throw new Error(
      "pi binary not found in PATH. Install pi (https://github.com/anthropics/pi) or set TAMANDUA_PI_BINARY.",
    );
  }

  async runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult> {
    const timeoutMs = ((options?.timeout) ?? 600) * 1000;
    const piPath = await this.findBinary({
      preferTokenSaver: options?.preferTokenSaver,
    });

    // pi --print mode: single-shot work prompt
    const args = ["--print", "--mode", "json", prompt];

    const childEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(options?.env ?? {}),
    };

    const preview = formatPiCommandPreview(piPath, args);
    // US-003: the round's start and elapsed budget are monotonic (rule 1):
    // remainingWallMs and durationMs come from this watch, never a
    // Date.now() difference, so an NTP step / suspend-resume cannot abort a
    // healthy round early or inflate/shrink its duration.
    const roundWatch = new Stopwatch();

    logger.info("pi pre-launch", {
      commandPreview: preview.commandPreview,
      argvPreview: preview.argvPreview,
      redactedIndices: preview.redactedIndices,
      truncatedIndices: preview.truncatedIndices,
      promptElided: preview.promptElided,
      argCount: preview.argCount,
      timeoutMs,
      workdir: options?.workdir,
    });

    // Launch pi through the shared per-execution isolation mechanism: a
    // FRESH native signal domain (Linux landlock helper / macOS seatbelt)
    // self-restricts and then execs the /bin/sh PGID wrapper below, so the
    // true harness PGID flows through to every tool subshell with pid/pgid
    // identity preserved across exec exactly as before. The mechanism
    // reports READY, waits for the parent's release, and only then starts
    // the harness exactly once.
    const launched = await launchRoundProcess({
      harness: "pi",
      command: [piPath, ...args],
      workdir: options?.workdir,
      env: childEnv,
      onSpawn: options?.onSpawn,
      execution: options?.execution,
      seams: options?.launch,
      signal: options?.signal,
      roundWatch,
      timeoutMs,
    });
    if (launched.status === "aborted") return launched.result;

    const child = launched.process.child;
    const childPid = launched.process.pid;
    // On Linux, the spawned child becomes its own group leader (pgid === pid)
    // when detached:true; the launch mechanism preserves that group across the
    // native setup child -> /bin/sh -> harness exec chain.
    const pgid = launched.process.pgid;
    const launchMode = launched.process.mode;
    const launchReason = launched.process.reason;

    logger.info("pi launched", {
      pid: childPid ?? null,
      pgid,
      mode: launchMode,
      ...(launchReason !== undefined ? { fallbackReason: launchReason } : {}),
      timeoutMs,
      workdir: options?.workdir,
    });

    // End stdin immediately — pi --print waits for stdin EOF before responding
    child.stdin?.end();

    // Collect stderr (bounded)
    let stderrPieces: string[] = [];
    let stderrBytes = 0;
    const MAX_STDERR_BYTES = 10 * 1024 * 1024; // 10MB cap for stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
        stderrPieces.push(str);
        stderrBytes += Buffer.byteLength(str, "utf-8");
      }
    });

    // Stream stdout through readline → parsePiOutputStream.
    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    const parseResultPromise = parsePiOutputStream(rl);

    // Wait for child exit, with timeout guard.
    // The adapter resolves on ALL outcomes (success, non-zero exit, timeout)
    // so the scheduler can attribute tokens and populate worker_lost events
    // with real exit/signal/stderr forensics. Only fatal spawn errors
    // (child.on("error")) still reject. The timer uses the REMAINING wall
    // budget (native setup already consumed some of it): the overall round
    // budget, including setup/fallback, stays as requested.
    const remainingWallMs = Math.max(1, timeoutMs - roundWatch.elapsedMs());
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Terminate the whole process group: SIGTERM, then SIGKILL after 5s.
        if (pgid) {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
        // Resolve with timeout signal info — the scheduler and dispatch-round
        // failure path can now populate worker_lost events with real forensics
        // instead of undefined.
        resolve({ code: null, signal: "SIGTERM" });
      }, remainingWallMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Always resolve — the scheduler decides what to do with non-zero
        // exits. Worker-lost events now carry exitCode/signal/stderrTail
        // instead of undefined.
        resolve({ code, signal: signal as NodeJS.Signals | null });
      });
    });

    const exitCode = exitInfo.code;
    const exitSignal = exitInfo.signal;
    const timedOut = exitCode === null && exitSignal === "SIGTERM";

    // Log non-zero exit failures (but don't reject — resolve like hermes)
    if (exitCode !== null && exitCode !== 0) {
      const failureDurationMs = roundWatch.elapsedMs();
      const failureStderr = stderrPieces.join("");
      const failureStderrMeta = buildStreamLogMetadata(failureStderr);
      logger.error("pi execution failed", {
        pid: childPid ?? null,
        pgid,
        exitCode,
        signal: exitSignal,
        durationMs: failureDurationMs,
        stderrBytes: failureStderrMeta.bytes,
        stderrPreview: failureStderrMeta.preview,
        stderrTruncated: failureStderrMeta.truncated,
      });
    } else if (exitSignal) {
      logger.warn("pi terminated by signal", {
        pid: childPid ?? null,
        pgid,
        signal: exitSignal,
        durationMs: roundWatch.elapsedMs(),
      });
    }

    // Wait for stdout parsing to finish (it will complete once stdout closes)
    const parseResult = await parseResultPromise;

    const durationMs = roundWatch.elapsedMs();
    const stderrOut = stderrPieces.join("");
    const stderrMeta = buildStreamLogMetadata(stderrOut);

    if (stderrMeta.preview) {
      const stderrClass = classifyHarnessStderr("pi", stderrOut);
      if (stderrClass.benign) {
        logger.debug("pi stderr (benign)", {
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      } else {
        logger.warn("pi stderr", {
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      }
    }

    // Reconstruct filtered stdout from parsed events for backwards compatibility.
    const filteredLines: string[] = [];
    if (parseResult.textFallback !== null) {
      filteredLines.push(parseResult.textFallback);
    }
    for (const event of parseResult.events) {
      filteredLines.push(JSON.stringify(event));
    }
    if (parseResult.assistantText.length > 0) {
      filteredLines.push(parseResult.assistantText);
    }
    const filteredStdout = filteredLines.join("\n");
    const stdoutMeta = buildStreamLogMetadata(filteredStdout);

    logger.info("pi completed", {
      pid: childPid ?? null,
      pgid,
      durationMs,
      exitCode,
      signal: exitSignal,
      stdoutBytes: stdoutMeta.bytes,
      stdoutPreview: stdoutMeta.preview,
      stdoutTruncated: stdoutMeta.truncated,
      stderrBytes: stderrMeta.bytes,
      hasStderr: stderrMeta.bytes > 0,
    });

    const stderrTail = sanitizeStderrTail(stderrOut);

    return {
      output: filteredStdout.trim(),
      exitCode: exitCode,
      signal: exitSignal ?? undefined,
      stderrTail,
      timedOut: timedOut || undefined,
      durationMs,
      // Native pi: the harness ran directly, so round time == harness time.
      harnessWallMs: durationMs,
      vmSetupMs: 0,
      launchMode,
      ...(launchReason !== undefined ? { launchReason } : {}),
    };
  }
}

// ── HermesHarnessAdapter ──────────────────────────────────────────

class HermesHarnessAdapter implements HarnessAdapter {
  readonly type: HarnessType = "hermes";

  async findBinary(
    options?: { preferTokenSaver?: boolean },
  ): Promise<string> {
    return resolveHermesBinary({
      preferTokenSaver: options?.preferTokenSaver,
    });
  }

  async runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult> {
    const timeoutMs = ((options?.timeout) ?? 600) * 1000;
    const hermesPath =
      options?.binaryPath ??
      (await this.findBinary({
        preferTokenSaver: options?.preferTokenSaver,
      }));

    const childEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(options?.env ?? {}),
    };

    // US-003: monotonic round watch (rule 1) — elapsed/remaining and
    // durationMs are all derived from it, never from Date.now() differences.
    const roundWatch = new Stopwatch();

    // Hermes single-shot invocation:
    // -q <prompt> delivers the task in single message mode.
    // --max-turns 8192 gives the agent plenty of room to complete the work.
    // --yolo skips permission confirmations (hermes equivalent of pi -y).
    // -Q suppresses banner/spinner (but NOT session_id).
    // Keep user config enabled so Hermes uses the configured provider/model.
    const args = [
      "chat",
      "--max-turns",
      "8192",
      "--yolo",
      "-Q",
      "-q",
      prompt,
    ];

    // Build command preview with redacted -q prompt payload.
    // Hermes argv: ['chat', '--max-turns', '8192', '--yolo', '-Q', '-q', prompt]
    // The prompt is at index 6 (after -q).
    const redactedIndices = findPromptArgvIndices(args, ["-q"]);
    const preview = formatCommandPreview(hermesPath, args, redactedIndices);

    logger.info("hermes pre-launch", {
      harness: "hermes",
      hermesPath,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      commandPreview: preview.commandPreview,
      redactedIndices: preview.redactedIndices,
      promptElided: preview.promptElided,
      timeoutMs,
      workdir: options?.workdir,
    });

    // Launch hermes through the shared per-execution isolation mechanism: a
    // FRESH native signal domain self-restricts and then execs the /bin/sh
    // PGID wrapper below, so the true harness PGID flows through to every
    // tool subshell with pid/pgid identity preserved across exec exactly as
    // before. The mechanism reports READY, waits for the parent's release,
    // and only then starts the harness exactly once.
    const launched = await launchRoundProcess({
      harness: "hermes",
      command: [hermesPath, ...args],
      workdir: options?.workdir,
      env: childEnv,
      onSpawn: options?.onSpawn,
      execution: options?.execution,
      seams: options?.launch,
      signal: options?.signal,
      roundWatch,
      timeoutMs,
    });
    if (launched.status === "aborted") return launched.result;

    const child = launched.process.child;
    const childPid = launched.process.pid;
    const pgid = launched.process.pgid;
    const launchMode = launched.process.mode;
    const launchReason = launched.process.reason;

    logger.info("hermes launched", {
      harness: "hermes",
      pid: childPid ?? null,
      pgid,
      mode: launchMode,
      ...(launchReason !== undefined ? { fallbackReason: launchReason } : {}),
      timeoutMs,
      workdir: options?.workdir,
    });

    // End stdin immediately — hermes reads from args (-q).
    child.stdin?.end();

    // Collect stderr and stdout with head+tail window collectors.
    // Head window: first ~1MB. Tail window: last ~9MB (10MB total budget).
    // When the stream exceeds 10MB, the middle is discarded and a truncation
    // marker is inserted. This guarantees the session_id trailer (on stderr)
    // and final STATUS/verdict lines (on stdout) survive regardless of
    // total stream size.
    const HEAD_BYTES = 1 * 1024 * 1024;
    const TAIL_BYTES = 9 * 1024 * 1024;

    // ── stderr collector ──
    let stderrHeadChunks: string[] = [];
    let stderrHeadBytes = 0;
    let stderrTailChunks: string[] = [];
    let stderrTailBytes = 0;
    let stderrTruncated = false;
    let stderrPhase: "head" | "tail" = "head";

    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      const strBytes = Buffer.byteLength(str, "utf-8");

      if (stderrPhase === "head" && !stderrTruncated) {
        stderrHeadChunks.push(str);
        stderrHeadBytes += strBytes;
        if (stderrHeadBytes >= HEAD_BYTES) {
          stderrPhase = "tail";
        }
        return;
      }

      // Phase "tail": collect into sliding tail window
      stderrTailChunks.push(str);
      stderrTailBytes += strBytes;

      if (!stderrTruncated && stderrHeadBytes + stderrTailBytes > HEAD_BYTES + TAIL_BYTES) {
        stderrTruncated = true;
        // Trim excess from tail to fit within TAIL_BYTES
        while (stderrTailBytes > TAIL_BYTES && stderrTailChunks.length > 0) {
          const oldest = stderrTailChunks.shift()!;
          stderrTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
        logger.warn("hermes stderr truncated", {
          harness: "hermes",
          pid: childPid ?? null,
          headBytes: stderrHeadBytes,
          tailBytes: stderrTailBytes,
          totalBudget: HEAD_BYTES + TAIL_BYTES,
        });
      } else if (stderrTruncated) {
        // Maintain ring buffer: drop oldest chunks when exceeding TAIL_BYTES
        while (stderrTailBytes > TAIL_BYTES && stderrTailChunks.length > 0) {
          const oldest = stderrTailChunks.shift()!;
          stderrTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
      }
    });

    // ── stdout collector ──
    let stdoutHeadChunks: string[] = [];
    let stdoutHeadBytes = 0;
    let stdoutTailChunks: string[] = [];
    let stdoutTailBytes = 0;
    let stdoutTruncated = false;
    let stdoutPhase: "head" | "tail" = "head";

    child.stdout?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      const strBytes = Buffer.byteLength(str, "utf-8");

      if (stdoutPhase === "head" && !stdoutTruncated) {
        stdoutHeadChunks.push(str);
        stdoutHeadBytes += strBytes;
        if (stdoutHeadBytes >= HEAD_BYTES) {
          stdoutPhase = "tail";
        }
        return;
      }

      // Phase "tail": collect into sliding tail window
      stdoutTailChunks.push(str);
      stdoutTailBytes += strBytes;

      if (!stdoutTruncated && stdoutHeadBytes + stdoutTailBytes > HEAD_BYTES + TAIL_BYTES) {
        stdoutTruncated = true;
        // Trim excess from tail to fit within TAIL_BYTES
        while (stdoutTailBytes > TAIL_BYTES && stdoutTailChunks.length > 0) {
          const oldest = stdoutTailChunks.shift()!;
          stdoutTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
        logger.warn("hermes stdout truncated", {
          harness: "hermes",
          pid: childPid ?? null,
          headBytes: stdoutHeadBytes,
          tailBytes: stdoutTailBytes,
          totalBudget: HEAD_BYTES + TAIL_BYTES,
        });
      } else if (stdoutTruncated) {
        // Maintain ring buffer: drop oldest chunks when exceeding TAIL_BYTES
        while (stdoutTailBytes > TAIL_BYTES && stdoutTailChunks.length > 0) {
          const oldest = stdoutTailChunks.shift()!;
          stdoutTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
      }
    });

    // Wait for child exit, with timeout guard.
    // The adapter resolves on ALL outcomes (success, non-zero exit, timeout,
    // teardown kill) so the scheduler can attribute tokens even when the
    // harness is killed after step completion.  Only fatal spawn errors
    // (child.on("error")) still reject — those go to the scheduler's catch
    // block which can attempt stderr-based sessionRef extraction.
    let timeoutTimerFired = false;
    // The timer uses the REMAINING wall budget (native setup already
    // consumed part of it), keeping the overall round budget intact. The
    // remaining budget is monotonic (rule 1): a wall-clock jump cannot
    // shorten it (premature abort) or lengthen it (budget overrun).
    const remainingWallMs = Math.max(1, timeoutMs - roundWatch.elapsedMs());
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        timeoutTimerFired = true;
        if (pgid) {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
        // Resolve with what we have — the stderr collector may already
        // contain the session_id trailer when the harness was killed.
        resolve({ code: null, signal: "SIGTERM" });
      }, remainingWallMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Always resolve — the scheduler decides what to do with non-zero
        // exits. Teardown kills (exit 130) and other non-zero outcomes now
        // flow through the normal post-round path where token attribution
        // can still capture hermes state.db tokens.
        resolve({ code, signal: signal as NodeJS.Signals | null });
      });
    });

    const durationMs = roundWatch.elapsedMs();
    const exitCode = exitInfo.code;
    const exitSignal = exitInfo.signal;

    // Log non-zero exits and signal kills but don't throw — the adapter
    // always resolves so the scheduler can run post-round processing.
    if (exitCode !== null && exitCode !== 0) {
      const failureStderr = stderrTruncated
        ? stderrHeadChunks.join("") + "\n[…output truncated…]\n" + stderrTailChunks.join("")
        : stderrHeadChunks.join("") + stderrTailChunks.join("");
      const failureStderrMeta = buildStreamLogMetadata(failureStderr);
      logger.error("hermes execution failed", {
        harness: "hermes",
        pid: childPid ?? null,
        pgid,
        exitCode,
        signal: exitSignal,
        durationMs,
        stderrBytes: failureStderrMeta.bytes,
        stderrPreview: failureStderrMeta.preview,
        stderrTruncated: failureStderrMeta.truncated,
      });
    } else if (exitSignal) {
      logger.warn("hermes terminated by signal", {
        harness: "hermes",
        pid: childPid ?? null,
        pgid,
        signal: exitSignal,
        durationMs,
      });
    }
    // Assemble stdout/stderr from head+tail windows. When either stream was
    // truncated, insert an explicit marker between head and tail.
    const TRUNCATION_MARKER = "\n[…output truncated…]\n";
    const rawStdout = stdoutTruncated
      ? stdoutHeadChunks.join("") + TRUNCATION_MARKER + stdoutTailChunks.join("")
      : stdoutHeadChunks.join("") + stdoutTailChunks.join("");
    const stderrOut = stderrTruncated
      ? stderrHeadChunks.join("") + TRUNCATION_MARKER + stderrTailChunks.join("")
      : stderrHeadChunks.join("") + stderrTailChunks.join("");
    const stderrMeta = buildStreamLogMetadata(stderrOut);

    if (stderrMeta.preview) {
      const stderrClass = classifyHarnessStderr("hermes", stderrOut);
      if (stderrClass.benign) {
        logger.debug("hermes stderr (benign)", {
          harness: "hermes",
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      } else {
        logger.warn("hermes stderr", {
          harness: "hermes",
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      }
    }

    // Extract session_id trailer. Real hermes prints the session identifier
    // (e.g. "session_id: 20260518_103004_cdae11") to STDERR at session end
    // (both normal exit and KeyboardInterrupt paths). Scan stderr first
    // (primary source), then fall back to stdout for backward compatibility.
    // Capture the LAST session_id (without prefix) for downstream token
    // accounting via hermes-usage.ts.
    const sessionIdRegex = /^session_id:\s*\S+/;
    const findSessionRef = (text: string): string | undefined => {
      const linez = text.split("\n");
      const match = linez.filter((l) => sessionIdRegex.test(l.trim())).pop();
      return match?.trim().replace(/^session_id:\s*/, "") || undefined;
    };
    const sessionRef = findSessionRef(stderrOut) || findSessionRef(rawStdout);

    // When no session_id trailer is found on either stream, emit a loud
    // diagnostic warning — operators need to see WHY tokens read 0.
    // This is non-fatal: the scheduler skips token lookup when sessionRef
    // is falsy, so the round completes normally.
    if (!sessionRef) {
      const jobId = process.env.TAMANDUA_WORKER_JOB_ID;
      const runIdMatch = jobId?.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      );
      const runId = runIdMatch ? runIdMatch[1] : undefined;
      const agentId = jobId && runId
        ? jobId.slice(jobId.indexOf(runId) + runId.length + 1)
        : undefined;
      logger.warn("hermes round completed with no session_id trailer — tokens will read 0", {
        harness: "hermes",
        pid: childPid ?? null,
        runId,
        jobId,
        agentId,
        exitCode,
        signal: exitSignal,
        stdoutBytes: Buffer.byteLength(rawStdout, "utf-8"),
        stderrBytes: Buffer.byteLength(stderrOut, "utf-8"),
      });
    }

    const filteredStdout = rawStdout
      .split("\n")
      .filter((line) => !sessionIdRegex.test(line.trim()))
      .join("\n")
      .trim();

    const stdoutMeta = buildStreamLogMetadata(filteredStdout);

    logger.info("hermes completed", {
      harness: "hermes",
      pid: childPid ?? null,
      pgid,
      durationMs,
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdoutBytes: stdoutMeta.bytes,
      stdoutPreview: stdoutMeta.preview,
      stdoutTruncated: stdoutMeta.truncated,
      stderrBytes: stderrMeta.bytes,
      hasStderr: stderrMeta.bytes > 0,
    });

    const wasTruncated = stdoutTruncated || stderrTruncated;
    if (wasTruncated) {
      logger.warn("hermes round output truncated", {
        harness: "hermes",
        pid: childPid ?? null,
        stdoutTruncated,
        stderrTruncated,
        stdoutBytes: Buffer.byteLength(rawStdout, "utf-8"),
        stderrBytes: Buffer.byteLength(stderrOut, "utf-8"),
      });
    }

    const stderrTail = sanitizeStderrTail(stderrOut);

    return {
      output: filteredStdout,
      sessionRef,
      exitCode,
      signal: exitSignal ?? undefined,
      truncated: wasTruncated || undefined,
      commandPreview: preview.commandPreview,
      redactedIndices: preview.redactedIndices,
      promptElided: preview.promptElided,
      stderrTail,
      timedOut: timeoutTimerFired || undefined,
      durationMs,
      // Native hermes: the harness ran directly, so round time == harness time.
      harnessWallMs: durationMs,
      vmSetupMs: 0,
      launchMode,
      ...(launchReason !== undefined ? { launchReason } : {}),
    };
  }
}

// ── DshHarnessAdapter ─────────────────────────────────────────────

class DshHarnessAdapter implements HarnessAdapter {
  readonly type: HarnessType = "dsh";

  async findBinary(
    options?: { preferTokenSaver?: boolean },
  ): Promise<string> {
    return resolveDshBinary({
      preferTokenSaver: options?.preferTokenSaver,
    });
  }

  async runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult> {
    const timeoutMs = ((options?.timeout) ?? 600) * 1000;
    const dshPath =
      options?.binaryPath ??
      (await this.findBinary({
        preferTokenSaver: options?.preferTokenSaver,
      }));

    const childEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(options?.env ?? {}),
    };

    // Mandatory tamandua injection — the dsh equivalent of the `--yolo`
    // flag tamandua passes to hermes. Under dsh's default
    // `workspace-write` sandbox the headless app auto-DENIES (fail-closed,
    // no prompt) any action outside the workspace root — including
    // `tamandua step complete`, which writes to ~/.tamandua — so without
    // this injection agents could do the work but never report it and every
    // run would be useless. Set unconditionally AFTER the env merge so it
    // overrides any inherited (or caller-supplied) value; it is
    // process-scoped — nothing under ~/.dsh is ever created or modified and
    // the user's other dsh usage is unaffected. (A profile cordis.patch.yml
    // that hard-pins sandbox/approval rows overrides this env var — dsh's
    // profile layers replace those config rows wholesale — `tamandua doctor`
    // probes for exactly that condition.)
    childEnv.DSH_PERMISSION_MODE = "danger-full-access";

    // US-003: monotonic round watch (rule 1) — elapsed/remaining and
    // durationMs are all derived from it, never from Date.now() differences.
    const roundWatch = new Stopwatch();

    // dsh headless invocation: `dsh --profile headless <prompt>`.
    // The headless app accepts ONLY the task positional (plus --help) —
    // no --json/--model/--resume/--cwd/--timeout/--yolo. All behavior
    // comes from env vars and profile patch layers.
    const args = ["--profile", "headless"];

    // Prompt-starting-with-`-` guard. Observed dsh behavior: a task token
    // whose first character is `-` is rejected by the headless app's
    // commander parse as `error: unknown option '-…'` (exit 1) — the task
    // misparses and the round never runs. dsh's launcher (apps/cli/args.ts)
    // consumes the FIRST `--` it sees and hands everything after it
    // verbatim to the booted app, whose own commander parse honors `--` as
    // end-of-options. So exactly TWO `--` tokens are emitted: the launcher
    // consumes one, the headless app consumes the second, and the prompt is
    // forced through as the task operand regardless of its first character.
    // (Verified against commander 15.0.0 from dsh's own dependency tree;
    // a single `--` does NOT survive to the headless app.)
    if (prompt.startsWith("-")) {
      args.push("--", "--");
    }
    args.push(prompt);

    // The prompt is always the final argv element.
    const redactedIndices = [args.length - 1];
    const preview = formatCommandPreview(dshPath, args, redactedIndices);

    logger.info("dsh pre-launch", {
      harness: "dsh",
      dshPath,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      commandPreview: preview.commandPreview,
      redactedIndices: preview.redactedIndices,
      promptElided: preview.promptElided,
      timeoutMs,
      workdir: options?.workdir,
    });

    // Launch dsh through the shared per-execution isolation mechanism: a
    // FRESH native signal domain self-restricts and then execs the /bin/sh
    // PGID wrapper below, so the true harness PGID flows through to every
    // tool subshell with pid/pgid identity preserved across exec exactly as
    // before. The mechanism reports READY, waits for the parent's release,
    // and only then starts the harness exactly once.
    const launched = await launchRoundProcess({
      harness: "dsh",
      command: [dshPath, ...args],
      workdir: options?.workdir,
      env: childEnv,
      onSpawn: options?.onSpawn,
      execution: options?.execution,
      seams: options?.launch,
      signal: options?.signal,
      roundWatch,
      timeoutMs,
    });
    if (launched.status === "aborted") return launched.result;

    const child = launched.process.child;
    const childPid = launched.process.pid;
    const pgid = launched.process.pgid;
    const launchMode = launched.process.mode;
    const launchReason = launched.process.reason;

    logger.info("dsh launched", {
      harness: "dsh",
      pid: childPid ?? null,
      pgid,
      mode: launchMode,
      ...(launchReason !== undefined ? { fallbackReason: launchReason } : {}),
      timeoutMs,
      workdir: options?.workdir,
    });

    // End stdin immediately — dsh reads the task from argv, and headless
    // has no interactive channel mounted.
    child.stdin?.end();

    // Collect stderr and stdout with head+tail window collectors — same
    // 10MB total budget (1MB head + 9MB tail) as the hermes adapter, so
    // the final assistant text on stdout (STATUS lines) survives regardless
    // of total stream size.
    const HEAD_BYTES = 1 * 1024 * 1024;
    const TAIL_BYTES = 9 * 1024 * 1024;

    // ── stderr collector ──
    let stderrHeadChunks: string[] = [];
    let stderrHeadBytes = 0;
    let stderrTailChunks: string[] = [];
    let stderrTailBytes = 0;
    let stderrTruncated = false;
    let stderrPhase: "head" | "tail" = "head";

    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      const strBytes = Buffer.byteLength(str, "utf-8");

      if (stderrPhase === "head" && !stderrTruncated) {
        stderrHeadChunks.push(str);
        stderrHeadBytes += strBytes;
        if (stderrHeadBytes >= HEAD_BYTES) {
          stderrPhase = "tail";
        }
        return;
      }

      // Phase "tail": collect into sliding tail window
      stderrTailChunks.push(str);
      stderrTailBytes += strBytes;

      if (!stderrTruncated && stderrHeadBytes + stderrTailBytes > HEAD_BYTES + TAIL_BYTES) {
        stderrTruncated = true;
        while (stderrTailBytes > TAIL_BYTES && stderrTailChunks.length > 0) {
          const oldest = stderrTailChunks.shift()!;
          stderrTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
        logger.warn("dsh stderr truncated", {
          harness: "dsh",
          pid: childPid ?? null,
          headBytes: stderrHeadBytes,
          tailBytes: stderrTailBytes,
          totalBudget: HEAD_BYTES + TAIL_BYTES,
        });
      } else if (stderrTruncated) {
        while (stderrTailBytes > TAIL_BYTES && stderrTailChunks.length > 0) {
          const oldest = stderrTailChunks.shift()!;
          stderrTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
      }
    });

    // ── stdout collector ──
    let stdoutHeadChunks: string[] = [];
    let stdoutHeadBytes = 0;
    let stdoutTailChunks: string[] = [];
    let stdoutTailBytes = 0;
    let stdoutTruncated = false;
    let stdoutPhase: "head" | "tail" = "head";

    child.stdout?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      const strBytes = Buffer.byteLength(str, "utf-8");

      if (stdoutPhase === "head" && !stdoutTruncated) {
        stdoutHeadChunks.push(str);
        stdoutHeadBytes += strBytes;
        if (stdoutHeadBytes >= HEAD_BYTES) {
          stdoutPhase = "tail";
        }
        return;
      }

      // Phase "tail": collect into sliding tail window
      stdoutTailChunks.push(str);
      stdoutTailBytes += strBytes;

      if (!stdoutTruncated && stdoutHeadBytes + stdoutTailBytes > HEAD_BYTES + TAIL_BYTES) {
        stdoutTruncated = true;
        while (stdoutTailBytes > TAIL_BYTES && stdoutTailChunks.length > 0) {
          const oldest = stdoutTailChunks.shift()!;
          stdoutTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
        logger.warn("dsh stdout truncated", {
          harness: "dsh",
          pid: childPid ?? null,
          headBytes: stdoutHeadBytes,
          tailBytes: stdoutTailBytes,
          totalBudget: HEAD_BYTES + TAIL_BYTES,
        });
      } else if (stdoutTruncated) {
        while (stdoutTailBytes > TAIL_BYTES && stdoutTailChunks.length > 0) {
          const oldest = stdoutTailChunks.shift()!;
          stdoutTailBytes -= Buffer.byteLength(oldest, "utf-8");
        }
      }
    });

    // Wait for child exit, with timeout guard. The adapter resolves on ALL
    // outcomes (success, non-zero exit, timeout) so the scheduler can run
    // post-round processing. Only fatal spawn errors (child.on("error"))
    // still reject. The timer uses the REMAINING wall budget (native setup
    // already consumed part of it), keeping the overall round budget intact.
    let timeoutTimerFired = false;
    // The remaining budget is monotonic (rule 1): a wall-clock jump cannot
    // shorten it (premature abort) or lengthen it (budget overrun).
    const remainingWallMs = Math.max(1, timeoutMs - roundWatch.elapsedMs());
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        timeoutTimerFired = true;
        if (pgid) {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
        // Resolve with timeout signal info — the scheduler and dispatch-round
        // failure path can populate worker_lost events with real forensics
        // instead of undefined.
        resolve({ code: null, signal: "SIGTERM" });
      }, remainingWallMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Always resolve — the scheduler decides what to do with non-zero
        // exits. dsh traps SIGTERM and exits 0, so a clean-looking close
        // (code 0) may still follow an external teardown kill; timedOut is
        // derived below from the adapter's own timer flag, never from this.
        resolve({ code, signal: signal as NodeJS.Signals | null });
      });
    });

    const durationMs = roundWatch.elapsedMs();
    const exitCode = exitInfo.code;
    const exitSignal = exitInfo.signal;

    // Phantom-outcome guard: dsh catches SIGTERM and exits 0
    // (supervisor-stop semantics), so a timed-out round would masquerade
    // as a clean success if timedOut were inferred from the exit signal.
    // timedOut comes exclusively from the adapter's own timeout-timer flag.
    const timedOut = timeoutTimerFired;

    // Log non-zero exits and signal kills but don't throw — the adapter
    // always resolves so the scheduler can run post-round processing.
    if (exitCode !== null && exitCode !== 0) {
      const failureStderr = stderrTruncated
        ? stderrHeadChunks.join("") + "\n[…output truncated…]\n" + stderrTailChunks.join("")
        : stderrHeadChunks.join("") + stderrTailChunks.join("");
      const failureStderrMeta = buildStreamLogMetadata(failureStderr);
      logger.error("dsh execution failed", {
        harness: "dsh",
        pid: childPid ?? null,
        pgid,
        exitCode,
        signal: exitSignal,
        durationMs,
        stderrBytes: failureStderrMeta.bytes,
        stderrPreview: failureStderrMeta.preview,
        stderrTruncated: failureStderrMeta.truncated,
      });
    } else if (exitSignal) {
      logger.warn("dsh terminated by signal", {
        harness: "dsh",
        pid: childPid ?? null,
        pgid,
        signal: exitSignal,
        durationMs,
      });
    }

    // Assemble stdout/stderr from head+tail windows. When either stream was
    // truncated, insert an explicit marker between head and tail.
    const TRUNCATION_MARKER = "\n[…output truncated…]\n";
    const rawStdout = stdoutTruncated
      ? stdoutHeadChunks.join("") + TRUNCATION_MARKER + stdoutTailChunks.join("")
      : stdoutHeadChunks.join("") + stdoutTailChunks.join("");
    const stderrOut = stderrTruncated
      ? stderrHeadChunks.join("") + TRUNCATION_MARKER + stderrTailChunks.join("")
      : stderrHeadChunks.join("") + stderrTailChunks.join("");
    const stderrMeta = buildStreamLogMetadata(stderrOut);

    if (stderrMeta.preview) {
      const stderrClass = classifyHarnessStderr("dsh", stderrOut);
      if (stderrClass.benign) {
        logger.debug("dsh stderr (benign)", {
          harness: "dsh",
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      } else {
        logger.warn("dsh stderr", {
          harness: "dsh",
          pid: childPid ?? null,
          stderrBytes: stderrMeta.bytes,
          stderrPreview: stderrMeta.preview,
          stderrTruncated: stderrMeta.truncated,
        });
      }
    }

    // stdout passes through VERBATIM: dsh prints exactly the last assistant
    // text message plus "\n". No filtering, no session trailer, no trim —
    // STATUS lines must survive intact for classifyWorkRoundOutcome. dsh
    // never prints a session id (headless has no resume), so token
    // accounting uses a workdir/mtime session-file scan instead.
    const stdoutMeta = buildStreamLogMetadata(rawStdout);

    logger.info("dsh completed", {
      harness: "dsh",
      pid: childPid ?? null,
      pgid,
      durationMs,
      exitCode,
      signal: exitSignal,
      stdoutBytes: stdoutMeta.bytes,
      stdoutPreview: stdoutMeta.preview,
      stdoutTruncated: stdoutMeta.truncated,
      stderrBytes: stderrMeta.bytes,
      hasStderr: stderrMeta.bytes > 0,
      timedOut,
    });

    const wasTruncated = stdoutTruncated || stderrTruncated;
    if (wasTruncated) {
      logger.warn("dsh round output truncated", {
        harness: "dsh",
        pid: childPid ?? null,
        stdoutTruncated,
        stderrTruncated,
        stdoutBytes: Buffer.byteLength(rawStdout, "utf-8"),
        stderrBytes: Buffer.byteLength(stderrOut, "utf-8"),
      });
    }

    const stderrTail = sanitizeStderrTail(stderrOut);

    return {
      output: rawStdout,
      exitCode,
      signal: exitSignal ?? undefined,
      truncated: wasTruncated || undefined,
      commandPreview: preview.commandPreview,
      redactedIndices: preview.redactedIndices,
      promptElided: preview.promptElided,
      stderrTail,
      timedOut: timedOut || undefined,
      durationMs,
      // Native dsh: the harness ran directly, so round time == harness time.
      harnessWallMs: durationMs,
      vmSetupMs: 0,
      launchMode,
      ...(launchReason !== undefined ? { launchReason } : {}),
    };
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Return the appropriate {@link HarnessAdapter} for the given harness type.
 *
 * @throws {Error} if the harness type is unknown.
 */
export function getHarnessAdapter(harnessType: string): HarnessAdapter {
  switch (harnessType) {
    case "pi":
      return new PiHarnessAdapter();
    case "hermes":
      return new HermesHarnessAdapter();
    case "dsh":
      return new DshHarnessAdapter();
    default:
      throw new Error(`unknown harness type: ${harnessType}`);
  }
}
