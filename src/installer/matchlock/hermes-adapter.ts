/**
 * Matchlock Hermes adapter — the standalone descriptor contract.
 *
 * MTLK-HERMES US-001: a self-contained, typed adapter for running a one-shot
 * Hermes chat inside a Matchlock VM. It resolves the effective profile from
 * frozen submission-time inputs, maps it to a stable guest home, asserts the
 * effective terminal backend is guest-local, and exposes typed launch / store /
 * session helpers for the shared controller. It is deliberately narrow: it does
 * not touch the central CLI, shared policy, scheduler, existing native
 * adapters, or the existing usage reader, and it never resolves configuration
 * from the daemon's own environment.
 *
 * MTLK-HERMES-GUARD: the public facade is admission-gated. A refused profile,
 * a config that cannot be read/parsed (unreadable, EISDIR/ENOTDIR, invalid
 * root, malformed YAML, invalid top-level/terminal/backend shapes) or a
 * non-guest-local terminal backend NEVER yields a usable launch descriptor:
 * `launch` stays null and `launchAdmission.ok` is false with a bounded code.
 * Absence of config.yaml is only treated as the built-in default when the
 * selected config root is a valid directory (see hermes-config).
 *
 * Please keep integration wiring and shared-controller consumption in the
 * shared policy/controller modules (owned by the pi run); this module only
 * publishes the descriptor and the pure helpers the controller can call.
 */

import path from "node:path";

import {
  resolveHermesProfile,
  DEFAULT_GUEST_HERMES_ROOT,
  DEFAULT_GUEST_HOME,
  HERMES_PROFILES_DIR,
  DEFAULT_HERMES_PROFILE,
} from "./hermes-profile.js";
import type {
  FrozenHermesSubmissionInput,
  HermesProfilePlan,
  HermesExternalDependency,
} from "./hermes-profile.js";

import { readHermesConfig, assertLocalTerminalBackend, parseHermesConfig } from "./hermes-config.js";
import type {
  ParsedHermesConfig,
  HermesConfigReadResult,
  HermesConfigProblem,
  HermesConfigProblemCode,
  HermesConfigLocation,
  LocalBackendCheck,
} from "./hermes-config.js";

import { buildHermesGuestLaunch } from "./hermes-launch.js";
import type { HermesGuestLaunch, HermesGuestLaunchInput } from "./hermes-launch.js";

import { extractSessionTrailer, stripSessionTrailer } from "./hermes-output.js";
import type { SessionTrailer } from "./hermes-output.js";

import {
  scanHermesStoreTokens,
  storeDirWithinScope,
  computeHermesTokenTotal,
} from "./hermes-store.js";
import type {
  HermesStoreScan,
  HermesStoreScanInput,
  HermesStoreStatus,
  HermesStoreScan as HermesStoreScanResult,
} from "./hermes-store.js";

export {
  // profile
  resolveHermesProfile,
  DEFAULT_GUEST_HERMES_ROOT,
  DEFAULT_GUEST_HOME,
  HERMES_PROFILES_DIR,
  DEFAULT_HERMES_PROFILE,
  // config
  readHermesConfig,
  assertLocalTerminalBackend,
  parseHermesConfig,
  // launch
  buildHermesGuestLaunch,
  // output
  extractSessionTrailer,
  stripSessionTrailer,
  // store
  scanHermesStoreTokens,
  storeDirWithinScope,
  computeHermesTokenTotal,
};

export type {
  FrozenHermesSubmissionInput,
  HermesProfilePlan,
  HermesExternalDependency,
  ParsedHermesConfig,
  HermesConfigReadResult,
  HermesConfigProblem,
  HermesConfigProblemCode,
  HermesConfigLocation,
  LocalBackendCheck,
  HermesGuestLaunch,
  HermesGuestLaunchInput,
  SessionTrailer,
  HermesStoreScan,
  HermesStoreScanInput,
  HermesStoreStatus,
  HermesStoreScanResult,
};

/** Optional inputs that shape the adapter plan (all read-only overrides). */
export interface ResolveHermesAdapterOptions {
  /** Guest launch cwd (worktree/repo path preserved host-identical). */
  guestCwd?: string;
  /** Guest launcher binary basename (default `hermes`). */
  binary?: string;
  /** `--max-turns` (default 8192). */
  maxTurns?: number;
  /** Private guest HOME (default `/root`). */
  guestHome?: string;
  /** Prompt to build the launch descriptor (otherwise `launch` is null). */
  prompt?: string;
  /** Explicit mapped host store dir to validate against the selected scope. */
  storeDir?: string;
}

/** Admission gate summary for the public facade. */
export interface HermesLaunchAdmission {
  /** True only when profile, config read and local backend all admit a launch. */
  ok: boolean;
  /**
   * Bounded primary refusal code when `ok` is false:
   * `profile-refused`, or one of the HermesConfigProblemCode values
   * (unreadable / not-a-file / invalid-root / malformed-yaml /
   * top-level-not-mapping / terminal-not-mapping / terminal-backend-type /
   * terminal-backend-remote / terminal-backend-unknown). Null when admitted.
   */
  code: HermesConfigProblemCode | "profile-refused" | null;
  /** Bounded human summary when refused; never raw config content. */
  reason: string | null;
}

/** The complete standalone descriptor for this run's Hermes adapter. */
export interface HermesAdapterPlan {
  profile: HermesProfilePlan;
  /**
   * Structured read result of the effective `config.yaml`. `absent` (genuine
   * absence under a valid root) and `error` (bounded problem) are never
   * conflated; no failure is represented as a fabricated-null default.
   */
  config: HermesConfigReadResult;
  /**
   * Terminal-backend admission. `ok:true` only when a guest-local backend can
   * be established (absent config under a valid root, unset backend, or
   * explicit "local"). Any config read/parse problem or explicit
   * non-"local" backend is `ok:false` with a bounded code.
   */
  localBackend: LocalBackendCheck;
  /** Guest launch descriptor, or null when no prompt was supplied OR admission refused. */
  launch: HermesGuestLaunch | null;
  /** Whether the optional storeDir is admitted within the selected scope. */
  storeScope: { ok: boolean; reason: string | null };
  /** True when the native CLI would refuse the captured profile selection. */
  selectionRefused: boolean;
  /** Summary gate: refused profile / config problem / non-local backend => no launch. */
  launchAdmission: HermesLaunchAdmission;
  /** Captured host identity the controller must canonicalize/admit (realpath). */
  capturedIdentity: {
    hostHomeRoot: string;
    hostProfilesRoot: string | null;
    hostEffectiveDir: string;
    outsideScope: boolean;
  };
  /** Integration gates the controller/operator must still close. */
  integrationGates: string[];
}

/** Gate list — explicit, never silently implied by this delivery. */
const INTEGRATION_GATES = [
  "Live SQLite/WAL/VMFS cross-VM locking requires real VM proof; synthetic local tests do not prove it.",
  "External profile/auth/skills dependency mounts (siblings, root stores) are controller/operator decisions; this adapter reports, it does not auto-mount.",
  "vaivm-native model validation (deepseek-v4-flash-vision-exp / deepseek, no Codex/MoA) is controller/operator-owned; this adapter reads config read-only.",
  "Guest binary resolution and /workspace/runtime helper-pack mapping are controller-owned (section 6.4).",
  "realpath containment for symlinked profile/store paths is a VFS integration gate; this delivery uses lexical containment.",
];

/**
 * Resolve the complete Hermes adapter plan from frozen submission-time inputs.
 * Never re-reads daemon env — retargeting is impossible after the plan is made.
 *
 * The plan is admission-gated: profile refusal, a bounded config read/parse
 * problem, or a non-guest-local terminal backend all leave `launch` null even
 * when a prompt was supplied, and are classified in `launchAdmission`.
 */
export function resolveHermesAdapterPlan(
  input: FrozenHermesSubmissionInput,
  options: ResolveHermesAdapterOptions = {},
): HermesAdapterPlan {
  const profile = resolveHermesProfile(input);

  // Structured read: absent (valid root, file genuinely missing) vs ok vs
  // bounded error. A read failure is never turned into a "null default".
  const config = readHermesConfig(path.join(profile.hostEffectiveDir, "config.yaml"));

  let localBackend: LocalBackendCheck;
  if (config.status === "error") {
    localBackend = {
      ok: false,
      code: config.problem.code,
      reason: config.problem.detail,
    };
  } else {
    // absent => native built-in defaults (null config); ok => parsed config.
    localBackend = assertLocalTerminalBackend(config.status === "absent" ? null : config.config);
  }

  const profileBlocked = profile.refused;
  const configBlocked = config.status === "error";
  const backendBlocked = !localBackend.ok;
  const admissionOk = !profileBlocked && !configBlocked && !backendBlocked;

  let admissionCode: HermesLaunchAdmission["code"] = null;
  let admissionReason: string | null = null;
  if (profileBlocked) {
    admissionCode = "profile-refused";
    admissionReason = profile.refusedReason ?? "The captured Hermes profile selection is refused.";
  } else if (configBlocked) {
    admissionCode = config.problem.code;
    admissionReason = config.problem.detail;
  } else if (!localBackend.ok) {
    admissionCode = localBackend.code;
    admissionReason = localBackend.reason;
  }

  let launch: HermesGuestLaunch | null = null;
  if (options.prompt !== undefined && admissionOk) {
    launch = buildHermesGuestLaunch({
      profileArg: profile.profile,
      hermesHome: profile.guestHermesHome,
      prompt: options.prompt,
      binary: options.binary,
      guestCwd: options.guestCwd ?? "",
      maxTurns: options.maxTurns,
      guestHome: options.guestHome ?? DEFAULT_GUEST_HOME,
    });
  }

  let storeScope: HermesAdapterPlan["storeScope"] = { ok: true, reason: null };
  if (options.storeDir !== undefined) {
    const admitted =
      profile.isNamedProfile
        ? profile.hostEffectiveDir
        : profile.hostHomeRoot;
    const ok = storeDirWithinScope(options.storeDir, admitted);
    storeScope = ok
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: `storeDir ${options.storeDir} falls outside the admitted profile scope ${admitted}; refusing host-default fallback.`,
        };
  } else {
    storeScope = {
      ok: true,
      reason: "no storeDir supplied; store scope not asserted.",
    };
  }

  return {
    profile,
    config,
    localBackend,
    launch,
    storeScope,
    selectionRefused: profile.refused,
    launchAdmission: {
      ok: admissionOk,
      code: admissionCode,
      reason: admissionReason,
    },
    capturedIdentity: {
      hostHomeRoot: profile.hostHomeRoot,
      hostProfilesRoot: profile.hostProfilesRoot,
      hostEffectiveDir: profile.hostEffectiveDir,
      outsideScope: profile.outsideScope,
    },
    integrationGates: INTEGRATION_GATES,
  };
}
