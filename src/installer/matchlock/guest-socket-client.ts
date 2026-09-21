/**
 * Guest CLI <=> guest bridge service socket client.
 *
 * A fresh Unix-socket connection per helper invocation. Bounded handshake and
 * request deadlines, correlated request ids, framed payloads; any transport
 * failure surfaces as a typed error the CLI maps to stderr + exit code.
 *
 * Node-core only — safe for the guest pack closure.
 */

import * as net from "node:net";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  GUEST_BRIDGE_PROTOCOL_VERSION,
  type BridgeResponsePayload,
  type GuestHelloAck,
} from "./guest-protocol.js";
import { FrameDecoder, decodeJsonPayload, encodeJsonFrame } from "./guest-framing.js";

export interface GuestRequestOptions {
  socketPath: string;
  helperBuildVersion: string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export type GuestRequestResult<P extends BridgeResponsePayload> =
  | { ok: true; payload: P }
  | { ok: false; code: string; message: string };

interface WireMessage {
  kind: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Open a socket to the guest bridge service, complete the protocol handshake
 * and issue one request, returning the correlated response. The socket is
 * always closed before returning.
 */
export async function guestRequest<P extends BridgeResponsePayload>(
  opts: GuestRequestOptions,
  frame: { op: string; params: unknown; opKey?: string },
): Promise<GuestRequestResult<P>> {
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise<GuestRequestResult<P>>((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const settle = (result: GuestRequestResult<P>): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const socket = net.createConnection({ path: opts.socketPath });
    const requestId = randomUUID();

    const failWith = (code: string, message: string): void => {
      settle({ ok: false, code, message });
    };

    const decoder = new FrameDecoder({
      onFrame: (payload) => {
        if (settled) return;
        const parsed = decodeJsonPayload<WireMessage>(payload);
        if (!parsed.ok) {
          failWith("BAD_FRAME", parsed.error);
          return;
        }
        const msg = parsed.value;
        if (msg.kind === "hello-ack") {
          const ack = msg as unknown as GuestHelloAck;
          if (ack.accepted !== true) {
            failWith("HANDSHAKE", `guest bridge rejected handshake: ${ack.reason ?? "unknown reason"}`);
            return;
          }
          const req = {
            kind: "req",
            id: requestId,
            op: frame.op,
            params: frame.params,
            ...(frame.opKey !== undefined ? { opKey: frame.opKey } : {}),
          };
          socket.write(encodeJsonFrame(req), (err) => {
            if (err && !settled) failWith("IO", `failed to write request: ${err.message}`);
          });
          timers.push(setTimeout(() => failWith("DEADLINE", `no response within ${requestTimeoutMs}ms`), requestTimeoutMs));
          return;
        }
        if (msg.kind === "res") {
          if (msg.id !== requestId) return; // ignore non-correlated responses
          const payload = msg.payload as P;
          if (typeof payload !== "object" || payload === null) {
            failWith("BAD_FRAME", "response payload is not an object");
            return;
          }
          settle({ ok: true, payload });
          return;
        }
        if (msg.kind === "err") {
          if (msg.id !== undefined && msg.id !== requestId) return;
          failWith(
            String(msg.code ?? "SERVICE"),
            typeof msg.message === "string" ? msg.message : "guest bridge error",
          );
          return;
        }
        failWith("BAD_FRAME", `unexpected frame kind: ${String(msg.kind)}`);
      },
      onError: (err) => failWith("BAD_FRAME", err.message),
    });

    socket.on("connect", () => {
      socket.write(
        encodeJsonFrame({
          kind: "hello",
          protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
          helperBuildVersion: opts.helperBuildVersion,
          clientId: randomUUID(),
        }),
      );
      timers.push(setTimeout(() => failWith("HANDSHAKE", `no handshake ack within ${handshakeTimeoutMs}ms`), handshakeTimeoutMs));
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("end", () => {
      if (!settled) failWith("IO", "guest bridge closed the connection before answering");
    });
    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        failWith("IO", `cannot connect to guest bridge socket "${opts.socketPath}": ${err.message}`);
      } else if (!settled) {
        failWith("IO", `guest bridge socket error: ${err.message}`);
      }
    });
    socket.on("close", () => {
      if (!settled) failWith("IO", "guest bridge socket closed before answering");
    });
  });
}
