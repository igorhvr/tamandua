/**
 * controller.ts — US-002.
 *
 * The Matchlock controller: the host-owned orchestrator for ONE opted-in
 * invocation (a fresh VM per probe/work/retry). It owns the ONLY Matchlock
 * control RPC connection, builds the exact-destination mount plan from the
 * persisted `ExecutionIsolation` policy, pins + verifies the image identity,
 * creates the VM, and runs guest commands through exec_stream / exec_pipe with
 * separate stdout/stderr — then cancels/close (positive timeout) on teardown.
 *
 * Image identity is IMMUTABLE across retries and REQUIRED BEFORE any VM
 * create: the FIRST admission goes through `resolveAndAdmitIdentity()`, which
 * resolves the tag over a bounded owned RPC transport, returns the validated
 * content+config identity WITHOUT issuing `create`, and disposes the
 * transport so the caller can persist the pin first. Every create then goes
 * through `prepareAndCreate(expected)` with that persisted identity — the
 * parameter is REQUIRED (TypeScript and, at runtime, for JS/undefined/null
 * callers; a missing/invalid pin fails before any child spawn). The
 * controller re-resolves the tag on every call, compares the newly observed
 * identity against the expected one BEFORE any `create`, and sends the
 * EXPECTED identity as `create.image_identity`. A moved/retagged image
 * therefore never reaches `create` and there is no implicit repinning path.
 *
 * WORK-ADMISSION IS A LIFECYCLE-GATED OPERATION (this is the phase guard this
 * file is built around). `resolveAndAdmitIdentity` and `prepareAndCreate` are
 * BOTH invoking operations: they require lifecycle `open` at ENTRY, and
 * `prepareAndCreate` re-checks lifecycle AFTER the awaited image resolution
 * and BEFORE issuing `create`. `closing` / `closed` / `disposed` can NEVER
 * admit or create — including a valid `close()` requested BEFORE the first
 * admission/create (whose cleanup legitimately fails with
 * `matchlock_cleanup_failed` because no transport/VM ever existed): that
 * close PERMANENTLY bars create, it never reopens.
 *
 * Explicit finite-phase/single-flight discipline prevents two phases from
 * sharing or disposing the same owned transport:
 *   - concurrent `resolveAndAdmitIdentity()` calls JOIN one in-flight
 *     admission (single-flight: exactly one owned transport, one resolve);
 *   - `prepareAndCreate` called while an admission owns the transport is a
 *     clear `controller_admission_in_progress` error (never a second child);
 *   - an admission attempted once the create invocation has begun fails with
 *     `controller_already_invoked`;
 *   - `close()` revokes work SYNCHRONOUSLY (lifecycle → `closing` before any
 *     await) and then WAITS for an in-flight admission/create phase to settle
 *     before driving the transport, so close never drives (or kills) a
 *     transport mid-phase. A failed close lets the caller retry cleanup or
 *     `dispose()`, but never reopens admission/create/exec work.
 *
 * If a `create` that was ALREADY ACCEPTED/IN-FLIGHT resolves after close was
 * requested, the late VM is an exact OWNED CLEANUP OBLIGATION: it is never
 * returned as usable/open work — `prepareAndCreate` rejects with
 * `late_vm_cleanup_required`, keeps the VM id + identity as evidence
 * (`lateVm`), and leaves the live transport for the pending `close()` to
 * confirm cleanup. Killing the RPC transport alone NEVER proves the VM is
 * gone: when a create request was in flight at dispose time the evidence
 * (`lateVm`) is preserved for controller recovery instead of pretending the
 * transport exit settled anything.
 *
 * Guest-work admission is a separate lifecycle gate from VM-close
 * confirmation: once `close(positive timeout)` is requested the controller
 * REVOKES new execStream/execPipe work BEFORE cancellation starts, and the
 * revocation is permanent — a failed/unconfirmed close lets the caller retry
 * `close()` or `dispose()`, but never reopens guest work. `close(0)`/invalid
 * values are validated BEFORE any state mutation, so a later valid `close`
 * still operates. `dispose()` revokes immediately and is idempotent.
 * `isClosed` is set ONLY after the server CONFIRMS the close response — an
 * RPC child exit alone never marks the controller closed (VM-close
 * confirmation stays distinct from transport termination). A close response
 * naming an already-stopped/closed VM IS such a confirmation (US-004): the VM
 * is gone, so the controller becomes `closed` exactly as on a successful
 * close. `dispose()` is the hard abort: it kills the EXACT owned RPC child
 * handle and resolves only
 * after the child close is observed. A terminal `disposed` state is never
 * overwritten by a late successful close transition.
 *
 * It never falls back to a native host harness and never accepts a guest
 * command for host execution.
 *
 * LAUNCH-GATE BACKSTOP (G8 US-004). When the caller supplies a
 * `launchGate` context, `prepareAndCreate` refuses — synchronously, BEFORE any
 * state mutation, overlay preparation or RPC child spawn — unless a gate
 * verdict exists for THE CURRENT RESOLVED INVOCATION: same invocation id and a
 * non-empty store-set key (the receipt path is reported, never required). A
 * verdict that belongs to a DIFFERENT invocation never authorises this create.
 * The check is a pure binding read: the controller NEVER re-evaluates the gate
 * and NEVER falls back to an earlier verdict. When `launchGate` is absent
 * (native pi/dsh runs, and hermes call paths that are not gate-wired yet) the
 * behaviour is byte-identical to the pre-G8 controller. This module
 * deliberately imports only the gate TYPES (`import type`), never an
 * observation/evaluation module, so it cannot accidentally become a second
 * evaluator.
 */

import { MatchlockRpcClient, isAlreadyStoppedCloseError, type MatchlockRpcClientOptions, type StreamNotify, type MatchlockPipeHandle, type MatchlockTtyHandle } from "./rpc-client.js";
import type { LaunchGateBinding } from "./launch-gate-wiring.js";
import { boundMatchlockErrorText } from "./runner-error.js";
import { MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE, matchlockSocketPathRefusal } from "./home-alias.js";
import {
  buildMatchlockCreateConfig,
  type MountAdmissionContext,
  validateWorkMounts,
} from "./mount-plan.js";
import { resolveImageIdentity, validatePinnedIdentity, verifyImageIdentity, type PinnedImageIdentity } from "./image.js";
import {
  cleanupDshProfileOverlay,
  DshProfileOverlayError,
  prepareDshProfileOverlay,
  publishDshHomeOverlayToHost,
} from "./dsh-profile-overlay.js";
import type { ExecutionIsolation } from "./policy.js";
import type {
  MatchlockCreateParams,
  MatchlockExecOptions,
  MatchlockExecResult,
  MatchlockRequestId,
  MatchlockTtyExecOptions,
} from "./types.js";

export interface MatchlockControllerLaunchGate {
  /**
   * The invocation id the caller RESOLVED and evaluated (interactive plan
   * invocation id / scheduled attempt invocation id). The binding must match
   * THIS id — a verdict from another invocation never authorises a create.
   */
  invocationId: string;
  /**
   * The gate verdict bound to {@link invocationId}, or `null` when no verdict
   * exists. A `null` binding is an explicit refusal, never a bypass: the
   * controller refuses to create a VM for it.
   */
  binding: LaunchGateBinding | null;
}

export interface MatchlockControllerOptions {
  /**
   * G8 ADMISSION-INTEGRATION US-004: the launch-gate BACKSTOP context for THIS
   * invocation. When present, `prepareAndCreate` refuses with
   * `matchlock_gate_verdict_missing` — BEFORE any state mutation or RPC child
   * spawn — unless `binding` exists, belongs to `invocationId`, and carries a
   * non-empty store-set key. The controller never re-evaluates the gate and
   * never falls back to a verdict belonging to another invocation. Absent ⇒
   * byte-identical prior behaviour (native pi/dsh runs are untouched). The
   * value is supplied by the gate callers (`interactive-session.ts` from the
   * admitted plan, `hermes-invocation-runner.ts` from the attempt binding).
   */
  launchGate?: MatchlockControllerLaunchGate;
  /** Absolute path/matchlock binary for the control RPC (tests inject a fake). */
  rpcBinaryPath?: string;
  /** Extra args for `matchlock rpc` (default ["rpc"]). */
  rpcArgs?: string[];
  /** Host path to the versioned RO guest helper pack. */
  helperPackHostPath?: string;
  /** Logger override. */
  onLog?: MatchlockRpcClientOptions["onLog"];
  /** Whether to require a pre-built guest helper pack (default true). */
  requireHelperPack?: boolean;
  /** Default request deadline (ms) for non-exec RPCs (pass-through). */
  requestTimeoutMs?: number;
  /** Distinct deadline (ms) for the `create` request. A cold VM boot + image
   *  pull can exceed the shared requestTimeoutMs default, so run-creation
   *  wiring should set an explicit create budget (default: inherit the
   *  client's requestTimeoutMs). */
  createTimeoutMs?: number;
  /** stdin write drain deadline (ms) (pass-through). */
  stdinDrainTimeoutMs?: number;
  /** exec_pipe `ready` observation deadline (ms) (pass-through). */
  readyTimeoutMs?: number;
  /** Bounded wait for in-flight execs to settle after cancel (ms). */
  execCancelSettleTimeoutMs?: number;
  /**
   * HOST-ATTESTED scoped progress resource (MTLK-PROGRESS): forwards the run
   * id into the create-config builder so the VM exports ONLY the per-run
   * progress resource directory at /workspace/runs/<runId> (RW) — the guest
   * progress document is backed by the host resource file and no sibling host
   * run state is mounted. Absent ⇒ no progress-resource mount is added
   * (byte-identical prior behavior).
   */
  progressResource?: { runId: string };
  /**
   * HOST-ATTESTED dsh private profile-overlay (DSH-PROFILE-OVERLAY US-002).
   *
   * When set (and the policy harness is "dsh") the controller owns the
   * per-invocation private overlay lifecycle: `prepareDshProfileOverlay`
   * creates THIS invocation's private overlay root (bound to the controller's
   * own host-generated `invocationId`) BEFORE `create`, the option is forwarded
   * into the create-config builder (with the invocation identity) so the
   * composed dsh home plan sources the effective home from it (never the host
   * farm), and finalization publishes/removes exactly that attested invocation
   * root ONLY under proven consumer quiescence (a wire-confirmed close, or a
   * provably-unused overlay) — a hard dispose or an unconfirmed close RETAINS
   * it (see `dshProfileOverlayStatus`). Absent ⇒ the builder refuses a dsh
   * policy with `dsh_profile_overlay_required`.
   */
  dshProfileOverlay?: { runId: string; liveStateRoot: string };
  /**
   * Mount-plan admission context override (deterministic home / live-state
   * root for tests). Defaults to the mount-plan module defaults (real operator
   * home / live Tamandua state root) when omitted.
   */
  mountAdmission?: MountAdmissionContext;
  /**
   * Extra guest environment merged OVER the create-config defaults
   * (PI_CODING_AGENT_DIR + the pinned harness override). Used by the
   * invocation runner to supply the guest helper-pack PATH prepend, the
   * invocation-bound TAMANDUA_* env and the attested suite namespace envs.
   * Never overrides the immutable image_identity pin.
   */
  createEnv?: Record<string, string>;
  /**
   * MTLK-INTERACTIVE (US-010): optional create-config builder override. When
   * omitted the workflow mount-plan builder (`buildMatchlockCreateConfig`) is
   * used unchanged, so every existing caller is byte-identical. Foreground
   * interactive sessions supply the shared interactive builder
   * (`buildInteractiveSessionCreateConfig`) so the VM carries the caller's
   * `owner_uid`/`owner_gid`, mounts the whole selected configuration directory
   * and omits the helper pack/progress resource.
   */
  buildCreateConfig?: (
    policy: ExecutionIsolation,
    identity: PinnedImageIdentity,
  ) => MatchlockCreateParams;
  /** Extra env keys merged over process.env for the RPC child (test seams). */
  rpcEnv?: Record<string, string>;
}

export interface MatchlockControllerIdentity {
  backend: "matchlock";
  invocationId: string;
  vmId: string | null;
  imageIdentity: PinnedImageIdentity | null;
  helperPackHostPath: string | null;
}

export type MatchlockExec = MatchlockExecResult;

/**
 * Guest-work admission lifecycle of a controller.
 *
 * - `open`: admission/create/exec work may proceed (a created VM exists for
 *   exec work).
 * - `closing`: a valid positive-timeout `close()` has begun; ALL invoking and
 *   guest work (admission, create, exec) is REVOKED (permanently — a
 *   failed/unconfirmed close never reopens it). Cleanup may be retried.
 * - `closed`: the VM close was CONFIRMED on the wire.
 * - `disposed`: `dispose()` (or an internal hard teardown) revoked work; the
 *   owned transport is being/has been killed. Idempotent terminal state.
 */
export type MatchlockControllerLifecycle = "open" | "closing" | "closed" | "disposed";

/**
 * Which invoking phase currently owns the controller's transport (if any).
 * `idle` = no admission in flight; `admitting` = a single-flight admission
 * owns a transport for resolve. A create invocation is tracked separately by
 * `invoked` + `createInFlight` (set synchronously at entry). close() waits for
 * a non-idle phase (admission OR create) to settle before it drives the
 * transport (single-owner discipline).
 */
type MatchlockControllerOpPhase = "idle" | "admitting";

/**
 * Evidence about a create that was in flight when work was revoked — the
 * exact owned cleanup obligation controller recovery must act on. Killing the
 * RPC transport does not prove the VM is gone, so this is preserved (never a
 * fabricated isClosed / never a reusable-open return).
 */
export interface MatchlockLateVmSettlement {
  /** VM id reported by the late create (null when the response never arrived
   *  because the transport was disposed first). */
  vmId: string | null;
  /** The identity that was sent as `create.image_identity`. */
  identity: PinnedImageIdentity | null;
  /** True ONLY after a close response CONFIRMED on the wire with the late VM
   *  existing (distinct from transport death). */
  cleanupConfirmed: boolean;
}

export class MatchlockControllerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockControllerError";
    this.code = code;
  }
}

/**
 * Hermes re-points TMPDIR at `<HERMES_HOME>/cache/scratch` at startup whenever
 * the caller has not set it (hermes_cli/main.py, `_export_scratch_tmp_env`).
 * Under Matchlock the Hermes home is a FUSE mount, and a Unix socket cannot be
 * bound on it. The gateway's control-socket path therefore falls back — and the
 * fallback resolves through `tempfile.gettempdir()`, i.e. that same TMPDIR — so
 * it lands on the very filesystem that just refused the bind and fails with
 * EOPNOTSUPP (errno 95), aborting bootstrap with "gateway session bootstrap
 * control listener unavailable".
 *
 * The guest's temp space must be guest-local. Pin `/tmp` whenever a Hermes home
 * is mapped, and only when the caller has not chosen a TMPDIR itself.
 */
export function applyGuestTempPolicy(env: Record<string, string> | undefined): void {
  if (env === undefined) return;
  if (env.HERMES_HOME && env.TMPDIR === undefined) env.TMPDIR = "/tmp";
}

/**
 * OVERLAY-INV-SCOPED: explicit disposition of the per-invocation dsh
 * profile-overlay finalization, tracked INDEPENDENTLY of the VM `closed` flag.
 *
 * - `none`: this controller owns no dsh overlay.
 * - `pending`: the overlay (if any) has been prepared but not yet finalized.
 * - `finalized`: TERMINAL — exactly this invocation's root was published
 *   (normal path) and/or removed, and no consumer could still exist.
 * - `retained`: consumer quiescence was UNPROVEN (hard dispose / transport
 *   death without a wire close) or publish/remove failed. The root is left in
 *   place (never removed) with typed evidence; a later `close()`/`dispose()`
 *   re-attempts when quiescence is now proven or re-reports the disposition.
 */
export type DshProfileOverlayDisposition =
  | { readonly status: "none" }
  | { readonly status: "pending" }
  | { readonly status: "finalized" }
  | {
      readonly status: "retained";
      readonly code: string;
      readonly reason: string;
      readonly quiescence: string;
    };

export class MatchlockController {
  private client: MatchlockRpcClient | null = null;
  private readonly clientOpts: MatchlockRpcClientOptions;
  private readonly policy: ExecutionIsolation;
  private readonly helperPackHostPath: string | null;
  private readonly createTimeoutMs: number | undefined;
  private readonly progressResource: { runId: string } | undefined;
  private readonly dshProfileOverlay: { runId: string; liveStateRoot: string } | undefined;
  private readonly mountAdmission: MountAdmissionContext | undefined;
  private readonly createEnv: Record<string, string> | undefined;
  private readonly buildCreateConfig:
    | ((policy: ExecutionIsolation, identity: PinnedImageIdentity) => MatchlockCreateParams)
    | undefined;
  private readonly rpcEnv: Record<string, string> | undefined;
  private readonly launchGate: MatchlockControllerLaunchGate | undefined;
  private pinnedIdentity: PinnedImageIdentity | null = null;
  private invoked = false;
  private vmId: string | null = null;
  private closed = false;
  private lifecycleState: MatchlockControllerLifecycle = "open";
  private closePromise: Promise<void> | null = null;
  private opPhase: MatchlockControllerOpPhase = "idle";
  private admissionPromise: Promise<PinnedImageIdentity> | null = null;
  private createInFlight: Promise<{ vmId: string; identity: PinnedImageIdentity }> | null = null;
  private lateVmRecord: MatchlockLateVmSettlement | null = null;
  /** True once a `create` request has actually been dispatched on the wire. */
  private createRequestSent = false;
  /**
   * OVERLAY-INV-SCOPED: overlay finalization disposition, tracked
   * INDEPENDENTLY of `closed`. `finalized` is terminal; a `retained` result is
   * re-attempted (when quiescence is now proven) or re-reported by later
   * close()/dispose() calls.
   */
  private overlayDisposition: DshProfileOverlayDisposition;

  readonly invocationId: string;

  constructor(policy: ExecutionIsolation, opts: MatchlockControllerOptions = {}) {
    this.policy = policy;
    this.helperPackHostPath = opts.helperPackHostPath ?? null;
    this.createTimeoutMs = opts.createTimeoutMs;
    this.progressResource = opts.progressResource;
    this.dshProfileOverlay = opts.dshProfileOverlay;
    this.mountAdmission = opts.mountAdmission;
    this.createEnv = opts.createEnv;
    this.buildCreateConfig = opts.buildCreateConfig;
    this.rpcEnv = opts.rpcEnv;
    this.launchGate = opts.launchGate;
    if (opts.requireHelperPack !== false && !this.helperPackHostPath) {
      // The guest pack is the only scoped bridge + helper source. Refuse to
      // run without it rather than fall back to the host harness.
      throw new MatchlockControllerError(
        "guest_bridge_unavailable",
        "A versioned RO guest helper pack host path is required to mount the scoped bridge; none was supplied.",
      );
    }
    this.invocationId = `inv-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`;
    this.overlayDisposition = this.hasDshProfileOverlay() ? { status: "pending" } : { status: "none" };
    // The controller builds transports lazily and per phase: admission
    // resolves over one owned child (then disposes it) and the create
    // invocation starts a FRESH owned child, so a disposed transport is never
    // reused or restarted.
    this.clientOpts = {
      binaryPath: opts.rpcBinaryPath,
      args: opts.rpcArgs,
      ...(this.rpcEnv ? { env: this.rpcEnv } : {}),
      onLog: opts.onLog,
      requestTimeoutMs: opts.requestTimeoutMs,
      stdinDrainTimeoutMs: opts.stdinDrainTimeoutMs,
      readyTimeoutMs: opts.readyTimeoutMs,
      execCancelSettleTimeoutMs: opts.execCancelSettleTimeoutMs,
    };
  }

  /** Backend/VM/invocation identity for the invocation manifest. */
  get identity(): MatchlockControllerIdentity {
    return {
      backend: "matchlock",
      invocationId: this.invocationId,
      vmId: this.vmId,
      imageIdentity: this.pinnedIdentity,
      helperPackHostPath: this.helperPackHostPath,
    };
  }

  /** The pinned identity this controller sent (or will send) as image_identity. */
  get pinnedImageIdentity(): PinnedImageIdentity | null {
    return this.pinnedIdentity;
  }

  /** True once the VM close has been CONFIRMED on the wire. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Guest-work admission lifecycle (open → closing → closed/disposed). */
  get lifecycle(): MatchlockControllerLifecycle {
    return this.lifecycleState;
  }

  /** Whether the RPC transport child is still running (owned liveness). */
  get rpcRunning(): boolean {
    return this.client?.isRunning ?? false;
  }

  /** Observable RPC child exit (code/signal) once it has exited. The signal
   *  is the REAL owned-child signal (e.g. "SIGTERM" after dispose) — a
   *  signaled transport is never reported as a success-shaped record.
   *  null/null while (or before) running is accurate. */
  get rpcExit(): { code: number | null; signal: string | null } {
    return { code: this.client?.exitCode ?? null, signal: this.client?.exitSignal ?? null };
  }

  /** Late-create settlement evidence (create in flight when work was revoked),
   *  or null when no create ever raced a revocation. Preserved for controller
   *  recovery — see `MatchlockLateVmSettlement`. */
  get lateVm(): MatchlockLateVmSettlement | null {
    return this.lateVmRecord;
  }

  /** Build a fresh owned RPC transport (same options as the controller). */
  private buildClient(): MatchlockRpcClient {
    return new MatchlockRpcClient(this.clientOpts);
  }

  /** HOME the Matchlock control child will actually be spawned with: the
   *  per-round verified alias (`rpcEnv.HOME`) when present, else the host
   *  process HOME. This is the value Matchlock derives every socket path from. */
  private effectiveRpcHome(): string {
    const fromRpcEnv = this.rpcEnv?.HOME;
    if (typeof fromRpcEnv === "string" && fromRpcEnv.length > 0) return fromRpcEnv;
    return process.env.HOME ?? "";
  }

  /** True when this controller owns a dsh per-invocation profile overlay. */
  private hasDshProfileOverlay(): boolean {
    return this.dshProfileOverlay !== undefined && this.policy.harness === "dsh";
  }

  /**
   * OVERLAY-INV-SCOPED: observable overlay finalization disposition. Tests and
   * controller recovery read this to distinguish a terminal published+removed
   * result from an explicitly RETAINED (quiescence-unproven / failed) one.
   */
  get dshProfileOverlayStatus(): DshProfileOverlayDisposition {
    return this.overlayDisposition;
  }

  /**
   * DSH-PROFILE-OVERLAY US-002 / OVERLAY-INV-SCOPED: stage THIS invocation's
   * private dsh profile-overlay root (a private copy of the host effective
   * DSH_HOME `profiles/` tree, with install-derived dirs empty) before
   * `create`. The root is bound to the controller's own host-generated
   * `invocationId` and allocated EXCLUSIVELY, so two overlapping invocations of
   * one run can never share (and therefore destroy) one mounted overlay root.
   * No-op for non-dsh policies or when the host attestation is absent (the
   * mount-plan builder refuses a dsh policy without it).
   */
  private prepareDshProfileOverlayForInvocation(): void {
    if (!this.hasDshProfileOverlay()) return;
    const overlay = this.dshProfileOverlay;
    if (!overlay) return;
    prepareDshProfileOverlay(
      overlay.runId,
      this.invocationId,
      overlay.liveStateRoot,
      this.policy.configurationRoot,
    );
    this.overlayDisposition = { status: "pending" };
  }

  /**
   * Evidence that NO consumer of the overlay can exist. Quiescence is PROVEN
   * only when either:
   *
   *   - the VM close was CONFIRMED on the wire (`closed`) — the single-shot
   *     invocation can never create again; or
   *   - the create was NEVER dispatched (`!createRequestSent`) AND work
   *     revocation is already irrevocable (`closing`/`disposed`), so the
   *     post-resolve lifecycle recheck in `doPrepareAndCreate` can never
   *     dispatch a create and no other continuation allocates an overlay
   *     (allocation is synchronous and precedes any await).
   *
   * Every other state — a dispatched create with no wire close response,
   * transport death, a late/unknown VM — leaves quiescence UNPROVEN. A single
   * false `createRequestSent` read alone is never treated as proof: the
   * revocation must be simultaneously irrevocable.
   */
  private overlayQuiescenceProof(context: string): { proven: boolean; how: string } {
    if (this.closed) return { proven: true, how: "wire-confirmed-close" };
    const revoked = this.lifecycleState === "closing" || this.lifecycleState === "disposed";
    if (!this.createRequestSent && revoked) return { proven: true, how: "no-consumer" };
    return {
      proven: false,
      how: this.createRequestSent
        ? `create-dispatched-without-wire-close (${context})`
        : `revocation-not-irrevocable (${context})`,
    };
  }

  /** Structured, non-fatal log of an overlay disposition change. */
  private logOverlayDisposition(): void {
    const d = this.overlayDisposition;
    const level = d.status === "retained" ? "warn" : "info";
    this.clientOpts.onLog?.(level, `dsh profile overlay ${d.status}`, {
      runId: this.dshProfileOverlay?.runId,
      invocationId: this.invocationId,
      vmId: this.vmId,
      createRequestSent: this.createRequestSent,
      closed: this.closed,
      lifecycle: this.lifecycleState,
      ...(d.status === "retained" ? { code: d.code, reason: d.reason, quiescence: d.quiescence } : {}),
    });
  }

  /**
   * OVERLAY-INV-SCOPED single finalization operation. A terminal
   * `published+removed` result is shared by every later close()/dispose() call;
   * a `retained` result is re-attempted when quiescence is now proven or
   * re-reported otherwise. Returns `true` when the overlay is terminal
   * (`finalized`/`none`), `false` when it is retained.
   *
   * Quiescence gate: publish ONLY on a wire-confirmed close (normal path:
   * publish THEN remove own root); on a proven no-consumer invocation remove
   * own UNUSED root without publishing; on any unproven path RETAIN the root
   * (no removal, no premature publish) with a typed disposition. Never equate
   * RPC transport exit with VM termination.
   */
  private tryFinalizeDshProfileOverlay(proof: { proven: boolean; how: string }): boolean {
    if (!this.hasDshProfileOverlay()) return true;
    if (this.overlayDisposition.status === "finalized") return true;
    const overlay = this.dshProfileOverlay;
    if (!overlay) return true;
    if (!proof.proven) {
      this.overlayDisposition = {
        status: "retained",
        code: "dsh_profile_overlay_retained",
        reason: `consumer quiescence unproven; overlay retained (${proof.how})`,
        quiescence: proof.how,
      };
      this.logOverlayDisposition();
      return false;
    }
    try {
      if (proof.how === "wire-confirmed-close") {
        // Normal path: the VM close is CONFIRMED on the wire, so merge the
        // guest-written durable entries back (never profiles/) BEFORE removing
        // exactly this invocation's root.
        publishDshHomeOverlayToHost(
          overlay.runId,
          this.invocationId,
          overlay.liveStateRoot,
          this.policy.configurationRoot,
        );
      }
      // `no-consumer`: the overlay is unused, so remove own root without
      // publishing (nothing was ever written into it by a consumer).
      cleanupDshProfileOverlay(overlay.runId, this.invocationId, overlay.liveStateRoot);
      this.overlayDisposition = { status: "finalized" };
      this.logOverlayDisposition();
      return true;
    } catch (err) {
      const code = err instanceof DshProfileOverlayError ? err.code : "dsh_profile_overlay_finalize_failed";
      this.overlayDisposition = {
        status: "retained",
        code,
        reason: (err as Error).message,
        quiescence: proof.how,
      };
      this.logOverlayDisposition();
      return false;
    }
  }

  /**
   * Re-attempt or re-report finalization after a wire-confirmed VM close. This
   * is the ONLY path that publishes. Throws a typed error when the overlay
   * remains retained after the attempt so a failed publish/remove is never
   * masked as a successful close.
   */
  private finalizeConfirmedCloseOrThrow(): void {
    if (!this.hasDshProfileOverlay()) return;
    if (!this.tryFinalizeDshProfileOverlay({ proven: true, how: "wire-confirmed-close" })) {
      const d = this.overlayDisposition as Extract<DshProfileOverlayDisposition, { status: "retained" }>;
      throw new MatchlockControllerError(
        d.code,
        `dsh profile overlay finalization failed after the wire-confirmed VM close; overlay RETAINED (${d.reason}); retry close()/dispose()`,
      );
    }
  }

  /**
   * Pre-flight SUN_LEN guard (US-004 / item 1b): before ANY RPC child is
   * spawned, compute the longest unix socket path Matchlock would produce from
   * the HOME about to be passed and fail closed with a typed
   * `matchlock_home_socket_path_too_long` error when it would not fit Linux's
   * 107-byte `sun_path` limit. The message names the limit, the computed length,
   * the HOME in use and the remedy, and flows through the structured-error path
   * (`classifyInvocationError`) so the real cause is always visible (F4).
   */
  private requireMatchlockSocketPathFits(home: string): void {
    const refusal = matchlockSocketPathRefusal(home);
    if (refusal === null) return;
    throw new MatchlockControllerError(MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE, refusal.message);
  }

  /** The transport for the NEXT phase: the live one if present, otherwise a
   *  fresh owned child (a disposed or exited transport is never reused). */
  private nextTransport(): MatchlockRpcClient {
    if (this.client && this.client.isRunning) return this.client;
    this.client = this.buildClient();
    return this.client;
  }

  /**
   * Terminal work-admission barrier. BOTH invoking operations
   * (resolveAndAdmitIdentity and prepareAndCreate) require lifecycle `open` at
   * entry — closing/closed/disposed never reopen, including a valid
   * close-before-create whose cleanup failed because no transport existed.
   */
  private requireLifecycleOpen(operation: string): void {
    switch (this.lifecycleState) {
      case "open":
        return;
      case "closing":
        throw new MatchlockControllerError(
          "controller_closing",
          `cannot ${operation}: a valid controller close has begun and never reopens work (closing); use a fresh controller for a new invocation`,
        );
      case "closed":
        throw new MatchlockControllerError(
          "controller_closed",
          `cannot ${operation}: controller is closed and never reopens work; use a fresh controller for a new invocation`,
        );
      case "disposed":
        throw new MatchlockControllerError(
          "controller_disposed",
          `cannot ${operation}: controller is disposed and never reopens work; use a fresh controller for a new invocation`,
        );
    }
  }

  /**
   * G8 US-004 — the controller's launch-gate BACKSTOP.
   *
   * A preflight verdict is evidence about a RESOLVED INVOCATION, so it is only
   * usable by the invocation it was decided for. This check is a pure binding
   * read (no re-evaluation, no fallback to any earlier verdict) executed
   * synchronously BEFORE any state mutation, overlay preparation or RPC child
   * spawn:
   *
   *   - no `launchGate` context  ⇒ native / not-gate-wired caller, no check;
   *   - `binding === null`       ⇒ refuse (no verdict exists);
   *   - binding.invocationId ≠ this invocation id ⇒ refuse (a foreign verdict
   *     never authorises THIS create);
   *   - empty/missing storeSetKey ⇒ refuse (a verdict that binds no store set
   *     proves nothing).
   *
   * The refusal is `matchlock_gate_verdict_missing` and names the invocation id
   * and — when a (foreign) receipt exists — its path, so an operator can see
   * exactly which verdict was present and which one was required.
   */
  private requireLaunchGateVerdict(): void {
    const gate = this.launchGate;
    if (gate === undefined) return;
    const invocationId = typeof gate.invocationId === "string" ? gate.invocationId : "";
    const binding = gate.binding ?? null;
    const storeSetKey = binding !== null && typeof binding.storeSetKey === "string" ? binding.storeSetKey.trim() : "";
    if (binding !== null && invocationId !== "" && binding.invocationId === invocationId && storeSetKey !== "") {
      return;
    }
    const receiptPath =
      binding !== null && typeof binding.receiptPath === "string" && binding.receiptPath.trim() !== ""
        ? binding.receiptPath.trim()
        : null;
    const reason =
      binding === null
        ? "no launch-gate verdict exists for this invocation"
        : invocationId === ""
          ? "the resolved invocation id is missing, so no verdict can be bound to it"
          : binding.invocationId !== invocationId
            ? `the only available verdict belongs to a DIFFERENT invocation (${binding.invocationId})`
            : "the available verdict carries no store-set key";
    const message =
      `refusing to create a VM: ${reason}; required invocation ${invocationId !== "" ? invocationId : "<missing>"}, ` +
      `receipt ${receiptPath !== null ? receiptPath : "<none recorded>"} ` +
      "(the launch gate must evaluate and record a verdict for THIS invocation before the controller may create; " +
      "the controller never re-evaluates)";
    throw new MatchlockControllerError(
      "matchlock_gate_verdict_missing",
      boundMatchlockErrorText(message, 1024),
    );
  }

  /**
   * SEPARATE admission path: resolve and validate the requested image tag over
   * a bounded OWNED RPC transport and return the pinned content+config
   * identity WITHOUT EVER issuing `create`. The transport is disposed before
   * this resolves, so the caller can persist the identity and only then start
   * the first invocation with `prepareAndCreate(expected)`. A failure (e.g. a
   * resolve error) also disposes the owned transport before propagating.
   *
   * Admission is lifecycle-gated at entry and single-flight: overlapping
   * calls JOIN the in-flight admission (one owned transport, one resolve),
   * and admission after a create invocation has begun fails closed.
   */
  async resolveAndAdmitIdentity(): Promise<PinnedImageIdentity> {
    this.requireLifecycleOpen("admit an image identity");
    // Pre-flight BEFORE any child spawn: a HOME whose longest Matchlock socket
    // path would exceed the Linux sun_path limit can never resolve/create.
    this.requireMatchlockSocketPathFits(this.effectiveRpcHome());
    if (this.invoked) {
      throw new MatchlockControllerError(
        "controller_already_invoked",
        "A controller instance invokes exactly once; admission must precede the create invocation.",
      );
    }
    // Single-flight: join an admission that already owns the transport.
    if (this.admissionPromise) return this.admissionPromise;
    this.opPhase = "admitting";
    const p = this.doAdmission();
    this.admissionPromise = p;
    try {
      return await p;
    } finally {
      if (this.admissionPromise === p) this.admissionPromise = null;
      if (this.opPhase === "admitting") this.opPhase = "idle";
    }
  }

  /** One bounded admission: resolve over a fresh owned child, dispose it in a
   *  finally on EVERY path (never a leaked child, never a shared one). */
  private async doAdmission(): Promise<PinnedImageIdentity> {
    const client = this.nextTransport();
    client.start();
    try {
      return await resolveImageIdentity((tag) => client.resolveImage(tag), this.policy.requestedImage);
    } finally {
      await client.dispose().catch(() => {});
    }
  }

  /**
   * Create the VM with the REQUIRED persisted immutable image identity.
   *
   * @param expected The persisted expected identity captured by the FIRST
   *   admission (`resolveAndAdmitIdentity()`) BEFORE the first VM create.
   *   REQUIRED in TypeScript and enforced at runtime for JS/undefined/null
   *   callers — a missing or invalid pin fails BEFORE any state mutation or
   *   child spawn (there is no implicit re-pin convenience path). The tag is
   *   re-resolved and compared against `expected` BEFORE any create; a
   *   moved/repinned image fails closed with NO create request issued. The
   *   EXPECTED identity is what `create.image_identity` carries.
   * @returns the VM id and the pinned identity actually sent as
   *   `create.image_identity`.
   *
   * Lifecycle/phase discipline: entry requires lifecycle `open` (closing/
   * closed/disposed permanently bar create), and the OPEN state is re-checked
   * AFTER the awaited image resolution and BEFORE issuing `create` — a close/
   * dispose that raced the resolve can never see a create. If the create was
   * ALREADY accepted/in-flight when close was requested and its response
   * arrives late, the VM is an exact owned cleanup obligation: this rejects
   * with `late_vm_cleanup_required`, records `lateVm` evidence, and leaves the
   * live transport for the pending close() to confirm cleanup.
   *
   * Owned-child cleanup: this controller is single-shot (a fresh VM per
   * invocation), so the spawned `matchlock rpc` child can never be reused for
   * a retry. ANY failure after `start()` therefore disposes the owned child
   * before the error propagates — except `late_vm_cleanup_required`, where the
   * pending close() owns transport cleanup. A moved-tag/create retry loop must
   * not leak one idle RPC child per failed attempt. Callers still SHOULD
   * `dispose()` a controller they abandon, and `close()` after a successful
   * create.
   */
  async prepareAndCreate(expected: PinnedImageIdentity): Promise<{ vmId: string; identity: PinnedImageIdentity }> {
    // Entry barriers are synchronous (before any await or child spawn): a
    // closing/closed/disposed controller can NEVER create, even when the
    // close that revoked it failed because no transport ever existed.
    this.requireLifecycleOpen("create a VM");
    // G8 US-004 launch-gate backstop: also synchronous, also before any state
    // mutation or child spawn. A gate-wired caller must present a verdict that
    // belongs to THIS invocation; the controller never re-evaluates and never
    // accepts a verdict recorded for a different invocation.
    this.requireLaunchGateVerdict();
    // Pre-flight SUN_LEN guard at the create entry too, so `create` can never
    // spawn an RPC child for a HOME whose socket path would not fit (this
    // mirrors resolveAndAdmitIdentity's admission entry).
    this.requireMatchlockSocketPathFits(this.effectiveRpcHome());
    if (this.invoked) {
      throw new MatchlockControllerError("controller_already_invoked", "A controller instance invokes exactly once.");
    }
    if (this.opPhase === "admitting") {
      throw new MatchlockControllerError(
        "controller_admission_in_progress",
        "an admission is resolving over the owned transport right now; persist its identity and call prepareAndCreate after it settles (single-flight: never a second child)",
      );
    }
    // Runtime-required persisted pin: JS/undefined/null callers fail HERE,
    // before any state change or child spawn, so create can never happen
    // before the caller persists the first-admission identity.
    if (expected === null || expected === undefined) {
      throw new MatchlockControllerError(
        "image_identity_required",
        "prepareAndCreate requires the persisted expected image identity (content + config) captured before the first VM create; call resolveAndAdmitIdentity() first and persist it",
      );
    }
    // The persisted expected identity must itself pin content+config; an empty
    // pin proves nothing and must fail before any create.
    const pin = validatePinnedIdentity(expected, "expected (persisted) image identity");
    // DSH-PROFILE-OVERLAY US-002: create the private per-run overlay directories
    // BEFORE the VM create, so the composed dsh home plan has a private source
    // for every install-derived profile module dir. Placed before `invoked` is
    // set, so a preparation failure does not consume the single-shot invocation.
    this.prepareDshProfileOverlayForInvocation();
    this.invoked = true;

    // Track the phase synchronously so close()/admission racing it see the
    // owning phase immediately (single-owner transport discipline).
    const p = this.doPrepareAndCreate(pin);
    this.createInFlight = p;
    try {
      return await p;
    } finally {
      if (this.createInFlight === p) this.createInFlight = null;
    }
  }

  private async doPrepareAndCreate(pin: PinnedImageIdentity): Promise<{ vmId: string; identity: PinnedImageIdentity }> {
    // Fresh RPC subprocess (per invocation => per probe/work/retry).
    const client = this.nextTransport();
    client.start();
    try {
      // Re-resolve the tag every invocation and compare against the expected
      // identity BEFORE create: a moved tag never reaches the create request.
      const resolved = await resolveImageIdentity((tag) => client.resolveImage(tag), this.policy.requestedImage);
      // Lifecycle recheck AFTER the awaited image resolution and BEFORE any
      // create: close/cancel/dispose that raced the resolve must never see a
      // create request issued.
      this.requireLifecycleOpen("issue create after image resolution");
      verifyImageIdentity(pin, resolved);

      this.pinnedIdentity = pin;
      this.createRequestSent = true;
      const created = await client.create(
        this.buildCreateParams(this.helperPackHostPath, pin),
        this.createTimeoutMs !== undefined ? { timeoutMs: this.createTimeoutMs } : undefined,
      );
      if (this.lifecycleState !== "open") {
        // Late VM: the create was accepted/in-flight when close was requested.
        // It is an exact owned CLEANUP OBLIGATION — never returned usable/open,
        // never a fabricated isClosed. Preserve vmId + identity as evidence and
        // leave the live transport for the pending close() to confirm cleanup
        // (do NOT dispose it here: that would kill the transport underneath
        // the close that owns the cleanup).
        this.vmId = created.id;
        this.lateVmRecord = { vmId: created.id, identity: pin, cleanupConfirmed: false };
        throw new MatchlockControllerError(
          "late_vm_cleanup_required",
          `VM ${created.id} was created after close was requested; it is an owned cleanup obligation, not usable open work (lateVm evidence preserved; isClosed is only set by a confirmed close response)`,
        );
      }
      this.vmId = created.id;
      return { vmId: created.id, identity: pin };
    } catch (err) {
      if (err instanceof MatchlockControllerError && err.code === "late_vm_cleanup_required") {
        // The pending close() owns transport cleanup for this late VM.
        throw err;
      }
      // A post-start failure leaves an idle owned RPC child that can never be
      // reused (single-shot). Dispose it BEFORE rethrowing so the caller's
      // retry loop does not leak one `matchlock rpc` child per failed attempt.
      await client.dispose().catch(() => {});
      if (this.createRequestSent && this.lifecycleState === "disposed" && this.vmId === null && !this.lateVmRecord) {
        // A create request was IN FLIGHT when the transport was disposed: the
        // runtime may have accepted it. Killing the RPC child alone does NOT
        // prove the VM is gone — preserve failure/identity evidence for
        // controller recovery instead of claiming transport death settled it.
        this.lateVmRecord = { vmId: null, identity: pin, cleanupConfirmed: false };
      }
      throw err;
    }
  }

  /** Build the create params from the policy + pinned identity. */
  buildCreateParams(helperPackHostPath: string | null, identity: PinnedImageIdentity): MatchlockCreateParams {
    validateWorkMounts(this.policy.workMounts);
    // Interactive foreground sessions supply the shared interactive builder as
    // an override; every workflow caller keeps the mount-plan builder (and its
    // helper-pack requirement) byte-for-byte.
    const cfg = this.buildCreateConfig
      ? this.buildCreateConfig(this.policy, identity)
      : buildMatchlockCreateConfig(this.policy, identity, {
          helperPackHostPath: helperPackHostPath ?? undefined,
          ...(this.progressResource ? { progressResource: this.progressResource } : {}),
          ...(this.dshProfileOverlay && this.policy.harness === "dsh"
            ? { dshProfileOverlay: { ...this.dshProfileOverlay, invocationId: this.invocationId } }
            : {}),
          ...(this.mountAdmission ? { admission: this.mountAdmission } : {}),
        });
    // Invocation-bound guest env (helper-pack PATH prepend, TAMANDUA_* identity
    // and attested suite env) is merged OVER the immutable planner defaults.
    // PI_CODING_AGENT_DIR (the harness directory override) stays pinned by the
    // planner — the runner supplies only additive keys.
    if (this.createEnv && Object.keys(this.createEnv).length > 0) {
      cfg.env = { ...(cfg.env ?? {}), ...this.createEnv };
    }
    applyGuestTempPolicy(cfg.env);
    return cfg;
  }

  /** Run a guest command with streamed stdout/stderr. */
  async execStream(cmd: MatchlockExecOptions, notify: StreamNotify, timeoutMs?: number): Promise<MatchlockExec> {
    this.requireAdmitted();
    const client = this.client;
    if (!client) throw new MatchlockControllerError("vm_not_created", "VM not created; call prepareAndCreate first");
    return client.execStream(cmd, notify, { timeoutMs });
  }

  /** Run a guest command in pipe mode (stdin written by the caller). */
  execPipe(cmd: MatchlockExecOptions, notify: StreamNotify, timeoutMs?: number): MatchlockPipeHandle {
    this.requireAdmitted();
    const client = this.client;
    if (!client) throw new MatchlockControllerError("vm_not_created", "VM not created; call prepareAndCreate first");
    return client.execPipe(cmd, notify, { timeoutMs });
  }

  /**
   * Run a guest command in interactive PTY mode (`exec_tty`). Requires an
   * admitted VM and delegates to the owned RPC client; the returned handle
   * exposes readiness-gated `stdin`, `resize(rows, cols)` and `result`.
   */
  execTty(cmd: MatchlockTtyExecOptions, notify: StreamNotify, timeoutMs?: number): MatchlockTtyHandle {
    this.requireAdmitted();
    const client = this.client;
    if (!client) throw new MatchlockControllerError("vm_not_created", "VM not created; call prepareAndCreate first");
    return client.execTty(cmd, notify, { timeoutMs });
  }

  /** Cancels an in-flight guest exec request. */
  async cancel(requestId: MatchlockRequestId): Promise<boolean> {
    const client = this.client;
    if (!client) throw new MatchlockControllerError("vm_not_created", "VM not created; call prepareAndCreate first");
    const r = await client.cancel(requestId);
    return r.cancelled;
  }

  /**
   * Gracefully close the owned VM with a POSITIVE timeout. Validates BEFORE
   * mutating any state (a rejected close(0) must NOT revoke work or silently
   * no-op a later close(30)); revokes NEW admission/create/exec work
   * SYNCHRONOUSLY BEFORE cancellation starts (the runtime's close waits for
   * handlers); then — single-owner phase discipline — waits (bounded by the
   * phase's own request deadlines) for an in-flight admission/create phase to
   * settle before driving the transport. Marks the controller closed ONLY
   * after the server CONFIRMS the close response. A failed/unconfirmed close
   * lets the caller retry `close()` or use `dispose()`, but admission for
   * guest work stays REVOKED from the moment a valid close was requested —
   * it never reopens.
   *
   * MTLK-CLEANUP US-004 — already-stopped idempotency: a close RESPONSE that
   * names an already-stopped / already-closed / "vm not running" VM is a
   * confirmation (the VM is gone) and marks the controller closed exactly like
   * a successful close; it never becomes a `matchlock_cleanup_failed`. A dead
   * transport with NO wire response still throws (isClosed is never fabricated
   * from transport death). On an already-`closed` controller close re-attempts
   * (or re-reports) the dsh overlay finalization instead of hiding it: the VM
   * close is confirmed, so quiescence is proven and a retained overlay is
   * published+removed — or the refusal is thrown again.
   */
  async close(timeoutSeconds: number): Promise<void> {
    if (this.closed) {
      // VM close already CONFIRMED on the wire. Overlay finalization is
      // tracked INDEPENDENTLY of `closed`: re-attempt it (quiescence is now
      // proven) or re-report a retained result — a failed publish/cleanup is
      // never masked by this no-op-shaped call.
      this.finalizeConfirmedCloseOrThrow();
      return;
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new MatchlockControllerError(
        "invalid_close_timeout",
        `matchlock close requires a positive timeout_seconds (got ${timeoutSeconds})`,
      );
    }
    if (this.lifecycleState === "disposed") {
      throw new MatchlockControllerError("controller_disposed", "controller is disposed; close is not possible");
    }
    if (this.lifecycleState === "closing") {
      // An in-flight close is shared; a FAILED close (closePromise cleared)
      // falls through so cleanup can be retried — but admission never reopens.
      if (this.closePromise) return this.closePromise;
    }
    // Revoke new admission/create/exec work BEFORE cancellation starts: no
    // invoking or guest operation may enter while live work is being settled.
    this.lifecycleState = "closing";
    this.closePromise = this.runClose(timeoutSeconds);
    try {
      await this.closePromise;
    } catch (err) {
      // Failed/unconfirmed cleanup: allow the caller to retry close or
      // dispose. Admission stays REVOKED (closing) — never reopened.
      this.closePromise = null;
      throw err;
    }
  }

  /** Phase single-owner discipline: let an in-flight admission/create phase
   *  settle (its own deadlines make this bounded) before close drives the
   *  transport — close never shares or disposes a transport mid-phase. */
  private async runClose(timeoutSeconds: number): Promise<void> {
    const pending = this.createInFlight ?? this.admissionPromise;
    if (pending) {
      try {
        await pending;
      } catch {
        // The phase reports its own error to its own caller; close continues
        // with cleanup on whatever transport state remains.
      }
    }
    await this.doCloseTransport(timeoutSeconds);
  }

  private async doCloseTransport(timeoutSeconds: number): Promise<void> {
    const client = this.client;
    if (!client || !client.isRunning) {
      // No LIVE transport to confirm a close against (never started, the
      // owning phase disposed it, or the owned RPC child already exited).
      // VM-close confirmation is DISTINCT from transport termination: isClosed
      // must never be set merely because the RPC child exited, so a confirmed
      // close cannot be fabricated here. The overlay is removed ONLY when the
      // no-consumer proof holds (create never dispatched + revocation
      // irrevocable); otherwise it is RETAINED with a typed disposition.
      this.tryFinalizeDshProfileOverlay(this.overlayQuiescenceProof("close-no-live-transport"));
      throw new MatchlockControllerError(
        "matchlock_cleanup_failed",
        "no live matchlock rpc transport to confirm close; use dispose() for hard teardown",
      );
    }
    // Settle live exec requests before close (server close waits handlers).
    // NOTE: today this registers the exec-family methods the client can put in
    // flight (exec/exec_stream/exec_pipe/exec_tty). A later guest-bridge stage
    // that runs long-lived bridge requests through this controller MUST
    // register them here too, otherwise close would wait on their handlers.
    await client.cancelInFlightExecRequests();
    // Confirmed close on the wire. MTLK-CLEANUP US-004: a recognized
    // already-stopped / already-closed / "vm not running" close RESPONSE is a
    // CONFIRMED close (the rpc client resolves it as such), so a guest-exited
    // VM whose close reports it is already gone is idempotent, not a cleanup
    // failure. The try/catch is defense-in-depth for a transport that surfaces
    // the recognized body as a rejection: it is swallowed as confirmed. Any
    // other failure — including a dead transport with NO wire response, which
    // `isAlreadyStoppedCloseError` refuses — leaves quiescence UNPROVEN: the
    // overlay is RETAINED with a typed disposition and the error propagates
    // (matchlock_cleanup_failed).
    try {
      await client.close(timeoutSeconds);
    } catch (err) {
      if (!isAlreadyStoppedCloseError(err)) {
        this.tryFinalizeDshProfileOverlay({ proven: false, how: "unconfirmed-close" });
        throw err;
      }
    }
    this.closed = true;
    // A terminal `disposed` state is never overwritten by a late successful
    // close transition.
    if (this.lifecycleState !== "disposed") this.lifecycleState = "closed";
    if (this.lateVmRecord && !this.lateVmRecord.cleanupConfirmed) {
      // A close response CONFIRMED on the wire after the late VM existed:
      // cleanup is confirmed (still distinct from transport death).
      this.lateVmRecord = { ...this.lateVmRecord, cleanupConfirmed: true };
    }
    // DSH-PROFILE-OVERLAY US-002 / OVERLAY-INV-SCOPED: the VM close is
    // CONFIRMED on the wire, so this invocation's private overlay is no longer
    // in use — finalization (publish THEN remove own root) runs under the same
    // quiescence gate. Finalization is tracked independently of `closed`; a
    // failure here stays visible on subsequent close()/dispose() calls instead
    // of becoming a hidden success. Never runs for an unconfirmed close.
    this.finalizeConfirmedCloseOrThrow();
  }

  /** Tear down without graceful close (cancel/abort path). Revokes guest work
   *  IMMEDIATELY (before the kill is observed), kills the EXACT owned RPC
   *  child and resolves once the child close is observed. Idempotent.
   *
   *  OVERLAY-INV-SCOPED: killing the RPC transport does NOT prove the VM is
   *  gone, so the overlay is RETAINED (never published, never removed) unless
   *  quiescence is positively proven — a confirmed wire close already observed
   *  (`closed`) or a provably unused overlay (create never dispatched and
   *  revocation irrevocable). Retention is a filesystem decision only: the
   *  owned transport is still killed. */
  dispose(): Promise<{ code: number | null; signal: string | null }> {
    this.lifecycleState = "disposed";
    this.tryFinalizeDshProfileOverlay(this.overlayQuiescenceProof("dispose"));
    return this.client ? this.client.dispose() : Promise.resolve({ code: null, signal: null });
  }

  private requireAdmitted(): void {
    if (!this.vmId) {
      throw new MatchlockControllerError("vm_not_created", "VM not created; call prepareAndCreate first");
    }
    if (this.lifecycleState === "closing") {
      throw new MatchlockControllerError(
        "controller_closing",
        "guest work is revoked: controller close has begun (a valid close never reopens admission)",
      );
    }
    if (this.lifecycleState === "closed") {
      throw new MatchlockControllerError("controller_closed", "controller is closed; guest work is denied");
    }
    if (this.lifecycleState === "disposed") {
      throw new MatchlockControllerError("controller_disposed", "controller is disposed; guest work is denied");
    }
  }
}
