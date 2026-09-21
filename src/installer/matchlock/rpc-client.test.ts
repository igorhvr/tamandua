import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MatchlockRpcClient,
  MATCHLOCK_CLIENT_ERROR_CODES,
  decodeFrameBytes,
  decodeFramesText,
  isAlreadyStoppedCloseError,
} from "../../../dist/installer/matchlock/rpc-client.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import type { MatchlockStreamFrame, MatchlockExecBufferedResult, MatchlockExecOptions } from "../../../dist/installer/matchlock/types.js";

// Test isolation: the controller/logger reachable from this suite must never
// resolve the live ~/.tamandua log path, so pin state/HOME to a temp dir
// before any test (the lane runner fails on [state-path] ledger entries).
const ISOLATED_STATE = tamanduaTempDir("tamandua-mtlk-rpcclient-state-");
const ISOLATED_HOME = path.join(ISOLATED_STATE, "home");
fs.mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.HOME = ISOLATED_HOME;
process.env.TAMANDUA_STATE_DIR = ISOLATED_STATE;
process.env.TAMANDUA_DB_PATH = path.join(ISOLATED_STATE, "tamandua.db");

const FAKE_ENV_KEYS = [
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_CREATE_ACTUAL_DIGEST",
  "FAKE_CREATE_ACTUAL_CONFIG_DIGEST",
  "FAKE_CREATE_REJECT_IMAGE_IDENTITY",
  "FAKE_CREATE_HANG",
  "FAKE_RESOLVE_MISSING",
  "FAKE_RESOLVE_HANG",
  "FAKE_EXEC_STDOUT",
  "FAKE_EXEC_STDERR",
  "FAKE_EXEC_EXIT",
  "FAKE_ECHO_STDIN",
  "FAKE_SPLIT_UTF8_STDOUT",
  "FAKE_STDOUT_BEFORE_READY",
  "FAKE_DELAY_READY_MS",
  "FAKE_NO_READY",
  "FAKE_PIPE_WAIT_MS",
  "FAKE_CANCEL_BLOCK_MS",
  "FAKE_EMIT_OVERSIZE_ON_START",
  "FAKE_STREAM_STDOUT_BYTES",
  "FAKE_CLOSE_FAIL",
  "FAKE_CLOSE_ERROR_MESSAGE",
  "FAKE_CLOSE_DELAY_MS",
  "FAKE_HOLD_OPEN",
  "FAKE_EXIT_AFTER_CREATE_MS",
  "FAKE_TRANSCRIPT_FILE",
];

function snapshotFakeEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of FAKE_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreFakeEnv(saved: Record<string, string | undefined>): void {
  for (const k of FAKE_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("matchlock rpc client (fake driver)", () => {
  let tmp: string;
  let fakeDriver: string;
  let savedEnv: Record<string, string | undefined>;
  const transcriptDirs: string[] = [];

  before(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-rpcclient-");
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
    savedEnv = snapshotFakeEnv();
  });
  after(() => {
    restoreFakeEnv(savedEnv);
    for (const d of transcriptDirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function scaffold(t: { after: (fn: () => Promise<unknown> | void) => void }, over: Record<string, string | undefined> = {}, clientOver: Record<string, number> = {}) {
    const saved = snapshotFakeEnv();
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const transcriptPath = tempTranscriptPath();
    transcriptDirs.push(path.dirname(transcriptPath));
    process.env.FAKE_TRANSCRIPT_FILE = transcriptPath;
    t.after(() => restoreFakeEnv(saved));
    const client = new MatchlockRpcClient({
      binaryPath: process.execPath,
      args: [fakeDriver],
      requestTimeoutMs: 10_000,
      readyTimeoutMs: 600,
      stdinDrainTimeoutMs: 3_000,
      // Isolation: capture diagnostics instead of the default logger, which
      // would write to the real ~/.tamandua state (guard ledger violation).
      onLog: () => {},
      ...clientOver,
    });
    // Always reclaim the OWNED child, even when an assertion fails: a leaked
    // child would keep the whole node:test process alive indefinitely.
    t.after(() => client.dispose());
    const readTranscript = (): Array<Record<string, unknown>> =>
      fs.existsSync(transcriptPath)
        ? fs
            .readFileSync(transcriptPath, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
    return { client, readTranscript };
  }

  it("exec_stream frames carry raw base64 and decode exactly once, chunk-safe across a split multi-byte char", async (t) => {
    const { client } = scaffold(t, { FAKE_SPLIT_UTF8_STDOUT: "1" });
    client.start();
    const stdout: MatchlockStreamFrame[] = [];
    const result = await client.execStream({ command: "printf h" }, (f) => {
      if (f.kind === "stdout") stdout.push(f);
    });
    assert.equal(result.exit_code, 0);
    assert.equal(stdout.length, 2, "driver must split stdout into two base64 frames");
    // A naive per-frame utf8 decode CORRUPTS the split multibyte char…
    const naiveFirst = Buffer.from(stdout[0].base64 ?? "", "base64").toString("utf8");
    assert.ok(naiveFirst.includes("\uFFFD"), "per-frame decode of the split lead byte must show a replacement char");
    // …while bytes-first concatenation + single decode is chunk-safe.
    const text = decodeFramesText(stdout);
    assert.equal(text, "héllo → wörld");
    // decodeFrameBytes decodes exactly one frame once (single-decode helper).
    const one = decodeFrameBytes(stdout[0]);
    assert.ok(Buffer.isBuffer(one));
    const two = Buffer.concat([one, decodeFrameBytes(stdout[1])]).toString("utf8");
    assert.equal(two, "héllo → wörld");
  });

  it("exec_pipe tolerates DATA BEFORE ready (out-of-order frame routed, stdin still gated on ready)", async (t) => {
    const { client } = scaffold(t, {
      FAKE_STDOUT_BEFORE_READY: "1",
      FAKE_ECHO_STDIN: "1",
      FAKE_IMAGE_DIGEST: "sha256:aaaa",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb",
    });
    client.start();
    const stdout: MatchlockStreamFrame[] = [];
    const pipe = client.execPipe({ command: "cat" }, (f) => {
      if (f.kind === "stdout") stdout.push(f);
    });
    await pipe.stdin.write("z");
    await pipe.stdin.eof();
    const result = await pipe.result;
    assert.equal(result.exit_code, 0);
    // Frame 1 (EARLY-) arrived before ready and must NOT be dropped; the
    // stdin payload arrives after ready and echoes last.
    assert.equal(stdout.length, 2);
    assert.equal(decodeFramesText(stdout), "EARLY-z");
  });

  it("execCommand assembles streamed stdout/stderr and reports them as base64 decoded exactly once", async (t) => {
    const { client } = scaffold(t, { FAKE_EXEC_STDOUT: "RAW-OUT", FAKE_EXEC_STDERR: "raw-err", FAKE_EXEC_EXIT: "3" });
    client.start();
    const result = await client.execCommand({ command: "echo raw" });
    assert.equal(result.exit_code, 3);
    assert.equal(result.stdout, Buffer.from("RAW-OUT").toString("base64"));
    assert.equal(Buffer.from(result.stdout, "base64").toString("utf8"), "RAW-OUT");
    assert.equal(result.stderr, Buffer.from("raw-err").toString("base64"));
    assert.equal(Buffer.from(result.stderr, "base64").toString("utf8"), "raw-err");
  });

  it("the raw buffered `exec` RPC method stays reachable and keeps base64-in-result wire shape", async (t) => {
    const { client } = scaffold(t, { FAKE_EXEC_STDOUT: "RAW-OUT", FAKE_EXEC_STDERR: "raw-err", FAKE_EXEC_EXIT: "3" });
    client.start();
    // Generic request to the real `exec` method: the response carries stdout/
    // stderr base64 in ONE line — wire mirror, decoded exactly once by the
    // consumer. (execCommand itself routes through exec_stream + assembly so a
    // large buffered output can never blow the single-line cap.)
    const result = await client.request<MatchlockExecBufferedResult, MatchlockExecOptions>("exec", { command: "echo raw" });
    assert.equal(result.exit_code, 3);
    assert.equal(result.stdout, Buffer.from("RAW-OUT").toString("base64"));
    assert.equal(Buffer.from(result.stdout, "base64").toString("utf8"), "RAW-OUT");
    assert.equal(result.stderr, Buffer.from("raw-err").toString("base64"));
  });

  it("execCommand enforces its output budget and does NOT destroy the transport on overflow", async (t) => {
    const { client } = scaffold(
      t,
      { FAKE_STREAM_STDOUT_BYTES: "200000", FAKE_EXEC_STDOUT: "", FAKE_EXEC_STDERR: "" },
      { bufferedExecOutputLimitBytes: 4096 },
    );
    client.start();
    await assert.rejects(client.execCommand({ command: "cat big" }), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.EXEC_OUTPUT_LIMIT;
    });
    // The transport survives: an oversized BUFFERED result is a caller budget
    // problem, not a protocol failure of the whole connection.
    assert.equal(client.isDisposed, false, "an execCommand budget breach must not dispose the transport");
    assert.equal(client.isRunning, true, "the owned RPC child must still be running");
    // And the transport is still usable afterwards.
    await client.resolveImage("img:1");
  });

  it("a request that never gets a response is a REPORTED timeout, not an unresolved promise", async (t) => {
    const saved = snapshotFakeEnv();
    process.env.FAKE_RESOLVE_HANG = "1";
    t.after(() => restoreFakeEnv(saved));
    const client = new MatchlockRpcClient({
      binaryPath: process.execPath,
      args: [fakeDriver],
      requestTimeoutMs: 250,
      // Isolation: never let the default logger touch the real state dir.
      onLog: () => {},
    });
    t.after(() => client.dispose());
    const started = Date.now();
    client.start();
    await assert.rejects(client.resolveImage("img:1"), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT;
    });
    assert.ok(Date.now() - started < 10_000, "deadline must fire promptly");
  });

  it("an oversized inbound line is a protocol failure that disposes the transport", async (t) => {
    const { client } = scaffold(t, { FAKE_EMIT_OVERSIZE_ON_START: "1" });
    client.start();
    // The driver prints a >16 MiB line at startup; the client must classify it
    // as a protocol failure and dispose its OWNED child (no unbounded memory).
    const deadline = Date.now() + 5_000;
    while (!client.isDisposed && Date.now() < deadline) {
      await delay(50);
    }
    assert.equal(client.isDisposed, true, "oversized line must trigger transport disposal");
    await client.dispose();
    await assert.rejects(client.resolveImage("img:1"), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED;
    });
  });

  it("exec_pipe queues stdin until `ready` is observed (never sends stdin before ready)", async (t) => {
    const { client, readTranscript } = scaffold(t, {
      FAKE_DELAY_READY_MS: "250",
      FAKE_ECHO_STDIN: "1",
      FAKE_IMAGE_DIGEST: "sha256:aaaa",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb",
    });
    client.start();
    const stdout: MatchlockStreamFrame[] = [];
    const pipe = client.execPipe({ command: "cat" }, (f) => {
      if (f.kind === "stdout") stdout.push(f);
    });
    const writeP = pipe.stdin.write("x\n");
    const eofP = pipe.stdin.eof();
    const result = await pipe.result;
    await writeP;
    await eofP;
    assert.equal(result.exit_code, 0);
    assert.equal(decodeFramesText(stdout), "x\n");
    const txn = readTranscript();
    const readyIdx = txn.findIndex((e) => e.event === "ready_sent");
    const stdinIdx = txn.findIndex((e) => e.method === "exec_pipe.stdin");
    assert.ok(readyIdx >= 0, "driver must send ready");
    assert.ok(stdinIdx >= 0, "client must eventually send stdin");
    assert.ok(readyIdx < stdinIdx, `stdin (idx ${stdinIdx}) must be sent AFTER ready (idx ${readyIdx})`);
  });

  it("exec_pipe stdin write rejects on the ready deadline when ready never arrives (bounded, no hang)", async (t) => {
    const { client } = scaffold(t, { FAKE_NO_READY: "1", FAKE_PIPE_WAIT_MS: "2000" });
    client.start();
    const pipe = client.execPipe({ command: "cat" }, () => {});
    // The exec result is deliberately never awaited in this scenario (stdin
    // never became writable); mark it handled so the t.after dispose cannot
    // surface it as an unhandled rejection.
    void pipe.result.catch(() => {});
    const started = Date.now();
    await assert.rejects(pipe.stdin.write("hello"), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT;
    });
    assert.ok(Date.now() - started < 5_000, "ready deadline must fire promptly");
  });

  it("pending stdin writes reject once the exec request has settled (no writes to a dead pipe)", async (t) => {
    const { client } = scaffold(t, { FAKE_PIPE_WAIT_MS: "150" });
    client.start();
    const pipe = client.execPipe({ command: "cat" }, () => {});
    const result = await pipe.result; // driver finishes without waiting for stdin
    assert.equal(result.exit_code, 0);
    await assert.rejects(pipe.stdin.write("late"), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.REQUEST_INACTIVE;
    });
    await assert.rejects(pipe.stdin.eof(), (e: unknown) => {
      const err = e as { code?: number };
      return err.code === MATCHLOCK_CLIENT_ERROR_CODES.REQUEST_INACTIVE;
    });
  });

  it("dispose kills the EXACT owned child and resolves only after its close is observed; idempotent", async (t) => {
    const { client } = scaffold(t, { FAKE_IMAGE_DIGEST: "sha256:aaaa", FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb" });
    client.start();
    assert.equal(client.isRunning, true);
    const pid = client["child"]?.pid;
    assert.ok(typeof pid === "number");
    const outcome = await client.dispose();
    assert.ok(outcome.code !== null || outcome.signal !== null, "child close must be observed");
    assert.equal(client.isDisposed, true);
    assert.equal(client.isRunning, false);
    // Idempotent second dispose returns the same observed outcome.
    const again = await client.dispose();
    assert.deepEqual(again, outcome);
  });

  it("close requires a positive timeout_seconds at the client boundary", async (t) => {
    const { client } = scaffold(t);
    client.start();
    await assert.rejects(client.close(0), /positive timeout_seconds/);
    await assert.rejects(client.close(-5), /positive timeout_seconds/);
    await assert.rejects(client.close(Number.NaN), /positive timeout_seconds/);
  });

  // ── MTLK-CLEANUP US-004: idempotent already-stopped close ────────────────

  it("US-004: isAlreadyStoppedCloseError recognizes ONLY a benign already-stopped/closed WIRE body (never a client transport/deadline code)", () => {
    // Recognized benign JSON-RPC error bodies: the VM is already gone.
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "vm not running" }), true);
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "vm is not running" }), true);
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "VM already closed" }), true);
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "vm already stopped" }), true);
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "already stopped" }), true);
    // A genuine Sandbox.Close aggregate is a REAL cleanup failure, not benign.
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "machine close: tap teardown failed" }), false);
    assert.equal(isAlreadyStoppedCloseError({ code: -32000, message: "rootfs remove: upper.ext4 busy" }), false);
    // A client-originated transport/deadline code has NO wire response: it can
    // never confirm a close even if its text contains "not running".
    assert.equal(
      isAlreadyStoppedCloseError({
        code: MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED,
        message: "matchlock rpc closed (code=null, signal=SIGKILL) while close was pending",
      }),
      false,
    );
    assert.equal(
      isAlreadyStoppedCloseError({ code: MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED, message: "matchlock rpc is not running (disposed)" }),
      false,
    );
    assert.equal(isAlreadyStoppedCloseError({ code: MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT, message: "vm not running" }), false);
    // Malformed values are never a wire confirmation.
    assert.equal(isAlreadyStoppedCloseError(new Error("vm not running")), false);
    assert.equal(isAlreadyStoppedCloseError("vm not running"), false);
    assert.equal(isAlreadyStoppedCloseError(null), false);
    assert.equal(isAlreadyStoppedCloseError({ message: "vm not running" }), false);
  });

  it("US-004: close resolves as a confirmed close when the server response says the VM is already stopped/closed", async (t) => {
    const { client } = scaffold(t, { FAKE_CLOSE_ERROR_MESSAGE: "vm not running" });
    client.start();
    // The server's close response rejects with a recognized benign body: the
    // client treats it as a CONFIRMED close (no throw), then lets the child
    // exit on stdin EOF.
    await client.close(30);
    assert.equal(client.isRunning, false, "the owned child must be reclaimed after a confirmed (already-stopped) close");
    assert.equal(client.exitCode, 0, "normal stdin-EOF child exit is exposed");
  });

  it("US-004: close with a DEAD transport (no wire response) still rejects and never fabricates a close", async (t) => {
    const { client } = scaffold(t);
    client.start();
    await client.dispose();
    let rejected: { code?: number } | undefined;
    await assert.rejects(
      () => client.close(30),
      (e: unknown) => {
        rejected = e as { code?: number };
        return rejected.code === MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED;
      },
    );
    assert.equal(rejected?.code, MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED, "a dead transport rejects; a close is never fabricated");
  });

  it("exposes the true owned child exit: a NORMAL exit records code 0 and a null signal", async (t) => {
    const { client } = scaffold(t);
    client.start();
    assert.equal(client.exitCode, null);
    assert.equal(client.exitSignal, null);
    // Confirmed close with no live VM still succeeds at the client boundary;
    // stdin EOF then lets the fixture exit normally (code 0).
    await client.close(30);
    assert.equal(client.exitCode, 0, "normal child exit must expose its real code");
    assert.equal(client.exitSignal, null, "a normal exit has no signal");
    assert.equal(client.isRunning, false);
  });

  it("exposes the true owned child exit: a SIGNALED fixture child is reported with its real signal, not a success-shaped record", async (t) => {
    // FAKE_HOLD_OPEN keeps the fixture alive on stdin EOF, so dispose() must
    // SIGTERM the EXACT owned child handle (never a name/PID-guess kill).
    const { client } = scaffold(t, { FAKE_HOLD_OPEN: "1" });
    client.start();
    const outcome = await client.dispose();
    assert.equal(outcome.signal, "SIGTERM", "dispose of a hold-open child must observe the real SIGTERM exit");
    assert.equal(outcome.code, null, "a signaled child has no exit code");
    assert.equal(client.exitSignal, "SIGTERM", "the read-only exitSignal accessor must carry the real signal");
    assert.equal(client.exitCode, null);
    assert.equal(client.isRunning, false);
  });
});
