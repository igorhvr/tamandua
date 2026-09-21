/**
 * Framed transport for the guest bridge.
 *
 * Frame wire format: 4-byte big-endian unsigned length N followed by exactly
 * N payload bytes (UTF-8 JSON). The decoder is incremental: it tolerates
 * partial frames split across arbitrary chunk boundaries and multiple frames
 * inside one chunk. Declared payloads larger than MAX_FRAME_PAYLOAD_BYTES are
 * rejected immediately (the transport is then considered corrupt and must be
 * closed by the caller). Node-core only — safe for the guest pack closure.
 */

import { MAX_FRAME_PAYLOAD_BYTES } from "./guest-protocol.js";

/** Big-endian uint32 length prefix. */
function writeHeader(length: number): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(length >>> 0, 0);
  return header;
}

/** Encode a raw payload buffer into one frame. */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(
      `frame payload ${payload.byteLength} bytes exceeds limit ${MAX_FRAME_PAYLOAD_BYTES}`,
    );
  }
  return Buffer.concat([writeHeader(payload.byteLength), payload]);
}

/** Encode a JSON-serializable value into one frame (payload must be UTF-8). */
export function encodeJsonFrame(value: unknown): Buffer {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new Error(`cannot serialize frame payload: ${(err as Error).message}`);
  }
  if (text === undefined) {
    throw new Error("cannot serialize frame payload: JSON.stringify returned undefined");
  }
  const payload = Buffer.from(text, "utf-8");
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(
      `frame payload ${payload.byteLength} bytes exceeds limit ${MAX_FRAME_PAYLOAD_BYTES}`,
    );
  }
  return encodeFrame(payload);
}

export interface FrameDecoderCallbacks {
  /** Called once per complete, in-limit payload. */
  onFrame: (payload: Buffer) => void;
  /** Called on a protocol violation (oversized frame, invalid header). */
  onError: (err: Error) => void;
}

/**
 * Incremental length-prefixed frame decoder. Feed raw bytes with `push()`.
 * A frame whose declared length exceeds the limit triggers `onError` exactly
 * once; the decoder stops parsing further input.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private failed = false;

  constructor(private readonly callbacks: FrameDecoderCallbacks) {}

  push(chunk: Buffer): void {
    if (this.failed) return;
    if (chunk.byteLength === 0) return;
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // Parse as many complete frames as the buffer holds.
    for (;;) {
      if (this.failed) return;
      if (this.buffer.byteLength < 4) return; // need the header
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_PAYLOAD_BYTES) {
        this.failed = true;
        this.callbacks.onError(
          new Error(`frame declares ${length} payload bytes; limit is ${MAX_FRAME_PAYLOAD_BYTES}`),
        );
        return;
      }
      if (this.buffer.byteLength < 4 + length) return; // partial payload
      const payload = this.buffer.subarray(4, 4 + length);
      // Copy so later chunks cannot alias into the payload the consumer keeps.
      this.callbacks.onFrame(Buffer.from(payload));
      this.buffer = this.buffer.subarray(4 + length);
      if (this.buffer.byteLength === 0) this.buffer = Buffer.alloc(0);
    }
  }

  /** True after an unrecoverable protocol violation. */
  isFailed(): boolean {
    return this.failed;
  }
}

/** Decode one complete frame payload into JSON, returning a friendly error on failure. */
export function decodeJsonPayload<T>(payload: Buffer): { ok: true; value: T } | { ok: false; error: string } {
  let text: string;
  try {
    text = payload.toString("utf-8");
  } catch (err) {
    return { ok: false, error: `invalid utf-8 payload: ${(err as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: `payload is not valid JSON: ${(err as Error).message}` };
  }
}
