/**
 * `tamandua matchlock` top-level group and its `setup` subcommand (MTLK-SETUP).
 *
 * The group is a thin CLI surface over the pure installer core
 * (`src/installer/matchlock-setup.ts`): it parses the setup arguments and runs
 * `runMatchlockSetup` with the spawn-capable default seams from
 * `src/installer/matchlock-setup-runner.ts`.
 *
 * Spec: matchlock-setup-command-proposal.md §4.1 / §8.
 */

import {
  parseMatchlockSetupArgs,
  runMatchlockSetup,
} from "../../installer/matchlock-setup.js";
import { createDefaultMatchlockSetupDeps } from "../../installer/matchlock-setup-runner.js";

/** Group-level help for `tamandua matchlock`. */
export function getMatchlockHelp(): string {
  return `tamandua matchlock — Provision matchlock and prepare this host for Matchlock runs

Usage: tamandua matchlock <subcommand>

Subcommands:
  setup        Provision matchlock: binaries, host setup, standard image

Run \`tamandua matchlock setup --help\` for the full phase, flag and platform
documentation, the re-login caveat, the offline (R11) contract and the
admission-refusal relationship.`;
}

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
 * Handles the `matchlock` group. Returns true when the command was handled;
 * false when the group belongs to another handler.
 */
export async function handleMatchlock(group: string, args: string[]): Promise<boolean> {
  if (group !== "matchlock") return false;

  const action = args[1];

  if (action === "setup") {
    const deps = createDefaultMatchlockSetupDeps();
    const parsed = parseMatchlockSetupArgs(args.slice(2));
    if (!parsed.ok) {
      deps.output.warn(parsed.refusal.message);
      process.exitCode = 1;
      return true;
    }

    const result = await runMatchlockSetup(parsed.options, deps);
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

  process.stderr.write(
    action === undefined
      ? "Missing matchlock subcommand.\nUsage: tamandua matchlock setup [flags]\n"
      : `Unknown matchlock action: ${action}\nUsage: tamandua matchlock setup [flags]\n`,
  );
  process.exitCode = 1;
  return true;
}
