/**
 * harness-launch.ts — KHYG US-002 shared per-execution launch mechanism.
 *
 * Every harness execution — the pi, Hermes and dsh work rounds AND the
 * launch-time harness probe round — flows through the three adapters'
 * `runRound` (src/installer/harness-adapter.ts). This module is the ONE
 * shared internal launch primitive those adapters call instead of spawning
 * `/bin/sh` directly. It gives each launch its OWN fresh native signal
 * domain:
 *
 *  - Linux   -> dist/native/landlock-helper (US-001): applies a Landlock
 *    SIGNAL-scope ruleset to itself, reports READY over a private control
 *    fd, and only execs the harness after the parent releases it.
 *  - macOS   -> /usr/bin/sandbox-exec -p <seatbelt profile> /bin/sh: the
 *    bridge shell exports TAMANDUA_WORKER_PGID and TAMANDUA_WORKER_PID,
 *    performs the same private READY/release handshake on fd 3, then execs
 *    the harness.
 *
 * The setup child is always a FRESH process in its own detached process
 * group; it self-restricts and then execs the existing `/bin/sh` PGID
 * wrapper (`export TAMANDUA_WORKER_PGID="$$"; export TAMANDUA_WORKER_PID="$$";
 * exec "$0" "$@"`, double-dollar expansion preserved verbatim) so
 * pid/pgid/TAMANDUA_WORKER_PGID/TAMANDUA_WORKER_PID identity is
 * preserved across exec exactly as before — no extra supervisor shell stays
 * in the ancestry, and the shared daemon is never sandboxed. CPID2: the
 * worker pid exported here is what `step claim` records in `claim_pid`.
 *
 * Non-negotiable launch/fallback contract (see the KHYG task):
 *  - A setup child that never receives release can never have executed the
 *    harness. Release is sent EXACTLY ONCE, only after a valid READY record
 *    (mode matching the backend) arrives on the control channel.
 *  - Backend unavailable, or a SETTLED pre-release setup failure (helper
 *    exited, or readiness never arrived within the setup wall and the setup
 *    child was killed), falls back ONCE to an unprotected run from the
 *    unchanged parent in a FRESH process, with a prominent durable warning
 *    recording mode=unprotected-fallback + reason + run/execution identity +
 *    UTC. There is never a generic "sandboxed command failed, now run it
 *    unsandboxed" retry.
 *  - Once release may have been sent, the outcome is NEVER replayed: a
 *    post-release harness exit (including a helper-like exit code such as
 *    125), crash, hang, or signal death is an ordinary harness round
 *    outcome, never a setup failure.
 *  - An external signal that kills the setup child before readiness (e.g.
 *    run cancellation) aborts the launch cleanly: zero executions, no
 *    fallback.
 *
 * This is process-signal isolation only and best effort — not a complete
 * security boundary. See native-signal-backend.ts for the honest limits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../lib/logger.js";
import { monotonicNow } from "../lib/instant.js";
import { emitEvent } from "./events.js";
import {
  LANDLOCK_CONTROL_FD,
  buildProtectedLaunchArgv,
  probeBackend,
  type BackendProbeOptions,
  type LandlockBackend,
  type SeatbeltBackend,
} from "./native-signal-backend.js";

// ── Constants ──────────────────────────────────────────────────────

/** Effective signal-isolation mode of one harness launch. */
export type HarnessLaunchMode = "landlock" | "seatbelt" | "unprotected-fallback";

/** Run-level event carrying the effective isolation mode of one launch. */
export const HARNESS_ISOLATION_EVENT = "run.harness_isolation";

/**
 * Maximum wall time the launch waits for the setup child's READY record
 * before treating readiness as missing (pre-release setup failure -> one
 * fallback). The native setup normally completes in a few milliseconds;
 * this is a pathological-case bound only. Override per launch via
 * HarnessLaunchSeams.setupWallMs.
 */
export const SETUP_READY_WALL_MS = 10_000;

/**
 * The exact `/bin/sh` PGID wrapper the pre-isolation adapters used. The
 * double-dollar PID expansion is intentional and MUST stay verbatim:
 * with detached:true the spawned child is its own group leader, so $$ (the
 * shell pid, preserved across exec) equals the process-group id. The claim
 * CLI prefers TAMANDUA_WORKER_PGID over self-detected PGID, which on macOS
 * would otherwise pick up the transient tool-call subshell. CPID2: the same
 * $$ is exported as TAMANDUA_WORKER_PID so `step claim` records the harness
 * worker pid (never the daemon pid).
 */
const PGID_SHELL_WRAPPER = `export TAMANDUA_WORKER_PGID="$$"; export TAMANDUA_WORKER_PID="$$"; exec "$0" "$@"`;

/**
 * macOS seatbelt bridge wrapper: the same PGID/worker-pid exports plus the
 * private control-channel handshake, because sandbox-exec has no native
 * readiness signal. Runs INSIDE the sandbox (sandbox-exec execs /bin/sh,
 * which execs the harness — no extra process stays in the ancestry). Exit
 * 125 on any pre-release failure matches the landlock helper's
 * setup-failure code.
 */
const SEATBELT_BRIDGE_WRAPPER =
  `export TAMANDUA_WORKER_PGID="$$"; ` +
  `export TAMANDUA_WORKER_PID="$$"; ` +
  `printf "READY mode=seatbelt\\n" >&3 || exit 125; ` +
  `IFS= read -r __tamandua_release <&3 || exit 125; ` +
  `[ "$__tamandua_release" = "GO" ] || exit 125; ` +
  `exec 3>&-; exec "$0" "$@"`;

/** Bounded capture for setup-child stderr that accompanies a fallback/abort. */
const SETUP_STDERR_TAIL_MAX = 4000;

// ── Options / outcomes ─────────────────────────────────────────────

/** Run/execution identity attached to durable mode records. */
export interface HarnessRoundIdentity {
  runId?: string;
  agentId?: string;
  workflowId?: string;
  stepId?: string;
  /** The scheduler's dispatch round (job) id — recorded as roundId. */
  roundId?: string;
}

/**
 * Internal test-only launch seams (never user-facing CLI knobs; only
 * function/option parameters, mirroring native-signal-backend.ts).
 */
export interface HarnessLaunchSeams {
  /** Backend probe overrides — point probeBackend at a fixture artifact dir. */
  probe?: BackendProbeOptions;
  /** Force the unprotected-fallback path with this reason (empty -> 'forced-fallback'). */
  forceFallbackReason?: string | null;
  /** Readiness wall in ms (default SETUP_READY_WALL_MS). */
  setupWallMs?: number;
}

export interface HarnessLaunchOptions {
  /** Harness label for logs/records: pi | hermes | dsh. */
  harness: string;
  /** The harness argv: [binary, ...args]. */
  command: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Published as soon as a setup/fallback child is spawned so callers (the
   * scheduler's in-flight child registry) can cancel the launch by killing
   * its process group during the setup phase.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  identity?: HarnessRoundIdentity;
  seams?: HarnessLaunchSeams;
  /**
   * Absolute MONOTONIC-ms deadline for the WHOLE launch (native setup +
   * fallback), on the same monotonic time base as the adapters' round
   * Stopwatch (`monotonicNow()` — never an epoch instant; TIME-CLOCKS
   * rule 1). The adapters derive it from their round wall budget
   * (roundWatch elapsed => monotonicNow() + remaining). Once it expires,
   * no fresh harness work may begin: the setup child is killed and the
   * launch aborts as timed out (zero executions, no fallback). When
   * omitted the setup phase is only bounded by seams.setupWallMs.
   */
  wallDeadlineMs?: number;
  /**
   * Explicit cancellation signal (the scheduler aborts the dispatch
   * round's controller on run teardown/pause/cancel). Cancellation intent
   * is retained across the setup wall and fallback decisions and VETOES
   * both release and any fresh fallback: an aborted launch never starts a
   * harness, even when the setup child's final signal is ambiguous (e.g.
   * the setup wall's own SIGKILL won the race with the cancel signal).
   */
  signal?: AbortSignal;
}

/** The launch succeeded; `child` is a LIVE harness process (protected or fallback). */
export interface HarnessLaunchLaunched {
  status: "launched";
  child: ChildProcess;
  pid: number | undefined;
  pgid: number;
  mode: HarnessLaunchMode;
  /** Present when mode === 'unprotected-fallback': the fallback reason. */
  reason?: string;
  /** Extra tokens from the READY record (e.g. `abi=8 pid=...`), when present. */
  readyDetail?: string;
}

/** The launch aborted before any harness execution (e.g. cancelled during setup). */
export interface HarnessLaunchAborted {
  status: "aborted";
  /** Why the launch aborted (human/machine-readable, no prompts/secrets). */
  reason: string;
  /** Exit code of the setup child (null when killed by a signal). */
  exitCode: number | null;
  /** Signal that killed the setup child, if any. */
  signal: string | null;
  /** Bounded stderr the setup child produced before it died. */
  stderrTail: string;
  pid: number | undefined;
  pgid: number;
  /**
   * True when the abort was caused by exhausting the caller's overall wall
   * budget during native setup (the adapter reports it as a timed-out
   * round). No harness ran and no fallback occurred.
   */
  timedOut?: boolean;
}

export type HarnessLaunchOutcome = HarnessLaunchLaunched | HarnessLaunchAborted;

// ── Mode records (durable + visible) ───────────────────────────────

/**
 * Run ids whose unprotected-fallback warning + run.harness_isolation record
 * have ALREADY been written in THIS process. The unprotected-fallback state
 * is a property of the host/run, not of each round: on a host with no usable
 * native backend, every round would otherwise emit the same WARN + event
 * hundreds of times (958 in one observed run). The set is process-scoped, so
 * it naturally resets on each daemon start — the first fallback round after a
 * daemon start records the warning/event, later rounds log at debug.
 */
const fallbackRecordedRunIds = new Set<string>();

/**
 * Test-only hook: clear the per-run fallback dedup state so unit tests can
 * isolate module state. Product code never calls this.
 */
export function __resetFallbackDedupForTests(): void {
  fallbackRecordedRunIds.clear();
}

/**
 * Record the launch's effective isolation mode. Always logged; additionally
 * emitted as a run.harness_isolation event when run identity is available
 * (the scheduler always supplies it). Fallback warnings are logged at warn
 * level and carried on the event with reason — visible on the run event
 * stream (dashboard/kanban) and durable in the log + events files.
 *
 * Per-run fallback dedup (WNOI): the FIRST unprotected-fallback execution for
 * a runId in this process logs the WARN and emits the run.harness_isolation
 * event; every LATER fallback execution for that runId logs the same fields
 * at debug and emits NO event. Protected modes ('landlock'/'seatbelt') are
 * unchanged: one info record + event per execution. Never dumps prompts or
 * secrets.
 */
function recordMode(
  opts: HarnessLaunchOptions,
  mode: HarnessLaunchMode,
  reason: string | undefined,
  detail: string | undefined,
): void {
  const { harness, identity } = opts;
  // A HUMAN-VISIBLE detail line on every record: the run-event renderers
  // (logs-tail-format.ts formatLogsTailLine, dashboard kanban) display
  // `detail` (not mode/reason), so a fallback must spell out that
  // protection was lost in the detail itself — a bare event name renders
  // nothing useful.
  const visible =
    detail !== undefined && detail !== ""
      ? `${detail}`
      : mode === "unprotected-fallback"
        ? `mode=unprotected-fallback reason=${reason ?? "unknown"}`
        : `mode=${mode}`;
  const fields = {
    harness,
    mode,
    ...(reason !== undefined && reason !== "" ? { reason } : {}),
    ...(visible !== "" ? { detail: visible } : {}),
    ...(identity?.runId !== undefined ? { runId: identity.runId } : {}),
  };
  if (mode === "unprotected-fallback") {
    // Dedup ONLY when we have a runId to key on; a runless fallback keeps
    // today's always-warn behavior (it has no run stream to record on).
    const fallbackRunId = identity?.runId;
    if (fallbackRunId !== undefined && fallbackRecordedRunIds.has(fallbackRunId)) {
      // Already warned/recorded for this run in this process: keep the
      // fields observable at debug and do NOT emit another event.
      logger.debug(
        "harness signal isolation unavailable (already recorded for this run; running unprotected)",
        fields,
      );
      return;
    }
    logger.warn(
      "harness signal isolation unavailable — running this execution unprotected (mode=unprotected-fallback)",
      fields,
    );
    if (fallbackRunId !== undefined) fallbackRecordedRunIds.add(fallbackRunId);
  } else {
    logger.info("harness execution isolation mode", fields);
  }
  if (identity?.runId === undefined) return; // no run stream to record on
  emitEvent({
    ts: new Date().toISOString(),
    event: HARNESS_ISOLATION_EVENT,
    runId: identity.runId,
    workflowId: identity.workflowId,
    agentId: identity.agentId,
    stepId: identity.stepId,
    roundId: identity.roundId,
    harness,
    mode,
    ...(reason !== undefined && reason !== "" ? { reason } : {}),
    ...(visible !== "" ? { detail: visible } : {}),
  });
}

/**
 * An already-expired overall wall budget must never begin fresh harness
 * work — including on every pre-release fallback route (forced fallback,
 * backend unavailable, argv/profile-read setup failure). The launch aborts
 * as timed out with zero starts and NO fallback mode record.
 */
function expiredAtEntry(opts: HarnessLaunchOptions): HarnessLaunchOutcome | null {
  if (opts.wallDeadlineMs === undefined || monotonicNow() < opts.wallDeadlineMs) return null;
  return {
    status: "aborted",
    reason: "overall round budget already expired before launch; harness never started",
    exitCode: null,
    signal: "SIGTERM", // timed-out round convention (adapter timedOut)
    stderrTail: "",
    pid: undefined,
    pgid: 0,
    timedOut: true,
  };
}

// ── Unprotected fallback launch ────────────────────────────────────

/**
 * Run the harness from the unchanged parent in a FRESH unprotected process
 * (the exact pre-isolation spawn shape: /bin/sh PGID wrapper, detached).
 * Only ever called when the backend is unavailable up front OR a setup
 * failure settled BEFORE release — never after release may have been sent.
 * The shared pre-spawn deadline guard applies to EVERY fallback route:
 * when the caller's overall wall budget already expired, no harness is
 * spawned and the launch aborts timed out instead.
 */
function spawnUnprotected(
  opts: HarnessLaunchOptions,
  reason: string,
  publishSpawn: (child: ChildProcess) => { pid: number | undefined; pgid: number },
): HarnessLaunchOutcome {
  const expired = expiredAtEntry(opts);
  if (expired !== null) return expired;
  const { command } = opts;
  const child = spawn("/bin/sh", ["-c", PGID_SHELL_WRAPPER, ...command], {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env as NodeJS.ProcessEnv | undefined,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  // Safety net: if this /bin/sh spawn itself fails (effectively impossible),
  // log instead of letting an unhandled 'error' event crash the caller. The
  // adapter attaches its own error/close listeners right after this resolves.
  child.on("error", (err) => {
    logger.warn(`${opts.harness} unprotected fallback spawn failed`, {
      error: String(err),
      reason,
    });
  });
  const { pid, pgid } = publishSpawn(child);
  recordMode(opts, "unprotected-fallback", reason, undefined);
  return { status: "launched", child, pid, pgid, mode: "unprotected-fallback", reason };
}

// ── Protected launch ───────────────────────────────────────────────

function buildSetupCommand(
  opts: HarnessLaunchOptions,
  backend: LandlockBackend | SeatbeltBackend,
): string[] {
  const wrapper = backend.kind === "landlock" ? PGID_SHELL_WRAPPER : SEATBELT_BRIDGE_WRAPPER;
  return ["/bin/sh", "-c", wrapper, ...opts.command];
}

function fallbackReasonWithStderr(reason: string, setupStderr: string): string {
  const tail = setupStderr.trim();
  if (tail === "") return reason;
  const collapsed = tail.split("\n").slice(-3).join(" ").slice(0, 300);
  return `${reason}; setup stderr: ${collapsed}`;
}

async function launchProtected(
  opts: HarnessLaunchOptions,
  backend: LandlockBackend | SeatbeltBackend,
  publishSpawn: (child: ChildProcess) => { pid: number | undefined; pgid: number },
): Promise<HarnessLaunchOutcome> {
  const controlFd = LANDLOCK_CONTROL_FD;
  let spec: { argv: string[] };
  try {
    const built = buildProtectedLaunchArgv(buildSetupCommand(opts, backend), {
      backend,
      controlFd,
    });
    if (built === null) {
      // Defensive: argv construction cannot fail after a successful probe.
      return spawnUnprotected(opts, "protected-launch-argv-unavailable", publishSpawn);
    }
    spec = built.spec;
  } catch (err) {
    // e.g. an unreadable/mis-shaped seatbelt profile asset (a directory
    // where the .sb file should be): protection is unusable for this
    // launch — safe fallback exactly once, never a crash.
    return spawnUnprotected(
      opts,
      fallbackReasonWithStderr(
        `native setup argv unavailable (${err instanceof Error ? err.message : String(err)})`,
        "",
      ),
      publishSpawn,
    );
  }

  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env as NodeJS.ProcessEnv | undefined,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const { pid, pgid } = publishSpawn(child);
  const setupWallMs = opts.seams?.setupWallMs ?? SETUP_READY_WALL_MS;
  const wallDeadlineMs = opts.wallDeadlineMs;
  const control = child.stdio[controlFd] as
    | (NodeJS.ReadWriteStream & { destroy?: () => void })
    | undefined;

  return await new Promise<HarnessLaunchOutcome>((resolve) => {
    let settled = false;
    let released = false;
    let killedForMissingReadiness = false; // our own setup-wall SIGKILL
    let killedForWallExhausted = false; // overall round budget exhausted
    let externalCancel = false; // explicit cancellation signal fired
    let readyBuf = "";
    let setupStderr = "";
    let setupTimer: NodeJS.Timeout | undefined;

    /** True when the caller's overall round budget has already expired. */
    const wallExhausted = (): boolean =>
      wallDeadlineMs !== undefined && monotonicNow() >= wallDeadlineMs;

    /** Explicit cancellation intent (signal aborted by the scheduler). */
    const isCancelled = (): boolean => externalCancel || opts.signal?.aborted === true;

    const cancelAbort = (): void => {
      settle({
        status: "aborted",
        reason: "harness launch cancelled before release; harness never started",
        exitCode: null,
        // Round-cancellation convention: the scheduler accompanies the abort
        // with a group SIGTERM; cancelled rounds resolve SIGTERM-shaped.
        signal: "SIGTERM",
        stderrTail: setupStderr,
        pid,
        pgid,
      });
    };

    /**
     * Abort the launch as timed out: the caller's overall wall budget ran
     * out during native setup. Zero executions and NEVER a fallback — an
     * exhausted overall budget must not begin fresh harness work.
     */
    const abortTimedOut = (why: string): void => {
      settle({
        status: "aborted",
        reason: why,
        exitCode: null,
        signal: "SIGTERM", // adapter timedOut-round convention
        stderrTail: setupStderr,
        pid,
        pgid,
        timedOut: true,
      });
    };

    /**
     * Fall back once (protected setup failed before release and the overall
     * budget has not yet expired), else abort as timed out. An explicit
     * cancellation vetoes the fallback entirely: a canceled run must never
     * receive a fresh live (unprotected) child.
     */
    const settleFallback = (reason: string): void => {
      if (isCancelled()) {
        cancelAbort();
        return;
      }
      if (wallExhausted()) {
        abortTimedOut(`${reason}; overall round budget exhausted`);
        return;
      }
      settle(spawnUnprotected(opts, fallbackReasonWithStderr(reason, setupStderr), publishSpawn));
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled || released) return;
      // Explicit cancellation intent wins over every other classification,
      // including our own setup-wall SIGKILL: the scheduler may have marked
      // the run canceled between the wall kill and this close event, and no
      // fresh harness work may start for a canceled run.
      if (isCancelled()) {
        cancelAbort();
        return;
      }
      if (killedForWallExhausted) {
        abortTimedOut(`native setup did not complete before the overall round budget expired`);
        return;
      }
      if (killedForMissingReadiness) {
        // We killed the setup child at the setup wall because readiness
        // never arrived. Fall back ONLY when the child actually died from
        // OUR SIGKILL: if the fatal signal was anything else (e.g. an
        // external SIGTERM cancellation delivered just before the wall),
        // explicit cancellation intent wins — zero starts, no fallback.
        if (code === null && signal === "SIGKILL") {
          settleFallback(`native setup did not report readiness within ${setupWallMs}ms`);
        } else {
          settle({
            status: "aborted",
            reason:
              signal !== null
                ? `native setup cancelled by ${signal} before readiness; harness never started`
                : `native setup exited (${code}) before readiness; harness never started`,
            exitCode: code,
            signal,
            stderrTail: setupStderr,
            pid,
            pgid,
          });
        }
        return;
      }
      if (signal !== null) {
        // An external signal killed the setup child before release (e.g.
        // run cancellation). Zero executions, no fallback.
        settle({
          status: "aborted",
          reason: `native setup child killed by ${signal} before readiness; harness never started`,
          exitCode: code,
          signal,
          stderrTail: setupStderr,
          pid,
          pgid,
        });
        return;
      }
      // Normal pre-release exit = settled setup failure (ABI gate, invalid
      // policy, control-channel EOF, ...). The harness never ran.
      settleFallback(`native setup failed before release (exit ${code})`);
    };

    const onExternalCancel = (): void => {
      if (settled || released) return;
      // The scheduler canceled the round during native setup: record the
      // intent and kill the setup child (it cannot have executed the
      // harness). The close handler reports a clean abort — never release,
      // never fall back.
      externalCancel = true;
      killSetupGroup();
    };

    const onError = (err: Error): void => {
      if (settled || released) return;
      const e = err as Error & { code?: string };
      // Spawn-level failure: the probed backend could not even be launched
      // (e.g. the helper vanished between probe and spawn). Protection is
      // unavailable for this launch — safe fallback, exactly once.
      settleFallback(
        `native setup spawn failed (${e.code ?? err.message}); backend unavailable at launch`,
      );
    };

    const onSetupStderr = (chunk: Buffer): void => {
      setupStderr = (setupStderr + chunk.toString("utf-8")).slice(-SETUP_STDERR_TAIL_MAX);
    };

    const onControlData = (chunk: Buffer): void => {
      if (settled || released) return;
      if (isCancelled()) {
        // Explicit cancellation arrived while waiting for readiness.
        externalCancel = true;
        killSetupGroup();
        return;
      }
      if (wallExhausted()) {
        // The overall round budget expired while waiting for readiness:
        // kill the setup child and abort timed out — no harness work may
        // begin after the budget.
        killedForWallExhausted = true;
        killSetupGroup();
        return;
      }
      readyBuf += chunk.toString("utf-8");
      for (;;) {
        const nl = readyBuf.indexOf("\n");
        if (nl === -1) break; // wait for the full frame
        const line = readyBuf.slice(0, nl).trim();
        readyBuf = readyBuf.slice(nl + 1);
        if (line === "") continue;
        const m = /^READY mode=(\S+)(?:\s+(.*))?$/.exec(line);
        // A valid READY must name THIS backend's mode; anything else
        // (partial/malformed frame) never authorizes release — the setup
        // deadline or the child's exit settles the launch instead.
        if (!m || m[1] !== backend.kind) continue;
        // Explicit cancellation vetoes the release: a canceled run must
        // never receive a live harness child.
        if (isCancelled()) {
          externalCancel = true;
          killSetupGroup();
          return;
        }
        released = true;
        const detail = m[2]?.trim() ?? "";
        // Record the effective mode BEFORE release (the parent records the
        // mode, then releases exactly once).
        recordMode(opts, backend.kind, undefined, detail || undefined);
        cleanup();
        // Release exactly once: any byte wakes the helper/bridge.
        if (control) {
          control.write("GO\n", () => {
            try {
              (control as { destroy?: () => void }).destroy?.();
            } catch {
              /* best effort */
            }
          });
        }
        settle({ status: "launched", child, pid, pgid, mode: backend.kind, readyDetail: detail || undefined });
        return;
      }
    };

    const killSetupGroup = (): void => {
      // Kill the setup child's whole process group (it cannot have executed
      // the harness pre-release). Group kill (not just pid) also reaps any
      // descendant the setup child left behind, so its stdio pipes close and
      // nothing stays orphaned.
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
          return;
        } catch {
          /* not a group leader — fall through to pid kill */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone — close will settle */
      }
    };

    const cleanup = (): void => {
      if (setupTimer !== undefined) clearTimeout(setupTimer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.stderr?.removeListener("data", onSetupStderr);
      if (control !== undefined) {
        control.removeListener("data", onControlData);
      }
      opts.signal?.removeEventListener("abort", onExternalCancel);
    };

    const settle = (outcome: HarnessLaunchOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    child.on("close", onClose);
    child.on("error", onError);
    child.stderr?.on("data", onSetupStderr);
    control?.on("data", onControlData);
    // The private control channel can be reset/closed by the setup child
    // (e.g. READY followed by peer closure). A stream 'error' must never be
    // an unhandled event in the shared daemon: absorb channel teardown
    // noise here. Readiness failures still settle via the child close or
    // the setup deadline.
    control?.on("error", () => {
      /* channel reset by the peer — handled via child close / deadline */
    });
    // Explicit cancellation (the scheduler aborts the round's signal on
    // teardown/pause/cancel) vetoes release AND any fresh fallback.
    opts.signal?.addEventListener("abort", onExternalCancel, { once: true });

    // The overall round budget and the readiness wall both bound the setup
    // phase; whichever expires first settles it. Both deadlines are on the
    // monotonic clock (TIME-CLOCKS rule 1) — the readiness wall starts from
    // monotonicNow() and the caller's wallDeadlineMs is already monotonic —
    // so a wall-clock jump cannot shift either. RETAIN which deadline this
    // timer was armed for instead of re-classifying by the clock inside the
    // callback: monotonic-timer vs monotonic-clock skew can still deliver
    // the overall-budget timer marginally before monotonicNow() crosses
    // that deadline, and re-classifying the fire would label an
    // overall-budget kill as a readiness-wall expiry — authorizing an
    // unprotected fallback AFTER the round's overall budget ran out.
    const setupWallAt = monotonicNow() + setupWallMs;
    const overallDeadline =
      wallDeadlineMs !== undefined && wallDeadlineMs <= setupWallAt
        ? wallDeadlineMs
        : undefined;
    const armedForOverall = overallDeadline !== undefined;
    const deadlineAt = overallDeadline ?? setupWallAt;
    const delayMs = Math.max(0, deadlineAt - monotonicNow());
    setupTimer = setTimeout(() => {
      if (settled || released) return;
      if (isCancelled()) {
        // The scheduler canceled while the setup deadline was pending.
        externalCancel = true;
        killSetupGroup();
        return;
      }
      if (armedForOverall) {
        // The armed deadline was the caller's overall round budget: the
        // setup phase ran out of overall time. Kill and abort timed out
        // with zero executions — NEVER a fallback.
        killedForWallExhausted = true;
      } else {
        // The armed deadline was the readiness wall (it expired before the
        // overall budget): kill for missing readiness; the close handler
        // falls back only if the overall budget still has room.
        killedForMissingReadiness = true;
      }
      killSetupGroup();
    }, delayMs);
    setupTimer.unref?.();
  });
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Launch ONE harness execution through the shared mechanism: fresh native
 * signal domain when a backend is available, else a single unprotected
 * fallback run (with a durable mode record), else a clean abort when the
 * launch was cancelled during setup. Resolves as soon as the harness is
 * running (release sent exactly once) or the launch settled without one.
 */
export function launchHarnessExecution(opts: HarnessLaunchOptions): Promise<HarnessLaunchOutcome> {
  const publishSpawn = (child: ChildProcess): { pid: number | undefined; pgid: number } => {
    const pid = child.pid;
    const pgid = pid ?? 0;
    if (pid !== undefined && opts.onSpawn !== undefined) {
      try {
        opts.onSpawn({ pid, pgid });
      } catch (err) {
        logger.warn(`${opts.harness} onSpawn callback threw`, { error: String(err) });
      }
    }
    return { pid, pgid };
  };

  // An already-cancelled round never spawns anything.
  if (opts.signal?.aborted === true) {
    return Promise.resolve({
      status: "aborted",
      reason: "harness launch cancelled before release; harness never started",
      exitCode: null,
      signal: "SIGTERM",
      stderrTail: "",
      pid: undefined,
      pgid: 0,
    });
  }

  // Every fallback route (forced fallback, backend unavailable, and
  // launchProtected's argv/profile-read catch) funnels through
  // spawnUnprotected, which enforces the expired-overall-budget guard at
  // the shared pre-spawn boundary: an already-past wallDeadlineMs aborts
  // timed out with zero starts and no fallback mode record.
  const forcedReason = opts.seams?.forceFallbackReason;
  if (forcedReason !== undefined && forcedReason !== null) {
    return Promise.resolve(
      spawnUnprotected(opts, forcedReason === "" ? "forced-fallback (test seam)" : forcedReason, publishSpawn),
    );
  }

  const backend = probeBackend(opts.seams?.probe);
  if (backend.kind === "unavailable") {
    return Promise.resolve(spawnUnprotected(opts, backend.reason, publishSpawn));
  }
  return launchProtected(opts, backend, publishSpawn);
}
