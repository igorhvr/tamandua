/**
 * Matchlock Hermes guest launch construction.
 *
 * MTLK-HERMES US-001: build the exact guest invocation for a one-shot Hermes
 * chat. The guest command is:
 *
 *   hermes --profile <name> chat --max-turns 8192 --yolo -Q -q <prompt>
 *
 * `--profile` is a global option (pre-parsed from argv by the installed CLI),
 * positioned *before* the `chat` subcommand. stdin is closed (EOF), stdout and
 * stderr stay as separate raw streams, and the final `session_id:` trailer is
 * recovered from stderr (see hermes-output). No pi JSON is involved.
 *
 * Pure: given a spec it returns the descriptor; there are no side effects and
 * no dependency on the daemon environment.
 */

import { DEFAULT_GUEST_HOME } from "./hermes-profile.js";

/** Inputs to build the guest launch. */
export interface HermesGuestLaunchInput {
  /** Selected profile id (`default` or a named profile id). */
  profileArg: string;
  /** Guest `HERMES_HOME` value. */
  hermesHome: string;
  /** Prompt text passed via `-q`. */
  prompt: string;
  /** Guest launcher binary basename (default `hermes`). */
  binary?: string;
  /** Explicit guest launch cwd (worktree/repo path preserved host-identical). */
  guestCwd: string;
  /** `--max-turns` value (default 8192 per the Matchlock contract). */
  maxTurns?: number;
  /** Private guest HOME (default `/root`). */
  guestHome?: string;
}

/** The fully-formed guest launch descriptor. */
export interface HermesGuestLaunch {
  binary: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdio: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" };
}

/**
 * Build the guest launch descriptor. `--profile` is positioned before the
 * `chat` subcommand to match the installed CLI's pre-parse profile selection.
 */
export function buildHermesGuestLaunch(
  input: HermesGuestLaunchInput,
): HermesGuestLaunch {
  const binary = input.binary ?? "hermes";
  const maxTurns = input.maxTurns ?? 8192;
  const argv = [
    binary,
    "--profile",
    input.profileArg,
    "chat",
    "--max-turns",
    String(maxTurns),
    "--yolo",
    "-Q",
    "-q",
    input.prompt,
  ];
  const env: Record<string, string> = {
    HERMES_HOME: input.hermesHome,
    HOME: input.guestHome ?? DEFAULT_GUEST_HOME,
  };
  return {
    binary,
    argv,
    env,
    cwd: input.guestCwd,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  };
}
