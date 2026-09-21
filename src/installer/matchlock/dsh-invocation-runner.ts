/**
 * dsh-invocation-runner.ts — MTLK-DSH-EXEC US-002.
 *
 * The dsh Matchlock INVOCATION RUNNER: executes ONE opted-in dsh invocation
 * (probe or work round) in a FRESH Matchlock VM. It deliberately composes the
 * dsh-specific launch semantics (US-001 strategy) on top of the SAME shared
 * invocation lifecycle pi uses (`runMatchlockInvocation`): host-owned
 * HostInvocationRegistry admission → progress-resource attach → versioned RO
 * guest pack validation → FRESH controller per invocation with the persisted
 * image pin → guest bridge service over exec_pipe → scoped host broker over
 * real NativeStepServices (+ host suite wiring when suite-capable) → the
 * guest dsh harness exec → terminal teardown that revokes invocation
 * authority exactly once and positively closes ONLY this invocation's owned
 * VM with a positive close timeout.
 *
 * dsh differences from pi (nothing else differs):
 *   - the guest harness argv is `dsh --profile headless <prompt>` (US-001
 *     launch contract): stdin closed (EOF), plain stdout preserved verbatim
 *     (dsh output is NOT pi JSON), and a leading-dash prompt carries the two
 *     `--` separators the outer launcher and inner headless parser each
 *     consume;
 *   - DSH_HOME and DSH_PERMISSION_MODE are forced guest env values (applied
 *     after any other guest env so nothing overrides them);
 *   - the helper-pack bin is prepended ONLY to the image's declared effective
 *     PATH (persisted `policy.imagePath` at admission), never a conservative
 *     default while the image declares one.
 *
 * Cancellation/EOF/protocol failure revokes even idle invocation authority,
 * late-create after cancel is an owned cleanup obligation, and every owned
 * child/listener/VM close is observed positively (bounded) by the shared
 * runner — a failed/unknown teardown surfaces as a typed error, never green.
 */

import {
  DSH_GUEST_CONFIGURATION_ROOT,
  DSH_GUEST_PERMISSION_MODE,
  type DshGuestLaunchOptions,
} from "./dsh-adapter-contract.js";
import { buildDshLaunchArgv, buildDshGuestEnv } from "./dsh-launch.js";
import {
  runMatchlockInvocation,
  MatchlockRunnerError,
  type MatchlockInvocationKind,
  type MatchlockInvocationResult,
  type RunMatchlockInvocationOptions,
} from "./pi-invocation-runner.js";
import type { ExecutionIsolation } from "./policy.js";

/** Guest launch options consumed by the dsh runner (subset of the shared ones). */
export type RunDshInvocationOptions = Omit<
  RunMatchlockInvocationOptions,
  | "policy"
  | "guestEnvOverrides"
> & {
  /** Persisted version-2 ExecutionIsolation policy with harness "dsh". */
  policy: ExecutionIsolation;
};

/**
 * Run ONE opted-in dsh invocation in a FRESH VM. Throws a typed
 * MatchlockRunnerError when the persisted policy is not a pinned harness
 * "dsh" record (fail closed — never a host/native fallback) or on any
 * invocation infrastructure failure.
 */
export async function runDshInvocation(
  opts: RunDshInvocationOptions,
): Promise<MatchlockInvocationResult> {
  const policy = opts.policy;
  if (policy.harness !== "dsh") {
    throw new MatchlockRunnerError(
      "harness_mismatch",
      `runDshInvocation requires a persisted harness "dsh" Matchlock policy (got harness ${JSON.stringify(
        policy.harness,
      )}); refusing to launch dsh work through a non-dsh policy.`,
    );
  }
  if (!policy.resolvedImageDigest || !policy.resolvedImageConfigDigest) {
    throw new MatchlockRunnerError(
      "image_identity_required",
      "Persisted dsh Matchlock policy does not carry the required immutable image content/config pin; refusing to invoke (legacy/unpinned record).",
    );
  }

  // Guest dsh launch argv (US-001): `dsh --profile headless <prompt>` with
  // the two-separator rule for leading-dash prompts. The shared runner
  // appends the (quoted) prompt text itself, so only the prefix is handed as
  // harnessArgv.
  const launchOptions: DshGuestLaunchOptions = {
    prompt: opts.promptText,
    ...(policy.configurationProfile ? { profile: policy.configurationProfile } : {}),
  };
  const fullArgv = buildDshLaunchArgv(launchOptions.prompt, {
    profile: launchOptions.profile,
    guestBinary: undefined,
  });
  const harnessArgv = fullArgv.slice(0, -1);

  // Forced dsh guest env: DSH_HOME = the RW config mount and the guest
  // sandbox mode INSIDE isolation. Merged last (via the shared runner's
  // guest-env composition) so nothing can override them.
  const guestEnvOverrides = buildDshGuestEnv({
    guestHome: policy.guestConfigurationRoot ?? DSH_GUEST_CONFIGURATION_ROOT,
    permissionMode: DSH_GUEST_PERMISSION_MODE,
  });

  return runMatchlockInvocation({
    ...opts,
    policy,
    harnessArgv,
    // The helper-pack bin is prepended ONLY to the image's declared PATH
    // (captured at admission). When the image declares none, opts.imagePath
    // (or the shared runner's conservative default) applies at launch.
    imagePath: opts.imagePath ?? policy.imagePath ?? undefined,
    guestEnvOverrides,
  });
}

export type { MatchlockInvocationKind, MatchlockInvocationResult };

// Re-export the typed infra error so the scheduler/dsh seam force-fails typed
// infrastructure failures distinctly from normal failed guest rounds.
export { MatchlockRunnerError };
