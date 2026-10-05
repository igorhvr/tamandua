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
 * MTLK-ISO-SLICE1 / SHARED-V3: version 3 is the SINGLE coordinated schema
 * shared by the standard-image and swap-default changes. It adds the image
 * provenance (`requestedImageSource`), the per-run swap size
 * (`resourceLimits.swapMB`, 0 = swap off) and the explicit root-usage
 * override consent (`rootUsageConsent`) as REQUIRED fields. There is no
 * 3→4 path: a pre-v3 binary refuses a v3 record fail-closed. A valid v2
 * record keeps reading (normalized in memory to the v3 shape at parse time
 * — a read-time projection that never rewrites the stored JSON); a v2 record
 * carrying v3-only fields, or a v3 record missing a required field, is
 * refused (version/field-set agreement).
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
  MATCHLOCK_DEFAULT_SWAP_MB,
  MATCHLOCK_MAX_SWAP_MB,
  resolveMatchlockResourceLimits,
  type MatchlockResourceHostProbe,
} from "./resource-limits.js";
import type { MatchlockImageSource } from "./standard-image.js";
import {
  MATCHLOCK_ALLOW_PRIVATE_GRAMMAR,
  MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES,
  isAllowPrivateEntryShape,
  normalizeAllowPrivateEntries,
  validateAllowPrivateEntry,
} from "./allow-private.js";

/**
 * Current policy record version. Bump when the field set changes
 * incompatible-ly. Version 2 added the REQUIRED immutable image content+config
 * pin (resolvedImageDigest / resolvedImageConfigDigest) — version 1 records
 * are legacy/unpinned and fail closed on read. Version 3 (MTLK-ISO-SLICE1,
 * SHARED-V3) adds the REQUIRED image provenance
 * (`requestedImageSource`), the per-run swap size
 * (`resourceLimits.swapMB`, integer 0..65536, 0 = swap off) and the explicit
 * root-usage override consent (`rootUsageConsent`). Version 3 is the single
 * coordinated schema for both the standard-image and swap-default changes —
 * there is deliberately no 3→4 path.
 */
export const MATCHLOCK_POLICY_VERSION = 3;
/** Current mount-planning policy version (host/guest path rules). */
export const MATCHLOCK_MOUNT_POLICY_VERSION = 1;
/**
 * Current guest network policy version (destination allow/deny).
 *
 * Version 2 (MTLK-ALLOW-PRIVATE) adds the optional allow-private destination
 * list (`networkAllowPrivate`): the per-run exception list of private
 * destinations the guest network may reach, mapped to the matchlock fork's
 * `network.allow_private`. Version 1 records carry no such list; a persisted
 * record whose `networkPolicyVersion` is not the current version fails closed.
 */
export const MATCHLOCK_NETWORK_POLICY_VERSION = 2;

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
  /**
   * Guest swap size in MB (MTLK-SWAP / SHARED-V3): an integer in
   * 0..{@link MATCHLOCK_MAX_SWAP_MB} where `0` explicitly means swap is
   * OFF. Required on a version-3 record with its OWN predicate — 0 is valid
   * for this field alone, while cpus/memoryMB/diskSizeMB keep
   * `isFinitePositive`. There is no absence semantics.
   */
  swapMB: number;
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
 * unrelated module tests still compile. For a CURRENT (version 3) record —
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
   * How the effective image reference was chosen (SHARED-V3): `"explicit"`
   * when the operator named an image (`--matchlock-image`), `"standard"`
   * when the bare opt-in resolved the standard image (or its env override).
   * REQUIRED on a version-3 record; a version-2 record has no such field and
   * is normalized to `"explicit"` at read time. Display-only provenance:
   * the authenticated identity is the content+config pin below.
   */
  requestedImageSource: MatchlockImageSource;
  /**
   * R13 root-usage consent (SHARED-V3): `true` ONLY when the operator
   * explicitly supplied the root-usage override to THIS action (or an
   * inherited record already carried `true`). `false` otherwise — including
   * every normalized version-2 record, where the value is a conservative
   * reading of missing information, not a claim about the run's history.
   * Strict boolean; REQUIRED on a version-3 record.
   */
  rootUsageConsent: boolean;
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
  /**
   * Optional per-run allow-private destination list (MTLK-ALLOW-PRIVATE): the
   * private destinations (host names, IP literals or CIDRs, optional `:port`)
   * the guest network may reach; every other private destination stays
   * blocked. Absent when empty. Persisted here so every round, retry and
   * resume of the run dispatches the SAME list and dispatch never re-derives
   * it from the daemon environment.
   */
  networkAllowPrivate?: string[];
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
   * Image provenance captured at run creation (SHARED-V3). Defaults to
   * `"explicit"` for a caller that predates the standard-image opt-in; the
   * standard-image path threads the parser's real `matchlockImageSource`.
   */
  requestedImageSource?: MatchlockImageSource;
  /**
   * R13 root-usage override consent for THIS action (default `false`). A
   * caller/action that did not explicitly exercise the override supplies
   * nothing; an inherited-policy write preserves the inherited value in
   * admission, never re-deriving it here.
   */
  rootUsageConsent?: boolean;
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
   * Optional per-run allow-private destination list (MTLK-ALLOW-PRIVATE)
   * resolved at launch. Entries are normalized (trim/drop-blank/dedupe) and
   * shape-validated here; the normalized list is stored ONLY when non-empty.
   * Resolution/DNS is deliberately left to the matchlock fork — this is a
   * shape check that fails closed before an invalid policy is persisted.
   */
  networkAllowPrivate?: readonly string[];
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
  return {
    cpus: resolved.cpus,
    memoryMB: resolved.memoryMB,
    diskSizeMB: resolved.diskSizeMB,
    // SHARED-V3: fresh writes carry the effective swap size from the shared
    // resolver (default 8192; 0 only when swap is explicitly disabled).
    swapMB: resolved.swapMB,
  };
}

/**
 * Complete a caller-supplied resource-limits object with the v3 swap field.
 *
 * A caller that predates the swap surface (or a fixture) may omit `swapMB`;
 * the persisted record is ALWAYS a complete v3 record, so the missing field
 * resolves to the shared built-in default (8192). An explicit `0` (swap off)
 * is preserved verbatim. This is the FRESH-write path only: an inherited
 * policy's limits are spread verbatim by admission and never pass here (the
 * INHERITANCE RULE: swapMB, provenance and consent are never recomputed from
 * the current environment on an inherited write).
 */
function completeResourceLimits(
  limits: ExecutionIsolationResourceLimits,
): ExecutionIsolationResourceLimits {
  return {
    cpus: limits.cpus,
    memoryMB: limits.memoryMB,
    diskSizeMB: limits.diskSizeMB,
    swapMB: typeof limits.swapMB === "number" ? limits.swapMB : MATCHLOCK_DEFAULT_SWAP_MB,
  };
}

/**
 * Build a well-formed, host-owned ExecutionIsolation policy (version 3).
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

  // MTLK-ALLOW-PRIVATE: normalize then shape-validate the per-run allow-private
  // destination list. The resolver is deliberately NOT consulted here — DNS
  // resolution and rebinding-safe name matching are the matchlock fork's job;
  // this fails closed on a malformed entry BEFORE an invalid policy is
  // persisted. The field is stored ONLY when the normalized list is non-empty.
  const networkAllowPrivate = normalizeAllowPrivateEntries(params.networkAllowPrivate ?? []);
  if (networkAllowPrivate.length > MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Matchlock policy networkAllowPrivate accepts at most ${MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES} entries (got ${networkAllowPrivate.length}).`,
    );
  }
  for (const entry of networkAllowPrivate) {
    const result = validateAllowPrivateEntry(entry);
    if (!result.ok) {
      throw new MatchlockPolicyError(
        "policy_invalid_record",
        `Matchlock policy networkAllowPrivate ${result.reason}. Entries are ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}.`,
      );
    }
  }

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
    // SHARED-V3 provenance: every fresh write is truthful. The standard-image
    // opt-in threads the parser's real source; every pre-existing caller and
    // every inherited-policy write (handled in admission) stays "explicit".
    requestedImageSource: params.requestedImageSource ?? "explicit",
    // SHARED-V3 R13 consent: true only when THIS action explicitly exercised
    // the root-usage override. An inherited-policy write preserves the
    // inherited value in admission, so this default never clobbers consent.
    rootUsageConsent: params.rootUsageConsent === true,
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
    // Clone so the persisted record never aliases caller state; omit entirely
    // when empty so an unset list stays absent.
    ...(networkAllowPrivate.length > 0 ? { networkAllowPrivate: [...networkAllowPrivate] } : {}),
    resourceLimits: params.resourceLimits
      ? completeResourceLimits(params.resourceLimits)
      : resolveDefaultResourceLimits(params.resourceHostProbe),
  };
}

/** Serialize a policy to the string stored in runs.matchlock_policy. */
export function serializeMatchlockPolicy(policy: ExecutionIsolation): string {
  return JSON.stringify(policy);
}

/**
 * MTLK-ISO-SLICE2 US-009 (spec C §4.4/§4.5): the ONE sanctioned in-place
 * policy update — the R13 consent-granting resume. Parse a persisted policy
 * and return a fresh v3 record with `rootUsageConsent: true`.
 *
 * The image identity and pin, resource limits, harness submission block, work
 * mounts and network restrictions are preserved VERBATIM; the only shape
 * change is the v2→v3 normalization `parseMatchlockPolicy` already performs
 * on a valid v2 record (version stamp plus defaulted `requestedImageSource` /
 * `swapMB`). A record that is already consented is returned byte-for-byte
 * unchanged. Throws {@link MatchlockPolicyError} on an unusable record: the
 * consent flag never rescues an unusable policy (the caller refuses on the
 * STATUS-UNUSABLE path BEFORE consulting consent).
 */
export function withGrantedRootUsageConsent(policyJson: string): string {
  const policy = parseMatchlockPolicy(policyJson);
  if (policy.rootUsageConsent === true) return policyJson;
  return serializeMatchlockPolicy({ ...policy, rootUsageConsent: true });
}

/** A typed, sanitized description of a non-NULL unusable policy. */
export interface UnusableMatchlockPolicyDescription {
  /** The typed {@link MatchlockPolicyError} code (or a fallback). */
  code: string;
  /** The allow-listed, sanitized explanation — never the raw parser message. */
  reason: string;
}

/**
 * MTLK-ISO-SLICE2 US-014 (spec C §4.6 sanitization rule): the ALLOW-LISTED,
 * sanitized operator explanation for a {@link MatchlockPolicyError} code.
 *
 * The parser's own message can embed fragments of the stored input (an
 * `unknown field "…"` name, the `JSON.parse` error snippet, the offending
 * version value) and the raw stored JSON must never be rendered by an
 * operator surface. Every consumer of the STATUS-UNUSABLE vocabulary derives
 * its reason from the error CATEGORY through this map; an unknown code falls
 * back to a bounded generic explanation. The strings are static: no parser
 * text, no stored input, no secrets.
 */
const SANITIZED_UNUSABLE_POLICY_REASONS: Readonly<Record<string, string>> = {
  policy_json_invalid: "the persisted matchlock policy is not valid JSON",
  policy_credential_field: "the persisted matchlock policy carries a credential-bearing field",
  policy_legacy_unpinned:
    "the persisted matchlock policy is a legacy unpinned record that must be recreated",
  policy_unsupported_version: "the persisted matchlock policy version is not supported by this build",
  policy_invalid_record: "the persisted matchlock policy is structurally invalid",
  policy_missing: "no persisted matchlock policy",
  policy_unusable: "the persisted matchlock policy could not be used",
};

/**
 * Map a typed unusable-policy code to its allow-listed, sanitized explanation.
 * Unknown codes (and any future code not yet allow-listed) degrade to a
 * bounded generic message rather than leaking parser text.
 */
export function sanitizeUnusableMatchlockPolicyReason(code: string): string {
  return (
    SANITIZED_UNUSABLE_POLICY_REASONS[code] ??
    "the persisted matchlock policy could not be used"
  );
}

/**
 * MTLK-ISO-SLICE2 US-010/US-014: the shared typed code + sanitized reason for a
 * non-NULL unusable persisted policy (spec C §4.6 sanitization rule). The
 * reason is an allow-listed explanation derived from the error CATEGORY —
 * never the raw parser message (which can embed stored-input fragments) and
 * never the raw policy JSON. Used by the control-plane resume handler, the
 * failed-run `resumeWorkflow` and `workflow status` so the STATUS-UNUSABLE
 * vocabulary cannot drift between the display surfaces.
 *
 * The null/undefined branch is defensive: callers reach here only for an
 * explicit non-NULL value.
 */
export function describeUnusableMatchlockPolicy(
  raw: string | null | undefined,
): UnusableMatchlockPolicyDescription {
  if (raw === null || raw === undefined) {
    return {
      code: "policy_missing",
      reason: sanitizeUnusableMatchlockPolicyReason("policy_missing"),
    };
  }
  try {
    parseMatchlockPolicy(raw);
    return {
      code: "policy_unusable",
      reason: sanitizeUnusableMatchlockPolicyReason("policy_unusable"),
    };
  } catch (err) {
    const code = err instanceof MatchlockPolicyError ? err.code : "policy_invalid_record";
    return { code, reason: sanitizeUnusableMatchlockPolicyReason(code) };
  }
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
  // SHARED-V3 provenance + R13 consent (defaulting this pair's absence only
  // applies to a version-2 record; on v3 they are REQUIRED).
  "requestedImageSource",
  "rootUsageConsent",
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
  "networkAllowPrivate",
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

/**
 * SHARED-V3 swap-size predicate: an INTEGER in 0..MATCHLOCK_MAX_SWAP_MB.
 * `0` is valid for this field alone (swap off), so it does NOT use
 * `isFinitePositive`. Rejects 65537, negatives, fractions, non-numbers and
 * NaN/Infinity.
 */
export function isSwapMB(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MATCHLOCK_MAX_SWAP_MB;
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

/**
 * Version-aware resource-limits validator. `requireSwap` is true for a v3
 * record (swapMB REQUIRED and 0..65536) and false for a v2 record (swapMB is
 * a v3-only field and must be ABSENT — version/field-set agreement).
 */
function isExecutionIsolationResourceLimits(
  v: unknown,
  requireSwap: boolean,
): v is ExecutionIsolationResourceLimits {
  if (!isRecord(v)) return false;
  if (
    !isFinitePositive(v.cpus) ||
    !isFinitePositive(v.memoryMB) ||
    !isFinitePositive(v.diskSizeMB)
  ) {
    return false;
  }
  return requireSwap ? isSwapMB(v.swapMB) : v.swapMB === undefined;
}

/**
 * Collect every structural validation failure for a candidate record.
 *
 * `expectedVersion` selects the record shape being validated: the current
 * (v3) shape by default, or the v2 shape when checking an inherited v2
 * record's ORIGINAL stored shape before normalization (version/field-set
 * agreement: a v2 record carrying v3-only fields is refused here).
 */
export function matchlockPolicyValidationErrors(
  v: unknown,
  expectedVersion: 2 | 3 = 3,
): string[] {
  if (!isRecord(v)) return ["policy record is not an object"];
  const errors: string[] = [];
  const requireV3Fields = expectedVersion === 3;
  for (const key of Object.keys(v)) {
    if (!EXECUTION_ISOLATION_KEYS.has(key)) {
      // MTLK-ISO2-CORRECTIVE (F5): a field NAME is caller-controlled input.
      // Name it only when it is a safe identifier so a sentinel cannot ride
      // the refusal/status output.
      errors.push(
        /^[A-Za-z0-9_]{1,64}$/.test(key)
          ? `unknown field "${key}"`
          : "unknown field (unsafe name withheld)",
      );
    }
  }
  if (v.version !== expectedVersion) {
    // MTLK-ISO2-CORRECTIVE (F5): never echo a non-numeric version verbatim.
    const observed =
      typeof v.version === "number" ? ` (got ${v.version})` : "";
    errors.push(`version must be ${expectedVersion}${observed}`);
  }
  if (v.backend !== "matchlock") errors.push('backend must be "matchlock"');
  if (!isNonEmptyBoundedString(v.requestedImage, MATCHLOCK_MAX_IMAGE_LENGTH)) {
    errors.push("requestedImage must be a non-empty bounded string");
  }
  if (!requireV3Fields) {
    // Version/field-set agreement: the two top-level v3-only fields must be
    // ABSENT on a v2 record.
    if (v.requestedImageSource !== undefined) {
      errors.push("requestedImageSource is a version-3 field; a version-2 record must not carry it");
    }
    if (v.rootUsageConsent !== undefined) {
      errors.push("rootUsageConsent is a version-3 field; a version-2 record must not carry it");
    }
  } else {
    // REQUIRED v3 image provenance.
    if (v.requestedImageSource !== "explicit" && v.requestedImageSource !== "standard") {
      errors.push('requestedImageSource must be "explicit" or "standard"');
    }
    // REQUIRED v3 R13 consent: a STRICT boolean (never truthy/falsy coercion).
    if (typeof v.rootUsageConsent !== "boolean") {
      errors.push("rootUsageConsent must be a boolean");
    }
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
  if (v.networkAllowPrivate !== undefined) {
    if (!Array.isArray(v.networkAllowPrivate)) {
      errors.push("networkAllowPrivate must be an array of allow-private entries when present");
    } else if (v.networkAllowPrivate.length > MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES) {
      errors.push(
        `networkAllowPrivate accepts at most ${MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES} entries (got ${v.networkAllowPrivate.length})`,
      );
    } else if (!(v.networkAllowPrivate as unknown[]).every(isAllowPrivateEntryShape)) {
      errors.push(`every networkAllowPrivate entry must be ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}`);
    }
  }
  if (!isExecutionIsolationResourceLimits(v.resourceLimits, requireV3Fields)) {
    if (isRecord(v.resourceLimits) &&
        isFinitePositive(v.resourceLimits.cpus) &&
        isFinitePositive(v.resourceLimits.memoryMB) &&
        isFinitePositive(v.resourceLimits.diskSizeMB)) {
      // The base trio is valid, so the only way the version-aware check failed
      // is the version-specific swapMB agreement.
      errors.push(requireV3Fields
        ? `resourceLimits.swapMB must be an integer between 0 and ${MATCHLOCK_MAX_SWAP_MB}`
        : "resourceLimits.swapMB is a version-3 field; a version-2 record must not carry it");
    } else {
      errors.push("resourceLimits must be finite positive numbers");
    }
  }
  return errors;
}

/** Structural type guard for a CURRENT (version-3) persisted ExecutionIsolation record. */
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
 * Normalize a VALID version-2 record to the current v3 shape for consumers.
 *
 * This is a READ-TIME projection: it returns a NEW in-memory object and never
 * mutates or rewrites the stored JSON. The v3 fields that did not exist on
 * v2 resolve conservatively:
 *  - `requestedImageSource: "explicit"` (only explicit references existed),
 *  - `resourceLimits.swapMB: 0` (swap OFF — the run's ORIGINAL behaviour,
 *    never the new 8192 default),
 *  - `rootUsageConsent: false` (a conservative reading of missing
 *    information, not a claim that the run never executed as root).
 *
 * The caller must have already validated the v2 original shape
 * (`matchlockPolicyValidationErrors(record, 2)`), so the v3-only fields are
 * guaranteed absent here.
 */
function normalizeV2PolicyToV3(record: Record<string, unknown>): ExecutionIsolation {
  const resourceLimits = {
    ...(record.resourceLimits as ExecutionIsolationResourceLimits),
    swapMB: 0,
  };
  return {
    ...(record as unknown as ExecutionIsolation),
    version: MATCHLOCK_POLICY_VERSION,
    requestedImageSource: "explicit",
    rootUsageConsent: false,
    resourceLimits,
  };
}

/**
 * Parse and validate a persisted policy string. Throws a MatchlockPolicyError
 * on malformed JSON, credential-bearing fields, legacy (version-1, unpinned)
 * records, unknown versions, or a structurally invalid record — a stored
 * policy that fails validation must fail closed, never be silently coerced or
 * treated as native.
 *
 * Reader rule (SHARED-V3): versions {2, 3} are accepted. The ORIGINAL stored
 * shape is validated FIRST (version/field-set agreement). A valid v2 record
 * is then normalized to the v3 shape for consumers (a read-time projection;
 * the stored string is never rewritten). A v3 record must carry every
 * required v3 field.
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
    if (parsed.version === 2) {
      // Validate the ORIGINAL v2 shape first (v3-only fields must be absent),
      // then project it to v3 for consumers.
      const v2Errors = matchlockPolicyValidationErrors(parsed, 2);
      if (v2Errors.length > 0) {
        throw new MatchlockPolicyError(
          "policy_invalid_record",
          `Invalid matchlock policy: ${v2Errors.join("; ")}.`,
        );
      }
      return normalizeV2PolicyToV3(parsed);
    }
    if (typeof parsed.version !== "number" || parsed.version !== MATCHLOCK_POLICY_VERSION) {
      // MTLK-ISO2-CORRECTIVE (F5): never embed the raw version value — it is
      // caller-controlled input that must not leak through scheduling_error
      // into the status document. A numeric version is safe to name; any other
      // type is reported by category only.
      const observed =
        typeof parsed.version === "number" ? ` (got ${parsed.version})` : "";
      throw new MatchlockPolicyError(
        "policy_unsupported_version",
        `Matchlock policy version is not supported by this build (expected ${MATCHLOCK_POLICY_VERSION})${observed}; refusing to treat it as an isolated run.`,
      );
    }
  }
  const errors = matchlockPolicyValidationErrors(parsed, 3);
  if (errors.length > 0) {
    throw new MatchlockPolicyError(
      "policy_invalid_record",
      `Invalid matchlock policy: ${errors.join("; ")}.`,
    );
  }
  return parsed as ExecutionIsolation;
}
