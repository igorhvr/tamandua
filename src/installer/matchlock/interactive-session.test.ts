/**
 * US-010 — interactive session controller core.
 *
 * Drives the foreground session controller against an OWNED fake VM backend
 * and owned fake host streams (no real VM, model call or matchlock
 * invocation). Covers:
 *   - exactly one VM from the pinned identity + one `exec_tty` with explicit
 *     user/working_dir/rows/cols and NO workflow-round deadline;
 *   - the ordered guest preparation commands;
 *   - host stdin forwarded ONLY after `exec_tty.ready` and bounded backpressure;
 *   - byte-verbatim guest stdout (binary + UTF-8 split across frames);
 *   - host EOF -> `exec_tty.stdin_eof` + resolution with the guest exit status;
 *   - cancellation of the in-flight request;
 *   - bounded teardown that NEVER claims success on an unconfirmed VM close.
 *
 * The controller reaches the shipped `MatchlockRpcClient` (a direct
 * `node:child_process` owner) through its exported `InteractiveSessionController`
 * class, so this file is registered in tests/serial-files.txt.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  InteractiveSessionController,
  InteractiveSessionError,
  INTERACTIVE_SESSION_ALREADY_STARTED_CODE,
  INTERACTIVE_SESSION_GUEST_PREP_FAILED_CODE,
  INTERACTIVE_SESSION_INPUT_FAILED_CODE,
  interactiveSessionSucceeded,
} from "../../../dist/installer/matchlock/interactive-session.js";
import { runInteractiveSession } from "../../../dist/installer/matchlock/interactive-session-orchestration.js";

// ── helpers ──────────────────────────────────────────────────────────

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── CLEANUP-1 fixture helpers ────────────────────────────────────────

const ownedTempDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  ownedTempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of ownedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Owned fake `matchlock` CLI for the CLEANUP-1 DEFAULT removal seam: records
 * every invocation's exact argv + forced HOME, deletes the exact state.db row
 * and removes the exact `<HOME>/.matchlock/vms/<vmId>/` state dir (or fails on
 * request). A non-`rm` invocation exits 2 so an accidental transport-args
 * reuse is loudly wrong.
 */
function writeFakeMatchlockRemovalCli(opts: {
  journalPath: string;
  rmExit?: number;
  rmStderr?: string;
}): string {
  const dir = tmpDir("tamandua-interactive-rmcli-");
  const file = path.join(dir, "matchlock");
  const L: string[] = [];
  L.push("#!/usr/bin/env node");
  L.push("const fs = require('node:fs');");
  L.push("const argv = process.argv.slice(2);");
  L.push(`const JOURNAL = ${JSON.stringify(opts.journalPath)};`);
  L.push(`const RM_EXIT = ${opts.rmExit ?? 0};`);
  L.push(`const RM_STDERR = ${JSON.stringify(opts.rmStderr ?? "")};`);
  L.push("const home = process.env.HOME || '';");
  L.push("const vmId = argv[1] || '';");
  L.push("const stateDir = home + '/.matchlock/vms/' + vmId;");
  L.push(
    "fs.appendFileSync(JOURNAL, JSON.stringify({ event: 'invoke', argv: argv, home: home, vmId: vmId, stateDirExisted: fs.existsSync(stateDir) }) + '\\n');",
  );
  L.push("if (argv[0] === 'rm') {");
  L.push("  if (RM_EXIT !== 0) { process.stderr.write(RM_STDERR); process.exit(RM_EXIT); }");
  L.push("  try {");
  L.push("    const dbPath = home + '/.matchlock/state.db';");
  L.push("    if (!fs.existsSync(dbPath)) throw new Error('state.db missing at ' + dbPath);");
  L.push("    const { DatabaseSync } = require('node:sqlite');");
  L.push("    const db = new DatabaseSync(dbPath);");
  L.push("    const res = db.prepare('DELETE FROM vms WHERE id = ?').run(vmId);");
  L.push("    db.close();");
  L.push("    if (Number(res.changes) === 0) throw new Error('no vms row for ' + vmId);");
  L.push("    fs.rmSync(stateDir, { recursive: true, force: true });");
  L.push("  } catch (e) {");
  L.push("    // A fixture deletion failure must FAIL the fixture, not fake success.");
  L.push("    fs.appendFileSync(JOURNAL, JSON.stringify({ event: 'delete_error', vmId: vmId, message: String(e && e.message || e) }) + '\\n');");
  L.push("    process.exit(3);");
  L.push("  }");
  L.push("  process.exit(0);");
  L.push("}");
  L.push("process.exit(2);");
  fs.writeFileSync(file, L.join("\n") + "\n", { mode: 0o755 });
  return file;
}

interface RemovalJournalLine {
  event: string;
  argv: string[];
  home: string;
  vmId: string;
  stateDirExisted: boolean;
}

function readRemovalJournal(p: string): RemovalJournalLine[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l: string) => l.trim() !== "")
    .map((l: string) => JSON.parse(l) as RemovalJournalLine);
}

function makePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subcommand: "pi",
    harness: "pi",
    shell: false,
    image: "igorhvr/tamandua",
    imageSource: "standard",
    workingDirectory: "/work/project",
    identity: { uid: 1000, gid: 1000, homeDir: "/home/kaladin", cwd: "/work/project" },
    configSelection: { piConfigRoot: "/home/kaladin/.pi", piConfigProfile: "default" },
    allowPrivate: [],
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 4096, swapMB: 8192 },
    rootUsageOverride: false,
    policy: {
      version: 3,
      backend: "matchlock",
      harness: "pi",
      requestedImage: "igorhvr/tamandua",
      workMounts: [],
      gitMetadataRoots: [],
      configurationRoot: "/home/kaladin/.pi",
      guestConfigurationRoot: "/home/kaladin/.pi",
      resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 4096, swapMB: 8192 },
      networkAllowPrivate: [],
    },
    pinnedIdentity: { tag: "igorhvr/tamandua", digest: "sha256:aaaa", config_digest: "sha256:bbbb" },
    ...overrides,
  };
}

function makePrep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const commands = [
    { id: "groupadd", command: "groupadd --gid 1000 tamandua", privileged: true },
    {
      id: "useradd",
      command: "useradd --uid 1000 --gid 1000 --home-dir /home/u1000 --no-create-home --shell /bin/sh tamandua",
      privileged: true,
    },
    {
      id: "create_home",
      command: "install -d -m 0700 -o 1000 -g 1000 /home/u1000",
      target: "/home/u1000",
      privileged: true,
    },
  ];
  return {
    harness: "pi",
    shell: false,
    uid: 1000,
    gid: 1000,
    user: "tamandua",
    group: "tamandua",
    guestHome: "/home/u1000",
    guestConfigurationRoot: "/home/kaladin/.pi",
    guestWorkingDirectory: "/work/project",
    commands,
    env: {
      HOME: "/home/u1000",
      PI_CODING_AGENT_DIR: "/home/kaladin/.pi",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
    },
    ...overrides,
  };
}

/** Owned fake host stdin: records pause/resume and lets tests emit events. */
class FakeStdin {
  paused = false;
  pauseCalls = 0;
  resumeCalls = 0;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((entry) => entry !== listener));
    return this;
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCalls += 1;
  }

  emitData(chunk: Buffer | string): void {
    this.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  emitEnd(): void {
    this.emit("end");
  }

  /** Simulate the host terminal disappearing (close WITHOUT a preceding end). */
  emitClose(): void {
    this.emit("close");
  }

  emitError(err: unknown): void {
    this.emit("error", err);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

/** Owned fake host stdout that captures every byte verbatim. */
class BufferSink {
  readonly chunks: Buffer[] = [];

  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
    return true;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Owned fake terminal hooks (US-011): records raw-mode enable/restore and lets
 * tests raise host signals. Never touches the real process terminal or installs
 * a real signal handler.
 */
class FakeTerminal {
  rawEnabled = false;
  rawEnableCalls = 0;
  restoreCalls = 0;
  readonly signalRegistrations: string[] = [];
  readonly dispositions: string[] = [];
  private readonly handlers = new Map<string, Array<() => void>>();

  enableRawMode(): () => void {
    this.rawEnableCalls += 1;
    this.rawEnabled = true;
    return () => {
      this.restoreCalls += 1;
      this.rawEnabled = false;
    };
  }

  onSignal(signal: string, handler: () => void): () => void {
    this.signalRegistrations.push(signal);
    const list = this.handlers.get(signal) ?? [];
    list.push(handler);
    this.handlers.set(signal, list);
    return () => {
      this.dispositions.push(signal);
      this.handlers.set(
        signal,
        (this.handlers.get(signal) ?? []).filter((entry) => entry !== handler),
      );
    };
  }

  emit(signal: string): void {
    for (const handler of [...(this.handlers.get(signal) ?? [])]) handler();
  }

  handlerCount(signal: string): number {
    return (this.handlers.get(signal) ?? []).length;
  }
}

/** Owned fake `exec_tty` handle with deterministic write/result control. */
class FakeTty {
  readonly writes: Buffer[] = [];
  eofCalls = 0;
  readonly resizeCalls: Array<{ rows: number; cols: number }> = [];
  /** When set, each stdin write awaits this barrier before resolving. */
  writeBarrier: Promise<void> | null = null;
  /** When set, the NEXT stdin write rejects with this error (then clears). */
  writeError: unknown = undefined;
  /** When set, the NEXT stdin eof rejects with this error (then clears). */
  eofError: unknown = undefined;
  private notify: ((frame: Record<string, unknown>) => void) | null = null;
  private resolveResult!: (value: { exit_code: number; duration_ms: number }) => void;
  private rejectResult!: (err: unknown) => void;
  readonly result: Promise<{ exit_code: number; duration_ms: number }>;

  constructor() {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  handle(notify: (frame: Record<string, unknown>) => void): Record<string, unknown> {
    this.notify = notify;
    return {
      requestId: 42,
      stdin: {
        write: async (data: Buffer | string): Promise<void> => {
          if (this.writeError !== undefined) {
            const err = this.writeError;
            this.writeError = undefined;
            throw err;
          }
          this.writes.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
          if (this.writeBarrier) await this.writeBarrier;
        },
        eof: async (): Promise<void> => {
          if (this.eofError !== undefined) {
            const err = this.eofError;
            this.eofError = undefined;
            throw err;
          }
          this.eofCalls += 1;
        },
      },
      resize: async (rows: number, cols: number): Promise<void> => {
        this.resizeCalls.push({ rows, cols });
      },
      result: this.result,
    };
  }

  emitFrame(frame: Record<string, unknown>): void {
    this.notify?.(frame);
  }

  emitReady(): void {
    this.emitFrame({ kind: "ready", requestId: 42 });
  }

  emitStdout(base64: string): void {
    this.emitFrame({ kind: "stdout", base64, requestId: 42 });
  }

  resolve(exitCode: number): void {
    this.resolveResult({ exit_code: exitCode, duration_ms: 1 });
  }

  reject(err: unknown): void {
    this.rejectResult(err);
  }
}

/** Owned fake VM backend: records every lifecycle call, creates nothing. */
class FakeBackend {
  readonly createCalls: unknown[] = [];
  readonly prepCommands: string[] = [];
  readonly ttyCalls: Array<{ cmd: Record<string, unknown>; timeoutMs: number | undefined }> = [];
  readonly cancelCalls: number[] = [];
  readonly closeCalls: number[] = [];
  /** Ordered teardown evidence: distinguishes cancel-then-close from close-only. */
  readonly events: string[] = [];
  disposeCalls = 0;
  vmId = "vm-1";
  /** When set, `prepareAndCreate` throws it (create never returned a VM). */
  createError: unknown = null;
  failPrepAtCommandIndex = -1;
  closeError: unknown = null;
  closeResolvesWithoutIsClosed = false;
  closed = false;
  readonly tty = new FakeTty();

  async prepareAndCreate(expected: unknown): Promise<{ vmId: string; identity: unknown }> {
    this.createCalls.push(expected);
    if (this.createError !== null) throw this.createError;
    return { vmId: this.vmId, identity: expected };
  }

  async execStream(cmd: { command: string }): Promise<{ exit_code: number; duration_ms: number }> {
    this.prepCommands.push(cmd.command);
    const index = this.prepCommands.length - 1;
    const exitCode = index === this.failPrepAtCommandIndex ? 1 : 0;
    return { exit_code: exitCode, duration_ms: 1 };
  }

  execTty(
    cmd: Record<string, unknown>,
    notify: (frame: Record<string, unknown>) => void,
    timeoutMs?: number,
  ): Record<string, unknown> {
    this.ttyCalls.push({ cmd, timeoutMs });
    return this.tty.handle(notify);
  }

  async cancel(id: number): Promise<boolean> {
    this.cancelCalls.push(id);
    this.events.push("cancel");
    // Emulate the runtime cancelling the in-flight PTY session.
    this.tty.reject(new Error("exec_tty cancelled"));
    return true;
  }

  async close(timeoutSeconds: number): Promise<void> {
    this.closeCalls.push(timeoutSeconds);
    this.events.push("close");
    if (this.closeError) throw this.closeError;
    if (!this.closeResolvesWithoutIsClosed) this.closed = true;
  }

  async dispose(): Promise<{ code: number | null; signal: string | null }> {
    this.disposeCalls += 1;
    return { code: null, signal: null };
  }

  get identity(): { invocationId: string; vmId: string | null } {
    return { invocationId: "inv-1", vmId: this.vmId };
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

interface Harness {
  readonly controller: InstanceType<typeof InteractiveSessionController>;
  readonly backend: FakeBackend;
  readonly stdin: FakeStdin;
  readonly stdout: BufferSink;
  readonly terminal: FakeTerminal;
  readonly factoryCalls: Array<{ policy: unknown; options: Record<string, unknown> }>;
  /**
   * CLEANUP-1: every removal call made through the harness's DEFAULT owned
   * recorder (injected seams record into their own closures).
   */
  readonly removals: Array<Record<string, unknown>>;
}

function makeHarness(
  plan: Record<string, unknown> = makePlan(),
  prep: Record<string, unknown> = makePrep(),
  overrides: Record<string, unknown> = {},
): Harness {
  const backend = new FakeBackend();
  const stdin = new FakeStdin();
  const stdout = new BufferSink();
  const terminal = new FakeTerminal();
  const factoryCalls: Harness["factoryCalls"] = [];
  const removals: Harness["removals"] = [];
  const {
    removeVm: injectedRemoveVm,
    removalEvidenceRoot: injectedRemovalEvidenceRoot,
    ...rest
  } = overrides;
  const controller = new InteractiveSessionController(plan, prep, {
    createBackend: (policy: unknown, options: Record<string, unknown>) => {
      factoryCalls.push({ policy, options });
      return backend;
    },
    stdin,
    stdout,
    terminal,
    terminalSize: () => ({ rows: 30, cols: 100 }),
    // CLEANUP-1 test isolation: a fake-backend session defaults to an OWNED
    // recorder + evidence root, so no unit test can ever reach an ambient
    // matchlock binary or the real HOME through the removal seam. Tests that
    // exercise the REAL default seam (captureAndRemoveVm) construct the
    // controller directly with owned fixtures; failure cases inject their own
    // seam explicitly.
    removeVm:
      injectedRemoveVm ??
      ((options: Record<string, unknown>): Record<string, unknown> => {
        removals.push(options);
        return { vmId: options.vmId, removed: true, logsCopiedTo: null, removalExitCode: 0 };
      }),
    removalEvidenceRoot:
      injectedRemovalEvidenceRoot ?? tmpDir("tamandua-interactive-removal-"),
    ...rest,
  });
  return { controller, backend, stdin, stdout, terminal, factoryCalls, removals };
}

// ── tests ────────────────────────────────────────────────────────────

describe("interactive session controller core (US-010)", () => {
  it("creates exactly one VM and launches one exec_tty with explicit user/working_dir/rows/cols and no workflow deadline", async () => {
    const { controller, backend, factoryCalls, removals } = makeHarness();
    const plan = makePlan();
    const prep = makePrep();

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    assert.equal(factoryCalls.length, 1, "exactly one backend constructed");
    assert.equal(factoryCalls[0].options.requireHelperPack, false, "requireHelperPack false");
    assert.equal(typeof factoryCalls[0].options.buildCreateConfig, "function", "interactive create-config builder seam");
    assert.deepEqual(factoryCalls[0].options.createEnv, prep.env, "guest launch env is the create env");

    assert.equal(backend.createCalls.length, 1, "exactly one VM create");
    assert.deepEqual(backend.createCalls[0], plan.pinnedIdentity, "created from the pinned identity");
    assert.deepEqual(
      backend.prepCommands,
      (prep.commands as Array<{ command: string }>).map((command) => command.command),
      "guest preparation commands run in order",
    );

    const ttyCall = backend.ttyCalls[0];
    assert.equal(ttyCall.cmd.command, "pi");
    assert.equal(ttyCall.cmd.working_dir, "/work/project");
    assert.equal(ttyCall.cmd.user, "1000:1000");
    assert.equal(ttyCall.cmd.rows, 30);
    assert.equal(ttyCall.cmd.cols, 100);
    assert.equal(ttyCall.timeoutMs, 0, "no workflow-round deadline on the interactive exec");

    backend.tty.resolve(5);
    const outcome = await runPromise;
    assert.equal(outcome.exitCode, 5);
    assert.equal(outcome.vmId, "vm-1");
    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(outcome.cancelled, false);
    assert.deepEqual(backend.closeCalls, [30], "bounded positive close timeout");
    assert.equal(interactiveSessionSucceeded(outcome), true);
    assert.equal(outcome.vmRemoved, true, "the confirmed close removed this session's VM record");
    assert.equal(removals.length, 1, "a confirmed close triggers exactly one VM record removal");
    assert.equal(removals[0].vmId, "vm-1", "removal targets this session's own VM");
  });

  it("forwards host stdin only after exec_tty.ready and honors bounded backpressure", async () => {
    const { controller, backend, stdin } = makeHarness(makePlan(), makePrep(), {
      stdinHighWaterBytes: 4,
    });

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    // Pre-ready input is buffered, never forwarded.
    stdin.emitData("ab");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(backend.tty.writes.length, 0, "nothing forwarded before ready");

    backend.tty.emitReady();
    await until(() => backend.tty.writes.length === 1, "buffered pre-ready bytes flushed");
    assert.deepEqual(backend.tty.writes[0], Buffer.from("ab"));

    // Block the next write, then exceed the high-water mark: the host stream
    // is paused until the queue drains.
    let releaseBarrier!: () => void;
    backend.tty.writeBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    stdin.emitData("aaaa");
    stdin.emitData("bbbb");
    assert.equal(stdin.paused, true, "host stdin paused at the bounded high-water mark");

    releaseBarrier();
    await until(() => !stdin.paused, "host stdin resumed after drain");
    await until(() => backend.tty.writes.length === 3, "all queued bytes written");
    assert.deepEqual(
      backend.tty.writes.map((buf) => buf.toString("utf8")),
      ["ab", "aaaa", "bbbb"],
    );

    backend.tty.resolve(0);
    const outcome = await runPromise;
    assert.equal(outcome.cleanupConfirmed, true);
  });

  it("writes guest stdout bytes verbatim, including binary and split multi-byte UTF-8", async () => {
    const { controller, backend, stdout } = makeHarness();
    const expected = Buffer.concat([
      Buffer.from("h\u00e9llo", "utf8"),
      Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f]),
      Buffer.from("\u{1F600}", "utf8"),
    ]);

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();

    // Split at arbitrary byte boundaries, including inside multi-byte chars.
    backend.tty.emitStdout(expected.subarray(0, 3).toString("base64"));
    backend.tty.emitStdout(expected.subarray(3, 6).toString("base64"));
    backend.tty.emitStdout(expected.subarray(6).toString("base64"));

    backend.tty.resolve(0);
    await runPromise;
    assert.deepEqual(stdout.bytes, expected, "every guest stdout byte reached the host verbatim");
  });

  it("sends exec_tty.stdin_eof on host EOF and resolves with the guest exit status", async () => {
    const { controller, backend, stdin } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();

    stdin.emitData("x");
    await until(() => backend.tty.writes.length === 1, "stdin write");
    stdin.emitEnd();
    await until(() => backend.tty.eofCalls === 1, "stdin eof");
    assert.equal(backend.tty.eofCalls, 1);

    backend.tty.resolve(7);
    const outcome = await runPromise;
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.cleanupConfirmed, true);
  });

  it("refuses to launch when a guest preparation command fails, and still tears the VM down", async () => {
    const { controller, backend } = makeHarness();
    backend.failPrepAtCommandIndex = 1;

    await assert.rejects(controller.run(), (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_GUEST_PREP_FAILED_CODE);
      return true;
    });
    assert.equal(backend.ttyCalls.length, 0, "no harness launched on failed prep");
    assert.deepEqual(backend.closeCalls, [30], "the created VM is still closed");
    assert.equal(backend.closed, true);
  });

  it("never claims success on an unconfirmed VM close and names the VM", async () => {
    const { controller, backend } = makeHarness();
    backend.closeError = new Error("close transport died");

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.cleanupConfirmed, false);
    assert.ok(
      typeof outcome.cleanupError === "string" && outcome.cleanupError.includes("vm-1"),
      "unconfirmed cleanup names the VM",
    );
    assert.equal(interactiveSessionSucceeded(outcome), false);
  });

  it("treats a close response that does not confirm the VM as unconfirmed", async () => {
    const { controller, backend } = makeHarness();
    backend.closeResolvesWithoutIsClosed = true;

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, false);
    assert.ok(outcome.cleanupError?.includes("vm-1"));
    assert.equal(interactiveSessionSucceeded(outcome), false);
  });

  it("cancels the in-flight exec_tty request and still confirms teardown", async () => {
    const { controller, backend } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    controller.cancel("test cancellation");
    await until(() => backend.cancelCalls.length === 1, "cancel dispatch");
    const outcome = await runPromise;

    assert.equal(outcome.cancelled, true);
    assert.deepEqual(backend.cancelCalls, [42]);
    assert.equal(outcome.cleanupConfirmed, true);
    assert.deepEqual(backend.closeCalls, [30]);
    assert.equal(interactiveSessionSucceeded(outcome), false, "a cancelled session is not a success");
  });

  it("launches zsh for a shell session and honours an explicit command override", async () => {
    const shellPlan = makePlan({ subcommand: "pi-shell", shell: true });
    const shellPrep = makePrep({ shell: true });
    const first = makeHarness(shellPlan, shellPrep);
    const firstRun = first.controller.run();
    await until(() => first.backend.ttyCalls.length === 1, "shell launch");
    assert.equal(first.backend.ttyCalls[0].cmd.command, "zsh");
    first.backend.tty.resolve(0);
    await firstRun;

    const overridden = makeHarness(makePlan(), makePrep(), { command: "/usr/local/bin/pi" });
    const secondRun = overridden.controller.run();
    await until(() => overridden.backend.ttyCalls.length === 1, "override launch");
    assert.equal(overridden.backend.ttyCalls[0].cmd.command, "/usr/local/bin/pi");
    overridden.backend.tty.resolve(0);
    await secondRun;
  });

  it("US-013: resolves the effective guest prep after create and uses it for prep + working dir", async () => {
    const backend = new FakeBackend();
    const basePrep = makePrep({ commands: [], env: { HOME: "/home/u1000" } });
    const resolvedPrep = makePrep({
      commands: [
        {
          id: "create_home",
          command: "install -d -m 0700 -o 1000 -g 1000 /home/u1000",
          target: "/home/u1000",
          privileged: true,
        },
      ],
      guestWorkingDirectory: "/work/resolved",
    });
    let resolverCalls = 0;
    let sawCreateBeforeResolve = false;
    const controller = new InteractiveSessionController(makePlan(), basePrep, {
      createBackend: () => backend,
      stdin: new FakeStdin(),
      stdout: new BufferSink(),
      terminal: new FakeTerminal(),
      terminalSize: () => ({ rows: 30, cols: 100 }),
      // CLEANUP-1 test isolation: this direct construction bypasses
      // makeHarness, so it injects its own owned no-op removal seam + owned
      // evidence root — no test may reach an ambient matchlock/HOME.
      removeVm: () => ({ vmId: "vm-1", removed: true, logsCopiedTo: null, removalExitCode: 0 }),
      removalEvidenceRoot: tmpDir("tamandua-interactive-removal-"),
      resolveGuestPrep: async () => {
        resolverCalls += 1;
        sawCreateBeforeResolve = backend.createCalls.length === 1;
        return resolvedPrep;
      },
    });

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    assert.equal(resolverCalls, 1, "the guest-prep resolver runs exactly once");
    assert.equal(sawCreateBeforeResolve, true, "the resolver runs AFTER the VM create");
    assert.deepEqual(
      backend.prepCommands,
      ["install -d -m 0700 -o 1000 -g 1000 /home/u1000"],
      "the resolved plan drives the preparation commands",
    );
    assert.equal(backend.ttyCalls[0].cmd.working_dir, "/work/resolved");

    backend.tty.resolve(0);
    const outcome = await runPromise;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.cleanupConfirmed, true);
  });

  it("runs exactly once; a second run is a typed refusal", async () => {
    const { controller, backend } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    await assert.rejects(controller.run(), (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_ALREADY_STARTED_CODE);
      return true;
    });
    backend.tty.resolve(0);
    await runPromise;
  });
});

describe("interactive session terminal + confirmed teardown (US-011)", () => {
  const TERMINAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGWINCH"];

  it("enables raw mode before launch and restores it once on success", async () => {
    const { controller, backend, terminal } = makeHarness();
    const runPromise = controller.run();
    assert.equal(terminal.rawEnabled, true, "raw mode enabled before the launch");
    assert.equal(terminal.rawEnableCalls, 1);
    assert.deepEqual(
      [...terminal.signalRegistrations].sort(),
      [...TERMINAL_SIGNALS].sort(),
      "all host signals are hooked",
    );

    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(terminal.restoreCalls, 1, "raw mode restored exactly once");
    assert.equal(terminal.rawEnabled, false);
    for (const signal of TERMINAL_SIGNALS) {
      assert.equal(terminal.handlerCount(signal), 0, `${signal} handler removed`);
    }
  });

  it("restores raw mode when a thrown error aborts the session", async () => {
    const { controller, backend, terminal } = makeHarness();
    backend.failPrepAtCommandIndex = 0;
    await assert.rejects(controller.run(), (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_GUEST_PREP_FAILED_CODE);
      return true;
    });
    assert.equal(terminal.restoreCalls, 1);
    assert.equal(terminal.rawEnabled, false);
    assert.equal(terminal.handlerCount("SIGINT"), 0);
  });

  it("forwards SIGWINCH as exec_tty.resize and Ctrl-C as input byte 0x03 without tearing down", async () => {
    let size = { rows: 30, cols: 100 };
    const { controller, backend, terminal } = makeHarness(makePlan(), makePrep(), {
      terminalSize: () => size,
    });
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();
    await until(() => backend.tty.resizeCalls.length === 0, "no resize yet");

    size = { rows: 50, cols: 140 };
    terminal.emit("SIGWINCH");
    await until(() => backend.tty.resizeCalls.length === 1, "resize forwarded");
    assert.deepEqual(backend.tty.resizeCalls[0], { rows: 50, cols: 140 });

    terminal.emit("SIGINT");
    await until(() => backend.tty.writes.length === 1, "ctrl-c forwarded");
    assert.deepEqual(backend.tty.writes[0], Buffer.from([0x03]));
    assert.deepEqual(backend.cancelCalls, [], "Ctrl-C never cancels or tears down");

    backend.tty.resolve(0);
    const outcome = await runPromise;
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(interactiveSessionSucceeded(outcome), true);
    assert.equal(terminal.restoreCalls, 1, "raw mode restored after the Ctrl-C session ends");
  });

  it("queues a pre-ready Ctrl-C and flushes it once exec_tty.ready arrives", async () => {
    const { controller, backend, terminal } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    terminal.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(backend.tty.writes.length, 0, "Ctrl-C queued before ready");

    backend.tty.emitReady();
    await until(() => backend.tty.writes.length === 1, "queued Ctrl-C flushed");
    assert.deepEqual(backend.tty.writes[0], Buffer.from([0x03]));
    backend.tty.resolve(0);
    await runPromise;
  });

  it("SIGTERM drives a bounded cancel-then-close teardown naming the VM", async () => {
    const { controller, backend, terminal } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    terminal.emit("SIGTERM");
    const outcome = await runPromise;

    assert.equal(outcome.cancelled, true);
    assert.deepEqual(backend.cancelCalls, [42], "in-flight exec_tty cancelled");
    assert.deepEqual(backend.closeCalls, [30], "positive close timeout");
    assert.ok(
      backend.events.indexOf("cancel") < backend.events.indexOf("close"),
      "cancel precedes close",
    );
    assert.equal(outcome.vmId, "vm-1");
    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(
      interactiveSessionSucceeded(outcome),
      false,
      "a terminated session is not a success",
    );
    assert.equal(terminal.restoreCalls, 1);
    assert.equal(terminal.rawEnabled, false);
  });

  it("SIGHUP and a terminal disconnect run the same bounded teardown", async () => {
    const hup = makeHarness();
    const hupRun = hup.controller.run();
    await until(() => hup.backend.ttyCalls.length === 1, "sighup launch");
    hup.terminal.emit("SIGHUP");
    const hupOutcome = await hupRun;
    assert.equal(hupOutcome.cancelled, true);
    assert.deepEqual(hup.backend.cancelCalls, [42]);
    assert.ok(hup.backend.events.indexOf("cancel") < hup.backend.events.indexOf("close"));
    assert.equal(hupOutcome.cleanupConfirmed, true);
    assert.equal(hup.terminal.restoreCalls, 1);

    const disc = makeHarness();
    const discRun = disc.controller.run();
    await until(() => disc.backend.ttyCalls.length === 1, "disconnect launch");
    disc.stdin.emitClose();
    const discOutcome = await discRun;
    assert.equal(discOutcome.cancelled, true);
    assert.deepEqual(disc.backend.cancelCalls, [42], "disconnect cancels the in-flight PTY");
    assert.ok(disc.backend.events.indexOf("cancel") < disc.backend.events.indexOf("close"));
    assert.equal(discOutcome.vmId, "vm-1");
    assert.equal(discOutcome.cleanupConfirmed, true);
    assert.equal(disc.terminal.restoreCalls, 1);
    assert.equal(disc.terminal.rawEnabled, false);
  });

  it("does not treat an EOF-then-close as a disconnect", async () => {
    const { controller, backend, stdin } = makeHarness();
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();

    stdin.emitEnd();
    await until(() => backend.tty.eofCalls === 1, "stdin eof");
    stdin.emitClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backend.cancelCalls, [], "close after EOF is not a disconnect");

    backend.tty.resolve(9);
    const outcome = await runPromise;
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exitCode, 9);
  });

  it("a SIGINT with no guest PTY yet is a harmless no-op", async () => {
    const { controller, backend, terminal } = makeHarness();
    const runPromise = controller.run();
    terminal.emit("SIGINT");
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.cleanupConfirmed, true);
    assert.deepEqual(backend.cancelCalls, []);
  });

  it("an unconfirmed close after external termination is a non-success naming the VM", async () => {
    const { controller, backend, terminal } = makeHarness();
    backend.closeResolvesWithoutIsClosed = true;
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");

    terminal.emit("SIGTERM");
    const outcome = await runPromise;
    assert.equal(outcome.cleanupConfirmed, false);
    assert.ok(outcome.cleanupError?.includes("vm-1"));
    assert.equal(interactiveSessionSucceeded(outcome), false);
    assert.equal(terminal.restoreCalls, 1);
  });
});

describe("interactive session failure propagation (D1/D2/D3) and cleanup diagnostics (D4)", () => {
  function makeRuntime(
    plan: Record<string, unknown>,
    prep: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      plan,
      createConfig: { image: "igorhvr/tamandua", vfs: { mounts: {} } },
      hostMountDestinations: [],
      prepInput: {},
      basePrep: prep,
      resolveGuestPrep: async () => prep,
    };
  }

  function startOrchestrated(
    plan: Record<string, unknown>,
    prep: Record<string, unknown>,
    backend: FakeBackend,
    stdin: FakeStdin,
    stdout: BufferSink,
    terminal: FakeTerminal,
  ): Promise<number> {
    return runInteractiveSession({} as never, {
      plan: async () => plan as never,
      buildRuntime: (p) => makeRuntime(p as unknown as Record<string, unknown>, prep) as never,
      controllerOptions: {
        createBackend: () => backend,
        stdin,
        stdout,
        terminal,
        terminalSize: () => ({ rows: 30, cols: 100 }),
        // CLEANUP-1 test isolation: an owned recorder (no ambient binary/HOME).
        removeVm: () => ({ vmId: "vm-1", removed: true, logsCopiedTo: null, removalExitCode: 0 }),
      },
      stdout: () => {},
      stderr: () => {},
    });
  }

  it("D1: an external SIGTERM maps to a non-zero public exit (never false success)", async () => {
    const backend = new FakeBackend();
    const terminal = new FakeTerminal();
    const runPromise = startOrchestrated(
      makePlan(),
      makePrep(),
      backend,
      new FakeStdin(),
      new BufferSink(),
      terminal,
    );
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    terminal.emit("SIGTERM");
    const code = await runPromise;

    assert.equal(code, 1, "a cancelled session must not be reported as exit 0");
    assert.deepEqual(backend.cancelCalls, [42], "the in-flight exec_tty must be cancelled");
    assert.ok(
      backend.events.indexOf("cancel") < backend.events.indexOf("close"),
      "cancel-before-close ordering",
    );
    assert.equal(backend.vmId, "vm-1");
    assert.equal(terminal.restoreCalls, 1, "raw mode restored exactly once");
  });

  it("D1 control: a normal guest exit 0 with confirmed cleanup stays success", async () => {
    const backend = new FakeBackend();
    const terminal = new FakeTerminal();
    const runPromise = startOrchestrated(
      makePlan(),
      makePrep(),
      backend,
      new FakeStdin(),
      new BufferSink(),
      terminal,
    );
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const code = await runPromise;

    assert.equal(code, 0, "a confirmed normal exit must stay success");
    assert.equal(terminal.restoreCalls, 1);
  });

  it("D2: a failed stdin write with guest exit 0 is a non-success carrying the original error and VM", async () => {
    const { controller, backend, stdin, terminal } = makeHarness();
    backend.tty.writeError = new Error("stdin write failed AUDIT_WRITE_FAILURE");
    const runPromise = controller.run();
    const rejection = assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_INPUT_FAILED_CODE);
      assert.match(err.message, /AUDIT_WRITE_FAILURE/, "the original I/O error is surfaced");
      assert.match(err.message, /vm-1/, "the VM is named");
      return true;
    });
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();
    stdin.emitData("payload");
    await new Promise((resolve) => setImmediate(resolve));
    backend.tty.resolve(0);

    await rejection;
    assert.equal(terminal.restoreCalls, 1);
    assert.deepEqual(backend.closeCalls, [30]);
  });

  it("D3: a failed stdin EOF with guest exit 0 is a non-success carrying the original error and VM", async () => {
    const { controller, backend, stdin, terminal } = makeHarness();
    backend.tty.eofError = new Error("stdin eof failed AUDIT_EOF_FAILURE");
    const runPromise = controller.run();
    const rejection = assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_INPUT_FAILED_CODE);
      assert.match(err.message, /AUDIT_EOF_FAILURE/, "the original EOF error is surfaced");
      assert.match(err.message, /vm-1/, "the VM is named");
      return true;
    });
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();
    stdin.emitEnd();
    await new Promise((resolve) => setImmediate(resolve));
    backend.tty.resolve(0);

    await rejection;
    assert.equal(terminal.restoreCalls, 1);
    assert.deepEqual(backend.closeCalls, [30]);
  });

  it("D2: an I/O failure with the guest result still pending tears down without any external signal", async () => {
    const { controller, backend, stdin, terminal } = makeHarness();
    backend.tty.writeError = new Error("stdin write fault AUDIT_PENDING");
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.emitReady();
    stdin.emitData("x");

    await assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.equal(err.code, INTERACTIVE_SESSION_INPUT_FAILED_CODE);
      assert.match(err.message, /AUDIT_PENDING/);
      return true;
    });
    assert.deepEqual(backend.cancelCalls, [42], "the still-pending exec is cancelled");
    assert.ok(
      backend.events.indexOf("cancel") < backend.events.indexOf("close"),
      "cancel-before-close ordering",
    );
    assert.deepEqual(backend.closeCalls, [30]);
    assert.equal(backend.closed, true, "the VM close is positively confirmed");
    assert.equal(terminal.restoreCalls, 1);
  });

  it("D4: a guest failure AND a failed close surface both errors, the VM and unconfirmed cleanup", async () => {
    const { controller, backend, terminal } = makeHarness();
    backend.vmId = "vm-audit-owned";
    backend.closeError = { code: -32000, message: "close confirmation fault" };
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.reject(new Error("guest transport fault AUDIT_GUEST"));

    await assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.match(err.message, /AUDIT_GUEST/, "the original guest failure is preserved");
      assert.match(err.message, /close confirmation fault/, "the JSON-RPC close body message is preserved (not [object Object])");
      assert.doesNotMatch(err.message, /\[object Object\]/);
      assert.match(err.message, /vm-audit-owned/, "the VM is named");
      assert.match(err.message, /NOT confirmed/, "cleanup is marked unconfirmed");
      return true;
    });
    assert.equal(terminal.restoreCalls, 1);
    assert.deepEqual(backend.closeCalls, [30]);
  });

  it("D4 control: a guest failure with a confirmed close is still non-success but reports confirmed cleanup", async () => {
    const { controller, backend } = makeHarness();
    backend.vmId = "vm-audit-owned";
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.reject(new Error("guest transport fault AUDIT_GUEST"));

    await assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.match(err.message, /AUDIT_GUEST/);
      assert.match(err.message, /cleanup for VM vm-audit-owned was confirmed/);
      return true;
    });
  });
});

// ── CLEANUP-1 (tamandua-me1): post-confirmed-close VM record removal ──

describe("CLEANUP-1: the interactive close path removes the session's own VM record", () => {
  function makeOwnedStore(): {
    root: string;
    home: string;
    evidenceRoot: string;
    ownedVm: string;
    sentinelVm: string;
    journal: string;
  } {
    const root = tmpDir("tamandua-interactive-clean1-");
    const home = path.join(root, "home");
    const evidenceRoot = path.join(root, "evidence");
    const ownedVm = "vm-cleanup-owned";
    const sentinelVm = "vm-cleanup-sentinel";
    fs.mkdirSync(path.join(home, ".matchlock", "vms", ownedVm, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, ".matchlock", "vms", ownedVm, "config.json"), JSON.stringify({ id: ownedVm }));
    fs.writeFileSync(path.join(home, ".matchlock", "vms", ownedVm, "logs", "guest.log"), "guest log\n");
    fs.mkdirSync(path.join(home, ".matchlock", "vms", sentinelVm), { recursive: true });
    const db = new DatabaseSync(path.join(home, ".matchlock", "state.db"));
    db.exec(
      "CREATE TABLE vms (id TEXT PRIMARY KEY, pid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, " +
        "image TEXT NOT NULL DEFAULT '', config_json BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    const now = new Date().toISOString();
    // Faithful post-close state: matchlock's close marks the row stopped
    // (it is the removal step under test that deletes row + dir).
    const insert = db.prepare("INSERT INTO vms (id, pid, status, image, created_at, updated_at) VALUES (?, 0, 'stopped', 'img', ?, ?)");
    insert.run(ownedVm, now, now);
    insert.run(sentinelVm, now, now);
    db.close();
    return {
      root,
      home,
      evidenceRoot,
      ownedVm,
      sentinelVm,
      journal: path.join(root, "rm-journal.jsonl"),
    };
  }

  function buildDirectController(
    store: ReturnType<typeof makeOwnedStore>,
    fakeCli: string,
    backend: FakeBackend,
    extra: Record<string, unknown> = {},
  ): InstanceType<typeof InteractiveSessionController> {
    return new InteractiveSessionController(makePlan(), makePrep(), {
      createBackend: () => backend,
      stdin: new FakeStdin(),
      stdout: new BufferSink(),
      terminal: new FakeTerminal(),
      terminalSize: () => ({ rows: 30, cols: 100 }),
      rpcBinaryPath: fakeCli,
      rpcEnv: { HOME: store.home },
      removalEvidenceRoot: store.evidenceRoot,
      ...extra,
    });
  }

  it("a confirmed close removes the VM row + state dir via the DEFAULT seam, keeping evidence and unrelated records", async () => {
    const store = makeOwnedStore();
    const fakeCli = writeFakeMatchlockRemovalCli({ journalPath: store.journal });
    const backend = new FakeBackend();
    backend.vmId = store.ownedVm;
    const controller = buildDirectController(store, fakeCli, backend);

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, true, "the close is still the authority");
    assert.equal(outcome.vmRemoved, true, "the confirmed close removed this session's VM record");

    // Evidence retained before removal, in the session's evidence root.
    const evidenceDir = path.join(store.evidenceRoot, store.ownedVm);
    assert.equal(outcome.vmLogsCopiedTo, evidenceDir, "evidence destination reported");
    assert.ok(fs.existsSync(path.join(evidenceDir, "config.json")), "config.json captured");
    assert.ok(fs.existsSync(path.join(evidenceDir, "logs", "guest.log")), "logs captured");

    // Record + state dir gone; the unrelated sentinel row/dir untouched.
    assert.equal(fs.existsSync(path.join(store.home, ".matchlock", "vms", store.ownedVm)), false, "owned state dir removed");
    const checkDb = new DatabaseSync(path.join(store.home, ".matchlock", "state.db"));
    const ownedCount = checkDb.prepare("SELECT COUNT(*) AS n FROM vms WHERE id = ?").get(store.ownedVm) as { n: number };
    const sentinelCount = checkDb.prepare("SELECT COUNT(*) AS n FROM vms WHERE id = ?").get(store.sentinelVm) as { n: number };
    checkDb.close();
    assert.equal(Number(ownedCount.n), 0, "owned VM row deleted");
    assert.equal(Number(sentinelCount.n), 1, "unrelated VM row untouched");
    assert.equal(fs.existsSync(path.join(store.home, ".matchlock", "vms", store.sentinelVm)), true, "unrelated state dir untouched");

    // Exact one removal invocation: `rm <vmId>` with the forced HOME.
    const entries = readRemovalJournal(store.journal);
    assert.equal(entries.length, 1, "exactly one removal invocation");
    assert.deepEqual(entries[0].argv, ["rm", store.ownedVm], "exact removal argv (no rpc args reuse)");
    assert.equal(entries[0].home, store.home, "HOME forced to the session's effective matchlock HOME");
    assert.equal(entries[0].stateDirExisted, true, "state dir existed at removal time");
  });

  it("an UNCONFIRMED close never attempts record removal", async () => {
    const { controller, backend, removals } = makeHarness();
    backend.closeError = new Error("close transport died");
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, false);
    assert.equal(outcome.vmRemoved, undefined, "no removal outcome on an unconfirmed close");
    assert.equal(removals.length, 0, "no removal was attempted");
  });

  it("a session whose create never returned removes nothing", async () => {
    const { controller, backend, removals } = makeHarness();
    backend.createError = new Error("create failed (fixture)");
    await assert.rejects(controller.run(), (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.match(err.message, /no VM was created/);
      return true;
    });
    assert.equal(removals.length, 0, "nothing to remove without an owned VM id");
    assert.equal(backend.disposeCalls, 1, "the never-created session disposes the transport");
    assert.deepEqual(backend.closeCalls, [], "no close without a VM");
  });

  it("a FAILED removal is reported and never changes the confirmed-close verdict", async () => {
    const store = makeOwnedStore();
    const fakeCli = writeFakeMatchlockRemovalCli({
      journalPath: store.journal,
      rmExit: 7,
      rmStderr: "rm refused by test wrapper",
    });
    const backend = new FakeBackend();
    backend.vmId = store.ownedVm;
    const controller = buildDirectController(store, fakeCli, backend);

    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, true, "the close verdict is unchanged by a removal failure");
    assert.equal(outcome.vmRemoved, false, "removal failure reported on the outcome");
    assert.match(outcome.vmRemovalError ?? "", /rm refused by test wrapper/, "bounded removal error surfaced");
    assert.equal(
      fs.existsSync(path.join(store.home, ".matchlock", "vms", store.ownedVm)),
      true,
      "the refused removal leaves the state dir in place",
    );
  });

  it("a THROWING removal seam is contained as reportable metadata", async () => {
    const { controller, backend } = makeHarness(makePlan(), makePrep(), {
      removeVm: () => {
        throw new Error("removal seam exploded AUDIT_REMOVAL_THROW");
      },
    });
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.resolve(0);
    const outcome = await runPromise;

    assert.equal(outcome.cleanupConfirmed, true, "the close verdict survives a throwing remover");
    assert.equal(outcome.vmRemoved, false);
    assert.match(outcome.vmRemovalError ?? "", /AUDIT_REMOVAL_THROW/);
  });

  it("a guest failure PLUS a failed removal reports BOTH (the primary error is never hidden)", async () => {
    const { controller, backend } = makeHarness(makePlan(), makePrep(), {
      removeVm: () => ({
        vmId: "vm-audit-owned",
        removed: false,
        logsCopiedTo: null,
        removalExitCode: 9,
        removalError: "removal fault AUDIT_REMOVE",
      }),
    });
    backend.vmId = "vm-audit-owned";
    const runPromise = controller.run();
    await until(() => backend.ttyCalls.length === 1, "exec_tty launch");
    backend.tty.reject(new Error("guest transport fault AUDIT_GUEST"));

    await assert.rejects(runPromise, (err: unknown) => {
      assert.ok(err instanceof InteractiveSessionError);
      assert.match(err.message, /AUDIT_GUEST/, "the original failure is preserved");
      assert.match(err.message, /cleanup for VM vm-audit-owned was confirmed/, "the close verdict is reported");
      assert.match(
        err.message,
        /vm-record removal for VM vm-audit-owned was NOT confirmed: removal fault AUDIT_REMOVE/,
        "the removal failure is reported alongside, not instead of",
      );
      return true;
    });
  });
});
