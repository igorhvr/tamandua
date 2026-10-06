/**
 * MTLK-INTERACTIVE (US-007) — interactive Hermes selection resolution.
 *
 * `resolveInteractiveHermesSelection` wires an interactive `hermes` /
 * `hermes-shell` session through the SAME frozen-submission Hermes machinery the
 * shipped one-shot runner uses: the effective profile and configuration
 * directory are resolved with `resolveHermesAdapterPlan`, which delegates
 * profile resolution to `resolveHermesProfile`, from the frozen
 * `{ homeDir, HERMES_HOME snapshot, cwd }` inputs only. The interactive plan
 * then admits through the hermes branch of `admitMatchlockRun` (in
 * `interactive-session-plan.ts`).
 *
 * The resolver turns the adapter descriptor into either a resolved selection or
 * a typed fail-closed refusal, BEFORE any image RPC / admission / VM create:
 *
 *   - refused profile (invalid/deleted/missing native selection)
 *       -> `interactive_hermes_selection_refused`;
 *   - non-local terminal backend, or an unreadable / malformed / non-regular
 *     effective `config.yaml`
 *       -> `interactive_hermes_selection_refused` (the adapter's bounded code);
 *   - effective configuration directory missing or not a directory, or a
 *     selection that escapes the admitted home root
 *       -> `interactive_hermes_config_unavailable`;
 *   - a REQUIRED external dependency reported by the adapter
 *       -> `interactive_hermes_external_dependency_unsupported`. The resolver
 *          NEVER auto-mounts or broadens the mount scope to compensate;
 *          neighboring (`required:false`) entries are reported but ignored.
 *
 * The entire effective Hermes configuration directory is mounted RW at the
 * approved guest HERMES_HOME by the interactive create-config builder
 * (`policy.configurationRoot` -> `policy.guestConfigurationRoot`); this module
 * only resolves and validates the selection, it plans no mounts. It imports
 * only the pure Hermes adapter/profile modules (no `child_process`), so it stays
 * in the parallel test lane.
 */

import fs from "node:fs";

import {
  resolveHermesAdapterPlan,
  type HermesExternalDependency,
} from "./hermes-adapter.js";

/** Typed refusal: the frozen Hermes selection is refused (profile/backend/config). */
export const INTERACTIVE_HERMES_SELECTION_REFUSED_CODE =
  "interactive_hermes_selection_refused" as const;

/** Typed refusal: the effective Hermes configuration directory is unavailable. */
export const INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE =
  "interactive_hermes_config_unavailable" as const;

/** Typed refusal: a REQUIRED external dependency is unsupported/unmounted. */
export const INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE =
  "interactive_hermes_external_dependency_unsupported" as const;

/** Typed, actionable refusal for an interactive Hermes selection failure. */
export class InteractiveHermesSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InteractiveHermesSelectionError";
    this.code = code;
  }
}

/**
 * FROZEN submission-time inputs captured at run creation. Identical in shape to
 * `HermesAdmissionSubmission`, so the resolved selection and the admission
 * `submission` cannot drift.
 */
export interface InteractiveHermesSubmission {
  homeDir: string;
  cwd: string;
  hermesHomeEnv: string | null;
}

/**
 * Structural subset of {@link HermesProfilePlan} the interactive resolver reads.
 * The shipped plan is assignable to it; tests may supply a minimal fake.
 */
export interface InteractiveHermesProfileSource {
  profile: string;
  isNamedProfile: boolean;
  hostEffectiveDir: string;
  guestHermesHome: string;
  guestProfilesRoot: string;
  externalDependencies: HermesExternalDependency[];
  outsideScope: boolean;
  outsideScopeReason: string | null;
  refused: boolean;
  refusedReason: string | null;
}

/**
 * Structural subset of {@link HermesAdapterPlan} the interactive resolver
 * reads. The shipped `resolveHermesAdapterPlan` result is assignable to it.
 */
export interface InteractiveHermesAdapterSource {
  profile: InteractiveHermesProfileSource;
  capturedIdentity: { hostEffectiveDir: string };
  selectionRefused: boolean;
  launchAdmission: {
    ok: boolean;
    code: string | null;
    reason: string | null;
  };
}

/** Resolved, admitted interactive Hermes selection. */
export interface InteractiveHermesSelection {
  /** Selected profile id (`default` or a named profile). */
  profile: string;
  isNamedProfile: boolean;
  /** Exact host directory mounted whole RW (the effective selected profile). */
  hostEffectiveDir: string;
  /** Approved guest `HERMES_HOME` mapping (the mount destination). */
  guestHermesHome: string;
  /** Guest `<root>/profiles` directory. */
  guestProfilesRoot: string;
  /** Frozen `HERMES_HOME` snapshot used for resolution (null when unset). */
  hermesHomeEnv: string | null;
  /** Every outside-scope entry reported by the adapter (never auto-mounted). */
  externalDependencies: HermesExternalDependency[];
}

/** Injectable inputs for deterministic tests; production callers omit these. */
export interface ResolveInteractiveHermesSelectionOptions {
  /** Injected adapter plan (tests); defaults to `resolveHermesAdapterPlan`. */
  adapterPlan?: InteractiveHermesAdapterSource;
  /** Injected directory probe (tests); defaults to `fs.statSync`. */
  isDirectory?: (p: string) => boolean;
}

/** True when `p` is an existing directory (never throws). */
function defaultIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Build the adapter's frozen input shape from the frozen submission snapshot. */
function toFrozenInput(submission: InteractiveHermesSubmission): {
  homeDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
} {
  return {
    homeDir: submission.homeDir,
    cwd: submission.cwd,
    env:
      submission.hermesHomeEnv !== null && submission.hermesHomeEnv !== undefined
        ? { HERMES_HOME: submission.hermesHomeEnv }
        : {},
  };
}

/**
 * Resolve and validate the effective interactive Hermes selection from FROZEN
 * submission inputs. Throws {@link InteractiveHermesSelectionError} on any
 * fail-closed rule; never auto-mounts, broadens or substitutes.
 */
export function resolveInteractiveHermesSelection(
  submission: InteractiveHermesSubmission,
  options: ResolveInteractiveHermesSelectionOptions = {},
): InteractiveHermesSelection {
  if (
    !submission ||
    typeof submission.homeDir !== "string" ||
    submission.homeDir.trim() === "" ||
    typeof submission.cwd !== "string" ||
    submission.cwd.trim() === ""
  ) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_SELECTION_REFUSED_CODE,
      "Refusing an interactive Hermes session: the FROZEN submission inputs (homeDir + HERMES_HOME snapshot + cwd) captured at run creation are required; " +
        "the Hermes selection is never resolved from ambient daemon HOME/env state.",
    );
  }

  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const plan =
    options.adapterPlan ??
    resolveHermesAdapterPlan(toFrozenInput(submission));

  const profile = plan.profile;

  // 1. A refused native profile selection (invalid/deleted/missing).
  if (plan.selectionRefused || profile.refused) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_SELECTION_REFUSED_CODE,
      `Refusing an interactive Hermes session: the frozen selection for profile "${profile.profile}" is refused` +
        (profile.refusedReason ? ` (${profile.refusedReason})` : "") +
        ". Resolve the profile selection before launching; Tamandua never substitutes a different profile or a fabricated default.",
    );
  }

  // 2. The ENTIRE effective configuration directory must exist and be a
  //    directory: it is mounted whole RW at the approved guest HERMES_HOME.
  const hostEffectiveDir = plan.capturedIdentity.hostEffectiveDir;
  if (
    typeof hostEffectiveDir !== "string" ||
    hostEffectiveDir.trim() === "" ||
    !isDirectory(hostEffectiveDir)
  ) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE,
      `Refusing an interactive Hermes session: the effective Hermes configuration directory "${hostEffectiveDir}" is missing or not a directory. ` +
        `The ENTIRE effective Hermes configuration directory must be mounted read-write at the approved guest HERMES_HOME "${profile.guestHermesHome}"; ` +
        "refusing to substitute an image default or broaden the mount scope. Create/supply the directory (or set HERMES_HOME) and retry.",
    );
  }

  // 3. Non-local terminal backend or an unreadable/malformed config. The
  //    adapter refuses these before any VM create; the interactive plan keeps
  //    the bounded code in the refusal.
  if (!plan.launchAdmission.ok) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_SELECTION_REFUSED_CODE,
      `Refusing an interactive Hermes session: the effective Hermes configuration did not admit a guest-local terminal backend` +
        (plan.launchAdmission.code ? ` (${plan.launchAdmission.code})` : "") +
        `: ${plan.launchAdmission.reason ?? "no launch admission"}. ` +
        "Matchlock requires a guest-local terminal backend and never rewrites the live configuration to hide an incompatibility.",
    );
  }

  // 4. A selection that escapes the admitted home root would require a broader
  //    mount; refuse instead of broadening.
  if (profile.outsideScope) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE,
      `Refusing an interactive Hermes session: the effective profile "${profile.profile}" resolves outside the admitted home root (${hostEffectiveDir}).` +
        (profile.outsideScopeReason ? ` ${profile.outsideScopeReason}` : "") +
        " Refusing to broaden the mount scope to compensate.",
    );
  }

  // 5. A REQUIRED external dependency is never auto-mounted or broadened.
  const dependencies = profile.externalDependencies ?? [];
  const required = dependencies.filter((dep) => dep.required);
  if (required.length > 0) {
    throw new InteractiveHermesSelectionError(
      INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
      `Refusing an interactive Hermes session: the selected profile "${profile.profile}" requires unsupported external ` +
        `dependencies (${required.map((dep) => `${dep.kind}:${dep.name}`).join(", ")}) that live outside the effective configuration directory. ` +
        "Tamandua never auto-mounts or broadens the mount scope to compensate; provide the dependency inside the effective profile or refuse the selection.",
    );
  }

  return {
    profile: profile.profile,
    isNamedProfile: profile.isNamedProfile,
    hostEffectiveDir,
    guestHermesHome: profile.guestHermesHome,
    guestProfilesRoot: profile.guestProfilesRoot,
    hermesHomeEnv: submission.hermesHomeEnv ?? null,
    externalDependencies: [...dependencies],
  };
}
