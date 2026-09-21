/**
 * MatchlockRpcClient — US-002 low-level RPC transport.
 *
 * A line-delimited JSON-RPC client over `matchlock rpc` stdin/stdout. The
 * Matchlock controller owns the ONLY control RPC connection per invocation
 * (a fresh VM per probe/work/retry), and uses this client to speak the
 * protocol the runtime's pkg/rpc/handler.go actually implements.
 *
 * Wire contract (derived from the runtime source + image-contract):
 *   - one JSON-RPC request object per line on stdin, one response OR
 *     notification per line on stdout. Request ids are NUMERIC (uint64).
 *   - responses carry a top-level `id`; stream notifications carry a
 *     `method` plus `params.id` correlating to the exec request.
 *   - `exec_stream` streams `exec_stream.stdout` / `exec_stream.stderr`
 *     notifications (EVERY chunk base64-encoded individually) then resolves
 *     with `{exit_code, duration_ms}`.
 *   - `exec_pipe` streams `exec_pipe.ready` FIRST, then `exec_pipe.stdout` /
 *     `exec_pipe.stderr`. stdin is delivered via `exec_pipe.stdin` (base64
 *     `params.data`) then `exec_pipe.stdin_eof` — both are one-way
 *     NOTIFICATIONS (no id, no response: the handler returns nil). The
 *     runtime registers the per-request pipe channel before it sends `ready`,
 *     so the client MUST NOT write stdin before `ready` is observed (the
 *     server would silently drop the chunk); this client queues stdin until
 *     the `ready` notification arrives (bounded by `readyTimeoutMs`).
 *   - `cancel` takes `{id}` of the in-flight request to cancel; the runtime
 *     answers synchronously and the cancelled exec later rejects with
 *     `-32003` (ErrCodeCancelled).
 *   - `close` takes a POSITIVE `timeout_seconds` (a non-positive value is a
 *     runtime error, never an unlimited graceful wait) and the server waits
 *     for in-flight handlers before tearing the VM down. A close RESPONSE that
 *     names an already-stopped/closed VM is a confirmed close (US-004); only a
 *     transport failure with no wire response still rejects.
 *
 * Lifecycle/deadline guarantees (every owned failure is REPORTED, nothing
 * hangs an unresolved promise):
 *   - every request-response has a finite deadline (options.requestTimeoutMs,
 *     overridable per call; `close` derives its own from timeout_seconds);
 *   - stdin writes honour backpressure with a finite drain deadline and
 *     reject immediately on child close/error/dispose or once the exec
 *     request has settled (a write to a dead/ended pipe is an error, never a
 *     hang);
 *   - incoming lines are length-bounded BEFORE the full line is buffered: a
 *     pre-parse byte watchdog on the stdout stream disposes the transport as
 *     soon as an unterminated line exceeds maxLineLength (memory never grows
 *     past the cap), and the parsed-line check remains as a second layer;
 *   - dispose() kills the EXACT owned child handle and resolves only after
 *     the child close is observed (bounded) — it never re-signals a
 *     historical PID;
 *   - the owned child's real exit code AND exit signal are exposed through
 *     the read-only exitCode / exitSignal accessors (null/null while running);
 *     a signaled child is never rewritten into a success-shaped record.
 *
 * Memory/backpressure: streamed frames are handed to a caller callback and
 * never buffered here (the controller/capture layer enforces its own bounded
 * budget and disk spill). `execCommand` (buffered capture) assembles its
 * output from exec_stream notifications under an explicit byte budget so one
 * large result can never blow the transport's single-line cap.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { logger } from "../../lib/logger.js";
import type {
  MatchlockCreateParams,
  MatchlockCreateResult,
  MatchlockExecOptions,
  MatchlockExecResult,
  MatchlockExecBufferedResult,
  MatchlockRpcErrorBody,
  MatchlockRequestId,
  MatchlockStreamFrame,
} from "./types.js";

/** Client-originated error codes (kept away from the runtime's -32000 range). */
export const MATCHLOCK_CLIENT_ERROR_CODES = {
  /** A request/readiness/drain deadline expired. */
  TIMEOUT: -32090,
  /** The transport was disposed while the request was in flight. */
  DISPOSED: -32091,
  /** The peer violated the line protocol (e.g. oversized frame). */
  PROTOCOL: -32092,
  /** The exec request already settled (result/error/cancel); stdin is inert. */
  REQUEST_INACTIVE: -32093,
  /** The RPC child closed/errored before the request settled. */
  TRANSPORT_CLOSED: -32094,
  /** A buffered exec exceeded the caller's output budget (use streaming). */
  EXEC_OUTPUT_LIMIT: -32095,
} as const;

export function clientError(code: number, message: string): MatchlockRpcErrorBody {
  return { code, message };
}

/**
 * Every code this client originates itself (LOCAL transport/deadline failures).
 * A body carrying one of these has NO server wire response behind it and can
 * therefore never confirm a VM close.
 */
const CLIENT_ERROR_CODES = new Set<number>(Object.values(MATCHLOCK_CLIENT_ERROR_CODES));

/**
 * MTLK-CLEANUP US-004 — recognized benign close responses.
 *
 * A `close` response whose error body names an already-stopped / already-closed
 * / not-running VM is a CONFIRMED close, not a cleanup failure: the VM is
 * already gone, so there is nothing left to stop. This makes close idempotent
 * when the guest exited (or a previous close already ran) before the request
 * arrived.
 *
 * The patterns are deliberately narrow and message-based: a genuine
 * `Sandbox.Close` aggregate failure (a TAP/nftables/VFS/disk removal error) is
 * NEVER mistaken for a benign close, so a real cleanup failure still surfaces.
 * A dead transport / request deadline carries a client-originated code and is
 * refused here: no wire response means no confirmed close (a close is never
 * fabricated from transport death).
 */
const ALREADY_STOPPED_CLOSE_PATTERNS: readonly RegExp[] = [
  /\bvm not running\b/i,
  /\bvm is not running\b/i,
  /\bvm already (?:closed|stopped)\b/i,
  /\balready closed\b/i,
  /\balready stopped\b/i,
];

/**
 * True ONLY for a real JSON-RPC error BODY (finite numeric `code` + `message`)
 * that names an already-stopped/closed VM. An `Error`, a bare string, a
 * malformed value, any client-originated transport/deadline code, or a genuine
 * cleanup-failure message is false.
 */
export function isAlreadyStoppedCloseError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const body = err as { code?: unknown; message?: unknown };
  if (typeof body.code !== "number" || !Number.isFinite(body.code)) return false;
  if (CLIENT_ERROR_CODES.has(body.code)) return false;
  if (typeof body.message !== "string") return false;
  return ALREADY_STOPPED_CLOSE_PATTERNS.some((re) => re.test(body.message as string));
}

/**
 * Exec-family methods the client can put in flight and therefore cancels
 * before a graceful close (the runtime's close waits for handlers). exec_tty
 * is deliberately NOT here yet: this slice exposes no execTty() API and does
 * not route exec_tty.* frames, so no exec_tty request can be in flight — the
 * future tty/bridge stage re-adds it together with the full wiring.
 */
const EXEC_METHODS = new Set(["exec", "exec_stream", "exec_pipe"]);

export interface MatchlockRpcClientOptions {
  /** Absolute path to the matchlock CLI (tests inject a fake driver). */
  binaryPath?: string;
  /** Subcommand argv (default ["rpc"]). */
  args?: string[];
  /** Extra child env keys merged OVER process.env. This option only
   *  ADDS/overrides keys — the child inherits every other host env var, so a
   *  caller that must not leak host secrets needs an explicit sanitized env
   *  wrapper, not just this option. */
  env?: Record<string, string>;
  /** Logger override (defaults to the tamandua logger). */
  onLog?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
  /** Default request-response deadline in ms (default 60_000). 0 disables. */
  requestTimeoutMs?: number;
  /** Deadline in ms for a blocked stdin write to drain (default 10_000). */
  stdinDrainTimeoutMs?: number;
  /** Deadline in ms to wait for an exec_pipe `ready` notification before stdin
   *  may be sent (default 15_000). */
  readyTimeoutMs?: number;
  /** Bounded wait in ms for in-flight execs to settle after cancel before
   *  close proceeds (default 5_000). */
  execCancelSettleTimeoutMs?: number;
  /** Incoming line length cap in bytes; a longer line is a protocol failure
   *  (default 16 MiB — above the runtime's 10 MiB scanner token cap). The
   *  cap bounds memory BEFORE an unterminated line is fully buffered. */
  maxLineLength?: number;
  /** Byte budget for a BUFFERED exec (execCommand) captured output, applied
   *  while assembling exec_stream notifications (default 32 MiB). Overshooting
   *  rejects with EXEC_OUTPUT_LIMIT instead of blowing the single-line cap. */
  bufferedExecOutputLimitBytes?: number;
  /** Extra time added to a `close` request deadline beyond timeout_seconds
   *  (default 10_000 ms). */
  closeGraceMs?: number;
  /** How long dispose waits for the child to exit after SIGTERM before
   *  escalating to SIGKILL (default 2_000 ms). */
  disposeKillGraceMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: MatchlockRpcErrorBody) => void;
  notify?: (frame: MatchlockStreamFrame) => void;
  timer?: NodeJS.Timeout;
  settled: boolean;
  /** Settles when the exec_pipe.ready notification is observed. */
  readyWaiters: Array<{ resolve: () => void; reject: (err: MatchlockRpcErrorBody) => void }>;
  readySeen: boolean;
}

/** Route one stream notification frame to a registered callback. */
export interface StreamNotify {
  (frame: MatchlockStreamFrame): void;
}

export interface RequestCallOptions {
  /** Response deadline for this call (default: options.requestTimeoutMs). */
  timeoutMs?: number;
}

export interface MatchlockPipeStdin {
  /** Send one base64 stdin chunk for the pipe (after `ready`). Bounded. */
  write(data: Buffer | string): Promise<void>;
  /** Signal stdin EOF for the pipe (after `ready`). Bounded. */
  eof(): Promise<void>;
}

export interface MatchlockPipeHandle {
  requestId: MatchlockRequestId;
  stdin: MatchlockPipeStdin;
  result: Promise<MatchlockExecResult>;
}

/** Decode ONE frame's base64 exactly once, returning its bytes. */
export function decodeFrameBytes(frame: MatchlockStreamFrame): Buffer {
  return Buffer.from(frame.base64 ?? "", "base64");
}

/**
 * Decode a whole stream (concatenated frames) to text exactly once. Frames
 * keep raw base64 so multi-byte UTF-8 sequences split across chunk boundaries
 * survive: the BYTES are concatenated first and decoded last.
 */
export function decodeFramesText(frames: Array<MatchlockStreamFrame | { base64?: string }>): string {
  const parts: Buffer[] = [];
  for (const frame of frames) {
    if (frame.base64) parts.push(Buffer.from(frame.base64, "base64"));
  }
  return Buffer.concat(parts).toString("utf8");
}

function toFrame(method: string, params: unknown): MatchlockStreamFrame | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const requestId = typeof p.id === "number" ? p.id : undefined;
  if (method === "exec_pipe.ready") return { kind: "ready", requestId };
  if (method === "exec_stream.stdout" || method === "exec_stream.stderr" || method === "exec_pipe.stdout" || method === "exec_pipe.stderr") {
    // Raw wire bytes preserved verbatim; consumers decode exactly once.
    return {
      kind: method.endsWith("stderr") ? "stderr" : "stdout",
      base64: typeof p.data === "string" ? p.data : "",
      requestId,
    };
  }
  return null;
}

function decodeParamsErrorBody(err: unknown): MatchlockRpcErrorBody {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as MatchlockRpcErrorBody;
  }
  return clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, String(err));
}

export class MatchlockRpcClient {
  private readonly binaryPath: string;
  private readonly args: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly log: NonNullable<MatchlockRpcClientOptions["onLog"]>;
  private readonly requestTimeoutMs: number;
  private readonly stdinDrainTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly execCancelSettleTimeoutMs: number;
  private readonly maxLineLength: number;
  private readonly bufferedExecOutputLimitBytes: number;
  private readonly closeGraceMs: number;
  private readonly disposeKillGraceMs: number;

  private child: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private started = false;
  private disposed = false;
  private childExitCode: number | null = null;
  private childSignal: string | null = null;
  private lastExit: { code: number | null; signal: string | null } = { code: null, signal: null };
  private startError: Error | undefined;
  private disposePromise: Promise<{ code: number | null; signal: string | null }> | undefined;
  /** Bytes received since the last line terminator (pre-parse memory guard). */
  private stdoutPendingBytes = 0;
  /** True once the oversized-line protocol failure has been raised. */
  private protocolFailed = false;

  constructor(opts: MatchlockRpcClientOptions = {}) {
    this.binaryPath = opts.binaryPath ?? "matchlock";
    this.args = opts.args?.length ? opts.args : ["rpc"];
    this.env = { ...(process.env as Record<string, string | undefined>), ...(opts.env ?? {}) };
    this.log =
      opts.onLog ??
      ((level, msg, fields) => {
        if (level === "warn") logger.warn(`[matchlock-rpc] ${msg}`, fields);
        else logger.info(`[matchlock-rpc] ${msg}`, fields);
      });
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.stdinDrainTimeoutMs = opts.stdinDrainTimeoutMs ?? 10_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    this.execCancelSettleTimeoutMs = opts.execCancelSettleTimeoutMs ?? 5_000;
    this.maxLineLength = opts.maxLineLength ?? 16 * 1024 * 1024;
    this.bufferedExecOutputLimitBytes = opts.bufferedExecOutputLimitBytes ?? 32 * 1024 * 1024;
    this.closeGraceMs = opts.closeGraceMs ?? 10_000;
    this.disposeKillGraceMs = opts.disposeKillGraceMs ?? 2_000;
  }

  /** Whether the underlying child process is still running (owned handle). */
  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Last child exit code (or null while running/killed by signal). */
  get exitCode(): number | null {
    return this.childExitCode;
  }

  /**
   * Last child exit signal (e.g. "SIGTERM" after dispose kills the exact
   * owned child), or null while the child is running or on a normal exit.
   * Read-only forensic accessor: a signaled transport is reported with its
   * REAL signal — never rewritten into a success-shaped (code 0 / null
   * signal) record.
   */
  get exitSignal(): string | null {
    return this.childSignal;
  }

  /** Spawn failure error, if any. */
  get spawnError(): Error | undefined {
    return this.startError;
  }

  /** Whether dispose() has completed (or is no longer needed). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Spawn the `matchlock rpc` child and begin reading its stdout. The first
   * request doubles as the readiness probe and is bounded by its deadline.
   */
  start(): void {
    if (this.started) throw new Error("MatchlockRpcClient already started");
    this.started = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.binaryPath, this.args, {
        cwd: process.cwd(),
        env: this.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.startError = err as Error;
      throw err;
    }
    this.child = child;

    child.on("error", (err) => {
      this.startError = err;
      this.settleAll(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, `matchlock rpc spawn error: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      this.childExitCode = code;
      this.childSignal = signal;
      this.lastExit = { code, signal };
      this.settleAll(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, `matchlock rpc closed (code=${code}, signal=${signal})`));
    });

    // Bounded stderr capture (diagnostics only; never a control channel).
    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString("utf-8")).slice(-4000);
    });
    child.stderr.on("end", () => {
      if (stderrBuf.trim() !== "") {
        this.log("info", "matchlock rpc stderr", { stderr: stderrBuf.trim() });
      }
    });

    // PRE-PARSE memory guard: registered BEFORE readline so it sees every
    // stdout chunk first. node:readline buffers an entire unterminated line
    // before emitting it, so the parsed-line length check alone would only
    // fire AFTER unbounded accumulation. This watchdog counts bytes since the
    // last terminator and raises the protocol failure as soon as an
    // unterminated line exceeds maxLineLength — memory never grows past the
    // cap plus one chunk, and the oversized content is never JSON-parsed.
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.protocolFailed || this.disposed) return;
      this.stdoutPendingBytes += chunk.length;
      const lastNl = chunk.lastIndexOf(0x0a); // '\n'
      if (lastNl >= 0) this.stdoutPendingBytes = chunk.length - lastNl - 1;
      if (this.stdoutPendingBytes > this.maxLineLength) {
        this.raiseProtocolFailure(this.stdoutPendingBytes);
      }
    });

    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("close", () => {
      // stdout EOF alone does not settle requests; the child 'close' event
      // (guaranteed after stdout EOF) rejects everything still pending.
    });
  }

  /** Raise the oversized/protocol-line failure exactly once and dispose. */
  private raiseProtocolFailure(bytes: number): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.log("warn", "matchlock rpc emitted an oversized line; treating as protocol failure", {
      bytes,
      maxLineLength: this.maxLineLength,
    });
    this.settleAll(clientError(MATCHLOCK_CLIENT_ERROR_CODES.PROTOCOL, `matchlock rpc line exceeds ${this.maxLineLength} bytes`));
    void this.dispose();
  }

  // ── inbound dispatch ───────────────────────────────────────────────

  private onLine(line: string): void {
    // Second-layer bound (the pre-parse watchdog in start() already prevents
    // an unterminated line from being buffered past maxLineLength; this
    // catches a parsed line that still exceeds it, e.g. after a chunking
    // edge).
    if (Buffer.byteLength(line, "utf8") > this.maxLineLength) {
      this.raiseProtocolFailure(Buffer.byteLength(line, "utf8"));
      return;
    }
    const trimmed = line.trim();
    if (trimmed === "") return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.log("warn", "matchlock rpc emitted non-JSON line", { line: trimmed.slice(0, 200) });
      return;
    }

    // A response carries the request id and no method.
    if (typeof obj.id === "number" && obj.method === undefined) {
      const pending = this.pending.get(obj.id);
      if (!pending) return;
      this.clearTimer(pending);
      this.pending.delete(obj.id);
      pending.settled = true;
      // stdin is inert once the exec request has settled (success or error).
      this.flushReadyWaiters(pending, clientError(MATCHLOCK_CLIENT_ERROR_CODES.REQUEST_INACTIVE, `exec request ${obj.id} already settled`));
      if (obj.error !== undefined) {
        pending.reject(obj.error as MatchlockRpcErrorBody);
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    // A notification carries a method. Route stream frames by params.id.
    if (typeof obj.method === "string") {
      const params = obj.params as Record<string, unknown> | undefined;
      const frame = toFrame(obj.method, params);
      if (!frame) return;
      const refId = frame.requestId;
      if (frame.kind === "ready" && refId !== undefined) {
        const pending = this.pending.get(refId);
        if (pending) pending.readySeen = true;
        this.resolveReadyWaiters(refId);
        return;
      }
      if (refId !== undefined) {
        const pending = this.pending.get(refId);
        if (pending?.notify) {
          try {
            pending.notify(frame);
          } catch (err) {
            this.log("warn", "matchlock rpc stream callback threw", { error: String(err) });
          }
        }
      }
      return;
    }
  }

  private clearTimer(pending: PendingRequest): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  private rejectPending(pending: PendingRequest, err: MatchlockRpcErrorBody): void {
    this.clearTimer(pending);
    pending.settled = true;
    this.flushReadyWaiters(pending, err);
    pending.reject(err);
  }

  private flushReadyWaiters(pending: PendingRequest, err: MatchlockRpcErrorBody): void {
    const waiters = pending.readyWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  private resolveReadyWaiters(requestId: number): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const waiters = pending.readyWaiters.splice(0);
    for (const w of waiters) w.resolve();
  }

  private settleAll(err: MatchlockRpcErrorBody): void {
    for (const [, p] of Array.from(this.pending)) this.rejectPending(p, err);
    this.pending.clear();
  }

  // ── outbound ───────────────────────────────────────────────────────

  /**
   * Write one line, honouring stdin backpressure with a FINITE drain deadline
   * that rejects on child close/error/dispose (never hangs).
   */
  private writeLine(obj: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.child;
      if (!child || this.disposed) {
        reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED, "matchlock rpc is not running (disposed)"));
        return;
      }
      const line = JSON.stringify(obj) + "\n";
      let finished = false;
      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        child.stdin.removeListener("drain", onDrain);
        child.stdin.removeListener("error", onStdinError);
        child.removeListener("close", onClose);
        if (timer) clearTimeout(timer);
        fn();
      };
      const onDrain = () => finish(() => resolve());
      const onStdinError = (err: Error) =>
        finish(() => reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, `matchlock rpc stdin error: ${err.message}`)));
      const onClose = (code: number | null, signal: string | null) =>
        finish(() => reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, `matchlock rpc closed while writing (code=${code}, signal=${signal})`)));
      let timer: NodeJS.Timeout | undefined;
      child.stdin.on("drain", onDrain);
      child.stdin.on("error", onStdinError);
      child.on("close", onClose);
      try {
        if (!child.stdin.write(line)) {
          timer = setTimeout(() => {
            finish(() => reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT, `matchlock rpc stdin did not drain within ${this.stdinDrainTimeoutMs}ms`)));
          }, this.stdinDrainTimeoutMs);
        } else {
          finish(() => resolve());
        }
      } catch (err) {
        finish(() => reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED, `matchlock rpc stdin write failed: ${(err as Error).message}`)));
      }
    });
  }

  private sendRequest<Result, Params>(
    method: string,
    params: Params | undefined,
    notify: StreamNotify | undefined,
    callOpts?: RequestCallOptions,
  ): { id: number; promise: Promise<Result>; settled: Promise<unknown> } {
    const id = this.nextId++;
    let settleResolve!: () => void;
    const settled = new Promise<void>((r) => (settleResolve = r));
    const promise = new Promise<Result>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: (r) => {
          settleResolve();
          resolve(r as Result);
        },
        reject: (err) => {
          settleResolve();
          reject(err);
        },
        notify,
        settled: false,
        readyWaiters: [],
        readySeen: false,
      };
      this.pending.set(id, entry);
      const timeoutMs = callOpts?.timeoutMs ?? this.requestTimeoutMs;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id);
          this.rejectPending(entry, clientError(MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT, `matchlock rpc request ${method}#${id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.writeLine({ jsonrpc: "2.0", method, id, params: params ?? {} }).catch((err) => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        this.rejectPending(entry, decodeParamsErrorBody(err));
      });
    });
    return { id, promise, settled };
  }

  /** Send a request and await its response within a finite deadline. */
  request<Result = unknown, Params = Record<string, unknown>>(
    method: string,
    params?: Params,
    notify?: StreamNotify,
    callOpts?: RequestCallOptions,
  ): Promise<Result> {
    return this.sendRequest<Result, Params>(method, params, notify, callOpts).promise;
  }

  /** Send a one-way notification (no id, no response expected). Bounded. */
  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.writeLine({ jsonrpc: "2.0", method, params });
  }

  /** Resolve an image tag to its identity (resolve_image). */
  async resolveImage(tag: string): Promise<unknown> {
    return this.request("resolve_image", { tag });
  }

  /** Create a VM. `params.image_identity` pins the expected identity. */
  create(params: MatchlockCreateParams, callOpts?: RequestCallOptions): Promise<MatchlockCreateResult> {
    return this.request<MatchlockCreateResult, MatchlockCreateParams>("create", params, undefined, callOpts);
  }

  /**
   * Buffered exec (high-level capture API).
   *
   * To keep a single huge result from ever blowing the transport's
   * single-line cap (the raw `exec` RPC base64-encodes stdout/stderr in ONE
   * response line, so output above ~¾ of maxLineLength would be a fatal
   * oversized line), execCommand issues the STREAMING `exec_stream` method
   * and assembles stdout/stderr BYTES under an explicit budget. Bytes are
   * concatenated frame-by-frame and base64-encoded ONCE at the end, so the
   * result fields keep the "raw base64, decode exactly once" contract of the
   * wire `exec` result. Output over `maxOutputBytes` (client default:
   * bufferedExecOutputLimitBytes, 32 MiB) cancels the guest exec and rejects
   * with EXEC_OUTPUT_LIMIT — the transport stays alive for other requests.
   * Consumers that need more than a bounded capture must use execStream /
   * execPipe directly. The raw `exec` RPC method remains reachable through
   * `request("exec", …)` for consumers that own their output bound.
   */
  async execCommand(
    cmd: MatchlockExecOptions,
    opts?: RequestCallOptions & { maxOutputBytes?: number },
  ): Promise<MatchlockExecBufferedResult> {
    const budget = opts?.maxOutputBytes ?? this.bufferedExecOutputLimitBytes;
    if (!Number.isFinite(budget) || budget <= 0) {
      throw clientError(MATCHLOCK_CLIENT_ERROR_CODES.EXEC_OUTPUT_LIMIT, `execCommand requires a positive maxOutputBytes budget (got ${budget})`);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    const { id, promise } = this.sendRequest<MatchlockExecResult, MatchlockExecOptions>(
      "exec_stream",
      cmd,
      (frame) => {
        if (overflowed) return; // budget already blown: keep draining, drop tail
        const bytes = decodeFrameBytes(frame);
        if (bytes.length === 0) return;
        if (frame.kind === "stderr") {
          if (stderrBytes + bytes.length > budget) {
            overflowed = true;
            this.request("cancel", { id }, undefined, { timeoutMs: this.requestTimeoutMs }).catch(() => {});
            return;
          }
          stderr.push(bytes);
          stderrBytes += bytes.length;
        } else {
          if (stdoutBytes + bytes.length > budget) {
            overflowed = true;
            this.request("cancel", { id }, undefined, { timeoutMs: this.requestTimeoutMs }).catch(() => {});
            return;
          }
          stdout.push(bytes);
          stdoutBytes += bytes.length;
        }
      },
      { timeoutMs: opts?.timeoutMs },
    );
    try {
      const result = await promise;
      if (overflowed) {
        throw clientError(
          MATCHLOCK_CLIENT_ERROR_CODES.EXEC_OUTPUT_LIMIT,
          `buffered exec output exceeded the ${budget}-byte budget; use execStream/execPipe for larger output`,
        );
      }
      return {
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        stdout: Buffer.concat(stdout).toString("base64"),
        stderr: Buffer.concat(stderr).toString("base64"),
      };
    } catch (err) {
      if (overflowed) {
        // The guest exec was cancelled on budget breach: report the LIMIT
        // error, not the -32003 cancellation, to the buffered-exec caller.
        throw clientError(
          MATCHLOCK_CLIENT_ERROR_CODES.EXEC_OUTPUT_LIMIT,
          `buffered exec output exceeded the ${budget}-byte budget; use execStream/execPipe for larger output`,
        );
      }
      throw err;
    }
  }

  /** Exec with streamed stdout/stderr notifications (frames carry raw base64). */
  execStream(cmd: MatchlockExecOptions, notify: StreamNotify, callOpts?: RequestCallOptions): Promise<MatchlockExecResult> {
    return this.request<MatchlockExecResult, MatchlockExecOptions>("exec_stream", cmd, notify, callOpts);
  }

  /**
   * Exec in pipe mode. The runtime streams `exec_pipe.ready`, then
   * `exec_pipe.stdout` / `exec_pipe.stderr`; stdin is delivered via
   * `exec_pipe.stdin` then `exec_pipe.stdin_eof` (both notifications).
   *
   * stdin writes are queued until `exec_pipe.ready` is OBSERVED (the runtime
   * registers the pipe before sending ready; anything earlier can be dropped)
   * and reject once the request settles or the transport dies — bounded by
   * `readyTimeoutMs`, the stdin drain deadline and the request deadline.
   */
  execPipe(cmd: MatchlockExecOptions, notify: StreamNotify, callOpts?: RequestCallOptions): MatchlockPipeHandle {
    const { id, promise } = this.sendRequest<MatchlockExecResult, MatchlockExecOptions>("exec_pipe", cmd, notify, callOpts);
    const gate = (): Promise<void> => {
      const entry = this.pending.get(id);
      if (!entry) {
        // Request already settled: stdin is inert.
        return Promise.reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.REQUEST_INACTIVE, `exec_pipe ${id} already settled; stdin is inert`));
      }
      if (entry.readySeen) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = entry.readyWaiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) entry.readyWaiters.splice(idx, 1);
          reject(clientError(MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT, `exec_pipe ${id} ready notification not observed within ${this.readyTimeoutMs}ms`));
        }, this.readyTimeoutMs);
        entry.readyWaiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    };
    const stdin: MatchlockPipeStdin = {
      write: async (data: Buffer | string): Promise<void> => {
        await gate();
        await this.notify("exec_pipe.stdin", { id, data: Buffer.from(data).toString("base64") });
      },
      eof: async (): Promise<void> => {
        await gate();
        await this.notify("exec_pipe.stdin_eof", { id });
      },
    };
    return { requestId: id, stdin, result: promise };
  }

  /** Cancel an in-flight request (returns whether it was cancellable). */
  async cancel(requestId: MatchlockRequestId): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }, { id: number }>("cancel", { id: requestId });
  }

  /**
   * Cancel and settle every in-flight exec-family request (bounded), used
   * before `close` because the runtime's close waits for handlers first.
   */
  async cancelInFlightExecRequests(settleTimeoutMs?: number): Promise<void> {
    const bound = settleTimeoutMs ?? this.execCancelSettleTimeoutMs;
    const execIds: number[] = [];
    const settled: Array<Promise<void>> = [];
    for (const [id, p] of Array.from(this.pending)) {
      if (p.settled || !EXEC_METHODS.has(p.method)) continue;
      execIds.push(id);
      const entry = this.pending.get(id);
      if (entry) {
        let notify!: () => void;
        const done = new Promise<void>((r) => (notify = r));
        settled.push(done);
        const origResolve = entry.resolve;
        const origReject = entry.reject;
        entry.resolve = (result) => {
          notify();
          origResolve(result);
        };
        entry.reject = (err) => {
          notify();
          origReject(err);
        };
      }
    }
    if (execIds.length === 0) return;
    for (const id of execIds) {
      // Best-effort cancel with its own bounded deadline; never hangs.
      this.request("cancel", { id }, undefined, { timeoutMs: bound }).catch(() => {
        /* cancel itself failing is reported through the exec settlement path */
      });
    }
    const timer = new Promise<void>((resolve) => setTimeout(resolve, bound));
    await Promise.race([Promise.allSettled(settled), timer]);
  }

  /**
   * Gracefully close the VM. `timeoutSeconds` MUST be positive — zero is not
   * an unlimited graceful wait. Resolves only when the server CONFIRMS the
   * close response; then stdin is ended so the RPC process may exit (bounded
   * wait, never a kill here — dispose() is the hard-abort path).
   *
   * MTLK-CLEANUP US-004: an already-stopped / already-closed / "vm not running"
   * close RESPONSE is itself a confirmation (the VM is gone) and resolves as a
   * confirmed close. A client-originated transport/deadline failure carries no
   * wire response and still rejects, so a close is never fabricated from a dead
   * transport.
   */
  async close(timeoutSeconds: number): Promise<void> {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error(`matchlock close requires a positive timeout_seconds (got ${timeoutSeconds})`);
    }
    const deadlineMs = timeoutSeconds * 1000 + this.closeGraceMs;
    try {
      await this.request("close", { timeout_seconds: timeoutSeconds }, undefined, { timeoutMs: deadlineMs });
    } catch (err) {
      if (!isAlreadyStoppedCloseError(err)) throw err;
      // MTLK-CLEANUP US-004: only a real WIRE response can reach this branch
      // (the predicate refuses every client-originated transport/deadline
      // code). The VM is already stopped/closed, so this is a CONFIRMED close.
      this.log("warn", "matchlock close reported the VM already stopped/closed; treating as a confirmed close", {
        code: (err as { code?: unknown }).code,
        message: (err as { message?: unknown }).message,
      });
    }
    // Confirmed on the wire. Let the process exit on stdin EOF (bounded; a
    // runtime that keeps running is reclaimed by dispose()).
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      await this.waitForExit(5_000).catch(() => ({ code: null, signal: null }));
    }
  }

  /** Await the owned child exit (after close). Bounded — never hangs forever. */
  async waitForExit(timeoutMs = 5000): Promise<{ code: number | null; signal: string | null }> {
    const child = this.child;
    if (!child) return this.lastExit;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.lastExit = { code: child.exitCode, signal: child.signalCode };
      return this.lastExit;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve({ code: null, signal: "SIGKILL" });
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const outcome = { code, signal: signal as string | null };
        this.lastExit = outcome;
        resolve(outcome);
      });
    });
  }

  /**
   * Tear down the transport (no graceful close). Kills the EXACT owned child
   * handle and resolves only once the child close has been OBSERVED (bounded)
   * — it never re-signals a stored/historical PID.
   */
  dispose(): Promise<{ code: number | null; signal: string | null }> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.settleAll(clientError(MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED, "matchlock rpc client disposed"));
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<{ code: number | null; signal: string | null }> {
    const child = this.child;
    this.child = undefined;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        /* ignore */
      }
      this.rl = undefined;
    }
    if (!child) return this.lastExit;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.lastExit = { code: child.exitCode, signal: child.signalCode };
      return this.lastExit;
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (outcome: { code: number | null; signal: string | null }) => {
        if (finished) return;
        finished = true;
        child.removeListener("close", onClose);
        if (timer) clearTimeout(timer);
        this.lastExit = outcome;
        resolve(outcome);
      };
      const onClose = (code: number | null, signal: string | null) =>
        finish({ code, signal: signal as string | null });
      let timer: NodeJS.Timeout | undefined;
      child.on("close", onClose);
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      if (child.exitCode === null && child.signalCode === null) {
        timer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          // The 'close' listener above observes the kill; no second resolve.
        }, this.disposeKillGraceMs);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      } else {
        finish({ code: child.exitCode, signal: child.signalCode });
      }
    });
  }
}
