/**
 * hermes-invocation-runner.ts — US-002 (MTLK-HERMES-EXEC).
 *
 * The host-side INVOCATION RUNNER for ONE opted-in Hermes invocation (launch
 * probe OR work round): executes the IMAGE's Hermes inside a FRESH Matchlock
 * VM by composing the immutable union components exactly as the component
 * contracts prescribe — the Hermes analogue of
 * src/installer/matchlock/pi-invocation-runner.ts (MTLK-PI-EXEC US-001):
 *
 *   frozen-submission adapter plan (resolveHermesAdapterPlan — typed refusal
 *     thrown BEFORE any VM create / broker op / registry effect; never daemon
 *     HOME or later ambient state)
 *     → config mount scope admission (canonical realpath of the adapter-selected
 *       host effective dir, whole-dir RW at the approved guest HERMES_HOME
 *       mapping; broad host HOME / live .tamandua admin state / lexical-only
 *       prefix admission never become mount sources)
 *     → registry.admitInvocation (host-owned, BEFORE any broker/guest work)
 *     → progress-resource attach (host <state>/runs/<runId>/progress-resource)
 *     → version-matched RO guest pack validation
 *     → FRESH MatchlockController per invocation with the persisted image pin
 *       (prepareAndCreate(expected) — never re-resolved/re-pinned by the
 *       runner, never a VM shared between probe and work)
 *     → guest bridge service over controller.execPipe (base64 stream frames
 *       decoded EXACTLY once and mapped onto a broker HostPipePair)
 *     → scoped host broker over the REAL NativeStepServices (same shared
 *       HostInvocationRegistry, real step-ops DB) and, when the host wired a
 *       suite-capable ledger, createHostSuiteBridge over the SAME registry
 *       lease + explicit host-owned suite store + canonical namespace; a
 *       host-attested HostMergeServices supplied by the scheduler seam
 *       (`RunHermesInvocationOptions.merge`, built from immutable run scope by
 *       `merge-invocation-wiring.ts`) is forwarded verbatim so an opted-in
 *       hermes merge workflow can serve the scoped merge.authorize /
 *       merge.report bridge ops; absence keeps them UNSUPPORTED (no fallback)
 *     → the guest Hermes harness runs `hermes --profile <name> chat
 *       --max-turns … --yolo -Q -q <prompt>` (guest step claim/complete/fail
 *       go through the host broker ONLY via the packed guest CLI — never the
 *       host DB/admin surface)
 *     → output/session handling: Hermes stdout is PLAIN TEXT (not pi JSON);
 *       the session id comes from the actual native launch/trailer
 *       conventions — the authoritative stderr trailer (extractSessionTrailer),
 *       decoded byte-exactly once across arbitrary frame/chunk boundaries —
 *       with a mapped-store fallback (H2): when the trailer was lost, the
 *       round's OWN session row (the single row inserted after a pre-harness
 *       rowid snapshot) is recovered from the mapped store; raw stdout and raw
 *       stderr are preserved as separate artifacts; the plain-text final
 *       message (trailer stripped) is the round's result
 *     → usage/store projection: token totals are read INSIDE the still-owned
 *       VM by a small trusted guest helper AFTER harness completion and
 *       BEFORE the confirmed VM close (qualified VFS confinement) — the runner
 *       NEVER opens the guest-writable mapped config store with host-side
 *       SQLite. Total = input + output + cache_write only (cache_read and
 *       reasoning excluded; no double count, no inference from unrelated
 *       sessions). Genuinely missing/ambiguous/truncated token data is
 *       reported unavailable/ambiguous — NEVER a fabricated zero, and never
 *       "newest wins" when more than one row was created.
 *     → terminal teardown that synchronously revokes invocation authority
 *       exactly once (registry.revokeInvocation + broker + suite seams),
 *       releases exact leases, and POSITIVELY closes/disposes ONLY this
 *       invocation's owned VM with a positive close timeout.
 *
 * No host Hermes findBinary/probe/spawn, no installation from host, no native
 * fallback, no shared VM, no fake success. A refused adapter plan, an
 * unavailable backend or an unsupported capability refuses BEFORE any VM
 * create. Cleanup failures are surfaced (thrown), never swallowed.
 *
 * The return value is a HarnessRoundResult-compatible object so the
 * scheduler's existing post-round processing (output handling, session/usage
 * attribution, instant-fail/backoff tracking, step auto-completion, orphan
 * recovery) can be reused unchanged.
 *
 * The shared engine helpers (composeGuestEnv, readGuestPack, quoteShellArg,
 * classifyInvocationError, admittedRootsFromPolicy, mapExecPipeToBrokerPipe,
 * MatchlockRunnerError, GUEST_RUNTIME_BIN, GUEST_BRIDGE_SERVICE …) are REUSED
 * from pi-invocation-runner.ts unchanged — that module's public surface and
 * its tests stay byte-identical; only the pi entrypoint test contracts are
 * preserved.
 */

import fs from "node:fs";
import path from "node:path";
import type { HarnessRoundResult } from "../harness-adapter.js";
import type { ExecutionIsolation } from "./policy.js";
import { MatchlockController, MatchlockControllerError } from "./controller.js";
import { decodeFrameBytes, type MatchlockPipeHandle } from "./rpc-client.js";
import type { MatchlockStreamFrame } from "./types.js";
import type { AuthoritativeStepServices, HostBinding } from "./broker-services.js";
import { NativeStepServices, type HostWorkerOwnership } from "./native-step-services.js";
import { HostInvocationRegistry } from "./native-step-invocations.js";
import type { GuestPackManifest } from "./guest-pack-builder.js";
import { attachRunProgressResource, assertSafeRunId, type RunProgressResource } from "./progress-resource.js";
import { resolveRunRoot } from "../paths.js";
// MATCHLOCK-OBS US-005 (bead tamandua-6sy.33.33): the shared reaper module owns
// the node:child_process spawn for post-close VM evidence capture + removal.
// This runner imports ONLY that seam and keeps no direct child_process
// dependency (mirrors the pi/dsh runner's US-004 wiring).
import { captureAndRemoveVm } from "./vm-evidence.js";
// MTLK-CLEANUP US-003/US-005: the per-run orphan store the runner hands a VM to
// when its post-harness close/dispose fails, so the reaper (US-006) and the
// run's completion cleanup (US-007) retry the disposal by exact id. The module
// is Node-core only + the zero-import runner-error leaf, so importing it keeps
// the runner's dependency shape (and cycle safety) intact.
import { writeOrphanVm, type VmOrphanVmRecord } from "./vm-orphans.js";
// MTLK-CLEANUP US-007/US-008: the run-teardown/operator reaper entry point.
// Importing it keeps the runner's dependency shape (vm-reaper -> vm-evidence
// owns the spawn; the runner still has NO direct node:child_process import) and
// there is no cycle back into this module.
import { reapOrphanedMatchlockVms } from "./vm-reaper.js";
import { createHostSuiteBridge, type HostSuiteBridge } from "./suite-host-bridge.js";
import { openHostSuiteStore, type HostSuiteStore } from "./host-suite-store.js";
import {
  resolveHermesAdapterPlan,
  type HermesAdapterPlan,
} from "./hermes-adapter.js";
import type {
  FrozenHermesSubmissionInput,
} from "./hermes-profile.js";
import type { HermesGuestLaunch } from "./hermes-launch.js";
import { computeHermesTokenTotal } from "./hermes-store.js";
import type { HermesStoreScan, HermesStoreStatus } from "./hermes-store.js";
// Reused shared-engine helpers from the (unchanged) pi invocation runner.
import {
  composeGuestEnv,
  readGuestPack,
  quoteShellArg,
  classifyInvocationError,
  admittedRootsFromPolicy,
  GUEST_BRIDGE_SERVICE,
  mapExecPipeToBrokerPipe,
  type MatchlockInvocationIdentity,
  type MatchlockInvocationKind,
  type MatchlockInvocationProgress,
  type MatchlockInvocationSuite,
  type ExecPipeBrokerBridge,
  type ComposedGuestEnv,
} from "./pi-invocation-runner.js";
// MTLK-INTEGRATE US-003: the base error comes from the LEAF so `extends
// MatchlockRunnerError` below cannot TDZ when this module is reached through
// the pi-invocation-runner cycle (scheduler-dsh entry point).
import {
  MatchlockRunnerError,
  describeMatchlockError,
  boundMatchlockErrorText,
  serializeMatchlockError,
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
} from "./runner-error.js";
import {
  isBroadHostSource,
  shadowsProtectedGuestRoot,
  type MountAdmissionContext,
} from "./mount-plan.js";
import type { HostBrokerHandle } from "./broker.js";
import { createHostBroker } from "./broker.js";
import { Deadline, type ClockFn } from "../../lib/instant.js";
import { MatchlockRoundTiming } from "./round-timing.js";
// MTLK-ALL-WORKFLOWS US-001: the host-attested scoped merge service is built
// OUTSIDE this module (scheduler seam `merge-invocation-wiring.ts`) and
// forwarded here verbatim; guest input/env can never enable it. When absent
// the broker keeps every merge.authorize / merge.report request UNSUPPORTED.
import type { HostMergeServices } from "./host-merge-services.js";

// ── public types ───────────────────────────────────────────────────────

export type HermesInvocationKind = MatchlockInvocationKind;

/**
 * Typed runner/infrastructure error (fail-closed; distinct from a guest round
 * outcome). Subclasses MatchlockRunnerError so the scheduler's typed
 * force-fail handling treats Hermes runner failures uniformly with pi.
 */
export class HermesInvocationError extends MatchlockRunnerError {}

/**
 * A REFUSED Hermes adapter selection (invalid profile / unreadable /
 * malformed / non-regular / explicit non-local terminal.backend) or a refused
 * Hermes config mount scope. Thrown BEFORE any VM create / broker op /
 * registry effect; refused config never yields a launch descriptor.
 */
export class HermesSelectionRefusedError extends HermesInvocationError {}

export interface RunHermesInvocationOptions {
  /** Persisted version-2 ExecutionIsolation policy (carries the image pin).
   *  The runner derives a Hermes-scoped create policy from it (the effective
   *  selected Hermes config directory replaces the pi configuration-root
   *  pair); the policy's work mounts / original repo / git metadata roots are
   *  carried over unchanged. */
  policy: ExecutionIsolation;
  /** Host-bound invocation identity. */
  identity: MatchlockInvocationIdentity;
  kind: HermesInvocationKind;
  /** Work/probe prompt text passed as the Hermes `-q` prompt argument. */
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
   * MTLK-ALL-WORKFLOWS US-001: host-attested, already-constructed merge
   * authorization/receipt service for an opted-in merge workflow. The
   * scheduler seam (`merge-invocation-wiring.ts`) builds it from the immutable
   * run merge context and passes it here; the runner only forwards it to the
   * broker. When absent every merge.authorize / merge.report request is
   * refused UNSUPPORTED (no host fallback), matching the pi runner.
   */
  merge?: HostMergeServices;
  /** Shared host invocation registry for the (run, agent) authority lifetime.
   *  When omitted the runner owns a single-invocation registry (tests). */
  registry?: HostInvocationRegistry;
  /** Host path to the built versioned RO guest helper pack. */
  helperPackHostPath: string;
  /** Role string for the HostBinding (informational; default derived from agent id). */
  role?: string;
  /**
   * FROZEN submission-time inputs captured at run creation (homeDir + env
   * snapshot + cwd). The Hermes adapter plan is resolved from ONLY these —
   * never daemon HOME or later ambient state.
   */
  submission: FrozenHermesSubmissionInput;
  /** Hermes launch options (defaults mirror buildHermesGuestLaunch). */
  hermes?: {
    /** Guest launcher binary basename (default `hermes`); test/synthetic override. */
    binary?: string;
    /** `--max-turns` (default 8192). */
    maxTurns?: number;
    /** Private guest HOME (default /root). */
    guestHome?: string;
  };
  /** The image's effective guest PATH used as the base for the helper-pack
   *  prepend (the image's Dockerfile PATH is preserved; only
   *  /workspace/runtime/bin is prepended). When omitted a conservative POSIX
   *  default is used (image PATH discovery/qualification is a later stage —
   *  see the pi runner's notes). */
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
  /** Mount-plan admission context override (deterministic home/live-state root for tests). */
  mountAdmission?: MountAdmissionContext;
  /** Trusted guest usage-helper argv prefix (default ["node"]); the store dir
   *  and session ref are appended. Test seam to pin a node binary. */
  usageHelperArgv?: string[];
  /** Positive budget (ms) for the in-VM usage projection exec (default 30s). */
  usageHelperTimeoutMs?: number;
  /**
   * US-006 test seam: monotonic clock used by the round timing tracker. The
   * production default is `monotonicNow`; a deterministic test injects a
   * scripted clock to prove `harnessWallMs` excludes VM setup and `vmSetupMs`
   * carries it without running a real VM.
   */
  clock?: ClockFn;
  onLog?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

/** Usage/store projection carried by the round result (never a fabricated zero). */
export interface HermesRoundUsage {
  status: HermesStoreStatus;
  /** input + output + cache_write token total, when status is "ok". */
  tokens?: number;
  /** Bounded evidence strings (mapped store paths only; never raw config). */
  evidence: string[];
}

/** Runner outcome extras attached to the HarnessRoundResult-compatible object. */
export interface HermesInvocationOutcome {
  /** Fresh per-invocation uuid. */
  invocationId: string;
  /** VM id created for this invocation (null when none was created). */
  vmId: string | null;
  kind: HermesInvocationKind;
  /** Bare run id. */
  runId: string;
  /** True when the round ended by the host cancel/abort signal. */
  canceled?: boolean;
  /** Cleanup was fully confirmed (VM closed or no VM ever created). */
  cleanupConfirmed?: boolean;
  /** True when the invocation had NO host suite wiring (suite-absent). */
  suiteAbsent?: boolean;
  /**
   * MATCHLOCK-OBS US-005: true only when the owned VM's evidence was captured
   * and the VM was POSITIVELY removed after a confirmed close. Absent when no
   * VM was ever created or the close was never confirmed (dispose-only).
   */
  vmRemoved?: boolean;
  /** MATCHLOCK-OBS US-005: evidence destination, or null when nothing captured. */
  vmLogsCopiedTo?: string | null;
  /** MATCHLOCK-OBS US-005: bounded removal failure description (absent on success). */
  vmRemovalError?: string;
  /**
   * MTLK-CLEANUP US-008: bounded serialized detail of a close/dispose failure
   * that happened AFTER the hermes harness process exited. The round result is
   * still returned (non-fatal); the VM was handed to the reaper via the per-run
   * orphan store. Absent when the close confirmed (or no VM was created).
   */
  vmCleanupFailure?: string;
  /** Session id recovered from the actual native launch/trailer conventions
   *  (authoritative stderr trailer preferred; stdout fallback) or, when the
   *  trailer was lost, from the round's own newly created mapped-store row.
   *  Null when no session could be recovered (incomplete accounting, never
   *  fabricated). */
  sessionId: string | null;
  /** Where the session id was recovered from: the trailer stream or the
   *  mapped-store fallback (`store`). */
  sessionSource: "stderr" | "stdout" | "store" | null;
  /** Token/usage projection from the selected MAPPED store (guest-helper read). */
  usage: HermesRoundUsage;
  /** Bounded raw stdout artifact, preserved separately from the final message
   *  (may still carry a stdout-side trailer line before stripping). */
  rawStdout: string;
  /** Bounded raw stderr artifact, preserved separately (authoritative trailer source). */
  rawStderr: string;
  /** True when the usage projection could not run because no session id was
   *  recovered from the output or from the mapped store (incomplete
   *  accounting). */
  usageSkippedNoSession?: boolean;
}

export type HermesInvocationResult = HarnessRoundResult & HermesInvocationOutcome;

// ── constants / helpers ────────────────────────────────────────────────

const MAX_OUTPUT_DEFAULT = 10 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_SECONDS = 30;
const DEFAULT_IMAGE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const EXEC_SETTLE_GRACE_MS = 10_000;
const USAGE_HELPER_TIMEOUT_DEFAULT_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Race `p` against a bounded timer. The timer is ALWAYS cleared once the
 *  race settles so a finished invocation never keeps the host alive on a
 *  stray wall-clock timer. A timeout resolves `onTimeout()`. */
function raceOrTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => resolve(onTimeout()), Math.max(1, ms));
    p.then(
      (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function bareRunId(runId: string): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  if (!UUID_RE.test(bare)) {
    throw new HermesInvocationError("invalid_run_id", `Refusing malformed run id: ${JSON.stringify(runId)}`);
  }
  return bare;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function roleFromAgent(agentId: string, fallback?: string): string {
  if (fallback) return fallback;
  const idx = agentId.lastIndexOf("_");
  if (idx >= 0 && idx < agentId.length - 1) return agentId.slice(idx + 1);
  return "developer";
}

/**
 * The EFFECTIVE Matchlock HOME the controller's RPC child is spawned with:
 * an explicit `rpcEnv.HOME` wins, else the host process HOME (mirrors
 * `MatchlockController.effectiveRpcHome`). MTLK-CLEANUP US-005 uses this for
 * the orphan record so the reaper/handoff point at the same store the VM was
 * created in.
 */
function effectiveMatchlockHome(rpcEnv?: Record<string, string>): string {
  const fromRpcEnv = rpcEnv?.HOME;
  if (typeof fromRpcEnv === "string" && fromRpcEnv.length > 0) return fromRpcEnv;
  return process.env.HOME ?? "";
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

// ── mount scope admission (canonical realpath; lexical prefix is not confinement) ─

export interface HermesConfigMountSpec {
  /** Canonical realpath of the adapter-selected host effective config dir. */
  hostConfigDir: string;
  /** Guest HERMES_HOME (the approved stable mapping) the whole dir is mounted at. */
  guestConfigDir: string;
  /** True when the plan's captured selection is a named profile. */
  isNamedProfile: boolean;
}

/**
 * Admit the effective selected Hermes config directory for whole-dir RW
 * mounting at the approved guest HERMES_HOME override.
 *
 * Confinement is by CANONICAL REALPATH of the adapter-selected host root, not
 * a lexical prefix predicate: a symlinked profile/home that resolves to a
 * broad host source (a whole operator home, live Tamandua admin state,
 * process/device tree or credential store) or that no longer names a real
 * directory is REFUSED here with bounded diagnostics. `ctx` pins the operator
 * home / live-state root for deterministic tests; production uses the real
 * mount-plan defaults.
 */
export function admitHermesConfigMount(
  plan: HermesAdapterPlan,
  ctx?: MountAdmissionContext,
): HermesConfigMountSpec {
  const effective = plan.capturedIdentity.hostEffectiveDir;
  if (typeof effective !== "string" || effective.trim() === "") {
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      "The Hermes adapter plan carries no effective host config directory; refusing to mount.",
    );
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(effective);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      `The effective Hermes config directory cannot be canonicalized (${message}); refusing to mount a host source that cannot be confined by realpath.`,
    );
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(canonical);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      `The canonical Hermes config directory ${canonical} is not a readable directory (${message}); refusing to substitute an image default.`,
    );
  }
  if (!st.isDirectory()) {
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      `The canonical Hermes config path ${canonical} is not a directory; the ENTIRE selected directory must be mounted RW — refusing to mount a non-directory source.`,
    );
  }
  if (isBroadHostSource(canonical, ctx)) {
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      `The canonical Hermes config source ${canonical} is a broad host source (whole home, live Tamandua admin state, process/device tree or credential store); a lexical prefix admission is not confinement — refusing to mount.`,
    );
  }
  const guest = plan.profile.guestHermesHome;
  if (!guest || shadowsProtectedGuestRoot(guest)) {
    throw new HermesSelectionRefusedError(
      "hermes_config_scope_refused",
      `The approved guest HERMES_HOME mapping ${guest ?? "(none)"} shadows a protected guest root; refusing the Hermes config mount.`,
    );
  }
  return {
    hostConfigDir: canonical,
    guestConfigDir: guest,
    isNamedProfile: plan.profile.isNamedProfile,
  };
}

/**
 * Derive the Hermes-scoped create policy from the persisted base policy: the
 * effective selected Hermes config directory (canonical realpath) replaces the
 * pi configuration-root pair so mount-plan's whole-directory RW host_fs mount
 * lands at the approved guest HERMES_HOME. The immutable image pin, work
 * mounts, original repo and git metadata roots are carried over unchanged.
 */
export function deriveHermesCreatePolicy(
  policy: ExecutionIsolation,
  mount: HermesConfigMountSpec,
): ExecutionIsolation {
  return {
    ...policy,
    configurationRoot: mount.hostConfigDir,
    guestConfigurationRoot: mount.guestConfigDir,
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

/** Decode each base64 frame EXACTLY once into bytes (chunk-boundary safe). */
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

function captureBytes(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/** Bounded grace for late stream frames to reach an empty capture (US-006). */
const FRAME_DRAIN_GRACE_MS = 200;

/**
 * US-006 (H1/D1): settle pending stream frames before the capture is read.
 * See the pi invocation runner's helper of the same name: a different runtime
 * version (or a relay that settles its waiter before flushing the last chunk)
 * can deliver the exec result before the final stdout frame. When the bounded
 * capture is still empty, wait a short bounded grace; a non-empty capture is
 * returned immediately.
 */
async function drainPendingStreamFrames(
  state: { stdoutBytes: number; overflowed: boolean },
  ms = FRAME_DRAIN_GRACE_MS,
): Promise<void> {
  if (state.stdoutBytes > 0 || state.overflowed) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ── the trusted in-VM usage projection helper ─────────────────────────

/**
 * Small TRUSTED guest helper (host-authored, Node-core only) executed INSIDE
 * the still-owned VM. It opens the explicit mapped guest store (never
 * os.homedir / process.env fallback) with guest-side SQLite under qualified
 * VFS confinement and prints ONE line of JSON with a session-metadata/
 * token-only projection — never session bodies or private reasoning. The host
 * runner maps the projection onto the established unavailable-vs-zero
 * semantics using pure helpers only (no host-side SQLite open of the
 * guest-writable mapped store in the runner path).
 *
 * Three modes (selected by the JSON request argument):
 *   - `inventory`    — pre-harness snapshot of `MAX(rowid)`/row count, so the
 *                      round's OWN newly inserted session can be identified
 *                      afterwards without any clock dependence.
 *   - `by-id`        — the authoritative trailer's session id.
 *   - `newest-after` — store fallback when the trailer was lost: the single
 *                      session row inserted after the pre-harness snapshot
 *                      (H2 recovery). More than one new row is AMBIGUOUS,
 *                      never "newest wins" (never a borrowed session).
 *
 * Exit 0 on every handled outcome; a parse failure upstream is treated as
 * truncated evidence, never a verified zero.
 */
export const GUEST_USAGE_HELPER_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
/* tamandua-guest-usage-helper — modes: inventory | by-id | newest-after */
// With node -e, argv[0] is the node binary and the first real argument
// (the store dir) lands at index 1 (the double-dash separator is consumed).
const argv = process.argv.slice(1);
const storeDir = argv[0];
let request = null;
try { request = JSON.parse(argv[1] || "null"); } catch { request = null; }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (!storeDir || !request || typeof request.mode !== "string") { out({ status: "bad-args" }); process.exit(0); }
const dbPath = path.join(storeDir, "state.db");
if (!fs.existsSync(dbPath)) {
  out({ status: "no-db", evidence: ["state.db not found under the mapped Hermes store"] });
  process.exit(0);
}
let db = null;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  if (!hasTable) {
    out({ status: "no-table", evidence: ["mapped store has no sessions table"] });
    process.exit(0);
  }
  const cols = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((r) => r.name);
  const required = ["input_tokens", "output_tokens", "cache_write_tokens"];
  const missing = required.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    out({ status: "missing-columns", evidence: ["sessions table missing required columns: " + missing.join(", ")] });
    process.exit(0);
  }
  const project = (row) => ({
    id: row.id === null || row.id === undefined ? null : String(row.id),
    input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens === null ? null : Number(row.output_tokens),
    cache_read_tokens: row.cache_read_tokens === null ? null : Number(row.cache_read_tokens),
    cache_write_tokens: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
  });
  const selectAll = "SELECT rowid AS __rowid, id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions ";
  if (request.mode === "inventory") {
    const maxRow = db.prepare("SELECT MAX(rowid) AS m FROM sessions").get();
    const countRow = db.prepare("SELECT COUNT(*) AS c FROM sessions").get();
    out({ status: "ok", maxRowid: maxRow && maxRow.m !== null ? Number(maxRow.m) : null, count: countRow ? Number(countRow.c) : 0 });
    process.exit(0);
  }
  if (request.mode === "by-id") {
    const sessionRef = typeof request.sessionId === "string" ? request.sessionId : "";
    if (!sessionRef) { out({ status: "bad-args", evidence: ["by-id mode requires a sessionId"] }); process.exit(0); }
    const row = db.prepare(selectAll + "WHERE id = ?").get(sessionRef);
    if (!row) { out({ status: "session-not-found", evidence: ["session row not found in the mapped store"] }); process.exit(0); }
    out({ status: "row", row: project(row), candidateCount: 1 });
    process.exit(0);
  }
  if (request.mode === "newest-after") {
    const minRowid = typeof request.minRowid === "number" && Number.isFinite(request.minRowid) ? request.minRowid : null;
    const rows = minRowid === null
      ? db.prepare(selectAll + "ORDER BY rowid DESC").all()
      : db.prepare(selectAll + "WHERE rowid > ? ORDER BY rowid DESC").all(minRowid);
    if (rows.length === 0) { out({ status: "no-new-session", evidence: ["no sessions row was created during the round"] }); process.exit(0); }
    if (rows.length > 1) { out({ status: "ambiguous-new-session", candidateCount: rows.length, evidence: [String(rows.length) + " sessions rows were created during the round"] }); process.exit(0); }
    out({ status: "row", row: project(rows[0]), candidateCount: 1 });
    process.exit(0);
  }
  out({ status: "bad-args", evidence: ["unknown usage helper mode: " + String(request.mode)] });
} catch (err) {
  out({ status: "read-error", evidence: ["mapped store read error: " + String((err && err.message) || err)] });
} finally {
  try { if (db) db.close(); } catch { /* best effort */ }
}
`;

export interface GuestStoreProjection {
  status:
    | "ok"
    | "row"
    | "no-db"
    | "no-table"
    | "missing-columns"
    | "session-not-found"
    | "no-new-session"
    | "ambiguous-new-session"
    | "read-error"
    | "bad-args";
  row?: {
    id?: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
  };
  candidateCount?: number;
  /** `inventory` mode: highest sessions rowid at snapshot time (null when empty). */
  maxRowid?: number | null;
  /** `inventory` mode: sessions row count at snapshot time. */
  count?: number;
  evidence?: string[];
}

/**
 * Map a guest helper by-id projection onto the established HermesStoreScan
 * semantics: total = input + output + cache_write (cache_read/reasoning
 * excluded); missing/ambiguous/truncated token data is unavailable/ambiguous,
 * NEVER a fabricated zero. Pure host-side mapping — the SQLite read happened
 * inside the VM.
 */
export function projectHermesStoreScan(
  projection: GuestStoreProjection,
  sessionRef: string,
): HermesStoreScan {
  const evidence = (extra?: string[]): string[] => [
    `session ${sessionRef} projection from the mapped store`,
    ...(extra ?? []),
  ];
  switch (projection.status) {
    case "no-db":
      return { status: "unavailable", evidence: evidence(projection.evidence) };
    case "no-table":
      return { status: "unavailable", evidence: evidence(projection.evidence) };
    case "missing-columns":
      return { status: "unavailable", evidence: evidence(projection.evidence) };
    case "session-not-found":
      return { status: "unavailable", evidence: evidence(projection.evidence) };
    case "no-new-session":
      return { status: "unavailable", evidence: evidence(projection.evidence) };
    case "ambiguous-new-session":
      return { status: "ambiguous", evidence: evidence(projection.evidence) };
    case "ok":
      return { status: "unavailable", evidence: evidence(["projection carried no session row"]) };
    case "bad-args":
      return { status: "unavailable", evidence: evidence(["guest usage helper received no store/session arguments"]) };
    case "read-error":
      return { status: "truncated", evidence: evidence(projection.evidence) };
    case "row": {
      const row: NonNullable<GuestStoreProjection["row"]> = projection.row ?? {
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
      };
      if (
        row.input_tokens === null ||
        row.output_tokens === null ||
        row.cache_write_tokens === null
      ) {
        return {
          status: "ambiguous",
          evidence: evidence(["session row has NULL token columns; count is unverified"]),
        };
      }
      const total = computeHermesTokenTotal(row as unknown as Record<string, unknown>);
      if (!Number.isFinite(total)) {
        return {
          status: "unavailable",
          evidence: evidence(["session row has non-finite or non-numeric token fields; count is unverified"]),
        };
      }
      return { status: "ok", tokens: total, evidence: evidence() };
    }
  }
}

/** A recovered session identity + its token projection (store fallback path). */
export interface HermesSessionRecovery {
  status: HermesStoreStatus;
  /** The round's session id, when one was recovered (null when none). */
  sessionId: string | null;
  /** input + output + cache_write total, when status is `ok`. */
  tokens?: number;
  evidence: string[];
}

/**
 * Map a `newest-after` guest-helper projection into a recovered session id +
 * token projection. The round's session row is identified by INSERT ORDER
 * (rowid greater than the pre-harness snapshot), never "newest wins": two or
 * more newly created rows are AMBIGUOUS, a genuinely absent row is
 * unavailable, and NULL/non-finite token columns stay ambiguous/unavailable —
 * never a fabricated zero and never a borrowed session. Pure host-side
 * mapping; the SQLite read happened inside the VM.
 */
export function projectHermesRecoveredSession(
  projection: GuestStoreProjection,
): HermesSessionRecovery {
  const evidence = (extra?: string[]): string[] => [
    "newest session created during the round (mapped-store fallback)",
    ...(extra ?? []),
  ];
  switch (projection.status) {
    case "no-db":
      return { status: "unavailable", sessionId: null, evidence: evidence(projection.evidence) };
    case "no-table":
      return { status: "unavailable", sessionId: null, evidence: evidence(projection.evidence) };
    case "missing-columns":
      return { status: "unavailable", sessionId: null, evidence: evidence(projection.evidence) };
    case "session-not-found":
      return { status: "unavailable", sessionId: null, evidence: evidence(projection.evidence) };
    case "no-new-session":
      return { status: "unavailable", sessionId: null, evidence: evidence(projection.evidence) };
    case "ambiguous-new-session":
      return { status: "ambiguous", sessionId: null, evidence: evidence(projection.evidence) };
    case "ok":
      return { status: "unavailable", sessionId: null, evidence: evidence(["projection carried no session row"]) };
    case "bad-args":
      return { status: "unavailable", sessionId: null, evidence: evidence(["guest usage helper received no store/request arguments"]) };
    case "read-error":
      return { status: "truncated", sessionId: null, evidence: evidence(projection.evidence) };
    case "row": {
      const row = projection.row;
      if (!row || typeof row.id !== "string" || row.id === "") {
        return {
          status: "ambiguous",
          sessionId: null,
          evidence: evidence(["session row has no id; identity is unverified"]),
        };
      }
      if (
        row.input_tokens === null ||
        row.output_tokens === null ||
        row.cache_write_tokens === null
      ) {
        return {
          status: "ambiguous",
          sessionId: row.id,
          evidence: evidence(["session row has NULL token columns; count is unverified"]),
        };
      }
      const total = computeHermesTokenTotal(row as unknown as Record<string, unknown>);
      if (!Number.isFinite(total)) {
        return {
          status: "unavailable",
          sessionId: row.id,
          evidence: evidence(["session row has non-finite or non-numeric token fields; count is unverified"]),
        };
      }
      return { status: "ok", sessionId: row.id, tokens: total, evidence: evidence() };
    }
  }
}

// ── the runner ─────────────────────────────────────────────────────────

interface RunnerOwned {
  controller: MatchlockController | null;
  controllerCreatedVm: boolean;
  broker: HostBrokerHandle | null;
  bridge: ExecPipeBrokerBridge | null;
  harnessExec: MatchlockPipeHandle | null;
  suiteStore: HostSuiteStore | null;
  suiteBridge: HostSuiteBridge | null;
  progressResource: RunProgressResource | null;
}

function emptyOwned(): RunnerOwned {
  return {
    controller: null,
    controllerCreatedVm: false,
    broker: null,
    bridge: null,
    harnessExec: null,
    suiteStore: null,
    suiteBridge: null,
    progressResource: null,
  };
}

/**
 * Execute ONE opted-in Hermes invocation in a FRESH VM and return a
 * HarnessRoundResult-compatible object. Throws a typed {@link
 * HermesInvocationError} on refusals/infrastructure failures — refusals always
 * BEFORE any VM create / broker op / registry effect, and failures always
 * after owned cleanup (cleanup failures are surfaced, never swallowed).
 */
export async function runHermesInvocation(opts: RunHermesInvocationOptions): Promise<HermesInvocationResult> {
  // TIME-CLOCKS rule 1: the round duration and the wall budget are in-process
  // intervals, measured on the monotonic clock so a wall-clock jump cannot
  // produce a negative/inflated duration or an early/late timeout.
  const timing = new MatchlockRoundTiming(opts.clock);
  const timeoutMs = opts.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new HermesInvocationError("invalid_timeout", `runHermesInvocation requires a positive timeoutMs (got ${timeoutMs})`);
  }
  if (typeof opts.helperPackHostPath !== "string" || opts.helperPackHostPath.trim() === "") {
    throw new HermesInvocationError("guest_bridge_unavailable", "A versioned RO guest helper pack host path is required; none was supplied.");
  }
  if (!opts.identity || typeof opts.identity.invocationId !== "string" || !isUuid(opts.identity.invocationId)) {
    throw new HermesInvocationError("invalid_invocation_id", `invocationId must be a uuid (got ${JSON.stringify(opts.identity?.invocationId)})`);
  }
  if (!opts.submission || typeof opts.submission.homeDir !== "string" || typeof opts.submission.cwd !== "string") {
    throw new HermesInvocationError(
      "hermes_selection_refused",
      "runHermesInvocation requires FROZEN submission inputs (homeDir/env/cwd captured at run creation); refusing to resolve the Hermes selection from ambient state.",
    );
  }
  const runId = bareRunId(opts.identity.runId);
  const invocationId = opts.identity.invocationId;
  const kind = opts.kind;
  const guestHome = opts.hermes?.guestHome ?? "/root";

  let vmId: string | null = null;
  const diag = (msg: string): void => {
    try {
      opts.onLog?.("info", msg, { runId, invocationId, kind, vmId });
    } catch {
      /* ignore */
    }
  };

  // ── 0. FROZEN adapter plan + typed refusal BEFORE any effect ─────────
  // The plan is resolved from the FROZEN submission inputs only (homeDir /
  // env-with-HERMES_HOME / cwd captured at run creation) — never daemon HOME
  // or later ambient state. A refused profile / unreadable / malformed /
  // non-regular / explicit non-local terminal.backend leaves launch null and
  // throws here BEFORE any VM create / broker op / registry effect; refused
  // config never yields a launch descriptor.
  let plan: HermesAdapterPlan;
  try {
    plan = resolveHermesAdapterPlan(opts.submission, {
      prompt: opts.promptText,
      binary: opts.hermes?.binary,
      maxTurns: opts.hermes?.maxTurns,
      guestHome,
      guestCwd: opts.workingDirectoryForHarness,
    });
  } catch (err) {
    throw classifyInvocationError(err, "resolve Hermes adapter plan");
  }
  if (plan.selectionRefused || !plan.launchAdmission.ok || plan.launch === null) {
    const ad = plan.launchAdmission;
    throw new HermesSelectionRefusedError(
      "hermes_selection_refused",
      `Hermes adapter refused the frozen submission selection${ad.code ? ` (${ad.code})` : ""}: ${ad.reason ?? "no launch descriptor produced"}. Refused before any VM create or registry effect.`,
    );
  }
  const launch: HermesGuestLaunch = plan.launch;

  // ── 1. config mount scope admission (canonical realpath) ─────────────
  // Broad host HOME / live .tamandua admin state / lexical-only prefix
  // admission never become mount sources.
  const mount = admitHermesConfigMount(plan, opts.mountAdmission);
  const hermesPolicy = deriveHermesCreatePolicy(opts.policy, mount);
  diag(`hermes config mount admitted: host ${mount.hostConfigDir} -> guest ${mount.guestConfigDir}`);

  // ── 2. persisted image pin (never re-resolved/re-pinned by the runner) ─
  if (!opts.policy.resolvedImageDigest || !opts.policy.resolvedImageConfigDigest) {
    throw new HermesInvocationError(
      "image_identity_required",
      "Persisted Matchlock policy does not carry the required immutable image content/config pin; refusing to invoke (legacy/unpinned record).",
    );
  }
  const pin = {
    digest: opts.policy.resolvedImageDigest,
    config_digest: opts.policy.resolvedImageConfigDigest,
    tag: opts.policy.requestedImage,
  };

  // ── 3. host-owned registry admission BEFORE any broker/guest work ────
  const registry = opts.registry ?? new HostInvocationRegistry();
  const admitted = registry.admitInvocation({
    invocationId,
    runId,
    agentId: opts.identity.agentId,
    jobId: opts.identity.jobId,
  });
  if (!admitted.ok) {
    throw new HermesInvocationError("invocation_admission_refused", admitted.reason);
  }

  // ── owned handles (all cleaned on every path) ─────────────────────────
  const owned: RunnerOwned = emptyOwned();
  let revokedOnce = false;
  let cleanupDone = false;
  const cleanupState: { error: HermesInvocationError | null } = { error: null };
  /**
   * MTLK-CLEANUP US-008: true once the hermes harness exec has SETTLED (the
   * process exited, was canceled, or its exec request was rejected). Only then
   * is a close/dispose failure a post-harness cleanup nuisance rather than a
   * possible symptom of a still-live round.
   */
  let harnessExited = false;
  /**
   * MTLK-CLEANUP US-008: bounded serialized detail of a post-harness
   * close/dispose failure. Non-null only when the harness had already exited;
   * the round result is then kept and the VM is handed to the reaper.
   */
  let vmCleanupFailure: string | null = null;
  /**
   * MATCHLOCK-OBS US-005: post-close evidence/removal outcome. Populated ONLY
   * after a POSITIVELY confirmed close, then spread onto every returned round
   * result (including canceled rounds). Empty for a dispose-only teardown.
   */
  const vmReapOutcome: {
    vmRemoved?: boolean;
    vmLogsCopiedTo?: string | null;
    vmRemovalError?: string;
  } = {};

  /**
   * MATCHLOCK-OBS US-005 (bead tamandua-6sy.33.33): capture the positively
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
   * MTLK-CLEANUP US-003/US-008: hand a post-harness close/dispose failure's VM
   * to the per-run orphan store so the stopped-VM reaper and the run's
   * completion cleanup can retry the disposal by EXACT id. Best-effort by
   * design: the store never throws for a malformed/absent file, and any
   * defensive failure here is logged (never allowed to change the round
   * outcome, which is exactly what this story protects).
   *
   * Returns the persisted record (or null) so US-007's immediate bounded reaper
   * pass can run for exactly that VM.
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
   * MTLK-CLEANUP US-007/US-008: after handing a VM to the orphan store,
   * best-effort invoke ONE bounded reaper pass for exactly that VM (same
   * process, mirroring the pi runner). The pass runs ONLY for the handed-off
   * VM's effective Matchlock HOME, uses the US-006 live-process guard, and can
   * NEVER change the round outcome — the entry point never throws and its
   * report is intentionally not surfaced here (the scheduler teardown pass is
   * the durable retry).
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
      owned.suiteBridge?.revokeAuthority(reason);
    } catch {
      /* idempotent host seam */
    }
  };

  const releaseLeases = (): void => {
    try {
      const lease = registry.getLeaseByInvocation(invocationId);
      if (lease) registry.releaseIfHeldBy(invocationId, lease.stepRowId);
    } catch {
      /* best-effort */
    }
  };

  /**
   * Terminal cleanup on every path. Order mirrors the pi invocation runner:
   * revoke authority synchronously, release leftover leases, end the broker
   * (revokes + ends toGuest → stdin EOF), wait bounded for the guest bridge
   * to exit, settle the exec pipes, then POSITIVELY close ONLY this VM with a
   * positive close timeout; hard-dispose only when close cannot confirm. Safe
   * when nothing was ever created (close-before-create, late-create-after-
   * cancel). Cleanup failures are thrown, never swallowed.
   */
  const cleanup = async (reason: string): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    const errors: string[] = [];
    revoke(reason);
    releaseLeases();
    if (owned.broker) {
      try {
        await owned.broker.close();
        await raceOrTimeout(
          owned.broker.closed.then(
            () => undefined,
            () => undefined,
          ),
          5000,
          () => undefined,
        );
      } catch (err) {
        // MTLK-CLEANUP US-001: the RPC client rejects with a PLAIN body object,
        // so the old `err.message`/`String(err)` dropped the real cause to
        // `[object Object]`. Serialize with the failing phase + owned vmId.
        errors.push(
          `broker close: ${serializeMatchlockError(err, { phase: "broker-close", vmId, runId, invocationId })}`,
        );
      }
    }
    if (owned.bridge) {
      try {
        if (!owned.bridge.eofSignaled) owned.bridge.pipe.toGuest.end();
      } catch {
        /* already ended */
      }
      try {
        await raceOrTimeout(
          owned.bridge.guestExit.then(
            () => undefined,
            () => undefined,
          ),
          8000,
          () => undefined,
        );
      } catch {
        /* bounded */
      }
      owned.bridge.closeFromGuest();
    }
    if (owned.harnessExec) {
      try {
        await raceOrTimeout(
          owned.harnessExec.result.then(
            () => undefined,
            () => undefined,
          ),
          2000,
          () => undefined,
        );
      } catch {
        /* bounded settle */
      }
    }
    if (owned.controller) {
      const ownedVmId = owned.controller.identity.vmId ?? owned.controller.lateVm?.vmId ?? vmId;
      const hasLiveOrCreated =
        owned.controllerCreatedVm ||
        owned.controller.lateVm !== null ||
        owned.controller.rpcRunning;
      try {
        if (hasLiveOrCreated) {
          await owned.controller.close(opts.closeTimeoutSeconds ?? DEFAULT_CLOSE_TIMEOUT_SECONDS);
          vmId = vmId ?? ownedVmId;
          // MATCHLOCK-OBS US-005: capture + remove ONLY after the close was
          // POSITIVELY confirmed on the wire (isClosed). An unconfirmed close
          // (or a dispose-only teardown, handled below) leaves the VM alone —
          // it may still be live, so removing it would be unsafe.
          if (owned.controller.isClosed && ownedVmId) {
            reapVmEvidence(ownedVmId);
          }
        } else {
          // Nothing was ever created and no live transport exists: dispose is
          // the exact (no-op) hard teardown — never fabricate a close.
          await owned.controller.dispose();
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
        // MTLK-CLEANUP US-005/US-008: a close/dispose failure AFTER the hermes
        // harness exec has settled is NOT an infrastructure failure of the
        // round. The round result (stdout/STATUS/evidence) is kept and
        // processed normally; the failure is logged at WARN with the serialized
        // cause and the VM is handed to the reaper (orphan record) so disposal
        // is retried later. create/probe/exec failures and a close failure
        // BEFORE the harness exits keep the fatal `matchlock_cleanup_failed`
        // behaviour.
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
          const orphanHandoff = handOffOrphanVm(ownedVmId, phase, detail);
          try {
            await owned.controller.dispose();
          } catch {
            /* final fallback */
          }
          // MTLK-CLEANUP US-007: after the hard dispose, best-effort retry ONE
          // bounded reaper pass for exactly the handed-off VM. Entirely
          // optional (the scheduler teardown + next pass reaper are the durable
          // retries) and it can never change the round outcome.
          tryImmediateOrphanReap(orphanHandoff);
        } else {
          errors.push(`vm close/dispose: ${detail}`);
          try {
            await owned.controller.dispose();
          } catch {
            /* final fallback */
          }
        }
      }
    }
    if (owned.suiteStore) {
      try {
        owned.suiteStore.close();
      } catch (err) {
        errors.push(
          `suite store close: ${serializeMatchlockError(err, { phase: "suite-store-close", vmId, runId, invocationId })}`,
        );
      }
      owned.suiteStore = null;
    }
    if (errors.length > 0) {
      const failure = new HermesInvocationError(
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
    if (owned.harnessExec) {
      owned.controller?.cancel(owned.harnessExec.requestId).catch(() => {});
    }
  };

  const canceledRound = async (reasonTail: string, vm: string | null): Promise<HermesInvocationResult> => ({
    output: "",
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
    canceled: true,
    stderrTail: `invocation canceled by host ${reasonTail}`,
    durationMs: timing.roundMs,
    ...timing.harnessFields(),
    invocationId,
    vmId: vm,
    kind,
    runId,
    cleanupConfirmed: true,
    suiteAbsent: opts.suite === undefined,
    ...vmReapOutcome,
    sessionId: null,
    sessionSource: null,
    usage: {
      status: "unavailable",
      evidence: [`invocation canceled by host ${reasonTail}; no session/usage accounting`],
    },
    rawStdout: "",
    rawStderr: "",
  });

  try {
    // ── 4. progress resource attach (host-attested, before create) ──────
    if (opts.progressResource) {
      owned.progressResource = attachRunProgressResource(opts.progressResource.runId, {
        runRoot: opts.progressResource.runRoot,
      });
    }

    // ── 5. guest pack identity (version-matched RO pack) ────────────────
    const manifest: GuestPackManifest = readGuestPack(opts.helperPackHostPath);

    // ── suite store (explicit host-owned evidence store) ────────────────
    if (opts.suite) {
      owned.suiteStore = openHostSuiteStore(opts.suite.storePath);
    }

    // ── guest env (invocation-bound + Hermes HOME mapping) ──────────────
    // HERMES_HOME is the approved stable guest mapping of the WHOLE effective
    // selected config directory mounted RW below; the guest never sees a host
    // path and never falls back to os.homedir()/process.env.
    const guestEnv: ComposedGuestEnv = composeGuestEnv({
      invocationId,
      runId,
      agentId: opts.identity.agentId,
      manifest,
      imagePath: opts.imagePath,
      suite: owned.suiteStore ? opts.suite : undefined,
      extra: {
        HERMES_HOME: mount.guestConfigDir,
        HOME: guestHome,
        ...opts.guestEnvOverrides,
      },
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

    // ── 6. FRESH controller per invocation (never shared) ───────────────
    const controller = new MatchlockController(hermesPolicy, {
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
      createEnv: guestEnv.env,
      ...(opts.progressResource?.runRoot !== undefined || opts.mountAdmission !== undefined
        ? {
            // Deterministic live-state/home override for tests: the mount
            // planner's broad-source + progress-resource admission must use the
            // same context the attached resource dir lives under.
            mountAdmission: opts.mountAdmission ?? {
              ...(process.env.HOME ? { home: process.env.HOME } : {}),
              liveStateRoot: path.resolve(opts.progressResource!.runRoot!, ".."),
            },
          }
        : {}),
    });
    owned.controller = controller;

    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = onAbort;
    }

    // Abort BEFORE create: revoke, clean up, and never create a VM.
    if (opts.signal?.aborted || aborted) {
      await cleanup("invocation canceled by host before VM create");
      return canceledRound("before VM create", null);
    }

    // ── 7. create the FRESH VM with the persisted pin ───────────────────
    // US-006: VM setup starts here (create/boot start) and ends when the
    // harness exec starts; it is reported separately as vmSetupMs and NEVER
    // folded into harnessWallMs.
    timing.startVmSetup();
    const createdResult = await controller.prepareAndCreate(pin);
    owned.controllerCreatedVm = true;
    vmId = createdResult.vmId;

    // Abort landed while the VM was being created: the late VM is an exact
    // owned cleanup obligation — positively close ONLY it, never launch work.
    if (aborted) {
      await cleanup("invocation canceled by host during VM create (late-create cleanup)");
      return canceledRound("during VM create", vmId);
    }

    // ── 8. guest bridge over exec_pipe (decode exactly once) ────────────
    let bridgeNotifyRef: { current: ((frame: MatchlockStreamFrame) => void) | null } = { current: null };
    const bridgeHandle = controller.execPipe(
      { command: GUEST_BRIDGE_SERVICE },
      (frame) => bridgeNotifyRef.current?.(frame),
      0, // long-lived bridge request; close() cancels it bounded
    );
    const bridgeCtx = mapExecPipeToBrokerPipe(bridgeHandle);
    bridgeNotifyRef.current = (frame: MatchlockStreamFrame): void => {
      if (frame.kind === "ready") return;
      bridgeCtx.notify(frame);
    };
    owned.bridge = bridgeCtx;

    // ── 9. broker: real NativeStepServices over the shared registry (+suite) ─
    const services: AuthoritativeStepServices = new NativeStepServices({
      binding,
      registry,
      workerOwnership: opts.workerOwnership ?? { jobId: opts.identity.jobId, pid: process.pid },
      progressResource: owned.progressResource?.access,
    });
    if (owned.suiteStore && opts.suite) {
      owned.suiteBridge = createHostSuiteBridge({
        invocationId,
        runId,
        agentId: opts.identity.agentId,
        jobId: opts.identity.jobId,
        registry,
        store: owned.suiteStore,
        namespace: opts.suite.namespace,
        admittedRoots: opts.suite.admittedRoots,
      });
    }
    const broker = createHostBroker({
      binding,
      services,
      pipe: bridgeCtx.pipe,
      ...(owned.suiteBridge ? { suite: owned.suiteBridge } : {}),
      // MTLK-ALL-WORKFLOWS US-001: forward the host-attested merge service
      // verbatim (constructed outside this module); absence keeps merge ops
      // UNSUPPORTED in the broker, never a host fallback.
      ...(opts.merge ? { merge: opts.merge } : {}),
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 20000,
      serviceTimeoutMs: opts.serviceTimeoutMs ?? 120000,
    });
    owned.broker = broker;

    // Strict HELLO before any harness work: a build/layout mismatch refuses
    // here (broker ready {ok:false}); no guest command was served.
    const handshakeDeadlineMs = (opts.handshakeTimeoutMs ?? 20000) + 5000;
    const hello = await raceOrTimeout(
      broker.ready,
      handshakeDeadlineMs,
      () => ({ ok: false as const, reason: "broker handshake deadline exceeded" }),
    );
    if (!hello.ok) {
      await cleanup(`guest bridge handshake refused before work: ${hello.reason ?? "unknown"}`);
      throw new HermesInvocationError("guest_bridge_unavailable", `guest bridge handshake refused before work: ${hello.reason ?? "unknown"}`);
    }

    // Abort landed while the bridge was being established (or during create):
    // revoke + clean up and never start the harness.
    if (aborted) {
      await cleanup("invocation canceled by host after VM create");
      return canceledRound("after VM create", vmId);
    }

    // ── 9b. PRE-harness mapped-store inventory INSIDE the still-owned VM ──
    // Snapshot the highest `sessions` rowid BEFORE the harness runs so a lost
    // session trailer (H2) can recover the round's OWN newly inserted row
    // afterwards without any host/guest clock assumption — never "newest wins"
    // and never a borrowed session. Best-effort: a failed inventory leaves the
    // fallback to the single-row (fresh store) case and never blocks the round.
    const preStoreInventory = await inventoryGuestStoreInsideVm({
      controller,
      storeGuestDir: mount.guestConfigDir,
      helperArgv: opts.usageHelperArgv ?? ["node"],
      helperTimeoutMs: opts.usageHelperTimeoutMs ?? USAGE_HELPER_TIMEOUT_DEFAULT_MS,
    });
    // Abort may have landed during the inventory exec: never launch the harness.
    if (aborted) {
      await cleanup("invocation canceled by host during store inventory");
      return canceledRound("during store inventory", vmId);
    }

    // ── 10. harness exec (probe/work) with remaining-wall-budget timeout ──
    // The Hermes harness is invoked through execPipe with stdin EOF'd
    // immediately ("stdin closed"). Its stdout is PLAIN TEXT (no pi JSON).
    const harnessCommand = [...launch.argv.map((a) => quoteShellArg(a))].join(" ");
    const capture: CaptureState = createCaptureState(opts.maxOutputBytes ?? MAX_OUTPUT_DEFAULT);
    // US-006: VM setup ends and the harness interval begins at the exact
    // moment the guest harness exec is issued.
    timing.startHarnessExec();
    const harnessHandle = controller.execPipe(
      { command: harnessCommand, working_dir: opts.workingDirectoryForHarness },
      (frame) => captureNotify(capture, frame),
      0, // bounded by the runner's wall-clock timeout + cancel
    );
    owned.harnessExec = harnessHandle;
    harnessHandle.stdin.eof().catch(() => {});

    const wallDeadline = new Deadline(timeoutMs);
    let settled = false;
    let execExitCode: number | null = null;
    let execError: unknown = null;
    const settle = harnessHandle.result.then(
      (r) => {
        execExitCode = r.exit_code;
        settled = true;
        // MTLK-CLEANUP US-008: the hermes harness process has exited; a later
        // close/dispose failure is now a non-fatal cleanup nuisance.
        harnessExited = true;
      },
      (err: unknown) => {
        execError = err;
        settled = true;
        // US-008: track the harness-exited state for the cleanup policy. Per
        // the story, "harnessExec settled / result captured" is the boundary.
        harnessExited = true;
      },
    );

    // Winner race: exec settled, wall budget expired, or the host aborted.
    // The wall-clock timer is cleared as soon as any outcome wins (never a
    // stray keep-alive timer after a finished round).
    let outcomeListener: (() => void) | null = null;
    const outcomePromise = new Promise<"exec" | "timeout" | "abort">((resolve) => {
      settle.then(() => resolve("exec"), () => resolve("exec"));
      outcomeListener = (): void => resolve("abort");
      opts.signal?.addEventListener("abort", outcomeListener, { once: true });
    });
    let outcome: "exec" | "timeout" | "abort";
    try {
      outcome = await raceOrTimeout(outcomePromise, Math.max(1, wallDeadline.remainingMs()), () => "timeout");
    } finally {
      if (outcomeListener && opts.signal) {
        try {
          opts.signal.removeEventListener("abort", outcomeListener);
        } catch {
          /* ignore */
        }
      }
    }

    let timedOut = false;
    let canceled = false;
    const truncated = capture.overflowed;
    let exitCode: number | null = null;
    let signal: string | null = null;
    // US-006 (H1/D1): a REJECTED harness exec (RPC/protocol/transport error,
    // e.g. the VM relay dropping the final stdout frames) must never be
    // swallowed into a clean-looking empty round. The guest may already have
    // completed the step through the host broker, so we do NOT throw (that
    // would force-fail a run whose work landed) — instead the real bounded
    // error is surfaced on the result and appended to the stderr tail.
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
        await raceOrTimeout(settle, EXEC_SETTLE_GRACE_MS, () => undefined);
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
      await raceOrTimeout(settle, 2000, () => undefined);
    }

    // US-006: the harness interval ends as soon as the exec settled (exit,
    // rejection, timeout or cancel) — the bounded stream drain below is NOT
    // harness process time.
    timing.endHarnessExec();

    // US-006 (H1/D1): bounded drain of pending stream frames before the
    // capture is finalized (frames normally precede the result; a different
    // runtime version can settle first). Non-empty captures skip the grace.
    await drainPendingStreamFrames(capture);
    const rawStdout = captureBytes(capture.stdout);
    const rawStderr = captureBytes(capture.stderr);
    const roundDurationMs = timing.roundMs;
    const capturedStderrTail = tailText(capture.stderr, 8192);
    const stderrTail =
      harnessExecError !== null
        ? `${capturedStderrTail ? `${capturedStderrTail}\n` : ""}harness exec failed: ${harnessExecError}`
        : capturedStderrTail;
    const canceledReason =
      outcome === "abort" || aborted ? "invocation canceled by host (AbortSignal)" : undefined;

    // ── 11. session id from the authoritative trailer conventions ───────
    // The Hermes quiet-mode CLI prints `\nsession_id: <id>` to STDERR (the
    // authoritative trailer); stdout is the fallback. The bytes were decoded
    // exactly once across frame boundaries, so a trailer split across chunks
    // is recovered intact.
    //
    // H2 (tamandua-6sy.33.10.29): when the trailer was lost (the same guest
    // exit that dropped the harness stdout), the round's session still exists
    // in the mapped store. Fall back to the single row inserted after the
    // pre-harness inventory — the session is then recovered from the STORE,
    // never fabricated and never borrowed from another round/run.
    const { extractSessionTrailer, stripSessionTrailer } = await import("./hermes-adapter.js");
    const trailer = extractSessionTrailer(rawStdout, rawStderr);
    let sessionId = trailer.sessionId;
    let sessionSource: "stderr" | "stdout" | "store" | null = trailer.source;
    const finalMessage = stripSessionTrailer(rawStdout);

    // ── 12. usage/store projection INSIDE the still-owned VM (guest helper) ─
    // Token totals are projected by a small trusted helper INSIDE the VM
    // after harness completion and BEFORE the confirmed VM close (qualified
    // VFS confinement). The runner NEVER opens the guest-writable mapped
    // config store with host-side SQLite. Missing/ambiguous/truncated data is
    // unavailable, never a fabricated zero. A session that exists in the
    // store is never reported unavailable.
    let usage: HermesRoundUsage;
    let usageSkippedNoSession = false;
    if (sessionId !== null) {
      usage = await projectUsageInsideVm({
        controller,
        storeGuestDir: mount.guestConfigDir,
        sessionRef: sessionId,
        helperArgv: opts.usageHelperArgv ?? ["node"],
        helperTimeoutMs: opts.usageHelperTimeoutMs ?? USAGE_HELPER_TIMEOUT_DEFAULT_MS,
      });
    } else {
      const recovered = await recoverRoundSessionInsideVm({
        controller,
        storeGuestDir: mount.guestConfigDir,
        preMaxRowid: preStoreInventory?.maxRowid ?? null,
        helperArgv: opts.usageHelperArgv ?? ["node"],
        helperTimeoutMs: opts.usageHelperTimeoutMs ?? USAGE_HELPER_TIMEOUT_DEFAULT_MS,
      });
      sessionId = recovered.sessionId;
      sessionSource = sessionId !== null ? "store" : null;
      usage = recovered.usage;
      usageSkippedNoSession = sessionId === null;
    }

    // ── 13. terminal teardown (revoke once, release leases, close VM) ───
    const cleanupReason =
      canceledReason ?? (timedOut ? `harness exceeded ${timeoutMs}ms wall budget` : "invocation completed");
    await cleanup(cleanupReason);

    return {
      output: finalMessage,
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
      // US-008: a post-harness close/dispose failure keeps the round but is
      // reported (cleanupConfirmed=false + bounded vmCleanupFailure) so the
      // caller can see the VM was handed to the reaper, not disposed.
      cleanupConfirmed: vmCleanupFailure === null,
      ...(vmCleanupFailure !== null ? { vmCleanupFailure } : {}),
      suiteAbsent: opts.suite === undefined,
      ...vmReapOutcome,
      sessionId,
      sessionSource,
      usage,
      rawStdout,
      rawStderr,
      ...(usageSkippedNoSession ? { usageSkippedNoSession: true } : {}),
    };
  } catch (err) {
    if (!cleanupDone) {
      try {
        await cleanup("infrastructure failure during invocation");
      } catch (cleanupErr) {
        throw classifyInvocationError(cleanupErr, "cleanup");
      }
    }
    if (cleanupState.error !== null && cleanupState.error.code === "matchlock_cleanup_failed") {
      // A cleanup failure on a NORMAL path (no earlier exception) must not be
      // hidden — surface it distinctly so the caller can distinguish a failed
      // round from a failed cleanup.
      const cleanupErr = cleanupState.error;
      const originalIsCleanupFailure =
        err instanceof HermesInvocationError && err.code === "matchlock_cleanup_failed";
      if (!originalIsCleanupFailure) {
        throw cleanupErr;
      }
    }
    throw classifyInvocationError(err, "runHermesInvocation");
  } finally {
    if (abortListener && opts.signal) {
      try {
        opts.signal.removeEventListener("abort", abortListener);
      } catch {
        /* ignore */
      }
    }
  }
}

interface GuestUsageHelperOptions {
  controller: MatchlockController;
  storeGuestDir: string;
  helperArgv: string[];
  helperTimeoutMs: number;
}

/** Parsed helper outcome, or a `helper-error` marker when the exec/parse failed. */
type GuestHelperRun =
  | GuestStoreProjection
  | { status: "helper-error"; evidence: string[] };

/**
 * Run the trusted guest usage helper INSIDE the still-owned VM (before the
 * confirmed VM close) for one JSON request. The SQLite open happens in the
 * guest; the host only parses the single JSON projection line. A helper
 * invocation failure is surfaced as `helper-error` evidence (never a
 * fabricated zero and never a silently dropped round).
 */
async function runGuestUsageHelper(
  opts: GuestUsageHelperOptions,
  request: Record<string, unknown>,
): Promise<GuestHelperRun> {
  const argv = [
    ...opts.helperArgv,
    "--input-type=module",
    "-e",
    GUEST_USAGE_HELPER_SOURCE,
    "--",
    opts.storeGuestDir,
    JSON.stringify(request),
  ];
  const command = argv.map((a) => quoteShellArg(a)).join(" ");
  const state: CaptureState = createCaptureState(64 * 1024);
  try {
    const result = await opts.controller.execStream(
      { command, working_dir: "/" },
      (frame) => captureNotify(state, frame),
      opts.helperTimeoutMs,
    );
    if (result.exit_code !== 0) {
      return {
        status: "helper-error",
        evidence: [`in-VM usage helper exited ${result.exit_code}; count is unverified`],
      };
    }
    const text = captureBytes(state.stdout).trim();
    const line = text.split("\n").filter((l) => l.trim() !== "").pop();
    if (!line) {
      return {
        status: "helper-error",
        evidence: ["in-VM usage helper produced no projection output; count is unverified"],
      };
    }
    try {
      return JSON.parse(line) as GuestStoreProjection;
    } catch {
      return {
        status: "helper-error",
        evidence: ["in-VM usage helper output was not parseable JSON; count is unverified"],
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "helper-error",
      evidence: [`in-VM usage helper failed to run: ${message}; count is unverified`],
    };
  }
}

/**
 * PRE-harness snapshot of the mapped store's highest `sessions` rowid. Returns
 * null (untracked) when the store/db/table is absent or unreadable, in which
 * case the fallback can still recover a lone session row from a fresh store.
 */
async function inventoryGuestStoreInsideVm(
  opts: GuestUsageHelperOptions,
): Promise<{ maxRowid: number | null } | null> {
  const projection = await runGuestUsageHelper(opts, { mode: "inventory" });
  if (projection.status !== "ok") return null;
  const max = projection.maxRowid;
  return { maxRowid: typeof max === "number" && Number.isFinite(max) ? max : null };
}

/**
 * Run the trusted guest usage helper INSIDE the still-owned VM (before the
 * confirmed VM close) and project the returned token data for the session id
 * recovered from the authoritative trailer.
 */
async function projectUsageInsideVm(
  opts: GuestUsageHelperOptions & { sessionRef: string },
): Promise<HermesRoundUsage> {
  const projection = await runGuestUsageHelper(opts, { mode: "by-id", sessionId: opts.sessionRef });
  if (projection.status === "helper-error") {
    return { status: "truncated", evidence: projection.evidence };
  }
  const scan = projectHermesStoreScan(projection, opts.sessionRef);
  return { status: scan.status, ...(scan.tokens !== undefined ? { tokens: scan.tokens } : {}), evidence: scan.evidence };
}

/**
 * Store fallback used when no session trailer was recovered: identify the
 * round's OWN session row from the single row inserted after the pre-harness
 * inventory and project its token total. The session id is recovered when the
 * row exists; genuinely missing/ambiguous/NULL rows stay unavailable/ambiguous
 * (never a fabricated zero, never a borrowed session).
 */
async function recoverRoundSessionInsideVm(
  opts: GuestUsageHelperOptions & { preMaxRowid: number | null },
): Promise<{ sessionId: string | null; usage: HermesRoundUsage }> {
  const projection = await runGuestUsageHelper(opts, {
    mode: "newest-after",
    minRowid: opts.preMaxRowid,
  });
  if (projection.status === "helper-error") {
    return { sessionId: null, usage: { status: "truncated", evidence: projection.evidence } };
  }
  const recovered = projectHermesRecoveredSession(projection);
  return {
    sessionId: recovered.sessionId,
    usage: {
      status: recovered.status,
      ...(recovered.tokens !== undefined ? { tokens: recovered.tokens } : {}),
      evidence: recovered.evidence,
    },
  };
}

// Re-export the shared typed error so the scheduler seam can force-fail typed
// infrastructure failures distinctly from normal failed guest rounds.
export { MatchlockRunnerError };
