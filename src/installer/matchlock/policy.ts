/**
 * Matchlock execution-isolation policy.
 *
 * MTLK-ADMIT: the typed, host-owned, immutable execution-isolation policy is
 * captured at run-creation time whenever the operator explicitly passes
 * `--matchlock IMAGE` (or a replacement run inherits an existing policy). It
 * is persisted on the run row (`runs.matchlock_policy`) and is NEVER
 * re-derived from daemon env/HOME at dispatch.
 *
 * Version 2 (MATCHLOCK_POLICY_VERSION) REQUIRES the immutable image
 * content+config pin: `resolvedImageDigest` + `resolvedImageConfigDigest`
 * captured by the admission RPC BEFORE the run becomes schedulable. A record
 * that does not pin content+config (including every legacy version-1 record
 * written by the earlier US-001 slice) FAILS CLOSED on read with an
 * actionable message — it is never treated as a working isolated run, and no
 * code path may silently re-pin a moved tag or fall back to a native harness.
 * A NULL `runs.matchlock_policy` remains the native (no Matchlock) case.
 *
 * The policy pins *authorized roots, the requested image AND its resolved
 * immutable identity*, not a snapshot of mounted bytes. The mounted
 * configuration directory remains mutable by design (credential refresh,
 * user edits); what is frozen is which root is authorized, the image, its
 * content/config identity, and the exact host/guest path mapping.
 *
 * No raw credential values or full configuration contents ever appear in the
 * record — only canonical host paths, image names, digests, versions and
 * enum discriminators. `parseMatchlockPolicy` rejects any object carrying a
 * credential-bearing key so a malformed or hostile DB value cannot smuggle
 * secrets into downstream consumers.
 */

import os from "node:os";
import path from "node:path";
import {
  DSH_GUEST_CONFIGURATION_ROOT,
  DSH_GUEST_PROFILE,
  type DshResolvedHostHome,
  type DshSubmissionContext,
} from "./dsh-adapter-contract.js";
import { resolveDshHostHome } from "./dsh-home.js";
import {
  resolveMatchlockResourceLimits,
  type MatchlockResourceHostProbe,
} from "./resource-limits.js";

/**
 * Current policy record version. Bump when the field set changes
 * incompatible-ly. Version 2 added the REQUIRED immutable image content+config
 * pin (resolvedImageDigest / resolvedImageConfigDigest) — version 1 records
 * are legacy/unpinned and fail closed on read.
 */
export const MATCHLOCK_POLICY_VERSION = 2;
/** Current mount-planning policy version (host/guest path rules). */
export const MATCHLOCK_MOUNT_POLICY_VERSION = 1;
/** Current guest network policy version (destination allow/deny). */
export const MATCHLOCK_NETWORK_POLICY_VERSION = 1;

/**
 * Guest path where the resolved configuration directory is mounted. Kept
 * constant across the supported workflows so the image PATH / worker helper
 * layout is predictable. pi's resolved configuration directory mounts here.
 */
export const DEFAULT_GUEST_CONFIGURATION_ROOT = "/workspace/config/pi";

/** pi settings file name within the config root (the "profile"). */
export const DEFAULT_PI_CONFIG_PROFILE = "settings.json";

/**
 * dsh harness configuration semantics (MTLK-DSH-EXEC US-002): the whole
 * FROZEN effective host DSH_HOME is mounted RW at this guest override and the
 * guest dsh boots the bare `headless` profile.
 */
export const DEFAULT_DSH_CONFIGURATION_ROOT = DSH_GUEST_CONFIGURATION_ROOT;
export const DEFAULT_DSH_CONFIGURATION_PROFILE = DSH_GUEST_PROFILE;

/** Bounded image-name length (a tag cannot legitimately exceed this). */
export const MATCHLOCK_MAX_IMAGE_LENGTH = 512;
/** Bounded digest length (algorithm prefix + ':' + long hex digest). */
export const MATCHLOCK_MAX_DIGEST_LENGTH = 1024;
/** Bounded absolute-path length for a single stored path field. */
export const MATCHLOCK_MAX_PATH_LENGTH = 4096;

/**
 * A single work mount: the host launch path, its canonical real path (for
 * confinement checks / host-alias handling), and the guest path. For every
 * work mount the exact-path rule requires `guestPath === hostPath`.
 */
export interface ExecutionIsolationWorkMount {
  hostPath: string;
  hostRealPath: string;
  guestPath: string;
}

export interface ExecutionIsolationResourceLimits {
  cpus: number;
  memoryMB: number;
  diskSizeMB: number;
}

/**
 * Hermes selection carried by a harness:"hermes" record. It captures the
 * FROZEN submission-time inputs the Hermes adapter plan is resolved from
 * (home dir + the HERMES_HOME env snapshot + cwd), so a dispatch-time round
 * can reconstruct the exact submission and re-resolve/admit the selection
 * WITHOUT ever reading the daemon HOME or later ambient state. Only these
 * three inputs are stored (the adapter plan is re-derived from them per
 * invocation — the mounted config directory remains mutable by design); no
 * raw config content and no credentials ever appear here. Never present on a
 * harness:"pi" record.
 */
export interface ExecutionIsolationHermesSubmission {
  /** FROZEN submission home dir captured at run creation. */
  homeDir: string;
  /** FROZEN submission cwd captured at run creation (resolves a relative HERMES_HOME). */
  cwd: string;
  /**
   * Raw HERMES_HOME value from the submission env snapshot, or null when
   * unset/blank at submission (the adapter then defaults to ~/.hermes under
   * `homeDir`). Trim semantics mirror the native resolver (a blank value is
   * treated as unset).
   */
  hermesHomeEnv: string | null;
}

/**
 * Typed, host-owned execution isolation policy. The controller derives exact
 * mounts and guest paths from this admitted policy and run metadata; it does
 * NOT re-resolve configuration roots, working directories or repository roots
 * from the daemon environment at dispatch time.
 *
 * `resolvedImageDigest` / `resolvedImageConfigDigest` are OPTIONAL at the
 * TypeScript level only so that in-memory version-1-shaped fixtures used by
 * unrelated module tests still compile. For a CURRENT (version 2) record —
 * i.e. anything produced by `buildMatchlockPolicy` or accepted by
 * `parseMatchlockPolicy` — both are REQUIRED and non-empty: a persisted
 * record without them fails closed on read. No dispatch/create path may run
 * on an unpinned record.
 *
 * Harness axis: `harness:"pi"` is the pi backend (pi configuration root/
 * profile/guest root below carry the pi selection). `harness:"hermes"` is
 * the opted-in Hermes backend: the configuration trio below carries the
 * Hermes selection — `configurationRoot` is the canonical host effective
 * Hermes config directory, `configurationProfile` is the resolved profile id
 * (`default` or a named profile id), `guestConfigurationRoot` is the approved
 * guest HERMES_HOME mapping — and `hermes` carries the FROZEN submission
 * inputs. A harness:"hermes" record MUST carry a valid `hermes` block; a
 * harness:"pi" record MUST NOT.
 */
export interface ExecutionIsolation {
  version: number;
  backend: "matchlock";
  /** Operator-supplied mandatory image; no host fallback is implied. */
  requestedImage: string;
  /**
   * The USER IMAGE's effective guest PATH (its OCI config env PATH), preserved
   * at admission from the resolved image so dispatch never re-resolves. The
   * invocation runner prepends ONLY the helper-pack bin to this PATH — never a
   * conservative host default when the image declares its own PATH. Optional
   * for legacy records / images without a declared PATH (runner falls back to
   * a conservative POSIX default in that case).
   */
  imagePath?: string;
  /**
   * Immutable OCI content digest resolved at run-creation admission
   * (e.g. `sha256:…`). Required for version-2 records.
   */
  resolvedImageDigest?: string;
  /**
   * Immutable OCI config digest resolved at run-creation admission
   * (e.g. `sha256:…`). Required for version-2 records.
   */
  resolvedImageConfigDigest?: string;
  /**
   * Selected harness: pi (default), Hermes, or dsh.
   *
   * MTLK-PI-EXEC union MTLK-HERMES-EXEC union MTLK-DSH-EXEC: the integrated
   * candidate admits all three. The field set below is the union of the four
   * source contracts — the pi selection (configurationRoot/profile/guest
   * PI_CODING_AGENT_DIR), the Hermes selection (resolved profile + guest
   * HERMES_HOME + FROZEN `hermes` block) and the dsh selection (resolved
   * effective DSH_HOME + guest /workspace/config/dsh + FROZEN submission
   * context).
   */
  harness: "pi" | "hermes" | "dsh";
  /**
   * Canonical host configuration root captured at run creation: the pi
   * configuration root for harness "pi"; the canonical host effective Hermes
   * config directory for harness "hermes"; the RESOLVED EFFECTIVE host
   * DSH_HOME (default `<capturedHome>/.dsh`, explicit `$DSH_HOME`, relative
   * resolved against the captured cwd, `~` expanded against the captured home)
   * for harness "dsh" — resolved ONCE at submission from the frozen submission
   * context and NEVER re-discovered from the daemon HOME/env at dispatch.
   */
  configurationRoot: string;
  /**
   * Bare file name of the configuration profile within the config root
   * (pi: settings.json; hermes: the resolved profile id; dsh: headless). No
   * path separators: a future consumer joins it onto configurationRoot, so a
   * path-shaped stored value must fail closed.
   */
  configurationProfile: string;
  /**
   * Exact guest override applied inside the guest: the native
   * PI_CODING_AGENT_DIR value for harness "pi", the approved guest HERMES_HOME
   * mapping for harness "hermes", or DSH_HOME for harness "dsh".
   */
  guestConfigurationRoot: string;
  /**
   * FROZEN submission-time inputs (homeDir + HERMES_HOME env snapshot +
   * cwd captured at run creation) for a harness:"hermes" record. Absent for
   * harness "pi" and for harness "dsh".
   */
  hermes?: ExecutionIsolationHermesSubmission;
  /**
   * Frozen submission context for harness "dsh" (MTLK-DSH-EXEC US-002): the
   * submitting user's HOME, the submitting command's cwd and the trimmed
   * explicit `$DSH_HOME` env value (null when unset/whitespace-only ⇒ the
   * `<home>/.dsh` default). `configurationRoot` above is the canonical
   * resolved form of these; the context is persisted so resume/rugpull can
   * never re-derive the effective home from a daemon HOME/env and so the
   * selection source stays auditable. Absent for pi/hermes records.
   */
  submissionHomeDir?: string;
  submissionCwd?: string;
  submissionDshHomeEnv?: string | null;
  submissionDshHomeSource?: "env" | "default";
  workPathMode: "host-absolute";
  /** Same absolute launch cwd on host and guest. */
  workingDirectory: string;
  /** Exact work/repository mounts (hostPath === guestPath for each). */
  workMounts: ExecutionIsolationWorkMount[];
  /**
   * Original repository root for runs whose working scope is inside a
   * repository (a direct repo cwd or a managed worktree); null for a direct
   * NON-repository working directory, which mounts itself only.
   */
  originalRepositoryRoot: string | null;
  /**
   * Resolved Git metadata/common directories that must be available. Roots
   * nested inside an already-mounted ancestor are redundant and the mount
   * planner drops them; EXTERNAL associated Git metadata (separate-git-dir /
   * linked-worktree layouts) is admitted at its own exact path.
   */
  gitMetadataRoots: string[];
  mountPolicyVersion: number;
  networkPolicyVersion: number;
  resourceLimits: ExecutionIsolationResourceLimits;
}

/**
 * The immutable identity that version-2 admission pins onto the policy
 * BEFORE the run can be scheduled. Mirrors `PinnedImageIdentity` in
 * image.ts (kept structurally independent so policy.ts stays a leaf).
 */
export interface MatchlockPinnedImage {
  /** OCI content digest (e.g. sha256:…). */
  digest: string;
  /** OCI config digest (e.g. sha256:…). */
  config_digest: string;
  /** The observed tag at admission (informational; not an authority). */
  tag?: string;
}

export interface BuildMatchlockPolicyParams {
  requestedImage: string;
  /**
   * The REQUIRED persisted immutable image identity (content + config) that
   * admission resolved over its owned RPC. There is no implicit re-pin
   * convenience path: building a policy without a validated pin throws.
   */
  identity: MatchlockPinnedImage;
  // MTLK-PI-EXEC union MTLK-HERMES-EXEC union MTLK-DSH-EXEC: the pi branch
  // added the optional imagePath (effective guest OCI PATH), the hermes branch
  // widened the harness union, and the dsh branch widened it again. Keep both:
  // pi/hermes/dsh records may carry imagePath, and the harness axis accepts all
  // three.
  harness: "pi" | "hermes" | "dsh";
  /** Optional effective guest PATH discovered at admission (image OCI env). */
  imagePath?: string;
  workingDirectory: string;
  originalRepositoryRoot: string | null;
  workMounts: ExecutionIsolationWorkMount[];
  gitMetadataRoots: string[];
  /**
   * Canonical host configuration root. For harness "pi" the pi configuration
   * root (default: resolvePiConfigRoot()); for harness "hermes" this MUST be
   * the explicit canonical host effective Hermes config directory (never a
   * silent pi default).
   */
  configurationRoot?: string;
  /**
   * Bare configuration profile file name (pi default settings.json; hermes the
   * resolved profile id supplied explicitly; dsh default headless); must
   * contain no path separators.
   */
  configurationProfile?: string;
  guestConfigurationRoot?: string;
  /**
   * FROZEN Hermes submission inputs. REQUIRED for harness "hermes"; must be
   * absent for harness "pi" and harness "dsh".
   */
  hermes?: ExecutionIsolationHermesSubmission;
  /** Frozen submission context for harness "dsh" (never re-derived later);
   *  absent for harness "pi" and harness "hermes". */
  submissionHomeDir?: string;
  submissionCwd?: string;
  submissionDshHomeEnv?: string | null;
  submissionDshHomeSource?: "env" | "default";
  resourceLimits?: ExecutionIsolationResourceLimits;
  /**
   * Optional injected host probe used ONLY when `resourceLimits` is absent, so
   * the host-derived defaults are deterministic in tests. Production callers
   * omit it and the resolver probes the real host.
   */
  resourceHostProbe?: MatchlockResourceHostProbe;
}

/**
 * Resolve the pi configuration root at capture time. Honours the native
 * `PI_CODING_AGENT_DIR` override (default `~/.pi/agent`). This mirrors
 * `paths.resolvePiConfigPath()`'s default but follows the pi-native env var.
 *
 * NOTE (exact-path admission): the HOST pi CONFIGURATION DIRECTORY must exist
 * and be a directory when admission runs — the ENTIRE selected root is
 * mounted RW into the guest, and a missing source is a hard fail-closed
 * admission error, never an image-default substitution. What may legitimately
 * be absent is the host pi EXECUTABLE (the guest image supplies it). The
 * directory existence check is enforced by the admission module
 * (`matchlock/admission.ts`), NOT skipped here.
 */
export function resolvePiConfigRoot(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".pi", "agent");
}

/** pi configuration profile name captured with the policy. */
export function resolvePiConfigProfile(): string {
  return DEFAULT_PI_CONFIG_PROFILE;
}

/**
 * Resolve the effective host DSH_HOME from a FROZEN submission context
 * (MTLK-DSH-EXEC US-002). Native-parity semantics are sourced from the
 * imported standalone adapter's dsh-home module: precedence is an explicit
 * configured override, then `$DSH_HOME` (empty/whitespace-only treated as
 * unset), then `<capturedHome>/.dsh`; a relative `$DSH_HOME` resolves against
 * the captured cwd and a `~` prefix expands against the captured home. This
 * is the ONLY production resolver — the effective home is captured at run
 * creation and persisted, never re-discovered from a daemon HOME/env.
 */
export function resolveDshPolicyHome(ctx: DshSubmissionContext): DshResolvedHostHome {
  return resolveDshHostHome(ctx);
}

/** True when a value is a non-empty bounded control-free string. */
function isBoundedCleanString(v: unknown, maxLength: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLength && hasNoControlChars(v);
}

/**
 * Host-derived built-in default resource limits (MTLK-VM-SIZE): used only
 * when a caller supplies no explicit `resourceLimits`. The probe override
 * keeps the defaults deterministic in tests.
 */
function resolveDefaultResourceLimits(
  hostProbe?: MatchlockResourceHostProbe,
): ExecutionIsolationResourceLimits {
  const resolved = resolveMatchlockResourceLimits(hostProbe ? { hostProbe } : {});
  return { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB };
}

/**
 * Build a well-formed, host-owned ExecutionIsolation policy (version 2).
 * Requires the immutable identity pin resolved at admission; throws when the
 * pin is missing or does not pin content+config (no silent unpinned policy,
 * no implicit re-pin).
 */
export function buildMatchlockPolicy(params: BuildMatchlockPolicyParams): ExecutionIsolation {
  const requestedImage = params.requestedImage.trim();
  if (!requestedImage) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      "Matchlock policy requires a non-empty requestedImage.",
    );
  }
  const harness = params.harness ?? "pi";
  if (harness !== "pi" && harness !== "hermes" && harness !== "dsh") {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Matchlock policy harness must be "pi", "hermes" or "dsh" (got ${JSON.stringify(harness)}).`,
    );
  }
  const digest = params.identity?.digest;
  const configDigest = params.identity?.config_digest;
  if (typeof digest !== "string" || digest.trim() === "" ||
      typeof configDigest !== "string" || configDigest.trim() === "") {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      "Matchlock policy requires the immutable image identity resolved at admission (content digest + config digest); call resolveAndAdmitIdentity() first and persist its pin. No silent unpinned policy is built.",
    );
  }
  // dsh: the effective host DSH_HOME must come from the FROZEN submission
  // context captured at run creation (never re-derived from daemon HOME/env).
  if (harness === "dsh") {
    const root = params.configurationRoot?.trim();
    if (!root) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "dsh Matchlock policy requires configurationRoot = the resolved effective host DSH_HOME captured at submission from the frozen submission context; it is never re-discovered from daemon HOME/env later.",
      );
    }
    if (typeof params.submissionHomeDir !== "string" || params.submissionHomeDir.trim() === "" ||
        !path.isAbsolute(params.submissionHomeDir)) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "dsh Matchlock policy requires the frozen submission homeDir (an absolute path) captured at run creation.",
      );
    }
    if (typeof params.submissionCwd !== "string" || params.submissionCwd.trim() === "" ||
        !path.isAbsolute(params.submissionCwd)) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "dsh Matchlock policy requires the frozen submission cwd (an absolute path) captured at run creation.",
      );
    }
    const source = params.submissionDshHomeSource ?? (params.submissionDshHomeEnv ? "env" : "default");
    if (source !== "env" && source !== "default") {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        `dsh Matchlock policy submissionDshHomeSource must be "env" or "default" (got ${JSON.stringify(source)}).`,
      );
    }
    if (source === "env" && !(typeof params.submissionDshHomeEnv === "string" && params.submissionDshHomeEnv.length > 0)) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "dsh Matchlock policy with submission source \"env\" requires the captured non-empty DSH_HOME env value.",
      );
    }
  } else if (harness === "pi" && (params.submissionHomeDir !== undefined || params.submissionCwd !== undefined ||
             params.submissionDshHomeEnv !== undefined || params.submissionDshHomeSource !== undefined)) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      "pi Matchlock policy must not carry the dsh-only frozen submission-context fields.",
    );
  }
  const configurationProfile = params.configurationProfile ?? (harness === "dsh"
    ? DEFAULT_DSH_CONFIGURATION_PROFILE
    : resolvePiConfigProfile());
  if (!isBareFilename(configurationProfile, MATCHLOCK_MAX_PATH_LENGTH)) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Matchlock configurationProfile must be a bare file name with no path separators (got "${configurationProfile}").`,
    );
  }
  // MTLK-PI-EXEC union MTLK-HERMES-EXEC union MTLK-DSH-EXEC: keep the pi
  // imagePath normalization AND the hermes/dsh harness/submission validation.
  const imagePath = normalizeImagePath(params.imagePath);

  // Harness axis: "pi" (pi configuration root/profile/defaults), "hermes"
  // (explicit Hermes configuration selection + FROZEN submission inputs), or
  // "dsh" (FROZEN submission context + resolved effective DSH_HOME). A record
  // never silently carries another harness's submission block or falls back to
  // the pi configuration root.
  const hermes = params.hermes;
  const dshFieldsPresent =
    params.submissionHomeDir !== undefined ||
    params.submissionCwd !== undefined ||
    params.submissionDshHomeEnv !== undefined ||
    params.submissionDshHomeSource !== undefined;
  if (harness === "hermes") {
    if (!isExecutionIsolationHermesSubmission(hermes)) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "Matchlock harness \"hermes\" requires the FROZEN Hermes submission inputs (homeDir/cwd/hermesHomeEnv) captured at run creation; none were supplied. No hermes policy is built from ambient state.",
      );
    }
    if (!isNarrowAbsolutePath(params.configurationRoot ?? "")) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "Matchlock harness \"hermes\" requires an explicit canonical host Hermes configuration root (configurationRoot); refusing to default to the pi configuration root.",
      );
    }
    if (!isNarrowAbsolutePath(params.guestConfigurationRoot ?? "")) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "Matchlock harness \"hermes\" requires an explicit guest HERMES_HOME mapping (guestConfigurationRoot); refusing to default to the pi guest override.",
      );
    }
    if (dshFieldsPresent) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "Matchlock harness \"hermes\" must not carry the dsh-only frozen submission-context fields; refusing an ambiguous record.",
      );
    }
  } else if (harness === "dsh") {
    if (hermes !== undefined) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        "A harness \"dsh\" Matchlock policy must not carry a hermes submission block; refusing an ambiguous record.",
      );
    }
  } else if (hermes !== undefined || dshFieldsPresent) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      "A harness \"pi\" Matchlock policy must not carry a hermes submission block; refusing an ambiguous record.",
    );
  }
  return {
    version: MATCHLOCK_POLICY_VERSION,
    backend: "matchlock",
    requestedImage,
    ...(imagePath !== undefined ? { imagePath } : {}),
    resolvedImageDigest: digest,
    resolvedImageConfigDigest: configDigest,
    harness,
    configurationRoot: params.configurationRoot ?? resolvePiConfigRoot(),
    configurationProfile,
    guestConfigurationRoot: params.guestConfigurationRoot ?? (harness === "dsh"
      ? DEFAULT_DSH_CONFIGURATION_ROOT
      : DEFAULT_GUEST_CONFIGURATION_ROOT),
    ...(harness === "hermes" && hermes !== undefined
      ? { hermes: { ...hermes, hermesHomeEnv: hermes.hermesHomeEnv } }
      : {}),
    ...(harness === "dsh"
      ? {
          submissionHomeDir: params.submissionHomeDir,
          submissionCwd: params.submissionCwd,
          submissionDshHomeEnv: params.submissionDshHomeEnv ?? null,
          submissionDshHomeSource: params.submissionDshHomeSource ?? (params.submissionDshHomeEnv ? "env" : "default"),
        }
      : {}),
    workPathMode: "host-absolute",
    workingDirectory: params.workingDirectory,
    // Clone array inputs so the persisted record never aliases caller-owned
    // objects — later mutation cannot silently rewrite a frozen policy.
    workMounts: params.workMounts.map((m) => ({ ...m })),
    originalRepositoryRoot: params.originalRepositoryRoot,
    gitMetadataRoots: [...params.gitMetadataRoots],
    mountPolicyVersion: MATCHLOCK_MOUNT_POLICY_VERSION,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: params.resourceLimits
      ? { ...params.resourceLimits }
      : resolveDefaultResourceLimits(params.resourceHostProbe),
  };
}

/** Serialize a policy to the string stored in runs.matchlock_policy. */
export function serializeMatchlockPolicy(policy: ExecutionIsolation): string {
  return JSON.stringify(policy);
}

// ── Validation ──

/**
 * Typed policy error. `code` classifies the failure so the dispatch barrier
 * and admission callers can produce an actionable refusal:
 *  - policy_json_invalid      — the stored string is not JSON
 *  - policy_credential_field  — the record carries a credential-bearing key
 *  - policy_legacy_unpinned   — version-1 (or older) unpinned legacy record
 *  - policy_unsupported_version — version present but not the current one
 *  - policy_invalid_record    — structurally invalid / fails fail-closed rules
 */
export class MatchlockPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockPolicyError";
    this.code = code;
  }
}

const EXECUTION_ISOLATION_KEYS = new Set([
  "version",
  "backend",
  "requestedImage",
  "imagePath",
  "resolvedImageDigest",
  "resolvedImageConfigDigest",
  "imagePath",
  "harness",
  "hermes",
  "configurationRoot",
  "configurationProfile",
  "guestConfigurationRoot",
  "submissionHomeDir",
  "submissionCwd",
  "submissionDshHomeEnv",
  "submissionDshHomeSource",
  "workPathMode",
  "workingDirectory",
  "workMounts",
  "originalRepositoryRoot",
  "gitMetadataRoots",
  "mountPolicyVersion",
  "networkPolicyVersion",
  "resourceLimits",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasNoControlChars(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(v);
}

/** An absolute, non-root, bounded, control-free path (POSIX-style). */
function isNarrowAbsolutePath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MATCHLOCK_MAX_PATH_LENGTH) {
    return false;
  }
  if (!path.isAbsolute(v) || v === path.sep) return false;
  return hasNoControlChars(v);
}

/**
 * An absolute (root allowed), bounded, control-free path. Used for the FROZEN
 * Hermes submission `cwd` (a working directory can legitimately be "/");
 * homeDir and the mounted configuration roots use {@link isNarrowAbsolutePath}.
 */
function isAbsolutePathAllowRoot(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MATCHLOCK_MAX_PATH_LENGTH) {
    return false;
  }
  if (!path.isAbsolute(v)) return false;
  return hasNoControlChars(v);
}

/** Raw HERMES_HOME snapshot value: null (unset) or a bounded control-free string. */
function isHermesHomeEnvSnapshot(v: unknown): v is string | null {
  if (v === null || v === undefined) return true;
  return typeof v === "string" && v.length <= MATCHLOCK_MAX_PATH_LENGTH && hasNoControlChars(v);
}

/**
 * Structural guard for the FROZEN Hermes submission block carried by a
 * harness:"hermes" record. `hermesHomeEnv` may be null (HERMES_HOME unset at
 * submission → adapter defaults to ~/.hermes under `homeDir`).
 */
function isExecutionIsolationHermesSubmission(v: unknown): v is ExecutionIsolationHermesSubmission {
  if (!isRecord(v)) return false;
  const keys = new Set(Object.keys(v));
  for (const key of keys) {
    if (key !== "homeDir" && key !== "cwd" && key !== "hermesHomeEnv") return false;
  }
  return (
    isNarrowAbsolutePath(v.homeDir) &&
    isAbsolutePathAllowRoot(v.cwd) &&
    isHermesHomeEnvSnapshot(v.hermesHomeEnv)
  );
}

function isNonEmptyBoundedString(v: unknown, maxLength: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLength && hasNoControlChars(v);
}

/**
 * A bare file NAME (a single path segment with no separators): bounded,
 * control-free, and not "." / "..". `configurationProfile` names the pi
 * settings FILE INSIDE the already-authorized `configurationRoot` — a
 * path-shaped value must never survive a fail-closed record, because a future
 * consumer that joins it onto `configurationRoot` could otherwise be steered
 * outside the authorized root (e.g. an absolute "/etc/passwd").
 */
function isBareFilename(v: unknown, maxLength: number): v is string {
  if (!isNonEmptyBoundedString(v, maxLength)) return false;
  if (v === "." || v === "..") return false;
  if (v.includes("/") || v.includes("\\")) return false;
  return true;
}

/** PATH-list shape: colon-separated ABSOLUTE segments (e.g. /usr/bin:/bin). */
export function isImagePathLike(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > MATCHLOCK_MAX_PATH_LENGTH * 4) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  const segments = v.split(":");
  if (segments.length === 0) return false;
  return segments.every((s) => s.length > 0 && s.startsWith("/") && !s.includes("\n") && !s.includes("\r"));
}

/** Normalize an optional image PATH (empty/blank → undefined). */
export function normalizeImagePath(v: string | undefined | null): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed === "") return undefined;
  if (!isImagePathLike(trimmed)) {
    const preview = JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Matchlock imagePath must be a colon-separated list of absolute directories (got ${preview}).`,
    );
  }
  return trimmed;
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isExecutionIsolationWorkMount(v: unknown): v is ExecutionIsolationWorkMount {
  if (!isRecord(v)) return false;
  return (
    isNarrowAbsolutePath(v.hostPath) &&
    isNarrowAbsolutePath(v.hostRealPath) &&
    isNarrowAbsolutePath(v.guestPath) &&
    v.guestPath === v.hostPath
  );
}

function isExecutionIsolationResourceLimits(v: unknown): v is ExecutionIsolationResourceLimits {
  if (!isRecord(v)) return false;
  return (
    isFinitePositive(v.cpus) &&
    isFinitePositive(v.memoryMB) &&
    isFinitePositive(v.diskSizeMB)
  );
}

/** Collect every structural validation failure for a candidate record. */
export function matchlockPolicyValidationErrors(v: unknown): string[] {
  if (!isRecord(v)) return ["policy record is not an object"];
  const errors: string[] = [];
  for (const key of Object.keys(v)) {
    if (!EXECUTION_ISOLATION_KEYS.has(key)) {
      errors.push(`unknown field "${key}"`);
    }
  }
  if (v.version !== MATCHLOCK_POLICY_VERSION) {
    errors.push(`version must be ${MATCHLOCK_POLICY_VERSION} (got ${String(v.version)})`);
  }
  if (v.backend !== "matchlock") errors.push('backend must be "matchlock"');
  if (!isNonEmptyBoundedString(v.requestedImage, MATCHLOCK_MAX_IMAGE_LENGTH)) {
    errors.push("requestedImage must be a non-empty bounded string");
  }
  if (v.imagePath !== undefined && !isImagePathLike(v.imagePath)) {
    errors.push("imagePath must be a colon-separated list of absolute directories when present");
  }
  // REQUIRED immutable content+config pin (version 2).
  if (!isNonEmptyBoundedString(v.resolvedImageDigest, MATCHLOCK_MAX_DIGEST_LENGTH)) {
    errors.push("resolvedImageDigest is required (immutable content digest)");
  }
  if (!isNonEmptyBoundedString(v.resolvedImageConfigDigest, MATCHLOCK_MAX_DIGEST_LENGTH)) {
    errors.push("resolvedImageConfigDigest is required (immutable config digest)");
  }
  // Harness axis union: pi, hermes and dsh are all valid; each harness's
  // submission block is required for that harness and forbidden on the other
  // two (no cross-harness mixing).
  if (v.harness !== "pi" && v.harness !== "hermes" && v.harness !== "dsh") {
    errors.push('harness must be "pi", "hermes" or "dsh"');
  } else if (v.harness === "hermes") {
    if (!isExecutionIsolationHermesSubmission(v.hermes)) {
      errors.push(
        'harness "hermes" requires the FROZEN hermes submission block (homeDir: narrow absolute path, cwd: absolute path, hermesHomeEnv: null or bounded string)',
      );
    }
    for (const key of ["submissionHomeDir", "submissionCwd", "submissionDshHomeEnv", "submissionDshHomeSource"]) {
      if (v[key] !== undefined) {
        errors.push(`field "${key}" is only valid on dsh (harness "dsh") policies`);
      }
    }
  } else if (v.harness === "dsh") {
    if (v.hermes !== undefined) {
      errors.push('harness "dsh" must not carry a hermes submission block');
    }
    // Frozen submission context is REQUIRED for dsh records (US-002): the
    // effective DSH_HOME is pinned at submission and never re-derived later.
    if (!isNarrowAbsolutePath(v.submissionHomeDir)) {
      errors.push("submissionHomeDir is required for dsh policies (narrow absolute path)");
    }
    if (!isNarrowAbsolutePath(v.submissionCwd)) {
      errors.push("submissionCwd is required for dsh policies (narrow absolute path)");
    }
    if (v.submissionDshHomeEnv !== null && v.submissionDshHomeEnv !== undefined &&
        !isBoundedCleanString(v.submissionDshHomeEnv, MATCHLOCK_MAX_PATH_LENGTH)) {
      errors.push("submissionDshHomeEnv must be null or a bounded control-free string for dsh policies");
    }
    if (v.submissionDshHomeEnv === undefined) {
      errors.push("submissionDshHomeEnv is required for dsh policies (explicit DSH_HOME value or null)");
    }
    if (v.submissionDshHomeSource !== "env" && v.submissionDshHomeSource !== "default") {
      errors.push('submissionDshHomeSource must be "env" or "default" for dsh policies');
    } else if (v.submissionDshHomeSource === "default" && v.submissionDshHomeEnv !== null) {
      errors.push('submissionDshHomeSource "default" requires submissionDshHomeEnv to be null');
    } else if (v.submissionDshHomeSource === "env" &&
               !(typeof v.submissionDshHomeEnv === "string" && v.submissionDshHomeEnv.length > 0)) {
      errors.push('submissionDshHomeSource "env" requires a non-empty submissionDshHomeEnv');
    }
  } else {
    // pi records never carry either other harness's submission block.
    if (v.hermes !== undefined) {
      errors.push('harness "pi" must not carry a hermes submission block');
    }
    for (const key of ["submissionHomeDir", "submissionCwd", "submissionDshHomeEnv", "submissionDshHomeSource"]) {
      if (v[key] !== undefined) {
        errors.push(`field "${key}" is only valid on dsh (harness "dsh") policies`);
      }
    }
  }
  if (!isNarrowAbsolutePath(v.configurationRoot)) errors.push("configurationRoot must be a narrow absolute path");
  if (!isBareFilename(v.configurationProfile, MATCHLOCK_MAX_PATH_LENGTH)) {
    errors.push("configurationProfile must be a bare file name with no path separators (e.g. settings.json)");
  }
  if (!isNarrowAbsolutePath(v.guestConfigurationRoot)) errors.push("guestConfigurationRoot must be a narrow absolute path");
  if (v.workPathMode !== "host-absolute") errors.push('workPathMode must be "host-absolute"');
  if (!isNarrowAbsolutePath(v.workingDirectory)) errors.push("workingDirectory must be a narrow absolute path");
  if (!Array.isArray(v.workMounts) || v.workMounts.length === 0) {
    errors.push("workMounts must be a non-empty array");
  } else if (!(v.workMounts as unknown[]).every(isExecutionIsolationWorkMount)) {
    errors.push("every workMount must carry identical narrow absolute host/guest paths");
  }
  if (v.originalRepositoryRoot !== null && !isNarrowAbsolutePath(v.originalRepositoryRoot)) {
    errors.push("originalRepositoryRoot must be null or a narrow absolute path");
  }
  if (!Array.isArray(v.gitMetadataRoots) ||
      !(v.gitMetadataRoots as unknown[]).every(isNarrowAbsolutePath)) {
    errors.push("gitMetadataRoots must be an array of narrow absolute paths");
  }
  if (v.mountPolicyVersion !== MATCHLOCK_MOUNT_POLICY_VERSION) {
    errors.push(`mountPolicyVersion must be ${MATCHLOCK_MOUNT_POLICY_VERSION} (got ${String(v.mountPolicyVersion)})`);
  }
  if (v.networkPolicyVersion !== MATCHLOCK_NETWORK_POLICY_VERSION) {
    errors.push(`networkPolicyVersion must be ${MATCHLOCK_NETWORK_POLICY_VERSION} (got ${String(v.networkPolicyVersion)})`);
  }
  if (!isExecutionIsolationResourceLimits(v.resourceLimits)) {
    errors.push("resourceLimits must be finite positive numbers");
  }
  return errors;
}

/** Structural type guard for a CURRENT (version-2) persisted ExecutionIsolation record. */
export function isExecutionIsolationPolicy(v: unknown): v is ExecutionIsolation {
  return matchlockPolicyValidationErrors(v).length === 0;
}

const FORBIDDEN_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "credential",
  "private_key",
  "bearer",
  "auth",
];

/**
 * Recursively reject any record whose keys look credential-bearing. The
 * policy schema has no legitimate credential field, so this is a hard
 * failure — a policy that would carry a secret is malformed, not sanitizable.
 */
export function assertNoCredentialValues(v: unknown): void {
  if (Array.isArray(v)) {
    for (const entry of v) assertNoCredentialValues(entry);
    return;
  }
  if (isRecord(v)) {
    for (const [key, value] of Object.entries(v)) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_KEY_FRAGMENTS.some((f) => lower.includes(f))) {
        throw new MatchlockPolicyError(
          "policy_credential_field",
          `Matchlock policy must not contain credential-bearing field "${key}".`,
        );
      }
      assertNoCredentialValues(value);
    }
  }
}

/**
 * Parse and validate a persisted policy string. Throws a MatchlockPolicyError
 * on malformed JSON, credential-bearing fields, legacy (version-1, unpinned)
 * records, unknown versions, or a structurally invalid record — a stored
 * policy that fails validation must fail closed, never be silently coerced or
 * treated as native.
 */
export function parseMatchlockPolicy(json: string): ExecutionIsolation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new MatchlockPolicyError(
      "policy_json_invalid",
      `Invalid matchlock policy JSON: ${(err as Error).message}`,
    );
  }
  assertNoCredentialValues(parsed);
  // Classify legacy/unknown VERSIONS before structural validation so a
  // version-1 unpinned record gets an explicit, actionable refusal instead of
  // a generic structural error.
  if (isRecord(parsed)) {
    if (parsed.version === 1) {
      throw new MatchlockPolicyError(
        "policy_legacy_unpinned",
        "Matchlock policy version 1 is a legacy UNPINNED record (no immutable image content/config identity). It must never look like a working isolated run: recreate the run with --matchlock so admission resolves and persists the content+config pin.",
      );
    }
    if (typeof parsed.version !== "number" || parsed.version !== MATCHLOCK_POLICY_VERSION) {
      throw new MatchlockPolicyError(
        "policy_unsupported_version",
        `Matchlock policy version ${String(parsed.version)} is not supported by this build (expected ${MATCHLOCK_POLICY_VERSION}); refusing to treat it as an isolated run.`,
      );
    }
  }
  const errors = matchlockPolicyValidationErrors(parsed);
  if (errors.length > 0) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Invalid matchlock policy: ${errors.join("; ")}.`,
    );
  }
  return parsed as ExecutionIsolation;
}
