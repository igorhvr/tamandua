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
import { resolveMatchlockResourceLimits } from "./resource-limits.js";
import type { DshSubmissionContext } from "./dsh-adapter-contract.js";
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
 * Environment override for the matchlock rpc CLI binary (tests inject a fake
 * driver; production uses `matchlock` from PATH). Only ever consulted when an
 * opt-in admission actually runs — no-flag runs never read it.
 */
export const MATCHLOCK_RPC_BIN_ENV = "TAMANDUA_MATCHLOCK_RPC_BIN";
/** Environment override for the matchlock rpc CLI args (JSON string array). */
export const MATCHLOCK_RPC_ARGS_ENV = "TAMANDUA_MATCHLOCK_RPC_ARGS";

export interface MatchlockAdmissionOptions {
  /** Operator-supplied mandatory image (a replacement inherits its tag). */
  requestedImage: string;
  /**
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
  if (inherited?.resourceLimits) return { ...inherited.resourceLimits };
  if (supplied) return { ...supplied };
  const resolved = resolveMatchlockResourceLimits();
  return { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB };
}

function resolveRpcInvocation(opts: MatchlockAdmissionOptions): { binaryPath: string; args: string[] } {
  const binaryPath = (opts.rpcBinaryPath ?? process.env[MATCHLOCK_RPC_BIN_ENV]?.trim()) || "matchlock";
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

function classifyResolveError(err: unknown, tag: string): MatchlockAdmissionError {
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
    `Matchlock could not resolve image "${tag}": ${message}`,
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
    throw classifyResolveError(err, opts.requestedImage);
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
  if (harness === "hermes") {
    return admitHermesMatchlockRun(opts, inherited, ctx);
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
  const admitted = await resolveImageAdmissionIdentity(opts);

  const policy = buildMatchlockPolicy({
    requestedImage,
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
): Promise<MatchlockAdmissionResult> {
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

  const policy = buildMatchlockPolicy({
    requestedImage,
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
  });
  return { policy, identity };
}
