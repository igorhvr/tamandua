/**
 * MTLK-INTERACTIVE US-010 (PROVISIONAL GAP GAP-07) — foreground session core.
 *
 * `InteractiveSessionController` is the foreground controller for ONE
 * interactive Matchlock session (`tamandua matchlock pi|pi-shell|hermes|
 * hermes-shell`). It deliberately REUSES the shipped slice-1 lifecycle rather
 * than adapting a workflow-shaped runner:
 *
 *   1. it owns exactly ONE fresh `MatchlockController`, constructed with
 *      `requireHelperPack: false` (interactive sessions run no scoped guest
 *      bridge) and with the shared interactive create-config builder
 *      (`buildInteractiveSessionCreateConfig`), so the VM carries the caller's
 *      `owner_uid`/`owner_gid`, mounts the whole selected configuration
 *      directory and omits the helper pack/progress resource;
 *   2. it creates the VM from the persisted pinned identity through the
 *      controller's identity re-verification
 *      (`prepareAndCreate(plan.pinnedIdentity)`);
 *   3. it runs the ordered in-guest preparation commands (US-006) IN ORDER over
 *      `exec_stream`, failing closed on the first non-zero exit;
 *   4. it launches the image-provided harness (or, for a `*-shell` session,
 *      `zsh`) through `exec_tty` with explicit `user="<uid>:<gid>"`,
 *      `working_dir` and terminal `rows`/`cols`;
 *   5. it forwards host stdin ONLY after `exec_tty.ready` is observed, honours
 *      bounded backpressure (a high-water mark pauses the host stream), writes
 *      guest stdout bytes back with no transformation or loss, and sends
 *      `exec_tty.stdin_eof` when host stdin ends;
 *   6. it applies NO workflow-round deadline to the interactive session (the
 *      per-call exec request deadline is disabled; readiness and stdin drains
 *      stay bounded), and
 *   7. it resolves with the launched process exit status, while teardown is
 *      bounded and NEVER claims success on an unconfirmed VM closure: an
 *      unconfirmed close yields a non-success outcome naming the VM.
 *
 * US-011 layers host-terminal integration onto the same controller through
 * injectable seams:
 *
 *   8. host raw mode is enabled BEFORE the launch and restored exactly once on
 *      every catchable exit (success, thrown error, SIGINT/SIGTERM/SIGHUP and
 *      terminal disconnect);
 *   9. `SIGWINCH` is re-probed and forwarded as `exec_tty.resize`;
 *  10. `SIGINT` (Ctrl-C) is forwarded to the guest application as the raw input
 *      byte `0x03` — it never terminates the host session;
 *  11. external termination (`SIGTERM`/`SIGHUP`) or a terminal disconnect runs a
 *      bounded teardown that cancels the in-flight `exec_tty` FIRST and then
 *      closes this session's VM with a positive timeout.
 *
 * Host streams, terminal dimensions, signal/raw-mode hooks and the controller
 * backend are injectable so the whole state machine is unit-testable against an
 * owned fake backend — no real VM, model call or matchlock invocation ever
 * happens in tests.
 */

import {
  MatchlockController,
  type MatchlockControllerOptions,
} from "./controller.js";
import type { PinnedImageIdentity } from "./image.js";
import type { InteractiveGuestPrepPlan } from "./interactive-guest-prep.js";
import type { InteractiveSessionPlan } from "./interactive-session-plan.js";
import { buildInteractiveSessionCreateConfig, type MountAdmissionContext } from "./mount-plan.js";
import { decodeFrameBytes, type MatchlockTtyHandle, type StreamNotify } from "./rpc-client.js";
import type { ExecutionIsolation } from "./policy.js";
import type {
  MatchlockExecOptions,
  MatchlockExecResult,
  MatchlockRequestId,
  MatchlockStreamFrame,
  MatchlockTtyExecOptions,
} from "./types.js";

/** Typed refusal code: the controller was asked to run more than once. */
export const INTERACTIVE_SESSION_ALREADY_STARTED_CODE =
  "interactive_session_already_started" as const;

/** Typed refusal code: an in-guest preparation command failed. */
export const INTERACTIVE_SESSION_GUEST_PREP_FAILED_CODE =
  "interactive_session_guest_prep_failed" as const;

/** Typed failure code: the guest never signalled `exec_tty.ready` in time. */
export const INTERACTIVE_SESSION_READY_TIMEOUT_CODE =
  "interactive_session_ready_timeout" as const;

/** Typed failure code: host stdin/EOF could not be delivered to the guest PTY. */
export const INTERACTIVE_SESSION_INPUT_FAILED_CODE =
  "interactive_session_input_failed" as const;

/** Typed failure code: a non-I/O session failure with cleanup diagnostics attached. */
export const INTERACTIVE_SESSION_FAILED_CODE = "interactive_session_failed" as const;

/** Default independent `exec_tty.ready` deadline (ms), owned by the controller. */
export const INTERACTIVE_SESSION_READY_TIMEOUT_MS = 15_000;

/** Typed, actionable failure for an interactive session controller. */
export class InteractiveSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InteractiveSessionError";
    this.code = code;
  }
}

/**
 * Render an unknown failure value into an actionable message. A JSON-RPC error
 * body is a plain `{ code, message }` object (NOT an Error), so `String(value)`
 * would yield the useless `[object Object]`; prefer the real `.message` so the
 * original transport diagnostic survives.
 */
export function renderUnknownError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return String(value);
}

/** Signals the interactive controller handles on the host terminal. */
export type InteractiveSessionSignalName = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGWINCH";

/**
 * Injectable host-terminal integration (US-011). Both methods are optional so a
 * test can supply only the seam it exercises; the default implementation
 * touches the real process terminal.
 *
 *   - `enableRawMode()` turns on host raw mode BEFORE the guest launch and
 *     returns an idempotent restore function that MUST be callable any number
 *     of times. When the host stdin is not a TTY it returns a no-op restore.
 *   - `onSignal(signal, handler)` registers one host signal handler and returns
 *     a disposer that removes exactly that handler.
 */
export interface InteractiveSessionTerminalHooks {
  enableRawMode?: () => (() => void) | void;
  onSignal?: (signal: InteractiveSessionSignalName, handler: () => void) => () => void;
}

/** Raw Ctrl-C byte forwarded to the guest application on host `SIGINT`. */
export const INTERACTIVE_SESSION_CTRL_C_BYTE = 0x03;

/** Real-process terminal hooks used when no injectable hook is supplied. */
export const DEFAULT_INTERACTIVE_SESSION_TERMINAL: Required<InteractiveSessionTerminalHooks> = {
  enableRawMode(): () => void {
    const stdin = process.stdin as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
      isRaw?: boolean;
    };
    if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) {
      return () => {};
    }
    // Never clobber a caller that was already in raw mode.
    if (stdin.isRaw === true) {
      return () => {};
    }
    stdin.setRawMode(true);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* the terminal may already be gone; nothing to restore */
      }
    };
  },
  onSignal(signal: InteractiveSessionSignalName, handler: () => void): () => void {
    process.on(signal, handler);
    return () => {
      process.removeListener(signal, handler);
    };
  },
};

/**
 * The subset of the shipped `MatchlockController` the session core drives.
 * `MatchlockController` satisfies this structurally; tests inject an owned
 * fake so no real VM/RPC child is ever created.
 */
export interface InteractiveSessionVmBackend {
  prepareAndCreate(
    expected: PinnedImageIdentity,
  ): Promise<{ vmId: string; identity: PinnedImageIdentity }>;
  execStream(
    cmd: MatchlockExecOptions,
    notify: StreamNotify,
    timeoutMs?: number,
  ): Promise<MatchlockExecResult>;
  execTty(
    cmd: MatchlockTtyExecOptions,
    notify: StreamNotify,
    timeoutMs?: number,
  ): MatchlockTtyHandle;
  cancel(requestId: MatchlockRequestId): Promise<boolean>;
  close(timeoutSeconds: number): Promise<void>;
  dispose(): Promise<{ code: number | null; signal: string | null }>;
  readonly identity: { invocationId: string; vmId: string | null };
  readonly isClosed: boolean;
}

/** Injectable factory for the owned VM backend (tests inject a fake). */
export type InteractiveSessionBackendFactory = (
  policy: ExecutionIsolation,
  options: MatchlockControllerOptions,
) => InteractiveSessionVmBackend;

/** The bounded, non-success-aware outcome of ONE interactive session. */
export interface InteractiveSessionOutcome {
  /** The launched guest process exit status (null when it never ran). */
  exitCode: number | null;
  /** The VM this session created (empty string when create never returned). */
  vmId: string;
  /**
   * True ONLY when the VM close was positively CONFIRMED on the wire. When
   * false the session MUST NOT be treated as a success — killing the RPC child
   * alone is never VM-close proof.
   */
  cleanupConfirmed: boolean;
  /** Present when cleanup was not confirmed: names the VM + the failure. */
  cleanupError?: string;
  /** True when the session was cancelled before the guest exited. */
  cancelled: boolean;
}

/** Injectable host integration for deterministic unit tests. */
export interface InteractiveSessionOptions {
  /** Override the owned backend factory (tests); default builds a real controller. */
  createBackend?: InteractiveSessionBackendFactory;
  /** Absolute path to the matchlock binary for the owned RPC control child. */
  rpcBinaryPath?: string;
  /** Extra args for `matchlock rpc` (tests pass the fake driver path). */
  rpcArgs?: string[];
  /** Extra env keys for the RPC child (test seams). */
  rpcEnv?: Record<string, string>;
  /** Logger override forwarded to the owned controller. */
  onLog?: MatchlockControllerOptions["onLog"];
  /** Response deadline (ms) for non-interactive RPCs (create/resolve). */
  requestTimeoutMs?: number;
  /** `exec_tty.ready` observation deadline (ms) — bounded readiness only. */
  readyTimeoutMs?: number;
  /** Bounded stdin-drain deadline (ms) for one stdin chunk. */
  stdinDrainTimeoutMs?: number;
  /** Bounded settle wait (ms) after cancelling in-flight execs. */
  execCancelSettleTimeoutMs?: number;
  /** Explicit `create` deadline (ms); cold boots can exceed requestTimeoutMs. */
  createTimeoutMs?: number;
  /** Mount-plan admission context (tests pin home/live-state deterministically). */
  admission?: MountAdmissionContext;
  /** Host stdin source (default `process.stdin`). */
  stdin?: NodeJS.ReadableStream;
  /** Host stdout sink (default `process.stdout`). */
  stdout?: NodeJS.WritableStream;
  /** Terminal dimension probe (default `process.stdout`); injectable for tests. */
  terminalSize?: () => { rows?: number; cols?: number } | null | undefined;
  /** Explicit initial terminal rows (overrides the probe). */
  rows?: number;
  /** Explicit initial terminal cols (overrides the probe). */
  cols?: number;
  /** Launch command override (default: the harness name, or `zsh` for `*-shell`). */
  command?: string;
  /**
   * MTLK-INTERACTIVE (US-013): optional post-create guest-preparation resolver.
   * The controller creates the VM first, then calls this with the owned backend
   * so the orchestration can OBSERVE the disposable guest (passwd/group
   * entries, existing directories, the image harness/zsh) and produce the
   * effective {@link InteractiveGuestPrepPlan}. When supplied, its plan drives
   * the preparation commands, the launch working directory and the
   * harness/shell usability gate; the constructor `prep` still supplies the
   * VM-wide create environment and the harness/shell identity, both of which
   * are known before the guest exists. When omitted the constructor `prep` is
   * used unchanged (US-010 behavior).
   */
  resolveGuestPrep?: (
    backend: InteractiveSessionVmBackend,
  ) => Promise<InteractiveGuestPrepPlan>;
  /** Bounded host-input queue high-water mark, bytes (default 1 MiB). */
  stdinHighWaterBytes?: number;
  /** Bounded deadline (ms) per guest preparation command (default client default). */
  guestPrepTimeoutMs?: number;
  /** Bounded positive close timeout (seconds) for the owned VM (default 30). */
  closeTimeoutSeconds?: number;
  /**
   * Injectable terminal raw-mode + signal hooks (US-011). Defaults to the real
   * process terminal; tests inject an owned fake so no host signal handler,
   * raw mode or real terminal state is ever touched.
   */
  terminal?: InteractiveSessionTerminalHooks;
}

/** Default bounded host-input high-water mark (bytes). */
export const INTERACTIVE_SESSION_STDIN_HIGH_WATER_BYTES = 1024 * 1024;

/** Default bounded VM-close timeout (seconds). */
export const INTERACTIVE_SESSION_CLOSE_TIMEOUT_SECONDS = 30;

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

// ── bounded host-stdin forwarder ─────────────────────────────────────

/**
 * Forwards host stdin bytes to an `exec_tty` handle with two hard rules:
 *   - NOTHING is forwarded until `markReady()` (the `exec_tty.ready` frame),
 *     so the runtime's PTY session is always registered before input;
 *   - the pending queue is bounded: when queued bytes reach the high-water mark
 *     the host stream is paused and resumed once the queue drains, so a slow
 *     wire can never grow an unbounded buffer.
 *
 * Host EOF is remembered and an `exec_tty.stdin_eof` is sent exactly once,
 * AFTER every queued byte has been written.
 */
class HostStdinForwarder {
  private ready = false;
  private stopped = false;
  private writing = false;
  private paused = false;
  private eofPending = false;
  private eofSent = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private error: unknown;
  /** Resolves with the FIRST write/EOF/stream error (never rejects). */
  private readonly errorPromise: Promise<unknown>;
  private errorResolve!: (err: unknown) => void;

  constructor(
    private readonly stdin: NodeJS.ReadableStream,
    private readonly handle: MatchlockTtyHandle,
    private readonly highWaterBytes: number,
  ) {
    this.errorPromise = new Promise<unknown>((resolve) => {
      this.errorResolve = resolve;
    });
    this.stdin.on("data", this.onData);
    this.stdin.on("end", this.onEnd);
    this.stdin.on("error", this.onError);
    // Hold the host stream until the guest PTY is ready.
    this.pause();
  }

  /** The `exec_tty.ready` frame was observed: start draining. */
  markReady(): void {
    if (this.ready || this.stopped) return;
    this.ready = true;
    this.resume();
    void this.flush();
  }

  /** Detach from the host stream once the session ends. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stdin.removeListener("data", this.onData);
    this.stdin.removeListener("end", this.onEnd);
    this.stdin.removeListener("error", this.onError);
  }

  /**
   * Inject bytes that did NOT arrive on the host stream (US-011: a host
   * `SIGINT` is forwarded as the raw Ctrl-C byte `0x03`). Injection obeys the
   * exact same readiness gate and bounded queue as host stdin, so a Ctrl-C
   * received before `exec_tty.ready` is queued, never lost, and never grows
   * an unbounded buffer.
   */
  inject(bytes: Buffer): void {
    this.enqueue(bytes);
  }

  /** True once host EOF was observed (used to distinguish EOF from disconnect). */
  get sawEof(): boolean {
    return this.eofPending || this.eofSent;
  }

  /** The first stdin-write/EOF error, if any (surfaced by the caller). */
  get firstError(): unknown {
    return this.error;
  }

  /**
   * Resolves with the FIRST stdin-write/EOF/stream error, so the session can
   * race a lost host-input failure against the guest result instead of
   * discarding it and reporting a false success.
   */
  get errored(): Promise<unknown> {
    return this.errorPromise;
  }

  /** True once `exec_tty.ready` was observed and draining began. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Record the first error exactly once, resolving the exposed promise. */
  private recordError(err: unknown): void {
    if (this.error !== undefined) return;
    this.error = err;
    this.errorResolve(err);
  }

  private enqueue(bytes: Buffer): void {
    if (this.stopped || bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.ready && this.pendingBytes >= this.highWaterBytes) this.pause();
    if (this.ready) void this.flush();
  }

  private readonly onData = (chunk: unknown): void => {
    if (this.stopped) return;
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    this.enqueue(bytes);
  };

  private readonly onEnd = (): void => {
    if (this.stopped) return;
    this.eofPending = true;
    if (this.ready) void this.flush();
  };

  private readonly onError = (err: unknown): void => {
    this.recordError(err);
  };

  private async flush(): Promise<void> {
    if (this.writing || this.stopped || !this.ready) return;
    this.writing = true;
    try {
      while (!this.stopped && this.pending.length > 0) {
        const chunk = this.pending.shift() as Buffer;
        this.pendingBytes -= chunk.length;
        if (this.pendingBytes < this.highWaterBytes) this.resume();
        await this.handle.stdin.write(chunk);
      }
      if (!this.stopped && this.eofPending && !this.eofSent) {
        this.eofSent = true;
        await this.handle.stdin.eof();
      }
    } catch (err) {
      this.recordError(err);
    } finally {
      this.writing = false;
      if (!this.stopped && this.ready && (this.pending.length > 0 || (this.eofPending && !this.eofSent))) {
        void this.flush();
      }
    }
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    try {
      this.stdin.pause();
    } catch {
      /* not every Readable supports pause(); the queue bound still holds */
    }
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    try {
      this.stdin.resume();
    } catch {
      /* see pause() */
    }
  }
}

// ── the foreground session controller ────────────────────────────────

/**
 * Owns ONE foreground interactive session over ONE fresh Matchlock VM. Call
 * `run()` once; `cancel()` may be called from any task to request bounded
 * cancellation of the in-flight guest request (teardown still runs).
 */
export class InteractiveSessionController {
  private readonly plan: InteractiveSessionPlan;
  private readonly prep: InteractiveGuestPrepPlan;
  private readonly options: InteractiveSessionOptions;
  private readonly hostStdin: NodeJS.ReadableStream;
  private readonly hostStdout: NodeJS.WritableStream;
  private readonly highWaterBytes: number;
  private readonly closeTimeoutSeconds: number;
  private readonly guestPrepTimeoutMs: number | undefined;
  private readonly launchCommand: string;
  private readonly readyTimeoutMs: number;
  private readonly rows: number;
  private readonly cols: number;
  private readonly sizeProbe: () => { rows?: number; cols?: number } | null | undefined;
  private readonly terminalHooks: Required<InteractiveSessionTerminalHooks>;

  private backend: InteractiveSessionVmBackend | null = null;
  private handle: MatchlockTtyHandle | null = null;
  private forwarder: HostStdinForwarder | null = null;
  private vmId: string | null = null;
  /** The resolved guest-prep plan (post-probe when a resolver is supplied). */
  private effectivePrep: InteractiveGuestPrepPlan | null = null;
  private started = false;
  private cancelled = false;
  private cancelReason: string | null = null;
  private exitCode: number | null = null;

  /** Latest known terminal dimensions (updated by SIGWINCH). */
  private currentRows: number;
  private currentCols: number;
  /** Resolves the moment external termination/disconnect is requested. */
  private cancelGate: { promise: Promise<void>; resolve: () => void } | null = null;
  /** The bounded in-flight cancel driven by an external termination. */
  private pendingCancel: Promise<boolean> | null = null;
  /** Signal/stream disposers + the idempotent raw-mode restore. */
  private terminalDisposers: Array<() => void> = [];
  private restoreRawMode: (() => void) | null = null;
  private hostStdinEnded = false;
  /** Independent `exec_tty.ready` deadline owned by the controller. */
  private readyTimer: NodeJS.Timeout | null = null;
  /** True once the `exec_tty.ready` frame was observed. */
  private readyObserved = false;
  /** True when this session failed because readiness never arrived. */
  private readyDeadlineExpired = false;
  /** The typed readiness failure surfaced after the deadline expires. */
  private readyDeadlineError: unknown = null;

  constructor(
    plan: InteractiveSessionPlan,
    prep: InteractiveGuestPrepPlan,
    options: InteractiveSessionOptions = {},
  ) {
    this.plan = plan;
    this.prep = prep;
    this.options = options;
    this.hostStdin = options.stdin ?? process.stdin;
    this.hostStdout = options.stdout ?? process.stdout;
    this.highWaterBytes = normalizePositiveInteger(
      options.stdinHighWaterBytes,
      INTERACTIVE_SESSION_STDIN_HIGH_WATER_BYTES,
    );
    this.closeTimeoutSeconds = normalizePositiveInteger(
      options.closeTimeoutSeconds,
      INTERACTIVE_SESSION_CLOSE_TIMEOUT_SECONDS,
    );
    this.guestPrepTimeoutMs = options.guestPrepTimeoutMs;
    this.readyTimeoutMs = normalizePositiveInteger(
      options.readyTimeoutMs,
      INTERACTIVE_SESSION_READY_TIMEOUT_MS,
    );
    this.launchCommand =
      options.command ?? (prep.shell ? "zsh" : prep.harness);
    this.sizeProbe = options.terminalSize ?? defaultTerminalSizeProbe;
    // Bind the injected hooks to their owner so an object whose methods use
    // `this` (a stateful test double or adapter) keeps working after extraction.
    const hooks = options.terminal;
    this.terminalHooks = {
      enableRawMode:
        hooks?.enableRawMode?.bind(hooks) ??
        DEFAULT_INTERACTIVE_SESSION_TERMINAL.enableRawMode,
      onSignal:
        hooks?.onSignal?.bind(hooks) ?? DEFAULT_INTERACTIVE_SESSION_TERMINAL.onSignal,
    };
    const dimensions = resolveTerminalDimensions(options, this.sizeProbe);
    this.rows = dimensions.rows;
    this.cols = dimensions.cols;
    this.currentRows = dimensions.rows;
    this.currentCols = dimensions.cols;
  }

  /** The VM id once `create` has returned (null before). */
  get createdVmId(): string | null {
    return this.vmId;
  }

  /** Whether a bounded cancellation has been requested. */
  get cancellationRequested(): boolean {
    return this.cancelled;
  }

  /** The cancellation reason, once requested. */
  get cancellationReason(): string | null {
    return this.cancelReason;
  }

  /** Last confirmed guest exit status (null until it resolves). */
  get lastExitCode(): number | null {
    return this.exitCode;
  }

  /**
   * Request bounded cancellation: cancels the in-flight `exec_tty` request
   * (the guest application receives the runtime's cancellation) and lets
   * `run()` finish with its bounded teardown. Idempotent and safe to call at
   * any time (before create it simply marks the session cancelled).
   */
  cancel(reason = "interactive session cancelled"): void {
    this.requestTermination(reason);
  }

  /**
   * Install the host-terminal integration, enable raw mode BEFORE the launch,
   * then run the session. Raw mode is restored exactly once on EVERY catchable
   * exit — success, a thrown error, `SIGINT`/`SIGTERM`/`SIGHUP` and terminal
   * disconnect — and every signal/stream hook is unregistered in the same
   * `finally`.
   */
  async run(): Promise<InteractiveSessionOutcome> {
    if (this.started) {
      throw new InteractiveSessionError(
        INTERACTIVE_SESSION_ALREADY_STARTED_CODE,
        "An interactive session controller runs exactly once; create a fresh controller per session.",
      );
    }
    this.started = true;
    this.installTerminalIntegration();
    this.restoreRawMode = this.enableRawMode();
    try {
      return await this.runSession();
    } finally {
      this.restoreRawMode?.();
      this.restoreRawMode = null;
      this.detachTerminalIntegration();
    }
  }

  /**
   * The session lifecycle proper (create -> prep -> exec_tty -> bounded
   * confirmed teardown). {@link run} owns the terminal state around it.
   */
  private async runSession(): Promise<InteractiveSessionOutcome> {
    const backend = this.resolveBackend();
    this.backend = backend;
    // Created up front so a termination arriving at ANY point can break the
    // long-lived exec wait instead of hanging until the guest exits.
    const cancelGate = this.getCancelGate();

    let failed = false;
    let failure: unknown;
    let cancelled = false;
    let result: MatchlockExecResult | null = null;

    try {
      const created = await backend.prepareAndCreate(this.plan.pinnedIdentity);
      this.vmId = created.vmId;

      if (this.cancelled) {
        cancelled = true;
      } else {
        // Resolve the effective prep AFTER create so the orchestration can
        // observe the disposable guest and fail closed before launch (US-013).
        const prep =
          this.options.resolveGuestPrep !== undefined
            ? await this.options.resolveGuestPrep(backend)
            : this.prep;
        this.effectivePrep = prep;
        await this.runGuestPrep(backend, prep);
        if (this.cancelled) {
          cancelled = true;
        } else {
          // NO workflow-round deadline: timeoutMs 0 disables the per-request
          // response timer for the long-lived interactive PTY. Readiness and
          // stdin drains stay independently bounded in the RPC client.
          const handle = backend.execTty(
            {
              command: this.launchCommand,
              working_dir: prep.guestWorkingDirectory,
              user: `${this.plan.identity.uid}:${this.plan.identity.gid}`,
              rows: this.rows,
              cols: this.cols,
            },
            (frame) => this.onFrame(frame),
            0,
          );
          this.handle = handle;
          this.forwarder = new HostStdinForwarder(
            this.hostStdin,
            handle,
            this.highWaterBytes,
          );
          // Defensive ordering: a `ready` delivered between the handle
          // assignment and forwarder construction was remembered; open the
          // gate now instead of dropping it.
          if (this.readyObserved) this.forwarder.markReady();
          const forwarder = this.forwarder;
          try {
            // A readiness deadline INDEPENDENT of the (disabled) request timer
            // so a guest that never emits `exec_tty.ready` cannot hang forever.
            this.armReadyDeadline(handle);
            // Race the guest result against external termination/disconnect AND
            // against a lost host-input/EOF failure, so the bounded teardown can
            // begin immediately instead of waiting for a result that may never
            // settle.
            const raced = await Promise.race([
              handle.result.then(
                (value) => ({ kind: "exit" as const, value }),
                (error: unknown) => ({ kind: "error" as const, error }),
              ),
              cancelGate.promise.then(() => ({ kind: "terminated" as const })),
              forwarder.errored.then((error) => ({ kind: "io-error" as const, error })),
            ]);
            if (raced.kind === "exit") {
              result = raced.value;
              this.exitCode = result.exit_code;
              // A recorded write/EOF failure means host input was lost even
              // when the guest still exited 0 (D2/D3): never report success.
              if (forwarder.firstError !== undefined) {
                failed = true;
                failure = this.inputFailure(forwarder.firstError);
              }
            } else if (raced.kind === "io-error") {
              failed = true;
              failure = this.inputFailure(raced.error);
              // The still-pending exec is cancelled BEFORE close; the abandoned
              // result is observed so it can never surface unhandled.
              this.pendingCancel = backend.cancel(handle.requestId).catch(() => false);
              void handle.result.catch(() => {});
            } else if (raced.kind === "terminated") {
              if (this.readyDeadlineExpired) {
                failed = true;
                failure = this.readyDeadlineError;
              } else {
                cancelled = true;
              }
              // The abandoned exec rejection is already observed so it can
              // never surface as an unhandled rejection.
              void handle.result.catch(() => {});
            } else if (this.cancelled) {
              cancelled = true;
            } else {
              failed = true;
              failure = raced.error;
            }
          } finally {
            this.clearReadyDeadline();
            this.forwarder?.stop();
            this.forwarder = null;
            this.handle = null;
          }
        }
      }
    } catch (err) {
      failed = true;
      failure = err;
    }

    const teardown = await this.teardown(backend);

    if (failed) {
      // Bounded cleanup has already been attempted; surface the original
      // failure TOGETHER with the cleanup status, VM identity and close error
      // (D4) instead of throwing bare and discarding the teardown diagnostics.
      const vmLabel = this.vmId === null ? "no VM was created" : `VM ${this.vmId}`;
      const cleanup = teardown.confirmed
        ? `cleanup for ${vmLabel} was confirmed`
        : `cleanup for ${vmLabel} was NOT confirmed: ${teardown.error ?? "reason unknown"}`;
      if (failure instanceof InteractiveSessionError) {
        throw new InteractiveSessionError(failure.code, `${failure.message}; ${cleanup}.`);
      }
      throw new InteractiveSessionError(
        INTERACTIVE_SESSION_FAILED_CODE,
        `Interactive session failed: ${renderUnknownError(failure)}; ${cleanup}.`,
      );
    }

    return {
      exitCode: result ? result.exit_code : null,
      vmId: this.vmId ?? "",
      cleanupConfirmed: teardown.confirmed,
      ...(teardown.error !== undefined ? { cleanupError: teardown.error } : {}),
      cancelled: cancelled || this.cancelled,
    };
  }

  /**
   * Request bounded termination (external signal or disconnect). Idempotent:
   * the FIRST request cancels the in-flight `exec_tty` (bounded by the client's
   * own cancel deadline), marks the session cancelled and opens the cancel gate
   * so `run()` stops waiting and drives the bounded cancel-then-close teardown.
   * Never awaited here, so a signal handler can never block.
   */
  private requestTermination(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
    if (this.backend && this.handle) {
      this.pendingCancel = this.backend.cancel(this.handle.requestId).catch(() => false);
    }
    this.cancelGate?.resolve();
  }

  private getCancelGate(): { promise: Promise<void>; resolve: () => void } {
    if (!this.cancelGate) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.cancelGate = { promise, resolve };
    }
    return this.cancelGate;
  }

  /**
   * Arm the INDEPENDENT readiness deadline when `exec_tty` is issued. The
   * per-request response timer stays disabled (`timeoutMs=0`) so no
   * workflow/session-duration deadline is imposed; this timer guards ONLY the
   * `exec_tty.ready` handshake. On expiry it records a typed failure, cancels
   * the in-flight exec BEFORE close and opens the cancel gate so the race
   * exits and the bounded teardown runs.
   */
  private armReadyDeadline(handle: MatchlockTtyHandle): void {
    this.clearReadyDeadline();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.readyObserved || this.cancelled) return;
      this.readyDeadlineExpired = true;
      this.readyDeadlineError = new InteractiveSessionError(
        INTERACTIVE_SESSION_READY_TIMEOUT_CODE,
        `exec_tty.ready was not observed within ${this.readyTimeoutMs}ms for Matchlock VM ` +
          `${this.vmId ?? "(unknown)"}; cancelling and closing the session instead of hanging.`,
      );
      if (this.backend) {
        this.pendingCancel = this.backend.cancel(handle.requestId).catch(() => false);
      }
      this.cancelGate?.resolve();
    }, this.readyTimeoutMs);
  }

  private clearReadyDeadline(): void {
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /** Build the typed failure for a lost host-input/EOF delivery. */
  private inputFailure(error: unknown): InteractiveSessionError {
    return new InteractiveSessionError(
      INTERACTIVE_SESSION_INPUT_FAILED_CODE,
      `Interactive stdin delivery to Matchlock VM ${this.vmId ?? "(unknown)"} failed: ` +
        `${renderUnknownError(error)}; refusing to report success because host input was lost.`,
    );
  }

  /** Register the injectable signal/stream hooks for the whole session. */
  private installTerminalIntegration(): void {
    const hooks = this.terminalHooks;
    const registerSignal = (
      signal: InteractiveSessionSignalName,
      handler: () => void,
    ): void => {
      try {
        this.terminalDisposers.push(hooks.onSignal(signal, handler));
      } catch {
        /* a platform that cannot register the signal simply has no hook */
      }
    };
    registerSignal("SIGINT", this.onSigint);
    registerSignal("SIGTERM", this.onSigterm);
    registerSignal("SIGHUP", this.onSighup);
    registerSignal("SIGWINCH", this.onSigwinch);

    // Terminal disconnect: host stdin closing BEFORE EOF, or any host terminal
    // stream erroring (EPIPE/EIO once the terminal is gone).
    if (typeof this.hostStdin.on === "function") {
      this.hostStdin.on("end", this.onHostStdinEnd);
      this.hostStdin.on("close", this.onHostStdinClose);
      this.hostStdin.on("error", this.onHostStdinError);
      this.terminalDisposers.push(() => {
        this.hostStdin.removeListener("end", this.onHostStdinEnd);
        this.hostStdin.removeListener("close", this.onHostStdinClose);
        this.hostStdin.removeListener("error", this.onHostStdinError);
      });
    }
    const stdout = this.hostStdout as NodeJS.WritableStream & {
      on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    if (typeof stdout.on === "function") {
      stdout.on("error", this.onHostStdoutError);
      this.terminalDisposers.push(() => {
        stdout.removeListener?.("error", this.onHostStdoutError);
      });
    }
  }

  private detachTerminalIntegration(): void {
    const disposers = this.terminalDisposers;
    this.terminalDisposers = [];
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* best effort: never let a dispose failure mask the session outcome */
      }
    }
  }

  private enableRawMode(): () => void {
    try {
      const restore = this.terminalHooks.enableRawMode();
      return typeof restore === "function" ? restore : () => {};
    } catch {
      return () => {};
    }
  }

  /**
   * Forward a host `SIGINT` to the guest application as the raw Ctrl-C byte
   * `0x03` (through the same readiness gate/bounded queue as host stdin). It
   * NEVER terminates the host session — the guest decides what Ctrl-C means.
   */
  private forwardCtrlC(): void {
    this.forwarder?.inject(Buffer.from([INTERACTIVE_SESSION_CTRL_C_BYTE]));
  }

  /**
   * Forward a host `SIGWINCH` as `exec_tty.resize` after re-probing the current
   * terminal dimensions. A resize after the PTY closed is a harmless no-op.
   */
  private forwardResize(): void {
    const handle = this.handle;
    if (!handle) return;
    const size = this.sizeProbe();
    this.currentRows = normalizePositiveInteger(size?.rows, this.currentRows);
    this.currentCols = normalizePositiveInteger(size?.cols, this.currentCols);
    void handle.resize(this.currentRows, this.currentCols).catch(() => {
      /* a resize raced the PTY exit; the outcome depends only on exit + close */
    });
  }

  private readonly onSigint = (): void => {
    this.forwardCtrlC();
  };

  private readonly onSigterm = (): void => {
    this.requestTermination("received SIGTERM: bounded cancel-then-close teardown");
  };

  private readonly onSighup = (): void => {
    this.requestTermination("received SIGHUP: bounded cancel-then-close teardown");
  };

  private readonly onSigwinch = (): void => {
    this.forwardResize();
  };

  private readonly onHostStdinEnd = (): void => {
    // A normal host EOF (Ctrl-D) is NOT a disconnect: the guest may still be
    // finishing. Only a close WITHOUT a preceding end is a disconnect.
    this.hostStdinEnded = true;
  };

  private readonly onHostStdinClose = (): void => {
    if (this.hostStdinEnded) return;
    this.requestTermination("host terminal disconnected (stdin closed)");
  };

  private readonly onHostStdinError = (err: unknown): void => {
    this.requestTermination(
      `host terminal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  };

  private readonly onHostStdoutError = (err: unknown): void => {
    this.requestTermination(
      `host terminal output error: ${err instanceof Error ? err.message : String(err)}`,
    );
  };

  /** Build the ONE owned backend (real controller by default). */
  private resolveBackend(): InteractiveSessionVmBackend {
    const create =
      this.options.createBackend ??
      ((policy: ExecutionIsolation, opts: MatchlockControllerOptions) =>
        new MatchlockController(policy, opts));
    // MTLK-RPC-BIN-SPLIT (tamandua-dwl): the transport launches the ADMITTED
    // invocation when the plan carries one — the exact binary + argv the swap
    // handshake probed and admission bound (`resolvedRpc`). Only a plan without
    // a frozen invocation (direct controller construction in unit tests) falls
    // back to the explicit per-session option.
    const admittedRpc = this.plan.resolvedRpc;
    const transportRpc =
      admittedRpc !== undefined
        ? { rpcBinaryPath: admittedRpc.binaryPath, rpcArgs: [...admittedRpc.args] }
        : {
            ...(this.options.rpcBinaryPath !== undefined
              ? { rpcBinaryPath: this.options.rpcBinaryPath }
              : {}),
            ...(this.options.rpcArgs !== undefined ? { rpcArgs: this.options.rpcArgs } : {}),
          };
    const controllerOptions: MatchlockControllerOptions = {
      requireHelperPack: false,
      ...transportRpc,
      ...(this.options.rpcEnv !== undefined ? { rpcEnv: this.options.rpcEnv } : {}),
      ...(this.options.onLog !== undefined ? { onLog: this.options.onLog } : {}),
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
      ...(this.options.readyTimeoutMs !== undefined
        ? { readyTimeoutMs: this.options.readyTimeoutMs }
        : {}),
      ...(this.options.stdinDrainTimeoutMs !== undefined
        ? { stdinDrainTimeoutMs: this.options.stdinDrainTimeoutMs }
        : {}),
      ...(this.options.execCancelSettleTimeoutMs !== undefined
        ? { execCancelSettleTimeoutMs: this.options.execCancelSettleTimeoutMs }
        : {}),
      ...(this.options.createTimeoutMs !== undefined
        ? { createTimeoutMs: this.options.createTimeoutMs }
        : {}),
      ...(this.options.admission !== undefined
        ? { mountAdmission: this.options.admission }
        : {}),
      // The launch environment (HOME, image PATH, config override, terminal
      // settings) is VM-wide: exec_tty carries no per-exec env, so it is merged
      // over the interactive create-config defaults.
      createEnv: { ...this.prep.env },
      buildCreateConfig: (policy, identity) =>
        buildInteractiveSessionCreateConfig(policy, identity, {
          ownerUid: this.plan.identity.uid,
          ownerGid: this.plan.identity.gid,
          ...(this.options.admission !== undefined
            ? { admission: this.options.admission }
            : {}),
        }),
    };
    return create(this.plan.policy, controllerOptions);
  }

  /** Run the ordered guest preparation commands, failing closed on non-zero. */
  private async runGuestPrep(
    backend: InteractiveSessionVmBackend,
    prep: InteractiveGuestPrepPlan,
  ): Promise<void> {
    for (const command of prep.commands) {
      const result = await backend.execStream(
        { command: command.command },
        () => {},
        this.guestPrepTimeoutMs,
      );
      if (result.exit_code !== 0) {
        throw new InteractiveSessionError(
          INTERACTIVE_SESSION_GUEST_PREP_FAILED_CODE,
          `Interactive guest preparation command "${command.id}" (${command.command}) failed with exit status ` +
            `${result.exit_code} in VM ${this.vmId ?? "unknown"}; refusing to launch the harness as an unprepared user.`,
        );
      }
    }
  }

  /**
   * Route one `exec_tty` frame: `ready` opens the host-input gate; `stdout`
   * bytes reach the host sink VERBATIM (raw base64 frame decoded exactly once,
   * so multi-byte UTF-8 sequences split across frames survive). A PTY has no
   * separate stderr, so no other frame kind is expected.
   */
  private onFrame(frame: MatchlockStreamFrame): void {
    if (frame.kind === "ready") {
      this.readyObserved = true;
      this.clearReadyDeadline();
      this.forwarder?.markReady();
      return;
    }
    if (frame.kind === "stdout") {
      const bytes = decodeFrameBytes(frame);
      if (bytes.length > 0) this.hostStdout.write(bytes);
    }
  }

  /**
   * Bounded teardown: cancel the in-flight `exec_tty` (when external
   * termination/disconnect requested it) FIRST, then close THIS session's VM
   * with the positive close timeout. `close` resolves ONLY on a wire-confirmed
   * close, so an unconfirmed closure yields `{confirmed: false}` naming the VM
   * and NEVER a success shape. Killing the RPC child (dispose) is used only
   * when no VM was ever created, and is never treated as proof of VM
   * termination.
   */
  private async teardown(
    backend: InteractiveSessionVmBackend,
  ): Promise<{ confirmed: boolean; error?: string }> {
    if (this.vmId === null) {
      try {
        await backend.dispose();
      } catch {
        /* best effort: no VM existed, nothing to confirm */
      }
      return { confirmed: false };
    }
    // Cancel-then-close ordering: the cancel request is already on the wire
    // (fired synchronously by requestTermination); awaiting it here keeps the
    // close strictly after it without ever hanging — the shipped client's
    // cancel has its own bounded deadline and close remains the authority.
    if (this.pendingCancel) {
      try {
        await this.pendingCancel;
      } catch {
        /* close below still decides the confirmed-cleanup outcome */
      }
    }
    try {
      await backend.close(this.closeTimeoutSeconds);
    } catch (err) {
      const detail = renderUnknownError(err);
      return {
        confirmed: false,
        error:
          `Matchlock VM ${this.vmId} was not confirmed closed (bounded close of ${this.closeTimeoutSeconds}s failed: ${detail}); ` +
          "the RPC child was left in place as retained diagnostics. Killing the RPC child alone is not proof of VM termination.",
      };
    }
    if (!backend.isClosed) {
      return {
        confirmed: false,
        error:
          `Matchlock VM ${this.vmId} close response did not positively confirm VM removal; ` +
          "the RPC child was left in place as retained diagnostics.",
      };
    }
    return { confirmed: true };
  }
}

/** True when cleanup was positively confirmed (never inferred from transport death). */
export function interactiveSessionSucceeded(outcome: InteractiveSessionOutcome): boolean {
  return outcome.cleanupConfirmed && !outcome.cancelled;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function defaultTerminalSizeProbe(): { rows?: number; cols?: number } | null {
  const out = process.stdout as NodeJS.WriteStream;
  return { rows: out.rows, cols: out.columns };
}

function resolveTerminalDimensions(
  options: InteractiveSessionOptions,
  probe: () => { rows?: number; cols?: number } | null | undefined,
): {
  rows: number;
  cols: number;
} {
  let probed: { rows?: number; cols?: number } | null | undefined;
  if (options.rows === undefined || options.cols === undefined) {
    probed = probe();
  }
  const rows = options.rows ?? probed?.rows ?? DEFAULT_ROWS;
  const cols = options.cols ?? probed?.cols ?? DEFAULT_COLS;
  return {
    rows: normalizePositiveInteger(rows, DEFAULT_ROWS),
    cols: normalizePositiveInteger(cols, DEFAULT_COLS),
  };
}
