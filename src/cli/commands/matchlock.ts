/**
 * `tamandua matchlock` top-level group and its subcommands.
 *
 * The group exposes `setup` (MTLK-SETUP: a thin CLI surface over the pure
 * installer core in `src/installer/matchlock-setup.ts`) plus the four
 * foreground interactive commands (MTLK-INTERACTIVE US-012):
 *
 *   tamandua matchlock setup        Provision matchlock: binaries, host setup, standard image
 *   tamandua matchlock pi           [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock pi-shell     [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock hermes       [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock hermes-shell [--working-directory-for-harness <dir>] [Matchlock options]
 *
 * The interactive side owns ONLY the group routing, the five `get<Thing>Help`
 * renderers and the hand-off to `parseInteractiveSessionArgs` (US-002). Image
 * selection, resource resolution and allow-private validation stay in the
 * shared installer modules the parser reuses, so the interactive path cannot
 * drift from the workflow path.
 *
 * `handleMatchlock` routes a well-formed invocation through the injectable
 * `runSession` seam. The production default is the US-013 orchestration
 * (`runInteractiveSession`). Tests inject a fake `runSession` so no VM,
 * terminal or real matchlock is touched. The `setup` path keeps the
 * MTLK-SETUP behavior verbatim: it parses the setup arguments and runs
 * `runMatchlockSetup` with the spawn-capable default seams.
 */

import {
  MatchlockResourceLimitError,
  type MatchlockResourceHostProbe,
} from "../../installer/matchlock/resource-limits.js";
import { MatchlockIsolationSettingError } from "../../installer/matchlock/isolation-settings.js";
import {
  runInteractiveSession,
  type RunInteractiveSessionOptions,
} from "../../installer/matchlock/interactive-session-orchestration.js";
import {
  INTERACTIVE_SESSION_SUBCOMMANDS,
  InteractiveSessionArgError,
  parseInteractiveSessionArgs,
  type InteractiveSessionArgs,
  type InteractiveSessionSubcommand,
} from "../matchlock-interactive-args.js";
import { reportUnknownCommand } from "../shared.js";
import {
  parseMatchlockSetupArgs,
  runMatchlockSetup,
} from "../../installer/matchlock-setup.js";
import { createDefaultMatchlockSetupDeps } from "../../installer/matchlock-setup-runner.js";

/** One-line usage synopsis shared by every matchlock error message. */
export const MATCHLOCK_USAGE =
  "tamandua matchlock <pi|pi-shell|hermes|hermes-shell> [--working-directory-for-harness <dir>] [Matchlock options]";

/** Shared option/environment reference block printed by every matchlock help. */
const MATCHLOCK_OPTIONS_HELP = `Options:
  --working-directory-for-harness <dir>
                          Directory mounted read-write at its identical
                          absolute guest path and used as the session working
                          directory (default: the invoking cwd; a relative
                          argument resolves against it and must stay inside it)
  --matchlock-image <ref>
                          Explicit, already-imported image. Overrides
                          TAMANDUA_MATCHLOCK_IMAGE and the built-in standard
                          image; the reference is preserved exactly.
  --matchlock-cpus <N>    VM vCPUs (positive integer)
  --matchlock-memory <MB|Ng>
                          VM memory
  --matchlock-disk <MB|Ng>
                          VM disk size
  --matchlock-swap <MB|Ng>
                          VM swap size (default 8192 MB, capped at 65536 MB)
  --matchlock-no-swap     Disable swap (mutually exclusive with --matchlock-swap)
  --matchlock-allow-private <entry>
                          Allow one private address range; repeatable. CLI
                          entries replace TAMANDUA_MATCHLOCK_ALLOW_PRIVATE.
  --matchlock-no-privileged
                          Create the VM WITHOUT the default whole-VM
                          privilege: in-guest sudo is blocked (standard VM).
                          Env form: TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1.
  --matchlock-prioritize-ipv4-dns-resolution
                          Prefer IPv4 answers from the guest DNS resolver
                          (the default): AAAA records are omitted when the
                          name has an A record.
  --matchlock-prioritize-ipv6-dns-resolution
                          Prefer IPv6 answers (verbatim relay). Wins when
                          both DNS-priority flags are supplied.
                          Env default (unless either flag is supplied):
                          TAMANDUA_MATCHLOCK_DNS_PRIORITY=ipv4|ipv6.
  --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs
                          Acknowledge and allow a root invocation for this
                          session only (session-scoped consent; never inferred
                          from SUDO_UID)
  -h, --help              Show this help

Environment precedence:
  image    --matchlock-image > TAMANDUA_MATCHLOCK_IMAGE > igorhvr/tamandua
  cpus     --matchlock-cpus > TAMANDUA_MATCHLOCK_CPUS
  memory   --matchlock-memory > TAMANDUA_MATCHLOCK_MEMORY_MB
  disk     --matchlock-disk > TAMANDUA_MATCHLOCK_DISK_MB
  swap     --matchlock-no-swap > --matchlock-swap > TAMANDUA_MATCHLOCK_SWAP_MB
           > 8192 MB
  privileged --matchlock-no-privileged > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1
           > default on
  dns-priority --matchlock-prioritize-ipv6-dns-resolution >
           --matchlock-prioritize-ipv4-dns-resolution >
           TAMANDUA_MATCHLOCK_DNS_PRIORITY (exactly "ipv4" or "ipv6") >
           default ipv4

A missing standard image is refused with the remedy \`tamandua matchlock setup\`.
A root invocation is refused before any Matchlock interaction unless the exact
override flag above is supplied. Sessions are foreground and interactive and
have no workflow-round deadline.`;

/** Detailed help for `tamandua matchlock setup`. */
export function getMatchlockSetupHelp(): string {
  return `tamandua matchlock setup — Provision matchlock: binaries, host setup, standard image

Usage: tamandua matchlock setup [flags]

Prepares this host end to end so tamandua can run Matchlock VMs, and warms the
assets a later isolated run needs so it does not need public-internet access.
The command never commits to the tamandua checkout, never installs OS packages,
and never escalates silently: the only privileged step is phase 2's visible
one-time sudo child, always displayed first and bound to the absolute installed
binary (N7). Everything else is user-writable-path only.

Phases (in order):

  1. Binaries (fail-closed)
     Synchronize the committed matchlock submodule
     (git submodule update --init matchlock), verify the exact Go minimum read
     from the synchronized go.mod with GOTOOLCHAIN=local (a missing or too-old
     go is a HARD failure before anything is built, installed or host-mutated),
     build matchlock + guest-init with the repo's pinned recipe (ldflags from
     VERSION.txt + the submodule commit; darwin codesign with the
     virtualization entitlement), and install both side by side into the
     prefix atomically (temp + rename). Idempotent: a re-run at the same commit
     reports "already at <sha>" unless --force. Phase 1 aborts the run.
  2. Host setup (Linux only)
     Run "<absolute installed matchlock> diagnose". When the host is not ready,
     print the exact command and its plain-language effects, then run it with
     inherited stdio: an ordinary user runs
     "sudo <absolute installed matchlock> setup linux"; a process already
     running as root (permitted by the R12 override) runs the absolute binary
     directly. Group-membership changes print the RE-LOGIN caveat below.
     Skipped by --no-host-setup and always skipped on macOS.
  3. Boot assets (image + guest kernel)
     Warn when a locally built/imported image shadows the standard reference
     (the accepted override; it is never deleted or re-tagged), require
     mkfs.erofs on PATH, enforce a 16 GB free-space floor on the image-store
     filesystem, then pull the effective standard image reference
     (igorhvr/tamandua, the host-architecture variant) via
     "matchlock pull [--force] <reference>" and warm the guest kernel with
     "<absolute installed matchlock> kernel pull". Phases 2 and 3 are
     independent: one failing does not block the other.
  4. Verify + report
     Re-run diagnose, report the installed version + commit, the effective
     image digest AND source (registry vs local shadow), the warmed kernel
     version + path (or embedded), the expected daemon binary and any PATH
     shadow warning, stale MATCHLOCK_* overrides, and an explicit
     offline-readiness verdict separating ASSETS from RUNNABILITY.
     --smoke is refused while a re-login is pending.

Flags:
  --latest                     Move the submodule content to the fork's main HEAD
  --ref <sha|tag|branch>       Check out specific submodule content
  --prefix <dir>               Install prefix (absolute; default ~/.local/bin on
                               Linux, /opt/homebrew/bin on macOS)
  --refresh-image              Force-update the standard image from the registry
                               (matchlock pull --force) — the documented update
                               channel for the standard image
  --allow-low-disk-space       Start the pull despite < 16 GB free in the store
  --no-host-setup              Skip the phase-2 sudo host-setup
  --no-image                   Skip only the image pull (the kernel warm still runs)
  --force                      Rebuild/reinstall even when already at the target commit
  --smoke                      Afterwards, boot a minimal --no-network VM as live proof
  --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs
                               Run the user-side phases as root anyway (not recommended);
                               a bare --force never implies this consent

Platform notes:
  Linux (amd64/arm64): all four phases. Default prefix ~/.local/bin. Ongoing
    host state is reported by "matchlock diagnose".
  macOS (Apple Silicon): phases 1, 3 and 4 only; phase 2 prints
    "host setup: not needed on macOS". The build adds the entitlement codesign
    and caches guest-init to ~/.cache/matchlock/guest-init. Default prefix
    /opt/homebrew/bin. A missing macOS SDK is refused with the
    SDKROOT=MacOSX26.5.sdk remedy. Intel macOS is not supported.

RE-LOGIN CAVEAT:
  When phase 2 runs and enrolls the user in the kvm/netdev groups, those group
  memberships take effect only in a NEW login session — VMs cannot run from
  this session until you log out and back in. The verify phase never claims VM
  readiness while a re-login is pending, and it refuses --smoke.

Offline (R11) contract:
  A successful setup leaves the standard image in the local matchlock store and
  the guest kernel warmed for this host, so a later isolated run needs no
  public-internet access on the host. "assets: offline-ready" requires the
  binaries, the image and the kernel; "runnability" is separate and stays
  relogin-required until the new login session exists. Use --refresh-image for
  the standard image update channel.

Admission relationship:
  Run creation never fetches the image. When the standard reference is absent
  from the local matchlock store, admission refuses the run with a typed error
  naming this command:
      Provision this host with: tamandua matchlock setup
  (or pass an explicit already-imported image with --matchlock-image <image>).
  Provisioning is this command's job; tamandua never pulls or builds an image
  at launch.

Running as root:
  tamandua matchlock setup refuses to run its user-side phases as root: the
  per-user binaries and assets would land in root's HOME (~/.local/bin,
  ~/.cache/matchlock) instead of yours. Re-run as your ordinary user. If you
  insist, re-run with
  --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs; the
  report then names the root-owned absolute locations it used.

Examples:
  tamandua matchlock setup
  tamandua matchlock setup --refresh-image
  tamandua matchlock setup --no-host-setup --no-image
  tamandua matchlock setup --ref v0.3.0 --prefix ~/.local/bin`;
}

/**
 * Raised when a well-formed invocation reaches the orchestration seam before
 * the foreground session controller is wired (US-013). It is a clean refusal:
 * no VM is created and nothing is launched.
 */
export class MatchlockSessionUnavailableError extends Error {
  readonly code = "matchlock_session_unavailable";

  constructor() {
    super(
      "Interactive Matchlock sessions are not available in this build " +
        "(provisional gap GAP-09): no VM was created and nothing was launched.",
    );
    this.name = "MatchlockSessionUnavailableError";
  }
}

/**
 * Injectable command surface. Production callers (the CLI dispatcher) rely on
 * the defaults; tests supply a resolved cwd/env/host probe, captured streams
 * and a fake `runSession` so no VM, terminal or real matchlock is touched.
 */
export interface MatchlockCommandDeps {
  /** Invoking directory used for the default/relative working directory. */
  cwd?: string;
  /** Environment snapshot for image/resource/allow-private defaults. */
  env?: Record<string, string | undefined>;
  /** Host capacity probe override (deterministic tests). */
  hostProbe?: MatchlockResourceHostProbe;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
  /**
   * Foreground session orchestration seam (US-013). Receives the fully parsed
   * invocation and resolves to the launched process's exit status.
   */
  runSession?: (args: InteractiveSessionArgs) => Promise<number>;
  /**
   * Injectable options for the production orchestration default (plan /
   * runtime / controller seams). Tests pin admission and controller seams; the
   * `stdout`/`stderr` sinks default to this handler's own sinks so captured
   * output keeps flowing through {@link MatchlockCommandDeps}.
   */
  session?: RunInteractiveSessionOptions;
}

/** Group help listing the five subcommands and the shared option set. */
export function getMatchlockHelp(): string {
  return `tamandua matchlock — Run pi or Hermes in a disposable Matchlock VM

Usage: ${MATCHLOCK_USAGE}

Launch a foreground interactive session inside a fresh, disposable Matchlock
VM. The VM belongs to this invocation only and is removed when the session
ends. Each subcommand accepts the complete shared Matchlock option set.

Subcommands:
  setup         Provision matchlock: binaries, host setup, standard image
  pi            Run the image-provided pi interactive coding harness
  pi-shell      Prepare the same pi guest, then run an interactive zsh
  hermes        Run the image-provided Hermes interactive coding harness
  hermes-shell  Prepare the same Hermes guest, then run an interactive zsh

Run \`tamandua matchlock setup --help\` for the full phase, flag and platform
documentation, the re-login caveat, the offline (R11) contract and the
admission-refusal relationship.

${MATCHLOCK_OPTIONS_HELP}`;
}

/**
 * Render one subcommand's help. The plain variants launch the harness; the
 * `-shell` variants prepare the identical guest and then exec an interactive
 * zsh so the harness can be started by hand inside.
 */
function renderSubcommandHelp(subcommand: InteractiveSessionSubcommand): string {
  const harness = subcommand.startsWith("pi") ? "pi" : "Hermes";
  const plain = subcommand.endsWith("-shell")
    ? subcommand.slice(0, -"-shell".length)
    : subcommand;
  const shell = subcommand.endsWith("-shell");

  const body = shell
    ? `Prepares the guest exactly as \`tamandua matchlock ${plain}\` would (same image
selection and pinning, resources, capability checks, mounts, configuration,
environment, guest user and working directory), then execs an interactive zsh
as the mapped guest user. Invoking ${harness} inside that shell starts the same
session the direct command would have started. An image without a zsh runnable
as the selected user is refused explicitly: no shell is substituted and
nothing is installed.`
    : `Launches the image-provided ${harness} interactive coding harness in normal
interactive mode as the mapped guest user. The guest configuration and the
working directory are mounted read-write at their identical absolute paths.`;

  return `tamandua matchlock ${subcommand} — ${shell ? `Prepare a ${harness} guest and run zsh` : `Run ${harness} in a disposable Matchlock VM`}

Usage: tamandua matchlock ${subcommand} [--working-directory-for-harness <dir>] [Matchlock options]

${body}

${MATCHLOCK_OPTIONS_HELP}`;
}

export function getMatchlockPiHelp(): string {
  return renderSubcommandHelp("pi");
}

export function getMatchlockPiShellHelp(): string {
  return renderSubcommandHelp("pi-shell");
}

export function getMatchlockHermesHelp(): string {
  return renderSubcommandHelp("hermes");
}

export function getMatchlockHermesShellHelp(): string {
  return renderSubcommandHelp("hermes-shell");
}

/** Default orchestration seam: the production foreground session runner. */
async function defaultSessionRunner(
  args: InteractiveSessionArgs,
  deps: MatchlockCommandDeps,
): Promise<number> {
  return runInteractiveSession(args, {
    ...deps.session,
    ...(deps.stdout !== undefined ? { stdout: deps.stdout } : {}),
    ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
  });
}

function isInteractiveSessionSubcommand(
  value: string,
): value is InteractiveSessionSubcommand {
  return (INTERACTIVE_SESSION_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Handle `tamandua matchlock ...`. Returns false for unrelated groups.
 *
 * Unknown subcommands use the repository's shared unknown-command reporter
 * (with a nearest-match suggestion); unknown/invalid options are refused by
 * the shared interactive parser and reported as a non-zero usage error with
 * the exact offending token.
 */
export async function handleMatchlock(
  group: string,
  args: string[],
  deps: MatchlockCommandDeps = {},
): Promise<boolean> {
  if (group !== "matchlock") return false;

  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const action = args[1];

  if (action === undefined) {
    stderr(`Missing matchlock subcommand.\nUsage: ${MATCHLOCK_USAGE}\n`);
    exit(1);
    return true;
  }

  if (action === "setup") {
    const setupDeps = createDefaultMatchlockSetupDeps();
    const parsed = parseMatchlockSetupArgs(args.slice(2));
    if (!parsed.ok) {
      setupDeps.output.warn(parsed.refusal.message);
      process.exitCode = 1;
      return true;
    }

    const result = await runMatchlockSetup(parsed.options, setupDeps);
    if (result.status === "ok") {
      process.stdout.write(`${result.message}\n`);
      return true;
    }
    // Refusals and phase failures are already reported through the warn seam
    // (with the exact remaining manual commands on failure); the non-zero
    // exit code is this handler's only additional duty.
    process.exitCode = 1;
    return true;
  }

  if (!isInteractiveSessionSubcommand(action)) {
    reportUnknownCommand(action, [...INTERACTIVE_SESSION_SUBCOMMANDS], "matchlock");
    return true;
  }

  let parsed: InteractiveSessionArgs;
  try {
    parsed = parseInteractiveSessionArgs(action, args.slice(2), {
      ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.hostProbe !== undefined ? { hostProbe: deps.hostProbe } : {}),
    });
  } catch (error) {
    if (
      error instanceof InteractiveSessionArgError ||
      error instanceof MatchlockResourceLimitError ||
      error instanceof MatchlockIsolationSettingError
    ) {
      stderr(`Error: ${error.message}\nUsage: ${MATCHLOCK_USAGE}\n`);
      exit(1);
      return true;
    }
    throw error;
  }

  const runSession =
    deps.runSession ?? ((parsed: InteractiveSessionArgs) => defaultSessionRunner(parsed, deps));
  let exitCode: number;
  try {
    exitCode = await runSession(parsed);
  } catch (error) {
    if (error instanceof MatchlockSessionUnavailableError) {
      stderr(`Error: ${error.message}\n`);
      exit(1);
      return true;
    }
    throw error;
  }

  if (exitCode !== 0) exit(exitCode);
  return true;
}
