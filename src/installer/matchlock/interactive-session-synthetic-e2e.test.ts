/**
 * MTLK-INTERACTIVE US-014 — synthetic end-to-end interactive integration.
 *
 * Drives the REAL `tamandua matchlock` CLI dispatch end to end against a
 * TEST-OWNED fake matchlock RPC binary (the `fake-rpc-driver` script spawned as
 * `node <driver>`), with injected capability probes (the R8 swap handshake and
 * the host resource probe). One invocation exercises the whole pipeline:
 *
 *   parse -> root gate -> admission (`resolve_image`) -> create ->
 *   guest-facts probe (`exec_stream`) -> guest preparation ->
 *   PTY launch (`exec_tty`) -> terminal events (SIGWINCH resize + SIGINT
 *   Ctrl-C forwarding) -> confirmed `close` (`vm_closed`).
 *
 * No real VM is started, no model is called and no matchlock binary is invoked:
 * every transport is the fake driver and `TAMANDUA_MATCHLOCK_RPC_BIN` is pinned
 * to a non-existent sentinel so a path that ignored the injected binary would
 * fail closed instead of silently reaching the real runtime.
 *
 * Serial lane: the test reaches the child_process-owning RPC transport and
 * spawns the fake driver through the production code, so it is registered in
 * tests/serial-files.txt.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";

import { handleMatchlock } from "../../../dist/cli/commands/matchlock.js";
import { MATCHLOCK_RPC_BIN_ENV } from "../../../dist/installer/matchlock/allow-private-support.js";
import {
  tempTranscriptPath,
  writeFakeRpcDriver,
} from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import type { InteractiveSessionTerminalHooks } from "../../../dist/installer/matchlock/interactive-session.js";
import { MatchlockRootUsageError } from "../../../dist/installer/matchlock/root-gate.js";

// ── fixtures ─────────────────────────────────────────────────────────

/** Sentinel the real runtime would be at; it must NEVER be spawned. */
const REAL_MATCHLOCK_SENTINEL = "/nonexistent/real-matchlock-binary";

/** Every ambient key the synthetic driver consumes or the test pins. */
const MANAGED_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_IMAGE_PATH",
  "FAKE_TRANSCRIPT_FILE",
  "FAKE_RESOLVE_MISSING",
  "FAKE_EXEC_STDOUT",
  "FAKE_TTY_STDOUT",
  "FAKE_TTY_STDOUT_FRAMES",
  "FAKE_TTY_ECHO_STDIN",
  "FAKE_TTY_EXIT",
  "FAKE_TTY_NO_READY",
  "FAKE_TTY_WAIT_MS",
  "FAKE_TTY_DELAY_READY_MS",
  "FAKE_CLOSE_FAIL",
  "FAKE_CLOSE_ERROR_MESSAGE",
  "FAKE_CLOSE_DELAY_MS",
  "DECOY_LOG",
  MATCHLOCK_RPC_BIN_ENV,
] as const;

const savedEnv: Record<string, string | undefined> = {};
const ownedTempDirs: string[] = [];

let tmpRoot = "";
let driver = "";
let configRoot = "";
let workDir = "";

function makeHomeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), prefix));
  ownedTempDirs.push(dir);
  return dir;
}

/** Fresh transcript path and a clean transcript file for one invocation. */
function resetTranscript(): string {
  const transcript = tempTranscriptPath();
  ownedTempDirs.push(path.dirname(transcript));
  fs.rmSync(transcript, { force: true });
  return transcript;
}

/** Reset every managed ambient key, then apply the requested fake values. */
function primeEnv(values: Record<string, string | undefined>): void {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = configRoot;
  process.env.FAKE_IMAGE_TAG = "vic/ml:latest";
  process.env.FAKE_IMAGE_DIGEST = "sha256:e2e-digest";
  process.env.FAKE_IMAGE_CONFIG_DIGEST = "sha256:e2e-config-digest";
  process.env.FAKE_IMAGE_PATH = "/usr/local/bin:/usr/bin:/bin";
  process.env[MATCHLOCK_RPC_BIN_ENV] = REAL_MATCHLOCK_SENTINEL;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

before(() => {
  tmpRoot = makeHomeTemp(".mtlk-e2e-");
  driver = writeFakeRpcDriver({ dir: path.join(tmpRoot, "driver") });
  configRoot = path.join(tmpRoot, "pi-agent");
  workDir = path.join(tmpRoot, "work");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  for (const key of MANAGED_ENV_KEYS) savedEnv[key] = process.env[key];
});

after(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of ownedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── fake host terminal + host streams ────────────────────────────────

/** Owned terminal double: no real raw mode, no real process signal handlers. */
class FakeTerminal implements InteractiveSessionTerminalHooks {
  rawEnabled = 0;
  restored = 0;
  readonly handlers = new Map<string, () => void>();
  private readonly installedResolve: () => void;
  installed: Promise<void>;

  constructor() {
    let resolve!: () => void;
    this.installed = new Promise<void>((r) => {
      resolve = r;
    });
    this.installedResolve = resolve;
  }

  enableRawMode(): () => void {
    this.rawEnabled += 1;
    this.installedResolve();
    return () => {
      this.restored += 1;
    };
  }

  onSignal(signal: string, handler: () => void): () => void {
    this.handlers.set(signal, handler);
    return () => {
      this.handlers.delete(signal);
    };
  }

  fire(signal: string): void {
    this.handlers.get(signal)?.();
  }
}

interface SessionRun {
  promise: Promise<boolean>;
  terminal: FakeTerminal;
  stdin: PassThrough;
  stdout: PassThrough;
  guestBytes: () => Buffer;
  prelaunch: () => string;
  diagnostics: () => string;
  exits: number[];
}

/** Start one real CLI dispatch with every transport pointed at the fake driver. */
function startSession(
  argv: string[],
  opts: { euid?: number; readyTimeoutMs?: number; omitControllerRpc?: boolean } = {},
): SessionRun {
  const terminal = new FakeTerminal();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const guestChunks: Buffer[] = [];
  stdout.on("data", (chunk) => guestChunks.push(Buffer.from(chunk)));
  const prelaunch: string[] = [];
  const diagnostics: string[] = [];
  const exits: number[] = [];

  const promise = handleMatchlock("matchlock", argv, {
    cwd: workDir,
    env: {},
    hostProbe: { onlineCpus: () => 8, totalMemoryMB: () => 16384 },
    stdout: (text) => {
      prelaunch.push(text);
    },
    stderr: (text) => {
      diagnostics.push(text);
    },
    exit: (code) => {
      exits.push(code);
    },
    session: {
      planOptions: {
        env: {},
        euid: opts.euid ?? 1000,
        uid: 1000,
        gid: 1000,
        homeDir: path.join(tmpRoot, "submitter-home"),
        stdinIsTty: true,
        stdoutIsTty: true,
        // Injected R8 capability probe: never touch a real matchlock --help.
        swapSupportProbe: async (binaryPath: string) => ({ supported: true, binaryPath }),
        rpcBinaryPath: process.execPath,
        rpcArgs: [driver],
        admission: { home: os.homedir() },
      },
      controllerOptions: {
        // MTLK-RPC-BIN-SPLIT differential: when `omitControllerRpc` is set the
        // session must launch the binding the PLAN froze and admission bound —
        // no session-level binary/args are supplied at all.
        ...(opts.omitControllerRpc
          ? {}
          : { rpcBinaryPath: process.execPath, rpcArgs: [driver] }),
        admission: { home: os.homedir() },
        terminal,
        stdin,
        stdout,
        rows: 24,
        cols: 80,
        terminalSize: () => ({ rows: 30, cols: 100 }),
        requestTimeoutMs: 5_000,
        readyTimeoutMs: opts.readyTimeoutMs ?? 5_000,
        createTimeoutMs: 5_000,
        guestPrepTimeoutMs: 5_000,
      },
    },
  });

  return {
    promise,
    terminal,
    stdin,
    stdout,
    guestBytes: () => Buffer.concat(guestChunks),
    prelaunch: () => prelaunch.join(""),
    diagnostics: () => diagnostics.join(""),
    exits,
  };
}

// ── transcript helpers ───────────────────────────────────────────────

type TranscriptFrame = Record<string, unknown> & {
  method?: string;
  event?: string;
  params?: Record<string, unknown>;
  exit_code?: number;
};

function readTranscript(file: string): TranscriptFrame[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TranscriptFrame);
}

async function waitForTranscript(
  file: string,
  needle: string,
  timeoutMs = 15_000,
): Promise<TranscriptFrame[]> {
  const start = Date.now();
  for (;;) {
    const frames = readTranscript(file);
    if (frames.some((frame) => JSON.stringify(frame).includes(needle))) return frames;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for "${needle}" in ${file}; got ${JSON.stringify(frames)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function methodIndex(frames: TranscriptFrame[], method: string): number {
  return frames.findIndex((frame) => frame.method === method);
}

function eventIndex(frames: TranscriptFrame[], event: string): number {
  return frames.findIndex((frame) => frame.event === event);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── the synthetic end-to-end run ─────────────────────────────────────

describe("US-014: synthetic end-to-end interactive session", () => {
  it("drives parse, root gate, admission, guest prep, exec_tty, terminal events and confirmed cleanup", async () => {
    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/usr/bin/pi|755 1000 1000\n",
      FAKE_TTY_STDOUT: "guest-ready\n",
      FAKE_TTY_ECHO_STDIN: "1",
      FAKE_TTY_EXIT: "7",
      // Delay the close response so we can prove success is not reported
      // until the VM close is CONFIRMED on the wire.
      FAKE_CLOSE_DELAY_MS: "400",
    });

    const run = startSession(
      [
        "matchlock",
        "pi",
        "--working-directory-for-harness",
        workDir,
        "--matchlock-image",
        "vic/ml:latest",
        "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
      ],
      // Root invocation WITH the exact session override: exercises the root
      // gate's consent branch end to end.
      { euid: 0 },
    );

    // Raw mode is enabled BEFORE the guest exists; the fake terminal proves it.
    await run.terminal.installed;

    // Wait for the PTY to be ready, then drive real terminal events.
    await waitForTranscript(transcript, "tty_ready_sent");
    run.terminal.fire("SIGWINCH");
    run.terminal.fire("SIGINT");
    await waitForTranscript(transcript, "exec_tty.resize");
    await waitForTranscript(transcript, "exec_tty.stdin");

    // A normal host EOF (Ctrl-D): the guest finishes and the VM closes.
    run.stdin.end();

    let settled = false;
    void run.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitForTranscript(transcript, "tty_result_sent");
    assert.equal(
      settled,
      false,
      "the run must not report success until the VM close is confirmed",
    );

    assert.equal(await run.promise, true);

    const frames = readTranscript(transcript);
    const methods = frames
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === "string");

    // Full pipeline reached the wire, in order.
    assert.ok(methods.includes("resolve_image"), "admission must resolve the image");
    assert.ok(methods.includes("create"), "the VM must be created");
    assert.ok(methods.includes("exec_stream"), "guest preparation runs exec_stream");
    assert.ok(methods.includes("exec_tty"), "the harness launches over exec_tty");
    assert.ok(methods.includes("close"), "the VM is closed");
    assert.ok(eventIndex(frames, "vm_created") >= 0, "the fake runtime recorded the create");
    assert.ok(eventIndex(frames, "vm_closed") >= 0, "the fake runtime confirmed the close");
    assert.ok(
      eventIndex(frames, "vm_closed") > eventIndex(frames, "tty_result_sent"),
      "cleanup is confirmed AFTER the guest exits",
    );
    assert.ok(
      !frames.some((frame) => JSON.stringify(frame).includes("Method not found")),
      "no unsupported method reached the transport",
    );
    assert.ok(
      !frames.some((frame) => "error" in frame),
      `no transport error is expected: ${JSON.stringify(frames)}`,
    );

    // Admission is resolve-only; the VM create is issued by the controller.
    const firstCreate = methodIndex(frames, "create");
    assert.ok(
      methodIndex(frames, "resolve_image") < firstCreate,
      "the image is resolved before create",
    );

    // exec_tty launch parameters carry the numeric guest identity + dimensions.
    const tty = frames.find((frame) => frame.method === "exec_tty");
    assert.ok(tty, "an exec_tty request must be present");
    assert.equal(tty.params?.command, "pi");
    assert.equal(tty.params?.working_dir, workDir);
    assert.equal(tty.params?.user, "1000:1000");
    assert.equal(tty.params?.rows, 24);
    assert.equal(tty.params?.cols, 80);

    // SIGWINCH -> exec_tty.resize with the re-probed dimensions.
    const resize = frames.find((frame) => frame.method === "exec_tty.resize");
    assert.ok(resize, "SIGWINCH must forward exec_tty.resize");
    assert.equal(resize.params?.rows, 30);
    assert.equal(resize.params?.cols, 100);

    // SIGINT -> the raw Ctrl-C byte, byte-preserved through the PTY echo.
    const stdinFrame = frames.find((frame) => frame.method === "exec_tty.stdin");
    assert.equal(stdinFrame?.params?.data, Buffer.from([0x03]).toString("base64"));
    assert.ok(
      run.guestBytes().includes(0x03),
      "the forwarded Ctrl-C byte must reach the host stdout",
    );
    assert.equal(
      frames.filter((frame) => frame.method === "exec_tty.stdin_eof").length,
      1,
      "exactly one stdin_eof is sent for the normal host EOF",
    );

    // The launched process exit status is propagated as the CLI exit status.
    assert.ok(
      frames.some((frame) => frame.event === "tty_result_sent" && frame.exit_code === 7),
    );
    assert.deepEqual(run.exits, [7]);

    // Pre-launch UX: provenance, pinned digests, guest identity and mount scope.
    const prelaunch = run.prelaunch();
    assert.match(prelaunch, /matchlock: interactive pi session/);
    assert.match(prelaunch, /image provenance: explicit/);
    assert.match(prelaunch, /digest=sha256:e2e-digest/);
    assert.match(prelaunch, /guest identity: uid=1000 gid=1000/);
    // ICEBOX Pillar B: the additive guest-sudo line follows the identity line.
    assert.match(prelaunch, /guest sudo: passwordless for all users \(privileged VM\)/);
    assert.match(prelaunch, new RegExp(`rw ${escapeRegExp(workDir)}`));
    assert.match(run.diagnostics(), /Warning: .*root/i);

    // ICEBOX: the create frame itself carries the resolved isolation settings
    // (privileged ON + the explicit dns_priority default) — the wire contract
    // the shared composer owns, observed end to end.
    const createRequest = frames.find((frame) => frame.method === "create");
    assert.ok(createRequest, "a create frame must be present");
    assert.equal(createRequest.params?.privileged, true, "privileged ON by default on the wire");
    assert.equal(
      (createRequest.params?.network as Record<string, unknown> | undefined)?.dns_priority,
      "ipv4",
      "the resolved dns_priority is ALWAYS sent explicitly",
    );

    // Host terminal is restored exactly once.
    assert.equal(run.terminal.rawEnabled, 1);
    assert.equal(run.terminal.restored, 1);

    // No real matchlock: the sentinel does not exist and every transport used
    // the test-owned fake driver, which is the only writer of the transcript.
    assert.equal(process.env[MATCHLOCK_RPC_BIN_ENV], REAL_MATCHLOCK_SENTINEL);
    assert.equal(fs.existsSync(REAL_MATCHLOCK_SENTINEL), false);
    assert.ok(driver.endsWith(path.join("driver", "fake-matchlock-rpc.mjs")));
  });

  it("launches zsh for the shell variant and probes that binary as the selected user", async () => {
    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/bin/zsh|755 1000 1000\n",
      FAKE_TTY_STDOUT: "shell-ready\n",
      FAKE_TTY_EXIT: "0",
    });

    const run = startSession([
      "matchlock",
      "pi-shell",
      "--working-directory-for-harness",
      workDir,
      "--matchlock-image",
      "vic/ml:latest",
      "--matchlock-no-privileged",
      // IPv6 BEFORE IPv4 on purpose: the last argument must not be the
      // "winner" — the both-flags rule is ipv6-wins in EITHER order.
      "--matchlock-prioritize-ipv6-dns-resolution",
      "--matchlock-prioritize-ipv4-dns-resolution",
    ]);

    await run.terminal.installed;
    await waitForTranscript(transcript, "tty_ready_sent");
    run.stdin.end();

    assert.equal(await run.promise, true);
    const frames = readTranscript(transcript);
    const tty = frames.find((frame) => frame.method === "exec_tty");
    assert.equal(tty?.params?.command, "zsh", "the shell variant execs an image zsh");
    assert.ok(eventIndex(frames, "vm_closed") >= 0, "the shell VM close is confirmed");
    assert.match(run.prelaunch(), /run `pi` inside the shell to start the same session/);
    // ICEBOX: the opt-out + both-DNS-flags invocation reaches the create frame
    // with ipv6 winning (either order), and the banner reports the standard-VM
    // variant; explicit provenance means NO ` (standard image)` suffix.
    const createRequest = frames.find((frame) => frame.method === "create");
    assert.ok(createRequest, "a create frame must be present");
    assert.equal(createRequest.params?.privileged, false, "the opt-out reaches the create frame");
    assert.equal(
      (createRequest.params?.network as Record<string, unknown> | undefined)?.dns_priority,
      "ipv6",
      "both DNS flags => ipv6 wins on the wire regardless of order",
    );
    assert.match(run.prelaunch(), /guest sudo: blocked \(standard VM\)/);
    assert.doesNotMatch(run.prelaunch(), /\(standard image\)/);
    assert.deepEqual(run.exits, []);
    assert.equal(run.terminal.restored, 1);
  });

  it("refuses a root invocation before any matchlock interaction (ordering)", async () => {
    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/usr/bin/pi|755 1000 1000\n",
      FAKE_TTY_STDOUT: "guest-ready\n",
    });

    const run = startSession(
      [
        "matchlock",
        "pi",
        "--working-directory-for-harness",
        workDir,
        "--matchlock-image",
        "vic/ml:latest",
      ],
      { euid: 0 },
    );

    await assert.rejects(run.promise, (error: unknown) => {
      assert.ok(error instanceof MatchlockRootUsageError);
      assert.match((error as Error).message, /root/i);
      return true;
    });

    assert.equal(
      fs.existsSync(transcript),
      false,
      "the root gate must run before any matchlock RPC child is spawned",
    );
    assert.equal(run.terminal.rawEnabled, 0, "no terminal state is touched on refusal");
    assert.equal(run.prelaunch(), "", "nothing is printed before the gate passes");
    assert.deepEqual(run.exits, []);
  });

  it("D7: a guest that never emits exec_tty.ready fails within the readiness deadline and restores the terminal", async () => {
    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/usr/bin/pi|755 1000 1000\n",
      FAKE_TTY_NO_READY: "1",
      FAKE_TTY_WAIT_MS: "5000",
    });

    const run = startSession(
      [
        "matchlock",
        "pi",
        "--working-directory-for-harness",
        workDir,
        "--matchlock-image",
        "vic/ml:latest",
      ],
      { readyTimeoutMs: 50 },
    );
    await run.terminal.installed;
    await waitForTranscript(transcript, "tty_request");
    const requestedAt = Date.now();

    // Queue one input chunk and EOF: the readiness gate must hold BOTH.
    run.stdin.write("queued-pre-ready");
    run.stdin.end();

    await run.promise;
    const elapsed = Date.now() - requestedAt;
    assert.ok(
      elapsed < 300,
      `the readiness deadline must fire within the observation bound (took ${elapsed}ms)`,
    );
    assert.deepEqual(run.exits, [1], "a never-ready session is a public failure");

    const frames = readTranscript(transcript);
    assert.ok(frames.some((frame) => frame.method === "exec_tty"), "exec_tty was issued");
    assert.ok(frames.some((frame) => frame.method === "cancel"), "the in-flight exec was cancelled");
    assert.ok(frames.some((frame) => frame.method === "close"), "the VM was closed");
    assert.ok(
      methodIndex(frames, "cancel") < methodIndex(frames, "close"),
      "cancel precedes close",
    );
    assert.equal(
      frames.filter((frame) => frame.method === "exec_tty.stdin").length,
      0,
      "zero pre-ready stdin reaches the wire",
    );
    assert.equal(run.terminal.restored, 1, "raw mode restored exactly once");
  });

  it("D7 control: ready before the deadline with exact input bytes remains a success", async () => {
    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/usr/bin/pi|755 1000 1000\n",
      FAKE_TTY_DELAY_READY_MS: "10",
      FAKE_TTY_ECHO_STDIN: "1",
      FAKE_TTY_EXIT: "0",
    });

    const run = startSession(
      [
        "matchlock",
        "pi",
        "--working-directory-for-harness",
        workDir,
        "--matchlock-image",
        "vic/ml:latest",
      ],
      { readyTimeoutMs: 50 },
    );
    await run.terminal.installed;
    await waitForTranscript(transcript, "tty_ready_sent");
    run.stdin.write("AUDIT-BYTES");
    run.stdin.end();

    assert.equal(await run.promise, true);
    assert.deepEqual(run.exits, [], "a confirmed normal exit 0 is not a failure");

    const frames = readTranscript(transcript);
    const stdinFrames = frames.filter((frame) => frame.method === "exec_tty.stdin");
    assert.ok(stdinFrames.length >= 1, "host input reached the wire after ready");
    assert.equal(
      stdinFrames[0].params?.data,
      Buffer.from("AUDIT-BYTES").toString("base64"),
      "exact input bytes are preserved",
    );
    assert.ok(run.guestBytes().toString("utf8").includes("AUDIT-BYTES"));
    assert.equal(run.terminal.restored, 1);
  });

  // MTLK-RPC-BIN-SPLIT (tamandua-dwl) DIFFERENTIAL. The original defect: the
  // session transport re-resolved the matchlock executable from the ambient
  // environment instead of launching the invocation the plan probed and
  // admission bound. Here NO session-level rpc binary/args are supplied at all
  // and the ambient override points at a decoy executable that records every
  // launch: only a transport that uses the plan's frozen binding can complete
  // the run through the admitted fake driver — a regression to environment
  // fallback lands on the decoy (and fails).
  it("launches ONLY the admitted binding when no session-level rpc options exist (environment fallback decoy must never run)", async () => {
    const decoyDir = makeHomeTemp(".mtlk-decoy-");
    const decoyPath = path.join(decoyDir, "matchlock");
    const decoyLog = path.join(decoyDir, "decoy-launches.log");
    fs.writeFileSync(
      decoyPath,
      `#!/bin/sh\necho "decoy launched: $*" >> "${decoyLog}"\nexit 1\n`,
    );
    fs.chmodSync(decoyPath, 0o755);

    const transcript = resetTranscript();
    primeEnv({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_EXEC_STDOUT: "passwd=0\ngroup=0\nbin=/usr/bin/pi|755 1000 1000\n",
      FAKE_TTY_EXIT: "0",
      // The fallback trap: any code path that re-resolves the rpc binary from
      // the environment (instead of the plan's frozen binding) can only find
      // this decoy.
      [MATCHLOCK_RPC_BIN_ENV]: decoyPath,
      DECOY_LOG: decoyLog,
    });

    // Trap BOTH fallback routes: the environment override set above AND PATH
    // (some fallback branches resolve the bare `matchlock` name through PATH).
    const savedPath = process.env.PATH;
    process.env.PATH = `${decoyDir}:${savedPath ?? ""}`;
    try {
      const run = startSession(
        [
          "matchlock",
          "pi",
          "--working-directory-for-harness",
          workDir,
          "--matchlock-image",
          "vic/ml:latest",
        ],
        { omitControllerRpc: true },
      );
      // Bounded readiness: if the session settles FIRST — the fallback decoy
      // was taken and the transport died, or any other early outcome — this
      // differential must surface that outcome instead of hanging forever;
      // and a session that stays stuck (neither ready nor settled) fails at a
      // wall-clock deadline instead of blocking the suite.
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
        readinessTimer = setTimeout(() => resolve({ kind: "deadline" }), 30_000);
      });
      // A no-op handler so a late rejection from a timed-out run is never an
      // unhandled rejection; the real await below still sees the rejection.
      void run.promise.catch(() => {});
      let readiness:
        | { kind: "ready" }
        | { kind: "settled"; result: boolean }
        | { kind: "rejected"; error: unknown }
        | { kind: "deadline" };
      try {
        readiness = await Promise.race([
          run.terminal.installed.then(() => ({ kind: "ready" as const })),
          run.promise.then(
            (result: boolean) => ({ kind: "settled" as const, result }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          ),
          deadline,
        ]);
      } finally {
        if (readinessTimer) clearTimeout(readinessTimer);
      }
      if (readiness.kind === "deadline") {
        // Unblock the owned transport before failing so the regression leaves
        // no wedged work behind.
        run.stdin.end();
        await Promise.race([run.promise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        throw new Error("differential: session never became ready within 30s");
      }
      if (readiness.kind === "settled") {
        throw new Error(
          `session settled before installing the terminal (result=${String(readiness.result)})`,
        );
      }
      if (readiness.kind === "rejected") throw readiness.error;
      await waitForTranscript(transcript, "tty_ready_sent");
      run.stdin.end();

      assert.equal(
        await run.promise,
        true,
        "the session completes through the admitted fake transport",
      );
      assert.equal(
        fs.existsSync(decoyLog),
        false,
        `the environment/PATH fallback decoy was never launched (${
          fs.existsSync(decoyLog) ? fs.readFileSync(decoyLog, "utf8") : "no decoy log"
        })`,
      );

      const frames = readTranscript(transcript);
      const methods = frames
        .map((frame) => frame.method)
        .filter((method): method is string => typeof method === "string");
      assert.ok(methods.includes("resolve_image"), "admission resolved the image");
      assert.ok(methods.includes("create"), "the VM was created");
      assert.ok(methods.includes("exec_tty"), "the harness launched over the admitted binding");
      assert.ok(methods.includes("close"), "the VM was closed");
      assert.deepEqual(run.exits, [], "no failure exit was requested");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});
