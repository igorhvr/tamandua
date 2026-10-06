/**
 * US-008 — fake RPC driver exec_tty protocol.
 *
 * Drives the SPAWNED fake driver over its real stdio JSON-RPC wire (the
 * `matchlock rpc` line-delimited protocol) and asserts the exec_tty family
 * matches the runtime pkg/rpc/handler.go handleExecTTY contract:
 *   - `exec_tty` request with command/working_dir/user/rows/cols
 *   - `exec_tty.ready` emitted BEFORE any stdout frame
 *   - base64 `exec_tty.stdout` frames
 *   - `exec_tty.stdin` / `exec_tty.stdin_eof` / `exec_tty.resize`
 *     NOTIFICATIONS consumed with no response
 *   - result `{exit_code, duration_ms}`
 * plus the deterministic knobs (scripted stdout, stdin echo, exit code,
 * delayed-ready, absent-ready) and the transcript event markers.
 *
 * This file spawns node:child_process, so it is registered in
 * tests/serial-files.txt. It never creates a real VM.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  writeFakeRpcDriver,
  tempTranscriptPath,
} from "../../../dist/installer/matchlock/fake-rpc-driver.js";

interface DriverFrame {
  jsonrpc?: string;
  id?: number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface TranscriptLine extends DriverFrame {
  event?: string;
  [key: string]: unknown;
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeBase64(data: unknown): string {
  return Buffer.from(String(data ?? ""), "base64").toString("utf8");
}

/**
 * Sanitized child env: strip every FAKE_* key so an ambient test-environment
 * fixture cannot leak into the spawned driver, then layer the per-test knobs.
 * Uses Object.entries (never a spread) to stay clear of the isolation guard.
 */
function driverEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("FAKE_")) env[key] = process.env[key];
  }
  return Object.assign(env, overrides);
}

/**
 * Minimal raw-protocol client: writes JSON-RPC lines to the driver's stdin and
 * consumes its stdout lines into an ordered queue that `waitFor` drains.
 */
class FakeDriverHarness {
  readonly frames: DriverFrame[] = [];
  private readonly queue: DriverFrame[] = [];
  private readonly waiters: Array<{
    match: (frame: DriverFrame) => boolean;
    resolve: (frame: DriverFrame) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private readonly rl: readline.Interface;
  private readonly proc: ChildProcessWithoutNullStreams;

  constructor(driverPath: string, env: Record<string, string | undefined>) {
    this.proc = spawn(process.execPath, [driverPath], {
      env: driverEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      if (line.trim() === "") return;
      const frame = JSON.parse(line) as DriverFrame;
      this.frames.push(frame);
      this.deliver(frame);
    });
  }

  private deliver(frame: DriverFrame): void {
    for (let i = 0; i < this.waiters.length; i += 1) {
      if (this.waiters[i].match(frame)) {
        const [waiter] = this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
    }
    this.queue.push(frame);
  }

  waitFor(match: (frame: DriverFrame) => boolean, timeoutMs = 5000): Promise<DriverFrame> {
    for (let i = 0; i < this.queue.length; i += 1) {
      if (match(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise<DriverFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for a driver frame"));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  waitReady(id: number): Promise<DriverFrame> {
    return this.waitFor((frame) => frame.method === "exec_tty.ready" && frame.params?.id === id);
  }

  waitStdout(id: number): Promise<DriverFrame> {
    return this.waitFor((frame) => frame.method === "exec_tty.stdout" && frame.params?.id === id);
  }

  waitResult(id: number): Promise<DriverFrame> {
    return this.waitFor((frame) => frame.id === id && frame.result !== undefined);
  }

  send(frame: unknown): void {
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
  }

  indexOf(frame: DriverFrame): number {
    return this.frames.indexOf(frame);
  }

  async stop(): Promise<void> {
    this.rl.close();
    if (!this.proc.stdin.destroyed) this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
      this.proc.once("exit", () => resolve());
      this.proc.kill("SIGKILL");
    });
  }
}

function execTtyRequest(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "exec_tty",
    params: {
      command: "/bin/sh",
      working_dir: "/workspace",
      user: "1000:1000",
      rows: 24,
      cols: 80,
      ...extra,
    },
  };
}

function readTranscript(file: string): TranscriptLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TranscriptLine);
}

describe("fake RPC driver exec_tty protocol", () => {
  let tmp: string;
  let driver: string;
  let harness: FakeDriverHarness | undefined;

  beforeEach(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-tty-driver-");
    driver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
  });

  afterEach(async () => {
    if (harness) await harness.stop();
    harness = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("emits exec_tty.ready before any stdout frame and streams base64 stdout frames", async () => {
    const transcript = tempTranscriptPath();
    harness = new FakeDriverHarness(driver, {
      FAKE_TTY_STDOUT_FRAMES: JSON.stringify(["one", "two"]),
      FAKE_TRANSCRIPT_FILE: transcript,
    });
    harness.send(execTtyRequest(1));

    const ready = await harness.waitReady(1);
    assert.equal(ready.jsonrpc, "2.0");
    assert.equal(ready.params?.id, 1);
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 1 } });

    const first = await harness.waitStdout(1);
    const second = await harness.waitStdout(1);
    assert.equal(decodeBase64(first.params?.data), "one");
    assert.equal(decodeBase64(second.params?.data), "two");

    const result = await harness.waitResult(1);
    assert.deepEqual(result.result, { exit_code: 0, duration_ms: 1 });

    // Wire ordering: ready precedes both stdout frames.
    const readyIndex = harness.indexOf(ready);
    assert.ok(readyIndex >= 0);
    assert.ok(readyIndex < harness.indexOf(first));
    assert.ok(harness.indexOf(first) < harness.indexOf(second));

    // Transcript carries the received request and the sent-side event markers.
    const lines = readTranscript(transcript);
    const request = lines.find((line) => line.method === "exec_tty");
    assert.equal(request?.params?.command, "/bin/sh");
    assert.equal(request?.params?.working_dir, "/workspace");
    assert.equal(request?.params?.user, "1000:1000");
    assert.equal(request?.params?.rows, 24);
    assert.equal(request?.params?.cols, 80);
    const events = lines.filter((line) => typeof line.event === "string").map((line) => line.event);
    assert.ok(events.indexOf("tty_ready_sent") < events.indexOf("tty_stdout_sent"));
    assert.ok(events.indexOf("tty_stdout_sent") < events.indexOf("tty_result_sent"));
  });

  it("consumes exec_tty.stdin / stdin_eof / resize notifications with no response and records them", async () => {
    const transcript = tempTranscriptPath();
    harness = new FakeDriverHarness(driver, {
      FAKE_TTY_ECHO_STDIN: "1",
      FAKE_TRANSCRIPT_FILE: transcript,
    });
    harness.send(execTtyRequest(2));
    await harness.waitReady(2);

    harness.send({
      jsonrpc: "2.0",
      method: "exec_tty.stdin",
      params: { id: 2, data: encodeBase64("hello") },
    });
    harness.send({
      jsonrpc: "2.0",
      method: "exec_tty.resize",
      params: { id: 2, rows: 40, cols: 120 },
    });
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 2 } });

    const echoed = await harness.waitStdout(2);
    assert.equal(decodeBase64(echoed.params?.data), "hello");
    const result = await harness.waitResult(2);
    assert.deepEqual(result.result, { exit_code: 0, duration_ms: 1 });

    // Notifications never receive their own JSON-RPC response, so no frame
    // carries a result id for stdin/resize/eof.
    const responses = harness.frames.filter((frame) => frame.result !== undefined && frame.id !== 2);
    assert.deepEqual(responses, []);

    const lines = readTranscript(transcript);
    const stdin = lines.find((line) => line.method === "exec_tty.stdin");
    assert.equal(stdin?.params?.id, 2);
    assert.equal(decodeBase64(stdin?.params?.data), "hello");
    const resize = lines.find((line) => line.method === "exec_tty.resize");
    assert.equal(resize?.params?.rows, 40);
    assert.equal(resize?.params?.cols, 120);
    const eof = lines.find((line) => line.method === "exec_tty.stdin_eof");
    assert.equal(eof?.params?.id, 2);
    // Received-frame order mirrors what the host sent.
    const methods = lines.filter((line) => line.method).map((line) => line.method);
    assert.deepEqual(methods, ["exec_tty", "exec_tty.stdin", "exec_tty.resize", "exec_tty.stdin_eof"]);
  });

  it("queues stdin until a delayed exec_tty.ready arrives", async () => {
    const transcript = tempTranscriptPath();
    harness = new FakeDriverHarness(driver, {
      FAKE_TTY_DELAY_READY_MS: "150",
      FAKE_TTY_ECHO_STDIN: "1",
      FAKE_TRANSCRIPT_FILE: transcript,
    });
    harness.send(execTtyRequest(3));
    harness.send({
      jsonrpc: "2.0",
      method: "exec_tty.stdin",
      params: { id: 3, data: encodeBase64("queued") },
    });
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 3 } });

    const ready = await harness.waitReady(3);
    // The stdin notification is host->driver only, so ordering is asserted
    // from the transcript: stdin was received BEFORE the delayed ready marker.
    const lines = readTranscript(transcript);
    const stdinIndex = lines.findIndex((line) => line.method === "exec_tty.stdin");
    const readyIndex = lines.findIndex((line) => line.event === "tty_ready_sent");
    assert.ok(stdinIndex >= 0, "stdin notification was received");
    assert.ok(readyIndex >= 0, "ready marker was recorded");
    assert.ok(stdinIndex < readyIndex, "stdin arrived BEFORE the delayed ready");
    const echoed = await harness.waitStdout(3);
    assert.equal(decodeBase64(echoed.params?.data), "queued");
    assert.ok(harness.indexOf(ready) < harness.indexOf(echoed), "ready still precedes stdout");
    const result = await harness.waitResult(3);
    assert.equal(result.result?.exit_code, 0);
  });

  it("supports an absent-ready knob while still consuming stdin and resolving", async () => {
    harness = new FakeDriverHarness(driver, {
      FAKE_TTY_NO_READY: "1",
      FAKE_TTY_STDOUT: "no-ready",
      FAKE_TTY_ECHO_STDIN: "1",
      FAKE_TTY_WAIT_MS: "5000",
    });
    harness.send(execTtyRequest(4));
    harness.send({
      jsonrpc: "2.0",
      method: "exec_tty.stdin",
      params: { id: 4, data: encodeBase64("input") },
    });
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 4 } });

    const scripted = await harness.waitStdout(4);
    assert.equal(decodeBase64(scripted.params?.data), "no-ready");
    const echoed = await harness.waitStdout(4);
    assert.equal(decodeBase64(echoed.params?.data), "input");
    const result = await harness.waitResult(4);
    assert.equal(result.result?.exit_code, 0);
    assert.ok(
      !harness.frames.some((frame) => frame.method === "exec_tty.ready"),
      "no ready frame is emitted with FAKE_TTY_NO_READY=1",
    );
  });

  it("resolves with the configured exit code and duration", async () => {
    harness = new FakeDriverHarness(driver, {
      FAKE_TTY_EXIT: "7",
      FAKE_TTY_DURATION_MS: "42",
    });
    harness.send(execTtyRequest(5));
    await harness.waitReady(5);
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 5 } });
    const result = await harness.waitResult(5);
    assert.deepEqual(result.result, { exit_code: 7, duration_ms: 42 });
  });

  it("preserves a multi-byte UTF-8 character split across stdout frame boundaries", async () => {
    harness = new FakeDriverHarness(driver, { FAKE_TTY_SPLIT_UTF8: "1" });
    harness.send(execTtyRequest(6));
    await harness.waitReady(6);
    harness.send({ jsonrpc: "2.0", method: "exec_tty.stdin_eof", params: { id: 6 } });

    const first = await harness.waitStdout(6);
    const second = await harness.waitStdout(6);
    const bytes = Buffer.concat([
      Buffer.from(String(first.params?.data ?? ""), "base64"),
      Buffer.from(String(second.params?.data ?? ""), "base64"),
    ]);
    assert.equal(bytes.toString("utf8"), "héllo → wörld");
  });

  it("requires an exec_tty request id", async () => {
    harness = new FakeDriverHarness(driver, {});
    harness.send({
      jsonrpc: "2.0",
      method: "exec_tty",
      params: { command: "/bin/sh" },
    });
    const error = await harness.waitFor((frame) => frame.error !== undefined);
    assert.equal(error.error?.code, -32600);
    assert.match(String(error.error?.message), /exec_tty requires request id/);
  });
});
