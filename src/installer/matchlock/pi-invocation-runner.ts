/**
 * pi-invocation-runner.ts — US-001 (MTLK-PI-EXEC).
 *
 * The missing host-side INVOCATION RUNNER: executes ONE opted-in pi
 * invocation (probe or work round) inside a FRESH Matchlock VM by composing
 * the immutable union components exactly as the component contracts
 * prescribe:
 *
 *   registry.admitInvocation (host-owned, BEFORE any broker/guest work)
 *     → progress-resource attach (host <state>/runs/<runId>/progress-resource,
 *       guest /workspace/runs/<runId>/progress.txt)
 *     → version-matched RO guest pack validation
 *     → FRESH MatchlockController per invocation with the persisted image pin
 *       (prepareAndCreate(expected) — never re-resolved/re-pinned by the
 *       runner, never a VM shared between probe and work)
 *     → guest bridge service over controller.execPipe, whose base64 stream
 *       frames are decoded EXACTLY once and mapped onto a broker HostPipePair
 *     → scoped host broker over the REAL NativeStepServices (same shared
 *       HostInvocationRegistry, real step-ops DB) and, when the host wired a
 *       suite-capable ledger, createHostSuiteBridge over the SAME registry
 *       lease + explicit host-owned suite store + canonical namespace +
 *       admitted roots (HostBrokerOptions.suite)
 *     → the guest pi harness runs `pi --print --mode json <prompt>` (guest
 *       step claim/complete/fail go through the host broker ONLY — never the
 *       host DB/admin surface)
 *     → terminal teardown that synchronously revokes invocation authority
 *       exactly once (registry.revokeInvocation + broker + suite seams),
 *       releases exact leases, and POSITIVELY closes/disposes ONLY this
 *       invocation's owned VM with a positive close timeout.
 *
 * No native fallback anywhere: an unpinned/incompatible image, an
 * unavailable backend or an unsupported capability refuses BEFORE any VM
 * create. Cleanup failures are surfaced (thrown), never swallowed.
 *
 * The return value is a HarnessRoundResult-compatible object so the
 * scheduler's existing post-round processing (output parsing, token
 * attribution, instant-fail/backoff tracking, step auto-completion, orphan
 * recovery) can be reused unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { HarnessRoundResult } from "../harness-adapter.js";
import type { ExecutionIsolation } from "./policy.js";
import type { GuestSuiteNamespace } from "./guest-suite-contract.js";
import {
  GUEST_BRIDGE_PROTOCOL_VERSION,
} from "./guest-protocol.js";
import { MatchlockController, MatchlockControllerError } from "./controller.js";
import { resolveLiveStateRoot } from "./mount-plan.js";
import { dshProfileModuleLinksDiffer, snapshotDshProfileModuleLinks } from "./dsh-home.js";
import { decodeFrameBytes, type MatchlockPipeHandle } from "./rpc-client.js";
import type { MatchlockStreamFrame } from "./types.js";
import {
  createHostBroker,
  type HostBrokerHandle,
  type HostPipePair,
} from "./broker.js";
import type { AuthoritativeStepServices, HostBinding } from "./broker-services.js";
import { NativeStepServices, type HostWorkerOwnership } from "./native-step-services.js";
import { HostInvocationRegistry } from "./native-step-invocations.js";
import { validateGuestPack, type GuestPackManifest } from "./guest-pack-builder.js";
import { attachRunProgressResource, assertSafeRunId, type RunProgressResource } from "./progress-resource.js";
import { resolveRunRoot } from "../paths.js";
// MATCHLOCK-OBS US-004 (bead tamandua-6sy.33.33): this module owns the
// node:child_process spawn for post-close VM evidence capture + removal. The
// runner imports ONLY this seam and keeps no direct child_process dependency.
import { captureAndRemoveVm } from "./vm-evidence.js";
// MTLK-CLEANUP US-003/US-005: the per-run orphan store the runner hands a VM to
// when its post-harness close/dispose fails, so the reaper (US-006) and the
// run's completion cleanup (US-007) retry the disposal by exact id. The module
// is Node-core only + the zero-import runner-error leaf, so importing it keeps
// the runner's dependency shape (and cycle safety) intact.
import { writeOrphanVm, type VmOrphanVmRecord } from "./vm-orphans.js";
// MTLK-CLEANUP US-007: the run-teardown/operator reaper entry point. Importing
// it keeps the runner's dependency shape (vm-reaper -> vm-evidence owns the
// spawn; the runner still has NO direct node:child_process import) and there is
// no cycle back into this module.
import { reapOrphanedMatchlockVms } from "./vm-reaper.js";
import { canonicalRealPath } from "./repository-scope.js";
import { createHostSuiteBridge, type HostSuiteBridge } from "./suite-host-bridge.js";
import { openHostSuiteStore, type HostSuiteStore } from "./host-suite-store.js";
import { createHostSuiteLedgerEvidenceSource } from "./suite-ledger-source.js";
import type { HostMergeServices } from "./host-merge-services.js";
import {
  ENV_GUEST_ENV_FINGERPRINT,
  ENV_GUEST_HELPER_CONTRACT,
  ENV_GUEST_IMAGE_CONTENT_ID,
  ENV_GUEST_PLATFORM,
  ENV_GUEST_SUITE_ENABLED,
} from "./suite-wire-env.js";
// MTLK-INTEGRATE US-003: the base error is a LEAF (runner-error.ts) so the
// hermes/dsh runners can extend it without a module-eval-time dependency on
// this module (which participates in a known import cycle). Re-exported below
// so existing importers keep importing it from here.
import {
  describeMatchlockError,
  boundMatchlockErrorText,
  serializeMatchlockError,
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
  MatchlockRunnerError,
} from "./runner-error.js";
import { Deadline, type ClockFn } from "../../lib/instant.js";
import { MatchlockRoundTiming } from "./round-timing.js";

// ── public types ───────────────────────────────────────────────────────

export type MatchlockInvocationKind = "probe" | "work";

/** Host-bound identity of ONE invocation (never guest-supplied). */
export interface MatchlockInvocationIdentity {
  /** Run id: bare uuid or `run-` prefixed (normalized to bare internally). */
  runId: string;
  /** Workflow agent/role id (e.g. feature-dev-merge_developer). */
  agentId: string;
  /** Workflow id (capability admission axis). */
  workflowId: string;
  /** Scheduler job id (stable across rounds; identity axis only). */
  jobId: string;
  /** Fresh per-invocation uuid — the unit of host authority. */
  invocationId: string;
}

/** Progress-resource wiring for the run (host-attested). */
export interface MatchlockInvocationProgress {
  /** Bound run id (bare uuid or run- prefixed). */
  runId: string;
  /** Optional host run root override (tests); default resolveRunRoot(). */
  runRoot?: string;
}

/** Host suite wiring: present ⇒ suite-capable invocation. */
export interface MatchlockInvocationSuite {
  /** Explicit host-owned Matchlock suite SQLite store path (never live/native state). */
  storePath: string;
  /** Host-admitted canonical environment namespace. */
  namespace: GuestSuiteNamespace;
  /** Canonical realpaths of admitted origin/work repository roots. */
  admittedRoots: readonly string[];
}

/**
 * MTLK-CLEANUP US-009: narrow, caller-supplied TEST-ONLY fault injection for
 * the close/dispose phase of one invocation.
 *
 * Reachability is deliberately constrained: this object can ONLY be passed
 * through the in-process {@link RunMatchlockInvocationOptions} of
 * {@link runMatchlockInvocation}. It is NEVER read from run context, an
 * environment variable, guest input or the persisted policy, so a production
 * dispatch can never arm it. Omitted / empty ⇒ every fault is OFF.
 */
export interface MatchlockInvocationFaults {
  /**
   * After the owned VM's close is POSITIVELY confirmed and BEFORE its evidence
   * is captured/removed, throw the controller-shaped close error this fault
   * models. This reproduces the #44 incident exactly: the VM is genuinely
   * stopped, the harness has already exited, so the US-005 policy keeps the
   * round result and hands the stopped VM to the reaper.
   */
  failClose?: boolean;
  /**
   * Throw the injected error on the dispose-only branch (no live VM/transport
   * existed). With no owned VM this stays on the fatal
   * `matchlock_cleanup_failed` path, exactly like a real dispose failure.
   */
  failDispose?: boolean;
  /**
   * Suppress the US-007 best-effort immediate reaper pass for the handed-off
   * VM, so a gate can observe the stopped leftover and drive the reaper itself.
   */
  suppressImmediateReap?: boolean;
  /** Optional message carried by the injected error (evidence labelling). */
  message?: string;
}

export interface RunMatchlockInvocationOptions {
  /** Persisted version-2 ExecutionIsolation policy (carries the image pin). */
  policy: ExecutionIsolation;
  /** Host-bound invocation identity. */
  identity: MatchlockInvocationIdentity;
  kind: MatchlockInvocationKind;
  /** Work/probe prompt text passed as the pi prompt argument. */
  promptText: string;
  /** Absolute launch cwd (same spelling host/guest; policy.workingDirectory). */
  workingDirectoryForHarness: string;
  /** Positive wall-clock budget (ms) for the harness exec. */
  timeoutMs: number;
  /** Cancellation signal (scheduler round abort). */
  signal?: AbortSignal;
  /** Host progress-resource run wiring (optional; when present the run opts in). */
  progressResource?: MatchlockInvocationProgress;
  /** Host suite wiring (optional; when present the invocation is suite-capable). */
  suite?: MatchlockInvocationSuite;
  /**
   * US-008: host-attested, already-constructed merge authorization/receipt
   * service (optional). The production scheduler seam builds it from the
   * immutable run merge context (`merge-invocation-wiring.ts`) and passes it
   * here; the runner only forwards it to the broker. When absent the merge ops
   * stay UNSUPPORTED (never a fabricated landing) and a workflow whose
   * declared capability closure requires `merge-branch` is refused before any
   * VM.
   */
  merge?: HostMergeServices;
  /**
   * Shared host invocation registry for the (run, agent) authority lifetime —
   * ONE registry SHARED by NativeStepServices AND createHostSuiteBridge.
   * When omitted the runner owns a single-invocation registry (tests).
   */
  registry?: HostInvocationRegistry;
  /** Host path to the built versioned RO guest helper pack. */
  helperPackHostPath: string;
  /** Role string for the HostBinding (informational; default derived from agent id). */
  role?: string;
  /**
   * Guest harness argv (production default ["pi","--print","--mode","json"]).
   * The prompt text is appended as the final quoted argument. Test-only
   * override to substitute a synthetic guest pi.
   */
  harnessArgv?: string[];
  /**
   * The image's effective guest PATH used as the base for the helper-pack
   * prepend. Production admission preserves the USER IMAGE's effective PATH
   * (policy.imagePath, from the resolved image config env) and the scheduler
   * forwards it into every round, so the guest keeps an image-declared
   * executable location. When omitted the helper pack bin is prepended to a
   * conservative POSIX default PATH (only for records admitted before PATH
   * discovery, or images that declare no PATH).
   */
  imagePath?: string;
  /** Extra guest env merged over the runner-composed invocation env (tests). */
  guestEnvOverrides?: Record<string, string>;
  /** Matchlock rpc binary seam (default env TAMANDUA_MATCHLOCK_RPC_BIN or "matchlock"). */
  rpcBinaryPath?: string;
  /** Matchlock rpc argv seam (default ["rpc"]). */
  rpcArgs?: string[];
  /** Extra env keys merged over process.env for the RPC child (test seams). */
  rpcEnv?: Record<string, string>;
  /** Controller stage deadlines (pass-through; defaults are bounded). */
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  execCancelSettleTimeoutMs?: number;
  /** Positive close timeout (seconds) for the owned VM (default 30). */
  closeTimeoutSeconds?: number;
  /** Bounded byte budget for the captured harness stdout (default 10 MiB). */
  maxOutputBytes?: number;
  /** Broker handshake deadline (ms). */
  handshakeTimeoutMs?: number;
  /** Broker delegated service deadline (ms). */
  serviceTimeoutMs?: number;
  /** Worker ownership recorded on native claims (default jobId + host pid). */
  workerOwnership?: HostWorkerOwnership;
  /**
   * US-006 test seam: monotonic clock used by the round timing tracker. The
   * production default is `monotonicNow`; a deterministic test injects a
   * scripted clock to prove `harnessWallMs` excludes VM setup and `vmSetupMs`
   * carries it without running a real VM.
   */
  clock?: ClockFn;
  /**
   * MTLK-CLEANUP US-009: TEST-ONLY close/dispose fault injection. Reachable
   * ONLY through this in-process options object (never env / run context /
   * guest input / persisted policy); omitted ⇒ every fault OFF. See
   * {@link MatchlockInvocationFaults}.
   */
  faults?: MatchlockInvocationFaults;
  onLog?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

/** Runner outcome extras attached to the HarnessRoundResult-compatible object. */
export interface MatchlockInvocationOutcome {
  /** Fresh per-invocation uuid. */
  invocationId: string;
  /** VM id created for this invocation (null when none was created). */
  vmId: string | null;
  kind: MatchlockInvocationKind;
  /** Bare run id. */
  runId: string;
  /** True when the round ended by the host cancel/abort signal. */
  canceled?: boolean;
  /** Cleanup was fully confirmed (VM closed or no VM ever created). */
  cleanupConfirmed?: boolean;
  /** True when the invocation had NO host suite wiring (suite-absent). */
  suiteAbsent?: boolean;
  /**
   * MATCHLOCK-OBS US-004: true only when the owned VM's evidence was captured
   * and the VM was POSITIVELY removed after a confirmed close. Absent when no
   * VM was ever created or the close was never confirmed (dispose-only).
   */
  vmRemoved?: boolean;
  /** MATCHLOCK-OBS US-004: evidence destination, or null when nothing captured. */
  vmLogsCopiedTo?: string | null;
  /** MATCHLOCK-OBS US-004: bounded removal failure description (absent on success). */
  vmRemovalError?: string;
  /**
   * MTLK-CLEANUP US-005: bounded serialized detail of a close/dispose failure
   * that happened AFTER the harness process exited. The round result is still
   * returned (non-fatal); the VM was handed to the reaper via the per-run
   * orphan store. Absent when the close confirmed (or no VM was created).
   */
  vmCleanupFailure?: string;
}

export type MatchlockInvocationResult = HarnessRoundResult & MatchlockInvocationOutcome;

/** Typed runner/infrastructure error (fail-closed; distinct from a guest round outcome). */
export { MatchlockRunnerError } from "./runner-error.js";
export { describeMatchlockError, boundMatchlockErrorText, serializeMatchlockError, MATCHLOCK_ERROR_TAIL_MAX_BYTES } from "./runner-error.js";

// ── constants / helpers ────────────────────────────────────────────────

const MAX_OUTPUT_DEFAULT = 10 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_SECONDS = 30;
const DEFAULT_IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const EXEC_SETTLE_GRACE_MS = 10_000;

/** Guest runtime mount root of the RO helper pack. */
export const GUEST_RUNTIME_BIN = "/workspace/runtime/bin";
/** Guest bridge service entry point inside the pack. */
export const GUEST_BRIDGE_SERVICE = "/workspace/runtime/bin/tamandua-bridge";

/**
 * MTLK-CLEANUP US-009: the controller-shaped error body every injected fault
 * throws. It is a PLAIN `{code,message}` body — exactly what the RPC client
 * rejects with — so the US-001 serializer renders `name=MatchlockRpcError`,
 * the code and the message, and the phase comes from the cleanup site.
 */
function injectedMatchlockFault(phase: "close" | "dispose", detail?: string): { code: number; message: string } {
  const base = "injected matchlock close/dispose failure (test-only fault seam)";
  const message = detail && detail.trim().length > 0 ? `${base}: ${detail}` : base;
  return { code: -32000, message: `${message} [phase=${phase}]` };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bareRunId(runId: string): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  if (!UUID_RE.test(bare)) {
    throw new MatchlockRunnerError("invalid_run_id", `Refusing malformed run id: ${JSON.stringify(runId)}`);
  }
  return bare;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The EFFECTIVE Matchlock HOME the controller's RPC child is spawned with:
 * an explicit `rpcEnv.HOME` wins, else the host process HOME (mirrors
 * `MatchlockController.effectiveRpcHome`). US-005 uses this for the orphan
 * record so the reaper/handoff point at the same store the VM was created in.
 */
function effectiveMatchlockHome(rpcEnv?: Record<string, string>): string {
  const fromRpcEnv = rpcEnv?.HOME;
  if (typeof fromRpcEnv === "string" && fromRpcEnv.length > 0) return fromRpcEnv;
  return process.env.HOME ?? "";
}

/** POSIX single-quote one shell argument (the exec command is a shell string). */
export function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new MatchlockRunnerError("invalid_prompt", "prompt contains a NUL byte; refusing to interpolate");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function roleFromAgent(agentId: string, fallback?: string): string {
  if (fallback) return fallback;
  const idx = agentId.lastIndexOf("_");
  if (idx >= 0 && idx < agentId.length - 1) return agentId.slice(idx + 1);
  return "developer";
}

function tailText(chunks: Buffer[], maxTailBytes: number): string {
  const all = Buffer.concat(chunks);
  const tail = all.subarray(Math.max(0, all.length - maxTailBytes));
  // ANSI-strip + hard line bound (mirrors native sanitizeStderrTail intent).
  return tail
    .toString("utf8")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => (line.length > 500 ? `${line.slice(0, 500)}…` : line))
    .slice(-200)
    .join("\n")
    .slice(-maxTailBytes);
}

// ── guest environment composition ─────────────────────────────────────

export interface ComposedGuestEnv {
  /** The bridge socket dir the guest service + CLI share (guest-visible). */
  socketDir: string;
  /** The full guest socket path. */
  socketPath: string;
  /** Every env key to place in the VM create config. */
  env: Record<string, string>;
}

/**
 * Compose the invocation-bound guest env: helper-pack PATH prepend, bound
 * run/invocation/agent identity, guest build version (from the pack
 * manifest), the shared bridge socket location, and (suite-capable) the
 * suite-enabled switch + attested namespace envs.
 */
export function composeGuestEnv(opts: {
  invocationId: string;
  runId: string;
  agentId: string;
  manifest: GuestPackManifest;
  imagePath?: string;
  suite?: MatchlockInvocationSuite;
  extra?: Record<string, string>;
}): ComposedGuestEnv {
  const socketDir = `/tmp/tamandua-guest-${opts.invocationId}`;
  const socketPath = `${socketDir}/bridge.sock`;
  const imagePath = opts.imagePath && opts.imagePath.trim() !== "" ? opts.imagePath : DEFAULT_IMAGE_PATH;
  const env: Record<string, string> = {
    PATH: `${GUEST_RUNTIME_BIN}:${imagePath}`,
    TAMANDUA_RUN_ID: `run-${opts.runId}`,
    TAMANDUA_INVOCATION_ID: opts.invocationId,
    TAMANDUA_WORKER_AGENT_ID: opts.agentId,
    TAMANDUA_GUEST_BUILD_VERSION: opts.manifest.tamanduaBuildVersion,
    TAMANDUA_GUEST_SOCKET_DIR: socketDir,
    TAMANDUA_GUEST_SOCKET: socketPath,
    TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS: "15000",
    TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS: "30000",
    TAMANDUA_BRIDGE_SHUTDOWN_FLUSH_MS: "2000",
    // Explicit default: suite ops are served ONLY when the host wired a
    // suite-capable broker. Absence is never hidden (the guest engine
    // degrades to real guest-local execution with explicit incomplete
    // evidence — never a recorded green).
    [ENV_GUEST_SUITE_ENABLED]: opts.suite ? "1" : "0",
  };
  if (opts.suite) {
    env[ENV_GUEST_IMAGE_CONTENT_ID] = opts.suite.namespace.imageContentId;
    env[ENV_GUEST_PLATFORM] = opts.suite.namespace.guestPlatform;
    env[ENV_GUEST_HELPER_CONTRACT] = opts.suite.namespace.helperContract;
    env[ENV_GUEST_ENV_FINGERPRINT] = opts.suite.namespace.compatibilityFingerprint;
  }
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) env[k] = v;
  }
  return { socketDir, socketPath, env };
}

/** Read + validate the built guest pack manifest on disk. */
export function readGuestPack(packRoot: string): GuestPackManifest {
  let manifest: GuestPackManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packRoot, "manifest.json"), "utf-8")) as GuestPackManifest;
  } catch (err) {
    throw new MatchlockRunnerError(
      "guest_bridge_unavailable",
      `Guest helper pack at ${packRoot} has no readable manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof manifest.tamanduaBuildVersion !== "string" ||
    manifest.tamanduaBuildVersion.trim() === "" ||
    typeof manifest.helperProtocolVersion !== "string" ||
    typeof manifest.packLayoutVersion !== "number"
  ) {
    throw new MatchlockRunnerError(
      "guest_bridge_unavailable",
      `Guest helper pack manifest at ${packRoot} is missing build/layout identity (tamanduaBuildVersion, helperProtocolVersion, packLayoutVersion).`,
    );
  }
  const validation = validateGuestPack(packRoot);
  if (!validation.ok) {
    throw new MatchlockRunnerError(
      "guest_bridge_unavailable",
      `Guest helper pack closure validation failed at ${packRoot}: ${validation.errors.join("; ")}`,
    );
  }
  return manifest;
}

/**
 * Admitted repository/work roots for the host binding (policy-derived).
 *
 * DESIGN INTENT: the policy records the EXACT host spelling of every root
 * (the spelling the guest sees as its cwd), and the canonical target is
 * recorded separately. This set therefore carries BOTH the exact spelling and
 * its canonical real path for the original repository root and for every work
 * mount (`hostPath` and `hostRealPath`), deduped with insertion order
 * preserved. Admission consumers compare by realpath identity
 * (`admittedRootMatches`), so a symlink-spelled work path is admitted while
 * every root outside the admitted set stays refused.
 */
export function admittedRootsFromPolicy(policy: ExecutionIsolation): string[] {
  const roots = new Set<string>();
  if (policy.originalRepositoryRoot) {
    roots.add(policy.originalRepositoryRoot);
    roots.add(canonicalRealPath(policy.originalRepositoryRoot));
  }
  for (const m of policy.workMounts) {
    roots.add(m.hostPath);
    roots.add(m.hostRealPath || m.hostPath);
  }
  return [...roots];
}

/** Map an RPC failure into a typed runner/infrastructure error. */
export function classifyInvocationError(err: unknown, stage: string): MatchlockRunnerError {
  if (err instanceof MatchlockRunnerError) return err;
  if (err instanceof MatchlockControllerError) {
    return new MatchlockRunnerError(err.code, `${stage}: ${err.message}`);
  }
  const message = describeMatchlockError(err);
  return new MatchlockRunnerError("matchlock_invocation_failed", `${stage}: ${message}`);
}

// ── exec_pipe → broker HostPipePair glue ───────────────────────────────

export interface ExecPipeBrokerBridge {
  pipe: HostPipePair;
  /** Ends the broker's fromGuest readable exactly once (exec pipe settled). */
  closeFromGuest(): void;
  /** Resolves once the guest bridge process exited (or the exec pipe settled). */
  readonly guestExit: Promise<void>;
  /** True once stdin EOF was signaled to the guest service. */
  readonly eofSignaled: boolean;
  /** Exec-pipe settlement error (null on clean exit). */
  readonly execError: unknown;
  /** Push one decoded stdout frame into fromGuest (decode exactly once). */
  notify(frame: MatchlockStreamFrame): void;
}

/**
 * Map a controller exec_pipe (whose stdout chunks arrive as per-frame base64
 * stream frames) onto a broker HostPipePair. Every base64 chunk is decoded
 * EXACTLY once (decodeFrameBytes) before its bytes are pushed into the
 * broker's fromGuest Readable; bytes written by the broker into toGuest are
 * forwarded as exec_pipe.stdin chunks, and ending toGuest signals stdin EOF.
 */
export function mapExecPipeToBrokerPipe(execPipe: MatchlockPipeHandle): ExecPipeBrokerBridge {
  const fromGuest = new PassThrough();
  const stderrChunks: Buffer[] = []; // captured separately by callers
  let guestExited = false;
  let execError: unknown = null;
  const exitWaiters: Array<() => void> = [];
  const markGuestExited = (): void => {
    if (guestExited) return;
    guestExited = true;
    try {
      fromGuest.end();
    } catch {
      /* already ended */
    }
    for (const r of exitWaiters.splice(0)) r();
  };
  const guestExit = new Promise<void>((resolve) => {
    if (guestExited) resolve();
    else exitWaiters.push(resolve);
  });

  let eofSignaled = false;
  const toGuest = new Writable({
    write(chunk: Buffer, _enc: unknown, cb: (err?: Error | null) => void): void {
      execPipe.stdin.write(chunk).then(
        () => cb(),
        (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
      );
    },
    final(cb: (err?: Error | null) => void): void {
      eofSignaled = true;
      execPipe.stdin.eof().then(
        () => cb(),
        (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
      );
    },
  });
  toGuest.on("error", () => {
    // A dead/ended host pipe must still release the guest.
    if (!eofSignaled) {
      eofSignaled = true;
      execPipe.stdin.eof().catch(() => {});
    }
  });

  execPipe.result.then(
    () => markGuestExited(),
    (err: unknown) => {
      execError = err;
      markGuestExited();
    },
  );

  return {
    pipe: { toGuest, fromGuest },
    closeFromGuest: (): void => {
      try {
        fromGuest.end();
      } catch {
        /* already ended */
      }
    },
    guestExit,
    get eofSignaled(): boolean {
      return eofSignaled;
    },
    get execError(): unknown {
      return execError;
    },
    notify(frame: MatchlockStreamFrame): void {
      if (frame.kind === "ready") return;
      const bytes = decodeFrameBytes(frame);
      if (bytes.length === 0) return;
      if (frame.kind === "stderr") {
        stderrChunks.push(bytes);
        return;
      }
      // stdout frame: decode base64 EXACTLY once. The broker's FrameDecoder
      // reassembles framed JSON across arbitrary chunk boundaries, so a chunk
      // split inside a multi-byte UTF-8 sequence is harmless at the byte
      // layer — a second decode would corrupt it.
      try {
        fromGuest.push(bytes);
      } catch {
        /* broker side went away */
      }
    },
  };
}

// ── bounded harness capture ────────────────────────────────────────────

interface CaptureState {
  stdout: Buffer[];
  stdoutBytes: number;
  stderr: Buffer[];
  stderrBytes: number;
  overflowed: boolean;
  maxBytes: number;
}

function createCaptureState(maxBytes: number): CaptureState {
  return { stdout: [], stdoutBytes: 0, stderr: [], stderrBytes: 0, overflowed: false, maxBytes };
}

function captureNotify(state: CaptureState, frame: MatchlockStreamFrame): void {
  if (frame.kind === "ready") return;
  const bytes = decodeFrameBytes(frame);
  if (bytes.length === 0) return;
  if (frame.kind === "stderr") {
    const budget = Math.max(4096, Math.floor(state.maxBytes / 4));
    if (!state.overflowed && state.stderrBytes + bytes.length <= budget) {
      state.stderr.push(bytes);
      state.stderrBytes += bytes.length;
    }
    return;
  }
  if (!state.overflowed && state.stdoutBytes + bytes.length <= state.maxBytes) {
    state.stdout.push(bytes);
    state.stdoutBytes += bytes.length;
  } else {
    state.overflowed = true;
  }
}

function captureStdoutText(state: CaptureState): string {
  return Buffer.concat(state.stdout).toString("utf8");
}

/** Bounded grace for late stream frames to reach an empty capture (US-006). */
const FRAME_DRAIN_GRACE_MS = 200;

/**
 * US-006 (H1/D1): settle pending stream frames before the capture is read.
 * The matchlock runtime emits stdout/stderr notifications BEFORE the exec
 * result, but a different runtime version (or a relay that settles its waiter
 * before flushing the last chunk) can deliver the result first. When the
 * bounded capture is still empty, wait a short bounded grace so an
 * already-buffered frame can be dispatched before classification. A non-empty
 * capture returns immediately (the common case); a genuinely empty round pays
 * only the bounded grace.
 */
async function drainPendingStreamFrames(
  state: { stdoutBytes: number; overflowed: boolean },
  ms = FRAME_DRAIN_GRACE_MS,
): Promise<void> {
  if (state.stdoutBytes > 0 || state.overflowed) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ── the runner ─────────────────────────────────────────────────────────

/**
 * Execute ONE opted-in pi invocation in a FRESH VM and return a
 * HarnessRoundResult-compatible object. Throws a typed
 * {@link MatchlockRunnerError} on infrastructure failures/refusals — always
 * after owned cleanup, and cleanup failures are surfaced, never swallowed.
 */
export async function runMatchlockInvocation(opts: RunMatchlockInvocationOptions): Promise<MatchlockInvocationResult> {
  // TIME-CLOCKS rule 1: the round duration and the wall budget are in-process
  // intervals, measured on the monotonic clock so a wall-clock jump cannot
  // produce a negative/inflated duration or an early/late timeout.
  const timing = new MatchlockRoundTiming(opts.clock);
  const timeoutMs = opts.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MatchlockRunnerError("invalid_timeout", `runMatchlockInvocation requires a positive timeoutMs (got ${timeoutMs})`);
  }
  if (typeof opts.helperPackHostPath !== "string" || opts.helperPackHostPath.trim() === "") {
    throw new MatchlockRunnerError("guest_bridge_unavailable", "A versioned RO guest helper pack host path is required; none was supplied.");
  }
  if (!opts.identity || typeof opts.identity.invocationId !== "string" || !isUuid(opts.identity.invocationId)) {
    throw new MatchlockRunnerError("invalid_invocation_id", `invocationId must be a uuid (got ${JSON.stringify(opts.identity?.invocationId)})`);
  }
  const runId = bareRunId(opts.identity.runId);
  const invocationId = opts.identity.invocationId;
  const kind = opts.kind;
  const diag = (msg: string): void => {
    try {
      opts.onLog?.("info", msg, { runId, invocationId, kind, vmId });
    } catch {
      /* ignore */
    }
  };
  let vmId: string | null = null;

  // ── 1. host-owned registry admission BEFORE any broker/guest work ─────
  const registry = opts.registry ?? new HostInvocationRegistry();
  const admitted = registry.admitInvocation({
    invocationId,
    runId,
    agentId: opts.identity.agentId,
    jobId: opts.identity.jobId,
  });
  if (!admitted.ok) {
    throw new MatchlockRunnerError("invocation_admission_refused", admitted.reason);
  }

  // ── owned handles (all cleaned on every path) ─────────────────────────
  let controller: MatchlockController | null = null;
  let controllerCreatedVm = false;
  let broker: HostBrokerHandle | null = null;
  let bridge: ExecPipeBrokerBridge | null = null;
  let harnessExec: MatchlockPipeHandle | null = null;
  let suiteStore: HostSuiteStore | null = null;
  let suiteBridge: HostSuiteBridge | null = null;
  let mergeService: HostMergeServices | null = null;
  let progressResource: RunProgressResource | null = null;
  let revokedOnce = false;
  let cleanupDone = false;
  const cleanupState: { error: MatchlockRunnerError | null } = { error: null };
  /**
   * MTLK-CLEANUP US-005: true once the harness exec has SETTLED (the process
   * exited, was canceled, or its exec request was rejected). Only then is a
   * close/dispose failure a post-harness cleanup nuisance rather than a
   * possible symptom of a still-live round.
   */
  let harnessExited = false;
  /**
   * MTLK-CLEANUP US-005: bounded serialized detail of a post-harness
   * close/dispose failure. Non-null only when the harness had already exited;
   * the round result is then kept and the VM is handed to the reaper.
   */
  let vmCleanupFailure: string | null = null;
  /**
   * MATCHLOCK-OBS US-004: post-close evidence/removal outcome. Populated ONLY
   * after a POSITIVELY confirmed close, then spread onto every returned round
   * result (including canceled/timeout rounds). Empty for a dispose-only
   * teardown (no confirmed close).
   */
  const vmReapOutcome: { vmRemoved?: boolean; vmLogsCopiedTo?: string | null; vmRemovalError?: string } = {};

  const revoke = (reason: string): void => {
    if (revokedOnce) return;
    revokedOnce = true;
    // TERMINAL revocation, exactly once: registry first (drops any held lease
    // and tombstones the identity), then the suite seam (idempotent — the
    // broker notifies its adapter + suite at most once per broker lifetime).
    try {
      registry.revokeInvocation(invocationId, reason);
    } catch {
      /* host-owned */
    }
    try {
      suiteBridge?.revokeAuthority(reason);
    } catch {
      /* idempotent host seam */
    }
  };

  const releaseLeases = (): void => {
    // Legitimate release of a lease this invocation still holds after the
    // round (e.g. harness died mid-claim): the adapter would already have
    // released an accepted transition's lease, so any leftover lease means no
    // mutation consumed the claim — drop only OUR lease (never revoke a
    // completed transition). The step row itself is re-pended by native
    // orphan recovery.
    try {
      const lease = registry.getLeaseByInvocation(invocationId);
      if (lease) registry.releaseIfHeldBy(invocationId, lease.stepRowId);
    } catch {
      /* best-effort */
    }
  };

  /**
   * MATCHLOCK-OBS US-004 (bead tamandua-6sy.33.33): capture the positively
   * closed VM's retained evidence into the run's evidence location and then
   * remove the VM, so stopped VM rows + `~/.matchlock/vms/<id>/` dirs stop
   * accumulating (probe + work, every round). The actual spawn lives in
   * `vm-evidence.ts`; this runner method only resolves the destination, the
   * EFFECTIVE matchlock HOME the controller's RPC child used, and the CLI
   * binary seam — the same values the controller was configured with.
   *
   * NEVER throws and NEVER touches the cleanup error list: a removal failure is
   * reportable round metadata (`vmRemoved: false` + bounded `vmRemovalError`)
   * and a warn log; it cannot change `cleanupConfirmed` or block the round.
   */
  const reapVmEvidence = (ownedVmId: string): void => {
    try {
      const runRoot = opts.progressResource?.runRoot ?? resolveRunRoot();
      const bare = assertSafeRunId(runId);
      const destinationDir = path.join(runRoot, bare, "matchlock", ownedVmId);
      // The EFFECTIVE matchlock HOME the controller's RPC child was spawned
      // with (mirrors MatchlockController.effectiveRpcHome): an explicit
      // rpcEnv.HOME wins, else the host process HOME.
      const matchlockHome = effectiveMatchlockHome(opts.rpcEnv);
      // The SAME binary seam the controller used (opts.rpcBinaryPath, else the
      // TAMANDUA_MATCHLOCK_RPC_BIN override, else "matchlock").
      const cliBinaryPath =
        opts.rpcBinaryPath ?? (process.env.TAMANDUA_MATCHLOCK_RPC_BIN?.trim() || "matchlock");
      const outcome = captureAndRemoveVm({
        vmId: ownedVmId,
        matchlockHome,
        destinationDir,
        cliBinaryPath,
        onLog: opts.onLog
          ? (level, message, fields) => {
              try {
                opts.onLog?.(level, message, fields);
              } catch {
                /* logging must never affect the round */
              }
            }
          : undefined,
      });
      vmReapOutcome.vmRemoved = outcome.removed;
      vmReapOutcome.vmLogsCopiedTo = outcome.logsCopiedTo;
      if (outcome.removalError) vmReapOutcome.vmRemovalError = outcome.removalError;
    } catch (err) {
      // captureAndRemoveVm never throws; defense-in-depth so the round is
      // never derailed by evidence capture. MTLK-CLEANUP US-001: serialized
      // with the exact phase + owned vmId.
      const removalError = serializeMatchlockError(err, {
        phase: "vm-evidence-removal",
        vmId: ownedVmId,
        runId,
        invocationId,
      });
      vmReapOutcome.vmRemoved = false;
      vmReapOutcome.vmLogsCopiedTo = vmReapOutcome.vmLogsCopiedTo ?? null;
      vmReapOutcome.vmRemovalError = removalError;
      try {
        opts.onLog?.("warn", "matchlock vm evidence capture/removal failed", {
          runId,
          invocationId,
          vmId: ownedVmId,
          removalError,
        });
      } catch {
        /* logging must never affect the round */
      }
    }
  };

  /**
   * MTLK-CLEANUP US-003/US-005: hand a post-harness close/dispose failure's VM
   * to the per-run orphan store so the stopped-VM reaper and the run's
   * completion cleanup can retry the disposal by EXACT id. Best-effort by
   * design: the store never throws for a malformed/absent file, and any
   * defensive failure here is logged (never allowed to change the round
   * outcome, which is exactly what this story protects).
   *
   * Returns the persisted record (or null) so US-007 can immediately retry ONE
   * bounded reaper pass for exactly that VM.
   */
  const handOffOrphanVm = (
    ownedVmId: string,
    phase: string,
    detail: string,
  ): VmOrphanVmRecord | null => {
    try {
      const runRoot = opts.progressResource?.runRoot ?? resolveRunRoot();
      return writeOrphanVm(
        {
          vmId: ownedVmId,
          matchlockHome: effectiveMatchlockHome(opts.rpcEnv),
          invocationId,
          phase,
          error: detail,
          agentId: opts.identity.agentId,
          round: opts.identity.jobId,
          kind,
        },
        {
          runId,
          runRoot,
          onLog: opts.onLog
            ? (level, message, fields) => {
                try {
                  opts.onLog?.(level, message, fields);
                } catch {
                  /* logging must never affect the round */
                }
              }
            : undefined,
        },
      );
    } catch (err) {
      // Defense-in-depth: a store refusal/write failure must never derail a
      // round that already completed. Serialize with the US-001 serializer.
      try {
        opts.onLog?.("warn", "matchlock orphan-VM handoff failed", {
          runId,
          invocationId,
          vmId: ownedVmId,
          phase,
          error: serializeMatchlockError(err, { phase, vmId: ownedVmId, runId, invocationId }),
        });
      } catch {
        /* logging must never affect the round */
      }
      return null;
    }
  };

  /**
   * MTLK-CLEANUP US-007: after handing a VM to the orphan store, best-effort
   * invoke ONE bounded reaper pass for exactly that VM (same process). The
   * pass runs ONLY for the handed-off VM's effective Matchlock HOME, uses the
   * US-006 live-process guard, and can NEVER change the round outcome — the
   * entry point never throws and its report is intentionally not surfaced here
   * (the scheduler teardown pass is the durable retry).
   */
  const tryImmediateOrphanReap = (record: VmOrphanVmRecord | null): void => {
    if (!record) return;
    try {
      reapOrphanedMatchlockVms({
        runId,
        runRoot: opts.progressResource?.runRoot ?? resolveRunRoot(),
        matchlockHome: record.matchlockHome,
        orphanRecords: [record],
      });
    } catch (err) {
      // Defense-in-depth: a reap failure must never derail a kept round.
      try {
        opts.onLog?.("warn", "matchlock immediate orphan reap failed", {
          runId,
          invocationId,
          vmId: record.vmId,
          phase: record.phase,
          error: serializeMatchlockError(err, {
            phase: record.phase,
            vmId: record.vmId,
            runId,
            invocationId,
          }),
        });
      } catch {
        /* logging must never affect the round */
      }
    }
  };

  /**
   * Terminal cleanup on every path. Order: revoke authority synchronously,
   * release leftover leases, end the broker (revokes + ends toGuest → stdin
   * EOF), wait bounded for the guest bridge to exit, settle the exec pipes,
   * then POSITIVELY close ONLY this VM with a positive close timeout (the
   * controller's close waits for an in-flight create phase and confirms the
   * VM close on the wire); hard-dispose only when close cannot confirm.
   * Safe when nothing was ever created (close-before-create,
   * late-create-after-cancel).
   */
  const cleanup = async (reason: string): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    const errors: string[] = [];
    revoke(reason);
    releaseLeases();
    if (broker) {
      try {
        await broker.close();
        await Promise.race([broker.closed, new Promise<void>((r) => setTimeout(r, 5000))]);
      } catch (err) {
        // MTLK-CLEANUP US-001: the RPC client rejects with a PLAIN body object,
        // so `String(err)`/`err.message` dropped the real cause to
        // `[object Object]`. The serializer renders name/code/message/stack +
        // phase + vmId as one bounded line.
        errors.push(
          `broker close: ${serializeMatchlockError(err, { phase: "broker-close", vmId, runId, invocationId })}`,
        );
      }
    }
    if (bridge) {
      try {
        if (!bridge.eofSignaled) bridge.pipe.toGuest.end();
      } catch {
        /* already ended */
      }
      try {
        await Promise.race([bridge.guestExit, new Promise<void>((r) => setTimeout(r, 8000))]);
      } catch {
        /* bounded */
      }
      bridge.closeFromGuest();
    }
    if (harnessExec) {
      try {
        await Promise.race([
          harnessExec.result.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((r) => setTimeout(r, 2000)),
        ]);
      } catch {
        /* bounded settle */
      }
    }
    if (controller) {
      const ownedVmId = controller.identity.vmId ?? controller.lateVm?.vmId ?? vmId;
      const hasLiveOrCreated =
        controllerCreatedVm ||
        controller.lateVm !== null ||
        controller.rpcRunning;
      let orphanHandoff: VmOrphanVmRecord | null = null;
      try {
        if (hasLiveOrCreated) {
          await controller.close(opts.closeTimeoutSeconds ?? DEFAULT_CLOSE_TIMEOUT_SECONDS);
          vmId = vmId ?? ownedVmId;
          // MTLK-CLEANUP US-009: TEST-ONLY fault seam. Injected AFTER the real
          // close was positively confirmed (the VM is genuinely stopped) and
          // BEFORE evidence capture/removal, so the post-harness policy below
          // keeps the round and hands the stopped VM to the reaper — exactly
          // the #44 shape.
          if (opts.faults?.failClose) {
            throw injectedMatchlockFault("close", opts.faults.message);
          }
          // MATCHLOCK-OBS US-004: capture + remove ONLY after the close was
          // POSITIVELY confirmed on the wire (isClosed). An unconfirmed close
          // (or a dispose-only teardown, handled below) leaves the VM alone —
          // it may still be live, so removing it would be unsafe.
          if (controller.isClosed && ownedVmId) {
            reapVmEvidence(ownedVmId);
          }
        } else {
          // MTLK-CLEANUP US-009: TEST-ONLY dispose-branch fault seam (no live
          // VM/transport existed, so this stays fatal like a real dispose
          // failure).
          if (opts.faults?.failDispose) {
            throw injectedMatchlockFault("dispose", opts.faults.message);
          }
          // Nothing was ever created and no live transport exists: dispose is
          // the exact (no-op) hard teardown — never fabricate a close.
          await controller.dispose();
        }
      } catch (err) {
        // MTLK-CLEANUP US-001: `err` here is frequently the RPC client's plain
        // `{code,message}` body (close failure), so render it with the
        // serializer + the exact failing phase and owned vmId.
        const phase = hasLiveOrCreated ? "close" : "dispose";
        const detail = serializeMatchlockError(err, {
          phase,
          vmId: ownedVmId,
          runId,
          invocationId,
        });
        // MTLK-CLEANUP US-005: a close/dispose failure AFTER the harness exec
        // has settled is NOT an infrastructure failure of the round. The round
        // result (stdout/STATUS/evidence) is kept and processed normally; the
        // failure is logged at WARN with the serialized cause and the VM is
        // handed to the reaper (orphan record) so disposal is retried later.
        // create/probe/exec failures and a close failure BEFORE the harness
        // exits keep the fatal `matchlock_cleanup_failed` behaviour.
        if (harnessExited && ownedVmId) {
          vmCleanupFailure = boundMatchlockErrorText(detail, MATCHLOCK_ERROR_TAIL_MAX_BYTES);
          try {
            opts.onLog?.("warn", "matchlock post-harness vm close/dispose failed; handing VM to the reaper", {
              runId,
              invocationId,
              kind,
              vmId: ownedVmId,
              phase,
              error: detail,
            });
          } catch {
            /* logging must never affect the round */
          }
          orphanHandoff = handOffOrphanVm(ownedVmId, phase, detail);
        } else {
          errors.push(`vm close/dispose: ${detail}`);
        }
        try {
          await controller.dispose();
        } catch {
          /* final fallback */
        }
        // MTLK-CLEANUP US-007: after the hard dispose, best-effort retry ONE
        // bounded reaper pass for exactly the handed-off VM. This is entirely
        // optional (the scheduler teardown + next pass reaper are the durable
        // retries) and can never change the round outcome. US-009 lets a gate
        // suppress it so the stopped leftover is observable.
        if (!opts.faults?.suppressImmediateReap) {
          tryImmediateOrphanReap(orphanHandoff);
        }
      }
    }
    if (suiteStore) {
      try {
        suiteStore.close();
      } catch (err) {
        errors.push(
          `suite store close: ${serializeMatchlockError(err, { phase: "suite-store-close", vmId, runId, invocationId })}`,
        );
      }
      suiteStore = null;
    }
    if (errors.length > 0) {
      const failure = new MatchlockRunnerError(
        "matchlock_cleanup_failed",
        `cleanup failed for invocation ${invocationId}: ${errors.join("; ")}`,
      );
      cleanupState.error = failure;
      throw failure;
    }
  };

  // Abort handling: record the abort and cancel the exact in-flight harness
  // exec. Full cleanup is driven deterministically at the next checkpoint
  // (awaited, so a cleanup failure is surfaced, never fire-and-forgotten).
  let aborted = false;
  let abortListener: (() => void) | null = null;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    if (harnessExec) {
      controller?.cancel(harnessExec.requestId).catch(() => {});
    }
  };

  // DSH-PROFILE-OVERLAY US-003: presence-only evidence that a dsh round never
  // rewrote the operator's install-derived profile module farm
  // (`<DSH_HOME>/profiles/node_modules`). The host farm is snapshotted BEFORE
  // the VM is created and once more after teardown; ONLY bounded counts are
  // recorded. A difference is NEVER a round failure: a concurrent native dsh
  // boot legitimately heals the host farm, and the controlled gate (US-005)
  // asserts byte-equality instead. Every log/snapshot step is contained so
  // evidence collection can never alter the round outcome.
  const dshFarmHome = opts.policy.harness === "dsh" ? opts.policy.configurationRoot : null;
  const dshFarmBefore = dshFarmHome ? snapshotDshProfileModuleLinks(dshFarmHome) : null;
  if (dshFarmHome && dshFarmBefore) {
    try {
      opts.onLog?.("info", "dsh profile-module farm pre-snapshot", {
        runId,
        invocationId,
        kind,
        linkCount: dshFarmBefore.size,
      });
    } catch {
      /* evidence must never affect the round */
    }
  }
  const recordDshFarmPostSnapshot = (): void => {
    if (!dshFarmHome || !dshFarmBefore) return;
    try {
      const after = snapshotDshProfileModuleLinks(dshFarmHome);
      const diff = dshProfileModuleLinksDiffer(dshFarmBefore, after);
      opts.onLog?.("info", "dsh profile-module farm post-snapshot", {
        runId,
        invocationId,
        kind,
        linkCount: after.size,
        added: diff.added.length,
        removed: diff.removed.length,
        retargeted: diff.retargeted.length,
      });
    } catch {
      /* evidence must never affect the round */
    }
  };

  try {
    // ── 2. progress resource attach (host-attested, before create) ──────
    if (opts.progressResource) {
      progressResource = attachRunProgressResource(opts.progressResource.runId, {
        runRoot: opts.progressResource.runRoot,
      });
    }

    // ── 3. guest pack identity (version-matched RO pack) ────────────────
    const manifest = readGuestPack(opts.helperPackHostPath);

    // ── 4. persisted image pin (never re-resolved/re-pinned by the runner) ─
    if (!opts.policy.resolvedImageDigest || !opts.policy.resolvedImageConfigDigest) {
      throw new MatchlockRunnerError(
        "image_identity_required",
        "Persisted Matchlock policy does not carry the required immutable image content/config pin; refusing to invoke (legacy/unpinned record).",
      );
    }
    const pin = {
      digest: opts.policy.resolvedImageDigest,
      config_digest: opts.policy.resolvedImageConfigDigest,
      tag: opts.policy.requestedImage,
    };

    // ── suite store (explicit host-owned evidence store) ────────────────
    if (opts.suite) {
      suiteStore = openHostSuiteStore(opts.suite.storePath);
    }

    // ── guest env (invocation-bound) ────────────────────────────────────
    const guestEnv = composeGuestEnv({
      invocationId,
      runId,
      agentId: opts.identity.agentId,
      manifest,
      imagePath: opts.imagePath,
      suite: suiteStore ? opts.suite : undefined,
      extra: opts.guestEnvOverrides,
    });

    const binding: HostBinding = {
      runId,
      invocationId,
      agentId: opts.identity.agentId,
      jobId: opts.identity.jobId,
      role: roleFromAgent(opts.identity.agentId, opts.role),
      admittedRoots:
        opts.suite && opts.suite.admittedRoots.length > 0
          ? opts.suite.admittedRoots
          : admittedRootsFromPolicy(opts.policy),
      helperProtocolVersion: manifest.helperProtocolVersion,
      helperBuildVersion: manifest.tamanduaBuildVersion,
    };

    // ── 5. FRESH controller per invocation (never shared) ───────────────
    // DSH-PROFILE-OVERLAY US-002: a dsh invocation mounts a COMPOSED DSH_HOME
    // whose install-derived profile module dirs come from a private per-run
    // overlay. The overlay root is host-attested: derived from the bound run
    // id and the Tamandua live state root (never guest input). The controller
    // creates the overlay dirs before create and removes the attested root
    // after the VM close is confirmed.
    const dshProfileOverlay =
      opts.policy.harness === "dsh"
        ? {
            runId,
            liveStateRoot: opts.progressResource?.runRoot
              ? path.resolve(opts.progressResource.runRoot, "..")
              : resolveLiveStateRoot(),
          }
        : undefined;
    controller = new MatchlockController(opts.policy, {
      rpcBinaryPath: opts.rpcBinaryPath ?? (process.env.TAMANDUA_MATCHLOCK_RPC_BIN?.trim() || undefined),
      rpcArgs: opts.rpcArgs,
      rpcEnv: opts.rpcEnv,
      helperPackHostPath: opts.helperPackHostPath,
      onLog: opts.onLog,
      requestTimeoutMs: opts.requestTimeoutMs,
      readyTimeoutMs: opts.readyTimeoutMs,
      execCancelSettleTimeoutMs: opts.execCancelSettleTimeoutMs,
      createTimeoutMs: opts.createTimeoutMs,
      progressResource: opts.progressResource ? { runId: opts.progressResource.runId } : undefined,
      ...(dshProfileOverlay ? { dshProfileOverlay } : {}),
      createEnv: guestEnv.env,
      ...(opts.progressResource?.runRoot
        ? {
            // Deterministic live-state override for tests: mount-plan's
            // progress-resource host dir must equal the attached resource dir.
            mountAdmission: {
              ...(process.env.HOME ? { home: process.env.HOME } : {}),
              liveStateRoot: path.resolve(opts.progressResource.runRoot, ".."),
            },
          }
        : {}),
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = onAbort;
    }

    // Abort BEFORE create: revoke, clean up, and never create a VM.
    if (opts.signal?.aborted || aborted) {
      await cleanup("invocation canceled by host before VM create");
      return {
        output: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        canceled: true,
        stderrTail: "invocation canceled by host before VM create",
        durationMs: timing.roundMs,
        ...timing.harnessFields(),
        invocationId,
        vmId: null,
        kind,
        runId,
        cleanupConfirmed: true,
        suiteAbsent: opts.suite === undefined,
        ...vmReapOutcome,
      };
    }

    // ── 6. create the FRESH VM with the persisted pin ───────────────────
    // US-006: VM setup starts here (create/boot start) and ends when the
    // harness exec starts; it is reported separately as vmSetupMs and NEVER
    // folded into harnessWallMs.
    timing.startVmSetup();
    const createdResult = await controller.prepareAndCreate(pin);
    controllerCreatedVm = true;
    vmId = createdResult.vmId;

    // Abort landed while the VM was being created: the late VM is an exact
    // owned cleanup obligation — positively close ONLY it, never launch work.
    if (aborted) {
      await cleanup("invocation canceled by host during VM create (late-create cleanup)");
      return {
        output: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        canceled: true,
        stderrTail: "invocation canceled by host during VM create",
        durationMs: timing.roundMs,
        ...timing.harnessFields(),
        invocationId,
        vmId,
        kind,
        runId,
        cleanupConfirmed: true,
        suiteAbsent: opts.suite === undefined,
        ...vmReapOutcome,
      };
    }

    // ── 7. guest bridge over exec_pipe (decode exactly once) ────────────
    const bridgeHandle = controller.execPipe(
      { command: GUEST_BRIDGE_SERVICE },
      (frame) => bridgeNotifyRef.current?.(frame),
      0, // long-lived bridge request; close() cancels it bounded
    );
    const bridgeCtx = mapExecPipeToBrokerPipe(bridgeHandle);
    const bridgeNotifyRef: { current: ((frame: MatchlockStreamFrame) => void) | null } = { current: null };
    bridgeNotifyRef.current = (frame: MatchlockStreamFrame): void => {
      if (frame.kind === "ready") return;
      bridgeCtx.notify(frame);
    };
    bridge = bridgeCtx;

    // ── 8. broker: real NativeStepServices over the shared registry (+suite) ─
    // The finalize_merge ledger seam is supplied ONLY here, from the same
    // host-owned store + canonical namespace the suite bridge serves. A
    // suite-absent invocation (or any native/no-flag caller) never has one, so
    // its gates stay byte-identical native.
    const ledgerEvidenceSource =
      suiteStore && opts.suite
        ? createHostSuiteLedgerEvidenceSource({ store: suiteStore, namespace: opts.suite.namespace })
        : undefined;
    const services: AuthoritativeStepServices = new NativeStepServices({
      binding,
      registry,
      workerOwnership: opts.workerOwnership ?? { jobId: opts.identity.jobId, pid: process.pid },
      progressResource: progressResource?.access,
      ...(ledgerEvidenceSource ? { ledgerEvidenceSource } : {}),
    });
    if (suiteStore && opts.suite) {
      suiteBridge = createHostSuiteBridge({
        invocationId,
        runId,
        agentId: opts.identity.agentId,
        jobId: opts.identity.jobId,
        registry,
        store: suiteStore,
        namespace: opts.suite.namespace,
        admittedRoots: opts.suite.admittedRoots,
      });
    }
    // US-008: the host-attested merge service is constructed OUTSIDE this
    // module (scheduler seam `merge-invocation-wiring.ts`) and forwarded here
    // verbatim. Guest input/env can never enable it; absence keeps the merge
    // ops UNSUPPORTED.
    if (opts.merge) {
      mergeService = opts.merge;
    }
    broker = createHostBroker({
      binding,
      services,
      pipe: bridgeCtx.pipe,
      ...(suiteBridge ? { suite: suiteBridge } : {}),
      ...(mergeService ? { merge: mergeService } : {}),
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 20000,
      serviceTimeoutMs: opts.serviceTimeoutMs ?? 120000,
    });

    // Strict HELLO before any harness work: a build/layout mismatch refuses
    // here (broker ready {ok:false}); no guest command was served.
    const handshakeDeadlineMs = (opts.handshakeTimeoutMs ?? 20000) + 5000;
    const hello = await Promise.race([
      broker.ready,
      new Promise<{ ok: boolean; reason?: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: "broker handshake deadline exceeded" }), handshakeDeadlineMs),
      ),
    ]);
    if (!hello.ok) {
      await cleanup(`guest bridge handshake refused before work: ${hello.reason ?? "unknown"}`);
      throw new MatchlockRunnerError("guest_bridge_unavailable", `guest bridge handshake refused before work: ${hello.reason ?? "unknown"}`);
    }

    // Abort landed while the bridge was being established (or during create):
    // revoke + clean up and never start the harness.
    if (aborted) {
      await cleanup("invocation canceled by host after VM create");
      return {
        output: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        canceled: true,
        stderrTail: "invocation canceled by host after VM create",
        durationMs: timing.roundMs,
        ...timing.harnessFields(),
        invocationId,
        vmId,
        kind,
        runId,
        cleanupConfirmed: true,
        suiteAbsent: opts.suite === undefined,
        ...vmReapOutcome,
      };
    }

    // ── 9. harness exec (probe/work) with remaining-wall-budget timeout ──
    // The harness is invoked through execPipe with stdin EOF'd immediately
    // ("stdin closed"), so the exact request id is available for cancellation.
    const harnessArgv = opts.harnessArgv ?? ["pi", "--print", "--mode", "json"];
    const harnessCommand = [...harnessArgv.map((a) => quoteShellArg(a)), quoteShellArg(opts.promptText)].join(" ");
    const capture = createCaptureState(opts.maxOutputBytes ?? MAX_OUTPUT_DEFAULT);
    // US-006: VM setup ends and the harness interval begins at the exact
    // moment the guest harness exec is issued.
    timing.startHarnessExec();
    const harnessHandle = controller.execPipe(
      { command: harnessCommand, working_dir: opts.workingDirectoryForHarness },
      (frame) => captureNotify(capture, frame),
      0, // bounded by the runner's wall-clock timeout + cancel
    );
    harnessExec = harnessHandle;
    // Close stdin immediately (bounded by the client ready gate).
    harnessHandle.stdin.eof().catch(() => {});

    const wallDeadline = new Deadline(timeoutMs);
    let settled = false;
    let execExitCode: number | null = null;
    let execError: unknown = null;
    const settle = harnessHandle.result.then(
      (r) => {
        execExitCode = r.exit_code;
        settled = true;
        // MTLK-CLEANUP US-005: the harness process has exited; a later
        // close/dispose failure is now a non-fatal cleanup nuisance.
        harnessExited = true;
      },
      (err: unknown) => {
        execError = err;
        settled = true;
        // US-005: track the harness-exited state for the cleanup policy. Per
        // the story, "harnessExec settled / result captured" is the boundary.
        harnessExited = true;
      },
    );

    // Winner race: exec settled, wall budget expired, or the host aborted.
    const outcome = await new Promise<"exec" | "timeout" | "abort">((resolve) => {
      settle.then(() => resolve("exec"), () => resolve("exec"));
      const remaining = wallDeadline.remainingMs();
      const timer = setTimeout(() => resolve("timeout"), Math.max(1, remaining));
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve("abort");
        },
        { once: true },
      );
    });

    let timedOut = false;
    let canceled = false;
    let truncated = capture.overflowed;
    let exitCode: number | null = null;
    let signal: string | null = null;
    // US-006 (H1/D1): a REJECTED harness exec (RPC/protocol/transport error,
    // e.g. the VM relay dropping the final stdout frames) must never be
    // swallowed into a clean-looking empty round. The guest may already have
    // completed the step through the host broker, so we do NOT throw (that
    // would force-fail a run whose work landed) — instead we surface the real
    // error (code + bounded message) as bounded diagnostics on the result.
    let harnessExecError: string | null = null;
    if (outcome === "exec") {
      if (execExitCode !== null) exitCode = execExitCode;
      if (execError !== null) harnessExecError = boundMatchlockErrorText(describeMatchlockError(execError), MATCHLOCK_ERROR_TAIL_MAX_BYTES);
    } else {
      // Timeout or abort: cancel the exact in-flight harness exec, then wait
      // bounded for its settlement (never hang).
      if (!settled) {
        try {
          await controller.cancel(harnessHandle.requestId);
        } catch {
          /* best effort */
        }
        await Promise.race([settle, new Promise<void>((r) => setTimeout(r, EXEC_SETTLE_GRACE_MS))]);
      }
      if (outcome === "timeout") timedOut = true;
      if (outcome === "abort" || aborted) canceled = true;
      if (execExitCode !== null) exitCode = execExitCode;
      if (!timedOut && !canceled && execError !== null) signal = "SIGTERM";
    }
    if (truncated && !settled) {
      try {
        await controller.cancel(harnessHandle.requestId);
      } catch {
        /* best effort */
      }
      await Promise.race([settle, new Promise<void>((r) => setTimeout(r, 2000))]);
    }

    const roundOutput = captureStdoutText(capture);
    // US-006: the harness interval ends as soon as the exec settled (exit,
    // rejection, timeout or cancel) — the bounded stream drain below is NOT
    // harness process time.
    timing.endHarnessExec();
    const roundDurationMs = timing.roundMs;
    // US-006 (H1/D1): the transport can deliver the exec result one tick
    // before the last stream frames (a different matchlock version, or a
    // relay that settles its waiter first). Give any already-buffered frames a
    // bounded chance to be dispatched before the capture is finalized: on a
    // normal round the frames precede the result and this is a no-op.
    await drainPendingStreamFrames(capture);
    const capturedOutput = captureStdoutText(capture) || roundOutput;
    // Surface (never swallow) a rejected exec: append the real bounded error to
    // the stderr tail so the round is not mistaken for a clean empty exit.
    const capturedStderrTail = tailText(capture.stderr, 8192);
    const stderrTail =
      harnessExecError !== null
        ? `${capturedStderrTail ? `${capturedStderrTail}\n` : ""}harness exec failed: ${harnessExecError}`
        : capturedStderrTail;
    const canceledReason =
      outcome === "abort" || aborted ? "invocation canceled by host (AbortSignal)" : undefined;

    // ── 10. terminal teardown (revoke once, release leases, close VM) ───
    const cleanupReason =
      canceledReason ?? (timedOut ? `harness exceeded ${timeoutMs}ms wall budget` : "invocation completed");
    await cleanup(cleanupReason);

    return {
      output: capturedOutput,
      exitCode,
      signal,
      timedOut,
      ...(canceledReason ? { canceled: true } : {}),
      truncated,
      stderrTail,
      ...(harnessExecError !== null ? { harnessExecError } : {}),
      durationMs: roundDurationMs,
      ...timing.harnessFields(),
      invocationId,
      vmId,
      kind,
      runId,
      // US-005: a post-harness close/dispose failure keeps the round but is
      // reported (cleanupConfirmed=false + bounded vmCleanupFailure) so the
      // caller can see the VM was handed to the reaper, not disposed.
      cleanupConfirmed: vmCleanupFailure === null,
      ...(vmCleanupFailure !== null ? { vmCleanupFailure } : {}),
      suiteAbsent: opts.suite === undefined,
      ...vmReapOutcome,
    };
  } catch (err) {
    if (!cleanupDone) {
      try {
        await cleanup("infrastructure failure during invocation");
      } catch (cleanupErr) {
        // Cleanup failure is surfaced (never swallowed) as its own typed error.
        throw classifyInvocationError(cleanupErr, "cleanup");
      }
    }
    if (cleanupState.error !== null && cleanupState.error.code === "matchlock_cleanup_failed") {
      // A cleanup failure on a NORMAL path (no earlier exception) must not be
      // hidden — surface it distinctly so the caller can distinguish a failed
      // round from a failed cleanup.
      const cleanupErr = cleanupState.error;
      const originalIsCleanupFailure =
        err instanceof MatchlockRunnerError && err.code === "matchlock_cleanup_failed";
      if (!originalIsCleanupFailure) {
        throw cleanupErr;
      }
    }
    throw classifyInvocationError(err, "runMatchlockInvocation");
  } finally {
    // Post-teardown farm evidence (DSH-PROFILE-OVERLAY US-003): taken after the
    // VM close/dispose so it reflects the state an in-VM round left behind.
    recordDshFarmPostSnapshot();
    if (abortListener && opts.signal) {
      try {
        opts.signal.removeEventListener("abort", abortListener);
      } catch {
        /* ignore */
      }
    }
  }
}
