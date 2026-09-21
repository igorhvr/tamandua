/**
 * fake-rpc-driver.ts — US-002 test helper.
 *
 * Writes a self-contained Node script that faithfully implements the
 * `matchlock rpc` line-delimited JSON-RPC contract (the methods the pi
 * controller actually uses), so the REAL `MatchlockRpcClient` /
 * `MatchlockController` can be driven deterministically WITHOUT a real VM.
 * The driver speaks the ACTUAL wire format: stdout/stderr payloads are
 * base64-encoded PER FRAME exactly like pkg/rpc/handler.go's streamWriter,
 * exec_pipe emits `exec_pipe.ready` (params.id) before streaming, and stdin is
 * consumed via the dotted `exec_pipe.stdin` / `exec_pipe.stdin_eof`
 * NOTIFICATIONS (no id, no response).
 *
 * The fake is configured through environment variables read at spawn time:
 *   FAKE_IMAGE_TAG / FAKE_IMAGE_DIGEST / FAKE_IMAGE_CONFIG_DIGEST — the image
 *     identity `resolve_image` reports and `create` verifies against.
 *   FAKE_IMAGE_OCI_ENV_PATH — optional image `oci.env.PATH` the fake reports
 *     on resolve_image (image-PATH discovery/preservation tests).
 *   FAKE_CREATE_ACTUAL_DIGEST / FAKE_CREATE_ACTUAL_CONFIG_DIGEST — the ACTUAL
 *     built image identity the runtime checks `create.image_identity` against.
 *   FAKE_CREATE_REJECT_IMAGE_IDENTITY=1 — create with a mismatching
 *     image_identity is rejected (-32000) fail-closed.
 *   FAKE_RESOLVE_MISSING=1 — resolve_image returns an unknown-image error.
 *   FAKE_RESOLVE_HANG=1 — resolve_image NEVER responds (request-deadline test).
 *   FAKE_RESOLVE_DELAY_MS — resolve_image sleeps this long before responding
 *     (close-during-delayed-resolve: a close requested while the create-path
 *     resolve is pending must prevent the create that would otherwise follow).
 *   FAKE_EXEC_STDOUT / FAKE_EXEC_STDERR / FAKE_EXEC_EXIT — exec output.
 *   FAKE_ECHO_STDIN=1 — exec_pipe echoes its collected stdin to stdout.
 *   FAKE_SPLIT_UTF8_STDOUT=1 — exec_stream/exec_pipe send stdout as TWO
 *     base64 frames whose boundary splits one multi-byte UTF-8 character
 *     (chunk-safe decode test).
 *   FAKE_STDOUT_BEFORE_READY=1 — exec_pipe emits one exec_pipe.stdout frame
 *     BEFORE exec_pipe.ready (out-of-order wire tolerance test).
 *   FAKE_DELAY_READY_MS — exec_pipe delays `exec_pipe.ready` by this many ms
 *     (stdin must be queued until ready) and records {"event":"ready_sent"}
 *     in the transcript.
 *   FAKE_NO_READY=1 — exec_pipe never sends `exec_pipe.ready` (client stdin
 *     must reject on its ready deadline instead of hanging).
 *   FAKE_PIPE_WAIT_MS — how long exec_pipe waits for stdin EOF before
 *     finishing (default 4000).
 *   FAKE_CANCEL_BLOCK_MS — exec_stream waits this long (cancellable) so a
 *     concurrent cancel can be exercised.
 *   FAKE_EMIT_OVERSIZE_ON_START=1 — prints one >16 MiB stdout line at startup
 *     (client inbound line-length / protocol-failure test).
 *   FAKE_STREAM_STDOUT_BYTES — exec_stream emits this many stdout bytes as
 *     many small base64 frames before resolving (buffered-exec budget test).
 *   FAKE_CREATE_HANG=1 — create NEVER responds (create-timeout test).
 *   FAKE_CREATE_DELAY_MS — create is ACCEPTED immediately (vmCreated=true,
 *     matching a runtime that began booting the VM) but its response is held
 *     this many ms (late-create/cancel settlement: a close requested while
 *     create is in flight, then the create response arrives late).
 *   FAKE_CLOSE_FAIL — number of consecutive close requests that fail with a
 *     -32000 error before the next succeeds (failed-close admission test).
 *   FAKE_CLOSE_ERROR_MESSAGE — make EVERY close respond with
 *     {code:-32000, message:<value>} instead of succeeding. Used to pin the
 *     benign already-stopped/closed close-body path (US-004) and the generic
 *     cleanup-failure path with an explicit message.
 *   FAKE_CLOSE_DELAY_MS — close handler delays its (successful) response by
 *     this many ms (delayed-close revocation test).
 *   FAKE_HOLD_OPEN=1 — do NOT exit on stdin EOF; keeps an interval running so
 *     the EXACT owned child can be signal-killed by dispose() (real exit
 *     signal forensics).
 *   FAKE_EXIT_AFTER_CREATE_MS — process.exit(9) this long after a successful
 *     create (transport exits WITHOUT a close response).
 *   FAKE_TRANSCRIPT_FILE — every received request is appended as a JSON line
 *     plus {"event":...} markers, so tests can assert exact wire ordering.
 *
 * The `close` handler mirrors pkg/rpc/handler.go handleClose: it does NOT
 * validate timeout_seconds (a non-positive value yields an immediately
 * expired close context, which fails an in-flight vm.Close with -32003 rather
 * than hanging), and it does NOT process.exit(0) right after responding — the
 * real server ends its run loop when the client closes stdin after the
 * confirmed response, which also lets the response flush before exit.
 *
 * Only Node built-ins are used (readline, fs). It never creates a VM.
 */

import fs from "node:fs";
import { tamanduaTempDir } from "../../lib/temp-dir.js";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DRIVER_SOURCE = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

const env = process.env;
const imageDigest = env.FAKE_IMAGE_DIGEST || "sha256:fakedigest";
const imageConfigDigest = env.FAKE_IMAGE_CONFIG_DIGEST || "sha256:fakeconfigdigest";
const imageTag = env.FAKE_IMAGE_TAG || "igorhvr/bedlam-ubuntu";
// The ACTUAL built image identity the runtime checks create.image_identity
// against. Simulates a store identity that differs from the built image.
const actualDigest = env.FAKE_CREATE_ACTUAL_DIGEST || imageDigest;
const actualConfigDigest = env.FAKE_CREATE_ACTUAL_CONFIG_DIGEST || imageConfigDigest;
const exitCode = Number.parseInt(env.FAKE_EXEC_EXIT || "0", 10);
const blockMs = Number.parseInt(env.FAKE_CANCEL_BLOCK_MS || "0", 10);
const readyDelayMs = Number.parseInt(env.FAKE_DELAY_READY_MS || "0", 10);
const noReady = env.FAKE_NO_READY === "1";
const pipeWaitMs = Number.parseInt(env.FAKE_PIPE_WAIT_MS || "4000", 10);
const streamStdoutBytes = Number.parseInt(env.FAKE_STREAM_STDOUT_BYTES || "0", 10);
const transcriptFile = env.FAKE_TRANSCRIPT_FILE || "";
// Fixtures for controller lifecycle/forensics regressions:
//   FAKE_CLOSE_FAIL — number of CONSECUTIVE close requests that fail with a
//     -32000 error before the next close succeeds (failed-close test).
//   FAKE_CLOSE_DELAY_MS — close handler sleeps this long before responding
//     (delayed-close admission-revocation test; the response is still sent).
//   FAKE_HOLD_OPEN=1 — do NOT exit on stdin EOF (keeps the event loop alive
//     with an interval) so the EXACT owned child can be signal-killed by the
//     client's dispose() (real-signal forensics test).
//   FAKE_EXIT_AFTER_CREATE_MS — process.exit(9) this long after a successful
//     create (transport exit WITHOUT a close response: isClosed must NOT be
//     set merely because the RPC child exited).
let closeFailuresLeft = Number.parseInt(env.FAKE_CLOSE_FAIL || "0", 10);
const closeErrorMessage = env.FAKE_CLOSE_ERROR_MESSAGE || "";
const closeDelayMs = Number.parseInt(env.FAKE_CLOSE_DELAY_MS || "0", 10);
const holdOpen = env.FAKE_HOLD_OPEN === "1";
const exitAfterCreateMs = Number.parseInt(env.FAKE_EXIT_AFTER_CREATE_MS || "0", 10);
const resolveDelayMs = Number.parseInt(env.FAKE_RESOLVE_DELAY_MS || "0", 10);
const createDelayMs = Number.parseInt(env.FAKE_CREATE_DELAY_MS || "0", 10);

// Split the payload across two frames INSIDE a multi-byte UTF-8 sequence so a
// naive per-frame utf8 decode corrupts it; bytes-first decode must survive.
function splitFrames(payload) {
  const buf = Buffer.from(payload, "utf8");
  const mid = buf.indexOf(0xC3); // first byte of a two-byte UTF-8 lead (é/ö…)
  const cut = mid >= 0 ? mid + 1 : Math.floor(buf.length / 2); // inside the pair
  return [buf.subarray(0, cut), buf.subarray(cut)];
}

function txn(obj) {
  if (transcriptFile) fs.appendFileSync(transcriptFile, JSON.stringify(obj) + "\\n");
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function sendResult(id, result) { send({ jsonrpc: "2.0", result, id }); }
function sendError(id, code, message) { send({ jsonrpc: "2.0", error: { code, message }, id }); }

if (env.FAKE_EMIT_OVERSIZE_ON_START === "1") {
  process.stdout.write("x".repeat(20 * 1024 * 1024) + "\\n");
}

// exec_pipe per-id state
const stdinBuf = new Map();       // id -> accumulated string
const eofResolvers = new Map();   // id -> resolve()
const cancelled = new Set();      // request ids cancelled
let vmCreated = false;            // true after a successful create

function resolveEof(id) { const r = eofResolvers.get(id); if (r) { eofResolvers.delete(id); r(); } }

function waitEofOrCancel(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { eofResolvers.delete(id); resolve(); }, timeoutMs);
    eofResolvers.set(id, () => { clearTimeout(timer); resolve(); });
  });
}

function waitInterruptible(id, ms) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (cancelled.has(id)) { clearInterval(timer); resolve(); }
    }, 10);
    setTimeout(() => { clearInterval(timer); resolve(); }, ms);
  });
}

async function handle(req) {
  txn(req);
  const method = req.method;
  if (method === "resolve_image") {
    if (env.FAKE_RESOLVE_HANG === "1") return; // never respond
    if (env.FAKE_RESOLVE_MISSING === "1") {
      return sendError(req.id, -32602, "image not found: " + (req.params && req.params.tag));
    }
    if (resolveDelayMs > 0) await new Promise((r) => setTimeout(r, resolveDelayMs));
    // MTLK-PI-EXEC union MTLK-DSH-EXEC: honor BOTH image-PATH spellings.
    // The pi branch introduced FAKE_IMAGE_OCI_ENV_PATH and the dsh branch
    // used FAKE_IMAGE_PATH for the same oci.env.PATH; tests on each side
    // pin their own spelling, so neither may be dropped.
    const rawImagePath = env.FAKE_IMAGE_OCI_ENV_PATH ?? env.FAKE_IMAGE_PATH;
    const ociEnv = rawImagePath && rawImagePath.trim() !== "" ? { PATH: rawImagePath } : {};
    return sendResult(req.id, { tag: imageTag, digest: imageDigest, config_digest: imageConfigDigest, source: "import", size: 1, oci: { cmd: ["/bin/sh"], ...(Object.keys(ociEnv).length > 0 ? { env: ociEnv } : {}) } });
  }
  if (method === "create") {
    const p = req.params || {};
    const ident = p.image_identity;
    if (env.FAKE_CREATE_HANG === "1") return; // never respond (create-timeout test)
    if (env.FAKE_CREATE_REJECT_IMAGE_IDENTITY === "1") {
      if (!ident || (!ident.digest && !ident.config_digest)) {
        return sendError(req.id, -32000, "expected identity pins nothing (set digest and/or config_digest)");
      }
      if (ident.digest !== actualDigest || ident.config_digest !== actualConfigDigest) {
        return sendError(req.id, -32000, "image identity mismatch: digest mismatch: expected \\"" + ident.digest + "\\", actual \\"" + actualDigest + "\\"");
      }
    }
    // ACCEPT the create (the runtime has begun booting this VM) BEFORE any
    // response delay: a close processed while create is in flight therefore
    // closes a real (vmCreated) VM — the late-create/cancel settlement case.
    vmCreated = true;
    txn({ event: "vm_created" });
    if (createDelayMs > 0) await new Promise((r) => setTimeout(r, createDelayMs));
    if (exitAfterCreateMs > 0) {
      setTimeout(() => process.exit(9), exitAfterCreateMs);
    }
    return sendResult(req.id, { id: "vm-" + Math.random().toString(16).slice(2, 10) });
  }
  if (method === "exec_pipe") {
    if (req.id == null) return sendError(req.id, -32600, "exec_pipe requires request id");
    const reqId = req.id;
    stdinBuf.set(reqId, ""); eofResolvers.set(reqId, () => {});
    if (env.FAKE_STDOUT_BEFORE_READY === "1") {
      // Out-of-order wire frame: data emitted BEFORE exec_pipe.ready. A
      // conforming client must tolerate/route it and still gate stdin on ready.
      send({ jsonrpc: "2.0", method: "exec_pipe.stdout", params: { id: reqId, data: Buffer.from("EARLY-").toString("base64") } });
    }
    if (readyDelayMs > 0) await new Promise((r) => setTimeout(r, readyDelayMs));
    if (!noReady) {
      txn({ event: "ready_sent", id: reqId });
      send({ jsonrpc: "2.0", method: "exec_pipe.ready", params: { id: reqId } });
    }
    await waitEofOrCancel(reqId, pipeWaitMs);
    if (cancelled.has(reqId)) return sendError(reqId, -32003, "request cancelled");
    const input = stdinBuf.get(reqId) || "";
    let out = (env.FAKE_EXEC_STDOUT !== undefined ? env.FAKE_EXEC_STDOUT : "") + (env.FAKE_ECHO_STDIN === "1" ? input : "");
    const err = env.FAKE_EXEC_STDERR || "";
    if (env.FAKE_SPLIT_UTF8_STDOUT === "1") {
      out = "héllo → wörld";
      const [a, b] = splitFrames(out);
      send({ jsonrpc: "2.0", method: "exec_pipe.stdout", params: { id: reqId, data: a.toString("base64") } });
      send({ jsonrpc: "2.0", method: "exec_pipe.stdout", params: { id: reqId, data: b.toString("base64") } });
    } else if (out !== "") {
      send({ jsonrpc: "2.0", method: "exec_pipe.stdout", params: { id: reqId, data: Buffer.from(out).toString("base64") } });
    }
    if (err !== "") send({ jsonrpc: "2.0", method: "exec_pipe.stderr", params: { id: reqId, data: Buffer.from(err).toString("base64") } });
    return sendResult(reqId, { exit_code: exitCode, duration_ms: 1 });
  }
  if (method === "exec_pipe.stdin") {
    const id = req.params && req.params.id;
    const data = req.params && req.params.data ? Buffer.from(req.params.data, "base64").toString("utf8") : "";
    if (stdinBuf.has(id)) stdinBuf.set(id, (stdinBuf.get(id) || "") + data);
    return;
  }
  if (method === "exec_pipe.stdin_eof") {
    resolveEof(req.params && req.params.id);
    return;
  }
  if (method === "exec_stream") {
    const reqId = req.id;
    if (blockMs > 0) await waitInterruptible(reqId, blockMs);
    if (cancelled.has(reqId)) return sendError(reqId, -32003, "request cancelled");
    const stdout = env.FAKE_EXEC_STDOUT || "";
    const stderr = env.FAKE_EXEC_STDERR || "";
    if (streamStdoutBytes > 0) {
      // Stream a large stdout as many small base64 frames (execCommand budget
      // test) — the assembled payload is 'a' repeated streamStdoutBytes.
      const chunk = Buffer.alloc(4096, 0x61); // 'a'
      let sent = 0;
      while (sent < streamStdoutBytes) {
        const n = Math.min(chunk.length, streamStdoutBytes - sent);
        send({ jsonrpc: "2.0", method: "exec_stream.stdout", params: { id: reqId, data: chunk.subarray(0, n).toString("base64") } });
        sent += n;
      }
    } else if (env.FAKE_SPLIT_UTF8_STDOUT === "1") {
      const [a, b] = splitFrames("héllo → wörld");
      send({ jsonrpc: "2.0", method: "exec_stream.stdout", params: { id: reqId, data: a.toString("base64") } });
      send({ jsonrpc: "2.0", method: "exec_stream.stdout", params: { id: reqId, data: b.toString("base64") } });
    } else if (stdout !== "") {
      send({ jsonrpc: "2.0", method: "exec_stream.stdout", params: { id: reqId, data: Buffer.from(stdout).toString("base64") } });
    }
    if (stderr !== "") send({ jsonrpc: "2.0", method: "exec_stream.stderr", params: { id: reqId, data: Buffer.from(stderr).toString("base64") } });
    return sendResult(reqId, { exit_code: exitCode, duration_ms: 1 });
  }
  if (method === "exec") {
    return sendResult(req.id, { exit_code: exitCode, stdout: Buffer.from(env.FAKE_EXEC_STDOUT || "").toString("base64"), stderr: Buffer.from(env.FAKE_EXEC_STDERR || "").toString("base64"), duration_ms: 1 });
  }
  if (method === "cancel") {
    const id = req.params && req.params.id;
    if (cancelled.has(id)) return sendResult(req.id, { cancelled: false });
    cancelled.add(id);
    resolveEof(id);
    return sendResult(req.id, { cancelled: true });
  }
  if (method === "close") {
    if (closeFailuresLeft > 0) {
      closeFailuresLeft -= 1;
      return sendError(req.id, -32000, "close failed (fixture)");
    }
    if (closeErrorMessage) {
      // US-004 fixture: an explicit close error body (e.g. "vm not running").
      return sendError(req.id, -32000, closeErrorMessage);
    }
    if (closeDelayMs > 0) await new Promise((r) => setTimeout(r, closeDelayMs));
    const p = req.params || {};
    const timeout = typeof p.timeout_seconds === "number" ? p.timeout_seconds : 0;
    // Mirror pkg/rpc/handler.go handleClose: no server-side validation of
    // timeout_seconds (the client enforces positive) — a non-positive value
    // just yields an immediately-expired close context. handleClose detaches
    // the VM FIRST; an expired context then fails the in-flight vm.Close with
    // -32003 (ErrCodeCancelled) rather than hanging, while close with no live
    // VM still reports success. Do NOT process.exit(0) right after responding:
    // the real server ends its run loop when the client closes stdin after
    // the confirmed response (client.close() does), letting the response
    // flush before the process exits.
    const alreadyClosed = !vmCreated;
    const expired = !Number.isFinite(timeout) || timeout <= 0;
    vmCreated = false;
    if (expired && !alreadyClosed) {
      return sendError(req.id, -32003, "close: context deadline exceeded (non-positive timeout_seconds)");
    }
    txn({ event: "vm_closed", timeout_seconds: timeout });
    return sendResult(req.id, {});
  }
  sendError(req.id, -32601, "Method not found");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (t === "") return;
  let req;
  try { req = JSON.parse(t); } catch { sendError(null, -32700, "Parse error"); return; }
  Promise.resolve(handle(req)).catch((e) => sendError(req.id, -32000, String(e && e.message || e)));
});
rl.on("close", () => {
  // FAKE_HOLD_OPEN keeps the process alive on stdin EOF (owned signal-kill
  // fixture); the default mirrors the real server, which exits when the
  // client closes stdin after the confirmed close response.
  if (holdOpen) return;
  process.exit(0);
});
if (holdOpen) setInterval(() => {}, 1000);
`;

export interface WriteFakeRpcDriverOptions {
  /** target directory (defaults to a fresh mktemp under /tmp). */
  dir?: string;
}

/**
 * Write the fake driver script and return its absolute path. The caller
 * spawns it with `rpcBinaryPath = process.execPath`, `rpcArgs = [path]`.
 */
export function writeFakeRpcDriver(opts: WriteFakeRpcDriverOptions = {}): string {
  const dir = opts.dir ?? tamanduaTempDir("tamandua-mtlk-fake-rpc-");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fake-matchlock-rpc.mjs");
  fs.writeFileSync(file, DRIVER_SOURCE, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

/** Create a unique owned transcript file path (caller cleans up). */
export function tempTranscriptPath(): string {
  const dir = tamanduaTempDir("tamandua-mtlk-txn-");
  return path.join(dir, `transcript-${randomBytes(4).toString("hex")}.jsonl`);
}

export { DRIVER_SOURCE };
