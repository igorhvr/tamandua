/**
 * Guest-local bridge service.
 *
 * Runs INSIDE the Matchlock VM as the single process whose stdin/stdout are
 * the dedicated exec pipe to the scoped host broker. It binds a guest-local
 * Unix socket so multiple helper CLI invocations (`/workspace/runtime/bin/
 * tamandua step ...`) can connect; every request is framed, bounded, queued
 * with finite deadlines and relayed to the host broker over the pipe. The
 * broker's responses are routed back to the requesting socket client by
 * correlated id.
 *
 * Hard rules:
 *   - stdout carries ONLY protocol frames; all diagnostics go to stderr.
 *   - a protocol/build handshake must complete before any command is served.
 *   - the socket path lives in a short fresh guest-owned directory; a
 *     pre-existing/stale path is NEVER unlinked blindly (startup refuses).
 *   - EOF of the host pipe, a host `ctrl close`, or SIGTERM/SIGINT triggers a
 *     bounded graceful shutdown: stop accepting, flush in-flight for at most
 *     shutdownFlushMs, unlink the exact socket we created, exit.
 *
 * Node-core only — safe for the guest pack closure.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  BRIDGE_OPS,
  isMergeBridgeOp,
  isQueryBridgeOp,
  isSuiteBridgeOp,
  validateMergeBridgeParams,
  validateQueryBridgeParams,
  validateSuiteBridgeParams,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_FLUSH_MS,
  ENV_GUEST_SOCKET,
  ENV_GUEST_SOCKET_DIR,
  GUEST_BRIDGE_PROTOCOL_VERSION,
  GUEST_SOCKET_FILENAME,
  MAX_QUEUED_PER_CONNECTION,
  MAX_REASON_BYTES,
  MAX_REPORT_BYTES,
  MAX_SOCKET_CONNECTIONS,
  type BridgeControl,
  type BridgeErrorCode,
  type BridgeRequest,
  type GuestHello,
  type GuestHelloAck,
} from "./guest-protocol.js";
import { FrameDecoder, decodeJsonPayload, encodeFrame, encodeJsonFrame } from "./guest-framing.js";

export interface GuestServiceOptions {
  /** Fresh guest-owned directory for the socket (created 0700 when absent). */
  socketDir?: string;
  /** Full socket path; overrides socketDir + default filename. */
  socketPath?: string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownFlushMs?: number;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  helperBuildVersion: string;
  packLayoutVersion: number;
  capabilities?: string[];
  /** Guest-supplied identity claims (validated by the broker, never trusted). */
  claimedIdentity?: { runId?: string; invocationId?: string; agentId?: string };
  /**
   * MTLK-SUITE-WIRE: true only when this bridge service is launched against a
   * HOST broker that was injected with a host suite transport/services bridge.
   * When false (default) every suite.* request fails explicitly as
   * UNSUPPORTED ("host suite service absent") so a guest can never advertise
   * or exercise a working suite capability that the host does not actually
   * provide. The engine then degrades to real guest-local execution with an
   * explicit warning (never a native host fallback or a false green).
   */
  suiteEnabled?: boolean;
}

export interface GuestServiceHandle {
  socketPath: string;
  /** Resolves {ok:true} once the host pipe handshake acked; {ok:false, reason} otherwise. */
  ready: Promise<{ ok: boolean; reason?: string }>;
  /** Graceful shutdown (stop accepting, flush, unlink, resolve exit code). */
  shutdown: () => Promise<number>;
  /** Exit code once the service fully stopped. */
  exited: Promise<number>;
  /** True when shutdown was requested. */
  isClosing: () => boolean;
}

interface PendingItem {
  id: string;
  client: net.Socket;
  frame: BridgeRequest;
  deadline: NodeJS.Timeout;
  canceled: boolean;
}

interface ClientState {
  socket: net.Socket;
  handshaken: boolean;
  handshakeTimer: NodeJS.Timeout;
}

function errFrame(id: string | undefined, code: BridgeErrorCode, message: string): Buffer {
  return encodeJsonFrame({ kind: "err", ...(id !== undefined ? { id } : {}), code, message });
}

/** Await the write callback (drain gating for backpressure). */
function writeFlushed(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Start the guest bridge service. Resolves a handle once the socket is
 * listening; host handshake and serving continue in the background.
 */
export async function startGuestBridgeService(
  opts: GuestServiceOptions,
): Promise<GuestServiceHandle> {
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const suiteEnabled = opts.suiteEnabled ?? false;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shutdownFlushMs = opts.shutdownFlushMs ?? DEFAULT_SHUTDOWN_FLUSH_MS;

  const socketPath = resolveSocketPath(opts);
  if (!socketPath) {
    throw new Error(
      `guest bridge socket is not configured: set ${ENV_GUEST_SOCKET} or ${ENV_GUEST_SOCKET_DIR}`,
    );
  }

  // Create the guest-owned socket directory (short, fresh, 0700).
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  // Never unlink blindly: a pre-existing path means a real conflict.
  if (fs.existsSync(socketPath)) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(socketPath);
    } catch {
      /* raced away; treat as absent below */
    }
    throw new Error(
      `guest bridge socket path already exists: ${socketPath}` +
        (stat ? ` (${stat.isSocket() ? "existing socket" : "non-socket entry"}) — refusing to unlink; use a fresh guest-owned directory` : ""),
    );
  }

  let closing = false;
  let server: net.Server | null = null;
  const clients = new Map<net.Socket, ClientState>();
  const queue: PendingItem[] = [];
  let inFlight: PendingItem | null = null;
  let hostReady = false;
  let shutdownFlushTimer: NodeJS.Timeout | null = null;
  let resolveReady: (v: { ok: boolean; reason?: string }) => void = () => {};
  const ready = new Promise<{ ok: boolean; reason?: string }>((r) => { resolveReady = r; });
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => { resolveExited = r; });
  let exitCode = 0;
  let ownSocketBound = false;

  const diag = (msg: string): void => {
    stderr.write(`[guest-bridge] ${msg}\n`);
  };

  const dropClient = (socket: net.Socket, code: BridgeErrorCode, message: string): void => {
    const state = clients.get(socket);
    if (!state) return;
    clients.delete(socket);
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    try {
      if (!socket.destroyed && code !== "CANCELED") socket.write(errFrame(undefined, code, message));
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  const rejectQueuedMatching = (predicate: (item: PendingItem) => boolean, code: BridgeErrorCode, message: string): void => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      if (predicate(item)) {
        queue.splice(i, 1);
        clearTimeout(item.deadline);
        try {
          item.client.write(errFrame(item.id, code, message));
        } catch {
          /* ignore */
        }
      }
    }
  };

  const pump = async (): Promise<void> => {
    if (closing) return;
    if (inFlight) return;
    if (queue.length === 0) return;
    if (!hostReady) return;
    const item = queue.shift()!;
    inFlight = item;
    try {
      const forward = {
        kind: "req",
        id: item.id,
        op: item.frame.op,
        params: item.frame.params,
        clientId: item.frame.clientId,
        ...(item.frame.opKey !== undefined ? { opKey: item.frame.opKey } : {}),
      };
      await writeFlushed(stdout, encodeJsonFrame(forward));
    } catch (err) {
      clearTimeout(item.deadline);
      try {
        item.client.write(errFrame(item.id, "IO", `forward to host failed: ${(err as Error).message}`));
      } catch {
        /* ignore */
      }
      inFlight = null;
      void pump();
    }
  };

  const finishItem = (item: PendingItem, buffer: Buffer): void => {
    if (item.canceled) return; // host canceled; nothing to deliver
    clearTimeout(item.deadline);
    try {
      // The host pipe payload must be re-framed for the socket client.
      item.client.write(encodeFrame(buffer));
    } catch {
      /* ignore */
    }
  };

  const hostAnswer = (id: string, buffer: Buffer): void => {
    if (inFlight && inFlight.id === id) {
      finishItem(inFlight, buffer);
      inFlight = null;
      void pump();
    }
  };

  const timeOutItem = (item: PendingItem): void => {
    if (item.canceled) return;
    item.canceled = true;
    try {
      item.client.write(errFrame(item.id, "DEADLINE", `guest bridge request timed out after ${requestTimeoutMs}ms`));
    } catch {
      /* ignore */
    }
    if (inFlight === item) {
      inFlight = null;
      // Ask the host to cancel the exact request (best effort).
      try {
        stdout.write(encodeJsonFrame({ kind: "ctrl", op: "cancel", id: item.id }));
      } catch {
        /* ignore */
      }
      void pump();
    } else {
      const idx = queue.indexOf(item);
      if (idx >= 0) queue.splice(idx, 1);
    }
  };

  const shutdown = async (): Promise<number> => {
    if (closing) return exitCode;
    closing = true;
    diag("shutdown requested");
    if (shutdownFlushTimer) clearTimeout(shutdownFlushTimer);
    // Stop accepting new connections.
    if (server) {
      server.close();
      server = null;
    }
    // Revoke queued client requests (close revokes all invocation authority).
    rejectQueuedMatching(() => true, "CLOSED", "guest bridge is closing");
    if (inFlight) {
      // Allow a bounded final flush for the in-flight request.
      await new Promise<void>((resolve) => {
        shutdownFlushTimer = setTimeout(resolve, shutdownFlushMs);
        const orig = inFlight;
        const check = setInterval(() => {
          if (!inFlight || inFlight !== orig) {
            clearInterval(check);
            if (shutdownFlushTimer) clearTimeout(shutdownFlushTimer);
            resolve();
          }
        }, 10);
      });
      // Give the in-flight client its answer or a close error.
      if (inFlight) {
        const stuck = inFlight;
        inFlight = null;
        if (!stuck.canceled) {
          try {
            stuck.client.write(errFrame(stuck.id, "CLOSED", "guest bridge closed before host answered"));
          } catch {
            /* ignore */
          }
        }
      }
    }
    for (const socket of [...clients.keys()]) {
      dropClient(socket, "CLOSED", "guest bridge is closing");
    }
    // Unlink only the exact socket this service bound.
    if (ownSocketBound) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* best effort */
      }
    }
    exitCode = 0;
    resolveExited(exitCode);
    return exitCode;
  };

  // ---- host pipe (exec pipe) side -------------------------------------
  let helloAcked = false;
  const pipeDecoder = new FrameDecoder({
    onFrame: (payload) => {
      const parsed = decodeJsonPayload<Record<string, unknown>>(payload);
      if (!parsed.ok) {
        diag(`bad host frame: ${parsed.error}`);
        return;
      }
      const msg = parsed.value;
      if (msg.kind === "hello-ack") {
        if (helloAcked) return;
        helloAcked = true;
        const ack = msg as unknown as { accepted: boolean; reason?: string };
        if (ack.accepted === true) {
          hostReady = true;
          resolveReady({ ok: true });
          diag("host handshake accepted");
          void pump();
        } else {
          resolveReady({ ok: false, reason: ack.reason ?? "host rejected handshake" });
          diag(`host handshake rejected: ${ack.reason ?? "unknown"}`);
        }
        return;
      }
      if (msg.kind === "res" || msg.kind === "err") {
        const id = typeof msg.id === "string" ? msg.id : undefined;
        if (id) hostAnswer(id, Buffer.from(payload));
        return;
      }
      if (msg.kind === "ctrl") {
        const ctrl = msg as unknown as BridgeControl;
        if (ctrl.op === "cancel") {
          const targetId = ctrl.id;
          rejectQueuedMatching(
            (item) => targetId === undefined || item.id === targetId,
            "CANCELED",
            "request canceled by host",
          );
          if (inFlight && (targetId === undefined || inFlight.id === targetId)) {
            const canceled = inFlight;
            canceled.canceled = true;
            clearTimeout(canceled.deadline);
            try {
              canceled.client.write(errFrame(canceled.id, "CANCELED", "request canceled by host"));
            } catch {
              /* ignore */
            }
            inFlight = null;
            void pump();
          }
          return;
        }
        if (ctrl.op === "close") {
          void shutdown();
          return;
        }
        diag(`unexpected ctrl op: ${String((ctrl as { op?: unknown }).op)}`);
        return;
      }
      diag(`unexpected host frame kind: ${String(msg.kind)}`);
    },
    onError: (err) => {
      diag(`host pipe protocol error: ${err.message}`);
      // A corrupt pipe cannot serve authority: shut down.
      void shutdown().catch(() => {});
    },
  });

  stdin.on("data", (chunk: Buffer) => pipeDecoder.push(chunk));
  stdin.on("end", () => {
    diag("host pipe EOF");
    if (!closing) void shutdown();
  });
  stdin.on("error", (err) => {
    diag(`host pipe error: ${err.message}`);
    if (!closing) void shutdown();
  });

  // ---- guest-local socket side -----------------------------------------
  server = net.createServer((socket) => {
    if (closing || clients.size >= MAX_SOCKET_CONNECTIONS) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const state: ClientState = {
      socket,
      handshaken: false,
      handshakeTimer: setTimeout(() => {
        dropClient(socket, "HANDSHAKE", `client handshake timed out after ${handshakeTimeoutMs}ms`);
      }, handshakeTimeoutMs),
    };
    clients.set(socket, state);

    const decoder = new FrameDecoder({
      onFrame: (payload) => {
        const parsed = decodeJsonPayload<GuestHello | BridgeRequest>(payload);
        if (!parsed.ok) {
          dropClient(socket, "BAD_FRAME", parsed.error);
          return;
        }
        const msg = parsed.value;
        if (!state.handshaken) {
          if (msg.kind !== "hello") {
            dropClient(socket, "HANDSHAKE", "expected hello before commands");
            return;
          }
          const hello = msg as unknown as GuestHello;
          if (hello.protocolVersion !== GUEST_BRIDGE_PROTOCOL_VERSION) {
            const ack: GuestHelloAck = {
              kind: "hello-ack",
              accepted: false,
              protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
              reason: `unsupported protocol version ${hello.protocolVersion} (need ${GUEST_BRIDGE_PROTOCOL_VERSION})`,
            };
            socket.write(encodeJsonFrame(ack), () => {
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
            });
            return;
          }
          state.handshaken = true;
          clearTimeout(state.handshakeTimer);
          const ack: GuestHelloAck = {
            kind: "hello-ack",
            accepted: true,
            protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
          };
          socket.write(encodeJsonFrame(ack));
          return;
        }
        if (msg.kind !== "req") {
          socket.write(errFrame(undefined, "BAD_REQUEST", "expected a request after handshake"));
          return;
        }
        const req = msg as unknown as BridgeRequest;
        const reason = validateRequest(req, suiteEnabled);
        if (reason) {
          socket.write(errFrame(req.id, reason.code, reason.message));
          return;
        }
        if (closing) {
          socket.write(errFrame(req.id, "CLOSED", "guest bridge is closing"));
          return;
        }
        if (queue.length >= MAX_QUEUED_PER_CONNECTION) {
          socket.write(errFrame(req.id, "QUEUE_FULL", `guest bridge queue is full (limit ${MAX_QUEUED_PER_CONNECTION})`));
          return;
        }
        const item: PendingItem = {
          id: req.id,
          client: socket,
          frame: req,
          deadline: setTimeout(() => timeOutItem(item), requestTimeoutMs),
          canceled: false,
        };
        queue.push(item);
        void pump();
      },
      onError: (err) => {
        dropClient(socket, "BAD_FRAME", err.message);
      },
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("error", () => {
      // Client vanished; cancel/forget its queued and in-flight work.
      rejectQueuedMatching((item) => item.client === socket, "IO", "client disconnected");
      if (inFlight && inFlight.client === socket) {
        const stuck = inFlight;
        inFlight = null;
        stuck.canceled = true;
        clearTimeout(stuck.deadline);
        try {
          stdout.write(encodeJsonFrame({ kind: "ctrl", op: "cancel", id: stuck.id }));
        } catch {
          /* ignore */
        }
        void pump();
      }
      clients.delete(socket);
    });
    socket.on("close", () => {
      if (clients.has(socket)) {
        rejectQueuedMatching((item) => item.client === socket, "IO", "client disconnected");
        if (inFlight && inFlight.client === socket) {
          const stuck = inFlight;
          inFlight = null;
          stuck.canceled = true;
          clearTimeout(stuck.deadline);
          try {
            stdout.write(encodeJsonFrame({ kind: "ctrl", op: "cancel", id: stuck.id }));
          } catch {
            /* ignore */
          }
          void pump();
        }
        clients.delete(socket);
      }
    });
  });
  server.maxConnections = MAX_SOCKET_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, () => {
      ownSocketBound = true;
      diag(`listening on ${socketPath}`);
      resolve();
    });
  });

  // Kick off the host handshake: send hello over the pipe.
  const helloPayload = {
    kind: "hello",
    protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
    packLayoutVersion: opts.packLayoutVersion,
    helperBuildVersion: opts.helperBuildVersion,
    capabilities: opts.capabilities ?? [],
    ...(opts.claimedIdentity?.runId ? { claimedRunId: opts.claimedIdentity.runId } : {}),
    ...(opts.claimedIdentity?.invocationId ? { claimedInvocationId: opts.claimedIdentity.invocationId } : {}),
    ...(opts.claimedIdentity?.agentId ? { claimedAgentId: opts.claimedIdentity.agentId } : {}),
  };
  await writeFlushed(stdout, encodeJsonFrame(helloPayload));
  // If the host never acks, fail ready after the handshake deadline.
  const failTimer = setTimeout(() => {
    if (!helloAcked) {
      resolveReady({ ok: false, reason: `host handshake timed out after ${handshakeTimeoutMs}ms` });
    }
  }, handshakeTimeoutMs);

  void ready.then((r) => {
    if (!r.ok && !closing) {
      diag(`host handshake failed: ${r.reason ?? "unknown"}`);
      // Fail closed: no commands may be served without a compatible host.
      void shutdown();
    }
  });
  void exited.then(() => {
    if (failTimer) clearTimeout(failTimer);
  });

  return {
    socketPath,
    ready,
    shutdown,
    exited,
    isClosing: () => closing,
  };
}

function resolveSocketPath(opts: GuestServiceOptions): string | null {
  if (opts.socketPath) return opts.socketPath;
  const direct = process.env[ENV_GUEST_SOCKET]?.trim();
  if (direct) return direct;
  const dir = opts.socketDir?.trim() ?? process.env[ENV_GUEST_SOCKET_DIR]?.trim();
  if (dir) return path.join(dir, GUEST_SOCKET_FILENAME);
  return null;
}

function validateRequest(
  req: BridgeRequest,
  suiteEnabled: boolean,
): { code: BridgeErrorCode; message: string } | null {
  if (typeof req.id !== "string" || req.id.length === 0 || req.id.length > 128) {
    return { code: "BAD_REQUEST", message: "request id must be a non-empty string <= 128 chars" };
  }
  if (!BRIDGE_OPS.includes(req.op)) {
    return { code: "UNSUPPORTED", message: `unsupported op: ${String(req.op)}` };
  }
  const params = req.params as Record<string, unknown>;
  if (typeof params !== "object" || params === null) {
    return { code: "BAD_REQUEST", message: "request params must be an object" };
  }
  // Suite ops: refuse explicitly unless the service was launched against a
  // suite-capable host, then enforce the full canonical wire validation at
  // this (guest service) boundary — malformed/oversized/nonfinite/unknown
  // suite requests never reach the host pipe.
  if (isSuiteBridgeOp(req.op)) {
    if (!suiteEnabled) {
      return {
        code: "UNSUPPORTED",
        message:
          "host suite service is absent for this invocation — the controller did not wire a suite-capable host broker; suite requests are not served",
      };
    }
    const refusal = validateSuiteBridgeParams(req.op, params);
    if (refusal) return refusal;
    return null;
  }
  // US-004 query ops (step.stories / workflow.status / logs.run): read-only
  // run-scoped shapes are validated canonically here so malformed or
  // oversized query requests never reach the host pipe. The service always
  // forwards them; the host broker answers UNSUPPORTED when it was not wired
  // with a run-scoped query bridge.
  if (isQueryBridgeOp(req.op)) {
    const refusal = validateQueryBridgeParams(req.op, params);
    if (refusal) return refusal;
    return null;
  }
  // US-007 scoped merge ops: canonical wire validation at the guest boundary
  // so malformed/oversized merge requests never reach the host pipe. The host
  // broker answers UNSUPPORTED when no merge service was wired.
  if (isMergeBridgeOp(req.op)) {
    const refusal = validateMergeBridgeParams(req.op, params);
    if (refusal) return refusal;
    return null;
  }
  if (typeof params.stepId === "string" && params.stepId.length > 256) {
    return { code: "BAD_REQUEST", message: "stepId too long" };
  }
  if (typeof params.agentId === "string" && params.agentId.length > 256) {
    return { code: "BAD_REQUEST", message: "agentId too long" };
  }
  if (typeof params.runId === "string" && params.runId.length > 256) {
    return { code: "BAD_REQUEST", message: "runId too long" };
  }
  if (typeof params.output === "string" && Buffer.byteLength(params.output, "utf-8") > MAX_REPORT_BYTES) {
    return { code: "OVERSIZED", message: `report content exceeds ${MAX_REPORT_BYTES} bytes` };
  }
  if (typeof params.reason === "string" && Buffer.byteLength(params.reason, "utf-8") > MAX_REASON_BYTES) {
    return { code: "OVERSIZED", message: `reason exceeds ${MAX_REASON_BYTES} bytes` };
  }
  if (typeof req.opKey === "string" && req.opKey.length > 128) {
    return { code: "BAD_REQUEST", message: "opKey too long" };
  }
  return null;
}
