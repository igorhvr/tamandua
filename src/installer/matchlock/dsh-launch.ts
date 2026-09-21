/**
 * Matchlock dsh guest-launch construction + controller-owned termination.
 *
 * Launch contract (design section 6.2, verified against the installed CLI
 * 0.1.3-alpha.2 source):
 *
 *   dsh --profile headless <prompt>
 *
 * - stdin is closed immediately; dsh reads the task from argv.
 * - A prompt whose first character is `-` requires TWO `--` separators: the
 *   outer launcher (apps/cli/args.ts) consumes the first `--` and forwards the
 *   remainder verbatim; the headless app's inner commander parse consumes the
 *   second and forces the prompt through as the task operand.
 * - stdout is preserved verbatim (including any final newline/STATUS); it is
 *   plain text, not pi JSON. No `--json`, model, resume or timeout switches
 *   are invented — timeout/cancel is controller-owned.
 * - The image PATH is independent of the host PATH: argv[0] is the guest
 *   binary name (`dsh`), resolved inside the VM by the controller.
 */

import {
  DSH_GUEST_CONFIGURATION_ROOT,
  DSH_GUEST_PERMISSION_MODE,
  DSH_GUEST_PROFILE,
  type DshChildExit,
  type DshGuestLaunchDescriptor,
  type DshGuestLaunchOptions,
  type DshRoundTermination,
} from "./dsh-adapter-contract.js";

/** Build the exact argv for one guest dsh headless round. */
export function buildDshLaunchArgv(
  prompt: string,
  options: { profile?: string; guestBinary?: string } = {},
): string[] {
  if (typeof prompt !== "string") {
    throw new TypeError("dsh launch prompt must be a string");
  }
  const binary = options.guestBinary ?? "dsh";
  const profile = options.profile ?? DSH_GUEST_PROFILE;
  const argv = [binary, "--profile", profile];
  // Two separators: outer launcher + inner headless parser each consume one.
  if (prompt.length > 0 && prompt.startsWith("-")) {
    argv.push("--", "--");
  }
  argv.push(prompt);
  return argv;
}

/**
 * Compose the guest env overrides for one dsh round. `DSH_HOME` and
 * `DSH_PERMISSION_MODE` are unconditional (applied AFTER any extra guest env so
 * nothing can override them). Credential references travel only through the
 * controller's explicit protected launch-input mechanism — this adapter never
 * inherits or forwards host `process.env`.
 */
export function buildDshGuestEnv(
  options: {
    guestHome?: string;
    permissionMode?: string;
    extraGuestEnv?: Record<string, string>;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...(options.extraGuestEnv ?? {}),
  };
  env.DSH_HOME = options.guestHome ?? DSH_GUEST_CONFIGURATION_ROOT;
  env.DSH_PERMISSION_MODE = options.permissionMode ?? DSH_GUEST_PERMISSION_MODE;
  return env;
}

/** Build the complete guest launch descriptor for one dsh round. */
export function buildDshGuestLaunch(
  options: DshGuestLaunchOptions,
): DshGuestLaunchDescriptor {
  const command = buildDshLaunchArgv(options.prompt, {
    profile: options.profile,
    guestBinary: options.guestBinary,
  });
  const env = buildDshGuestEnv({
    guestHome: options.guestHome,
    permissionMode: undefined,
    extraGuestEnv: options.extraGuestEnv,
  });
  const promptLeadingDash = options.prompt.length > 0 && options.prompt.startsWith("-");
  return {
    command,
    env,
    stdin: "close",
    stdout: "verbatim",
    promptLeadingDash,
    summary: command
      .map((part) => (/^-| /.test(part) ? JSON.stringify(part) : part))
      .join(" "),
  };
}

/**
 * Controller-owned round classification. A recorded timeout/cancel ALWAYS wins
 * over child exit forensics: the inspected dsh traps SIGTERM and exits 0, so a
 * clean-looking post-termination `exit 0` must never erase an already recorded
 * timeout/cancellation.
 *
 * @param timedOut true when the controller's wall-clock deadline fired.
 * @param cancelled true when the controller cancelled the round.
 * @param exit child exit forensics (may describe the same round's teardown).
 */
export function classifyDshRoundTermination(options: {
  timedOut: boolean;
  cancelled: boolean;
  exit: DshChildExit;
}): DshRoundTermination {
  if (options.cancelled) return "cancelled";
  if (options.timedOut) return "timed-out";
  if (options.exit.exitCode === 0) return "completed";
  return "failed";
}
