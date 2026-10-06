/**
 * MTLK-INTERACTIVE (US-004) — interactive session admission planning.
 *
 * `planInteractiveSession` is the single admission seam for the four foreground
 * interactive commands (`tamandua matchlock pi|pi-shell|hermes|hermes-shell`).
 * It deliberately reuses the shipped slice-1 admission machinery rather than
 * introducing a parallel policy/image path:
 *
 *   1. Capture the caller's numeric uid/gid, HOME, cwd and the pi/Hermes
 *      configuration-selection inputs BEFORE anything could mutate the Matchlock
 *      process environment (this module performs no environment mutation).
 *   2. Apply the shared R13 root-usage gate FIRST (US-003) — before any
 *      capability probe, image resolve or RPC dispatch — so a refused root
 *      invocation touches nothing.
 *   3. Require a terminal on stdin AND stdout before any admission/RPC.
 *   4. For the hermes harness, resolve/validate the effective Hermes selection
 *      from the FROZEN submission inputs through the shipped adapter (US-007);
 *      a refused profile, non-local terminal backend, missing/non-directory
 *      config source or required external dependency refuses before any RPC.
 *   5. Resolve the image through `resolveMatchlockImageReference` (the SAME
 *      shared precedence the parser used) and run the bounded R8 swap-capability
 *      probe against the binary the admission will actually use.
 *   6. Call the shipped `admitMatchlockRun` with `workspaceMode: "direct"` and
 *      the parser-resolved resource limits/allow-private list to obtain the
 *      version-3 policy and immutable pinned identity (the hermes branch
 *      re-resolves the same frozen submission).
 *
 * Fail-closed boundaries (never permissive admission, never a silent skip,
 * never a host-execution fallback):
 *   - missing standard image  -> typed `matchlock_standard_image_missing` naming
 *     `tamandua matchlock setup` as the remedy;
 *   - missing explicit image  -> typed `matchlock_explicit_image_missing`
 *     requiring operator provisioning;
 *   - no TTY                  -> typed `matchlock_interactive_tty_required`;
 *   - unconfirmed swap capability -> typed `matchlock_swap_unsupported`.
 *
 * PROVISIONAL GAPS: GAP-02 (R8 swap probe, local `swap-support.ts`) and GAP-10
 * (provenance-aware missing-image remedy). Both are recorded in
 * INTEGRATION-NOTES.md with reconciliation instructions. Nothing in this module
 * is real-VM qualification.
 */

import os from "node:os";

import {
  admitMatchlockRun,
  MatchlockAdmissionError,
  type MatchlockAdmissionOptions,
  type MatchlockAdmissionResult,
  type MatchlockAllowPrivateSupportProbe,
} from "./admission.js";
import { resolveMatchlockRpcBinaryPath } from "./allow-private-support.js";
import type { PinnedImageIdentity } from "./image.js";
import type { MountAdmissionContext } from "./mount-plan.js";
import {
  resolvePiConfigProfile,
  resolvePiConfigRoot,
  type ExecutionIsolation,
  type ExecutionIsolationResourceLimits,
} from "./policy.js";
import { assertMatchlockRootUsageAllowed } from "./root-gate.js";
import {
  resolveMatchlockImageReference,
  type MatchlockImageSource,
} from "./standard-image.js";
import {
  MATCHLOCK_SWAP_UNSUPPORTED_CODE,
  probeMatchlockSwapSupport,
  type MatchlockSwapSupport,
  type MatchlockSwapSupportProbe,
} from "./swap-support.js";
import {
  resolveInteractiveHermesSelection,
  type InteractiveHermesAdapterSource,
  type InteractiveHermesSelection,
} from "./interactive-hermes-selection.js";
import type {
  InteractiveSessionArgs,
  InteractiveSessionHarness,
  InteractiveSessionSubcommand,
} from "../../cli/matchlock-interactive-args.js";

/** Typed refusal code: no terminal on stdin and/or stdout. */
export const INTERACTIVE_SESSION_TTY_REQUIRED_CODE = "matchlock_interactive_tty_required" as const;

/** Typed refusal code: the standard image is not provisioned locally (GAP-10). */
export const MATCHLOCK_STANDARD_IMAGE_MISSING_CODE = "matchlock_standard_image_missing" as const;

/** Typed refusal code: the explicit image is not provisioned (GAP-10). */
export const MATCHLOCK_EXPLICIT_IMAGE_MISSING_CODE = "matchlock_explicit_image_missing" as const;

/** Typed refusal code: the numeric caller identity cannot be captured. */
export const INTERACTIVE_IDENTITY_UNAVAILABLE_CODE = "interactive_session_identity_unavailable" as const;

/** Typed, actionable refusal for an interactive admission planning failure. */
export class InteractiveSessionPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InteractiveSessionPlanError";
    this.code = code;
  }
}

/** Captured caller identity (numeric ids; never inferred from `SUDO_UID`). */
export interface InteractiveSessionIdentity {
  uid: number;
  gid: number;
  homeDir: string;
  cwd: string;
}

/** Captured configuration-selection inputs for the selected harness. */
export interface InteractiveSessionConfigSelection {
  /** pi configuration root captured at admission (pi harness only). */
  piConfigRoot?: string;
  /** pi configuration profile captured at admission (pi harness only). */
  piConfigProfile?: string;
  /** Frozen `HERMES_HOME` snapshot (null when unset; hermes harness only). */
  hermesHomeEnv?: string | null;
}

/** Injectable admission seam (defaults to the shipped `admitMatchlockRun`). */
export type AdmitInteractiveSession = (
  opts: MatchlockAdmissionOptions,
) => Promise<MatchlockAdmissionResult>;

/** Injectable inputs for deterministic tests; production callers omit these. */
export interface PlanInteractiveSessionOptions {
  /** Environment snapshot used for the shared image/allow-private/binary resolution. */
  env?: NodeJS.ProcessEnv;
  /** Injected effective uid for the root gate (tests); defaults to `process.geteuid`. */
  euid?: number;
  /** Injected numeric uid (tests); defaults to `process.getuid`. */
  uid?: number;
  /** Injected numeric gid (tests); defaults to `process.getgid`. */
  gid?: number;
  /** Injected HOME (tests); defaults to `$HOME`, then `os.homedir()`. */
  homeDir?: string;
  /** Injected stdin TTY probe (tests); defaults to `process.stdin.isTTY === true`. */
  stdinIsTty?: boolean;
  /** Injected stdout TTY probe (tests); defaults to `process.stdout.isTTY === true`. */
  stdoutIsTty?: boolean;
  /** Frozen `HERMES_HOME` snapshot (tests); defaults to the trimmed env value. */
  hermesHomeEnv?: string | null;
  /** Injected Hermes adapter plan (tests); defaults to `resolveHermesAdapterPlan`. */
  hermesAdapterPlan?: InteractiveHermesAdapterSource;
  /** Injected directory probe for the Hermes config root (tests). */
  hermesIsDirectory?: (p: string) => boolean;
  /** Injected image resolver (tests); defaults to `resolveMatchlockImageReference`. */
  resolveImage?: typeof resolveMatchlockImageReference;
  /** Injected swap-capability probe (tests); defaults to `probeMatchlockSwapSupport`. */
  swapSupportProbe?: MatchlockSwapSupportProbe;
  /** Injected allow-private support probe forwarded to admission (tests). */
  allowPrivateSupportProbe?: MatchlockAllowPrivateSupportProbe;
  /** Injected admission seam (tests); defaults to `admitMatchlockRun`. */
  admit?: AdmitInteractiveSession;
  /** Override the matchlock rpc binary (tests inject a fake driver). */
  rpcBinaryPath?: string;
  /** Override the matchlock rpc args (tests pass [driverPath]). */
  rpcArgs?: string[];
  /** Finite request deadline for the owned resolve transport (ms). */
  rpcRequestTimeoutMs?: number;
  /** Admission context (tests pin home/live-state deterministically). */
  admission?: MountAdmissionContext;
  /** Git binary for repository-scope resolution (tests). */
  gitBinary?: string;
}

/** The admitted interactive session plan (consumed by create-config/controller). */
export interface InteractiveSessionPlan {
  subcommand: InteractiveSessionSubcommand;
  harness: InteractiveSessionHarness;
  /** True for the `*-shell` variants. */
  shell: boolean;
  /** Effective image reference (bare; never `:latest`). */
  image: string;
  /** Provenance of {@link image}: "explicit" or "standard". */
  imageSource: MatchlockImageSource;
  /** Absolute working directory mounted at its identical guest path. */
  workingDirectory: string;
  /** Captured caller identity. */
  identity: InteractiveSessionIdentity;
  /** Captured configuration-selection inputs. */
  configSelection: InteractiveSessionConfigSelection;
  /**
   * Resolved/validated effective Hermes selection (hermes harness only): the
   * profile, the whole effective config directory mounted RW and the approved
   * guest `HERMES_HOME` mapping. Absent for pi.
   */
  hermesSelection?: InteractiveHermesSelection;
  /** Resolved allow-private list (empty when none). */
  allowPrivate: string[];
  /** Resolved VM resource limits (parser output). */
  resourceLimits: ExecutionIsolationResourceLimits;
  /** True when the exact root-usage override flag was supplied here. */
  rootUsageOverride: boolean;
  /** Shared root warning text when root execution was authorized. */
  rootUsageWarning?: string;
  /** The admitted version-3 policy. */
  policy: ExecutionIsolation;
  /** The pinned immutable image identity (also embedded in the policy). */
  pinnedIdentity: PinnedImageIdentity;
}

/**
 * Admission error codes that mean the image could not be resolved/provisioned.
 * Only these are re-classified into the provenance-aware missing-image refusal;
 * every other admission error (root/allow-private/config/mount/transport)
 * propagates unchanged.
 */
const IMAGE_ADMISSION_FAILURE_CODES = new Set([
  "image_unusable",
  "image_identity_required",
  "image_identity_mismatch",
]);

/**
 * Build the provenance-aware missing-image refusal (GAP-10): a standard image
 * names `tamandua matchlock setup`; an explicit image requires operator
 * provisioning. Neither path ever pulls, builds or installs.
 */
function missingImageError(
  imageSource: MatchlockImageSource,
  image: string,
  detail: string,
): InteractiveSessionPlanError {
  const suffix =
    "Tamandua never pulls, builds or installs an image during launch and never falls back to host execution.";
  if (imageSource === "standard") {
    return new InteractiveSessionPlanError(
      MATCHLOCK_STANDARD_IMAGE_MISSING_CODE,
      `The standard Matchlock image "${image}" is not provisioned locally: ${detail}. ` +
        `Provision it with \`tamandua matchlock setup\`. ${suffix}`,
    );
  }
  return new InteractiveSessionPlanError(
    MATCHLOCK_EXPLICIT_IMAGE_MISSING_CODE,
    `The explicitly requested Matchlock image "${image}" is not provisioned locally: ${detail}. ` +
      `Operator provisioning is required (provision/import the named image, or verify the reference with \`tamandua matchlock setup\`). ${suffix}`,
  );
}

/** Re-classify an image-admission failure; every other error propagates. */
function rethrowImageAdmissionFailure(
  err: unknown,
  imageSource: MatchlockImageSource,
  image: string,
): never {
  if (err instanceof MatchlockAdmissionError && IMAGE_ADMISSION_FAILURE_CODES.has(err.code)) {
    throw missingImageError(imageSource, image, err.message);
  }
  throw err;
}

/** Capture the numeric caller identity; refuse rather than assume. */
function captureIdentity(
  args: InteractiveSessionArgs,
  options: PlanInteractiveSessionOptions,
  env: NodeJS.ProcessEnv,
): InteractiveSessionIdentity {
  const uid =
    options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const gid =
    options.gid ?? (typeof process.getgid === "function" ? process.getgid() : undefined);
  if (typeof uid !== "number" || typeof gid !== "number") {
    throw new InteractiveSessionPlanError(
      INTERACTIVE_IDENTITY_UNAVAILABLE_CODE,
      "Refusing an interactive Matchlock session: the invoking process cannot report numeric uid/gid, " +
        "and the guest must be entered as the caller's numeric identity. Never inferred from SUDO_UID.",
    );
  }
  const homeRaw = options.homeDir ?? env.HOME ?? os.homedir();
  const homeDir = typeof homeRaw === "string" ? homeRaw.trim() : "";
  if (homeDir === "") {
    throw new InteractiveSessionPlanError(
      INTERACTIVE_IDENTITY_UNAVAILABLE_CODE,
      "Refusing an interactive Matchlock session: the caller's HOME could not be captured " +
        "(a writable guest-local HOME is prepared from it).",
    );
  }
  return { uid, gid, homeDir, cwd: args.workingDirectory };
}

/** Resolve the frozen `HERMES_HOME` snapshot (empty/whitespace means unset). */
function captureHermesHomeEnv(
  options: PlanInteractiveSessionOptions,
  env: NodeJS.ProcessEnv,
): string | null {
  if (options.hermesHomeEnv !== undefined) {
    const explicit = options.hermesHomeEnv;
    return explicit === null || explicit.trim() === "" ? null : explicit.trim();
  }
  const raw = env.HERMES_HOME;
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Plan (admit) one interactive Matchlock session. Pure planning: no VM is
 * created and no host execution occurs. The caller persists `plan.policy`
 * before the session controller creates the VM.
 */
export async function planInteractiveSession(
  args: InteractiveSessionArgs,
  options: PlanInteractiveSessionOptions = {},
): Promise<InteractiveSessionPlan> {
  const env = options.env ?? process.env;

  // 1. Capture identity/config BEFORE anything could mutate the process env.
  const identity = captureIdentity(args, options, env);
  const hermesHomeEnv =
    args.harness === "hermes" ? captureHermesHomeEnv(options, env) : null;
  const configSelection: InteractiveSessionConfigSelection =
    args.harness === "hermes"
      ? { hermesHomeEnv }
      : {
          piConfigRoot: resolvePiConfigRoot(),
          piConfigProfile: resolvePiConfigProfile(),
        };

  // 2. R13 root gate FIRST — before any probe, resolve or RPC.
  const rootUsageWarning = assertMatchlockRootUsageAllowed({
    euid: options.euid,
    rootUsageOverride: args.rootUsageOverride,
  });

  // 3. Require a terminal on stdin AND stdout before any admission/RPC.
  const stdinIsTty = options.stdinIsTty ?? process.stdin.isTTY === true;
  const stdoutIsTty = options.stdoutIsTty ?? process.stdout.isTTY === true;
  if (!stdinIsTty || !stdoutIsTty) {
    const missing = [!stdinIsTty ? "stdin" : null, !stdoutIsTty ? "stdout" : null]
      .filter((x): x is string => x !== null)
      .join(" and ");
    throw new InteractiveSessionPlanError(
      INTERACTIVE_SESSION_TTY_REQUIRED_CODE,
      `Refusing to start an interactive Matchlock session without a terminal on ${missing}. ` +
        "Interactive sessions require terminal stdin and stdout, and there is no host-execution fallback; " +
        "run `tamandua matchlock <harness>` from an interactive terminal.",
    );
  }

  // 4. Resolve the effective Hermes selection from the FROZEN submission
  //    inputs through the shipped adapter. A refused profile, a non-local
  //    terminal backend, a missing/non-directory config source or a required
  //    external dependency refuses here, before the image RPC and before any
  //    admission; the hermes branch of admitMatchlockRun then re-resolves the
  //    same frozen inputs when it builds the policy.
  let hermesSelection: InteractiveHermesSelection | undefined;
  if (args.harness === "hermes") {
    hermesSelection = resolveInteractiveHermesSelection(
      { homeDir: identity.homeDir, cwd: identity.cwd, hermesHomeEnv },
      {
        ...(options.hermesAdapterPlan ? { adapterPlan: options.hermesAdapterPlan } : {}),
        ...(options.hermesIsDirectory ? { isDirectory: options.hermesIsDirectory } : {}),
      },
    );
  }

  // 5. Resolve the image through the shared precedence.
  const resolveImage = options.resolveImage ?? resolveMatchlockImageReference;
  const resolvedImage = resolveImage({
    requested: true,
    explicitImage: args.imageSource === "explicit" ? args.image : undefined,
    env,
  });
  if (!resolvedImage || resolvedImage.image.trim() === "") {
    throw missingImageError(
      args.imageSource,
      args.image,
      "the shared resolver produced no usable reference",
    );
  }
  const image = resolvedImage.image;
  const imageSource = resolvedImage.source;

  // 6. R8 swap-capability handshake against the binary admission will use —
  //    for EVERY interactive invocation, including swap-disabled ones.
  const rpcBinaryPath = options.rpcBinaryPath?.trim() || resolveMatchlockRpcBinaryPath(env);
  const swapProbe =
    options.swapSupportProbe ??
    ((bin: string) => probeMatchlockSwapSupport({ binaryPath: bin }));
  let swapSupport: MatchlockSwapSupport;
  try {
    swapSupport = await swapProbe(rpcBinaryPath);
  } catch (err) {
    throw new InteractiveSessionPlanError(
      MATCHLOCK_SWAP_UNSUPPORTED_CODE,
      `Refusing the interactive Matchlock session: could not confirm swap capability of the matchlock binary at ${rpcBinaryPath} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "The swap capability is required for every interactive session (even swap-disabled ones); " +
        "provision the qualified build with `tamandua matchlock setup`.",
    );
  }
  if (!swapSupport.supported) {
    const detail = swapSupport.reason ? ` Reason: ${swapSupport.reason}.` : "";
    throw new InteractiveSessionPlanError(
      MATCHLOCK_SWAP_UNSUPPORTED_CODE,
      `Refusing the interactive Matchlock session: the matchlock binary at ${rpcBinaryPath} does not support the swap capability.${detail} ` +
        "The swap capability is required for every interactive session (even swap-disabled ones); " +
        "provision the qualified build with `tamandua matchlock setup`.",
    );
  }

  // 7. Admit through the shipped v3 admission (direct workspace mode, no VM).
  const admit = options.admit ?? admitMatchlockRun;
  const resourceLimits: ExecutionIsolationResourceLimits = {
    cpus: args.resourceLimits.cpus,
    memoryMB: args.resourceLimits.memoryMB,
    diskSizeMB: args.resourceLimits.diskSizeMB,
    swapMB: args.resourceLimits.swapMB,
  };
  const admissionOptions: MatchlockAdmissionOptions = {
    requestedImage: image,
    imageSource,
    rootUsageConsent: args.rootUsageOverride,
    harness: args.harness,
    ...(args.harness === "hermes"
      ? {
          submission: {
            homeDir: identity.homeDir,
            cwd: identity.cwd,
            hermesHomeEnv,
          },
        }
      : {}),
    workspaceMode: "direct",
    workingDirectory: args.workingDirectory,
    resourceLimits,
    allowPrivate: args.allowPrivate,
    ...(options.allowPrivateSupportProbe
      ? { allowPrivateSupportProbe: options.allowPrivateSupportProbe }
      : {}),
    // MTLK integration union: main's shipped admission re-runs the swap
    // handshake for the v3 policy. Forward the injected probe so the
    // interactive plan and the admission it delegates to agree on capability
    // (and tests inject a supporting/refusing probe exactly once per boundary).
    ...(options.swapSupportProbe
      ? { swapSupportProbe: options.swapSupportProbe }
      : {}),
    rpcBinaryPath,
    ...(options.rpcArgs ? { rpcArgs: options.rpcArgs } : {}),
    ...(options.rpcRequestTimeoutMs !== undefined
      ? { rpcRequestTimeoutMs: options.rpcRequestTimeoutMs }
      : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    ...(options.gitBinary ? { gitBinary: options.gitBinary } : {}),
  };

  let admitted: MatchlockAdmissionResult;
  try {
    admitted = await admit(admissionOptions);
  } catch (err) {
    rethrowImageAdmissionFailure(err, imageSource, image);
  }

  return {
    subcommand: args.subcommand,
    harness: args.harness,
    shell: args.shell,
    image,
    imageSource,
    workingDirectory: args.workingDirectory,
    identity,
    configSelection,
    ...(hermesSelection !== undefined ? { hermesSelection } : {}),
    allowPrivate: [...args.allowPrivate],
    resourceLimits,
    rootUsageOverride: args.rootUsageOverride,
    ...(rootUsageWarning !== undefined ? { rootUsageWarning } : {}),
    policy: admitted.policy,
    pinnedIdentity: admitted.identity,
  };
}
