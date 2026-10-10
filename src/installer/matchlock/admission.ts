/**
 * admission.ts — MTLK-ADMIT: production run-creation admission.
 *
 * This is the ONE production caller that persists a pinned Matchlock
 * execution-isolation policy before a run can be scheduled. For an opted-in
 * run it:
 *
 *  1. captures the selected pi configuration root/profile and the exact work /
 *     original-repository / Git-metadata scope AT SUBMISSION (never re-derived
 *     from daemon env/HOME later);
 *  2. validates source directories, canonical bindings and exact guest paths
 *     against the existing mount rules (mount-plan.ts predicates + the runtime
 *     symlink-source rule) — the ENTIRE selected host configuration root must
 *     exist and mount RW; only the host pi EXECUTABLE may be absent;
 *  3. resolves the immutable image content+config identity over a BOUNDED
 *     OWNED `matchlock rpc` transport (resolve_image only — NO create is ever
 *     issued here; the transport is disposed on every path), mirroring the
 *     controller's separate `resolveAndAdmitIdentity()` admission path;
 *  4. for replacement runs, verifies the freshly resolved identity against the
 *     INHERITED persisted pin (a moved/retagged image fails closed);
 *  5. persists the version-2 policy (with the pin) so registration/dispatch can
 *     never see runnable work before the pin is stored. When the resolved
 *     image declares an effective guest PATH (its OCI config env PATH), that
 *     non-secret PATH is preserved on the policy (`imagePath`) so dispatch
 *     never re-resolves and the runner prepends ONLY the helper-pack bin.
 *
 * Any resolve/admission/persistence failure surfaces as an honest refusal
 * (MatchlockAdmissionError with an actionable code); the caller fails the run
 * and NO native work is produced. There is no default image and no silent
 * re-pin. Only bounded non-secret pin/path/policy metadata is saved — never
 * credentials and never full image configuration beyond the effective PATH.
 *
 * This module does NOT create VMs, does NOT touch controller lifecycle, and
 * never falls back to a native host harness.
 */

import fs from "node:fs";
import path from "node:path";
import { MatchlockRpcClient, MATCHLOCK_CLIENT_ERROR_CODES } from "./rpc-client.js";
import { MatchlockImageError, resolveImageIdentityWithConfig, verifyImageIdentity, type PinnedImageIdentity } from "./image.js";
import {
  buildMatchlockPolicy,
  DEFAULT_DSH_CONFIGURATION_PROFILE,
  DEFAULT_DSH_CONFIGURATION_ROOT,
  DEFAULT_GUEST_CONFIGURATION_ROOT,
  resolveDshPolicyHome,
  resolvePiConfigProfile,
  resolvePiConfigRoot,
  type ExecutionIsolation,
  type ExecutionIsolationResourceLimits,
  type ExecutionIsolationWorkMount,
} from "./policy.js";
import { MATCHLOCK_DEFAULT_SWAP_MB, resolveMatchlockResourceLimits } from "./resource-limits.js";
import {
  resolveMatchlockDnsPriority,
  resolveMatchlockPrivileged,
  type ResolvedMatchlockDnsPriority,
  type ResolvedMatchlockPrivileged,
} from "./isolation-settings.js";
import {
  MATCHLOCK_ALLOW_PRIVATE_ENV,
  MATCHLOCK_ALLOW_PRIVATE_GRAMMAR,
  normalizeAllowPrivateEntries,
  validateAllowPrivateEntry,
} from "./allow-private.js";
import {
  MATCHLOCK_ALLOW_PRIVATE_FLAG,
  probeMatchlockAllowPrivateSupport,
  type MatchlockAllowPrivateSupport,
} from "./allow-private-support.js";
import {
  MATCHLOCK_SWAP_FLAG,
  probeMatchlockSwapSupport,
  resolveMatchlockSwapBinaryPath,
  type MatchlockSwapSupport,
  type MatchlockSwapSupportProbe,
} from "./swap-support.js";
import type { DshSubmissionContext } from "./dsh-adapter-contract.js";
import type { MatchlockImageSource } from "./standard-image.js";
import {
  canonicalRealPath,
  isWithinPath,
  resolveRepositoryScope,
} from "./repository-scope.js";
import {
  isBroadHostSource,
  shadowsProtectedGuestRoot,
  type MountAdmissionContext,
} from "./mount-plan.js";
import { resolveHermesAdapterPlan } from "./hermes-adapter.js";

/**
 * The FROZEN Hermes submission inputs captured at run creation (homeDir + the
 * HERMES_HOME env snapshot + cwd). The Hermes adapter plan is resolved from
 * ONLY these — never daemon HOME or later ambient state. `hermesHomeEnv` is
 * null when HERMES_HOME was unset at submission (the adapter then defaults to
 * ~/.hermes under `homeDir`).
 */
export interface HermesAdmissionSubmission {
  homeDir: string;
  cwd: string;
  hermesHomeEnv: string | null;
}

/** Build the adapter's frozen input shape from the captured submission. */
export function toFrozenHermesSubmission(
  submission: HermesAdmissionSubmission,
): { homeDir: string; cwd: string; env: Record<string, string | undefined> } {
  return {
    homeDir: submission.homeDir,
    cwd: submission.cwd,
    env:
      submission.hermesHomeEnv !== null && submission.hermesHomeEnv !== undefined
        ? { HERMES_HOME: submission.hermesHomeEnv }
        : {},
  };
}

export class MatchlockAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockAdmissionError";
    this.code = code;
  }
}

/**
 * R13: the deliberately long root-usage override flag. Kept in lockstep with
 * the parser spelling (`src/cli/workflow-run-args.ts`) so the refusal text
 * always names a flag that actually exists.
 */
export const MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG =
  "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs";

/**
 * The spec C §2.6 root-usage refusal text. Matchlock is documented to run
 * unprivileged; a root process is refused by default before ANY matchlock
 * interaction (no probe, no image resolve, no VM), and the override is the one
 * escape hatch. A refusal never falls back to the native host harness.
 */
export function matchlockRootUsageRefusalText(): string {
  return [
    "Cannot start run: refusing to execute a Matchlock run as root.",
    "Matchlock is documented to run unprivileged — sudo is for its one-time host preparation only, never for running matchlock itself — and `tamandua matchlock setup` exists precisely so matchlock never needs root later.",
    "If you insist, re-run with:",
    `  ${MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG}`,
    "The run was marked failed and nothing ran natively.",
  ].join("\n");
}

/**
 * Default effective-uid probe. `process.geteuid` is POSIX-only; when it is
 * unavailable a non-root sentinel is returned so a platform without it never
 * trips the root gate. The gate keys on the EFFECTIVE uid (broader than sudo:
 * a root login is refused identically), never on the guest workload's uid.
 */
function defaultEffectiveUid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : -1;
}

/**
 * R13 root gate. Runs FIRST (before the capability probes, the image resolve
 * and any policy construction) through the injectable `effectiveUid` seam.
 *
 * Consent is EITHER the override supplied to THIS action (`rootUsageConsent`)
 * OR valid inherited consent on a replacement's persisted policy. `euid 0`
 * with neither is a typed `matchlock_root_usage_refused` whose text is the
 * spec C §2.6 refusal; it writes no policy, resolves no image and spawns no
 * matchlock process. `euid 0` with consent proceeds (the persisted policy
 * then records the consent per the §4.5 writer rule).
 */
function assertMatchlockRootUsagePermitted(
  opts: MatchlockAdmissionOptions,
  inherited: ExecutionIsolation | undefined,
): void {
  const effectiveUid = opts.effectiveUid ?? defaultEffectiveUid;
  if (effectiveUid() !== 0) return;
  const consented = inherited?.rootUsageConsent === true || opts.rootUsageConsent === true;
  if (consented) return;
  throw new MatchlockAdmissionError(
    "matchlock_root_usage_refused",
    matchlockRootUsageRefusalText(),
  );
}

/**
 * Provenance-aware `image_unusable` refusal text (spec C §2.3). A standard
 * provenance store miss names the `tamandua matchlock setup` remedy; an
 * explicit image keeps the import-and-retry guidance. Neither path ever
 * fetches or builds an image.
 */
function imageUnusableRefusalMessage(
  tag: string,
  source: MatchlockImageSource,
  detail: string,
): string {
  if (source === "standard") {
    return (
      `Cannot start run: the standard Matchlock image ${tag} is not in the local matchlock store. ` +
      "Provision this host with: tamandua matchlock setup " +
      "(or pass an explicit already-imported image with --matchlock-image <image>). " +
      "The run was marked failed and nothing ran natively."
    );
  }
  return (
    `Cannot start run: Matchlock image ${tag} is not usable: image_unusable (${detail}). ` +
    `Import it into the local matchlock store (matchlock pull ${tag}) and retry. ` +
    "The run was marked failed and nothing ran natively."
  );
}

/**
 * The effective provenance of the image being admitted: an inherited policy's
 * persisted value ALWAYS wins for a replacement (never recomputed from the
 * current environment); a fresh admission uses the caller's real provenance
 * (absent defaults to "explicit").
 */
function effectiveRequestedImageSource(opts: MatchlockAdmissionOptions): MatchlockImageSource {
  return opts.inheritedPolicy?.requestedImageSource ?? opts.imageSource ?? "explicit";
}

/**
 * Environment override for the matchlock rpc CLI binary (tests inject a fake
 * driver; production uses `matchlock` from PATH). Only ever consulted when an
 * opt-in admission actually runs — no-flag runs never read it.
 */
export const MATCHLOCK_RPC_BIN_ENV = "TAMANDUA_MATCHLOCK_RPC_BIN";
/** Environment override for the matchlock rpc CLI args (JSON string array). */
export const MATCHLOCK_RPC_ARGS_ENV = "TAMANDUA_MATCHLOCK_RPC_ARGS";

/**
 * MTLK-ALLOW-PRIVATE US-008: injectable probe for the installed matchlock's
 * allow-private support. It receives the binary path resolved from
 * {@link resolveRpcInvocation} and returns the US-007 probe result. Production
 * uses {@link probeMatchlockAllowPrivateSupport}; tests inject a
 * supporting/refusing fake so they never need a real matchlock binary.
 */
export type MatchlockAllowPrivateSupportProbe = (
  binaryPath: string,
) => MatchlockAllowPrivateSupport | Promise<MatchlockAllowPrivateSupport>;

export interface MatchlockAdmissionOptions {
  /** Operator-supplied mandatory image (a replacement inherits its tag). */
  requestedImage: string;
  /**
   * SHARED-V3 (MTLK-ISO-SLICE1): the REAL provenance of `requestedImage` for a
   * FRESH admission — "explicit" (`--matchlock-image [=]<image>`) or "standard"
   * (bare `--matchlock`, resolving to the built-in standard image or
   * TAMANDUA_MATCHLOCK_IMAGE). Persisted as the policy's `requestedImageSource`
   * so the v3 record is truthful instead of a placeholder. An inherited policy's
   * value ALWAYS wins for a replacement (preserved VERBATIM, never recomputed
   * from the current environment); absent on a fresh write defaults to
   * "explicit".
   */
  imageSource?: MatchlockImageSource;
  /**
   * SHARED-V3 (MTLK-ISO-SLICE1): true ONLY when the operator explicitly supplied
   * `--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs` to THIS
   * action. Persisted as the policy's `rootUsageConsent` (R13 root usage
   * consent). An inherited policy's value ALWAYS wins for a replacement
   * (preserved VERBATIM); absent/false on a fresh write records `false`.
   */
  rootUsageConsent?: boolean;
  /**
   * R13: injectable effective-uid seam for the root gate. Production omits
   * this (the real `process.geteuid()` is consulted); tests inject a
   * deterministic value so the uid-0 branch is exercised without running as
   * root. The gate concerns the HOST submitting process identity only.
   */
  effectiveUid?: () => number;
  /**
   * Selected Matchlock harness: "pi" (default), "hermes" or "dsh". A hermes
   * opt-in REQUIRES a Hermes `submission` (frozen inputs) unless an inherited
   * hermes policy already carries them; a dsh opt-in REQUIRES the frozen dsh
   * submission context unless inherited.
   */
  harness?: "pi" | "hermes" | "dsh";
  /**
   * FROZEN submission inputs captured at run creation for a FRESH opt-in:
   * Hermes submission (homeDir + HERMES_HOME env snapshot + cwd) for harness
   * "hermes", or the dsh submission context (HOME/DSH_HOME/cwd) for harness
   * "dsh". Ignored/absent for harness "pi"; replacement runs inherit their
   * frozen inputs from the inherited policy instead.
   */
  submission?: HermesAdmissionSubmission | DshSubmissionContext;
  workspaceMode: "direct" | "worktree";
  /** Absolute launch cwd (same spelling on host and guest). */
  workingDirectory: string;
  /** Absolute origin-repository spelling (worktree mode only). */
  worktreeOriginRepository?: string;
  /**
   * Inherited policy of the FAILED run being replaced (rugpull) — the
   * configuration root/profile, guest destination, resource limits, original
   * repository authority and immutable identity pin are retained; only a new
   * host-created worktree's path/metadata may be re-derived. When present the
   * freshly resolved identity MUST match the inherited pin.
   */
  inheritedPolicy?: ExecutionIsolation;
  /**
   * MTLK-VM-SIZE US-003: caller-resolved VM resource limits for a FRESH
   * admission (the CLI validates/clamps flag/env values and passes the
   * result). An inherited policy's limits ALWAYS win over this value — a
   * rugpull replacement retains the failed run's admitted VM size — and when
   * neither is present the host-derived built-in defaults are used.
   */
  resourceLimits?: ExecutionIsolationResourceLimits;
  /**
   * MTLK-ALLOW-PRIVATE: the operator-resolved allow-private destination list
   * for a FRESH Matchlock opt-in (flag > env, already shape-validated by the
   * CLI). Admission normalizes/validates it and persists it as
   * `networkAllowPrivate` on the run policy, so every round/retry/resume of
   * the run dispatches the SAME list. Ignored when `inheritedPolicy` is
   * present — a rugpull replacement retains the inherited policy's list (the
   * persisted policy, never the daemon environment, is authoritative). Absent
   * or empty keeps the pre-change policy byte-identical.
   */
  allowPrivate?: readonly string[];
  /**
   * ICEBOX Pillar B (privileged-by-default): the SUBMISSION-resolved
   * whole-VM privilege setting + source (opt-out flag >
   * TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 > default ON), resolved by the
   * composing surface (the CLI parser / run creation) and threaded here for
   * a FRESH admission. When absent, admission resolves the bare built-in
   * default itself (`privileged: true`, source `"default"`) — admission
   * NEVER reads the ambient environment for this setting. Ignored when
   * `inheritedPolicy` is present: a replacement preserves the inherited
   * value VERBATIM (the persisted policy, never current flags/env, is
   * authoritative — same INHERITANCE RULE as resource limits and
   * allow-private).
   */
  matchlockPrivileged?: ResolvedMatchlockPrivileged;
  /**
   * ICEBOX DNS (NIXV6-DNS-REWRITER): the SUBMISSION-resolved address-family
   * preference + source (flag > env > default ipv4). Same contract as
   * {@link matchlockPrivileged}: fresh admissions get the supplied value or
   * the bare built-in default; replacements preserve the inherited value
   * verbatim.
   */
  matchlockDnsPriority?: ResolvedMatchlockDnsPriority;
  /**
   * MTLK-ALLOW-PRIVATE US-008: injectable allow-private support probe. When an
   * effective (inherited or supplied) allow-private list is non-empty, admission
   * probes the resolved rpc binary BEFORE the image resolve / any create effect
   * and refuses with `matchlock_allow_private_unsupported` when the installed
   * matchlock does not advertise `--allow-private`. Production omits this (the
   * default US-007 probe runs against the real binary); tests inject a
   * deterministic fake.
   */
  allowPrivateSupportProbe?: MatchlockAllowPrivateSupportProbe;
  /**
   * MTLK-ISO-SLICE2 US-003: injectable swap-capability support probe. Runs for
   * EVERY Matchlock admission (fresh opt-in, a `--matchlock-no-swap` run and an
   * inherited-policy replacement) BEFORE the image resolve / any policy
   * construction and AFTER the R13 root gate, even when the run disables swap
   * (0): the probe is the operator's proxy that the qualified runtime build is
   * the one in use. Production omits this (the default US-001 probe runs against
   * the binary resolved by {@link resolveRpcInvocation}); tests inject a
   * deterministic supporting/refusing fake so they never spawn a real binary.
   */
  swapSupportProbe?: MatchlockSwapSupportProbe;
  /** Override the matchlock rpc binary (tests inject a fake driver). */
  rpcBinaryPath?: string;
  /** Override the matchlock rpc args (tests pass [driverPath]). */
  rpcArgs?: string[];
  /**
   * MTLK-ISO2-MEND (admission resolve-once-and-bind): the ONE rpc invocation
   * this admission has already resolved. `admitMatchlockRun` resolves it once,
   * before any awaited capability probe, and threads it through the swap
   * handshake, the allow-private probe and the image resolve so the binary that
   * is PROBED is exactly the binary that is LAUNCHED (no re-resolution drift).
   * Callers normally omit it. Mirrors {@link MatchlockSwapHandshakeOptions}.
   */
  resolvedRpc?: ResolvedRpcInvocation;
  /** Finite request deadline for the owned resolve transport (ms). */
  rpcRequestTimeoutMs?: number;
  /** Admission context (tests pin home/live-state deterministically). */
  admission?: MountAdmissionContext;
  /** Git binary for repository-scope resolution (tests). */
  gitBinary?: string;
}

/**
 * MTLK-ISO2-MEND (admission resolve-once-and-bind): the immutable rpc
 * invocation resolved at the start of one admission/resume action. Admitting an
 * executable ONCE and binding it across every awaited probe + the launch closes
 * the drift window in which an environment change (PATH, TAMANDUA_MATCHLOCK_RPC_BIN
 * or TAMANDUA_MATCHLOCK_RPC_ARGS) between two awaits could qualify one binary
 * and launch a different one.
 */
export interface ResolvedRpcInvocation {
  /** The absolute binary path the RPC transport will launch. */
  binaryPath: string;
  /** The argv tail handed to that binary (defaults to ["rpc"]). */
  args: string[];
}

export interface MatchlockAdmissionResult {
  /** The persisted version-2 policy carrying the immutable identity pin. */
  policy: ExecutionIsolation;
  /** The pinned content+config identity (also embedded in the policy). */
  identity: PinnedImageIdentity;
}

function lstatIsSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Assert a single planned host source is mountable: not a broad host source,
 *  guest-safe at its (possibly distinct) guest destination, and (mirroring the
 *  runtime's validateNoSourceSymlink) not an EXISTING symlink source — an
 *  unsupported symlink layout is an explicit refusal. Work roots carry
 *  guestPath === hostPath; the configuration mount targets its fixed guest
 *  override instead. */
function assertMountableHostSource(
  hostPath: string,
  guestPath: string,
  ctx: MountAdmissionContext | undefined,
  what: string,
): void {
  if (isBroadHostSource(hostPath, ctx)) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `Refusing to mount broad host source for ${what}: ${hostPath}`,
    );
  }
  if (shadowsProtectedGuestRoot(guestPath)) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `Guest mount destination for ${what} shadows a protected guest OS root: ${guestPath} (host ${hostPath})`,
    );
  }
  if (lstatIsSymlink(hostPath)) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `${what} source ${hostPath} is a symlink; the runtime requires a real path source (unsupported layout). Name the resolved real path or refuse the run — never mount through the alias.`,
    );
  }
}

function assertConfigRootExists(configRoot: string, what: string): string {
  // The ENTIRE selected host configuration source must exist and mount RW.
  // Only the host/guest harness EXECUTABLE may be absent (the image supplies
  // it); a missing pi config root, hermes home or dsh HOME is the same hard
  // fail-closed refusal.
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(configRoot);
  } catch {
    st = undefined;
  }
  if (!st || !st.isDirectory()) {
    if (what === "hermes") {
      throw new MatchlockAdmissionError(
        "guest_configuration_incompatible",
        `Selected host Hermes configuration source is not an existing DIRECTORY: ${configRoot}. ` +
          "The ENTIRE selected Hermes configuration directory must be mounted read-write; refusing to substitute an image default. " +
          "Only the guest hermes EXECUTABLE may be absent — create/supply the Hermes configuration directory (or set HERMES_HOME) and retry.",
      );
    }
    throw new MatchlockAdmissionError(
      "guest_configuration_incompatible",
      `${what} is not an existing DIRECTORY: ${configRoot}. ` +
        "The ENTIRE selected configuration directory must be mounted read-write; refusing to substitute an image default. " +
        "Only the host pi EXECUTABLE may be absent — create/supply the configuration directory and retry.",
    );
  }
  // Canonicalize a symlinked config source (the config mount targets the
  // canonical real directory at the fixed guest override; work paths are the
  // ones that must keep their exact host spelling).
  const real = canonicalRealPath(configRoot);
  if (real !== configRoot) return real;
  return configRoot;
}

export interface PlannedPolicyScope {
  workingDirectory: string;
  originalRepositoryRoot: string | null;
  gitMetadataRoots: string[];
  workMounts: ExecutionIsolationWorkMount[];
}

function toWorkMount(hostPath: string): ExecutionIsolationWorkMount {
  return {
    hostPath,
    hostRealPath: canonicalRealPath(hostPath),
    guestPath: hostPath,
  };
}

/** Roots already covered by a planned mount of `coveredBy` (nested same-source
 *  mounts are redundant — the mount planner drops them, so they are not listed
 *  as separate policy roots). */
function externalRoots(roots: string[], coveredBy: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    if (coveredBy.some((c) => c && isWithinPath(root, c))) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/** Plan + validate the work scope for a FRESH (non-inherited) run. */
function planFreshScope(opts: MatchlockAdmissionOptions, ctx: MountAdmissionContext | undefined): PlannedPolicyScope {
  const wd = opts.workingDirectory;
  if (opts.workspaceMode === "worktree") {
    const scope = resolveRepositoryScope(wd, { gitBinary: opts.gitBinary });
    if (!scope.commonDir) {
      throw new MatchlockAdmissionError(
        "mount_policy_rejected",
        `Worktree working directory ${wd} does not resolve to a git worktree (no common dir); cannot admit the original repository for a Matchlock run.`,
      );
    }
    // Original repository authority: the MAIN checkout of this worktree (or
    // the bare repository path itself when the origin is bare).
    let originalRoot: string;
    if (scope.bare) {
      originalRoot = scope.commonDir!;
    } else if (scope.mainWorktree) {
      originalRoot = scope.mainWorktree;
    } else {
      throw new MatchlockAdmissionError(
        "mount_policy_rejected",
        `Could not resolve the original repository (main worktree) for ${wd}; unsupported layout, refusing admission.`,
      );
    }
    const covered = [wd, originalRoot];
    const gitRoots = externalRoots([scope.gitDir ?? "", scope.commonDir ?? ""], covered);
    for (const m of [wd, originalRoot, ...gitRoots]) assertMountableHostSource(m, m, ctx, "work/repository mount");
    return {
      workingDirectory: wd,
      originalRepositoryRoot: originalRoot,
      gitMetadataRoots: gitRoots,
      workMounts: [toWorkMount(wd)],
    };
  }

  // Direct mode: a NON-repository working directory mounts itself only.
  const scope = resolveRepositoryScope(wd, { gitBinary: opts.gitBinary });
  assertMountableHostSource(wd, wd, ctx, "working directory");
  if (!scope.topLevel) {
    return {
      workingDirectory: wd,
      originalRepositoryRoot: null,
      gitMetadataRoots: [],
      workMounts: [toWorkMount(wd)],
    };
  }
  // Direct cwd INSIDE a repository: admit the complete original repository
  // (main checkout for plain/worktree layouts; the checkout top level for a
  // separate-git-dir checkout) plus any external Git metadata.
  const originalRoot =
    scope.mainWorktree ??
    scope.topLevel;
  const covered = [wd, originalRoot];
  const gitRoots = externalRoots([scope.gitDir ?? "", scope.commonDir ?? ""], covered);
  // A linked-worktree top level different from the original root is mounted
  // too (the cwd's worktree is part of the working scope).
  const workMounts = [toWorkMount(wd)];
  if (scope.topLevel && scope.topLevel !== originalRoot && !isWithinPath(scope.topLevel, wd)) {
    workMounts.push(toWorkMount(scope.topLevel));
  }
  for (const m of [wd, originalRoot, ...gitRoots]) assertMountableHostSource(m, m, ctx, "work/repository mount");
  return {
    workingDirectory: wd,
    originalRepositoryRoot: originalRoot,
    gitMetadataRoots: gitRoots,
    workMounts,
  };
}

/** Re-plan a replacement scope: retain the inherited policy's authority and
 *  derive ONLY the new host-created worktree's exact path/metadata. */
function planReplacementScope(opts: MatchlockAdmissionOptions, inherited: ExecutionIsolation): PlannedPolicyScope {
  const wd = opts.workingDirectory;
  if (opts.workspaceMode === "direct") {
    // Same working directory as the failed run — retain its admitted scope
    // verbatim (authority preserved; re-derivation would re-read the daemon
    // environment as new authority, which is forbidden).
    const scope = resolveRepositoryScope(wd, { gitBinary: opts.gitBinary });
    if (inherited.originalRepositoryRoot) {
      assertMountableHostSource(inherited.originalRepositoryRoot, inherited.originalRepositoryRoot, opts.admission, "original repository");
    }
    if (scope.topLevel && !inherited.originalRepositoryRoot) {
      throw new MatchlockAdmissionError(
        "mount_policy_rejected",
        `Replacement direct working directory ${wd} is inside a git repository but the inherited policy has no original repository root; refusing to silently re-derive authority.`,
      );
    }
    return {
      workingDirectory: wd,
      originalRepositoryRoot: inherited.originalRepositoryRoot,
      gitMetadataRoots: [...inherited.gitMetadataRoots],
      workMounts: inherited.workMounts.map((m) => ({ ...m })),
    };
  }
  // Worktree mode: the replacement uses a NEW managed worktree; derive only
  // its exact path/metadata and confirm the original authority matches.
  const scope = resolveRepositoryScope(wd, { gitBinary: opts.gitBinary });
  if (!scope.commonDir) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `Replacement worktree working directory ${wd} does not resolve to a git worktree; refusing admission.`,
    );
  }
  let derivedRoot: string;
  if (scope.bare) {
    derivedRoot = scope.commonDir!;
  } else if (scope.mainWorktree) {
    derivedRoot = scope.mainWorktree;
  } else {
    derivedRoot = path.dirname(scope.commonDir);
  }
  if (!inherited.originalRepositoryRoot) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      "Inherited Matchlock policy for a worktree run has no original repository root; refusing to admit the replacement without repository authority.",
    );
  }
  const inheritedReal = canonicalRealPath(inherited.originalRepositoryRoot);
  const derivedReal = canonicalRealPath(derivedRoot);
  if (inheritedReal !== derivedReal) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `Replacement worktree resolves its original repository at ${derivedRoot} but the inherited policy pins ${inherited.originalRepositoryRoot}; refusing to re-authorize a different original repository.`,
    );
  }
  const covered = [wd, inherited.originalRepositoryRoot];
  const gitRoots = externalRoots([scope.gitDir ?? "", scope.commonDir ?? ""], covered);
  for (const m of [wd, inherited.originalRepositoryRoot, ...gitRoots]) {
    assertMountableHostSource(m, m, opts.admission, "work/repository mount");
  }
  return {
    workingDirectory: wd,
    originalRepositoryRoot: inherited.originalRepositoryRoot,
    gitMetadataRoots: gitRoots,
    workMounts: [toWorkMount(wd)],
  };
}

/**
 * Resolve the effective resource limits for one admission (MTLK-VM-SIZE
 * US-003). Precedence: an INHERITED policy (rugpull replacement retains the
 * failed run's admitted VM size) > caller-supplied limits (already
 * validated/clamped by the CLI resolver) > host-derived built-in defaults.
 */
function resolveAdmissionResourceLimits(
  inherited: ExecutionIsolation | undefined,
  supplied: ExecutionIsolationResourceLimits | undefined,
): ExecutionIsolationResourceLimits {
  // INHERITANCE RULE (SHARED-V3): an inherited-policy write preserves the
  // persisted limits VERBATIM — including swapMB (0 = off), which is NEVER
  // recomputed from the current environment/defaults. A valid v2 record was
  // already normalized to swapMB 0 at read time.
  if (inherited?.resourceLimits) return { ...inherited.resourceLimits };
  if (supplied) {
    // A fresh write with caller-supplied (CLI-resolved) limits: an explicit
    // 0 is preserved; only a caller that predates the swap field falls back
    // to the built-in default so the persisted v3 record is complete.
    return {
      cpus: supplied.cpus,
      memoryMB: supplied.memoryMB,
      diskSizeMB: supplied.diskSizeMB,
      swapMB: typeof supplied.swapMB === "number" ? supplied.swapMB : MATCHLOCK_DEFAULT_SWAP_MB,
    };
  }
  const resolved = resolveMatchlockResourceLimits();
  return {
    cpus: resolved.cpus,
    memoryMB: resolved.memoryMB,
    diskSizeMB: resolved.diskSizeMB,
    swapMB: resolved.swapMB,
  };
}

/**
 * Resolve the effective allow-private destination list for one admission
 * (MTLK-ALLOW-PRIVATE). Precedence: an INHERITED policy's persisted list
 * (a rugpull replacement retains the failed run's admitted exceptions) > the
 * operator-supplied list (a fresh opt-in) > absent. The effective list is
 * normalized (trim/blank-drop/dedupe, first-seen order) and every entry is
 * shape-validated; an invalid entry refuses the admission BEFORE any effect,
 * naming the offending entry and the grammar, rather than dropping it.
 * An absent/empty effective list yields `undefined` so the persisted policy
 * stays byte-identical to a pre-change admission.
 */
function resolveAdmissionAllowPrivate(
  inherited: ExecutionIsolation | undefined,
  supplied: readonly string[] | undefined,
): string[] | undefined {
  const source = inherited?.networkAllowPrivate ?? supplied;
  if (source === undefined) return undefined;
  const normalized = normalizeAllowPrivateEntries(source);
  if (normalized.length === 0) return undefined;
  for (const entry of normalized) {
    const result = validateAllowPrivateEntry(entry);
    if (!result.ok) {
      throw new MatchlockAdmissionError(
        "policy_invalid_record",
        `Matchlock admission allow-private ${result.reason}. Entries are ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}.`,
      );
    }
  }
  return normalized;
}

/**
 * ICEBOX: resolve the effective isolation settings (privileged-by-default +
 * DNS preference) for one admission.
 *
 * INHERITANCE RULE (identical to resource limits / allow-private): an
 * inherited policy's persisted settings win VERBATIM — a replacement/rugpull
 * never re-derives privilege or the DNS preference from current flags or the
 * daemon environment. A pre-ICEBOX inherited record carries NEITHER field:
 * the replacement WRITE materializes the standing ICEBOX defaults this
 * binary actually selects (`privileged: true`, source `"default"`; priority
 * `"ipv4"`, source `"default"`) so the new record is self-describing and a
 * future composer-default change can never silently alter the replacement's
 * behavior. (Read paths never rewrite stored JSON — only this fresh WRITE
 * gains the fields.)
 *
 * A FRESH admission uses the caller-supplied resolved value; a caller that
 * threads nothing (a pre-ICEBOX caller shape) gets the bare built-in
 * defaults resolved HERE — never from the ambient environment.
 */
function resolveAdmissionIsolationSettings(
  inherited: ExecutionIsolation | undefined,
  supplied: {
    privileged?: ResolvedMatchlockPrivileged;
    dnsPriority?: ResolvedMatchlockDnsPriority;
  },
): {
  matchlockPrivileged: ResolvedMatchlockPrivileged;
  matchlockDnsPriority: ResolvedMatchlockDnsPriority;
} {
  if (inherited) {
    return {
      // Persisted values are preserved VERBATIM (cloned so the new record
      // never aliases the inherited object); a pre-ICEBOX record gains the
      // standing defaults this binary actually selects.
      matchlockPrivileged:
        inherited.matchlockPrivileged !== undefined
          ? { ...inherited.matchlockPrivileged }
          : resolveMatchlockPrivileged({}),
      matchlockDnsPriority:
        inherited.matchlockDnsPriority !== undefined
          ? { ...inherited.matchlockDnsPriority }
          : resolveMatchlockDnsPriority({}),
    };
  }
  return {
    matchlockPrivileged:
      supplied.privileged !== undefined
        ? { ...supplied.privileged }
        : resolveMatchlockPrivileged({}),
    matchlockDnsPriority:
      supplied.dnsPriority !== undefined
        ? { ...supplied.dnsPriority }
        : resolveMatchlockDnsPriority({}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * MTLK-ALLOW-PRIVATE US-008: refuse an allow-private run when the installed
 * matchlock cannot honour the list. The US-007 probe runs against the rpc binary
 * resolved by {@link resolveRpcInvocation} BEFORE the image resolve / any create
 * effect; an unsupported (older) build, a missing binary or a probe that cannot
 * run is a fail-closed `matchlock_allow_private_unsupported` refusal naming the
 * binary and every requested entry. The list is NEVER silently dropped and no
 * policy is written (the refusal precedes `buildMatchlockPolicy`). The probe is
 * injectable so tests never need a real matchlock binary.
 */
async function assertMatchlockAllowPrivateSupport(
  opts: MatchlockAdmissionOptions,
  allowPrivate: readonly string[],
): Promise<void> {
  const { binaryPath } = resolveRpcInvocation(opts);
  const probe =
    opts.allowPrivateSupportProbe ??
    ((bin: string) => probeMatchlockAllowPrivateSupport({ binaryPath: bin }));

  let support: MatchlockAllowPrivateSupport;
  try {
    support = await probe(binaryPath);
  } catch (err) {
    throw new MatchlockAdmissionError(
      "matchlock_allow_private_unsupported",
      `Refusing allow-private run: could not verify that the matchlock binary at ${binaryPath} supports ${MATCHLOCK_ALLOW_PRIVATE_FLAG} (${errorMessage(err)}). ` +
        `The requested private destinations (${allowPrivate.join(", ")}) are never silently dropped; ` +
        `upgrade matchlock to a build that lists ${MATCHLOCK_ALLOW_PRIVATE_FLAG} (verify with \`matchlock run --help\`) ` +
        `or drop --matchlock-allow-private / ${MATCHLOCK_ALLOW_PRIVATE_ENV} for this run.`,
    );
  }
  if (support.supported) return;

  // MTLK-ISO2-CORRECTIVE (F6): a missing binary keeps the uniform
  // `matchlock_unavailable` taxonomy regardless of the allow-private list.
  if (support.reasonCode === "missing_binary") {
    throw new MatchlockAdmissionError(
      "matchlock_unavailable",
      `Matchlock rpc CLI is unavailable while admitting "${opts.requestedImage}": ${support.reason ?? `binary not found: ${binaryPath}`}. ` +
        "Refusing to start the run without the qualified Matchlock runtime; no host fallback occurred.",
    );
  }

  const detail = support.reason ? ` Reason: ${support.reason}.` : "";
  throw new MatchlockAdmissionError(
    "matchlock_allow_private_unsupported",
    `Refusing allow-private run: the matchlock binary at ${binaryPath} does not support ${MATCHLOCK_ALLOW_PRIVATE_FLAG}.${detail} ` +
      `The requested private destinations (${allowPrivate.join(", ")}) cannot be honoured and are never silently dropped; ` +
      `upgrade matchlock to a build that lists ${MATCHLOCK_ALLOW_PRIVATE_FLAG} (verify with \`matchlock run --help\`) ` +
      `or drop --matchlock-allow-private / ${MATCHLOCK_ALLOW_PRIVATE_ENV} for this run.`,
  );
}

/**
 * MTLK-ISO-SLICE2 US-010: the inputs {@link assertMatchlockSwapSupport} needs.
 * It is a structural subset of {@link MatchlockAdmissionOptions} so the
 * failed-run resume path (which does not run fresh admission) can re-run the
 * exact same handshake against the persisted policy's image / the resolved
 * binary.
 */
export interface MatchlockSwapHandshakeOptions {
  /** Image named in a refusal; the persisted policy's reference on resume. */
  requestedImage?: string;
  /** Injectable probe (tests); production omits it. */
  swapSupportProbe?: MatchlockSwapSupportProbe;
  /** Override the matchlock rpc binary (tests inject a fake driver). */
  rpcBinaryPath?: string;
  /** Override the matchlock rpc args (tests pass [driverPath]). */
  rpcArgs?: string[];
  /**
   * MTLK-ISO2-MEND (admission resolve-once-and-bind): an invocation the caller
   * already resolved. When present it is bound verbatim for the probe and the
   * returned path — the handshake never re-resolves the environment.
   */
  resolvedRpc?: ResolvedRpcInvocation;
}

/**
 * MTLK-ISO-SLICE2 US-003: refuse a Matchlock admission when the resolved
 * matchlock binary cannot honour the run's swap setting. The US-001 probe runs
 * against the rpc binary resolved by {@link resolveRpcInvocation} BEFORE the
 * image resolve / any policy construction and AFTER the R13 root gate — for
 * EVERY Matchlock admission, including a swap-disabled (`swap_mb` 0) run and an
 * inherited-policy replacement. A missing binary (ENOENT) keeps the existing
 * `matchlock_unavailable` classification; every other failure — token not
 * advertised, timeout, unparseable output — refuses with the typed
 * `matchlock_swap_unsupported` error naming the resolved binary path and the
 * `tamandua matchlock setup` remedy. No policy is written, no image resolved and
 * no VM started. The probe is injectable so tests never need a real binary.
 *
 * MTLK-ISO-SLICE2 US-010: exported so `resumeWorkflow` re-runs the SAME
 * handshake (and taxonomy) before re-registering a Matchlock run (resume does
 * not pass through fresh admission).
 */
export async function assertMatchlockSwapSupport(
  opts: MatchlockSwapHandshakeOptions,
): Promise<string> {
  const { binaryPath } = resolveRpcInvocation(opts);
  const probe =
    opts.swapSupportProbe ??
    ((bin: string) => probeMatchlockSwapSupport({ binaryPath: bin }));

  let support: MatchlockSwapSupport;
  try {
    support = await probe(binaryPath);
  } catch (err) {
    throw new MatchlockAdmissionError(
      "matchlock_swap_unsupported",
      `Refusing Matchlock run: could not verify that the matchlock binary at ${binaryPath} supports ${MATCHLOCK_SWAP_FLAG} (${errorMessage(err)}). ` +
        `The qualified runtime is required even when swap is disabled; provision it with \`tamandua matchlock setup\` ` +
        `or upgrade matchlock to a build that lists ${MATCHLOCK_SWAP_FLAG} (verify with \`matchlock run --help\`).`,
    );
  }
  if (support.supported) return binaryPath;
  if (support.reasonCode === "missing_binary") {
    throw new MatchlockAdmissionError(
      "matchlock_unavailable",
      `Matchlock rpc CLI is unavailable while admitting "${opts.requestedImage}": ${support.reason ?? `binary not found: ${binaryPath}`}. ` +
        "Refusing to start the run without the qualified Matchlock runtime; no host fallback occurred.",
    );
  }
  const detail = support.reason ? ` Reason: ${support.reason}.` : "";
  throw new MatchlockAdmissionError(
    "matchlock_swap_unsupported",
    `Refusing Matchlock run: the matchlock binary at ${binaryPath} does not support ${MATCHLOCK_SWAP_FLAG}.${detail} ` +
      `The qualified runtime is required even when swap is disabled; provision it with \`tamandua matchlock setup\` ` +
      `or upgrade matchlock to a build that lists ${MATCHLOCK_SWAP_FLAG} (verify with \`matchlock run --help\`).`,
  );
}

function resolveRpcInvocation(opts: {
  rpcBinaryPath?: string;
  rpcArgs?: string[];
  resolvedRpc?: ResolvedRpcInvocation;
}): ResolvedRpcInvocation {
  // MTLK-ISO2-MEND (admission resolve-once-and-bind): a caller that already
  // resolved the invocation binds it verbatim — the environment is never
  // re-read, so a PATH/RPC-env change between awaited probes cannot make the
  // launched binary differ from the probed one.
  if (opts.resolvedRpc) return opts.resolvedRpc;
  // MTLK-ISO2-CORRECTIVE (F6): resolve the ONE absolute path the RPC transport
  // will launch (empty PATH components included, exactly like spawn), so the
  // probe and the child cannot diverge and refusals name an absolute path.
  const explicit = opts.rpcBinaryPath?.trim();
  const binaryPath = explicit
    ? path.resolve(explicit)
    : resolveMatchlockSwapBinaryPath(process.env);
  let args = opts.rpcArgs;
  if (!args) {
    const raw = process.env[MATCHLOCK_RPC_ARGS_ENV]?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
          throw new Error("not a string array");
        }
        args = parsed as string[];
      } catch {
        throw new MatchlockAdmissionError(
          "matchlock_unavailable",
          `${MATCHLOCK_RPC_ARGS_ENV} must be a JSON array of strings (override for the matchlock rpc CLI args).`,
        );
      }
    }
  }
  return { binaryPath, args: args && args.length > 0 ? args : ["rpc"] };
}

/** Extract the expected pin from an inherited policy. */
export function pinFromPolicy(policy: ExecutionIsolation): PinnedImageIdentity {
  if (!policy.resolvedImageDigest || !policy.resolvedImageConfigDigest) {
    throw new MatchlockAdmissionError(
      "image_identity_required",
      "Inherited Matchlock policy does not carry the required immutable image content/config pin; refusing to re-admit (legacy/unpinned record).",
    );
  }
  return {
    digest: policy.resolvedImageDigest,
    config_digest: policy.resolvedImageConfigDigest,
    tag: policy.requestedImage,
  };
}

function classifyResolveError(
  err: unknown,
  tag: string,
  imageSource: MatchlockImageSource,
): MatchlockAdmissionError {
  if (err instanceof MatchlockImageError) {
    return new MatchlockAdmissionError(err.code, err.message);
  }
  const body = err as { code?: unknown; message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : err instanceof Error ? err.message : String(err);
  const code = typeof body?.code === "number" ? body.code : undefined;
  if (code === MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT || /timed out/i.test(message)) {
    return new MatchlockAdmissionError(
      "matchlock_unavailable",
      `Matchlock image admission timed out resolving "${tag}": ${message}`,
    );
  }
  if (code === MATCHLOCK_CLIENT_ERROR_CODES.TRANSPORT_CLOSED || /spawn error|not found: (?:pi|matchlock)|ENOENT/i.test(message)) {
    return new MatchlockAdmissionError(
      "matchlock_unavailable",
      `Matchlock rpc CLI is unavailable while admitting image "${tag}": ${message}. ` +
        "Refusing to start the run without a pinned immutable image identity; no host fallback occurred.",
    );
  }
  return new MatchlockAdmissionError(
    "image_unusable",
    imageUnusableRefusalMessage(tag, imageSource, message),
  );
}

/**
 * Resolve the immutable image identity + declared image PATH over a bounded
 * OWNED RPC transport (resolve_image ONLY — never create). The transport is
 * disposed on every path before the promise settles, so a failure can never
 * leak a child and a success can never leave a transport that a later path
 * might reuse to create.
 */
async function resolveImageAdmissionIdentity(opts: MatchlockAdmissionOptions): Promise<{
  pin: PinnedImageIdentity;
  imagePath: string | null;
}> {
  const { binaryPath, args } = resolveRpcInvocation(opts);
  const client = new MatchlockRpcClient({
    binaryPath,
    args,
    requestTimeoutMs: opts.rpcRequestTimeoutMs ?? 45_000,
    stdinDrainTimeoutMs: 5_000,
    readyTimeoutMs: 5_000,
  });
  client.start();
  try {
    // MTLK-PI-EXEC union MTLK-DSH-EXEC: the dsh branch's
    // resolveImageIdentityWithConfig is the union seam — it validates the pin
    // (validateResolvedImageIdentity) AND captures the declared OCI PATH.
    const { pin, imagePath } = await resolveImageIdentityWithConfig(
      (tag) => client.resolveImage(tag),
      opts.requestedImage,
    );
    const inherited = opts.inheritedPolicy;
    if (inherited) {
      // Replacement runs must NOT silently accept a moved/retagged image:
      // the freshly observed identity is compared against the persisted pin
      // and any mismatch fails closed before anything is persisted.
      try {
        verifyImageIdentity(pinFromPolicy(inherited), pin);
      } catch (err) {
        if (err instanceof MatchlockImageError) {
          throw new MatchlockAdmissionError(
            err.code,
            `Replacement image identity mismatch for "${opts.requestedImage}": ${err.message}. The persisted pin is NOT re-pinned; refusing to relaunch on moved content.`,
          );
        }
        throw err;
      }
    }
    return { pin, imagePath };
  } catch (err) {
    if (err instanceof MatchlockAdmissionError) throw err;
    throw classifyResolveError(err, opts.requestedImage, effectiveRequestedImageSource(opts));
  } finally {
    await client.dispose().catch(() => {});
  }
}

/**
 * Admit an opted-in Matchlock run at submission time: validate the selected
 * host configuration source and the exact work/repository scope, resolve and
 * pin the immutable image identity over a bounded owned RPC (NO create), and
 * return the ready-to-persist version-2 policy. The caller MUST persist
 * `result.policy` before the run can become schedulable.
 */
export async function admitMatchlockRun(opts: MatchlockAdmissionOptions): Promise<MatchlockAdmissionResult> {
  const inherited = opts.inheritedPolicy;
  // R13 root gate FIRST: an euid-0 process with no consent (neither the
  // override supplied to THIS action nor valid inherited consent) refuses
  // before any capability probe, the image resolve or any policy construction —
  // no matchlock process is spawned and nothing runs natively.
  assertMatchlockRootUsagePermitted(opts, inherited);
  const requestedImage = opts.requestedImage.trim();
  if (!requestedImage) {
    throw new MatchlockAdmissionError("image_unusable", "Matchlock admission requires a non-empty requestedImage.");
  }
  if (inherited && inherited.requestedImage !== requestedImage) {
    throw new MatchlockAdmissionError(
      "mount_policy_rejected",
      `Replacement requested image "${requestedImage}" differs from the inherited pinned image "${inherited.requestedImage}"; refusing to re-admit under a different image.`,
    );
  }
  // Harness axis: a replacement retains its inherited harness; a fresh run
  // uses the explicitly requested harness (pi default). MTLK-INTEGRATE union:
  // pi, hermes and dsh are all admitted; an unknown harness refuses closed
  // before any effect.
  const harness = inherited?.harness ?? opts.harness ?? "pi";
  if (harness !== "pi" && harness !== "hermes" && harness !== "dsh") {
    throw new MatchlockAdmissionError(
      "guest_harness_incompatible",
      `Matchlock admission supports harness "pi", "hermes" or "dsh" (got ${JSON.stringify(harness)}); refusing before any effect.`,
    );
  }

  const ctx = opts.admission;
  // MTLK-ALLOW-PRIVATE: resolve the effective per-run exception list ONCE,
  // before either harness branch, so the pi/dsh and hermes paths cannot drift.
  // The persisted inherited policy wins for a replacement; a fresh opt-in uses
  // the operator-supplied list. The value is persisted in the returned policy
  // and is never re-derived from the daemon environment at dispatch.
  const allowPrivate = resolveAdmissionAllowPrivate(inherited, opts.allowPrivate);
  // ICEBOX isolation settings (privileged-by-default + DNS priority):
  // resolved ONCE here under the INHERITANCE RULE (an inherited policy's
  // persisted values win VERBATIM; a fresh admission uses the
  // caller-supplied resolved value, else the bare built-in defaults).
  // Admission never reads the ambient environment for these.
  const isolationSettings = resolveAdmissionIsolationSettings(inherited, {
    privileged: opts.matchlockPrivileged,
    dnsPriority: opts.matchlockDnsPriority,
  });

  // MTLK-ISO2-MEND (admission resolve-once-and-bind): resolve the ONE rpc
  // invocation HERE, after every structural refusal and before the first
  // awaited capability probe, then bind it through the whole action. The swap
  // handshake, the allow-private probe and the image resolve therefore all use
  // the exact same binary/argv — a PATH or TAMANDUA_MATCHLOCK_RPC_* change
  // between two awaits can no longer qualify one binary and launch another.
  const boundOpts: MatchlockAdmissionOptions = {
    ...opts,
    resolvedRpc: resolveRpcInvocation(opts),
  };

  if (harness === "hermes") {
    return admitHermesMatchlockRun(boundOpts, inherited, ctx, allowPrivate, isolationSettings);
  }

  // MTLK-ISO-SLICE2 US-003: the pi/dsh path runs the swap-capability handshake
  // BEFORE the image resolve / policy build and AFTER the R13 root gate, for
  // every admission (including a swap-disabled run). The hermes branch runs the
  // same handshake at the top of admitHermesMatchlockRun for parity, so each
  // admission probes exactly once.
  await assertMatchlockSwapSupport(boundOpts);

  // MTLK-ISO2-CORRECTIVE (F6): the allow-private probe runs AFTER the swap
  // handshake so a missing/unsupporting runtime ALWAYS reports the uniform
  // matchlock_unavailable / matchlock_swap_unsupported taxonomy before the
  // flag-specific allow-private refusal. No image resolve happens before it.
  if (allowPrivate && allowPrivate.length > 0) {
    await assertMatchlockAllowPrivateSupport(boundOpts, allowPrivate);
  }

  // Selected configuration source/profile/guest destination: inherited for
  // replacements, captured fresh for new runs. For dsh the effective host
  // DSH_HOME is resolved ONCE here from the FROZEN submission context (default
  // <home>/.dsh, explicit $DSH_HOME with trim/whitespace/relative/tilde
  // semantics from the native dsh-home source) and NEVER re-discovered from
  // the daemon HOME/env at dispatch. The pi path stays byte-identical.
  let configRootRaw: string;
  let configurationProfile: string;
  let guestConfigurationRoot: string;
  let submissionHomeDir: string | undefined;
  let submissionCwd: string | undefined;
  let submissionDshHomeEnv: string | null | undefined;
  let submissionDshHomeSource: "env" | "default" | undefined;
  if (harness === "dsh") {
    configurationProfile = inherited?.configurationProfile ?? DEFAULT_DSH_CONFIGURATION_PROFILE;
    guestConfigurationRoot = inherited?.guestConfigurationRoot ?? DEFAULT_DSH_CONFIGURATION_ROOT;
    if (inherited) {
      // Replacement: RETAIN the inherited frozen context verbatim (a moved
      // daemon HOME/env/cwd must never re-derive a different effective home).
      configRootRaw = inherited.configurationRoot;
      submissionHomeDir = inherited.submissionHomeDir;
      submissionCwd = inherited.submissionCwd;
      submissionDshHomeEnv = inherited.submissionDshHomeEnv ?? null;
      submissionDshHomeSource = inherited.submissionDshHomeSource ?? "default";
    } else {
      const sub = opts.submission;
      if (!sub || typeof sub.homeDir !== "string" || typeof sub.cwd !== "string" || !("env" in sub)) {
        throw new MatchlockAdmissionError(
          "dsh_submission_context_required",
          "dsh Matchlock admission requires the FROZEN submission context (submitting HOME, DSH_HOME and cwd) captured at run creation; the effective DSH_HOME is never re-discovered from the daemon HOME/env.",
        );
      }
      const dshSub = sub as DshSubmissionContext;
      const resolved = resolveDshPolicyHome(dshSub);
      configRootRaw = resolved.hostHome;
      submissionHomeDir = dshSub.homeDir;
      submissionCwd = dshSub.cwd;
      const envRaw = dshSub.env.DSH_HOME;
      submissionDshHomeEnv = envRaw !== undefined && envRaw.trim() !== "" ? envRaw.trim() : null;
      submissionDshHomeSource = resolved.source;
    }
  } else {
    configurationProfile = inherited?.configurationProfile ?? resolvePiConfigProfile();
    guestConfigurationRoot = inherited?.guestConfigurationRoot ?? DEFAULT_GUEST_CONFIGURATION_ROOT;
    configRootRaw = inherited?.configurationRoot ?? resolvePiConfigRoot();
  }

  const configurationRoot = assertConfigRootExists(
    configRootRaw,
    harness === "dsh"
      ? `Selected host dsh home source`
      : `Selected host pi configuration source`,
  );
  assertMountableHostSource(
    configurationRoot,
    guestConfigurationRoot,
    ctx,
    harness === "dsh" ? "dsh configuration home (whole effective DSH_HOME)" : "pi configuration directory",
  );
  // A fresh run uses the caller-supplied (CLI-resolved) limits, else the
  // host-derived defaults; a replacement inherits its policy's limits
  // verbatim (MTLK-VM-SIZE).
  const resourceLimits = resolveAdmissionResourceLimits(inherited, opts.resourceLimits);

  // Exact work/repository/Git scope.
  const plan = inherited
    ? planReplacementScope(opts, inherited)
    : planFreshScope(opts, ctx);

  // Immutable image content+config identity + declared image PATH (owned
  // bounded RPC; NO create). The PATH is persisted with the policy so the
  // helper-pack bin can be prepended ONLY to the image's own effective PATH
  // at dispatch — never re-resolved after submission. MTLK-PI-EXEC union
  // MTLK-DSH-EXEC: applies to pi and dsh alike (the pi admission path is
  // otherwise byte-identical; hermes resolves the same way in its own path).
  // MTLK-ISO2-MEND (resolve-once-and-bind): the image transport uses the SAME
  // invocation the probes above used (`boundOpts`), never a fresh resolution.
  const admitted = await resolveImageAdmissionIdentity(boundOpts);

  // SHARED-V3 provenance + R13 consent. INHERITANCE RULE: an inherited-policy
  // write (replacement/rugpull) preserves the persisted provenance VERBATIM and
  // NEVER recomputes it from the current environment; a fresh write uses the
  // caller's real provenance (defaults "explicit"). Consent follows the §4.5
  // authoritative rule: existing true stays true; an override supplied to THIS
  // action may set false->true; otherwise false — so a fresh false never
  // clears inherited true, and the recorded value always matches the gate.
  const requestedImageSource: MatchlockImageSource =
    inherited?.requestedImageSource ?? opts.imageSource ?? "explicit";
  const rootUsageConsent: boolean =
    inherited?.rootUsageConsent === true || opts.rootUsageConsent === true;

  const policy = buildMatchlockPolicy({
    requestedImage,
    requestedImageSource,
    rootUsageConsent,
    identity: admitted.pin,
    imagePath: admitted.imagePath ?? undefined,
    harness,
    workingDirectory: plan.workingDirectory,
    originalRepositoryRoot: plan.originalRepositoryRoot,
    workMounts: plan.workMounts,
    gitMetadataRoots: plan.gitMetadataRoots,
    configurationRoot,
    configurationProfile,
    guestConfigurationRoot,
    ...(harness === "dsh"
      ? {
          submissionHomeDir,
          submissionCwd,
          submissionDshHomeEnv: submissionDshHomeEnv ?? null,
          submissionDshHomeSource: submissionDshHomeSource ?? "default",
        }
      : {}),
    resourceLimits,
    networkAllowPrivate: allowPrivate,
    // ICEBOX isolation settings: the resolved value + its source reach the
    // persisted policy on every fresh admission write (see
    // resolveAdmissionIsolationSettings for the INHERITANCE RULE).
    matchlockPrivileged: isolationSettings.matchlockPrivileged,
    matchlockDnsPriority: isolationSettings.matchlockDnsPriority,
  });
  return { policy, identity: admitted.pin };
}

/**
 * Admit a FRESH or REPLACEMENT hermes opted-in run. The effective Hermes
 * selection is resolved from FROZEN submission inputs ONLY (homeDir +
 * HERMES_HOME env snapshot + cwd captured at run creation — inherited verbatim
 * for replacements, NEVER re-read from daemon HOME/ambient state):
 *   - a refused/invalid profile, unreadable/malformed/non-regular config or an
 *     explicit non-local terminal backend REFUSES here (bounded diagnostics)
 *     before the image RPC and before any host execution / VM create;
 *   - the canonical effective Hermes config directory must exist and mount
 *     whole RW at the approved guest HERMES_HOME (no image-default
 *     substitution, no broad host source, no symlink source, no guest-root
 *     shadow);
 *   - the immutable image content+config pin is resolved over the owned
 *     bounded RPC (resolve only — NO create) exactly like the pi path.
 */
async function admitHermesMatchlockRun(
  opts: MatchlockAdmissionOptions,
  inherited: ExecutionIsolation | undefined,
  ctx: MountAdmissionContext | undefined,
  allowPrivate: string[] | undefined,
  isolationSettings: {
    matchlockPrivileged: ResolvedMatchlockPrivileged;
    matchlockDnsPriority: ResolvedMatchlockDnsPriority;
  },
): Promise<MatchlockAdmissionResult> {
  // R13 parity: the hermes path runs the SAME root gate, with the same code
  // and ordering, before its selection checks, probes or image resolve. The
  // outer admitMatchlockRun gate already ran; this keeps the guarantee local
  // to the branch as well.
  assertMatchlockRootUsagePermitted(opts, inherited);
  // MTLK-ISO-SLICE2 US-003 parity: the hermes path performs the SAME swap
  // handshake with the same taxonomy, AFTER the root gate and BEFORE the
  // Hermes selection checks and the image resolve.
  await assertMatchlockSwapSupport(opts);
  // MTLK-ISO2-CORRECTIVE (F6): same ordering/taxonomy as the pi/dsh path —
  // the allow-private flag probe runs only after the swap handshake.
  if (allowPrivate && allowPrivate.length > 0) {
    await assertMatchlockAllowPrivateSupport(opts, allowPrivate);
  }
  const requestedImage = opts.requestedImage.trim();

  // Frozen submission inputs: inherited for replacements (never re-read from
  // the daemon environment), captured at run creation for fresh runs.
  const submission: HermesAdmissionSubmission | undefined =
    inherited && inherited.hermes
      ? {
          homeDir: inherited.hermes.homeDir,
          cwd: inherited.hermes.cwd,
          hermesHomeEnv: inherited.hermes.hermesHomeEnv,
        }
      : opts.submission && "hermesHomeEnv" in opts.submission
        ? opts.submission
        : undefined;
  if (!submission || typeof submission.homeDir !== "string" || submission.homeDir.trim() === "" ||
      typeof submission.cwd !== "string" || submission.cwd.trim() === "") {
    throw new MatchlockAdmissionError(
      "hermes_selection_refused",
      "Matchlock Hermes admission requires FROZEN submission inputs (homeDir + HERMES_HOME env snapshot + cwd) captured at run creation; refusing to resolve the Hermes selection from ambient state.",
    );
  }

  // Adapter plan from the frozen inputs only. A refused profile / config
  // problem / explicit non-local backend refuses BEFORE the image RPC and
  // before any host execution or VM create.
  let plan;
  try {
    plan = resolveHermesAdapterPlan(toFrozenHermesSubmission(submission));
  } catch (err) {
    throw new MatchlockAdmissionError(
      "hermes_selection_refused",
      `Refusing to admit the Hermes selection from the frozen submission inputs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (plan.selectionRefused || !plan.launchAdmission.ok) {
    const ad = plan.launchAdmission;
    throw new MatchlockAdmissionError(
      "hermes_selection_refused",
      `Hermes adapter refused the frozen submission selection${ad.code ? ` (${ad.code})` : ""}: ${ad.reason ?? "no launch admission"}. Refused before any host execution or VM create.`,
    );
  }

  // The ENTIRE effective selected Hermes config directory must exist and be a
  // directory (mounted whole RW at the approved guest HERMES_HOME). Only the
  // guest Hermes executable may be absent — the image supplies it.
  const effectiveRaw = plan.capturedIdentity.hostEffectiveDir;
  const guestHermesHome = plan.profile.guestHermesHome;
  const configurationRoot = assertConfigRootExists(effectiveRaw, "hermes");
  assertMountableHostSource(configurationRoot, guestHermesHome, ctx, "Hermes configuration directory");
  // A fresh run uses the caller-supplied (CLI-resolved) limits, else the
  // host-derived defaults; a replacement inherits its policy's limits
  // verbatim (MTLK-VM-SIZE).
  const resourceLimits = resolveAdmissionResourceLimits(inherited, opts.resourceLimits);

  // Exact work/repository/Git scope (identical rules to the pi path).
  const scopePlan = inherited
    ? planReplacementScope(opts, inherited)
    : planFreshScope(opts, ctx);

  // Immutable image content+config identity (owned bounded RPC; NO create).
  // MTLK-PI-EXEC union MTLK-HERMES-EXEC union MTLK-DSH-EXEC:
  // resolveImageAdmissionIdentity returns {pin, imagePath} so the resolved
  // image's effective guest PATH is preserved; the hermes path honours it
  // exactly like the pi and dsh paths.
  const admitted = await resolveImageAdmissionIdentity(opts);
  const identity = admitted.pin;

  // SHARED-V3 provenance + R13 consent (identical to the pi/dsh path): an
  // inherited-policy write preserves the persisted values VERBATIM; a fresh
  // write uses the caller's real provenance/consent (defaults "explicit"/false).
  const requestedImageSource: MatchlockImageSource =
    inherited?.requestedImageSource ?? opts.imageSource ?? "explicit";
  const rootUsageConsent: boolean =
    inherited?.rootUsageConsent === true || opts.rootUsageConsent === true;

  const policy = buildMatchlockPolicy({
    requestedImage,
    requestedImageSource,
    rootUsageConsent,
    identity,
    imagePath: admitted.imagePath ?? undefined,
    harness: "hermes",
    workingDirectory: scopePlan.workingDirectory,
    originalRepositoryRoot: scopePlan.originalRepositoryRoot,
    workMounts: scopePlan.workMounts,
    gitMetadataRoots: scopePlan.gitMetadataRoots,
    configurationRoot,
    configurationProfile: plan.profile.profile,
    guestConfigurationRoot: guestHermesHome,
    hermes: {
      homeDir: submission.homeDir,
      cwd: submission.cwd,
      hermesHomeEnv: submission.hermesHomeEnv,
    },
    resourceLimits,
    networkAllowPrivate: allowPrivate,
    // ICEBOX isolation settings: identical to the pi/dsh path — the
    // resolved value + source (inherited verbatim, or the fresh
    // submission-resolved pair, or the standing defaults) reach the
    // persisted policy.
    matchlockPrivileged: isolationSettings.matchlockPrivileged,
    matchlockDnsPriority: isolationSettings.matchlockDnsPriority,
  });
  return { policy, identity };
}
