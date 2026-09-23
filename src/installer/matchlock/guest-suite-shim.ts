/**
 * MTLK guest suite: portable guest test-shim engine.
 *
 * A self-contained, transport-injected port of the native tamandua-test
 * content-addressed suite shim (src/suite/shim.ts) that runs INSIDE the
 * Matchlock guest. Hard rules preserved from the native contract:
 *
 *   - the reviewed command is ALWAYS executed guest-locally via
 *     `/bin/sh -c "<cmdString>"` with the exact command-string semantics,
 *     cwd, shell prefixes/quotes/pipes intact; a command is NEVER forwarded
 *     to the host as a bridge request
 *   - stdout/stderr stay separate and stream through untouched (raw bytes);
 *     only a BOUNDED tail is retained for the ledger record (the native
 *     unbounded `captured += ...` accumulation is not copied)
 *   - exit status is preserved; tracked-dirty refusal is 88 and happens
 *     BEFORE any transport work even when the transport is unavailable;
 *     tree drift during a green run is 86 with the original cause preserved;
 *     catchable interruption (SIGHUP/SIGINT/SIGQUIT/SIGTERM) is 87
 *   - untracked artifacts never affect ledger evidence; the command hash is
 *     the SHA-256 of the exact raw command string and is NEVER decorated with
 *     environment data
 *   - single-flight claim/release is exact-token based, with waiter polling,
 *     waiter promotion and re-key/recheck semantics
 *   - a transport outage or a refused/malformed/wrong-namespace response
 *     NEVER records or replays a false green: the engine degrades to real
 *     guest execution with an explicit warning and incomplete evidence (no
 *     required merge gate is satisfied by a passthrough)
 *   - without a host-attested environment namespace the engine trusts NO
 *     ledger result and degrades to real execution (component rule: scope
 *     binding is host-supplied input, not freely asserted guest authority)
 *
 * All timers/buffers are bounded and poll timers stay REFERENCED (native
 * parity), so a standalone guest entry parked in a waiter poll cannot have
 * its event loop drain to a silent exit 0 mid-poll; every transport request
 * carries a finite deadline. cmd_display is clamped by real UTF-8 bytes
 * (clampDisplayBytes), never by a code-unit slice that can exceed the bound.
 * Node-core only — safe for the portable RO guest pack closure.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  CLAIM_TIMEOUT_MS as NATIVE_CLAIM_TIMEOUT_MS,
  CMD_DISPLAY_MAX_BYTES,
  DEFAULT_SUITE_REQUEST_TIMEOUT_MS,
  GUEST_SUITE_TRANSPORT_VERSION,
  MAX_SUITE_REQUEST_TIMEOUT_MS,
  RED_CONTEXT_WINDOW_MS as NATIVE_RED_CONTEXT_WINDOW_MS,
  SINGLEFLIGHT_POLL_INTERVAL_MS as NATIVE_SINGLEFLIGHT_POLL_INTERVAL_MS,
  TTL_GREEN_MS as NATIVE_TTL_GREEN_MS,
  isPermittedSuiteEvent,
  normalizeGuestSuiteNamespace,
  guestSuiteNamespaceId,
  type GuestSuiteLatestRow,
  type GuestSuiteLookupResult,
  type GuestSuiteNamespace,
  type GuestSuiteTransport,
} from "./guest-suite-contract.js";
import {
  committedTreeHash,
  computeCmdHash,
  formatTrackedDirtyList,
  getOriginRepo,
  getTrackedDirtyPaths,
  trackedTreeHash,
} from "./guest-suite-git.js";
import { parseSuiteWireInstant } from "./guest-protocol.js";

// ── Native parity constants ───────────────────────────────────────────

/** Dedicated fail-closed exit when a passing command cannot be attributed. */
export const TREE_DRIFT_EXIT_CODE = 86;
/** Dedicated red-ledger exit for executions interrupted by a caller signal. */
export const INTERRUPTED_EXIT_CODE = 87;
/** Dedicated refusal when tracked files are already dirty before testing. */
export const TREE_DIRTY_EXIT_CODE = 88;

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];

// ── I/O surface (injected; entry binds it to the real process) ─────────

export interface GuestSuiteShimIo {
  /**
   * Working directory for every spawned /bin/sh -c child (both passthrough
   * and recording paths) and for the engine's own relative --repo
   * resolution. The process entry binds this to process.cwd(); an injected
   * io (tests / later integration) controls where guest commands execute.
   */
  cwd: string;
  envGet: (name: string) => string | undefined;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /** Raw-byte forwarding hooks; when provided, child output is written raw. */
  writeOutRaw?: (chunk: Buffer) => void;
  writeErrRaw?: (chunk: Buffer) => void;
}

/** Engine tunables (defaults are the native constants). */
export interface GuestSuiteShimOptions {
  /** Finite per-op transport deadline (native control-client default 1500ms). */
  requestTimeoutMs?: number;
  /** Single-flight poll cadence. */
  singleflightPollIntervalMs?: number;
  /** Single-flight claim timeout — how long a waiter polls before executing. */
  claimTimeoutMs?: number;
  /** Green-TTL window. */
  ttlGreenMs?: number;
  /** Red context window. */
  redContextWindowMs?: number;
  /** Host-supplied invocation identity bound to the exact claim token. */
  invocationId?: string;
  /** Injectable clock (ms epoch) for age computations. */
  now?: () => number;
}

export interface GuestSuiteShimDeps {
  /** Typed suite transport. May be a fake in tests, the wired adapter later. */
  transport: GuestSuiteTransport;
  /**
   * Host-attested environment namespace. Null means the invocation is not
   * environment-qualified: no ledger result is trusted and the command runs
   * for real with an explicit warning.
   */
  namespace: GuestSuiteNamespace | null;
  options?: GuestSuiteShimOptions;
}

export interface GuestSuiteShimResult {
  exitCode: number;
}

// ── Argument parsing (native exact shape) ─────────────────────────────

export interface ParsedGuestSuiteArgs {
  repo: string;
  runId: string;
  stepId: string;
  force: boolean;
  cmdArgs: string[];
  cmdString: string;
}

export function parseGuestSuiteArgs(argv: string[]): ParsedGuestSuiteArgs {
  let repo = "";
  let runId = "";
  let stepId = "";
  let force = false;
  let separatorIdx = -1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      separatorIdx = i;
      break;
    }
    if ((arg === "--repo" || arg === "-r") && i + 1 < argv.length) {
      repo = argv[++i];
      continue;
    }
    if ((arg === "--run" || arg === "-R") && i + 1 < argv.length) {
      runId = argv[++i];
      continue;
    }
    if ((arg === "--step" || arg === "-s") && i + 1 < argv.length) {
      stepId = argv[++i];
      continue;
    }
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
  }

  const cmdArgs = separatorIdx >= 0 ? argv.slice(separatorIdx + 1) : [];
  const cmdString = cmdArgs.join(" ");
  return { repo, runId, stepId, force, cmdArgs, cmdString };
}

/**
 * True when the argv requests help BEFORE the `--` command separator.
 * Mirrors native parseArgs value consumption: a token consumed as the value
 * of --repo/-r/--run/-R/--step/-s is NEVER treated as a help flag, so
 * `--repo -h -- echo x` means repo value "-h" (→ native "--repo path not
 * found: -h" passthrough), not help.
 */
export function wantsGuestSuiteHelp(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return false; // a `--help` after `--` is a command argument
    if (
      (arg === "--repo" || arg === "-r" || arg === "--run" || arg === "-R" || arg === "--step" || arg === "-s")
      && i + 1 < argv.length
    ) {
      i += 1; // consume the option's value even when it looks like a flag
      continue;
    }
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/**
 * Byte-aware display truncation: keeps at most `maxBytes` UTF-8 bytes of
 * `text`, never splitting a code point. Native slices by JS code units, so a
 * multibyte command can exceed the display bound; the guest engine clamps by
 * real bytes so cmd_display is a genuine bounded field and the transport's
 * OVERSIZED refusal is only a second line of defense, never the enforcement.
 */
export function clampDisplayBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  // Longest code-unit prefix whose UTF-8 byte length is ≤ maxBytes
  // (byteLength(prefix) is monotone in code-unit count → binary search).
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  // Never split a surrogate pair: back off over a trailing high surrogate.
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

export const GUEST_SUITE_HELP = `Usage: tamandua-test --repo <path> --run <id> --step <id> [--force] -- <command...>

Options:
  --repo, -r   Path to the git repository (required for caching)
  --run, -R    Run ID for ledger attribution
  --step, -s   Step ID for ledger attribution
  --force, -f  Force execution even when a fresh green cache entry exists
  --help, -h   Show this help

Environment:
  TAMANDUA_TSTX=0   Disable caching entirely (full passthrough)

A content-addressed test-suite ledger that skips re-execution of test
commands against byte-identical working trees, replaying the recorded
result instead. Strictly monotone: degrades to passthrough on any doubt.
Results are recorded only when tracked repository content stays unchanged
through process exit. Tree drift requires a stable-tree rerun and makes an
otherwise passing command exit ${TREE_DRIFT_EXIT_CODE}.
Uncommitted tracked changes are refused before lookup or execution with exit
${TREE_DIRTY_EXIT_CODE}; untracked artifacts do not affect ledger evidence.
Executions interrupted by SIGHUP, SIGINT, SIGQUIT, or SIGTERM terminate their
child process, record red evidence, and exit ${INTERRUPTED_EXIT_CODE}.

Exit codes 86, 87, 88 are meaningful only when accompanied by this shim's
own stderr message. A test command's own 86, 87, or 88 exit code is passed
through verbatim.

Matchlock guest notes:
  The reviewed command ALWAYS runs inside this guest via /bin/sh -c with the
  exact command string, cwd and shell semantics; it is never executed on the
  host. stdout/stderr pass through unmodified. Ledger records/cache keys are
  scoped to the host-attested environment namespace (immutable image content,
  guest platform, helper contract and a bounded nonsecret compatibility
  fingerprint) supplied to this invocation; without that attested namespace
  no cached result is trusted and the real command runs with a warning.
  A transport outage or refusal degrades to real execution with explicit
  incomplete evidence — never a recorded or replayed green.
`;

// ── Passthrough / capture helpers ─────────────────────────────────────

function rawOut(io: GuestSuiteShimIo): (chunk: Buffer) => void {
  return io.writeOutRaw ?? ((chunk: Buffer) => io.writeOut(chunk.toString()));
}

function rawErr(io: GuestSuiteShimIo): (chunk: Buffer) => void {
  return io.writeErrRaw ?? ((chunk: Buffer) => io.writeErr(chunk.toString()));
}

function passthroughNotice(io: GuestSuiteShimIo, reason: string): void {
  io.writeErr(`tamandua-test: passthrough mode — ${reason}\n`);
}

/**
 * Real guest-local execution with the exact command string via /bin/sh -c.
 * stdin is inherited (native passthrough); stdout/stderr are piped and
 * forwarded byte-for-byte through the io raw hooks so passthrough output is
 * indistinguishable from the raw command except the single stderr notice.
 */
function passthroughExec(cmdString: string, io: GuestSuiteShimIo): Promise<number> {
  if (cmdString.length === 0) {
    io.writeErr("tamandua-test: error: no command to run\n");
    return Promise.resolve(1);
  }
  return new Promise<number>((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmdString], {
      cwd: io.cwd,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => rawOut(io)(chunk));
    child.stderr?.on("data", (chunk: Buffer) => rawErr(io)(chunk));
    child.on("error", (err: Error) => {
      io.writeErr(`tamandua-test: failed to spawn command: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });
}

/** Bounded rolling tail: never retains more than `limit` bytes of stream. */
class BoundedTail {
  private chunks: Buffer[] = [];
  private retained = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.retained += chunk.byteLength;
    while (this.retained > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.byteLength <= this.retained - this.limit) {
        this.retained -= first.byteLength;
        this.chunks.shift();
      } else {
        const drop = this.retained - this.limit;
        this.chunks[0] = first.subarray(drop);
        this.retained -= drop;
      }
    }
  }

  /** True when streamed content ever exceeded the limit. */
  hasExceeded(): boolean {
    return this.retained >= this.limit;
  }

  /** Retained tail as a single buffer (≤ limit bytes). */
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ExecuteOutcome {
  exitCode: number;
  durationMs: number;
  tail: string;
  interruptedBy: NodeJS.Signals | null;
}

/**
 * Run the command via /bin/sh -c, streaming stdout/stderr through untouched
 * (raw bytes, separate streams) while retaining only a bounded tail for the
 * ledger record. Forwarded caller signals terminate the whole detached child
 * process group and resolve with interruption evidence (native semantics).
 * The caller keeps the returned ChildProcess handle; no stale PID is used
 * after the child exits. Signal listeners stay installed until `cleanup()` is
 * called (native keeps them through ledger finalization so a duplicate
 * timeout signal cannot race the pending record), and every run MUST call
 * cleanup exactly once after the outcome settles.
 */
export function executeGuestSuiteCommand(
  cmdString: string,
  io: GuestSuiteShimIo,
  opts: { logTailBytes?: number; now?: () => number } = {},
): { outcome: Promise<ExecuteOutcome>; child: ChildProcess; cleanup: () => void } {
  const limit = opts.logTailBytes ?? 20 * 1024;
  const startedAt = (opts.now ?? Date.now)();
  const tailOut = new BoundedTail(limit);
  const tailErr = new BoundedTail(limit);
  const child: ChildProcess = spawn("/bin/sh", ["-c", cmdString], {
    cwd: io.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Give the shell and its descendants a process group so timeout signals
    // forwarded to the shim terminate the whole suite (native behavior).
    detached: process.platform !== "win32",
  });
  let interruptedBy: NodeJS.Signals | null = null;
  let completed = false;

  let resolveOutcome!: (value: ExecuteOutcome) => void;
  const outcome = new Promise<ExecuteOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const finish = (exitCode: number): void => {
    if (completed) return;
    completed = true;
    // Streams stay separate on the way out; the record tail is stdout then
    // stderr, and stderr interruption evidence is appended on the stderr
    // side. Native keeps its signal handlers through ledger finalization;
    // removal is the caller's cleanup() obligation (see doc comment).
    const outBuf = tailOut.buffer();
    const errBuf = tailErr.buffer();
    const combined = Buffer.concat([outBuf, errBuf]);
    const tailText = combined.byteLength > limit
      ? combined.subarray(combined.byteLength - limit).toString("utf-8")
      : combined.toString("utf-8");
    resolveOutcome({
      exitCode,
      durationMs: ((opts.now ?? Date.now)() - startedAt),
      tail: tailText,
      interruptedBy,
    });
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (completed || interruptedBy !== null) return;
    interruptedBy = signal;
    const evidence =
      `tamandua-test: suite KILLED by external ${signal} - this means the caller's command timeout or external signal terminated the suite before it finished. This attempt produced NO USABLE EVIDENCE; the suite must run to completion for results to be recorded in the evidence ledger.\n`;
    io.writeErr(evidence);
    tailErr.push(Buffer.from(evidence, "utf-8"));
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Child may already be gone; its close event still completes exactly once.
    }
  };

  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, onSignal);
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    rawOut(io)(chunk);
    tailOut.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    rawErr(io)(chunk);
    tailErr.push(chunk);
  });
  child.on("error", (err: Error) => {
    const evidence = `tamandua-test: failed to spawn command: ${err.message}`;
    io.writeErr(`${evidence}\n`);
    tailErr.push(Buffer.from(`${evidence}\n`, "utf-8"));
    finish(interruptedBy === null ? 1 : INTERRUPTED_EXIT_CODE);
  });
  child.on("close", (code: number | null) => {
    finish(interruptedBy === null ? (code ?? 1) : INTERRUPTED_EXIT_CODE);
  });

  const cleanup = (): void => {
    for (const signal of FORWARDED_SIGNALS) {
      process.removeListener(signal, onSignal);
    }
  };

  return { outcome, child, cleanup };
}

function sleep(ms: number): Promise<void> {
  // Referenced timer (native parity): the timer is NOT unref'd, so a
  // standalone guest entry parked in a single-flight waiter poll keeps the
  // event loop alive until the bounded poll deadline — an unref'd timer would
  // let Node drain the loop mid-poll and exit 0 with no suite result (silent
  // phantom pass) whenever the transport holds no referenced handle.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Shared engine context & helpers ───────────────────────────────────

export interface GuestSuiteShimContext {
  io: GuestSuiteShimIo;
  transport: GuestSuiteTransport;
  namespace: GuestSuiteNamespace;
  namespaceId: string;
  repoReal: string;
  runId: string;
  stepId: string;
  force: boolean;
  ownerToken: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  claimTimeoutMs: number;
  ttlGreenMs: number;
  redContextWindowMs: number;
  invocationId?: string;
  now: () => number;
  cmdString: string;
  cmdDisplay: string;
  cmdHash: string;
  originRepo: string;
  /** Current committed-tree ledger hash (re-keyed during the flow). */
  treeHash: string;
  /** Junk-probe special-exit instrumentation (native test-hook parity). */
  junkProbePath?: string;
  junkProbeTracked: () => boolean;
}

/**
 * Emit a permitted suite event best-effort. Non-permitted events are refused
 * locally (never sent) — the transport allowlist is mirrored here.
 */
async function emitSuiteEvent(
  ctx: GuestSuiteShimContext,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!isPermittedSuiteEvent(event)) return;
  await ctx.transport.emitEvent(
    {
      namespace: ctx.namespace,
      event,
      runId: ctx.runId,
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      fields,
    },
    ctx.requestTimeoutMs,
  ).catch(() => undefined);
}

function fmtAge(nowMs: number, createdAt: string): number {
  // Host-supplied ledger instant: parse it in-pack, pinning a zone-less value
  // to UTC. An unreadable value stays NaN, which every caller treats as "no
  // replay / no red note".
  const t = parseSuiteWireInstant(createdAt);
  return t === undefined ? NaN : nowMs - t;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function printFlakyBanner(io: GuestSuiteShimIo, passCount: number, failCount: number): void {
  const total = passCount + failCount;
  io.writeErr(
    `⚠ FLAKY: identical tree produced ${passCount} passes / ${failCount} failures in last 24h (${total} total runs)\n`,
  );
}

function printRedContextNote(
  io: GuestSuiteShimIo,
  latest: GuestSuiteLatestRow,
  cmdDisplay: string,
  ageMs: number,
): void {
  const minutesAgo = Math.max(1, Math.round(ageMs / 60_000));
  const runId = latest.run_id ?? "?";
  const stepId = latest.step_id ?? "?";
  io.writeErr(
    `note: this tree failed ${cmdDisplay} ${minutesAgo}m ago (run #${runId}, step ${stepId}) — rerunning\n`,
  );
}

function replay(
  io: GuestSuiteShimIo,
  latest: GuestSuiteLatestRow,
  cmdDisplay: string,
  ageMs: number,
): void {
  const treeHashShort = String(latest.tree_hash ?? "").slice(0, 12);
  const runId = latest.run_id ?? "?";
  const stepId = latest.step_id ?? "?";
  const duration = typeof latest.duration_ms === "number"
    ? (latest.duration_ms / 1000).toFixed(1)
    : "?";
  const logTail = typeof latest.log_tail === "string" ? latest.log_tail : "";
  io.writeOut(
    `TAMANDUA-TEST CACHED: tree ${treeHashShort} passed ${cmdDisplay} ${formatAge(ageMs)} ago (run #${runId}, step ${stepId}, exit 0, ${duration}s)\n`,
  );
  const tailKB = logTail.length > 0 ? Math.ceil(logTail.length / 1024) : 0;
  io.writeOut(`--- recorded output (last ${tailKB}KB) ---\n`);
  if (logTail) io.writeOut(logTail);
}

/** Print the dirty refusal exactly like the native FAILURE_CLASS block. */
function writeDirtyRefusal(io: GuestSuiteShimIo, dirtyPaths: string[]): void {
  io.writeErr(
    `FAILURE_CLASS: tree_dirty\n`
    + `FAILURE: uncommitted changes to tracked files — commit them before testing\n`
    + `(the merge gate verifies the committed tree: git rev-parse HEAD^{tree}).\n`
    + `${formatTrackedDirtyList(dirtyPaths, 32)}\n`
    + `ACTION: commit or discard these, then re-run the suite via the shim.\n`,
  );
}

// ── Main engine ───────────────────────────────────────────────────────

/**
 * Run the guest suite shim once. Returns the process exit code. The reviewed
 * command runs only guest-locally; every ledger mutation happens through the
 * injected typed transport.
 */
export async function runGuestSuiteShim(
  argv: string[],
  io: GuestSuiteShimIo,
  deps: GuestSuiteShimDeps,
): Promise<GuestSuiteShimResult> {
  const opts = deps.options ?? {};
  const requestTimeoutMs = Math.min(
    opts.requestTimeoutMs ?? DEFAULT_SUITE_REQUEST_TIMEOUT_MS,
    MAX_SUITE_REQUEST_TIMEOUT_MS,
  );
  const pollIntervalMs = opts.singleflightPollIntervalMs ?? NATIVE_SINGLEFLIGHT_POLL_INTERVAL_MS;
  const claimTimeoutMs = opts.claimTimeoutMs ?? NATIVE_CLAIM_TIMEOUT_MS;
  const ttlGreenMs = opts.ttlGreenMs ?? NATIVE_TTL_GREEN_MS;
  const redContextWindowMs = opts.redContextWindowMs ?? NATIVE_RED_CONTEXT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const logTailBytes = 20 * 1024;

  const parsed = parseGuestSuiteArgs(argv);
  const cmdString = parsed.cmdString;

  // --help / -h before `--`: native prints help to stderr and exits 0.
  if (wantsGuestSuiteHelp(argv)) {
    io.writeErr(GUEST_SUITE_HELP);
    return { exitCode: 0 };
  }

  // TAMANDUA_TSTX=0 — full guest-local passthrough (native kill switch).
  if ((io.envGet("TAMANDUA_TSTX") ?? "") === "0") {
    passthroughNotice(io, "TAMANDUA_TSTX=0 kill switch active");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }

  // No command → native error.
  if (parsed.cmdArgs.length === 0) {
    io.writeErr("tamandua-test: error: no test command provided (use -- to separate args)\n");
    return { exitCode: 1 };
  }

  // No repo → native passthrough.
  if (!parsed.repo) {
    passthroughNotice(io, "no --repo specified");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }

  // Resolve the repo; missing path → native passthrough.
  let repoReal: string;
  try {
    repoReal = realpathSync(parsed.repo);
  } catch {
    passthroughNotice(io, `--repo path not found: ${parsed.repo}`);
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }

  // Native R3: hashing failure → passthrough.
  let preTreeHash = committedTreeHash(repoReal);
  if (preTreeHash === null) {
    passthroughNotice(io, "git tree hash failed (non-git directory or git error)");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }
  if (trackedTreeHash(repoReal) === null) {
    passthroughNotice(io, "git tracked tree hash failed (non-git directory or git error)");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }

  const cmdHash = computeCmdHash(cmdString);
  const originRepo = getOriginRepo(repoReal);
  const ownerToken = randomUUID();

  // Host-attested namespace gate: without a valid one no ledger result is
  // trusted and the real command runs with explicit incomplete evidence.
  let namespace: GuestSuiteNamespace | null = null;
  if (deps.namespace) {
    const normalized = normalizeGuestSuiteNamespace({ ...deps.namespace });
    if (normalized.ok) {
      namespace = normalized.value;
    } else {
      io.writeErr(
        `tamandua-test: refusing to trust the suite ledger: ${normalized.error} — executing the real command without recording\n`,
      );
      const code = await passthroughExec(cmdString, io);
      return { exitCode: code };
    }
  }
  if (namespace === null) {
    io.writeErr(
      "tamandua-test: no host-attested Matchlock environment namespace was supplied to this invocation — no ledger result can be trusted; executing the real command with incomplete evidence\n",
    );
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }
  const namespaceId = guestSuiteNamespaceId(namespace);

  const junkProbePath = io.envGet("TAMANDUA_TSTX_JUNK_PROBE");
  const junkProbeTracked = (): boolean => {
    if (junkProbePath === undefined) return false;
    try {
      return spawnSync(
        "git", ["ls-files", "--error-unmatch", "--", junkProbePath],
        { cwd: repoReal, stdio: "ignore" },
      ).status === 0;
    } catch {
      return false;
    }
  };

  const context: GuestSuiteShimContext = {
    io,
    transport: deps.transport,
    namespace,
    namespaceId,
    repoReal,
    runId: parsed.runId,
    stepId: parsed.stepId,
    force: parsed.force,
    ownerToken,
    requestTimeoutMs,
    pollIntervalMs,
    claimTimeoutMs,
    ttlGreenMs,
    redContextWindowMs,
    ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
    now,
    cmdString,
    cmdDisplay: clampDisplayBytes(cmdString, CMD_DISPLAY_MAX_BYTES),
    cmdHash,
    originRepo,
    treeHash: preTreeHash,
    ...(junkProbePath !== undefined ? { junkProbePath } : {}),
    junkProbeTracked,
  };

  const emitSpecialExit = async (details: {
    shimExitCode: number;
    commandExitCode: number | null;
    preTreeHash: string;
    postTreeHash: string;
    ledgerRowId: number | null;
    interrupted: boolean;
    trackedDirty: boolean;
  }): Promise<void> => {
    if (junkProbePath === undefined) return;
    await emitSuiteEvent(context, "suite.special_exit_observed", {
      run_id: context.runId,
      step_id: context.stepId,
      origin_repo: context.originRepo,
      tree_hash: details.preTreeHash,
      cmd_hash: context.cmdHash,
      shim_exit_code: details.shimExitCode,
      command_exit_code: details.commandExitCode,
      pre_tree_hash: details.preTreeHash,
      post_tree_hash: details.postTreeHash,
      ledger_row_id: details.ledgerRowId,
      interrupted: details.interrupted,
      tracked_dirty: details.trackedDirty,
      junk_probe_path: junkProbePath,
      junk_probe_tracked: junkProbeTracked(),
    });
  };

  // ── Transport wrappers (trusted-value + exact-token semantics) ──────

  /** Lookup that only ever returns results echoed from OUR namespace. */
  const trustedLookup = async (
    treeHash: string,
  ): Promise<{ value: GuestSuiteLookupResult } | { reason: string }> => {
    const res = await context.transport.lookup(
      {
        originRepo: context.originRepo,
        treeHash,
        cmdHash: context.cmdHash,
        namespace,
      },
      context.requestTimeoutMs,
    );
    if (!res.ok) {
      if (res.reason === "refused") {
        return { reason: `suite transport refused lookup (${res.code}): ${res.message}` };
      }
      return { reason: res.message };
    }
    if (res.value.namespaceId !== namespaceId) {
      return {
        reason:
          `suite lookup answered from namespace "${res.value.namespaceId}" but this invocation is in "${namespaceId}" — not trusting the result`,
      };
    }
    return { value: res.value };
  };

  /** Exact-token claim. */
  const ctxClaim = async (
    treeHash: string,
  ): Promise<{ ok: true; action: "run" | "wait"; claimedAt?: string } | { ok: false; reason: string }> => {
    const res = await context.transport.claim(
      {
        originRepo: context.originRepo,
        treeHash,
        cmdHash: context.cmdHash,
        namespace,
        ownerToken: context.ownerToken,
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.stepId ? { stepId: context.stepId } : {}),
        ...(context.invocationId ? { invocationId: context.invocationId } : {}),
      },
      context.requestTimeoutMs,
    );
    if (!res.ok) {
      if (res.reason === "refused") {
        return { ok: false, reason: `suite transport refused claim (${res.code}): ${res.message}` };
      }
      return { ok: false, reason: res.message };
    }
    if (res.value.namespaceId !== namespaceId) {
      return {
        ok: false,
        reason:
          `suite claim answered from namespace "${res.value.namespaceId}" but this invocation is in "${namespaceId}"`,
      };
    }
    return { ok: true, action: res.value.action, claimedAt: res.value.claimedAt };
  };

  /** Exact-token release — only ever releases THIS invocation's token. */
  const ctxRelease = async (treeHash: string, reason?: string): Promise<boolean> => {
    const res = await context.transport.release(
      {
        originRepo: context.originRepo,
        treeHash,
        cmdHash: context.cmdHash,
        namespace,
        ownerToken: context.ownerToken,
        ...(reason ? { reason } : {}),
      },
      context.requestTimeoutMs,
    ).catch(() => ({ ok: false as const, reason: "unavailable" as const, message: "release failed" }));
    return res.ok === true && res.value.released === true;
  };

  /**
   * Replay corridor (initial green, waiter promotion, re-key). Revalidates
   * tracked-dirt and committed-tree identity before replaying; a green from a
   * different tree or a dirty tree is never replayed (native F1).
   */
  const replayCachedResult = async (
    cachedResult: GuestSuiteLatestRow,
    treeHash: string,
    ageMs: number,
  ): Promise<"replayed" | "dirty-refused" | "execute"> => {
    const dirtyPaths = getTrackedDirtyPaths(repoReal);
    if (dirtyPaths === null) return "execute";
    if (dirtyPaths.length > 0) {
      writeDirtyRefusal(io, dirtyPaths);
      return "dirty-refused";
    }
    const currentTreeHash = committedTreeHash(repoReal);
    if (currentTreeHash === null || currentTreeHash !== treeHash) return "execute";

    await emitSuiteEvent(context, "suite.cache_hit", {
      run_id: context.runId,
      step_id: context.stepId,
      origin_repo: context.originRepo,
      tree_hash: treeHash.slice(0, 12),
      cmd_hash: context.cmdHash,
      cmd_display: context.cmdDisplay,
      saved_duration_ms: typeof cachedResult.duration_ms === "number"
        ? cachedResult.duration_ms
        : undefined,
      ledger_row_id: typeof cachedResult.id === "number" ? cachedResult.id : undefined,
      force: context.force,
    });
    replay(io, cachedResult, context.cmdDisplay, ageMs);
    return "replayed";
  };

  const handleReplayVerdict = (verdict: "replayed" | "dirty-refused" | "execute"): number | null => {
    if (verdict === "replayed") return 0;
    if (verdict === "dirty-refused") return TREE_DIRTY_EXIT_CODE;
    return null; // execute fresh
  };

  /**
   * Waiters poll until the owner records a green (replay) or the claim is
   * released/expired/red (execute). Bounded by claimTimeoutMs (native R16-R17).
   */
  const pollForResult = async (treeHash: string): Promise<
    { action: "replay"; latest: GuestSuiteLatestRow; ageMs: number }
    | { action: "execute"; ownsClaim: boolean }
  > => {
    const startTime = now();
    while (now() - startTime < claimTimeoutMs) {
      await sleep(pollIntervalMs);
      const looked = await trustedLookup(treeHash);
      if (!("value" in looked)) {
        io.writeErr(`tamandua-test: warning: ${looked.reason} — executing the real command\n`);
        return { action: "execute", ownsClaim: false };
      }
      const latest = looked.value.latest;
      if (latest && typeof latest.exit_code === "number") {
        if (!context.force && latest.exit_code === 0) {
          const ageMs = fmtAge(now(), String(latest.created_at ?? ""));
          if (!Number.isNaN(ageMs) && ageMs <= context.ttlGreenMs) {
            return { action: "replay", latest, ageMs };
          }
        }
      }
      const claim = await ctxClaim(treeHash);
      if (!claim.ok) {
        io.writeErr(`tamandua-test: warning: ${claim.reason} — executing the real command\n`);
        return { action: "execute", ownsClaim: false };
      }
      if (claim.action === "run") return { action: "execute", ownsClaim: true };
    }
    io.writeErr("tamandua-test: single-flight claim poll timed out — executing\n");
    return { action: "execute", ownsClaim: false };
  };

  // ── Native flow: dirty refusal happens BEFORE any transport work ────

  const initialDirtyPaths = getTrackedDirtyPaths(repoReal);
  if (initialDirtyPaths === null) {
    passthroughNotice(io, "git tracked status failed");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }
  if (initialDirtyPaths.length > 0) {
    await emitSpecialExit({
      shimExitCode: TREE_DIRTY_EXIT_CODE, commandExitCode: null,
      preTreeHash, postTreeHash: preTreeHash, ledgerRowId: null,
      interrupted: false, trackedDirty: true,
    });
    writeDirtyRefusal(io, initialDirtyPaths);
    return { exitCode: TREE_DIRTY_EXIT_CODE };
  }

  // Native lookup + replay/red context handling.
  const lookupResult = await trustedLookup(preTreeHash);
  if (!("value" in lookupResult)) {
    passthroughNotice(io, lookupResult.reason);
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }
  if (lookupResult.value.flaky) {
    printFlakyBanner(io, lookupResult.value.passCount, lookupResult.value.failCount);
    await emitSuiteEvent(context, "suite.flaky_detected", {
      run_id: context.runId,
      step_id: context.stepId,
      tree_hash: preTreeHash,
      cmd_hash: context.cmdHash,
      pass_count: lookupResult.value.passCount,
      fail_count: lookupResult.value.failCount,
      window: "24h",
    });
  }
  const latest = lookupResult.value.latest;

  // R5: fresh green without --force → replay (after F1 revalidation).
  if (latest && typeof latest.exit_code === "number" && latest.exit_code === 0 && !context.force) {
    const ageMs = fmtAge(now(), String(latest.created_at ?? ""));
    if (!Number.isNaN(ageMs) && ageMs <= context.ttlGreenMs) {
      const verdict = await replayCachedResult(latest, preTreeHash, ageMs);
      const replayExit = handleReplayVerdict(verdict);
      if (replayExit !== null) return { exitCode: replayExit };
      // "execute" → fall through and execute fresh.
    }
  }

  // R6: recent red → context note.
  if (latest && typeof latest.exit_code === "number" && latest.exit_code !== 0) {
    const ageMs = fmtAge(now(), String(latest.created_at ?? ""));
    if (!Number.isNaN(ageMs) && ageMs <= context.redContextWindowMs) {
      printRedContextNote(io, latest, context.cmdDisplay, ageMs);
    }
  }

  // R7/R16-R17: claim for single-flight.
  let ownsClaim = false;
  const firstClaim = await ctxClaim(preTreeHash);
  if (!firstClaim.ok) {
    io.writeErr(`tamandua-test: warning: ${firstClaim.reason} — executing the real command\n`);
  } else if (firstClaim.action === "wait") {
    await emitSuiteEvent(context, "suite.singleflight_wait", {
      run_id: context.runId,
      step_id: context.stepId,
      tree_hash: preTreeHash,
      cmd_hash: context.cmdHash,
      waited_ms: 0,
    });
    const poll = await pollForResult(preTreeHash);
    if (poll.action === "replay") {
      const verdict = await replayCachedResult(poll.latest, preTreeHash, poll.ageMs);
      const replayExit = handleReplayVerdict(verdict);
      if (replayExit !== null) return { exitCode: replayExit };
    }
    ownsClaim = poll.action === "execute" ? poll.ownsClaim : false;
  } else {
    ownsClaim = true;
  }

  // Promoted-waiter re-key loop: if the committed tree moved while waiting,
  // release the old key and re-check/re-claim for the CURRENT tree (native
  // pre-execution re-key).
  while (ownsClaim) {
    const executionTreeHash = committedTreeHash(repoReal);
    if (executionTreeHash === null || executionTreeHash === preTreeHash) break;

    await ctxRelease(preTreeHash);
    preTreeHash = executionTreeHash;

    const currentLookup = await trustedLookup(preTreeHash);
    if (!("value" in currentLookup)) {
      io.writeErr(`tamandua-test: warning: ${currentLookup.reason} — executing the real command\n`);
      ownsClaim = false;
      break;
    }
    if (currentLookup.value.flaky) {
      printFlakyBanner(io, currentLookup.value.passCount, currentLookup.value.failCount);
      await emitSuiteEvent(context, "suite.flaky_detected", {
        run_id: context.runId,
        step_id: context.stepId,
        tree_hash: preTreeHash,
        cmd_hash: context.cmdHash,
        pass_count: currentLookup.value.passCount,
        fail_count: currentLookup.value.failCount,
        window: "24h",
      });
    }
    const currentLatest = currentLookup.value.latest;
    if (currentLatest && currentLatest.exit_code === 0 && !context.force) {
      const ageMs = fmtAge(now(), String(currentLatest.created_at ?? ""));
      if (!Number.isNaN(ageMs) && ageMs <= context.ttlGreenMs) {
        const verdict = await replayCachedResult(currentLatest, preTreeHash, ageMs);
        const replayExit = handleReplayVerdict(verdict);
        if (replayExit !== null) return { exitCode: replayExit };
      }
    }
    if (currentLatest && typeof currentLatest.exit_code === "number" && currentLatest.exit_code !== 0) {
      const currentAgeMs = fmtAge(now(), String(currentLatest.created_at ?? ""));
      if (!Number.isNaN(currentAgeMs) && currentAgeMs <= context.redContextWindowMs) {
        printRedContextNote(io, currentLatest, context.cmdDisplay, currentAgeMs);
      }
    }
    const currentClaim = await ctxClaim(preTreeHash);
    if (!currentClaim.ok) {
      io.writeErr(`tamandua-test: warning: ${currentClaim.reason} — executing the real command\n`);
      ownsClaim = false;
      break;
    }
    if (currentClaim.action === "run") continue;
    const currentPoll = await pollForResult(preTreeHash);
    if (currentPoll.action === "replay") {
      const verdict = await replayCachedResult(currentPoll.latest, preTreeHash, currentPoll.ageMs);
      const replayExit = handleReplayVerdict(verdict);
      if (replayExit !== null) return { exitCode: replayExit };
    }
    ownsClaim = currentPoll.action === "execute" ? currentPoll.ownsClaim : false;
  }

  // Refuse dirty trees right before execution (including after a wait).
  const executionDirtyPaths = getTrackedDirtyPaths(repoReal);
  if (executionDirtyPaths === null) {
    if (ownsClaim) await ctxRelease(preTreeHash);
    passthroughNotice(io, "git tracked status failed before execution");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }
  if (executionDirtyPaths.length > 0) {
    if (ownsClaim) await ctxRelease(preTreeHash);
    writeDirtyRefusal(io, executionDirtyPaths);
    return { exitCode: TREE_DIRTY_EXIT_CODE };
  }

  const trackedPre = trackedTreeHash(repoReal);
  if (trackedPre === null) {
    if (ownsClaim) await ctxRelease(preTreeHash);
    passthroughNotice(io, "git tracked tree hash failed before execution");
    const code = await passthroughExec(cmdString, io);
    return { exitCode: code };
  }

  // F3: HEAD moved during the wait — re-key so the recorded row describes the
  // tree actually tested.
  if (trackedPre !== preTreeHash) {
    if (ownsClaim) await ctxRelease(preTreeHash);
    const currentTreeHash = committedTreeHash(repoReal);
    if (currentTreeHash === null) {
      passthroughNotice(io, "git committed tree hash failed during re-key");
      const code = await passthroughExec(cmdString, io);
      return { exitCode: code };
    }
    preTreeHash = currentTreeHash;

    const rekeyLookup = await trustedLookup(preTreeHash);
    if (!("value" in rekeyLookup)) {
      passthroughNotice(io, rekeyLookup.reason);
      const code = await passthroughExec(cmdString, io);
      return { exitCode: code };
    }
    if (rekeyLookup.value.flaky) {
      printFlakyBanner(io, rekeyLookup.value.passCount, rekeyLookup.value.failCount);
      await emitSuiteEvent(context, "suite.flaky_detected", {
        run_id: context.runId,
        step_id: context.stepId,
        tree_hash: preTreeHash,
        cmd_hash: context.cmdHash,
        pass_count: rekeyLookup.value.passCount,
        fail_count: rekeyLookup.value.failCount,
        window: "24h",
      });
    }
    const rekeyLatest = rekeyLookup.value.latest;
    if (rekeyLatest && rekeyLatest.exit_code === 0 && !context.force) {
      const ageMs = fmtAge(now(), String(rekeyLatest.created_at ?? ""));
      if (!Number.isNaN(ageMs) && ageMs <= context.ttlGreenMs) {
        const verdict = await replayCachedResult(rekeyLatest, preTreeHash, ageMs);
        const replayExit = handleReplayVerdict(verdict);
        if (replayExit !== null) return { exitCode: replayExit };
      }
    }
    if (rekeyLatest && typeof rekeyLatest.exit_code === "number" && rekeyLatest.exit_code !== 0) {
      const rekeyAgeMs = fmtAge(now(), String(rekeyLatest.created_at ?? ""));
      if (!Number.isNaN(rekeyAgeMs) && rekeyAgeMs <= context.redContextWindowMs) {
        printRedContextNote(io, rekeyLatest, context.cmdDisplay, rekeyAgeMs);
      }
    }
    const rekeyClaim = await ctxClaim(preTreeHash);
    if (!rekeyClaim.ok) {
      io.writeErr(`tamandua-test: warning: ${rekeyClaim.reason} — executing the real command\n`);
      ownsClaim = false;
    } else if (rekeyClaim.action === "run") {
      ownsClaim = true;
    } else {
      await emitSuiteEvent(context, "suite.singleflight_wait", {
        run_id: context.runId,
        step_id: context.stepId,
        tree_hash: preTreeHash,
        cmd_hash: context.cmdHash,
        waited_ms: 0,
      });
      const rekeyPoll = await pollForResult(preTreeHash);
      if (rekeyPoll.action === "replay") {
        const verdict = await replayCachedResult(rekeyPoll.latest, preTreeHash, rekeyPoll.ageMs);
        const replayExit = handleReplayVerdict(verdict);
        if (replayExit !== null) return { exitCode: replayExit };
      }
      ownsClaim = rekeyPoll.action === "execute" ? rekeyPoll.ownsClaim : false;
    }
  }

  // US-002 parity: advisory p50 duration hint before execution (namespaced).
  if (!context.force) {
    try {
      const res = await context.transport.durationHistory(
        { originRepo: context.originRepo, cmdHash: context.cmdHash, namespace },
        context.requestTimeoutMs,
      );
      if (res.ok && res.value.namespaceId === namespaceId && res.value.durations.length > 0) {
        const sorted = [...res.value.durations].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const p50Ms = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        const p50Min = Math.round(p50Ms / 60_000);
        io.writeErr(
          `TAMANDUA-TEST: expect ~${p50Min}min based on ${res.value.durations.length} prior runs — use a timeout comfortably above this\n`,
        );
      }
    } catch {
      // Advisory only — silent degradation.
    }
  }

  const executionStartedAt = new Date(now()).toISOString();
  await emitSuiteEvent(context, "suite.execute_started", {
    run_id: context.runId,
    step_id: context.stepId,
    origin_repo: context.originRepo,
    tree_hash: preTreeHash,
    cmd_hash: context.cmdHash,
    started_at: executionStartedAt,
  });

  // R9: execute the exact command, streaming stdout/stderr through untouched.
  const exec = executeGuestSuiteCommand(cmdString, io, { logTailBytes, now });
  const outcome = await exec.outcome;
  const { exitCode, durationMs, tail, interruptedBy } = outcome;

  // Reusable evidence requires byte-identical tracked content from command
  // start through full exit; untracked artifacts are irrelevant (native).
  const trackedPost = trackedTreeHash(repoReal);
  if (trackedPost === null || trackedPost !== trackedPre) {
    const shortPre = trackedPre.slice(0, 12);
    const shortPost = trackedPost?.slice(0, 12) ?? "unavailable";
    if (ownsClaim) await ctxRelease(preTreeHash, "tree_drift");
    await emitSuiteEvent(context, "suite.tree_drift_detected", {
      run_id: context.runId,
      step_id: context.stepId,
      pre_tree_hash: shortPre,
      post_tree_hash: shortPost,
      exit_code: exitCode,
    });
    if (exitCode === 0) {
      await emitSpecialExit({
        shimExitCode: TREE_DRIFT_EXIT_CODE,
        commandExitCode: exitCode,
        preTreeHash: trackedPre,
        postTreeHash: trackedPost ?? trackedPre,
        ledgerRowId: null,
        interrupted: false,
        trackedDirty: false,
      });
    }
    const reason = trackedPost === null
      ? `post-run tree hash unavailable (pre ${shortPre})`
      : `tree changed during test execution (pre ${shortPre}, post ${shortPost})`;
    io.writeErr(
      `tamandua-test: result could not be attributed: ${reason}; not recorded — stable-tree rerun required\n`,
    );
    exec.cleanup();
    return { exitCode: exitCode === 0 ? TREE_DRIFT_EXIT_CODE : exitCode };
  }

  // R10/R11: record; a transport failure must not alter the exit code —
  // warn and continue (never fabricate a green).
  //
  // Claim lifecycle note (native parity): when THIS invocation owns the
  // claim and the record is NOT accepted on a non-interrupted stable-tree
  // exit (refused / unavailable / wrong-namespace), the engine mirrors native
  // shim.ts and returns without an explicit self-release: a successful record
  // is what clears the single-flight claim, and host-side expiry bounds how
  // long a waiter can poll. Integration should decide whether to add a
  // best-effort exact-token self-release once a record is DEFINITIVELY not
  // accepted (it must never release while the record may still have landed).
  let recordedId: number | null = null;
  const recRes = await context.transport.record(
    {
      originRepo: context.originRepo,
      treeHash: preTreeHash,
      cmdHash: context.cmdHash,
      namespace,
      cmdDisplay: context.cmdDisplay,
      exitCode,
      durationMs,
      logTail: tail.length > 0 ? tail : null,
      runId: context.runId || null,
      stepId: context.stepId || null,
      force: context.force,
      startedAt: executionStartedAt,
    },
    context.requestTimeoutMs,
  );
  if (recRes.ok) {
    if (recRes.value.namespaceId !== namespaceId) {
      io.writeErr(
        "tamandua-test: warning: suite record was answered from a different environment namespace — the result was NOT recorded for this namespace\n",
      );
    } else {
      recordedId = recRes.value.id;
    }
  } else {
    io.writeErr(
      recRes.reason === "refused"
        ? `tamandua-test: warning: suite transport refused to record (${recRes.code}) — result not recorded: ${recRes.message}\n`
        : "tamandua-test: warning: failed to record suite result to control plane\n",
    );
  }
  if (exitCode === INTERRUPTED_EXIT_CODE) {
    await emitSpecialExit({
      shimExitCode: INTERRUPTED_EXIT_CODE,
      commandExitCode: INTERRUPTED_EXIT_CODE,
      preTreeHash,
      postTreeHash: preTreeHash,
      ledgerRowId: recordedId,
      interrupted: true,
      trackedDirty: false,
    });
    if (ownsClaim) await ctxRelease(preTreeHash, "cancel");
  }
  if (interruptedBy !== null) {
    exec.cleanup();
    return { exitCode: INTERRUPTED_EXIT_CODE };
  }

  exec.cleanup();
  return { exitCode };
}
