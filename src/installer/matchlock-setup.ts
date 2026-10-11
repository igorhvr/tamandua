/**
 * Pure core for `tamandua matchlock setup` (MTLK-SETUP).
 *
 * This module deliberately does NOT import `node:child_process`: every process
 * interaction goes through the injected `RunCommand` seam so the unit test stays
 * in the PARALLEL lane (spec N5). The spawn-capable default wiring lives in a
 * separate module added by a later story.
 *
 * `runMatchlockSetup` sequences R12 preflight → N7 absolute-path binding → R8
 * prerequisite gates → R9 phase-1 submodule sync (N3: never stages or commits)
 * → the Go-minimum gate against the synchronized go.mod (`GOTOOLCHAIN=local`)
 * → R7 idempotency (an installed binary pair already at the target commit is a
 * no-op unless `--force`) → the pinned R2 build recipe (matchlock + guest-init,
 * darwin codesign) → the R3 atomic install into the resolved prefix (temp +
 * rename, non-writable prefix refused with remedies and never a silent sudo)
 * → R4 phase 2 host setup on linux (the absolute installed path is
 * `diagnose`d; when not ready the identity-selected `sudo <abs> setup linux`
 * child runs with inherited stdio and the re-login caveat is surfaced).
 * Phase 3's boot assets then run: the image portion (R5) is a shadow warning
 * for a local built/imported entry, the `mkfs.erofs` gate, the 16 GB
 * disk-space floor and a cache-aware `matchlock pull [--force] <effective
 * reference>`; the guest-kernel warm (R11) invokes the additive
 * `<abs> kernel pull` through the same runner, records the resolved
 * version/path, and treats an unknown command as an older pin with a
 * pin/update remedy. `--no-image` skips only the pull. Phase 4 (R6) closes the
 * run: it re-runs `diagnose`, reports the installed version/commit, the
 * effective image digest and source, the warmed kernel (or `embedded`), then
 * the explicit R11 offline-readiness verdict separating ASSETS (`assets:
 * offline-ready` only when image + kernel + binaries are all present) from
 * RUNNABILITY (a pending re-login leads the report and refuses `--smoke`,
 * which otherwise boots a minimal `--no-network` VM). It also owns the N7
 * post-install checks: capabilities are re-verified on the file just installed
 * (a missing capability fails verify with the identity-selected bound fix), the
 * binary the daemon is EXPECTED to resolve is named (labelled expected, never
 * verified) with a PATH-shadowing warning, and stale MATCHLOCK_* environment
 * overrides are reported.
 *
 * Spec: matchlock-setup-command-proposal.md
 * (sha256 b9c908be8c52b0adce1aacff4fa3dd4a1ec924b8e86bc45566ed0b0ab4f3d8ea).
 */

import { delimiter, dirname, isAbsolute, join } from "node:path";
import { STANDARD_MATCHLOCK_IMAGE } from "./matchlock/standard-image.js";

/**
 * Standard Matchlock image reference pulled in phase 3 — tamandua-48v
 * consolidation: the literal is declared exactly ONCE, in the sibling
 * src/installer/matchlock/standard-image.ts (the iso line's canonical module),
 * and both lines resolve it through this alias. Previously each line declared
 * its own byte-equal copy; a crossline parity guard pinned them together until
 * this consolidation landed.
 */
export const STANDARD_IMAGE_REFERENCE = STANDARD_MATCHLOCK_IMAGE;

/**
 * Environment variable that overrides the effective standard image reference.
 */
export const MATCHLOCK_IMAGE_ENV_NAME = "TAMANDUA_MATCHLOCK_IMAGE";

/**
 * R12 override flag: permit running the user-side phases as root (not
 * recommended, per matchlock's own docs). A bare `--force` never implies it.
 */
export const ROOT_OVERRIDE_FLAG =
  "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs";

/**
 * Default installed-prefix on macOS (Apple Silicon).
 */
export const DARWIN_DEFAULT_PREFIX = "/opt/homebrew/bin";

/**
 * Architectures `matchlock setup` supports on Linux (R10). `x64` is Node's
 * spelling; `amd64` is Go's, and either may arrive through a seam.
 */
export const SUPPORTED_LINUX_ARCHES: readonly string[] = ["x64", "amd64", "arm64"];

/** Architectures `matchlock setup` supports on macOS (R10: arm64 only). */
export const SUPPORTED_DARWIN_ARCHES: readonly string[] = ["arm64"];

/** Registered submodule name and path inside the tamandua checkout (R1/R8). */
export const MATCHLOCK_SUBMODULE_NAME = "matchlock";

/**
 * Expected `origin` URL of the committed `matchlock` submodule (R1/R9). The
 * `--url` test hook overrides it; production always uses this fork.
 */
export const MATCHLOCK_FORK_URL = "https://github.com/igorhvr/matchlock.git";

/**
 * Bounded timeout for git submodule operations, including the network fetch
 * used by `--ref`/`--latest` (R9/N5).
 */
export const SUBMODULE_COMMAND_TIMEOUT_MS = 5 * 60_000;

/**
 * SDKROOT note printed by the darwin SDK refusal (R8 / §4.3), verbatim from the
 * spec's example so operators see the exact expected bundle-name shape.
 */
export const SDKROOT_NOTE = "SDKROOT=MacOSX26.5.sdk";

/**
 * Maximum rendered length of a single setup warning line (N6, bounded
 * one-line stderr messages).
 */
export const MAX_SETUP_WARNING_LENGTH = 240;

/** A value a seam may produce synchronously or as a promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Result of one injected command invocation. */
export interface RunCommandResult {
  /** Process exit code. */
  code: number;
  /** Captured stdout (empty for inherited stdio). */
  stdout: string;
  /** Captured stderr (empty for inherited stdio). */
  stderr: string;
}

/** Options for one injected command invocation. */
export interface RunCommandOptions {
  /** Working directory for the child. */
  cwd?: string;
  /** Environment additions/overrides for the child. */
  env?: Record<string, string | undefined>;
  /** "pipe" captures output; "inherit" wires the child to this process. */
  stdio?: "pipe" | "inherit";
  /** Bounded timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional stdin payload. */
  input?: string;
}

/**
 * Injected command runner. Resolves with the process result; it throws ONLY
 * when the binary cannot be spawned at all (ENOENT/EACCES), never for a
 * non-zero exit code.
 */
export type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => MaybePromise<RunCommandResult>;

/** Injected filesystem probes and mutations used by the installer. */
export interface MatchlockSetupFs {
  exists(path: string): MaybePromise<boolean>;
  isFile(path: string): MaybePromise<boolean>;
  /** True when `path` is an existing executable (X_OK analog). */
  isExecutable(path: string): MaybePromise<boolean>;
  isWritableDir(path: string): MaybePromise<boolean>;
  readTextFile(path: string): MaybePromise<string>;
  writeFile(path: string, contents: string): MaybePromise<void>;
  /** Copies a file (binary-safe) from one absolute path to another. */
  copyFile(from: string, to: string): MaybePromise<void>;
  rename(from: string, to: string): MaybePromise<void>;
  remove(path: string): MaybePromise<void>;
  mkdirp(path: string): MaybePromise<void>;
  realpath(path: string): MaybePromise<string>;
  readDir(path: string): MaybePromise<string[]>;
  freeSpaceBytes(path: string): MaybePromise<number>;
}

/** Scope of an entry in the local matchlock image store (matchlock `scope`). */
export type StoredImageSource = "local" | "registry";

/**
 * A resolved entry in the local matchlock image store. `local` is a built or
 * imported image that SHADOWS the registry cache for the same reference and is
 * the accepted operator override (R5/R6); `registry` is the pulled cache copy.
 */
export interface StoredImageEntry {
  /** Content digest, e.g. `sha256:<hex>`. */
  digest: string;
  /** Which store scope resolved the reference. */
  source: StoredImageSource;
}

/** Injected output seam (`stdout`/`stderr` analog). */
export interface SetupOutput {
  log(message: string): void;
  warn(message: string): void;
}

/** A typed, non-throwing refusal surfaced to the caller. */
export interface SetupRefusal {
  code: string;
  message: string;
}

/** A non-fatal warning (N6: omitted from results when there are none). */
export interface SetupWarning {
  code: string;
  message: string;
}

/** Parsed `tamandua matchlock setup` options. */
export interface MatchlockSetupOptions {
  /** `--latest`: move submodule content to the fork's main HEAD. */
  latest: boolean;
  /** `--ref <sha|tag|branch>`: check out specific submodule content. */
  ref?: string;
  /** `--prefix <dir>`: install location (absolute; defaults per platform). */
  prefix?: string;
  /** `--refresh-image`: force an image re-pull. */
  refreshImage: boolean;
  /** `--allow-low-disk-space`: start the pull below the 16 GB floor. */
  allowLowDiskSpace: boolean;
  /** `--no-host-setup`: skip phase 2. */
  noHostSetup: boolean;
  /** `--no-image`: skip only the image pull (kernel warm still runs). */
  noImage: boolean;
  /** `--force`: rebuild/reinstall even when already at the target commit. */
  force: boolean;
  /** `--smoke`: opt-in minimal `--no-network` VM after verify. */
  smoke: boolean;
  /** R12 override: permit running the user-side phases as root. */
  forceMatchlockUsageAsRoot: boolean;
  /** `--url <url>`: test hook overriding the expected fork URL. */
  url?: string;
}

/**
 * Injected seams for `runMatchlockSetup`. Everything platform-, process-,
 * environment- and identity-specific is injected so the core stays pure.
 */
export interface MatchlockSetupDeps {
  /** Process execution seam (argv arrays only; never a shell string). */
  runCommand: RunCommand;
  /** Filesystem probes and mutations. */
  fs: MatchlockSetupFs;
  /**
   * Read-only image-store probe (R5/R6): resolve `reference` to its stored
   * digest and scope. A `local` entry is a built/imported image that shadows
   * the registry cache; `undefined` is a store miss. It never touches the
   * network and never mutates the store.
   */
  resolveStoredImage(reference: string): MaybePromise<StoredImageEntry | undefined>;
  /** Host platform, e.g. "linux" or "darwin". */
  platform: string;
  /** Host CPU architecture, e.g. "x64" or "arm64". */
  arch: string;
  /**
   * Resolved tamandua source checkout root (the git worktree that holds the
   * registered `matchlock` submodule). Defaults to `resolveSourcePath()` in the
   * spawn-capable wiring.
   */
  sourcePath: string;
  /** Environment map (process.env analog). */
  env: Record<string, string | undefined>;
  /** Effective user id (R12 root gate). */
  euid: number;
  /**
   * Resolves an account's home from the account database (passwd analog).
   * Used instead of an inherited `HOME` under forced-root mode (R12).
   */
  accountHomeResolver(account: string): string | undefined;
  /** Output seam. */
  output: SetupOutput;
}

/** Absolute paths the run is bound to (N7). */
export interface MatchlockEffectivePaths {
  /** Effective account whose home is being provisioned ("root" under R12). */
  account: string;
  /** Effective account home (from the account database under forced root). */
  home: string;
  /** Install prefix for the binary pair. */
  prefix: string;
  /** `~/.cache/matchlock`. */
  cacheDir: string;
  /** `~/.cache/matchlock/images` (matchlock image store, N4). */
  imageStore: string;
  /** `~/.cache/matchlock/kernels`. */
  kernelCache: string;
  /** Absolute installed matchlock path (N7). */
  matchlockPath: string;
  /** Absolute installed guest-init path (N7). */
  guestInitPath: string;
}

/** Per-phase outcome reported by the orchestrator. */
export type SetupPhaseStatus = "ok" | "failed" | "skipped" | "not-run";

/** One phase's outcome. */
export interface SetupPhaseOutcome {
  /** 1 = binaries, 2 = host setup, 3 = boot assets, 4 = verify. */
  phase: number;
  /** Stable phase name: binaries | host-setup | boot-assets | verify. */
  name: string;
  /** Outcome status. */
  status: SetupPhaseStatus;
  /** Human-readable one-line summary. */
  message: string;
  /** Optional structured detail for the verify report. */
  details?: Record<string, unknown>;
}

/** Overall result status. */
export type MatchlockSetupStatus = "ok" | "refused" | "failed";

/** Result of `runMatchlockSetup`. */
export interface MatchlockSetupResult {
  /** Overall outcome; refusals are never warnings (N6). */
  status: MatchlockSetupStatus;
  /** Per-phase outcomes (empty before phases are implemented). */
  phases: SetupPhaseOutcome[];
  /** Warnings, omitted entirely when there are none (N6). */
  warnings?: SetupWarning[];
  /** True when phase 2 executed and a fresh login is required (R4). */
  reloginRequired: boolean;
  /** Effective absolute paths, or null when refused before resolution. */
  effective: MatchlockEffectivePaths | null;
  /** Typed refusal when status is "refused". */
  refusal?: SetupRefusal;
  /** Typed hard failure when status is "failed" (R8's unconditional gate). */
  failure?: PrerequisiteFailure;
  /**
   * True when R7 idempotency detected the target commit already installed and
   * skipped the build/install (omitted otherwise, mirroring the warnings shape).
   */
  idempotent?: boolean;
  /**
   * The exact manual commands that finish setup after a failure (N1/N7),
   * omitted when there are none. Every entry binds to the ABSOLUTE installed
   * path and the host-setup entry is selected by effective identity (sudo only
   * for a non-root caller).
   */
  remainingCommands?: string[];
  /** Human-readable one-line summary. */
  message: string;
}

/** Result of parsing setup args: parsed options or a typed refusal. */
export type ParseMatchlockSetupArgsResult =
  | { ok: true; options: MatchlockSetupOptions }
  | { ok: false; refusal: SetupRefusal };

type BooleanFlagKey =
  | "latest"
  | "refreshImage"
  | "allowLowDiskSpace"
  | "noHostSetup"
  | "noImage"
  | "force"
  | "smoke"
  | "forceMatchlockUsageAsRoot";

const BOOLEAN_FLAGS: Record<string, BooleanFlagKey> = {
  "--latest": "latest",
  "--refresh-image": "refreshImage",
  "--allow-low-disk-space": "allowLowDiskSpace",
  "--no-host-setup": "noHostSetup",
  "--no-image": "noImage",
  "--force": "force",
  "--smoke": "smoke",
  [ROOT_OVERRIDE_FLAG]: "forceMatchlockUsageAsRoot",
};

const VALUE_FLAGS: Record<string, "ref" | "prefix" | "url"> = {
  "--ref": "ref",
  "--prefix": "prefix",
  "--url": "url",
};

const USAGE_HINT = "Run `tamandua matchlock setup --help` for usage.";

function defaultOptions(): MatchlockSetupOptions {
  return {
    latest: false,
    refreshImage: false,
    allowLowDiskSpace: false,
    noHostSetup: false,
    noImage: false,
    force: false,
    smoke: false,
    forceMatchlockUsageAsRoot: false,
  };
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parses `tamandua matchlock setup` arguments.
 *
 * Never throws: missing values, positional arguments and unknown flags are
 * returned as a typed `SetupRefusal` that `runMatchlockSetup` surfaces.
 */
export function parseMatchlockSetupArgs(
  args: readonly string[],
): ParseMatchlockSetupArgsResult {
  const options = defaultOptions();

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--") {
      const rest = args.slice(i + 1);
      if (rest.length > 0) {
        return {
          ok: false,
          refusal: {
            code: "unexpected-argument",
            message:
              `matchlock setup: unexpected argument "${rest[0]}". ` +
              `This command takes flags only. ${USAGE_HINT}`,
          },
        };
      }
      break;
    }

    const booleanKey = token.startsWith("--=") ? undefined : BOOLEAN_FLAGS[token];
    if (booleanKey !== undefined) {
      options[booleanKey] = true;
      continue;
    }

    let name = token;
    let inlineValue: string | undefined;
    const equalsAt = token.indexOf("=");
    if (token.startsWith("--") && equalsAt > 2) {
      name = token.slice(0, equalsAt);
      inlineValue = token.slice(equalsAt + 1);
    }

    const valueKey = VALUE_FLAGS[name];
    if (valueKey !== undefined) {
      let value = inlineValue;
      if (value === undefined) {
        value = args[i + 1];
        if (value === undefined) {
          return {
            ok: false,
            refusal: {
              code: "missing-value",
              message: `matchlock setup: option ${name} requires a value. ${USAGE_HINT}`,
            },
          };
        }
        i += 1;
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        return {
          ok: false,
          refusal: {
            code: "missing-value",
            message: `matchlock setup: option ${name} requires a non-empty value. ${USAGE_HINT}`,
          },
        };
      }
      options[valueKey] = trimmed;
      continue;
    }

    if (token.startsWith("-")) {
      return {
        ok: false,
        refusal: {
          code: "unknown-flag",
          message: `matchlock setup: unknown option "${token}". ${USAGE_HINT}`,
        },
      };
    }

    return {
      ok: false,
      refusal: {
        code: "unexpected-argument",
        message:
          `matchlock setup: unexpected argument "${token}". ` +
          `This command takes flags only. ${USAGE_HINT}`,
      },
    };
  }

  return { ok: true, options };
}

/** Returns the default install prefix for a platform. */
export function defaultPrefixForPlatform(platform: string, home: string): string {
  if (platform === "darwin") return DARWIN_DEFAULT_PREFIX;
  return join(home, ".local", "bin");
}

/** Input for the N7 absolute-path helper. */
export interface ResolveMatchlockPathsInput {
  platform: string;
  account: string;
  home: string;
  prefix?: string;
}

/**
 * Derives the absolute paths every phase is bound to (N7). Defaults:
 * `~/.local/bin` (linux) / `/opt/homebrew/bin` (darwin); `--prefix` overrides.
 */
export function resolveMatchlockPaths(
  input: ResolveMatchlockPathsInput,
): MatchlockEffectivePaths {
  const home = input.home;
  const prefix = nonEmpty(input.prefix) ?? defaultPrefixForPlatform(input.platform, home);
  const cacheDir = join(home, ".cache", "matchlock");
  return {
    account: input.account,
    home,
    prefix,
    cacheDir,
    imageStore: join(cacheDir, "images"),
    kernelCache: join(cacheDir, "kernels"),
    matchlockPath: join(prefix, "matchlock"),
    guestInitPath: join(prefix, "guest-init"),
  };
}

/**
 * Environment overlay for EVERY phase child process (R12/N1/N4): the inherited
 * environment with `HOME` forced to the EFFECTIVE account home. Under
 * forced-root mode the inherited `HOME` may name another user, and matchlock
 * derives its image store / kernel cache from `$HOME/.cache/matchlock` (and Go
 * its build cache from the home), so the effective home — never an inherited
 * one — is what every child (build, install staging, `pull`, kernel warm,
 * `diagnose`/`version`/`getcap` and `--smoke`) must see. `--prefix` still
 * governs the install location independently of `HOME`.
 */
export function matchlockChildEnv(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Record<string, string | undefined> {
  return { ...deps.env, HOME: effective.home };
}

/**
 * Wraps the injected runner so every child it spawns carries the effective
 * home/store/cache context (R12/N1), while per-call overrides (e.g.
 * `GOTOOLCHAIN=local`, `GOOS`/`GOARCH`) are preserved. The effective `HOME`
 * always wins, so a forced-root run can never inherit another user's home.
 */
function applyEffectiveEnv(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): MatchlockSetupDeps {
  return {
    ...deps,
    runCommand: (command, args, options) =>
      deps.runCommand(command, args, {
        ...options,
        env: {
          ...deps.env,
          ...(options?.env ?? {}),
          ...matchlockChildEnv(deps, effective),
        },
      }),
  };
}

/** Rendering/collection helpers for N6 warnings. */
export function formatSetupWarning(
  warning: SetupWarning,
  maxLength: number = MAX_SETUP_WARNING_LENGTH,
): string {
  const prefix = `matchlock setup: warning [${warning.code}]: `;
  const collapsed = warning.message.replace(/\s+/g, " ").trim();
  const available = Math.max(0, maxLength - prefix.length);
  const bounded =
    collapsed.length > available
      ? `${collapsed.slice(0, Math.max(0, available - 3))}...`
      : collapsed;
  return `${prefix}${bounded}`;
}

/**
 * Builds the optional `warnings` field: present only when there is at least
 * one warning, so JSON projections omit the key when empty (N6).
 */
export function warningsField(
  warnings: readonly SetupWarning[],
): { warnings?: SetupWarning[] } {
  return warnings.length > 0 ? { warnings: [...warnings] } : {};
}

/** Renders each warning as a bounded one-line message on the warn seam (N6). */
export function emitSetupWarnings(
  output: SetupOutput,
  warnings: readonly SetupWarning[],
): void {
  for (const warning of warnings) {
    output.warn(formatSetupWarning(warning));
  }
}

/* -------------------------------------------------------------------------- */
/* R8 prerequisite gates (pre-mutation, pre-content-sync)                      */
/* -------------------------------------------------------------------------- */

/** A prerequisite gate outcome that stops the run before any mutation (R8). */
export interface PrerequisiteFailure {
  /** Stable code, e.g. "go-missing" or "source-not-a-git-worktree". */
  code: string;
  /** Full human-readable message with remedies. */
  message: string;
  /**
   * True for the unconditional HARD failures (missing `go`): the caller maps
   * them to a non-zero `status: "failed"` result, never a refusal.
   */
  hard: boolean;
}

/** Result of `checkPrerequisites`. */
export type PrerequisiteCheckResult =
  | {
      ok: true;
      /** Absolute path to the `git` executable found on the injected PATH. */
      gitPath: string;
      /** Absolute path to the `go` executable found on the injected PATH. */
      goPath: string;
      /** Absolute source checkout root that passed the worktree/submodule gate. */
      sourcePath: string;
    }
  | { ok: false; failure: PrerequisiteFailure };

/**
 * "Nothing was changed" trailer shared by every R8 refusal/hard-failure so the
 * operator knows exactly what was and was not touched (R8, §4.3).
 */
export const NOTHING_CHANGED_TRAILER =
  "Nothing was changed: no build, no install, no host mutation, and the " +
  "matchlock submodule was NOT synchronized.";

function goMissingFailure(): PrerequisiteFailure {
  return {
    code: "go-missing",
    hard: true,
    message: [
      "matchlock setup: `go` is required to build matchlock (HARD prerequisite;",
      "  checked before the content sync and before any build, install or host",
      "  change, so it gates every invocation — including one that would otherwise",
      "  be a no-op). Found: none on PATH.",
      "  Install Go (e.g. `brew install go`, `mise use go@1.25`, or your distro's",
      "  go package), then re-run. The required version is read from the submodule's",
      "  go.mod once its content is synchronized.",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function gitMissingFailure(): PrerequisiteFailure {
  return {
    code: "git-missing",
    hard: false,
    message: [
      "matchlock setup: `git` is required (it synchronizes the matchlock submodule",
      "  and reads its state). Found: none on PATH.",
      "  Install git (e.g. `brew install git`, `apt install git`, `dnf install git`),",
      "  then re-run.",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function notAWorktreeFailure(sourcePath: string): PrerequisiteFailure {
  return {
    code: "source-not-a-git-worktree",
    hard: false,
    message: [
      `matchlock setup: refusing: the source path "${sourcePath}" is not a git`,
      "  worktree (no .git entry). The committed `matchlock` submodule lives in the",
      "  tamandua source checkout; run this command from an installed tamandua",
      "  checkout (`tamandua update` refreshes one).",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function unregisteredSubmoduleFailure(
  sourcePath: string,
  detail: string,
): PrerequisiteFailure {
  return {
    code: "matchlock-submodule-missing",
    hard: false,
    message: [
      "matchlock setup: refusing: no registered `matchlock` submodule in the",
      `  tamandua checkout "${sourcePath}" (${detail}). This command never registers`,
      "  the submodule itself.",
      "  Remedy: run `tamandua update` to update the checkout to a revision that",
      "  registers the committed `matchlock` submodule, then re-run.",
      `  ${NOTHING_CHANGED_TRAILER}`,
      "  .gitmodules and the gitlink were left untouched.",
    ].join("\n"),
  };
}

function unsupportedPlatformFailure(platform: string): PrerequisiteFailure {
  return {
    code: "unsupported-platform",
    hard: false,
    message:
      `matchlock setup: refusing: unsupported platform "${platform}". Supported ` +
      "platforms are linux amd64/arm64 and darwin arm64 (Apple Silicon).",
  };
}

function unsupportedArchFailure(platform: string, arch: string): PrerequisiteFailure {
  if (platform === "darwin") {
    return {
      code: "unsupported-arch",
      hard: false,
      message: [
        `matchlock setup: refusing: darwin/${arch} is not supported. Intel Macs`,
        "  (x86_64) are out of scope (R10). Use an Apple Silicon (arm64) Mac, or a",
        "  supported linux amd64/arm64 host.",
        `  ${NOTHING_CHANGED_TRAILER}`,
      ].join("\n"),
    };
  }
  return {
    code: "unsupported-arch",
    hard: false,
    message: [
      `matchlock setup: refusing: linux/${arch} is not supported. ` +
        "Supported architectures are amd64 and arm64 (R10).",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function codesignMissingFailure(): PrerequisiteFailure {
  return {
    code: "codesign-missing",
    hard: false,
    message: [
      "matchlock setup: `codesign` is required on macOS (it applies the",
      "  virtualization entitlement to the built matchlock binary). Found: none on",
      "  PATH. Install the Xcode command-line tools (`xcode-select --install`), then",
      "  re-run.",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function sdkMissingFailure(): PrerequisiteFailure {
  return {
    code: "macos-sdk-missing",
    hard: false,
    message: [
      "matchlock setup: no usable macOS SDK was found",
      "  (`xcrun --sdk macosx --show-sdk-path` failed). Install the Xcode",
      "  command-line tools (`xcode-select --install`), then re-run. If you set",
      `  SDKROOT explicitly, point it at the SDK bundle (e.g. \`${SDKROOT_NOTE}\`).`,
      `  ${NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

/**
 * Finds an executable named `name` on the injected PATH using only fs probes
 * (no `which`/`command -v` spawn), so the gate stays deterministic.
 */
export async function findExecutableOnPath(
  deps: MatchlockSetupDeps,
  name: string,
): Promise<string | undefined> {
  const pathValue = nonEmpty(deps.env.PATH);
  if (pathValue === undefined) return undefined;
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim();
    if (dir === "") continue;
    const candidate = join(dir, name);
    let executable = false;
    try {
      executable = await deps.fs.isExecutable(candidate);
    } catch {
      executable = false;
    }
    if (executable) return candidate;
  }
  return undefined;
}

/** One parsed `[submodule "<name>"]` stanza from `.gitmodules`. */
export interface GitmodulesSubmodule {
  name: string;
  path?: string;
  url?: string;
}

/**
 * Parses the `[submodule "<name>"]` stanza out of `.gitmodules` text and
 * returns its `path`/`url` values, or `undefined` when the stanza is absent.
 */
export function parseGitmodulesSubmodule(
  text: string,
  name: string,
): GitmodulesSubmodule | undefined {
  let current: GitmodulesSubmodule | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (line === "") continue;
    const header = /^\[submodule\s+"([^"]+)"\]$/.exec(line);
    if (header) {
      if (current?.name === name) return current;
      current = { name: header[1] };
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv !== null && current !== undefined) {
      if (kv[1] === "path") current.path = kv[2].trim();
      else if (kv[1] === "url") current.url = kv[2].trim();
    }
  }

  return current?.name === name ? current : undefined;
}

/**
 * Parses `.gitmodules` text and reports whether it declares submodule `name`
 * at `submodulePath` (R8: `.gitmodules` entry + gitlink).
 */
export function gitmodulesDeclaresSubmodule(
  text: string,
  name: string,
  submodulePath: string,
): boolean {
  return parseGitmodulesSubmodule(text, name)?.path === submodulePath;
}

/**
 * Returns the `url` declared for submodule `name` in `.gitmodules` text
 * (the trust anchor `git submodule update --init` clones from), R9.
 */
export function gitmodulesSubmoduleUrl(
  text: string,
  name: string,
): string | undefined {
  return nonEmpty(parseGitmodulesSubmodule(text, name)?.url);
}

/**
 * One `git submodule status` line, e.g. `-<sha> matchlock` or
 * `+<sha> matchlock (heads/main)`. The leading character is `" "` (matches the
 * gitlink), `"-"` (not initialized), `"+"` (checked-out content differs) or
 * `"U"` (merge conflict).
 */
export interface ParsedSubmoduleStatus {
  /** Leading status character. */
  status: string;
  /** Commit recorded by `git submodule status` (lowercased). */
  sha: string;
  /** Submodule path exactly as printed. */
  path: string;
  /** False only for the `"-"` (uninitialized) state. */
  initialized: boolean;
}

/** Parses the `git submodule status -- <path>` output line for `submodulePath`. */
export function parseSubmoduleStatus(
  stdout: string,
  submodulePath: string,
): ParsedSubmoduleStatus | undefined {
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.trim() === "") continue;
    const match = /^([ +\-U])([0-9a-fA-F]{40,64})\s+(\S+)(?:\s+\(.*\))?$/.exec(rawLine);
    if (match === null) continue;
    if (match[3] !== submodulePath) continue;
    return {
      status: match[1],
      sha: match[2].toLowerCase(),
      path: match[3],
      initialized: match[1] !== "-",
    };
  }
  return undefined;
}

/**
 * Extracts the touched paths from `git status --porcelain` output (R9 dirty
 * submodule refusal). Rename/copy entries keep both sides of the arrow.
 */
export function parseDirtyPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (/^[ MADRCU?!]{1,2} /.test(line)) {
      paths.push(line.slice(3).trim());
    } else {
      paths.push(line.trim());
    }
  }
  return paths;
}

/**
 * Extracts the gitlink object id for `submodulePath` from the output of
 * `git ls-files --stage -- <path>` (mode 160000).
 */
export function parseGitlink(
  stdout: string,
  submodulePath: string,
): string | undefined {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parts = /^(\d{6})\s+([0-9a-fA-F]{40,64})\s+(\d+)\t(.+)$/.exec(line);
    if (parts === null) continue;
    if (parts[1] !== "160000") continue;
    if (parts[4].trim() !== submodulePath) continue;
    return parts[2].toLowerCase();
  }
  return undefined;
}

interface SubmoduleRegistration {
  registered: boolean;
  detail: string;
}

async function inspectRegisteredMatchlockSubmodule(
  deps: MatchlockSetupDeps,
): Promise<SubmoduleRegistration> {
  const gitmodulesPath = join(deps.sourcePath, ".gitmodules");
  if (!(await deps.fs.exists(gitmodulesPath))) {
    return { registered: false, detail: "no .gitmodules file" };
  }

  let contents = "";
  try {
    contents = await deps.fs.readTextFile(gitmodulesPath);
  } catch {
    return { registered: false, detail: "unreadable .gitmodules file" };
  }
  if (
    !gitmodulesDeclaresSubmodule(
      contents,
      MATCHLOCK_SUBMODULE_NAME,
      MATCHLOCK_SUBMODULE_NAME,
    )
  ) {
    return {
      registered: false,
      detail: `.gitmodules has no [submodule "matchlock"] path = matchlock entry`,
    };
  }

  let stdout = "";
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", deps.sourcePath, "ls-files", "--stage", "--", MATCHLOCK_SUBMODULE_NAME],
      { cwd: deps.sourcePath },
    );
    if (result.code !== 0) {
      return { registered: false, detail: `git ls-files exited ${result.code}` };
    }
    stdout = result.stdout;
  } catch {
    return { registered: false, detail: "git could not read the index" };
  }

  if (parseGitlink(stdout, MATCHLOCK_SUBMODULE_NAME) === undefined) {
    return {
      registered: false,
      detail: "the git index records no gitlink for matchlock",
    };
  }
  return { registered: true, detail: "ok" };
}

async function hasUsableMacSdk(deps: MatchlockSetupDeps): Promise<boolean> {
  try {
    const result = await deps.runCommand(
      "xcrun",
      ["--sdk", "macosx", "--show-sdk-path"],
      { timeoutMs: 30_000 },
    );
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * R8 prerequisite gates: run before any mutation and before the content sync.
 *
 * Order: supported platform/arch → darwin build tooling → `go` HARD gate →
 * `git` → the source path is a git worktree → a registered `matchlock`
 * submodule (`.gitmodules` entry + gitlink). Missing `go` is the one
 * unconditional non-zero hard failure (R8); everything else is a typed refusal.
 */
export async function checkPrerequisites(
  deps: MatchlockSetupDeps,
): Promise<PrerequisiteCheckResult> {
  const { platform, arch, sourcePath } = deps;

  if (platform !== "linux" && platform !== "darwin") {
    return { ok: false, failure: unsupportedPlatformFailure(platform) };
  }

  if (platform === "darwin") {
    if (!SUPPORTED_DARWIN_ARCHES.includes(arch)) {
      return { ok: false, failure: unsupportedArchFailure(platform, arch) };
    }
    const codesignPath = await findExecutableOnPath(deps, "codesign");
    if (codesignPath === undefined) {
      return { ok: false, failure: codesignMissingFailure() };
    }
    if (!(await hasUsableMacSdk(deps))) {
      return { ok: false, failure: sdkMissingFailure() };
    }
  } else if (!SUPPORTED_LINUX_ARCHES.includes(arch)) {
    return { ok: false, failure: unsupportedArchFailure(platform, arch) };
  }

  const goPath = await findExecutableOnPath(deps, "go");
  if (goPath === undefined) {
    return { ok: false, failure: goMissingFailure() };
  }

  const gitPath = await findExecutableOnPath(deps, "git");
  if (gitPath === undefined) {
    return { ok: false, failure: gitMissingFailure() };
  }

  if (!(await deps.fs.exists(join(sourcePath, ".git")))) {
    return { ok: false, failure: notAWorktreeFailure(sourcePath) };
  }

  const submodule = await inspectRegisteredMatchlockSubmodule(deps);
  if (!submodule.registered) {
    return {
      ok: false,
      failure: unregisteredSubmoduleFailure(sourcePath, submodule.detail),
    };
  }

  return { ok: true, gitPath, goPath, sourcePath };
}

/* -------------------------------------------------------------------------- */
/* R9 submodule guards + phase-1 content sync (N3)                             */
/* -------------------------------------------------------------------------- */

/** What the phase-1 sync did to the submodule content. */
export type SubmoduleSyncAction =
  | "already-synced"
  | "initialized"
  | "synced"
  | "checked-out";

/** Outcome of `syncMatchlockSubmodule`. */
export type SubmoduleSyncOutcome =
  | {
      ok: true;
      /** Which sync branch ran. */
      action: SubmoduleSyncAction;
      /** Origin URL the guard accepted (fork or `--url` override). */
      originUrl: string;
      /** Commit the superproject's gitlink records, when readable. */
      gitlinkSha?: string;
      /** Submodule `HEAD` after the sync, when readable. */
      contentSha?: string;
      /** True when content differs from the gitlink (N3: reported, uncommitted). */
      drift: boolean;
      /** Drift warning, present only when `drift` is true. */
      warning?: SetupWarning;
      /** One-line summary (mirrors the spec's typical output). */
      message: string;
    }
  | { ok: false; refusal: SetupRefusal };

function submoduleRefusal(code: string, lines: readonly string[]): SubmoduleSyncOutcome {
  return { ok: false, refusal: { code, message: lines.join("\n") } };
}

function submoduleCommandRefusal(
  gitStep: string,
  result: RunCommandResult | undefined,
): SubmoduleSyncOutcome {
  return submoduleRefusal("submodule-sync-failed", [
    `matchlock setup: refusing: \`git ${gitStep}\` failed` +
      `${result ? ` (exit ${result.code})` : " (could not be spawned)"}.`,
    "  The submodule content was left as found; nothing was built, installed or",
    "  host-mutated. The superproject is never staged or committed (N3).",
    "  Check network access to the fork and re-run.",
  ]);
}

async function readGitlinkSha(
  deps: MatchlockSetupDeps,
): Promise<string | undefined> {
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", deps.sourcePath, "ls-files", "--stage", "--", MATCHLOCK_SUBMODULE_NAME],
      { cwd: deps.sourcePath },
    );
    if (result.code !== 0) return undefined;
    return parseGitlink(result.stdout, MATCHLOCK_SUBMODULE_NAME);
  } catch {
    return undefined;
  }
}

async function readDeclaredSubmoduleUrl(
  deps: MatchlockSetupDeps,
): Promise<string | undefined> {
  const gitmodulesPath = join(deps.sourcePath, ".gitmodules");
  try {
    if (!(await deps.fs.exists(gitmodulesPath))) return undefined;
    return gitmodulesSubmoduleUrl(
      await deps.fs.readTextFile(gitmodulesPath),
      MATCHLOCK_SUBMODULE_NAME,
    );
  } catch {
    return undefined;
  }
}

async function readSubmoduleStatus(
  deps: MatchlockSetupDeps,
): Promise<
  { ok: true; status: ParsedSubmoduleStatus | undefined } | { ok: false; message: string }
> {
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", deps.sourcePath, "submodule", "status", MATCHLOCK_SUBMODULE_NAME],
      { cwd: deps.sourcePath, timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      return { ok: false, message: `git submodule status exited ${result.code}` };
    }
    return {
      ok: true,
      status: parseSubmoduleStatus(result.stdout, MATCHLOCK_SUBMODULE_NAME),
    };
  } catch {
    return { ok: false, message: "git submodule status could not be spawned" };
  }
}

async function readSubmoduleOriginUrl(
  deps: MatchlockSetupDeps,
  submodulePath: string,
): Promise<string | undefined> {
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", submodulePath, "remote", "get-url", "origin"],
      { cwd: submodulePath, timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) return undefined;
    return nonEmpty(result.stdout);
  } catch {
    return undefined;
  }
}

async function readSubmoduleDirtyPaths(
  deps: MatchlockSetupDeps,
  submodulePath: string,
): Promise<string[] | undefined> {
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", submodulePath, "status", "--porcelain"],
      { cwd: submodulePath, timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) return undefined;
    return parseDirtyPaths(result.stdout);
  } catch {
    return undefined;
  }
}

async function readSubmoduleContentSha(
  deps: MatchlockSetupDeps,
  submodulePath: string,
): Promise<string | undefined> {
  try {
    const result = await deps.runCommand(
      "git",
      ["-C", submodulePath, "rev-parse", "HEAD"],
      { cwd: submodulePath, timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) return undefined;
    return nonEmpty(result.stdout)?.toLowerCase();
  } catch {
    return undefined;
  }
}

async function runSubmoduleUpdate(
  deps: MatchlockSetupDeps,
): Promise<RunCommandResult | undefined> {
  try {
    return await deps.runCommand(
      "git",
      ["-C", deps.sourcePath, "submodule", "update", "--init", MATCHLOCK_SUBMODULE_NAME],
      { cwd: deps.sourcePath, timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

async function runSubmoduleFetch(
  deps: MatchlockSetupDeps,
  submodulePath: string,
  args: readonly string[],
): Promise<RunCommandResult | undefined> {
  try {
    return await deps.runCommand("git", ["-C", submodulePath, "fetch", ...args], {
      cwd: submodulePath,
      timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

async function runSubmoduleCheckout(
  deps: MatchlockSetupDeps,
  submodulePath: string,
  args: readonly string[],
): Promise<RunCommandResult | undefined> {
  try {
    return await deps.runCommand("git", ["-C", submodulePath, "checkout", ...args], {
      cwd: submodulePath,
      timeoutMs: SUBMODULE_COMMAND_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

/**
 * Phase-1 content synchronization with the R9 submodule guards (N3).
 *
 * Order: read the gitlink → read `git submodule status` → verify the fork
 * origin → refuse a dirty working tree before any checkout → sync
 * (`submodule update --init`) or check out `--ref`/`--latest` → report content
 * vs gitlink drift. Every process goes through the injected runner as an argv
 * array; the ref/url values are never interpolated into a shell string, and
 * the superproject is never staged or committed.
 */
export async function syncMatchlockSubmodule(
  options: MatchlockSetupOptions,
  deps: MatchlockSetupDeps,
): Promise<SubmoduleSyncOutcome> {
  const submodulePath = join(deps.sourcePath, MATCHLOCK_SUBMODULE_NAME);

  const gitlinkSha = await readGitlinkSha(deps);
  const declaredUrl = await readDeclaredSubmoduleUrl(deps);

  const statusRead = await readSubmoduleStatus(deps);
  if (!statusRead.ok) {
    return submoduleRefusal("submodule-status-failed", [
      `matchlock setup: refusing: cannot read the state of the committed ` +
        `\`${MATCHLOCK_SUBMODULE_NAME}\` submodule (${statusRead.message}).`,
      `  ${NOTHING_CHANGED_TRAILER}`,
    ]);
  }
  const initialized = statusRead.status?.initialized ?? false;

  const expectedUrl = nonEmpty(options.url) ?? MATCHLOCK_FORK_URL;
  const observedUrl = initialized
    ? (await readSubmoduleOriginUrl(deps, submodulePath)) ?? declaredUrl
    : declaredUrl;

  // `.gitmodules` is the trust anchor `git submodule update --init` clones from,
  // so a mismatch there is refused even when the recorded remote looks right.
  if (declaredUrl !== undefined && declaredUrl !== expectedUrl) {
    return submoduleRefusal("submodule-origin-mismatch", [
      `matchlock setup: refusing: the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule declared in`,
      `  .gitmodules points at: ${declaredUrl}`,
      `  expected fork:        ${expectedUrl}`,
      "  Refusing before any fetch or checkout. The command never re-points the",
      "  submodule; fix the registration in the tamandua checkout and re-run.",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ]);
  }

  if (observedUrl === undefined || observedUrl !== expectedUrl) {
    return submoduleRefusal("submodule-origin-mismatch", [
      `matchlock setup: refusing: the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule origin is not the`,
      "  expected fork.",
      `  observed: ${observedUrl ?? "(none)"}`,
      `  expected: ${expectedUrl}`,
      "  Refusing before any fetch or checkout; a different origin could pull",
      "  unreviewed content. Fix the submodule remote (or, for tests only, pass",
      "  --url) and re-run.",
      `  ${NOTHING_CHANGED_TRAILER}`,
    ]);
  }

  // R9: a dirty working tree would be clobbered by any checkout, so refuse
  // before one; --force never overrides dirtiness.
  if (initialized) {
    const dirtyPaths = await readSubmoduleDirtyPaths(deps, submodulePath);
    if (dirtyPaths === undefined) {
      return submoduleRefusal("submodule-status-failed", [
        `matchlock setup: refusing: cannot read the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule working`,
        "  tree state; refusing to touch it.",
        `  ${NOTHING_CHANGED_TRAILER}`,
      ]);
    }
    if (dirtyPaths.length > 0) {
      return submoduleRefusal("submodule-dirty", [
        `matchlock setup: refusing: the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule working tree is dirty.`,
        "  Local edits must be resolved by hand first; a checkout would clobber them.",
        "  Dirty paths:",
        ...dirtyPaths.map((path) => `    ${path}`),
        "  --force does NOT override a dirty submodule working tree (R9).",
        `  ${NOTHING_CHANGED_TRAILER}`,
        "  The submodule content was left exactly as found.",
      ]);
    }
  }

  let action: SubmoduleSyncAction = "already-synced";

  if (!initialized) {
    const result = await runSubmoduleUpdate(deps);
    if (result === undefined || result.code !== 0) {
      return submoduleCommandRefusal(
        `submodule update --init ${MATCHLOCK_SUBMODULE_NAME}`,
        result,
      );
    }
    action = "initialized";
  } else if (options.ref !== undefined) {
    const fetch = await runSubmoduleFetch(deps, submodulePath, []);
    if (fetch === undefined || fetch.code !== 0) {
      return submoduleCommandRefusal(`-C ${submodulePath} fetch`, fetch);
    }
    const checkout = await runSubmoduleCheckout(deps, submodulePath, [options.ref]);
    if (checkout === undefined || checkout.code !== 0) {
      return submoduleCommandRefusal(
        `-C ${submodulePath} checkout ${options.ref}`,
        checkout,
      );
    }
    action = "checked-out";
  } else if (options.latest) {
    const fetch = await runSubmoduleFetch(deps, submodulePath, ["origin", "main"]);
    if (fetch === undefined || fetch.code !== 0) {
      return submoduleCommandRefusal(`-C ${submodulePath} fetch origin main`, fetch);
    }
    // FETCH_HEAD is exactly the fork's main HEAD just fetched, independent of
    // any stale local branch in the submodule.
    const checkout = await runSubmoduleCheckout(deps, submodulePath, [
      "--detach",
      "FETCH_HEAD",
    ]);
    if (checkout === undefined || checkout.code !== 0) {
      return submoduleCommandRefusal(
        `-C ${submodulePath} checkout --detach FETCH_HEAD`,
        checkout,
      );
    }
    action = "checked-out";
  } else {
    const content = await readSubmoduleContentSha(deps, submodulePath);
    if (content !== undefined && gitlinkSha !== undefined && content !== gitlinkSha) {
      // Content behind the committed gitlink (e.g. after `tamandua update`) is
      // not an error: phase 1 syncs it.
      const result = await runSubmoduleUpdate(deps);
      if (result === undefined || result.code !== 0) {
        return submoduleCommandRefusal(
          `submodule update --init ${MATCHLOCK_SUBMODULE_NAME}`,
          result,
        );
      }
      action = "synced";
    } else if (content === undefined) {
      return submoduleRefusal("submodule-status-failed", [
        `matchlock setup: refusing: cannot read the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule content`,
        "  commit (`git rev-parse HEAD`); refusing to build unverified content.",
        `  ${NOTHING_CHANGED_TRAILER}`,
      ]);
    }
  }

  const contentSha = await readSubmoduleContentSha(deps, submodulePath);
  const drift =
    contentSha !== undefined && gitlinkSha !== undefined && contentSha !== gitlinkSha;

  let warning: SetupWarning | undefined;
  if (drift) {
    warning = {
      code: "submodule-drift",
      message:
        `matchlock setup: the \`${MATCHLOCK_SUBMODULE_NAME}\` submodule content ${contentSha} differs ` +
        `from the committed gitlink ${gitlinkSha}; the drift is reported and left ` +
        "uncommitted (N3: this command never runs git add, git commit or git stage).",
    };
  }

  const revision = contentSha ?? gitlinkSha ?? "unknown";
  const suffix = options.latest ? " (main)" : "";
  const message =
    `matchlock setup: submodule ${MATCHLOCK_SUBMODULE_NAME} → ${expectedUrl} ` +
    `@ ${revision}${suffix}`;

  return {
    ok: true,
    action,
    originUrl: expectedUrl,
    gitlinkSha,
    contentSha,
    drift,
    ...(warning !== undefined ? { warning } : {}),
    message,
  };
}

/* -------------------------------------------------------------------------- */
/* US-004 Go-minimum gate (phase 1, first check after the content sync)        */
/* -------------------------------------------------------------------------- */

/**
 * Environment variable Go uses to control automatic toolchain switching
 * (`GOTOOLCHAIN`). `matchlock setup` always forces it to `local` (R8) so an
 * insufficient toolchain can never be silently repaired by a download.
 */
export const GOTOOLCHAIN_ENV_NAME = "GOTOOLCHAIN";

/** The only value `matchlock setup` accepts for `GOTOOLCHAIN` (R8). */
export const GOTOOLCHAIN_LOCAL = "local";

/** Bounded timeout for the `go version` probe (N5). */
export const GO_VERSION_TIMEOUT_MS = 60_000;

/** A parsed Go toolchain version, compared numerically (not lexically). */
export interface GoVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Renders a `GoVersion` as `major.minor.patch`. */
export function formatGoVersion(version: GoVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function toGoVersion(major: string, minor: string, patch?: string): GoVersion {
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: patch === undefined ? 0 : Number.parseInt(patch, 10),
  };
}

/**
 * Parses the first non-comment `go <major>[.<minor>[.<patch>]]` directive out
 * of a `go.mod` body. Returns `undefined` when the file declares none. This is
 * the exact minimum the toolchain must satisfy (R8).
 */
export function parseGoDirective(goModText: string): GoVersion | undefined {
  for (const rawLine of goModText.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    const match = /^go\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s|$)/.exec(line);
    if (match !== null) return toGoVersion(match[1], match[2] ?? "0", match[3]);
  }
  return undefined;
}

/** Parses `go version` output such as `go version go1.25.5 linux/amd64`. */
export function parseGoVersionOutput(stdout: string): GoVersion | undefined {
  const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout);
  if (match === null) return undefined;
  return toGoVersion(match[1], match[2], match[3]);
}

/** Numeric (major, minor, patch) comparison; never lexical. */
export function compareGoVersions(a: GoVersion, b: GoVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Environment for every `go` invocation: the inherited env with
 * `GOTOOLCHAIN=local` forced, so neither the version probe nor a build can
 * fall back to Go's automatic toolchain download (R8).
 */
export function goToolchainEnv(
  deps: MatchlockSetupDeps,
): Record<string, string | undefined> {
  return { ...deps.env, [GOTOOLCHAIN_ENV_NAME]: GOTOOLCHAIN_LOCAL };
}

/**
 * "Nothing else was changed" trailer for post-sync hard failures. Unlike
 * `NOTHING_CHANGED_TRAILER`, it states that the submodule content WAS
 * synchronized (R8 / §4.3): only the build/install/host work is untouched.
 */
export const POST_SYNC_NOTHING_CHANGED_TRAILER =
  "The matchlock submodule content WAS synchronized; nothing else was changed: " +
  "no build, no install and no host mutation.";

function goModUnreadableFailure(goModPath: string): PrerequisiteFailure {
  return {
    code: "go-mod-unreadable",
    hard: true,
    message: [
      "matchlock setup: cannot read the `go` directive required to build matchlock:",
      `  the synchronized submodule has no readable go.mod (${goModPath}).`,
      "  Refusing before any build, install or host change so an unverifiable",
      "  toolchain can never be used. Run `tamandua update` to restore the checkout,",
      "  then re-run. Go is never auto-installed.",
      `  ${POST_SYNC_NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function goMinimumUnknownFailure(goModPath: string): PrerequisiteFailure {
  return {
    code: "go-minimum-unknown",
    hard: true,
    message: [
      `matchlock setup: the synchronized submodule's go.mod (${goModPath}) has no`,
      "  parseable `go <major>[.<minor>[.<patch>]]` directive, so the required Go",
      "  version cannot be determined. Refusing before any build, install or host",
      "  change; Go is never auto-installed.",
      `  ${POST_SYNC_NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function goTooOldFailure(
  minimum: GoVersion,
  found: GoVersion,
  goPath: string,
): PrerequisiteFailure {
  const min = formatGoVersion(minimum);
  return {
    code: "go-too-old",
    hard: true,
    message: [
      `matchlock setup: go >= ${min} is required (hard prerequisite; the minimum is`,
      "  the `go` directive in the synchronized submodule's go.mod).",
      `  Found: go${formatGoVersion(found)} at ${goPath}.`,
      `  Install or select Go ${min} or newer (e.g. \`brew upgrade go\`,`,
      `  \`mise use go@${min}\`, or your distro's go package), then re-run. Go's`,
      "  automatic toolchain download is disabled (GOTOOLCHAIN=local), so the",
      "  requirement can never be satisfied silently. Go is never auto-installed.",
      `  ${POST_SYNC_NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function goVersionUnknownFailure(goPath: string, detail: string): PrerequisiteFailure {
  return {
    code: "go-version-unknown",
    hard: true,
    message: [
      `matchlock setup: cannot determine the Go toolchain version (${detail}), so the`,
      "  synchronized go.mod minimum cannot be verified. Check the toolchain",
      "  (`go version`) and re-run. Go's automatic toolchain download is disabled",
      `  (GOTOOLCHAIN=local), so the requirement is never satisfied silently. Found`,
      `  binary: ${goPath}. Go is never auto-installed.`,
      `  ${POST_SYNC_NOTHING_CHANGED_TRAILER}`,
    ].join("\n"),
  };
}

function boundedGoOutput(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(no output)";
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, Math.max(0, maxLength - 3))}...`
    : collapsed;
}

/** Result of `checkGoMinimum`. */
export type GoMinimumCheckResult =
  | {
      ok: true;
      /** Minimum read from the synchronized submodule `go.mod`. */
      minimum: GoVersion;
      /** Version the local toolchain reports. */
      found: GoVersion;
      /** Absolute path to the go.mod the minimum was read from. */
      goModPath: string;
    }
  | { ok: false; failure: PrerequisiteFailure };

/**
 * Phase 1's first check after the content sync (R8): reads the exact minimum
 * from the synchronized submodule's `go.mod`, probes the local toolchain with
 * `GOTOOLCHAIN=local`, and fails HARD (non-zero, never auto-installing Go) when
 * the toolchain is older or its version cannot be determined. The caller
 * invokes this after `syncMatchlockSubmodule` and before any build, install or
 * host change.
 */
export async function checkGoMinimum(
  deps: MatchlockSetupDeps,
  goPath: string,
): Promise<GoMinimumCheckResult> {
  const submodulePath = join(deps.sourcePath, MATCHLOCK_SUBMODULE_NAME);
  const goModPath = join(submodulePath, "go.mod");

  let goModText: string | undefined;
  try {
    if (await deps.fs.exists(goModPath)) {
      goModText = await deps.fs.readTextFile(goModPath);
    }
  } catch {
    goModText = undefined;
  }
  if (goModText === undefined) {
    return { ok: false, failure: goModUnreadableFailure(goModPath) };
  }

  const minimum = parseGoDirective(goModText);
  if (minimum === undefined) {
    return { ok: false, failure: goMinimumUnknownFailure(goModPath) };
  }

  let probe: RunCommandResult;
  try {
    probe = await deps.runCommand(goPath, ["version"], {
      cwd: submodulePath,
      env: goToolchainEnv(deps),
      timeoutMs: GO_VERSION_TIMEOUT_MS,
    });
  } catch {
    return {
      ok: false,
      failure: goVersionUnknownFailure(goPath, "`go version` could not be spawned"),
    };
  }

  const found = probe.code === 0 ? parseGoVersionOutput(probe.stdout) : undefined;
  if (found === undefined) {
    const detail =
      probe.code === 0
        ? `\`go version\` printed ${boundedGoOutput(probe.stdout)}`
        : `\`go version\` exited ${probe.code}: ${boundedGoOutput(
            probe.stderr || probe.stdout,
          )}`;
    return { ok: false, failure: goVersionUnknownFailure(goPath, detail) };
  }

  if (compareGoVersions(found, minimum) < 0) {
    return { ok: false, failure: goTooOldFailure(minimum, found, goPath) };
  }

  return { ok: true, minimum, found, goModPath };
}

/* -------------------------------------------------------------------------- */
/* US-005 R2 build recipe (phase 1)                                            */
/* -------------------------------------------------------------------------- */

/**
 * `VERSION.txt` at the submodule root: the ldflags version source (R2).
 */
export const MATCHLOCK_VERSION_FILE = "VERSION.txt";

/**
 * The fork keeps the upstream module path, so the version ldflags package path
 * is fixed (R2/§3.2).
 */
export const MATCHLOCK_VERSION_PACKAGE = "github.com/jingkaihe/matchlock/pkg/version";

/** matchlock build package and output, relative to the submodule root (R2). */
export const MATCHLOCK_BUILD_PACKAGE = "./cmd/matchlock";
export const MATCHLOCK_BUILD_OUTPUT = "bin/matchlock";

/** guest-init build package and output, relative to the submodule root (R2). */
export const GUEST_INIT_BUILD_PACKAGE = "./cmd/guest-init";
export const GUEST_INIT_BUILD_OUTPUT = "bin/guest-init";

/** darwin virtualization-entitlement file signed onto matchlock (R2/§5). */
export const MATCHLOCK_ENTITLEMENTS_FILE = "matchlock.entitlements";

/** Bounded timeout for each build/sign invocation (N5). */
export const BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * Maps a host architecture seam value to the `GOARCH` the linux `guest-init`
 * binary is built for: Node's `x64` spells Go's `amd64` (R2/§3.2).
 */
export function guestInitGoArch(arch: string): string {
  return arch === "x64" ? "amd64" : arch;
}

/**
 * Renders the exact `-ldflags` argument the pinned recipe passes to
 * `go build` (R2). The string is one argv element — values are never
 * interpolated into a shell string (N5).
 */
export function matchlockLdflags(
  version: string,
  commit: string,
  buildTime: string,
): string {
  return [
    `-X ${MATCHLOCK_VERSION_PACKAGE}.Version=${version}`,
    `-X ${MATCHLOCK_VERSION_PACKAGE}.GitCommit=${commit}`,
    `-X ${MATCHLOCK_VERSION_PACKAGE}.BuildTime=${buildTime}`,
  ].join(" ");
}

/** Result of a successful R2 build. */
export interface MatchlockBuildSuccess {
  ok: true;
  /** Version read from the submodule `VERSION.txt`. */
  version: string;
  /** Submodule commit baked into the ldflags and recorded for the report. */
  commit: string;
  /** Build timestamp baked into the ldflags. */
  buildTime: string;
  /** Absolute path to the freshly built `matchlock` binary. */
  matchlockOutputPath: string;
  /** Absolute path to the freshly built `guest-init` binary. */
  guestInitOutputPath: string;
  /** True when the darwin entitlement codesign ran. */
  signed: boolean;
  /** darwin: absolute path `guest-init` was cached to, when applicable. */
  cachedGuestInitPath?: string;
  /** One-line summary (mirrors the spec's typical output). */
  message: string;
}

/** Result of `buildMatchlockBinaries`: success or a phase-1 hard failure. */
export type MatchlockBuildResult =
  | MatchlockBuildSuccess
  | { ok: false; failure: PrerequisiteFailure };

/**
 * "Nothing was installed" trailer for build failures (§4.3: a build failure is
 * non-zero and the previously installed binaries are untouched).
 */
export const BUILD_FAILED_NOTHING_INSTALLED_TRAILER =
  "Nothing was installed: the previously installed binaries (if any) are untouched.";

function versionFileFailure(versionPath: string): PrerequisiteFailure {
  return {
    code: "matchlock-version-unreadable",
    hard: true,
    message: [
      "matchlock setup: cannot build the pinned matchlock recipe:",
      `  the synchronized submodule has no readable ${MATCHLOCK_VERSION_FILE} (${versionPath}).`,
      "  The version ldflags are derived from it; refusing before any build or",
      "  install so a mislabelled binary is never produced.",
      `  ${BUILD_FAILED_NOTHING_INSTALLED_TRAILER}`,
    ].join("\n"),
  };
}

function submoduleCommitFailure(): PrerequisiteFailure {
  return {
    code: "submodule-commit-unknown",
    hard: true,
    message: [
      "matchlock setup: cannot resolve the synchronized submodule commit",
      "  (`git -C matchlock rev-parse HEAD` failed or printed nothing), so the",
      "  GitCommit ldflags cannot be pinned. Refusing before any build or install.",
      `  ${BUILD_FAILED_NOTHING_INSTALLED_TRAILER}`,
    ].join("\n"),
  };
}

function buildFailure(
  component: "matchlock" | "guest-init",
  result: RunCommandResult | undefined,
): PrerequisiteFailure {
  const detail = result === undefined ? "could not be spawned" : `exited ${result.code}`;
  return {
    code: component === "matchlock" ? "matchlock-build-failed" : "guest-init-build-failed",
    hard: true,
    message: [
      `matchlock setup: building ${component} failed (\`go build\` ${detail}).`,
      `  ${boundedGoOutput(result?.stderr || result?.stdout || "")}`,
      "  Check the toolchain and the synchronized submodule content, then re-run.",
      `  ${BUILD_FAILED_NOTHING_INSTALLED_TRAILER}`,
    ].join("\n"),
  };
}

function codesignFailure(result: RunCommandResult | undefined): PrerequisiteFailure {
  const detail = result === undefined ? "could not be spawned" : `exited ${result.code}`;
  return {
    code: "codesign-failed",
    hard: true,
    message: [
      `matchlock setup: codesigning the built matchlock failed (\`codesign\` ${detail}).`,
      `  ${boundedGoOutput(result?.stderr || result?.stdout || "")}`,
      "  The virtualization entitlement must be signed for matchlock to run VMs on",
      "  macOS. Check the entitlements file and the signing identity, then re-run.",
      `  ${BUILD_FAILED_NOTHING_INSTALLED_TRAILER}`,
    ].join("\n"),
  };
}

function guestInitCacheFailure(
  from: string,
  to: string,
  error: unknown,
): PrerequisiteFailure {
  const detail = error instanceof Error ? error.message : "unknown error";
  return {
    code: "guest-init-cache-failed",
    hard: true,
    message: [
      `matchlock setup: caching guest-init failed (${from} -> ${to}): ${detail}.`,
      "  matchlock resolves guest-init from its own directory or",
      "  ~/.cache/matchlock; refusing so a half-provisioned host is never reported",
      "  as ready.",
      `  ${BUILD_FAILED_NOTHING_INSTALLED_TRAILER}`,
    ].join("\n"),
  };
}

async function runBuildCommand(
  deps: MatchlockSetupDeps,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): Promise<RunCommandResult | undefined> {
  try {
    return await deps.runCommand(command, args, {
      cwd,
      ...(env !== undefined ? { env } : {}),
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

/**
 * Phase-1 R2 build recipe: replicates the fork's `mise.toml` `tasks.build`
 * exactly, with argv-array spawns and bounded timeouts.
 *
 * - reads the version from the submodule `VERSION.txt` and the commit from
 *   `git -C matchlock rev-parse HEAD`;
 * - `go build -ldflags=... -o bin/matchlock ./cmd/matchlock`;
 * - `go build -trimpath -o bin/guest-init ./cmd/guest-init` with
 *   `CGO_ENABLED=0 GOOS=linux GOARCH=<host arch>`;
 * - darwin only: `codesign --entitlements matchlock.entitlements -f -s - bin/matchlock`
 *   and caches guest-init into the effective `~/.cache/matchlock/guest-init`.
 *
 * Every `go` invocation carries `GOTOOLCHAIN=local` (R8) so the pinned
 * toolchain is always the one that builds. A failure is a phase-1 hard failure
 * that leaves the installed binaries untouched (§4.3).
 */
export async function buildMatchlockBinaries(
  deps: MatchlockSetupDeps,
  goPath: string,
  effective: MatchlockEffectivePaths,
): Promise<MatchlockBuildResult> {
  const submodulePath = join(deps.sourcePath, MATCHLOCK_SUBMODULE_NAME);
  const versionPath = join(submodulePath, MATCHLOCK_VERSION_FILE);

  let versionText: string | undefined;
  try {
    if (await deps.fs.exists(versionPath)) {
      versionText = await deps.fs.readTextFile(versionPath);
    }
  } catch {
    versionText = undefined;
  }
  const version = (versionText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (version === undefined) {
    return { ok: false, failure: versionFileFailure(versionPath) };
  }

  const commit = await readSubmoduleContentSha(deps, submodulePath);
  if (commit === undefined) {
    return { ok: false, failure: submoduleCommitFailure() };
  }

  const buildTime = new Date().toISOString();
  const ldflags = matchlockLdflags(version, commit, buildTime);
  const matchlockOutputPath = join(submodulePath, MATCHLOCK_BUILD_OUTPUT);
  const guestInitOutputPath = join(submodulePath, GUEST_INIT_BUILD_OUTPUT);

  // `go build -o` does not create the output directory; ensure it exists.
  try {
    await deps.fs.mkdirp(join(submodulePath, "bin"));
  } catch {
    // A read-only/short-circuit fs seam may already provide `bin`; the build
    // itself will surface a real failure.
  }

  const matchlockBuild = await runBuildCommand(
    deps,
    goPath,
    [
      "build",
      `-ldflags=${ldflags}`,
      "-o",
      MATCHLOCK_BUILD_OUTPUT,
      MATCHLOCK_BUILD_PACKAGE,
    ],
    submodulePath,
    goToolchainEnv(deps),
  );
  if (matchlockBuild === undefined || matchlockBuild.code !== 0) {
    return { ok: false, failure: buildFailure("matchlock", matchlockBuild) };
  }

  const guestInitEnv: Record<string, string | undefined> = {
    ...goToolchainEnv(deps),
    CGO_ENABLED: "0",
    GOOS: "linux",
    GOARCH: guestInitGoArch(deps.arch),
  };
  const guestInitBuild = await runBuildCommand(
    deps,
    goPath,
    ["build", "-trimpath", "-o", GUEST_INIT_BUILD_OUTPUT, GUEST_INIT_BUILD_PACKAGE],
    submodulePath,
    guestInitEnv,
  );
  if (guestInitBuild === undefined || guestInitBuild.code !== 0) {
    return { ok: false, failure: buildFailure("guest-init", guestInitBuild) };
  }

  let signed = false;
  let cachedGuestInitPath: string | undefined;
  if (deps.platform === "darwin") {
    const sign = await runBuildCommand(
      deps,
      "codesign",
      [
        "--entitlements",
        MATCHLOCK_ENTITLEMENTS_FILE,
        "-f",
        "-s",
        "-",
        MATCHLOCK_BUILD_OUTPUT,
      ],
      submodulePath,
      undefined,
    );
    if (sign === undefined || sign.code !== 0) {
      return { ok: false, failure: codesignFailure(sign) };
    }
    signed = true;

    cachedGuestInitPath = join(effective.cacheDir, "guest-init");
    try {
      await deps.fs.mkdirp(effective.cacheDir);
      await deps.fs.copyFile(guestInitOutputPath, cachedGuestInitPath);
    } catch (error) {
      return {
        ok: false,
        failure: guestInitCacheFailure(guestInitOutputPath, cachedGuestInitPath, error),
      };
    }
  }

  return {
    ok: true,
    version,
    commit,
    buildTime,
    matchlockOutputPath,
    guestInitOutputPath,
    signed,
    ...(cachedGuestInitPath !== undefined ? { cachedGuestInitPath } : {}),
    message:
      `matchlock setup: built matchlock ${version} (${commit}) + guest-init` +
      `${signed ? " (codesigned)" : ""}; outputs under ${submodulePath}/bin`,
  };
}

/* -------------------------------------------------------------------------- */
/* US-006 R3 atomic install (phase 1)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Trailer for install failures: the temp file is removed and no partially
 * written binary is ever published (R3/§4.3).
 */
export const INSTALL_FAILED_TRAILER =
  "The temporary file in the prefix was removed; no partially written binary was published.";

/** One binary staged for the atomic publish. */
interface InstallItem {
  /** Built source path under the submodule `bin/`. */
  source: string;
  /** Final installed absolute path (N7). */
  destination: string;
  /** Same-directory temporary path renamed onto the destination. */
  temp: string;
}

/**
 * Same-directory temp path for an atomic publish (same filesystem). The pid
 * suffix keeps two concurrent setup runs from sharing a staging file; the
 * destination is still only ever replaced by a single `rename`.
 */
function installTempPath(destination: string): string {
  return `${destination}.tmp-${process.pid}`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * §2/§4.3 prefix refusal: name the remedies and state explicitly that no sudo
 * was attempted (R3: never a silent sudo).
 */
function prefixNotWritableRefusal(prefix: string, detail: string): SetupRefusal {
  return {
    code: "prefix-not-writable",
    message: [
      `matchlock setup: refusing to install into ${prefix}: ${detail}.`,
      "  No sudo was attempted and nothing was installed.",
      "  Remedies:",
      "    - install into a directory you own:",
      "        tamandua matchlock setup --prefix <dir>",
      `      (the default is ~/.local/bin on Linux and ${DARWIN_DEFAULT_PREFIX} on macOS);`,
      `    - create the directory yourself and re-run, e.g. \`mkdir -p ${prefix}\`;`,
      "    - or fix its ownership/permissions as the owning user (chown/chmod).",
    ].join("\n"),
  };
}

function installFailure(
  stage: "copy" | "rename",
  source: string,
  destination: string,
  error: unknown,
): PrerequisiteFailure {
  return {
    code: "install-failed",
    hard: true,
    message: [
      `matchlock setup: installing the binaries into the prefix failed during ${stage}`,
      `  (${source} -> ${destination}): ${errorDetail(error)}.`,
      `  ${INSTALL_FAILED_TRAILER}`,
      "  Any previously installed binaries are left in place; re-run once the",
      "  prefix is writable and has enough free space.",
    ].join("\n"),
  };
}

async function safeIsWritableDir(deps: MatchlockSetupDeps, path: string): Promise<boolean> {
  try {
    return await deps.fs.isWritableDir(path);
  } catch {
    return false;
  }
}

async function safeExists(deps: MatchlockSetupDeps, path: string): Promise<boolean> {
  try {
    return await deps.fs.exists(path);
  } catch {
    return false;
  }
}

/**
 * Walks up from `path` to the first writable directory, so a missing prefix can
 * be created (via the injected `mkdirp`) only when an existing ancestor the
 * operator owns is writable. Returns undefined when nothing writable is found.
 */
async function nearestWritableAncestor(
  deps: MatchlockSetupDeps,
  path: string,
): Promise<string | undefined> {
  let current = dirname(path);
  while (true) {
    if (await safeIsWritableDir(deps, current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * R3 prefix pre-check: a writable prefix passes; a missing prefix is created
 * only when a writable ancestor exists; an existing-but-unwritable prefix (or a
 * missing prefix with no writable ancestor) yields the refusal. Never escalates
 * privileges.
 */
export async function ensureMatchlockInstallPrefix(
  deps: MatchlockSetupDeps,
  prefix: string,
): Promise<SetupRefusal | undefined> {
  if (await safeIsWritableDir(deps, prefix)) return undefined;
  if (await safeExists(deps, prefix)) {
    return prefixNotWritableRefusal(prefix, "the path exists but is not a writable directory");
  }
  const ancestor = await nearestWritableAncestor(deps, prefix);
  if (ancestor === undefined) {
    return prefixNotWritableRefusal(
      prefix,
      "it does not exist and no writable parent directory was found",
    );
  }
  try {
    await deps.fs.mkdirp(prefix);
  } catch (error) {
    return prefixNotWritableRefusal(prefix, `creating it failed (${errorDetail(error)})`);
  }
  return undefined;
}

async function removeInstallTemps(
  deps: MatchlockSetupDeps,
  installs: readonly InstallItem[],
): Promise<void> {
  for (const item of installs) {
    try {
      if (await safeExists(deps, item.temp)) await deps.fs.remove(item.temp);
    } catch {
      // Best-effort cleanup: a leftover temp file is inert.
    }
  }
}

/** Result of a successful R3 install. */
export interface MatchlockInstallSuccess {
  ok: true;
  /** Resolved install prefix (the temp files live here). */
  prefix: string;
  /** Absolute installed matchlock path (N7). */
  matchlockPath: string;
  /** Absolute installed guest-init path (N7). */
  guestInitPath: string;
  /** One-line summary. */
  message: string;
}

/** Result of `installMatchlockBinaries`: success, prefix refusal, or hard failure. */
export type MatchlockInstallResult =
  | MatchlockInstallSuccess
  | { ok: false; refusal?: SetupRefusal; failure?: PrerequisiteFailure };

/**
 * Phase-1 R3 install: publish the freshly built matchlock + guest-init side by
 * side into the resolved prefix.
 *
 * Both binaries are first copied to same-directory temp files, then each temp is
 * `rename`d onto its destination — an atomic replace that can never expose a
 * partially written binary. A copy failure therefore leaves every previously
 * installed destination untouched and removes the temp files. Prefix
 * writability is checked first (R3): a non-writable prefix is a refusal naming
 * remedies, with no install attempt and no sudo.
 */
export async function installMatchlockBinaries(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
  build: Pick<MatchlockBuildSuccess, "matchlockOutputPath" | "guestInitOutputPath">,
): Promise<MatchlockInstallResult> {
  const refusal = await ensureMatchlockInstallPrefix(deps, effective.prefix);
  if (refusal !== undefined) return { ok: false, refusal };

  const installs: InstallItem[] = [
    {
      source: build.matchlockOutputPath,
      destination: effective.matchlockPath,
      temp: installTempPath(effective.matchlockPath),
    },
    {
      source: build.guestInitOutputPath,
      destination: effective.guestInitPath,
      temp: installTempPath(effective.guestInitPath),
    },
  ];

  // Stage both temp files before publishing either destination so a failed copy
  // never touches a previously installed binary.
  for (const item of installs) {
    try {
      await deps.fs.copyFile(item.source, item.temp);
    } catch (error) {
      await removeInstallTemps(deps, installs);
      return { ok: false, failure: installFailure("copy", item.source, item.destination, error) };
    }
  }

  // Atomic publish: same-directory rename (same filesystem), one per binary.
  for (const item of installs) {
    try {
      await deps.fs.rename(item.temp, item.destination);
    } catch (error) {
      await removeInstallTemps(deps, installs);
      return { ok: false, failure: installFailure("rename", item.temp, item.destination, error) };
    }
  }

  return {
    ok: true,
    prefix: effective.prefix,
    matchlockPath: effective.matchlockPath,
    guestInitPath: effective.guestInitPath,
    message: `matchlock setup: installed matchlock + guest-init to ${effective.prefix}`,
  };
}

/* -------------------------------------------------------------------------- */
/* US-007 R7 idempotent no-op detection (phase 1)                              */
/* -------------------------------------------------------------------------- */

/** Bounded timeout for the installed-binary `matchlock version` probe (R7). */
export const VERSION_PROBE_TIMEOUT_MS = 30_000;

/** Version/commit parsed from the installed binary's `matchlock version`. */
export interface InstalledMatchlockIdentity {
  /** Version string reported by the installed binary. */
  version: string;
  /** Commit reported by the installed binary (often abbreviated). */
  commit: string;
  /** Build timestamp reported by the installed binary, when present. */
  built?: string;
}

/**
 * Parses the installed binary's identity from `matchlock version` output (R7).
 * The operator-owned fork prints exactly:
 *
 *   matchlock <version> (commit: <sha>, built: <when>)
 *
 * Returns undefined when no non-empty line matches, so the caller can surface a
 * typed non-zero failure instead of guessing (R7/§4.4).
 */
export function parseMatchlockVersionOutput(
  stdout: string,
): InstalledMatchlockIdentity | undefined {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match =
      /^matchlock\s+(\S+)\s+\(commit:\s*([^,)]+?)\s*(?:,\s*built:\s*([^)]*?)\s*)?\)$/.exec(line);
    if (match === null) continue;
    const version = nonEmpty(match[1]);
    const commit = nonEmpty(match[2]);
    if (version === undefined || commit === undefined) continue;
    const built = nonEmpty(match[3]);
    return {
      version,
      commit,
      ...(built !== undefined ? { built } : {}),
    };
  }
  return undefined;
}

/**
 * True when an installed commit (often the fork's abbreviated `matchlock
 * version` sha) identifies the same commit as the target full SHA. Prefix
 * matching requires at least 7 hex characters so a stray short string can never
 * declare idempotency.
 */
export function matchlockCommitMatches(installed: string, target: string): boolean {
  const a = installed.trim().toLowerCase();
  const b = target.trim().toLowerCase();
  if (a === "" || b === "") return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 7 || !/^[0-9a-f]+$/.test(shorter)) return false;
  return longer.startsWith(shorter);
}

/**
 * Trailer for an unparseable installed-version report: the decision never
 * mutates anything, so a stale or foreign binary pair is left untouched.
 */
export const INSTALLED_VERSION_UNPARSEABLE_TRAILER =
  "The previously installed binaries are left untouched: nothing was built or installed.";

function installedVersionFailure(
  matchlockPath: string,
  result: RunCommandResult | undefined,
): PrerequisiteFailure {
  const detail = result === undefined ? "could not be spawned" : `exited ${result.code}`;
  const output = result === undefined ? "" : result.stdout || result.stderr;
  return {
    code: "matchlock-version-unparseable",
    hard: true,
    message: [
      "matchlock setup: cannot determine the installed matchlock version/commit (R7).",
      `  \`${matchlockPath} version\` ${detail} or printed output that is not the`,
      '  expected "matchlock <version> (commit: <sha>, built: <when>)" line,',
      "  so the installed pair cannot be compared with the target submodule commit.",
      ...(output.trim() !== "" ? [`  ${boundedGoOutput(output)}`] : []),
      `  ${INSTALLED_VERSION_UNPARSEABLE_TRAILER}`,
      "  Re-run with --force to rebuild and reinstall the pinned binary pair.",
    ].join("\n"),
  };
}

/** Result of the R7 installed-binary identity probe. */
export type InstalledMatchlockIdentityResult =
  | { ok: true; identity: InstalledMatchlockIdentity }
  | { ok: false; failure: PrerequisiteFailure };

/**
 * Runs `<absolute installed matchlock> version` (N7) and parses its identity.
 * A probe that cannot be spawned, exits non-zero, or prints unparseable output
 * is a typed non-zero failure (R7/§4.4) — never a silent rebuild decision.
 */
export async function readInstalledMatchlockIdentity(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Promise<InstalledMatchlockIdentityResult> {
  let result: RunCommandResult | undefined;
  try {
    result = await deps.runCommand(effective.matchlockPath, ["version"], {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    });
  } catch {
    result = undefined;
  }
  const identity =
    result !== undefined && result.code === 0
      ? parseMatchlockVersionOutput(result.stdout)
      : undefined;
  if (identity === undefined) {
    return { ok: false, failure: installedVersionFailure(effective.matchlockPath, result) };
  }
  return { ok: true, identity };
}

/** True when both installed binaries are present (R7 requires both). */
async function installedBinariesPresent(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Promise<boolean> {
  return (
    (await safeExists(deps, effective.matchlockPath)) &&
    (await safeExists(deps, effective.guestInitPath))
  );
}

/* -------------------------------------------------------------------------- */
/* US-008 R4 phase 2 host setup (linux only)                                  */
/* -------------------------------------------------------------------------- */

/** Bounded timeout for the read-only `<abs installed matchlock> diagnose` gate (R4). */
export const HOST_SETUP_DIAGNOSE_TIMEOUT_MS = 60_000;

/** Bounded timeout for the privileged `<abs installed matchlock> setup linux` child (R4). */
export const HOST_SETUP_TIMEOUT_MS = 30 * 60_000;

/** One-line report when `diagnose` already passes (R4/§4.2). */
export const HOST_SETUP_ALREADY_READY_MESSAGE =
  "host setup: already ready (matchlock diagnose passed)";

/** One-line report on macOS, where host setup is never needed (R4/§5). */
export const HOST_SETUP_MACOS_SKIP_MESSAGE = "host setup: not needed on macOS";

/** One-line report when `--no-host-setup` skips the phase (R4/N2). */
export const HOST_SETUP_SKIPPED_MESSAGE = "host setup: skipped (--no-host-setup)";

/**
 * The R4 re-login caveat: group changes only take effect in a fresh login
 * session, so no VM can boot from the current one. Printed verbatim.
 */
export const RELOGIN_CAVEAT =
  "group changes require a NEW LOGIN SESSION — VMs cannot run from this session until you log out and back in";

/** Prominent rendering of the re-login caveat (§2 UX text). */
export const RELOGIN_CAVEAT_MESSAGE =
  `matchlock setup: !!! RE-LOGIN REQUIRED — ${RELOGIN_CAVEAT}. ` +
  "Log out and back in, then re-run `tamandua matchlock setup` (it will skip what is done) to verify.";

/**
 * `--smoke` is refused while a group re-login is pending (R4/R6/§4.3): a smoke
 * VM cannot start from a session whose groups predate the change.
 */
export const SMOKE_RELOGIN_REFUSAL_MESSAGE =
  "--smoke refused: a NEW LOGIN SESSION is required before a VM can boot " +
  "(group changes take effect only after you log out and back in).";

/**
 * Plain-language list of what `<abs> setup linux` does (R4/§3.3). The
 * capability line names the absolute installed binary whose capabilities the
 * privileged child sets (N7).
 */
export function hostSetupEffects(matchlockPath: string): string[] {
  return [
    "installs Firecracker + jailer from vendored assets (no network) into /usr/libexec/matchlock",
    `sets cap_net_admin,cap_net_raw+ep on ${matchlockPath}`,
    "configures /dev/net/tun (group netdev, mode 0660)",
    "enables IPv4 forwarding via a sysctl drop-in",
    "loads nf_tables",
    "adds the invoking user to the kvm and netdev groups",
  ];
}

/**
 * The identity-selected phase-2 command (R4/N2/N7). An ordinary user always
 * runs the bounded, visible `sudo <absolute installed matchlock> setup linux`
 * — even when the R12 override was supplied, since that only permits running
 * tamandua itself as root and does not confer root identity. A process already
 * running as root invokes the absolute binary directly, with no sudo wrapper.
 */
export function hostSetupCommand(euid: number, matchlockPath: string): string[] {
  if (euid === 0) return [matchlockPath, "setup", "linux"];
  return ["sudo", matchlockPath, "setup", "linux"];
}

/** True when `--smoke` must be refused because a group re-login is pending (R4). */
export function smokeRefusedByRelogin(
  options: MatchlockSetupOptions,
  reloginRequired: boolean,
): boolean {
  return options.smoke && reloginRequired;
}

/** Result of phase 2 host setup. */
export interface HostSetupPhaseResult {
  /** Phase outcome for the orchestrator's `phases` array. */
  outcome: SetupPhaseOutcome;
  /** True when the phase executed and a fresh login session is required (R4). */
  reloginRequired: boolean;
  /** The identity-selected command that ran (also the remaining manual command). */
  command?: string[];
}

/**
 * Phase 2 (R4, linux only): gate on `<absolute installed matchlock> diagnose`,
 * and when the host is not ready display the exact identity-selected command
 * plus its plain-language effects, then run it with inherited stdio so the sudo
 * prompt and matchlock's own output are visible. A successful run surfaces the
 * re-login caveat; a failure marks the phase failed without blocking phase 3.
 * Skipped by `--no-host-setup` and unconditionally on darwin.
 */
export async function runHostSetupPhase(
  options: MatchlockSetupOptions,
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Promise<HostSetupPhaseResult> {
  if (deps.platform !== "linux") {
    const message =
      deps.platform === "darwin"
        ? HOST_SETUP_MACOS_SKIP_MESSAGE
        : `host setup: not needed on ${deps.platform}`;
    deps.output.log(message);
    return {
      outcome: {
        phase: 2,
        name: "host-setup",
        status: "skipped",
        message,
        details: { reason: "platform", platform: deps.platform },
      },
      reloginRequired: false,
    };
  }

  if (options.noHostSetup) {
    deps.output.log(HOST_SETUP_SKIPPED_MESSAGE);
    return {
      outcome: {
        phase: 2,
        name: "host-setup",
        status: "skipped",
        message: HOST_SETUP_SKIPPED_MESSAGE,
        details: { reason: "no-host-setup" },
      },
      reloginRequired: false,
    };
  }

  // Diagnose gate: always the absolute installed path (N7). A spawn failure and
  // a non-zero exit both mean "not ready" and fall through to host setup.
  let diagnose: RunCommandResult | undefined;
  try {
    diagnose = await deps.runCommand(effective.matchlockPath, ["diagnose"], {
      timeoutMs: HOST_SETUP_DIAGNOSE_TIMEOUT_MS,
    });
  } catch {
    diagnose = undefined;
  }
  if (diagnose !== undefined && diagnose.code === 0) {
    deps.output.log(HOST_SETUP_ALREADY_READY_MESSAGE);
    return {
      outcome: {
        phase: 2,
        name: "host-setup",
        status: "skipped",
        message: HOST_SETUP_ALREADY_READY_MESSAGE,
        details: { diagnose: "passed" },
      },
      reloginRequired: false,
    };
  }

  // Display the exact command and its effects BEFORE spawning the child (N2).
  const command = hostSetupCommand(deps.euid, effective.matchlockPath);
  const commandText = command.join(" ");
  deps.output.log(
    "matchlock setup: matchlock diagnose reports the host is NOT ready. Running host setup:",
  );
  deps.output.log(`    ${commandText}`);
  deps.output.log("  Host setup will:");
  for (const effect of hostSetupEffects(effective.matchlockPath)) {
    deps.output.log(`    - ${effect}`);
  }

  // Inherited stdio: the sudo prompt and matchlock's own step output are visible.
  let setup: RunCommandResult | undefined;
  try {
    setup = await deps.runCommand(command[0], command.slice(1), {
      stdio: "inherit",
      timeoutMs: HOST_SETUP_TIMEOUT_MS,
    });
  } catch {
    setup = undefined;
  }

  if (setup !== undefined && setup.code === 0) {
    deps.output.log(RELOGIN_CAVEAT_MESSAGE);
    return {
      outcome: {
        phase: 2,
        name: "host-setup",
        status: "ok",
        message: RELOGIN_CAVEAT_MESSAGE,
        details: { command: commandText, reloginRequired: true },
      },
      reloginRequired: true,
      command,
    };
  }

  const detail =
    setup === undefined
      ? "could not be spawned (sudo cancelled or unavailable)"
      : `exited ${setup.code}`;
  const message = [
    `matchlock setup: host setup failed (${detail}).`,
    "  The installed binaries and the boot-assets phase are unaffected; phase 3 still runs.",
    "  To finish host setup by hand, run:",
    `      ${commandText}`,
  ].join("\n");
  deps.output.warn(message);
  return {
    outcome: {
      phase: 2,
      name: "host-setup",
      status: "failed",
      message,
      details: { command: commandText },
    },
    reloginRequired: false,
    command,
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — boot assets: standard image (R5)                                  */
/* -------------------------------------------------------------------------- */

/** `mkfs.erofs` binary the image materialization needs on PATH (R5/§4.3). */
export const MKFS_EROFS_BINARY = "mkfs.erofs";

/**
 * Free-space floor before the pull starts: 16 GiB on the filesystem holding
 * the image store (R5/§4.3). `--allow-low-disk-space` overrides.
 */
export const IMAGE_STORE_MIN_FREE_BYTES = 16 * 1024 ** 3;

/** Human label for the free-space floor in user-facing messages (R5). */
export const IMAGE_STORE_MIN_FREE_LABEL = "16 GB";

/** Bounded timeout for `matchlock pull` (R5/N5); env-overridable below. */
export const DEFAULT_PULL_TIMEOUT_MS = 15 * 60_000;

/**
 * Env override for the pull timeout, spelled exactly as the approved spec pins
 * it: `TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS` (the vendor prefix is
 * `TAMANDUA`, matching the image reference override).
 */
export const PULL_TIMEOUT_ENV_NAME = "TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS";

/** `matchlock` subcommand that provisions the standard image (R5). */
export const MATCHLOCK_PULL_COMMAND = "pull";

/** `--refresh-image` maps to `--force` on `matchlock pull` (R5). */
export const MATCHLOCK_PULL_FORCE_ARG = "--force";

/** Bounded stderr/stdout tail recorded on a pull failure (R5/§4.3). */
export const MAX_PULL_OUTPUT_TAIL_LENGTH = 400;

/**
 * One-line report when `--no-image` skips the pull. The kernel warm (R11) is a
 * separate phase-3 step and still runs, which is why only the pull is skipped.
 */
export const IMAGE_SKIPPED_MESSAGE =
  "boot assets: image pull skipped (--no-image); the kernel warm still runs";

/* -------------------------------------------------------------------------- */
/* Phase 3 — boot assets: guest-kernel warm (R11)                              */
/* -------------------------------------------------------------------------- */

/**
 * `matchlock` group + subcommand that warms the guest-kernel cache (R11). The
 * additive command is a sibling deliverable in the operator-owned matchlock
 * fork; this installer only CONSUMES it through the injected runner.
 */
export const MATCHLOCK_KERNEL_COMMAND = "kernel";

/** Subcommand of {@link MATCHLOCK_KERNEL_COMMAND} that fetches the kernel. */
export const MATCHLOCK_KERNEL_PULL_ARG = "pull";

/**
 * Bounded timeout for `matchlock kernel pull` (R11/N5). The warm only fetches a
 * kernel image (`ghcr.io/jingkaihe/matchlock/kernel:<version>`), so it is
 * bounded well below the standard-image pull budget.
 */
export const DEFAULT_KERNEL_PULL_TIMEOUT_MS = 10 * 60_000;

/** Bounded stderr/stdout tail recorded on a kernel-warm failure (R11/§4.3). */
export const MAX_KERNEL_OUTPUT_TAIL_LENGTH = 400;

/**
 * Remedy printed when the installed `matchlock` does not implement
 * `kernel pull` (an older submodule pin; R11). Names the pin/update path: the
 * gitlink and the fork-side command land together, so the fix is to sync the
 * pin (`tamandua update`) and rebuild (`--force`).
 */
export const KERNEL_WARM_MISSING_COMMAND_REMEDY = [
  "matchlock setup: kernel warm failed: the installed matchlock does not support `kernel pull` (unknown command).",
  "  The pinned matchlock revision must contain the additive `kernel pull` fetch (R11).",
  "  Sync the pin (`tamandua update`) and rebuild (`tamandua matchlock setup --force`), then re-run.",
  "  The image pull and the installed binaries are unaffected.",
].join("\n");

/**
 * One-line report when the fork command confirms a kernel of the pinned version
 * is already cached: the warm is a no-op (R11 idempotency).
 */
export const KERNEL_ALREADY_PRESENT_LABEL = "already present (no-op)";

/**
 * A guest kernel the phase-3 warm recorded for phase 4's report (R11). Fields
 * are populated from the fork command's own output; they are omitted when the
 * command did not report them.
 */
export interface WarmedKernel {
  /** Kernel version the command resolved, e.g. `6.19.8`. */
  version?: string;
  /** Absolute (or `~`-relative) path of the warmed kernel file. */
  path?: string;
  /** True when the command reported an already-present kernel (no-op). */
  alreadyPresent: boolean;
  /**
   * True when the runtime's selected backend embeds the kernel in the binary
   * (the linux/amd64 QEMU vendored path, offline by construction) so there is
   * nothing to download and phase 4 reports `embedded` (R6/R11).
   */
  embedded?: boolean;
}

/** Result of phase 3's guest-kernel warm (R11). */
export interface KernelWarmResult {
  /** Phase-3 outcome for the warm sub-step (`name: "boot-assets"`). */
  outcome: SetupPhaseOutcome;
  /** Recorded kernel, when the warm succeeded. */
  kernel?: WarmedKernel;
  /** Exact `matchlock kernel pull` argv that ran. */
  command: string[];
  /** CPU arch the warm targeted (informational). */
  arch: string;
  /** Warnings the sub-step produced (currently none; kept for symmetry). */
  warnings: SetupWarning[];
}

/** Provenance of the effective standard-image reference (R5). */
export type ImageReferenceSource = "env" | "standard";

/** The effective standard-image reference and where it came from. */
export interface EffectiveImageReference {
  reference: string;
  source: ImageReferenceSource;
}

/**
 * Effective standard-image reference: the `TAMANDUA_MATCHLOCK_IMAGE` env
 * override when non-empty, else the pinned `STANDARD_IMAGE_REFERENCE` (R5).
 */
export function effectiveImageReference(deps: MatchlockSetupDeps): EffectiveImageReference {
  const override = nonEmpty(deps.env[MATCHLOCK_IMAGE_ENV_NAME]);
  if (override !== undefined) return { reference: override, source: "env" };
  return { reference: STANDARD_IMAGE_REFERENCE, source: "standard" };
}

/**
 * Bounded pull timeout: the `TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS` override
 * when it parses to a positive integer, else the 15-minute default (R5).
 */
export function pullTimeoutMs(deps: MatchlockSetupDeps): number {
  const raw = nonEmpty(deps.env[PULL_TIMEOUT_ENV_NAME]);
  if (raw === undefined) return DEFAULT_PULL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PULL_TIMEOUT_MS;
  return Math.max(1, Math.floor(parsed));
}

/** Renders a byte count for the disk-floor message (GB/MB, one decimal). */
export function formatFreeSpace(bytes: number): string {
  const gib = 1024 ** 3;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * Parses the digest `matchlock pull` reports (`sha256:<hex>`). Prefers the full
 * 64-hex form; falls back to the abbreviated form some CLI builds print.
 */
export function parsePullDigest(output: string): string | undefined {
  const full = /sha256:[0-9a-fA-F]{64}/.exec(output);
  if (full !== null) return full[0].toLowerCase();
  const abbreviated = /sha256:[0-9a-fA-F]{7,63}/.exec(output);
  return abbreviated === null ? undefined : abbreviated[0].toLowerCase();
}

/** The exact `matchlock pull [--force] <reference>` argv (R5); cache-aware. */
export function matchlockPullCommand(
  reference: string,
  refreshImage: boolean,
): string[] {
  return refreshImage
    ? [MATCHLOCK_PULL_COMMAND, MATCHLOCK_PULL_FORCE_ARG, reference]
    : [MATCHLOCK_PULL_COMMAND, reference];
}

/** A bounded, single-line rendering of captured pull output for a failure. */
function boundedPullOutput(output: string): string {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  return collapsed.length > MAX_PULL_OUTPUT_TAIL_LENGTH
    ? `${collapsed.slice(0, MAX_PULL_OUTPUT_TAIL_LENGTH - 3)}...`
    : collapsed;
}

async function safeFreeSpaceBytes(
  deps: MatchlockSetupDeps,
  path: string,
): Promise<number | undefined> {
  try {
    const value = await deps.fs.freeSpaceBytes(path);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Result of phase 3's image portion (R5). */
export interface ImagePhaseResult {
  /** Phase-3 outcome (`name: "boot-assets"`). */
  outcome: SetupPhaseOutcome;
  /** Effective reference used for the pull. */
  reference: string;
  /** Provenance of the effective reference. */
  referenceSource: ImageReferenceSource;
  /** Local shadow entry when one exists (never deleted/renamed/retagged). */
  shadow?: StoredImageEntry;
  /** Digest the pull reported, when it did. */
  digest?: string;
  /** True when `--no-image` skipped the pull. */
  skipped: boolean;
  /** Exact pull argv when the pull ran. */
  command?: string[];
  /** Warnings the phase produced (shadow, low-disk override, ...). */
  warnings: SetupWarning[];
}

/**
 * Phase 3's image portion (R5): shadow check (warn + proceed, never mutate the
 * local entry) → `mkfs.erofs` gate → 16 GB disk-space floor (override
 * `--allow-low-disk-space`) → `matchlock pull [--force] <effective reference>`
 * with a bounded timeout and stderr-forwarded progress. `--no-image` skips
 * only the pull; the kernel warm (R11, a later story) still runs. The pull is
 * cache-aware unless `--refresh-image`, which adds `--force`.
 */
export async function runImagePhase(
  options: MatchlockSetupOptions,
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Promise<ImagePhaseResult> {
  const { reference, source } = effectiveImageReference(deps);
  const warnings: SetupWarning[] = [];

  if (options.noImage) {
    deps.output.log(IMAGE_SKIPPED_MESSAGE);
    return {
      outcome: {
        phase: 3,
        name: "boot-assets",
        status: "skipped",
        message: IMAGE_SKIPPED_MESSAGE,
        details: { reference, referenceSource: source, reason: "no-image" },
      },
      reference,
      referenceSource: source,
      skipped: true,
      warnings,
    };
  }

  // Shadow check BEFORE the gates and the pull (R5): a locally built/imported
  // entry under the effective reference is the accepted operator override.
  // Warn naming its digest, then proceed. The local entry is never deleted,
  // renamed or retagged — this phase performs no filesystem mutation at all.
  let shadow: StoredImageEntry | undefined;
  try {
    shadow = await deps.resolveStoredImage(reference);
  } catch {
    shadow = undefined;
  }
  if (shadow !== undefined && shadow.source === "local") {
    const refreshNote = options.refreshImage
      ? " --refresh-image updates the registry cache only: the effective image is UNCHANGED (the local entry is still used)."
      : " Runs use the local entry in preference to the registry image.";
    warnings.push({
      code: "image-shadow",
      message:
        `local image "${reference}" shadows the registry copy ` +
        `(local digest ${shadow.digest}).${refreshNote} It is never deleted, renamed or retagged.`,
    });
  }

  // `mkfs.erofs` gate (R5/§4.3): required to materialize EROFS rootfs images.
  const mkfsPath = await findExecutableOnPath(deps, MKFS_EROFS_BINARY);
  if (mkfsPath === undefined) {
    const remedy =
      deps.platform === "darwin"
        ? "Install erofs-utils (e.g. add `erofs-utils` to the managed Mac's nix environment), then re-run."
        : "Install erofs-utils (`apt install erofs-utils` or `dnf install erofs-utils`), then re-run.";
    const message = [
      `matchlock setup: \`${MKFS_EROFS_BINARY}\` is required to materialize the standard image but was not found on PATH.`,
      `  ${remedy}`,
      "  Host setup (phase 2) is unaffected; the image pull did not start.",
    ].join("\n");
    deps.output.warn(message);
    return {
      outcome: {
        phase: 3,
        name: "boot-assets",
        status: "failed",
        message,
        details: {
          reference,
          referenceSource: source,
          refused: true,
          reason: "mkfs-erofs-missing",
        },
      },
      reference,
      referenceSource: source,
      ...(shadow !== undefined ? { shadow } : {}),
      skipped: false,
      warnings,
    };
  }

  // Disk-space floor on the image-store filesystem (R5/§4.3).
  const freeBytes = await safeFreeSpaceBytes(deps, effective.imageStore);
  if (freeBytes !== undefined && freeBytes < IMAGE_STORE_MIN_FREE_BYTES) {
    const measured = formatFreeSpace(freeBytes);
    if (!options.allowLowDiskSpace) {
      const message = [
        `matchlock setup: refusing the image pull: only ${measured} free on the image-store filesystem (${effective.imageStore}); at least ${IMAGE_STORE_MIN_FREE_LABEL} is required.`,
        "  Free some space, or re-run with:",
        "      --allow-low-disk-space",
      ].join("\n");
      deps.output.warn(message);
      return {
        outcome: {
          phase: 3,
          name: "boot-assets",
          status: "failed",
          message,
          details: {
            reference,
            referenceSource: source,
            refused: true,
            reason: "low-disk-space",
            freeBytes,
            floorBytes: IMAGE_STORE_MIN_FREE_BYTES,
          },
        },
        reference,
        referenceSource: source,
        ...(shadow !== undefined ? { shadow } : {}),
        skipped: false,
        warnings,
      };
    }
    warnings.push({
      code: "low-disk-space-override",
      message:
        `${measured} free on the image-store filesystem is below the ` +
        `${IMAGE_STORE_MIN_FREE_LABEL} floor; --allow-low-disk-space starts the pull anyway ` +
        "(free space while it runs).",
    });
  }

  // Pull (R5): cache-aware by default; `--force` only with --refresh-image.
  const command = matchlockPullCommand(reference, options.refreshImage);
  const timeoutMs = pullTimeoutMs(deps);
  let pull: RunCommandResult | undefined;
  try {
    pull = await deps.runCommand(effective.matchlockPath, command, {
      stdio: "pipe",
      timeoutMs,
    });
  } catch {
    pull = undefined;
  }

  const captured = pull === undefined ? "" : `${pull.stdout}\n${pull.stderr}`;
  // Progress is forwarded to stderr (the warn seam), never swallowed (R5).
  for (const line of captured.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") deps.output.warn(trimmed);
  }
  const digest = parsePullDigest(captured);

  if (pull === undefined || pull.code !== 0) {
    const detail = pull === undefined ? "could not be spawned" : `exited ${pull.code}`;
    const tail = boundedPullOutput(captured);
    const message = [
      `matchlock setup: image phase failed: \`${effective.matchlockPath} ${command.join(" ")}\` ${detail}${tail === "" ? "." : `:\n${tail}`}`,
      "  Check registry reachability, then re-run; the binaries and host setup are unaffected.",
    ].join("\n");
    deps.output.warn(message);
    return {
      outcome: {
        phase: 3,
        name: "boot-assets",
        status: "failed",
        message,
        details: {
          reference,
          referenceSource: source,
          command: command.join(" "),
          reason: "pull-failed",
          exitCode: pull?.code,
        },
      },
      reference,
      referenceSource: source,
      ...(shadow !== undefined ? { shadow } : {}),
      skipped: false,
      command,
      warnings,
    };
  }

  const digestNote = digest !== undefined ? ` (digest ${digest})` : "";
  const message = options.refreshImage
    ? `matchlock setup: refreshed the registry cache for ${reference}${digestNote}`
    : `matchlock setup: standard image ${reference} present${digestNote}`;
  deps.output.log(message);
  return {
    outcome: {
      phase: 3,
      name: "boot-assets",
      status: "ok",
      message,
      details: {
        reference,
        referenceSource: source,
        refreshImage: options.refreshImage,
        ...(digest !== undefined ? { digest } : {}),
        ...(shadow !== undefined
          ? { shadow: { digest: shadow.digest, source: shadow.source } }
          : {}),
        timeoutMs,
      },
    },
    reference,
    referenceSource: source,
    ...(shadow !== undefined ? { shadow } : {}),
    ...(digest !== undefined ? { digest } : {}),
    skipped: false,
    command,
    warnings,
  };
}

/**
 * The exact `matchlock kernel pull` argv (R11). The additive command is the
 * fork-side sibling deliverable; setup only invokes it through the runner.
 */
export function matchlockKernelPullCommand(): string[] {
  return [MATCHLOCK_KERNEL_COMMAND, MATCHLOCK_KERNEL_PULL_ARG];
}

/**
 * True when a failed `matchlock kernel pull` output says the subcommand is
 * unknown/unrecognized — i.e. an older submodule pin whose binary predates the
 * additive fetch (R11), as opposed to a transient fetch failure.
 */
export function kernelPullCommandMissing(output: string): boolean {
  return /unknown\s+(?:command|subcommand)|unrecognized\s+(?:command|subcommand)|no\s+such\s+command|not\s+a\s+matchlock\s+command|invalid\s+command|is\s+not\s+a\s+valid\s+command/i.test(
    output,
  );
}

/**
 * Parses the fork command's own stdout/stderr into the warmed-kernel record
 * phase 4 reports (R11). The fork prints the resolved version and path and,
 * for an already-cached kernel, an "already present"/no-op note; the parser is
 * tolerant of the exact wording because the command is a sibling deliverable.
 * Absent fields stay undefined rather than guessing.
 */
export function parseKernelPullOutput(output: string): WarmedKernel {
  const text = output.replace(/\r/g, " ");
  const alreadyPresent =
    /\balready\b[^\n.]*\b(?:present|installed|cached|warmed|available)\b|\bup[ -]to[ -]date\b|\bno[ -]?op\b/i.test(
      text,
    );
  const versionMatch =
    /kernel\s+(\d+(?:\.\d+)+)/i.exec(text) ?? /(\d+\.\d+(?:\.\d+)*)/.exec(text);
  const pathMatch =
    /(?:warmed|present|installed|cached|path)\b[^\n:]*[:\-]\s*((?:~|\/)[^\s,;)]*)/i.exec(text);
  // The linux/amd64 QEMU backend embeds the kernel in the binary (R6/R11):
  // there is nothing to fetch and phase 4 reports `embedded`.
  const embedded = /\bembedded\b|\bvendored\b/i.test(text);
  const kernel: WarmedKernel = { alreadyPresent: alreadyPresent || embedded };
  if (versionMatch !== null) kernel.version = versionMatch[1];
  if (pathMatch !== null) kernel.path = pathMatch[1].replace(/[.,;:]+$/, "");
  if (embedded) kernel.embedded = true;
  return kernel;
}

/** A bounded, single-line rendering of captured kernel-warm output. */
function boundedKernelOutput(output: string): string {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  return collapsed.length > MAX_KERNEL_OUTPUT_TAIL_LENGTH
    ? `${collapsed.slice(0, MAX_KERNEL_OUTPUT_TAIL_LENGTH - 3)}...`
    : collapsed;
}

/**
 * Phase 3's guest-kernel warm (R11): invoke the absolute installed
 * `<prefix>/matchlock kernel pull` with a bounded timeout and record the
 * resolved version/path for phase 4. The fork command is idempotent (a present
 * kernel is a no-op). An unknown command means an older submodule pin and gets
 * the pin/update remedy; any other failure is a typed boot-assets failure with
 * a bounded stderr tail, retry guidance and a non-zero overall exit — the image
 * pull and installed binaries are unaffected.
 */
export async function runKernelWarmPhase(
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
): Promise<KernelWarmResult> {
  const command = matchlockKernelPullCommand();
  const arch = deps.arch;
  let pull: RunCommandResult | undefined;
  try {
    pull = await deps.runCommand(effective.matchlockPath, command, {
      stdio: "pipe",
      timeoutMs: DEFAULT_KERNEL_PULL_TIMEOUT_MS,
    });
  } catch {
    pull = undefined;
  }

  const captured = pull === undefined ? "" : `${pull.stdout}\n${pull.stderr}`;
  // Progress/errors are forwarded to stderr (the warn seam), never swallowed.
  for (const line of captured.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") deps.output.warn(trimmed);
  }

  if (pull === undefined) {
    const message = [
      `matchlock setup: kernel warm failed: \`${effective.matchlockPath} ${command.join(" ")}\` could not be spawned.`,
      "  Check registry reachability, then re-run; the image pull and the installed binaries are unaffected.",
    ].join("\n");
    deps.output.warn(message);
    return {
      outcome: {
        phase: 3,
        name: "boot-assets",
        status: "failed",
        message,
        details: {
          reason: "kernel-warm-failed",
          command: command.join(" "),
          arch,
        },
      },
      command,
      arch,
      warnings: [],
    };
  }

  if (pull.code !== 0) {
    const tail = boundedKernelOutput(captured);
    const missing = kernelPullCommandMissing(captured);
    const message = missing
      ? KERNEL_WARM_MISSING_COMMAND_REMEDY
      : [
          `matchlock setup: kernel warm failed: \`${effective.matchlockPath} ${command.join(" ")}\` exited ${pull.code}${tail === "" ? "." : `:\n${tail}`}`,
          "  Check registry reachability, then re-run; the image pull and the installed binaries are unaffected.",
        ].join("\n");
    deps.output.warn(message);
    return {
      outcome: {
        phase: 3,
        name: "boot-assets",
        status: "failed",
        message,
        details: {
          reason: missing ? "kernel-pull-unsupported" : "kernel-warm-failed",
          command: command.join(" "),
          exitCode: pull.code,
          arch,
        },
      },
      command,
      arch,
      warnings: [],
    };
  }

  const kernel = parseKernelPullOutput(captured);
  const versionLabel = kernel.version ?? "version not reported";
  const pathLabel = kernel.path !== undefined ? `: ${kernel.path}` : "";
  const message = kernel.alreadyPresent
    ? `matchlock setup: guest kernel ${versionLabel} ${KERNEL_ALREADY_PRESENT_LABEL}${pathLabel}`
    : `matchlock setup: guest kernel ${versionLabel} warmed${pathLabel}`;
  deps.output.log(message);
  return {
    outcome: {
      phase: 3,
      name: "boot-assets",
      status: "ok",
      message,
      details: {
        reason: "kernel-warmed",
        command: command.join(" "),
        arch,
        alreadyPresent: kernel.alreadyPresent,
        ...(kernel.version !== undefined ? { version: kernel.version } : {}),
        ...(kernel.path !== undefined ? { path: kernel.path } : {}),
      },
    },
    kernel,
    command,
    arch,
    warnings: [],
  };
}

/**
 * Merges phase 3's image and kernel-warm sub-results into the single
 * `boot-assets` outcome the orchestrator records (R11). The phase fails when
 * either sub-step failed; a `--no-image` skip still yields `ok` when the
 * kernel warm succeeded. Image details are preserved and the warm record is
 * added under `details.kernel` for phase 4.
 */
export function combineBootAssetsPhase(
  image: ImagePhaseResult,
  kernel: KernelWarmResult | undefined,
): SetupPhaseOutcome {
  const details: Record<string, unknown> = {
    ...(image.outcome.details ?? {}),
    ...(kernel !== undefined
      ? {
          kernel: {
            command: kernel.command.join(" "),
            arch: kernel.arch,
            status: kernel.outcome.status,
            alreadyPresent: kernel.kernel?.alreadyPresent ?? false,
            ...(kernel.kernel?.version !== undefined
              ? { version: kernel.kernel.version }
              : {}),
            ...(kernel.kernel?.path !== undefined ? { path: kernel.kernel.path } : {}),
          },
        }
      : {}),
  };
  if (image.outcome.status === "failed") {
    return {
      phase: 3,
      name: "boot-assets",
      status: "failed",
      message: image.outcome.message,
      details,
    };
  }
  if (kernel !== undefined && kernel.outcome.status === "failed") {
    // The warm is the failing sub-step: surface its typed reason at the phase
    // level (the image details above stay intact for phase 4).
    if (typeof kernel.outcome.details?.reason === "string") {
      details.reason = kernel.outcome.details.reason;
    }
    return {
      phase: 3,
      name: "boot-assets",
      status: "failed",
      message: kernel.outcome.message,
      details,
    };
  }
  const messages = [image.outcome.message, kernel?.outcome.message].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return {
    phase: 3,
    name: "boot-assets",
    status: "ok",
    message: messages.join("\n"),
    details,
  };
}

/* -------------------------------------------------------------------------- */
/* US-011 R6 phase 4 verify + offline-readiness report                        */
/* -------------------------------------------------------------------------- */

/** Bounded timeout for phase 4's re-run `<abs installed matchlock> diagnose` (R6). */
export const VERIFY_DIAGNOSE_TIMEOUT_MS = 60_000;

/** Bounded timeout for the opt-in `--smoke` no-network VM boot (R6). */
export const SMOKE_TIMEOUT_MS = 10 * 60_000;

/** `--smoke` argv (R6): a minimal `matchlock run --image <ref> --no-network -- true`. */
export const SMOKE_RUN_COMMAND = "run";
export const SMOKE_IMAGE_FLAG = "--image";
export const SMOKE_NO_NETWORK_FLAG = "--no-network";
export const SMOKE_GUEST_ARGV_SEPARATOR = "--";
export const SMOKE_GUEST_COMMAND = "true";

/** The exact `matchlock run --image <ref> --no-network -- true` smoke argv (R6). */
export function matchlockSmokeCommand(reference: string): string[] {
  return [
    SMOKE_RUN_COMMAND,
    SMOKE_IMAGE_FLAG,
    reference,
    SMOKE_NO_NETWORK_FLAG,
    SMOKE_GUEST_ARGV_SEPARATOR,
    SMOKE_GUEST_COMMAND,
  ];
}

/** Heading of the phase-4 verify report (R6). */
export const VERIFY_REPORT_HEADING = "matchlock setup: verify";

/** Heading of the R11 offline-readiness verdict that closes the report. */
export const OFFLINE_READINESS_HEADING = "offline-readiness:";

/** R11 assets verdict: image + kernel/binaries are all present (offline-ready). */
export const OFFLINE_ASSETS_READY_LABEL = "assets: offline-ready";

/** R11 assets verdict prefix when at least one provisioned asset is missing. */
export const OFFLINE_ASSETS_MISSING_LABEL = "assets: missing";

/** Runnability verdict: VMs can boot from the current session. */
export const RUNNABILITY_READY_LABEL = "runnability: ready in this session";

/** Runnability verdict: group enrollment needs a fresh login before VMs boot. */
export const RUNNABILITY_RELOGIN_LABEL =
  "runnability: re-login required before VMs can run (a NEW LOGIN SESSION is needed)";

/** Runnability verdict: `matchlock diagnose` still reports the host is unready. */
export const RUNNABILITY_HOST_NOT_READY_LABEL =
  "runnability: host not ready (matchlock diagnose failed)";

/** Word the R6 report uses for a shadow-explained digest mismatch (informational). */
export const VERIFY_SHADOWED_LABEL = "shadowed";

/** Assets-missing remedy fragments the verdict names for each missing asset. */
export const IMAGE_MISSING_REMEDY =
  "remedy: re-run `tamandua matchlock setup` (see the phase-3 image result above)";
export const KERNEL_MISSING_REMEDY =
  "remedy: re-run `tamandua matchlock setup` (see the phase-3 kernel-warm result above)";
export const BINARIES_MISSING_REMEDY =
  "remedy: re-run `tamandua matchlock setup`";

/* -------------------------------------------------------------------------- */
/* US-012 N7 post-install re-verification                                     */
/* -------------------------------------------------------------------------- */

/**
 * Operator env override naming the matchlock CLI binary the daemon/runner is
 * expected to resolve (N7). Mirrors `MATCHLOCK_RPC_BIN_ENV` in
 * src/installer/matchlock/allow-private-support.ts (sibling line; consolidated
 * at integration).
 */
export const MATCHLOCK_RPC_BIN_ENV_NAME = "TAMANDUA_MATCHLOCK_RPC_BIN";

/** The matchlock CLI binary name (both the installed file and the PATH lookup). */
export const MATCHLOCK_BINARY_NAME = "matchlock";

/**
 * The read-only capability tool used to re-verify the file just installed
 * (N7). matchlock's `setup linux` runs `setcap cap_net_admin,cap_net_raw+ep`
 * on the invoking binary, and `getcap` is the canonical way to observe that
 * metadata afterwards. A capability read is METADATA (spec §10.7): whether the
 * kernel honors it at exec depends on the filesystem mount options.
 */
export const CAPABILITY_PROBE_COMMAND = "getcap";

/** Bounded timeout for the read-only `getcap <abs installed>` probe (N7). */
export const CAPABILITY_PROBE_TIMEOUT_MS = 10_000;

/** Cap on captured `getcap` output characters rendered in a failure message. */
export const MAX_CAPABILITY_OUTPUT_LENGTH = 200;

/**
 * The capability tokens matchlock's `setup linux` sets on the invoking binary
 * (`cmd/matchlock/setup_linux.go`: `cap_net_admin,cap_net_raw+ep`).
 */
export const REQUIRED_MATCHLOCK_CAPABILITIES: readonly string[] = [
  "cap_net_admin",
  "cap_net_raw",
];

/**
 * Stale environment overrides that would win over the installed binary pair and
 * must therefore be reported by verify (N7). Report-only: setup never unsets or
 * rewrites the operator's environment.
 */
export const STALE_MATCHLOCK_ENV_OVERRIDES: readonly string[] = [
  "MATCHLOCK_FIRECRACKER",
  "MATCHLOCK_JAILER",
  "MATCHLOCK_GUEST_INIT",
];

/** Warning code for a predicted daemon binary that differs from the installed path. */
export const MATCHLOCK_PATH_SHADOW_WARNING_CODE = "matchlock-path-shadow";

/** Warning code for each stale MATCHLOCK_* override that wins over the installed pair. */
export const STALE_MATCHLOCK_ENV_WARNING_CODE = "stale-matchlock-env-override";

/** Hard-failure code when the newly installed file lacks a required capability. */
export const VERIFY_CAPABILITIES_MISSING_CODE = "verify-capabilities-missing";

/** Capability-re-verification verdict rendered by the phase-4 report (N7). */
export type ReportCapabilityStatus =
  | "verified"
  | "missing"
  | "unavailable"
  | "inapplicable";

/** Post-install capability re-verification the phase-4 report (N7). */
export interface CapabilitiesReport {
  status: ReportCapabilityStatus;
  /** Absolute path the probe targeted (N7; never a bare name). */
  path: string;
  /** Required capability tokens that were observed. */
  found: string[];
  /** Required capability tokens that were missing. */
  missing: string[];
  /**
   * The identity-selected bound fix command (R4/N7): `sudo <abs> setup linux`
   * for a non-root caller, `<abs> setup linux` for an already-root caller
   * permitted by R12.
   */
  fixCommand?: string[];
  /** Bounded raw `getcap` output, when anything was printed. */
  output?: string;
}

/** Raw result of the `getcap <abs installed matchlock>` probe (N7). */
export interface CapabilityProbeResult {
  verified: boolean;
  /** True when the probe could not be spawned at all (e.g. `getcap` absent). */
  unavailable: boolean;
  found: string[];
  missing: string[];
  output?: string;
}

/** The daemon-resolved binary prediction the phase-4 report renders (N7). */
export interface ExpectedBinaryReport {
  /**
   * `TAMANDUA_MATCHLOCK_RPC_BIN` when set, else the first executable `matchlock`
   * on the operator PATH, else the bare name `matchlock`. This is a PREDICTION:
   * it is labelled expected and is never asserted as verified.
   */
  path: string;
  /** True when the prediction came from TAMANDUA_MATCHLOCK_RPC_BIN. */
  fromEnvOverride: boolean;
  /** True when a real executable was resolved on PATH (not the bare fallback). */
  resolvedFromPath: boolean;
  /** True when the prediction differs from the installed absolute path (shadowing). */
  shadowed: boolean;
}

/** One stale environment override named by the phase-4 report (N7). */
export interface StaleEnvOverride {
  name: string;
  value: string;
}

/** Effective standard-image provenance in the phase-4 report (R6). */
export type ReportImageSource = "registry" | "local";

/** Effective-vs-pulled image resolution the phase-4 report renders (R6). */
export interface EffectiveImageReport {
  reference: string;
  /** True when an image is present (store hit or a successful pull). */
  present: boolean;
  /** Effective digest (a local shadow entry wins over the registry copy). */
  digest?: string;
  /** Effective source; undefined when no image is present. */
  source?: ReportImageSource;
  /** Digest the phase-3 pull reported, when it did. */
  pulledDigest?: string;
  /** True when a local built/imported entry explains the effective image. */
  shadowed: boolean;
  /** True when the effective digest differs from the pulled digest. */
  mismatch: boolean;
  /** True when the mismatch is explained by an accepted local shadow. */
  mismatchExplained: boolean;
}

function normalizedDigest(digest: string | undefined): string | undefined {
  const value = nonEmpty(digest);
  return value === undefined ? undefined : value.toLowerCase();
}

/**
 * Classifies the effective standard image for the R6 report (US-011). The
 * store resolver (a `local` entry is the accepted shadow override) is
 * authoritative; a successful phase-3 pull is itself proof the image landed.
 * A mismatch between the effective and pulled digests is only informational
 * when a local shadow explains it (R6/§4.3): an unexplained resolution change
 * is a hard failure the caller surfaces.
 */
export function classifyEffectiveImage(input: {
  reference: string;
  resolved?: StoredImageEntry;
  pulledDigest?: string;
  /** Phase-3 image sub-step status. */
  imageStatus: SetupPhaseStatus;
  /** True when `--no-image` skipped the pull. */
  imageSkipped: boolean;
}): EffectiveImageReport {
  const pullSucceeded = input.imageStatus === "ok" && !input.imageSkipped;
  const present = input.resolved !== undefined || pullSucceeded;
  const digest =
    input.resolved?.digest ?? (pullSucceeded ? input.pulledDigest : undefined);
  const source: ReportImageSource | undefined = present
    ? input.resolved?.source ?? "registry"
    : undefined;
  const shadowed = source === "local";
  const pulled = normalizedDigest(input.pulledDigest);
  const effective = normalizedDigest(digest);
  const mismatch =
    pulled !== undefined && effective !== undefined && pulled !== effective;
  return {
    reference: input.reference,
    present,
    ...(digest !== undefined ? { digest } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(input.pulledDigest !== undefined ? { pulledDigest: input.pulledDigest } : {}),
    shadowed,
    mismatch,
    mismatchExplained: mismatch && shadowed,
  };
}

/** Kernel classification in the phase-4 report (R6/R11). */
export type ReportKernelStatus = "warmed" | "embedded" | "missing";

/** The warmed/embedded/missing guest kernel the report renders (R6). */
export interface KernelReport {
  status: ReportKernelStatus;
  version?: string;
  path?: string;
  alreadyPresent: boolean;
}

/**
 * Classifies the phase-3 warm result for the report: `embedded` for the
 * vendored QEMU/amd64 path (nothing to fetch, offline by construction),
 * `warmed` for a successful download/cache warm (version/path when reported),
 * and `missing` when the warm did not succeed.
 */
export function classifyWarmedKernel(
  kernel: KernelWarmResult | undefined,
): KernelReport {
  if (
    kernel === undefined ||
    kernel.outcome.status !== "ok" ||
    kernel.kernel === undefined
  ) {
    return { status: "missing", alreadyPresent: false };
  }
  const record = kernel.kernel;
  const fields = {
    ...(record.version !== undefined ? { version: record.version } : {}),
    ...(record.path !== undefined ? { path: record.path } : {}),
  };
  if (record.embedded === true) {
    return { status: "embedded", alreadyPresent: true, ...fields };
  }
  return { status: "warmed", alreadyPresent: record.alreadyPresent, ...fields };
}

/** Runnability verdict the R11 report separates from the assets verdict. */
export type RunnabilityStatus = "ready" | "relogin-required" | "host-not-ready";

/** Structured phase-4 report (R6): assets vs runnability. */
export interface VerifyReport {
  diagnoseReady: boolean;
  version?: string;
  commit?: string;
  image: EffectiveImageReport;
  kernel: KernelReport;
  binariesPresent: boolean;
  assetsReady: boolean;
  missingAssets: string[];
  runnability: RunnabilityStatus;
  /** N7: capabilities re-verified on the newly installed file. */
  capabilities: CapabilitiesReport;
  /** N7: the binary the daemon is EXPECTED to resolve (never asserted verified). */
  expectedBinary: ExpectedBinaryReport;
  /** N7: stale MATCHLOCK_* overrides that win over the installed pair. */
  staleEnvOverrides: StaleEnvOverride[];
}

/**
 * Extracts the capability tokens (`cap_net_admin`, ...) from `getcap` output.
 * Both the current `<path> cap_net_admin,cap_net_raw=ep` and older
 * `<path> = cap_net_admin+ep` shapes are handled, so only the tokens matter.
 */
export function parseGetcapCapabilities(output: string): string[] {
  const found = new Set<string>();
  for (const match of output.matchAll(/\bcap_[a-z0-9_]+\b/gi)) {
    found.add(match[0].toLowerCase());
  }
  return [...found].sort();
}

/** The required capability tokens absent from `found` (N7). */
export function missingMatchlockCapabilities(found: readonly string[]): string[] {
  const present = new Set(found.map((token) => token.toLowerCase()));
  return REQUIRED_MATCHLOCK_CAPABILITIES.filter((token) => !present.has(token));
}

function boundedCapabilityOutput(output: string): string {
  const collapsed = output.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_CAPABILITY_OUTPUT_LENGTH
    ? `${collapsed.slice(0, MAX_CAPABILITY_OUTPUT_LENGTH - 3)}...`
    : collapsed;
}

/**
 * Re-verifies the required network capabilities on the file just installed
 * (N7) with a bounded, read-only `getcap <absolute installed matchlock>` probe.
 * A capability read proves only metadata (§10.7): whether the kernel honors it
 * at exec depends on the filesystem mount options. A probe that cannot be
 * spawned is reported as `unavailable`, never silently treated as verified.
 */
export async function probeInstalledMatchlockCapabilities(
  deps: MatchlockSetupDeps,
  matchlockPath: string,
): Promise<CapabilityProbeResult> {
  let result: RunCommandResult | undefined;
  try {
    result = await deps.runCommand(CAPABILITY_PROBE_COMMAND, [matchlockPath], {
      stdio: "pipe",
      timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    });
  } catch {
    result = undefined;
  }
  if (result === undefined) {
    return {
      verified: false,
      unavailable: true,
      found: [],
      missing: [...REQUIRED_MATCHLOCK_CAPABILITIES],
    };
  }
  const output = boundedCapabilityOutput(`${result.stdout}${result.stderr}`);
  const found = parseGetcapCapabilities(output);
  const missing = missingMatchlockCapabilities(found);
  return {
    verified: missing.length === 0,
    unavailable: false,
    found,
    missing,
    ...(output !== "" ? { output } : {}),
  };
}

/**
 * Resolves the binary the daemon is EXPECTED to resolve (N7):
 * `TAMANDUA_MATCHLOCK_RPC_BIN` when set (trimmed), else the first executable
 * `matchlock` on the operator PATH, else the bare name `matchlock`. The result
 * is a prediction labelled expected and is never presented as verified.
 */
export async function resolveExpectedDaemonBinary(
  deps: MatchlockSetupDeps,
  installedMatchlockPath: string,
): Promise<ExpectedBinaryReport> {
  const override = nonEmpty(deps.env[MATCHLOCK_RPC_BIN_ENV_NAME]);
  if (override !== undefined) {
    return {
      path: override,
      fromEnvOverride: true,
      resolvedFromPath: true,
      shadowed: override !== installedMatchlockPath,
    };
  }
  const onPath = await findExecutableOnPath(deps, MATCHLOCK_BINARY_NAME);
  const path = onPath ?? MATCHLOCK_BINARY_NAME;
  return {
    path,
    fromEnvOverride: false,
    resolvedFromPath: onPath !== undefined,
    shadowed: path !== installedMatchlockPath,
  };
}

/** Collects the stale MATCHLOCK_* overrides that win over the installed pair (N7). */
export function collectStaleMatchlockEnvOverrides(
  env: Record<string, string | undefined>,
): StaleEnvOverride[] {
  const stale: StaleEnvOverride[] = [];
  for (const name of STALE_MATCHLOCK_ENV_OVERRIDES) {
    const value = nonEmpty(env[name]);
    if (value !== undefined) stale.push({ name, value });
  }
  return stale;
}

/** The N7 warning naming a daemon-resolved binary that shadows the installed one. */
export function pathShadowWarning(
  expected: ExpectedBinaryReport,
  installedMatchlockPath: string,
): SetupWarning {
  return {
    code: MATCHLOCK_PATH_SHADOW_WARNING_CODE,
    message:
      `the daemon is expected to resolve matchlock to ${expected.path}` +
      `${
        expected.fromEnvOverride
          ? ` (${MATCHLOCK_RPC_BIN_ENV_NAME})`
          : expected.resolvedFromPath
            ? " (first on PATH)"
            : " (bare name; not found on PATH)"
      }, which differs from the installed ${installedMatchlockPath} ` +
      "(PATH shadowing; expected, not verified). Every phase here is bound to " +
      "the installed absolute path (N7), but a daemon without this override " +
      "would execute the shadowing binary.",
  };
}

/** The N7 warning naming one stale override that wins over the installed pair. */
export function staleEnvOverrideWarning(entry: StaleEnvOverride): SetupWarning {
  return {
    code: STALE_MATCHLOCK_ENV_WARNING_CODE,
    message:
      `stale environment override ${entry.name}=${entry.value} wins over the ` +
      "installed matchlock pair; unset it to use the installed binaries.",
  };
}

/** The bound N7/R4 fix for a missing capability on the installed file. */
export function capabilitiesFixCommand(euid: number, matchlockPath: string): string[] {
  return hostSetupCommand(euid, matchlockPath);
}

function verifyCapabilitiesFailure(
  capabilities: CapabilitiesReport,
): PrerequisiteFailure {
  const fix = capabilities.fixCommand?.join(" ") ?? `${capabilities.path} setup linux`;
  return {
    code: VERIFY_CAPABILITIES_MISSING_CODE,
    hard: true,
    message: [
      `matchlock setup: verify failed: the newly installed \`${capabilities.path}\` is missing`,
      `  required capabilities: ${capabilities.missing.join(", ")}. Readiness recorded for a`,
      "  different binary is not proof for the file just written (N7).",
      `  Fix: ${fix}`,
      "  Capabilities are metadata; if `getcap` shows them but they are ineffective, use a",
      "  --prefix on a filesystem that honors capabilities or change the mount options.",
    ].join("\n"),
  };
}

function imageReportLine(image: EffectiveImageReport): string {
  if (!image.present) {
    return `${image.reference} — not present in the local store`;
  }
  const bits = [image.reference];
  if (image.digest !== undefined) bits.push(`digest ${image.digest}`);
  if (image.source === "local") {
    bits.push("(source: local built/imported entry — accepted shadow override)");
  } else {
    bits.push("(source: registry cache)");
  }
  if (image.mismatchExplained) {
    bits.push(
      `— ${VERIFY_SHADOWED_LABEL}: registry pull reported ${image.pulledDigest} (informational)`,
    );
  }
  return bits.join(" ");
}

function kernelReportLine(kernel: KernelReport): string {
  if (kernel.status === "embedded") {
    return `embedded (vendored; offline by construction)${
      kernel.version !== undefined ? ` — ${kernel.version}` : ""
    }`;
  }
  if (kernel.status === "warmed") {
    const bits = ["warmed"];
    if (kernel.version !== undefined) bits.push(kernel.version);
    if (kernel.path !== undefined) bits.push(`(${kernel.path})`);
    if (kernel.alreadyPresent) bits.push("(already present)");
    return bits.join(" ");
  }
  return "missing";
}

function runnabilityLabel(status: RunnabilityStatus): string {
  switch (status) {
    case "relogin-required":
      return RUNNABILITY_RELOGIN_LABEL;
    case "host-not-ready":
      return RUNNABILITY_HOST_NOT_READY_LABEL;
    default:
      return RUNNABILITY_READY_LABEL;
  }
}

function capabilitiesReportLine(capabilities: CapabilitiesReport): string {
  switch (capabilities.status) {
    case "inapplicable":
      return "not applicable on this platform";
    case "unavailable":
      return (
        `NOT VERIFIED (${CAPABILITY_PROBE_COMMAND} unavailable) on ${capabilities.path} ` +
        "— the file exists but its capabilities could not be read"
      );
    case "missing": {
      const bits = [
        `MISSING on ${capabilities.path}`,
        `(missing: ${capabilities.missing.join(", ")})`,
      ];
      if (capabilities.fixCommand !== undefined) {
        bits.push(`— fix: ${capabilities.fixCommand.join(" ")}`);
      }
      return bits.join(" ");
    }
    default:
      return `verified (${capabilities.found.join(", ")}) on ${capabilities.path}`;
  }
}

function expectedBinaryReportLine(expected: ExpectedBinaryReport): string {
  const source = expected.fromEnvOverride
    ? `from ${MATCHLOCK_RPC_BIN_ENV_NAME}`
    : expected.resolvedFromPath
      ? "first on PATH"
      : "bare name; not found on PATH";
  const bits = [`${expected.path} (expected, never verified; ${source})`];
  if (expected.shadowed) {
    bits.push("— WARNING: differs from the installed path (PATH shadowing)");
  } else {
    bits.push("— matches the installed path");
  }
  return bits.join(" ");
}

function staleEnvOverridesLine(overrides: readonly StaleEnvOverride[]): string {
  if (overrides.length === 0) return "none";
  return overrides.map((entry) => `${entry.name}=${entry.value}`).join("; ");
}

/**
 * Renders the phase-4 verify report: diagnose verdict, installed version +
 * commit, the effective image digest/source, the warmed kernel (or `embedded`),
 * the N7 post-install checks (capabilities re-verified on the installed file,
 * the expected daemon-resolved binary, stale MATCHLOCK_* overrides), then the
 * explicit offline-readiness verdict separating ASSETS from RUNNABILITY
 * (R6/R11).
 */
export function renderVerifyReport(report: VerifyReport): string {
  const versionLine =
    report.version !== undefined
      ? `${report.version}${
          report.commit !== undefined ? ` (commit: ${report.commit})` : ""
        }`
      : "not reported";
  const assetsLine = report.assetsReady
    ? `  ${OFFLINE_ASSETS_READY_LABEL}`
    : `  ${OFFLINE_ASSETS_MISSING_LABEL} — ${report.missingAssets.join("; ")}`;
  return [
    VERIFY_REPORT_HEADING,
    `  diagnose: ${
      report.diagnoseReady ? "host is ready" : "host is NOT ready"
    }`,
    `  matchlock version: ${versionLine}`,
    `  capabilities: ${capabilitiesReportLine(report.capabilities)}`,
    `  expected daemon binary: ${expectedBinaryReportLine(report.expectedBinary)}`,
    `  stale env overrides: ${staleEnvOverridesLine(report.staleEnvOverrides)}`,
    `  image: ${imageReportLine(report.image)}`,
    `  kernel: ${kernelReportLine(report.kernel)}`,
    OFFLINE_READINESS_HEADING,
    assetsLine,
    `  ${runnabilityLabel(report.runnability)}`,
  ].join("\n");
}

function verifyVersionFailure(
  matchlockPath: string,
  identity: InstalledMatchlockIdentity,
  target: string,
): PrerequisiteFailure {
  return {
    code: "verify-version-mismatch",
    hard: true,
    message: [
      `matchlock setup: verify failed: the installed \`${matchlockPath}\` reports commit`,
      `  ${identity.commit} (version ${identity.version}) but the built target is ${target}.`,
      "  The installed binary does not match the synchronized submodule content.",
      "  Re-run `tamandua matchlock setup --force` to rebuild and reinstall the pinned pair.",
    ].join("\n"),
  };
}

function verifyDigestFailure(image: EffectiveImageReport): PrerequisiteFailure {
  return {
    code: "verify-image-digest-mismatch",
    hard: true,
    message: [
      `matchlock setup: verify failed: the effective image "${image.reference}" resolves to`,
      `  ${image.digest} but the registry pull reported ${image.pulledDigest}, and no local`,
      "  built/imported entry explains the difference. An unexplained resolution change is",
      "  never shadowed away; re-run `tamandua matchlock setup --refresh-image`.",
    ].join("\n"),
  };
}

function verifyReportDetails(report: VerifyReport): Record<string, unknown> {
  return {
    diagnoseReady: report.diagnoseReady,
    binariesPresent: report.binariesPresent,
    assetsReady: report.assetsReady,
    runnability: report.runnability,
    missingAssets: report.missingAssets,
    ...(report.version !== undefined ? { version: report.version } : {}),
    ...(report.commit !== undefined ? { commit: report.commit } : {}),
    image: {
      reference: report.image.reference,
      present: report.image.present,
      ...(report.image.digest !== undefined ? { digest: report.image.digest } : {}),
      ...(report.image.source !== undefined ? { source: report.image.source } : {}),
      ...(report.image.pulledDigest !== undefined
        ? { pulledDigest: report.image.pulledDigest }
        : {}),
      shadowed: report.image.shadowed,
      mismatch: report.image.mismatch,
      mismatchExplained: report.image.mismatchExplained,
    },
    kernel: {
      status: report.kernel.status,
      alreadyPresent: report.kernel.alreadyPresent,
      ...(report.kernel.version !== undefined ? { version: report.kernel.version } : {}),
      ...(report.kernel.path !== undefined ? { path: report.kernel.path } : {}),
    },
    capabilities: {
      status: report.capabilities.status,
      path: report.capabilities.path,
      found: report.capabilities.found,
      missing: report.capabilities.missing,
      ...(report.capabilities.fixCommand !== undefined
        ? { fixCommand: report.capabilities.fixCommand }
        : {}),
    },
    expectedBinary: {
      path: report.expectedBinary.path,
      fromEnvOverride: report.expectedBinary.fromEnvOverride,
      resolvedFromPath: report.expectedBinary.resolvedFromPath,
      shadowed: report.expectedBinary.shadowed,
    },
    staleEnvOverrides: report.staleEnvOverrides.map((entry) => ({
      name: entry.name,
      value: entry.value,
    })),
  };
}

/** Input phase 4 needs from the completed phase 1/2/3 work (R6). */
export interface VerifyPhaseInput {
  image: ImagePhaseResult;
  kernel?: KernelWarmResult;
  /** True when phase 2 changed group membership (leads the report). */
  reloginRequired: boolean;
  /** Target submodule content commit the installed binary must match (R6/R7). */
  targetCommit?: string;
}

/** Result of phase 4 verify (R6). */
export interface VerifyPhaseResult {
  /** Phase outcome for the orchestrator's `phases` array (`phase: 4`). */
  outcome: SetupPhaseOutcome;
  /** Structured report backing the rendered text. */
  report: VerifyReport;
  reloginRequired: boolean;
  /** True when the opt-in `--smoke` VM boot was actually attempted. */
  smokeRan: boolean;
  /** True when `--smoke` was refused because a re-login is pending. */
  smokeRefused: boolean;
  warnings: SetupWarning[];
}

/**
 * Phase 4 verify + report (R6). Re-runs the absolute installed
 * `<prefix>/matchlock diagnose`, reads `<prefix>/matchlock version`, resolves
 * the effective standard-image digest/source against the digest phase 3 pulled,
 * classifies the warmed kernel (or `embedded`), re-verifies the required
 * capabilities on the newly installed file (N7), names the binary the daemon is
 * expected to resolve and reports stale MATCHLOCK_* overrides, prints the
 * report, and ends with the R11 offline-readiness verdict separating ASSETS
 * from RUNNABILITY.
 *
 * Hard failures (non-zero): the installed version/commit does not match the
 * built target, the newly installed file lacks a required capability (N7), or
 * the effective image digest disagrees with the pulled digest with no local
 * shadow explaining it (an explained mismatch is reported as `shadowed`,
 * informational, and never masks another failure). A pending re-login leads the
 * report with the caveat and refuses `--smoke`; otherwise `--smoke` boots the
 * minimal `--no-network` VM through the injected runner.
 */
export async function runVerifyPhase(
  options: MatchlockSetupOptions,
  deps: MatchlockSetupDeps,
  effective: MatchlockEffectivePaths,
  input: VerifyPhaseInput,
): Promise<VerifyPhaseResult> {
  const warnings: SetupWarning[] = [];

  // Re-run diagnose on the just-installed binary (R6/N7).
  let diagnose: RunCommandResult | undefined;
  try {
    diagnose = await deps.runCommand(effective.matchlockPath, ["diagnose"], {
      stdio: "pipe",
      timeoutMs: VERIFY_DIAGNOSE_TIMEOUT_MS,
    });
  } catch {
    diagnose = undefined;
  }
  const diagnoseReady = diagnose !== undefined && diagnose.code === 0;

  // Installed version + commit (R6/R7).
  const identityProbe = await readInstalledMatchlockIdentity(deps, effective);

  // Effective image resolution vs the digest phase 3 pulled (R6/§4.3).
  let resolved: StoredImageEntry | undefined;
  try {
    resolved = await deps.resolveStoredImage(input.image.reference);
  } catch {
    resolved = undefined;
  }
  const image = classifyEffectiveImage({
    reference: input.image.reference,
    ...(resolved !== undefined ? { resolved } : {}),
    ...(input.image.digest !== undefined ? { pulledDigest: input.image.digest } : {}),
    imageStatus: input.image.outcome.status,
    imageSkipped: input.image.skipped,
  });

  const kernel = classifyWarmedKernel(input.kernel);
  const matchlockPresent = await safeExists(deps, effective.matchlockPath);
  const guestInitPresent = await safeExists(deps, effective.guestInitPath);
  const binariesPresent = matchlockPresent && guestInitPresent;

  // N7: re-verify the capabilities on the file just installed, even when the
  // pre-install diagnose passed. Readiness recorded for a different binary is
  // not proof for this one. `getcap` reads capability METADATA (§10.7).
  let capabilities: CapabilitiesReport;
  if (deps.platform !== "linux") {
    capabilities = {
      status: "inapplicable",
      path: effective.matchlockPath,
      found: [],
      missing: [],
    };
  } else {
    const probe = await probeInstalledMatchlockCapabilities(deps, effective.matchlockPath);
    const status: ReportCapabilityStatus = probe.verified
      ? "verified"
      : probe.unavailable
        ? "unavailable"
        : "missing";
    capabilities = {
      status,
      path: effective.matchlockPath,
      found: probe.found,
      missing: probe.missing,
      ...(probe.output !== undefined ? { output: probe.output } : {}),
      ...(status === "missing"
        ? { fixCommand: capabilitiesFixCommand(deps.euid, effective.matchlockPath) }
        : {}),
    };
    if (status === "unavailable") {
      deps.output.warn(
        `matchlock setup: verify: could not re-verify capabilities on ` +
          `${effective.matchlockPath} (${CAPABILITY_PROBE_COMMAND} unavailable); ` +
          "the file exists but a missing capability can be neither confirmed nor ruled out.",
      );
    }
  }

  // N7: name the binary the daemon is EXPECTED to resolve (prediction only) and
  // report stale MATCHLOCK_* overrides that win over the installed pair.
  const expectedBinary = await resolveExpectedDaemonBinary(deps, effective.matchlockPath);
  const staleEnvOverrides = collectStaleMatchlockEnvOverrides(deps.env);
  if (expectedBinary.shadowed) {
    warnings.push(pathShadowWarning(expectedBinary, effective.matchlockPath));
  }
  for (const entry of staleEnvOverrides) {
    warnings.push(staleEnvOverrideWarning(entry));
  }

  const missingAssets: string[] = [];
  if (!binariesPresent) {
    missingAssets.push(`the installed matchlock/guest-init pair (${BINARIES_MISSING_REMEDY})`);
  }
  if (!image.present) {
    missingAssets.push(`the standard image "${image.reference}" (${IMAGE_MISSING_REMEDY})`);
  }
  if (kernel.status === "missing") {
    missingAssets.push(`the guest kernel (${KERNEL_MISSING_REMEDY})`);
  }
  const assetsReady = missingAssets.length === 0;

  // Runnability is never implied by assets readiness (R6/R11): a pending
  // re-login, a failing diagnose, or a missing capability on the installed file
  // still blocks VM boots. An unreadable capability is not proof of a missing
  // one, so only `missing` blocks here.
  const runnability: RunnabilityStatus = input.reloginRequired
    ? "relogin-required"
    : diagnoseReady && capabilities.status !== "missing"
      ? "ready"
      : "host-not-ready";

  const report: VerifyReport = {
    diagnoseReady,
    ...(identityProbe.ok
      ? { version: identityProbe.identity.version, commit: identityProbe.identity.commit }
      : {}),
    image,
    kernel,
    binariesPresent,
    assetsReady,
    missingAssets,
    runnability,
    capabilities,
    expectedBinary,
    staleEnvOverrides,
  };

  // Hard failures (R6/§4.3). A shadow-explained digest mismatch is deliberately
  // NOT a failure: it is reported as `shadowed` and never masks a real one. A
  // missing capability on the newly installed file fails verify until fixed,
  // printing the identity-selected bound command (N7) — but only when the file
  // is actually present (a missing pair is already an assets failure).
  let failure: PrerequisiteFailure | undefined;
  if (!identityProbe.ok) {
    failure = identityProbe.failure;
  } else if (
    input.targetCommit !== undefined &&
    !matchlockCommitMatches(identityProbe.identity.commit, input.targetCommit)
  ) {
    failure = verifyVersionFailure(
      effective.matchlockPath,
      identityProbe.identity,
      input.targetCommit,
    );
  } else if (capabilities.status === "missing" && matchlockPresent) {
    failure = verifyCapabilitiesFailure(capabilities);
  } else if (image.mismatch && !image.mismatchExplained) {
    failure = verifyDigestFailure(image);
  }

  const rendered = renderVerifyReport(report);
  const reportMessage = input.reloginRequired
    ? `${RELOGIN_CAVEAT_MESSAGE}\n${rendered}`
    : rendered;
  deps.output.log(reportMessage);
  if (!diagnoseReady) {
    deps.output.warn(
      "matchlock setup: verify: matchlock diagnose reports the host is NOT ready" +
        (diagnose === undefined ? " (probe could not be spawned)." : ` (exit ${diagnose.code}).`),
    );
  }

  // --smoke (R6): opt-in minimal `--no-network` VM. Refused while a fresh
  // login session is required; otherwise booted through the injected runner.
  let smokeRan = false;
  let smokeRefused = false;
  let smokeNote: string | undefined;
  if (options.smoke) {
    if (input.reloginRequired) {
      smokeRefused = true;
      deps.output.warn(SMOKE_RELOGIN_REFUSAL_MESSAGE);
      warnings.push({
        code: "smoke-refused-relogin",
        message: SMOKE_RELOGIN_REFUSAL_MESSAGE,
      });
      smokeNote = SMOKE_RELOGIN_REFUSAL_MESSAGE;
    } else {
      const command = matchlockSmokeCommand(input.image.reference);
      let smoke: RunCommandResult | undefined;
      try {
        smoke = await deps.runCommand(effective.matchlockPath, command, {
          stdio: "inherit",
          timeoutMs: SMOKE_TIMEOUT_MS,
        });
      } catch {
        smoke = undefined;
      }
      smokeRan = true;
      if (smoke !== undefined && smoke.code === 0) {
        smokeNote =
          `matchlock setup: smoke VM booted (\`${effective.matchlockPath} ${command.join(" ")}\`)`;
        deps.output.log(smokeNote);
      } else {
        const detail = smoke === undefined ? "could not be spawned" : `exited ${smoke.code}`;
        smokeNote =
          `matchlock setup: --smoke failed: \`${effective.matchlockPath} ${command.join(" ")}\` ${detail}. ` +
          "Re-run after fixing the host.";
        deps.output.warn(smokeNote);
        warnings.push({ code: "smoke-failed", message: smokeNote });
      }
    }
  }

  const details = {
    ...verifyReportDetails(report),
    smokeRan,
    smokeRefused,
  };

  if (failure !== undefined) {
    deps.output.warn(failure.message);
    return {
      outcome: {
        phase: 4,
        name: "verify",
        status: "failed",
        message: failure.message,
        details: { ...details, reason: failure.code },
      },
      report,
      reloginRequired: input.reloginRequired,
      smokeRan,
      smokeRefused,
      warnings,
    };
  }

  return {
    outcome: {
      phase: 4,
      name: "verify",
      status: "ok",
      message: smokeNote !== undefined ? `${reportMessage}\n${smokeNote}` : reportMessage,
      details,
    },
    report,
    reloginRequired: input.reloginRequired,
    smokeRan,
    smokeRefused,
    warnings,
  };
}

/** Public-entry input: parsed options or raw CLI args. */
export type MatchlockSetupInput = MatchlockSetupOptions | readonly string[];

/** The §2 refusal text for running as root without the R12 override. */
export const ROOT_REFUSAL_MESSAGE = [
  "matchlock setup: refusing to run as root.",
  "  `tamandua matchlock setup` exists so that matchlock itself never needs root: it",
  "  builds/installs per-user binaries and provisions per-user assets, so as root they",
  "  would land in root's HOME (~/.local/bin, ~/.cache/matchlock) instead of yours.",
  "  Re-run as your ordinary user (plain `tamandua matchlock setup`, no sudo). The",
  "  only privileged step is the one-time sudo host preparation in phase 2 (matchlock's",
  "  own guidance: sudo only for its setup commands, never for run/exec).",
  "  If you insist, re-run with:",
  `    ${ROOT_OVERRIDE_FLAG}`,
  "  Root-owned locations will be named explicitly in the report.",
].join("\n");

function refusedResult(refusal: SetupRefusal): MatchlockSetupResult {
  return {
    status: "refused",
    phases: [],
    reloginRequired: false,
    effective: null,
    refusal,
    message: refusal.message,
  };
}

/** Heading for the exact remaining manual commands printed on a failed run (N1). */
export const REMAINING_COMMANDS_HEADING =
  "matchlock setup: remaining manual commands (absolute installed paths):";

/** Renders the remaining-command guidance block (N1/N7). */
export function renderRemainingCommands(commands: readonly string[]): string {
  return [REMAINING_COMMANDS_HEADING, ...commands.map((command) => `    ${command}`)].join(
    "\n",
  );
}

/**
 * The exact manual commands that finish a failed run (N1/N7), derived from the
 * per-phase outcomes. A phase that is `ok`/`skipped` leaves nothing to do; a
 * `failed` or `not-run` phase contributes its bound remediation:
 * - phase 2 (host setup) → the identity-selected `[sudo] <abs> setup linux`;
 * - phase 3 (boot assets) → `<abs> pull [--force] <effective ref>` and
 *   `<abs> kernel pull`;
 * - phase 4 (verify) → the bound capability fix when capabilities are missing.
 * Every command names the absolute installed path; `sudo` appears only for a
 * non-root caller.
 */
export function remainingSetupCommands(
  phases: readonly SetupPhaseOutcome[],
  euid: number,
  effective: MatchlockEffectivePaths,
  reference: string,
  refreshImage: boolean,
): string[] {
  const commands: string[] = [];
  const push = (command: string): void => {
    if (!commands.includes(command)) commands.push(command);
  };
  const hostSetup = hostSetupCommand(euid, effective.matchlockPath).join(" ");
  for (const phase of phases) {
    if (phase.status === "ok" || phase.status === "skipped") continue;
    if (phase.phase === 2) {
      push(hostSetup);
    } else if (phase.phase === 3) {
      push(
        [effective.matchlockPath, ...matchlockPullCommand(reference, refreshImage)].join(" "),
      );
      push([effective.matchlockPath, ...matchlockKernelPullCommand()].join(" "));
    } else if (phase.phase === 4) {
      const reason = (phase.details as { reason?: string } | undefined)?.reason;
      if (reason === VERIFY_CAPABILITIES_MISSING_CODE) push(hostSetup);
    }
  }
  return commands;
}

/** A later phase that never ran because phase 1 aborted the run (N1). */
function notRunPhase(phase: number, name: string): SetupPhaseOutcome {
  return {
    phase,
    name,
    status: "not-run",
    message: `matchlock setup: phase ${phase} (${name}) not run: phase 1 aborted the run (N1).`,
    details: { reason: "phase-1-aborted" },
  };
}

/**
 * Phase 1 hard failure (N1): the run aborts, later phases are marked `not-run`,
 * and the previously installed binaries/store are untouched. `warnings` carries
 * any already-collected warnings (e.g. submodule drift); the bound remaining
 * commands are derived from the not-run phases.
 */
function phaseOneFailureResult(
  failure: PrerequisiteFailure,
  effective: MatchlockEffectivePaths,
  warnings: readonly SetupWarning[],
  context: { euid: number; reference: string; refreshImage: boolean },
): MatchlockSetupResult {
  const phases: SetupPhaseOutcome[] = [
    {
      phase: 1,
      name: "binaries",
      status: "failed",
      message: failure.message,
      details: { reason: failure.code },
    },
    notRunPhase(2, "host-setup"),
    notRunPhase(3, "boot-assets"),
    notRunPhase(4, "verify"),
  ];
  const remaining = remainingSetupCommands(
    phases,
    context.euid,
    effective,
    context.reference,
    context.refreshImage,
  );
  const remainingBlock = remaining.length > 0 ? renderRemainingCommands(remaining) : "";
  return {
    status: "failed",
    phases,
    reloginRequired: false,
    effective,
    failure,
    ...(remaining.length > 0 ? { remainingCommands: remaining } : {}),
    ...warningsField(warnings),
    message:
      remainingBlock === "" ? failure.message : `${failure.message}\n${remainingBlock}`,
  };
}

/** Context for the bound remaining-command guidance (N1/N7). */
function remainingCommandContext(
  deps: MatchlockSetupDeps,
  options: MatchlockSetupOptions,
): { euid: number; reference: string; refreshImage: boolean } {
  return {
    euid: deps.euid,
    reference: effectiveImageReference(deps).reference,
    refreshImage: options.refreshImage,
  };
}

function effectiveAccount(deps: MatchlockSetupDeps): string {
  if (deps.euid === 0) return "root";
  return (
    nonEmpty(deps.env.USER) ??
    nonEmpty(deps.env.LOGNAME) ??
    nonEmpty(deps.env.USERNAME) ??
    "user"
  );
}

function accountHomeFromDatabase(
  deps: MatchlockSetupDeps,
  account: string,
): string | undefined {
  try {
    return nonEmpty(deps.accountHomeResolver(account));
  } catch {
    return undefined;
  }
}

interface ResolveEffectiveResult {
  effective?: MatchlockEffectivePaths;
  refusal?: SetupRefusal;
}

function resolveEffectivePaths(
  options: MatchlockSetupOptions,
  deps: MatchlockSetupDeps,
): ResolveEffectiveResult {
  if (options.prefix !== undefined && !isAbsolute(options.prefix)) {
    return {
      refusal: {
        code: "prefix-not-absolute",
        message:
          `matchlock setup: --prefix must be an absolute path (got "${options.prefix}"). ` +
          "Every phase is bound to absolute installed paths (N7).",
      },
    };
  }

  const account = effectiveAccount(deps);
  const databaseHome = accountHomeFromDatabase(deps, account);

  let home: string | undefined;
  if (deps.euid === 0) {
    // Forced-root mode: never inherit a HOME naming another user's dirs (R12).
    home = databaseHome;
    if (home === undefined) {
      return {
        refusal: {
          code: "account-home-unresolved",
          message:
            `matchlock setup: cannot resolve the home directory of account "${account}" ` +
            "from the account database. Refusing to fall back to an inherited HOME " +
            "under forced-root mode (R12).",
        },
      };
    }
  } else {
    home = nonEmpty(deps.env.HOME) ?? databaseHome;
    if (home === undefined) {
      return {
        refusal: {
          code: "home-unresolved",
          message:
            "matchlock setup: cannot determine the effective home directory " +
            "(HOME is unset and the account database has no entry).",
        },
      };
    }
  }

  return {
    effective: resolveMatchlockPaths({
      platform: deps.platform,
      account,
      home,
      prefix: options.prefix,
    }),
  };
}

/**
 * Runs `tamandua matchlock setup`.
 *
 * The privilege preflight (R12), absolute-path binding (N7), the R8
 * prerequisite gates, the R9 phase-1 content sync and the Go-minimum gate run
 * before any phase (and before any build/install/host change). Later stories
 * append the build, install and the four phases. Accepts parsed options or raw
 * args (unknown flags become a typed refusal here, never an uncaught throw).
 */
export async function runMatchlockSetup(
  input: MatchlockSetupInput,
  deps: MatchlockSetupDeps,
): Promise<MatchlockSetupResult> {
  let options: MatchlockSetupOptions;
  if (Array.isArray(input)) {
    const parsed = parseMatchlockSetupArgs(input);
    if (!parsed.ok) {
      deps.output.warn(parsed.refusal.message);
      return refusedResult(parsed.refusal);
    }
    options = parsed.options;
  } else {
    options = input as MatchlockSetupOptions;
  }

  // Privilege preflight (R12): refuse before any phase. A bare --force never
  // implies consent.
  if (deps.euid === 0 && !options.forceMatchlockUsageAsRoot) {
    const refusal: SetupRefusal = {
      code: "root-refused",
      message: ROOT_REFUSAL_MESSAGE,
    };
    deps.output.warn(refusal.message);
    return refusedResult(refusal);
  }

  const resolved = resolveEffectivePaths(options, deps);
  if (resolved.effective === undefined) {
    const refusal = resolved.refusal ?? {
      code: "effective-paths-unresolved",
      message: "matchlock setup: cannot resolve the effective absolute paths.",
    };
    deps.output.warn(refusal.message);
    return refusedResult(refusal);
  }

  const effective = resolved.effective;

  // N1/R12: every phase child is bound to the effective account context. The
  // wrapper forces the effective HOME (and thus the store/cache paths derived
  // from it) into EVERY child, so a forced-root run never inherits another
  // user's HOME; `--prefix` still governs the install location.
  const phaseDeps = applyEffectiveEnv(deps, effective);
  const remainingContext = remainingCommandContext(deps, options);

  // R8 prerequisite gates: before any mutation and before the content sync.
  // Missing `go` is the unconditional non-zero hard failure.
  const prerequisites = await checkPrerequisites(phaseDeps);
  if (!prerequisites.ok) {
    const failure = prerequisites.failure;
    deps.output.warn(failure.message);
    if (failure.hard) {
      return phaseOneFailureResult(failure, effective, [], remainingContext);
    }
    return refusedResult({ code: failure.code, message: failure.message });
  }

  // Phase 1 content sync + R9 submodule guards (N3). This never stages or
  // commits anything; a content-vs-gitlink drift is reported as a warning.
  const sync = await syncMatchlockSubmodule(options, phaseDeps);
  if (!sync.ok) {
    deps.output.warn(sync.refusal.message);
    return refusedResult(sync.refusal);
  }
  deps.output.log(sync.message);

  const warnings: SetupWarning[] = [];
  if (sync.warning !== undefined) warnings.push(sync.warning);

  // Phase 1's first check after the content sync (R8/US-004): verify the exact
  // Go minimum read from the synchronized go.mod with GOTOOLCHAIN=local. This
  // is a HARD failure before any build, install or host change, and it gates a
  // would-be no-op invocation too.
  const goCheck = await checkGoMinimum(phaseDeps, prerequisites.goPath);
  if (!goCheck.ok) {
    const failure = goCheck.failure;
    deps.output.warn(failure.message);
    return phaseOneFailureResult(failure, effective, warnings, remainingContext);
  }

  // R7 idempotency: when both installed binaries are present and the installed
  // `matchlock version` reports the target submodule commit, this re-run is a
  // no-op (`already at <sha>`) unless --force. The build and install are
  // skipped, but the run continues: phases 2-4 stay cache-aware and independent
  // (R7/§4.4). --force is handled here only; the R9 dirty check (above) and the
  // R12 root gate (top of this function) are never overridden by it.
  let idempotent = false;
  let idempotentMessage: string | undefined;
  const targetCommit = sync.contentSha;
  if (
    !options.force &&
    targetCommit !== undefined &&
    (await installedBinariesPresent(phaseDeps, effective))
  ) {
    const probe = await readInstalledMatchlockIdentity(phaseDeps, effective);
    if (!probe.ok) {
      const failure = probe.failure;
      deps.output.warn(failure.message);
      return phaseOneFailureResult(failure, effective, warnings, remainingContext);
    }
    if (matchlockCommitMatches(probe.identity.commit, targetCommit)) {
      idempotent = true;
      idempotentMessage =
        `matchlock setup: already at ${targetCommit} (installed ${probe.identity.version}); ` +
        "skipping the build and install (R7; pass --force to rebuild)";
      deps.output.log(idempotentMessage);
    }
  }

  if (!idempotent) {
    // Phase 1 build (R2): replicate the fork's pinned recipe. Every `go`
    // invocation carries GOTOOLCHAIN=local; a failure is a phase-1 hard failure
    // and the previously installed binaries are untouched (§4.3).
    const build = await buildMatchlockBinaries(phaseDeps, prerequisites.goPath, effective);
    if (!build.ok) {
      const failure = build.failure;
      deps.output.warn(failure.message);
      return phaseOneFailureResult(failure, effective, warnings, remainingContext);
    }
    deps.output.log(build.message);

    // Phase 1 install (R3): publish both binaries atomically into the resolved
    // prefix. A non-writable prefix is a refusal naming remedies (never a silent
    // sudo); any other install failure is a phase-1 hard failure that leaves the
    // previously installed binaries untouched.
    const install = await installMatchlockBinaries(phaseDeps, effective, build);
    if (!install.ok) {
      if (install.failure !== undefined) {
        const failure = install.failure;
        deps.output.warn(failure.message);
        return phaseOneFailureResult(failure, effective, warnings, remainingContext);
      }
      const refusal = install.refusal ?? {
        code: "install-refused",
        message: "matchlock setup: refusing to install the binaries into the prefix.",
      };
      deps.output.warn(refusal.message);
      return refusedResult(refusal);
    }
    deps.output.log(install.message);
  }

  // Phase 2 host setup (R4, linux only): an independent phase — a failure here
  // marks the phase failed and the run non-zero but must NOT abort before
  // phase 3. The gate is the absolute installed `matchlock diagnose`.
  const phases: SetupPhaseOutcome[] = [];
  const hostSetup = await runHostSetupPhase(options, phaseDeps, effective);
  phases.push(hostSetup.outcome);
  const reloginRequired = hostSetup.reloginRequired;

  // Phase 3 boot assets (R5/R11): independent of phase 2 (a phase-2 failure
  // never blocks it). Shadow warning → mkfs.erofs gate → disk-space floor →
  // cache-aware `matchlock pull [--force]` → guest-kernel warm. `--no-image`
  // skips only the pull, so the kernel warm still runs. Gate refusals and pull
  // failures mark the phase failed (non-zero exit) without a hard abort; the
  // kernel warm is skipped when the image sub-step failed (retry after fixing
  // it) and otherwise runs after it.
  const image = await runImagePhase(options, phaseDeps, effective);
  const kernel =
    image.outcome.status === "failed"
      ? undefined
      : await runKernelWarmPhase(phaseDeps, effective);
  phases.push(combineBootAssetsPhase(image, kernel));
  warnings.push(...image.warnings, ...(kernel?.warnings ?? []));

  // Phase 4 verify + report (R6). This runs even when phase 2 or 3 failed so
  // the operator gets a combined readiness report; it owns the R11
  // offline-readiness verdict and the opt-in `--smoke` boot (refused while a
  // re-login is pending, §4.3).
  const verify = await runVerifyPhase(options, phaseDeps, effective, {
    image,
    ...(kernel !== undefined ? { kernel } : {}),
    reloginRequired,
    ...(targetCommit !== undefined ? { targetCommit } : {}),
  });
  phases.push(verify.outcome);
  warnings.push(...verify.warnings);

  emitSetupWarnings(deps.output, warnings);

  const failedPhase = phases.find((phase) => phase.status === "failed");
  if (failedPhase !== undefined) {
    // N1: exit non-zero if ANY phase failed (2 and 3 are independent; phase 4
    // always reports the combined state) and print the exact remaining manual
    // commands, each bound to the absolute installed path and selected by
    // effective identity.
    const remaining = remainingSetupCommands(
      phases,
      remainingContext.euid,
      effective,
      remainingContext.reference,
      remainingContext.refreshImage,
    );
    const remainingBlock = remaining.length > 0 ? renderRemainingCommands(remaining) : "";
    if (remainingBlock !== "") deps.output.warn(remainingBlock);
    return {
      status: "failed",
      phases,
      reloginRequired,
      effective,
      ...(idempotent ? { idempotent: true } : {}),
      ...warningsField(warnings),
      ...(remaining.length > 0 ? { remainingCommands: remaining } : {}),
      message:
        remainingBlock === "" ? failedPhase.message : `${failedPhase.message}\n${remainingBlock}`,
    };
  }

  return {
    status: "ok",
    phases,
    reloginRequired,
    effective,
    ...(idempotent ? { idempotent: true } : {}),
    ...warningsField(warnings),
    message: idempotentMessage ?? sync.message,
  };
}
