/**
 * US-001 unit tests for the pure `matchlock setup` core.
 *
 * Injected runner/fs/platform/env/euid seams only: no child_process import, no
 * network, no real git, no sudo, no VM. This file therefore runs in the
 * PARALLEL lane and must NOT be listed in tests/serial-files.txt.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BUILD_FAILED_NOTHING_INSTALLED_TRAILER,
  BUILD_TIMEOUT_MS,
  CAPABILITY_PROBE_COMMAND,
  CAPABILITY_PROBE_TIMEOUT_MS,
  DARWIN_DEFAULT_PREFIX,
  DEFAULT_KERNEL_PULL_TIMEOUT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  GO_VERSION_TIMEOUT_MS,
  GOTOOLCHAIN_ENV_NAME,
  GOTOOLCHAIN_LOCAL,
  GUEST_INIT_BUILD_OUTPUT,
  GUEST_INIT_BUILD_PACKAGE,
  HOST_SETUP_ALREADY_READY_MESSAGE,
  HOST_SETUP_DIAGNOSE_TIMEOUT_MS,
  HOST_SETUP_MACOS_SKIP_MESSAGE,
  HOST_SETUP_SKIPPED_MESSAGE,
  HOST_SETUP_TIMEOUT_MS,
  IMAGE_MISSING_REMEDY,
  IMAGE_SKIPPED_MESSAGE,
  IMAGE_STORE_MIN_FREE_BYTES,
  IMAGE_STORE_MIN_FREE_LABEL,
  INSTALL_FAILED_TRAILER,
  KERNEL_ALREADY_PRESENT_LABEL,
  KERNEL_MISSING_REMEDY,
  KERNEL_WARM_MISSING_COMMAND_REMEDY,
  MATCHLOCK_BUILD_OUTPUT,
  MATCHLOCK_BUILD_PACKAGE,
  MATCHLOCK_BINARY_NAME,
  MATCHLOCK_PATH_SHADOW_WARNING_CODE,
  MATCHLOCK_RPC_BIN_ENV_NAME,
  INSTALLED_VERSION_UNPARSEABLE_TRAILER,
  MATCHLOCK_ENTITLEMENTS_FILE,
  MATCHLOCK_FORK_URL,
  MATCHLOCK_IMAGE_ENV_NAME,
  MATCHLOCK_KERNEL_COMMAND,
  MATCHLOCK_KERNEL_PULL_ARG,
  MATCHLOCK_PULL_FORCE_ARG,
  MATCHLOCK_SUBMODULE_NAME,
  MATCHLOCK_VERSION_FILE,
  MATCHLOCK_VERSION_PACKAGE,
  MAX_KERNEL_OUTPUT_TAIL_LENGTH,
  MAX_SETUP_WARNING_LENGTH,
  MKFS_EROFS_BINARY,
  OFFLINE_ASSETS_MISSING_LABEL,
  OFFLINE_ASSETS_READY_LABEL,
  OFFLINE_READINESS_HEADING,
  POST_SYNC_NOTHING_CHANGED_TRAILER,
  PULL_TIMEOUT_ENV_NAME,
  RELOGIN_CAVEAT,
  RELOGIN_CAVEAT_MESSAGE,
  REMAINING_COMMANDS_HEADING,
  REQUIRED_MATCHLOCK_CAPABILITIES,
  ROOT_OVERRIDE_FLAG,
  RUNNABILITY_HOST_NOT_READY_LABEL,
  RUNNABILITY_READY_LABEL,
  RUNNABILITY_RELOGIN_LABEL,
  SDKROOT_NOTE,
  SMOKE_RELOGIN_REFUSAL_MESSAGE,
  SMOKE_TIMEOUT_MS,
  STALE_MATCHLOCK_ENV_OVERRIDES,
  STALE_MATCHLOCK_ENV_WARNING_CODE,
  STANDARD_IMAGE_REFERENCE,
  VERIFY_CAPABILITIES_MISSING_CODE,
  VERIFY_DIAGNOSE_TIMEOUT_MS,
  VERIFY_REPORT_HEADING,
  VERIFY_SHADOWED_LABEL,
  VERSION_PROBE_TIMEOUT_MS,
  buildMatchlockBinaries,
  capabilitiesFixCommand,
  checkGoMinimum,
  checkPrerequisites,
  classifyEffectiveImage,
  classifyWarmedKernel,
  collectStaleMatchlockEnvOverrides,
  combineBootAssetsPhase,
  compareGoVersions,
  defaultPrefixForPlatform,
  effectiveImageReference,
  emitSetupWarnings,
  ensureMatchlockInstallPrefix,
  findExecutableOnPath,
  formatFreeSpace,
  formatGoVersion,
  formatSetupWarning,
  gitmodulesDeclaresSubmodule,
  gitmodulesSubmoduleUrl,
  goToolchainEnv,
  guestInitGoArch,
  hostSetupCommand,
  hostSetupEffects,
  installMatchlockBinaries,
  kernelPullCommandMissing,
  matchlockCommitMatches,
  matchlockChildEnv,
  matchlockKernelPullCommand,
  matchlockLdflags,
  matchlockPullCommand,
  matchlockSmokeCommand,
  missingMatchlockCapabilities,
  parseDirtyPaths,
  parseGetcapCapabilities,
  parseGitlink,
  parseGoDirective,
  parseGoVersionOutput,
  parseGitmodulesSubmodule,
  parseKernelPullOutput,
  parseMatchlockSetupArgs,
  parseMatchlockVersionOutput,
  parsePullDigest,
  parseSubmoduleStatus,
  pathShadowWarning,
  probeInstalledMatchlockCapabilities,
  pullTimeoutMs,
  readInstalledMatchlockIdentity,
  remainingSetupCommands,
  renderRemainingCommands,
  renderVerifyReport,
  resolveExpectedDaemonBinary,
  resolveMatchlockPaths,
  runHostSetupPhase,
  runImagePhase,
  runKernelWarmPhase,
  runMatchlockSetup,
  runVerifyPhase,
  smokeRefusedByRelogin,
  staleEnvOverrideWarning,
  syncMatchlockSubmodule,
  warningsField,
  type ExpectedBinaryReport,
  type KernelWarmResult,
  type MatchlockBuildSuccess,
  type MatchlockEffectivePaths,
  type MatchlockSetupDeps,
  type MatchlockSetupFs,
  type MatchlockSetupOptions,
  type PrerequisiteCheckResult,
  type RunCommand,
  type RunCommandOptions,
  type RunCommandResult,
  type StaleEnvOverride,
  type StoredImageEntry,
  type VerifyPhaseResult,
  type VerifyReport,
} from "../../dist/installer/matchlock-setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

interface FakeDepsOverrides {
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
  euid?: number;
  accountHomes?: Record<string, string>;
  /** Resolved source checkout root (default "/repo"). */
  sourcePath?: string;
  /**
   * When true (default) the fake starts from a provisioned host: a git
   * worktree at `sourcePath`, a registered `matchlock` submodule, and `git`/`go`
   * on PATH. Tests that probe a missing prerequisite set this to false and seed
   * exactly the files/dirs they need.
   */
  useDefaultHost?: boolean;
  /** Extra files (path -> contents) on the fake filesystem. */
  files?: Record<string, string>;
  /** Extra directories on the fake filesystem. */
  dirs?: string[];
  /** Existing files that are NOT executable (everything else known is). */
  nonExecutables?: string[];
  /** Existing directories that are NOT writable (R3 prefix-refusal tests). */
  nonWritableDirs?: string[];
  fs?: Partial<MatchlockSetupFs>;
  /**
   * Image-store entries keyed by reference (R5 shadow checks). A `local` entry
   * models a locally built/imported image that shadows the registry cache; an
   * absent key is a store miss.
   */
  imageEntries?: Record<string, StoredImageEntry>;
  /** Free space in bytes on the image-store filesystem (default 64 GiB). */
  freeSpaceBytes?: number;
  /**
   * Optional runner stub consulted before the built-in fake responses. Return
   * `undefined` to fall through to the default (provisioned-host) response, so
   * a test only has to describe the calls it changes.
   */
  onRun?: (
    command: string,
    args: string[],
    options?: RunCommandOptions,
  ) => RunCommandResult | undefined | Promise<RunCommandResult | undefined>;
}

export interface FakeMatchlockSetupDeps extends MatchlockSetupDeps {
  calls: { command: string; args: string[]; options?: RunCommandOptions }[];
  logs: string[];
  warns: string[];
  fsWrites: string[];
}

/** A `.gitmodules` declaring the registered `matchlock` submodule. */
const GITMODULES_FIXTURE = [
  '[submodule "matchlock"]',
  "\tpath = matchlock",
  "\turl = https://github.com/igorhvr/matchlock.git",
  "",
].join("\n");

/** The synchronized submodule's `go.mod` and its Go minimum (US-004). */
const GO_MOD_FIXTURE = [
  "module github.com/jingkaihe/matchlock",
  "",
  "go 1.25.5",
  "",
].join("\n");

/** Well-formed local toolchain output for the default fake host. */
const GO_VERSION_FIXTURE = "go version go1.25.5 linux/amd64\n";

/** The submodule `VERSION.txt` the build recipe bakes into the ldflags (US-005). */
const VERSION_FIXTURE = "1.2.3\n";

const GITLINK_SHA = "a".repeat(40);

/**
 * `matchlock version` output of a provisioned host (US-007). The fork prints an
 * abbreviated commit, which the R7 matcher must accept against the full target.
 */
const MATCHLOCK_VERSION_FIXTURE =
  `matchlock 0.2.17 (commit: ${GITLINK_SHA.slice(0, 7)}, built: Wed Sep 23 09:34:18 UTC 2026)\n`;

/** Both default installed paths (linux ~/.local/bin) for R7 no-op fixtures. */
const INSTALLED_MATCHLOCK_PATH = "/home/kaladin/.local/bin/matchlock";
const INSTALLED_GUEST_INIT_PATH = "/home/kaladin/.local/bin/guest-init";

/**
 * Reusable fake seam bundle for the whole `matchlock-setup.test.ts` suite.
 * Later stories extend the same test file (and thus reuse this helper).
 */
export function createFakeDeps(
  overrides: FakeDepsOverrides = {},
): FakeMatchlockSetupDeps {
  const calls: FakeMatchlockSetupDeps["calls"] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const fsWrites: string[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const pathValue = overrides.env?.PATH ?? "/usr/bin";
  const sourcePath = overrides.sourcePath ?? "/repo";

  if (overrides.useDefaultHost ?? true) {
    files.set(`${sourcePath}/.gitmodules`, GITMODULES_FIXTURE);
    files.set(`${sourcePath}/${MATCHLOCK_SUBMODULE_NAME}/go.mod`, GO_MOD_FIXTURE);
    files.set(
      `${sourcePath}/${MATCHLOCK_SUBMODULE_NAME}/${MATCHLOCK_VERSION_FILE}`,
      VERSION_FIXTURE,
    );
    files.set("/usr/bin/git", "");
    files.set("/usr/bin/go", "");
    // Phase 3's image gate needs `mkfs.erofs` on PATH; tests that exercise the
    // missing-binary remedy pass it in `nonExecutables`.
    files.set("/usr/bin/mkfs.erofs", "");
    dirs.add(`${sourcePath}/.git`);
    // The provisioned host has a writable install prefix (R3) so the atomic
    // install succeeds by default. R3 refusal tests seed `nonWritableDirs`
    // (or override `isWritableDir`) instead.
    dirs.add("/home/kaladin/.local/bin");
    dirs.add("/root/.local/bin");
    dirs.add("/opt/matchlock/bin");
    dirs.add(DARWIN_DEFAULT_PREFIX);
  }
  for (const [p, contents] of Object.entries(overrides.files ?? {})) {
    files.set(p, contents);
  }
  for (const d of overrides.dirs ?? []) {
    dirs.add(d);
  }
  const nonExecutables = new Set(overrides.nonExecutables ?? []);
  const nonWritableDirs = new Set(overrides.nonWritableDirs ?? []);

  const baseFs: MatchlockSetupFs = {
    exists: (p) => files.has(p) || dirs.has(p),
    isFile: (p) => files.has(p),
    isExecutable: (p) => files.has(p) && !nonExecutables.has(p),
    isWritableDir: (p) => dirs.has(p) && !nonWritableDirs.has(p),
    readTextFile: (p) => files.get(p) ?? "",
    writeFile: (p, contents) => {
      fsWrites.push(`write:${p}`);
      files.set(p, contents);
    },
    copyFile: (from, to) => {
      fsWrites.push(`copy:${from}->${to}`);
      files.set(to, files.get(from) ?? "");
    },
    rename: (from, to) => {
      fsWrites.push(`rename:${from}->${to}`);
      const value = files.get(from);
      if (value !== undefined) {
        files.delete(from);
        files.set(to, value);
      }
    },
    remove: (p) => {
      fsWrites.push(`remove:${p}`);
      files.delete(p);
      dirs.delete(p);
    },
    mkdirp: (p) => {
      fsWrites.push(`mkdirp:${p}`);
      dirs.add(p);
    },
    realpath: (p) => p,
    readDir: () => [],
    freeSpaceBytes: () => overrides.freeSpaceBytes ?? 64 * 1024 * 1024 * 1024,
    ...overrides.fs,
  };

  const runCommand: RunCommand = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (overrides.onRun) {
      const stubbed = await overrides.onRun(command, args, options);
      if (stubbed !== undefined) return stubbed;
    }
    if (command === "git") {
      // Submodule-internal probes first: `submodule status` also carries "status".
      if (args.includes("submodule") && args.includes("status")) {
        return {
          code: 0,
          stdout: ` ${GITLINK_SHA} matchlock (heads/main)\n`,
          stderr: "",
        };
      }
      if (args.includes("remote") && args.includes("get-url")) {
        return { code: 0, stdout: `${MATCHLOCK_FORK_URL}\n`, stderr: "" };
      }
      if (args.includes("status") && args.includes("--porcelain")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse") && args.includes("HEAD")) {
        return { code: 0, stdout: `${GITLINK_SHA}\n`, stderr: "" };
      }
      if (args.includes("ls-files") && args.includes("--stage")) {
        return { code: 0, stdout: `160000 ${GITLINK_SHA} 0\tmatchlock\n`, stderr: "" };
      }
    }
    if (command === "xcrun") {
      return {
        code: 0,
        stdout: "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk\n",
        stderr: "",
      };
    }
    if (command.endsWith("go") && args[0] === "version") {
      return { code: 0, stdout: GO_VERSION_FIXTURE, stderr: "" };
    }
    if (args[0] === "version" && (command === "matchlock" || command.endsWith("/matchlock"))) {
      return { code: 0, stdout: MATCHLOCK_VERSION_FIXTURE, stderr: "" };
    }
    if (command === CAPABILITY_PROBE_COMMAND) {
      const target = args[0] ?? "";
      return {
        code: 0,
        stdout: target !== "" ? `${target} cap_net_admin,cap_net_raw=ep\n` : "",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const env: Record<string, string | undefined> = {
    HOME: "/home/kaladin",
    USER: "kaladin",
    PATH: pathValue,
    // A correctly-enrolled host points the daemon at the installed binary, so
    // the N7 expected-vs-installed prediction does not warn by default. US-012
    // tests override this key to exercise the PATH-shadowing branch.
    [MATCHLOCK_RPC_BIN_ENV_NAME]: INSTALLED_MATCHLOCK_PATH,
    ...overrides.env,
  };

  const accountHomes: Record<string, string> = overrides.accountHomes ?? {
    root: "/root",
    kaladin: "/home/kaladin",
  };

  return {
    runCommand,
    fs: baseFs,
    resolveStoredImage: (reference) => overrides.imageEntries?.[reference],
    platform: overrides.platform ?? "linux",
    arch: overrides.arch ?? "x64",
    sourcePath,
    env,
    euid: overrides.euid ?? 1000,
    accountHomeResolver: (account) => accountHomes[account],
    output: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    calls,
    logs,
    warns,
    fsWrites,
  };
}

function parseOptions(args: readonly string[]): MatchlockSetupOptions {
  const parsed = parseMatchlockSetupArgs(args);
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(args)} to parse`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.options;
}

/**
 * The read-only probes the gates may run: PATH probes (fs only), the gitlink
 * index read, the submodule status/origin/dirty/content reads, and the darwin
 * SDK probe. Anything else (build, install, `submodule update`, fetch,
 * checkout, setup, pull, ...) would be a mutation.
 */
function isReadOnlyProbe(command: string, args: string[]): boolean {
  if (command === "xcrun") return true;
  if (command.endsWith("go") && args[0] === "version") return true;
  if (args[0] === "version" && (command === "matchlock" || command.endsWith("/matchlock"))) {
    return true;
  }
  if (args[0] === "diagnose" && (command === "matchlock" || command.endsWith("/matchlock"))) {
    return true;
  }
  if (command === CAPABILITY_PROBE_COMMAND) return true;
  if (command !== "git") return false;
  if (args.includes("ls-files")) return true;
  if (args.includes("rev-parse")) return true;
  if (args.includes("remote") && args.includes("get-url")) return true;
  if (args.includes("status") && args.includes("--porcelain")) return true;
  if (args.includes("submodule") && args.includes("status")) return true;
  return false;
}

function mutatingCalls(
  deps: FakeMatchlockSetupDeps,
): { command: string; args: string[] }[] {
  return deps.calls.filter(({ command, args }) => !isReadOnlyProbe(command, args));
}

/**
 * Journaled `matchlock kernel pull` invocations for the phase-3 warm (R11).
 * The image `pull` (args[0] === "pull") is a different sub-step.
 */
function kernelWarmCalls(
  deps: FakeMatchlockSetupDeps,
): { command: string; args: string[]; options?: RunCommandOptions }[] {
  return deps.calls.filter(
    (call) =>
      call.command === INSTALLED_MATCHLOCK_PATH && call.args[0] === MATCHLOCK_KERNEL_COMMAND,
  );
}

function assertNoMutations(deps: FakeMatchlockSetupDeps): void {
  assert.deepEqual(deps.fsWrites, [], "expected no filesystem mutation");
  assert.deepEqual(mutatingCalls(deps), [], "expected no mutating command");
}

describe("matchlock-setup: constants", () => {
  it("pins the standard image reference byte-for-byte", () => {
    assert.equal(STANDARD_IMAGE_REFERENCE, "igorhvr/tamandua");
  });

  it("pins the image env override name byte-for-byte", () => {
    assert.equal(MATCHLOCK_IMAGE_ENV_NAME, "TAMANDUA_MATCHLOCK_IMAGE");
  });

  it("pins the pull-timeout and RPC-bin env override names byte-for-byte", () => {
    assert.equal(PULL_TIMEOUT_ENV_NAME, "TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS");
    assert.equal(MATCHLOCK_RPC_BIN_ENV_NAME, "TAMANDUA_MATCHLOCK_RPC_BIN");
  });
});

describe("matchlock-setup: parseMatchlockSetupArgs", () => {
  it("parses every documented flag", () => {
    const options = parseOptions([
      "--latest",
      "--ref",
      "v0.3.0",
      "--prefix",
      "/opt/tamandua-prefix",
      "--refresh-image",
      "--allow-low-disk-space",
      "--no-host-setup",
      "--no-image",
      "--force",
      "--smoke",
      ROOT_OVERRIDE_FLAG,
      "--url",
      "https://example.invalid/fork.git",
    ]);

    assert.equal(options.latest, true);
    assert.equal(options.ref, "v0.3.0");
    assert.equal(options.prefix, "/opt/tamandua-prefix");
    assert.equal(options.refreshImage, true);
    assert.equal(options.allowLowDiskSpace, true);
    assert.equal(options.noHostSetup, true);
    assert.equal(options.noImage, true);
    assert.equal(options.force, true);
    assert.equal(options.smoke, true);
    assert.equal(options.forceMatchlockUsageAsRoot, true);
    assert.equal(options.url, "https://example.invalid/fork.git");
  });

  it("defaults every flag to false/undefined for an empty invocation", () => {
    const options = parseOptions([]);
    assert.equal(options.latest, false);
    assert.equal(options.ref, undefined);
    assert.equal(options.prefix, undefined);
    assert.equal(options.refreshImage, false);
    assert.equal(options.allowLowDiskSpace, false);
    assert.equal(options.noHostSetup, false);
    assert.equal(options.noImage, false);
    assert.equal(options.force, false);
    assert.equal(options.smoke, false);
    assert.equal(options.forceMatchlockUsageAsRoot, false);
    assert.equal(options.url, undefined);
  });

  it("accepts the --flag=value inline form", () => {
    const options = parseOptions(["--ref=abc123", "--prefix=/opt/bin", "--url=file:///srv/fork"]);
    assert.equal(options.ref, "abc123");
    assert.equal(options.prefix, "/opt/bin");
    assert.equal(options.url, "file:///srv/fork");
  });

  it("reports an unknown flag as a typed refusal naming the flag", () => {
    const parsed = parseMatchlockSetupArgs(["--frobnicate"]);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.refusal.code, "unknown-flag");
    assert.match(parsed.refusal.message, /--frobnicate/);
  });

  it("reports a positional argument as a typed refusal", () => {
    const parsed = parseMatchlockSetupArgs(["setup"]);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.refusal.code, "unexpected-argument");
    assert.match(parsed.refusal.message, /setup/);
  });

  it("reports a missing flag value as a typed refusal", () => {
    const parsed = parseMatchlockSetupArgs(["--ref"]);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.refusal.code, "missing-value");
    assert.match(parsed.refusal.message, /--ref/);
  });

  it("surfaces an unknown flag through runMatchlockSetup without throwing", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup(["--frobnicate"], deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "unknown-flag");
    assert.equal(deps.calls.length, 0);
  });
});

describe("matchlock-setup: R12 privilege preflight", () => {
  it("refuses root without the override before any phase and names the flag", async () => {
    const deps = createFakeDeps({ euid: 0, env: { HOME: "/home/alice" } });
    const result = await runMatchlockSetup(parseOptions([]), deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "root-refused");
    assert.equal(result.effective, null);
    assert.equal(result.reloginRequired, false);
    assert.deepEqual(result.phases, []);
    assert.match(result.refusal?.message ?? "", /refusing to run as root/i);
    assert.match(result.refusal?.message ?? "", new RegExp(ROOT_OVERRIDE_FLAG));
    // Nothing ran and nothing was mutated.
    assert.equal(deps.calls.length, 0);
    assert.deepEqual(deps.fsWrites, []);
  });

  it("does not treat a bare --force as R12 consent", async () => {
    const deps = createFakeDeps({ euid: 0 });
    const result = await runMatchlockSetup(parseOptions(["--force"]), deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "root-refused");
  });

  it("proceeds with the override and uses the account-database home, not an inherited HOME", async () => {
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice", USER: "alice" },
      accountHomes: { root: "/root", alice: "/home/alice" },
    });
    const result = await runMatchlockSetup(parseOptions([ROOT_OVERRIDE_FLAG]), deps);

    assert.equal(result.status, "ok");
    const effective = result.effective as MatchlockEffectivePaths;
    assert.equal(effective.account, "root");
    assert.equal(effective.home, "/root");
    assert.notEqual(effective.home, "/home/alice");
    assert.equal(effective.prefix, "/root/.local/bin");
    assert.equal(effective.cacheDir, "/root/.cache/matchlock");
    assert.equal(effective.imageStore, "/root/.cache/matchlock/images");
    assert.equal(effective.kernelCache, "/root/.cache/matchlock/kernels");
  });

  it("keeps an explicit --prefix under forced-root mode", async () => {
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice" },
      accountHomes: { root: "/root" },
    });
    const result = await runMatchlockSetup(
      parseOptions([ROOT_OVERRIDE_FLAG, "--prefix", "/opt/matchlock/bin"]),
      deps,
    );

    assert.equal(result.status, "ok");
    const effective = result.effective as MatchlockEffectivePaths;
    assert.equal(effective.prefix, "/opt/matchlock/bin");
    assert.equal(effective.matchlockPath, "/opt/matchlock/bin/matchlock");
    assert.equal(effective.guestInitPath, "/opt/matchlock/bin/guest-init");
  });

  it("refuses when forced-root mode cannot resolve the account home", async () => {
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice" },
      accountHomes: {},
    });
    const result = await runMatchlockSetup(parseOptions([ROOT_OVERRIDE_FLAG]), deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "account-home-unresolved");
    assert.equal(deps.calls.length, 0);
  });
});

describe("matchlock-setup: R8 prerequisite gates", () => {
  it("passes for a provisioned linux host and exposes the resolved tools", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.failure, undefined);
    assert.equal(result.refusal, undefined);

    const check = await checkPrerequisites(deps);
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.equal(check.goPath, "/usr/bin/go");
    assert.equal(check.gitPath, "/usr/bin/git");
    assert.equal(check.sourcePath, "/repo");
  });

  it("refuses a non-git-worktree source path before mutation and names the path", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: {
        "/usr/bin/git": "",
        "/usr/bin/go": "",
        "/repo/.gitmodules": GITMODULES_FIXTURE,
      },
      dirs: [],
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "source-not-a-git-worktree");
    assert.match(result.refusal?.message ?? "", /\/repo/);
    assertNoMutations(deps);
  });

  it("refuses a missing .gitmodules with the tamandua update remedy and writes nothing", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: { "/usr/bin/git": "", "/usr/bin/go": "" },
      dirs: ["/repo/.git"],
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "matchlock-submodule-missing");
    assert.match(result.refusal?.message ?? "", /tamandua update/);
    assertNoMutations(deps);
    assert.equal(
      deps.fsWrites.some((entry) => entry.includes(".gitmodules")),
      false,
    );
  });

  it("refuses a .gitmodules entry without a gitlink and never writes the registration", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: {
        "/usr/bin/git": "",
        "/usr/bin/go": "",
        "/repo/.gitmodules": GITMODULES_FIXTURE,
      },
      dirs: ["/repo/.git"],
      onRun: async (command, args) => {
        if (command === "git" && args.includes("ls-files")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "matchlock-submodule-missing");
    assert.match(result.refusal?.message ?? "", /gitlink/);
    assert.match(result.refusal?.message ?? "", /tamandua update/);
    assertNoMutations(deps);
    assert.equal(
      deps.fsWrites.some(
        (entry) => entry.includes(".gitmodules") || entry.includes("matchlock"),
      ),
      false,
    );
  });

  it("refuses a missing git on PATH before mutation", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: { "/usr/bin/go": "", "/repo/.gitmodules": GITMODULES_FIXTURE },
      dirs: ["/repo/.git"],
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "git-missing");
    assert.match(result.refusal?.message ?? "", /git/);
    assertNoMutations(deps);
    assert.equal(deps.calls.length, 0);
  });

  it("treats a non-executable go as missing (HARD failure)", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: { "/usr/bin/git": "", "/usr/bin/go": "" },
      dirs: ["/repo/.git"],
      nonExecutables: ["/usr/bin/go"],
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-missing");
    assert.equal(result.failure?.hard, true);
  });

  it("fails HARD on missing go before the content sync and states nothing changed", async () => {
    const deps = createFakeDeps({ useDefaultHost: false });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.refusal, undefined);
    assert.equal(result.failure?.code, "go-missing");
    assert.equal(result.failure?.hard, true);
    assert.match(result.message, /HARD prerequisite/);
    assert.match(result.message, /Nothing was changed/);
    assert.equal(result.reloginRequired, false);
    // N1 (US-013): phase 1 aborts and every later phase is marked not-run.
    assert.equal(result.phases.find((phase) => phase.phase === 1)?.status, "failed");
    assert.deepEqual(
      result.phases.filter((phase) => phase.phase >= 2).map((phase) => phase.status),
      ["not-run", "not-run", "not-run"],
    );
    assertNoMutations(deps);
    assert.equal(deps.calls.length, 0);
  });

  it("fails HARD on missing go even for a would-be no-op invocation", async () => {
    // Everything else looks provisioned: a git worktree with the registered
    // submodule, git on PATH, and both binaries already installed at the
    // target commit. Only `go` is missing, so the run would otherwise be a
    // no-op — it must still fail hard and non-zero (R8).
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: {
        "/usr/bin/git": "",
        "/repo/.gitmodules": GITMODULES_FIXTURE,
        "/home/kaladin/.local/bin/matchlock": "",
        "/home/kaladin/.local/bin/guest-init": "",
      },
      dirs: ["/repo/.git"],
      onRun: async (command, args) => {
        if (command === "/home/kaladin/.local/bin/matchlock" && args[0] === "version") {
          return { code: 0, stdout: "matchlock 1.2.3\ncommit deadbeef\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    // No --force and every phase skipped: the invocation would otherwise be a no-op.
    const result = await runMatchlockSetup(
      ["--no-host-setup", "--no-image"],
      deps,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-missing");
    assert.equal(deps.calls.length, 0, "no build/install/version call may run");
    assertNoMutations(deps);
  });

  it("refuses darwin x86_64 with a remedy", async () => {
    const deps = createFakeDeps({ platform: "darwin", arch: "x64" });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "unsupported-arch");
    assert.match(result.refusal?.message ?? "", /Intel|x86_64/);
    assertNoMutations(deps);
  });

  it("refuses darwin without codesign on PATH", async () => {
    const deps = createFakeDeps({ platform: "darwin", arch: "arm64" });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "codesign-missing");
    assert.match(result.refusal?.message ?? "", /xcode-select --install/);
    assertNoMutations(deps);
  });

  it("refuses darwin without a usable SDK and prints the SDKROOT note", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      files: { "/usr/bin/codesign": "" },
      onRun: async (command) => {
        if (command === "xcrun") {
          return { code: 1, stdout: "", stderr: "xcode-select: error" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "macos-sdk-missing");
    assert.match(result.refusal?.message ?? "", new RegExp(SDKROOT_NOTE.replace(/\./g, "\\.")));
    assertNoMutations(deps);
  });

  it("proceeds on darwin arm64 with codesign and a usable SDK", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      files: { "/usr/bin/codesign": "" },
    });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "ok");
  });

  it("refuses an unsupported linux architecture", async () => {
    const deps = createFakeDeps({ arch: "ia32" });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "unsupported-arch");
    assertNoMutations(deps);
  });

  it("refuses an unsupported platform", async () => {
    const deps = createFakeDeps({ platform: "win32" });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "unsupported-platform");
  });

  it("returns a typed refusal (never throws) from checkPrerequisites when npm-like PATH has no go", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      env: { PATH: "/repo/bin" },
      dirs: ["/repo/.git"],
    });
    const check: PrerequisiteCheckResult = await checkPrerequisites(deps);
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.equal(check.failure.code, "go-missing");
  });
});

describe("matchlock-setup: R8 parsing helpers", () => {
  it("accepts a .gitmodules stanza with the matchlock path", () => {
    assert.equal(
      gitmodulesDeclaresSubmodule(GITMODULES_FIXTURE, MATCHLOCK_SUBMODULE_NAME, "matchlock"),
      true,
    );
  });

  it("rejects a .gitmodules with a different submodule path", () => {
    const text = '[submodule "matchlock"]\n\tpath = vendor/matchlock\n';
    assert.equal(gitmodulesDeclaresSubmodule(text, "matchlock", "matchlock"), false);
  });

  it("rejects a .gitmodules with a different submodule name", () => {
    const text = '[submodule "other"]\n\tpath = matchlock\n';
    assert.equal(gitmodulesDeclaresSubmodule(text, "matchlock", "matchlock"), false);
  });

  it("extracts a gitlink object id from git ls-files --stage output", () => {
    const gitlink = "b".repeat(40);
    assert.equal(
      parseGitlink(`160000 ${gitlink} 0\tmatchlock\n`, "matchlock"),
      gitlink,
    );
  });

  it("ignores regular blobs and other paths when extracting the gitlink", () => {
    const gitlink = "c".repeat(40);
    const output = [
      "100644 deadbeef 0\tREADME.md",
      `160000 ${gitlink} 0\tother`,
      `160000 ${gitlink} 0\tmatchlock`,
    ].join("\n");
    assert.equal(parseGitlink(output, "matchlock"), gitlink);
  });

  it("returns undefined when the gitlink is absent", () => {
    assert.equal(parseGitlink("100644 deadbeef 0\tREADME.md\n", "matchlock"), undefined);
  });

  it("resolves an executable on PATH and skips a non-executable candidate", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: { "/first/go": "", "/second/go": "" },
      nonExecutables: ["/first/go"],
      env: { PATH: "/first:/second" },
    });
    assert.equal(await findExecutableOnPath(deps, "go"), "/second/go");
    assert.equal(await findExecutableOnPath(deps, "git"), undefined);
  });
});

describe("matchlock-setup: R9 submodule state machine", () => {
  function hasStep(deps: FakeMatchlockSetupDeps, step: string): boolean {
    return deps.calls.some((call) => call.args.includes(step));
  }

  function noCommitCommands(deps: FakeMatchlockSetupDeps): void {
    assert.equal(
      deps.calls.some((call) =>
        call.args.some((arg) => arg === "add" || arg === "commit" || arg === "stage"),
      ),
      false,
      "the command must never stage or commit the superproject (N3)",
    );
  }

  it("pins the expected fork URL byte-for-byte", () => {
    assert.equal(MATCHLOCK_FORK_URL, "https://github.com/igorhvr/matchlock.git");
  });

  it("refuses a submodule origin that is not the fork and prints the observed URL", async () => {
    const upstream = "https://github.com/jingkaihe/matchlock.git";
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("remote") && args.includes("get-url")) {
          return { code: 0, stdout: `${upstream}\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "submodule-origin-mismatch");
    assert.match(result.refusal?.message ?? "", /https:\/\/github\.com\/jingkaihe\/matchlock\.git/);
    assert.match(result.refusal?.message ?? "", /expected fork/);
    assert.equal(hasStep(deps, "update"), false);
    assert.equal(hasStep(deps, "fetch"), false);
    assert.equal(hasStep(deps, "checkout"), false);
    assertNoMutations(deps);
  });

  it("refuses a .gitmodules URL that is not the fork before initializing", async () => {
    const deps = createFakeDeps({
      files: {
        "/repo/.gitmodules":
          '[submodule "matchlock"]\n\tpath = matchlock\n\turl = https://github.com/jingkaihe/matchlock.git\n',
      },
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return { code: 0, stdout: `-${GITLINK_SHA} matchlock\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "submodule-origin-mismatch");
    assert.equal(hasStep(deps, "update"), false);
    assertNoMutations(deps);
  });

  it("accepts the --url test hook as the expected origin", async () => {
    const localBare = "file:///srv/fork.git";
    const deps = createFakeDeps({
      files: {
        "/repo/.gitmodules": `[submodule "matchlock"]\n\tpath = matchlock\n\turl = ${localBare}\n`,
      },
      onRun: async (command, args) => {
        if (command === "git" && args.includes("remote") && args.includes("get-url")) {
          return { code: 0, stdout: `${localBare}\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--url", localBare], deps);
    assert.equal(result.status, "ok");
  });

  it("refuses a dirty submodule before any checkout, prints the paths, and --force cannot override", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (
          command === "git" &&
          args.includes("status") &&
          args.includes("--porcelain") &&
          !args.includes("submodule")
        ) {
          return { code: 0, stdout: " M pkg/foo.go\n?? pkg/new.go\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--force"], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "submodule-dirty");
    assert.match(result.refusal?.message ?? "", /pkg\/foo\.go/);
    assert.match(result.refusal?.message ?? "", /pkg\/new\.go/);
    assert.match(result.refusal?.message ?? "", /--force does NOT override/);
    assert.equal(hasStep(deps, "update"), false);
    assert.equal(hasStep(deps, "fetch"), false);
    assert.equal(hasStep(deps, "checkout"), false);
    assertNoMutations(deps);
  });

  it("initializes an uninitialized submodule with `git submodule update --init matchlock`", async () => {
    let initialized = false;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return {
            code: 0,
            stdout: initialized
              ? ` ${GITLINK_SHA} matchlock (heads/main)\n`
              : `-${GITLINK_SHA} matchlock\n`,
            stderr: "",
          };
        }
        if (command === "git" && args.includes("submodule") && args.includes("update")) {
          initialized = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const update = deps.calls.find(
      (call) => call.args.includes("submodule") && call.args.includes("update"),
    );
    assert.ok(update, "expected a submodule update call");
    assert.deepEqual(update?.args, [
      "-C",
      "/repo",
      "submodule",
      "update",
      "--init",
      "matchlock",
    ]);
    assert.equal(result.warnings, undefined);
  });

  it("syncs content behind the committed gitlink instead of treating it as an error", async () => {
    const behind = "b".repeat(40);
    let head = behind;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return { code: 0, stdout: `+${head} matchlock (heads/main)\n`, stderr: "" };
        }
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("submodule") && args.includes("update")) {
          head = GITLINK_SHA;
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(hasStep(deps, "update"), true);
    assert.equal(result.warnings, undefined, "a synced gitlink must not report drift");
  });

  it("checks out --ref content, reports the drift, and never stages or commits", async () => {
    const pinned = "d".repeat(40);
    let head = GITLINK_SHA;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          const marker = head === GITLINK_SHA ? " " : "+";
          return { code: 0, stdout: `${marker}${head} matchlock (heads/main)\n`, stderr: "" };
        }
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("checkout")) {
          head = pinned;
          return { code: 0, stdout: "", stderr: "" };
        }
        // After the checkout the rebuilt binary reports the new content commit.
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          return { code: 0, stdout: `matchlock 0.2.17 (commit: ${head}, built: now)\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--ref", "v0.3.0"], deps);

    assert.equal(result.status, "ok");
    const fetch = deps.calls.find((call) => call.args.includes("fetch"));
    assert.deepEqual(fetch?.args, ["-C", "/repo/matchlock", "fetch"]);
    const checkout = deps.calls.find((call) => call.args.includes("checkout"));
    assert.deepEqual(checkout?.args, ["-C", "/repo/matchlock", "checkout", "v0.3.0"]);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "submodule-drift"),
      true,
    );
    assert.match(result.warnings?.[0]?.message ?? "", new RegExp(pinned));
    assert.match(result.warnings?.[0]?.message ?? "", /N3/);
    noCommitCommands(deps);
  });

  it("moves to the fork main HEAD with --latest, reports drift, and never commits", async () => {
    const latest = "e".repeat(40);
    let head = GITLINK_SHA;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          const marker = head === GITLINK_SHA ? " " : "+";
          return { code: 0, stdout: `${marker}${head} matchlock (heads/main)\n`, stderr: "" };
        }
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("checkout")) {
          head = latest;
          return { code: 0, stdout: "", stderr: "" };
        }
        // After the checkout the rebuilt binary reports the new content commit.
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          return { code: 0, stdout: `matchlock 0.2.17 (commit: ${head}, built: now)\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--latest"], deps);

    assert.equal(result.status, "ok");
    const fetch = deps.calls.find((call) => call.args.includes("fetch"));
    assert.deepEqual(fetch?.args, [
      "-C",
      "/repo/matchlock",
      "fetch",
      "origin",
      "main",
    ]);
    const checkout = deps.calls.find((call) => call.args.includes("checkout"));
    assert.deepEqual(checkout?.args, [
      "-C",
      "/repo/matchlock",
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "submodule-drift"),
      true,
    );
    assert.match(result.message, /\(main\)/);
    noCommitCommands(deps);
  });

  it("is a read-only no-op when the content already matches the gitlink", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(hasStep(deps, "update"), false);
    assert.equal(hasStep(deps, "fetch"), false);
    assert.equal(hasStep(deps, "checkout"), false);
    assert.equal(result.warnings, undefined);
  });

  it("returns a typed outcome from syncMatchlockSubmodule", async () => {
    const deps = createFakeDeps();
    const outcome = await syncMatchlockSubmodule(parseOptions([]), deps);

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.action, "already-synced");
    assert.equal(outcome.drift, false);
    assert.equal(outcome.originUrl, MATCHLOCK_FORK_URL);
    assert.equal(outcome.gitlinkSha, GITLINK_SHA);
    assert.equal(outcome.contentSha, GITLINK_SHA);
  });

  it("refuses when the submodule status cannot be read", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "submodule-status-failed");
    assertNoMutations(deps);
  });

  it("refuses when `git submodule update` fails", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return { code: 0, stdout: `-${GITLINK_SHA} matchlock\n`, stderr: "" };
        }
        if (command === "git" && args.includes("submodule") && args.includes("update")) {
          return { code: 1, stdout: "", stderr: "network down" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "submodule-sync-failed");
  });
});

describe("matchlock-setup: R9 parsing helpers", () => {
  it("parses the three submodule status shapes", () => {
    const sha = "f".repeat(40);
    assert.deepEqual(parseSubmoduleStatus(` ${sha} matchlock (heads/main)\n`, "matchlock"), {
      status: " ",
      sha,
      path: "matchlock",
      initialized: true,
    });
    assert.equal(
      parseSubmoduleStatus(`-${sha} matchlock\n`, "matchlock")?.initialized,
      false,
    );
    assert.equal(parseSubmoduleStatus(`+${sha} matchlock\n`, "matchlock")?.status, "+");
  });

  it("ignores submodule status lines for other submodules", () => {
    const sha = "f".repeat(40);
    assert.equal(parseSubmoduleStatus(` ${sha} other\n`, "matchlock"), undefined);
  });

  it("extracts dirty paths from porcelain output", () => {
    assert.deepEqual(parseDirtyPaths(" M pkg/foo.go\n?? pkg/new.go\n"), [
      "pkg/foo.go",
      "pkg/new.go",
    ]);
    assert.deepEqual(parseDirtyPaths(""), []);
  });

  it("parses the submodule stanza and url from .gitmodules", () => {
    assert.equal(gitmodulesSubmoduleUrl(GITMODULES_FIXTURE, "matchlock"), MATCHLOCK_FORK_URL);
    assert.equal(parseGitmodulesSubmodule(GITMODULES_FIXTURE, "matchlock")?.path, "matchlock");
    assert.equal(gitmodulesSubmoduleUrl(GITMODULES_FIXTURE, "nope"), undefined);
  });
});

describe("matchlock-setup: US-004 Go-minimum gate", () => {
  function goCalls(
    deps: FakeMatchlockSetupDeps,
  ): { command: string; args: string[]; options?: RunCommandOptions }[] {
    return deps.calls.filter((call) => call.command.endsWith("go"));
  }

  it("parses the first non-comment go directive from go.mod", () => {
    assert.deepEqual(parseGoDirective(GO_MOD_FIXTURE), {
      major: 1,
      minor: 25,
      patch: 5,
    });
    assert.deepEqual(
      parseGoDirective(
        [
          "// go 1.12.0 must be ignored",
          "module example.com/x",
          "",
          "go 1.24 // trailing comment",
          "go 1.30",
        ].join("\n"),
      ),
      { major: 1, minor: 24, patch: 0 },
    );
    assert.deepEqual(parseGoDirective("go 1.25\n"), { major: 1, minor: 25, patch: 0 });
  });

  it("returns undefined when go.mod declares no go directive", () => {
    assert.equal(parseGoDirective("module example.com/x\n"), undefined);
    assert.equal(parseGoDirective("toolchain go1.26.0\n"), undefined);
  });

  it("parses `go version` output and compares versions numerically", () => {
    assert.deepEqual(parseGoVersionOutput("go version go1.25.5 linux/amd64"), {
      major: 1,
      minor: 25,
      patch: 5,
    });
    assert.deepEqual(parseGoVersionOutput("go version go1.24 darwin/arm64"), {
      major: 1,
      minor: 24,
      patch: 0,
    });
    assert.equal(parseGoVersionOutput("not a go toolchain"), undefined);
    assert.equal(formatGoVersion({ major: 1, minor: 25, patch: 5 }), "1.25.5");
    // Numeric, not lexical: 1.9.0 < 1.10.0.
    assert.ok(
      compareGoVersions({ major: 1, minor: 9, patch: 0 }, { major: 1, minor: 10, patch: 0 }) <
        0,
    );
    assert.ok(
      compareGoVersions({ major: 1, minor: 26, patch: 0 }, { major: 1, minor: 25, patch: 5 }) >
        0,
    );
    assert.equal(
      compareGoVersions({ major: 1, minor: 25, patch: 5 }, { major: 1, minor: 25, patch: 5 }),
      0,
    );
  });

  it("forces GOTOOLCHAIN=local for every go invocation without dropping env", () => {
    const deps = createFakeDeps({
      env: { PATH: "/usr/bin", GOTOOLCHAIN: "auto", CUSTOM: "kept" },
    });
    const env = goToolchainEnv(deps);
    assert.equal(GOTOOLCHAIN_ENV_NAME, "GOTOOLCHAIN");
    assert.equal(GOTOOLCHAIN_LOCAL, "local");
    assert.equal(env[GOTOOLCHAIN_ENV_NAME], GOTOOLCHAIN_LOCAL);
    assert.equal(env.GOTOOLCHAIN, "local");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.CUSTOM, "kept");
  });

  it("runs the version probe in the synchronized submodule dir with GOTOOLCHAIN=local", async () => {
    const deps = createFakeDeps();
    const result = await checkGoMinimum(deps, "/usr/bin/go");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.minimum, { major: 1, minor: 25, patch: 5 });
      assert.deepEqual(result.found, { major: 1, minor: 25, patch: 5 });
      assert.equal(result.goModPath, "/repo/matchlock/go.mod");
    }
    const probe = goCalls(deps)[0];
    assert.deepEqual(probe?.args, ["version"]);
    assert.equal(probe?.options?.env?.[GOTOOLCHAIN_ENV_NAME], GOTOOLCHAIN_LOCAL);
    assert.equal(probe?.options?.cwd, "/repo/matchlock");
    assert.equal(probe?.options?.timeoutMs, GO_VERSION_TIMEOUT_MS);
  });

  it("fails HARD when the local Go is older than the go.mod minimum, as phase 1's first check after the sync", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          return { code: 0, stdout: "go version go1.24.3 linux/amd64\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.refusal, undefined);
    assert.equal(result.failure?.code, "go-too-old");
    assert.equal(result.failure?.hard, true);
    assert.match(result.message, /go >= 1\.25\.5/);
    assert.match(result.message, /go1\.24\.3/);
    assert.match(result.message, /synchronized/i);
    assert.ok(result.message.includes(POST_SYNC_NOTHING_CHANGED_TRAILER));
    // The content sync ran before the Go probe.
    const syncIndex = deps.calls.findIndex(
      (call) => call.args.includes("submodule") && call.args.includes("status"),
    );
    const goIndex = deps.calls.findIndex((call) => call.command.endsWith("go"));
    assert.ok(syncIndex >= 0 && goIndex > syncIndex, "go probe must follow the content sync");
    // No build/install/host mutation ran; the only go invocation is the probe.
    assert.deepEqual(
      goCalls(deps).map((call) => call.args[0]),
      ["version"],
    );
    assertNoMutations(deps);
  });

  it("fails HARD when the synchronized go.mod is unreadable and states content was synchronized", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: {
        "/usr/bin/git": "",
        "/usr/bin/go": "",
        "/repo/.gitmodules": GITMODULES_FIXTURE,
      },
      dirs: ["/repo/.git"],
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-mod-unreadable");
    assert.equal(result.failure?.hard, true);
    assert.match(result.message, /go\.mod/);
    assert.match(result.message, /synchronized/i);
    assertNoMutations(deps);
  });

  it("fails HARD when the go.mod has no parseable go directive", async () => {
    const deps = createFakeDeps({
      files: {
        "/repo/matchlock/go.mod": "module github.com/jingkaihe/matchlock\n",
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-minimum-unknown");
    assert.equal(result.failure?.hard, true);
    assert.match(result.message, /synchronized/i);
    assert.deepEqual(goCalls(deps), [], "no probe without a known minimum");
  });

  it("fails HARD when `go version` exits non-zero or cannot be spawned", async () => {
    const failing = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          return { code: 2, stdout: "", stderr: "go: cannot find GOROOT" };
        }
        return undefined;
      },
    });
    const failed = await runMatchlockSetup([], failing);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "go-version-unknown");
    assert.match(failed.message, /exited 2/);
    assert.match(failed.message, /synchronized/i);

    const throwing = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          throw new Error("ENOENT");
        }
        return undefined;
      },
    });
    const missing = await runMatchlockSetup([], throwing);
    assert.equal(missing.status, "failed");
    assert.equal(missing.failure?.code, "go-version-unknown");
    assert.match(missing.message, /could not be spawned/);
  });

  it("fails HARD when `go version` prints an unrecognized string", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          return { code: 0, stdout: "gcc version 14\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-version-unknown");
    assert.match(result.message, /printed/);
  });

  it("fails a would-be no-op invocation when the Go requirement is unmet", async () => {
    // Both binaries are already installed and both phases are skipped, so the
    // invocation would otherwise be a no-op — it must still fail hard (R8).
    const deps = createFakeDeps({
      files: {
        "/home/kaladin/.local/bin/matchlock": "",
        "/home/kaladin/.local/bin/guest-init": "",
      },
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          return { code: 0, stdout: "go version go1.21.0 linux/amd64\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--no-host-setup", "--no-image"], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-too-old");
    assert.equal(result.failure?.hard, true);
    assert.deepEqual(
      goCalls(deps).map((call) => call.args[0]),
      ["version"],
    );
    assertNoMutations(deps);
  });

  it("probes the toolchain only after an uninitialized submodule is synchronized", async () => {
    let initialized = false;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          return {
            code: 0,
            stdout: initialized
              ? ` ${GITLINK_SHA} matchlock (heads/main)\n`
              : `-${GITLINK_SHA} matchlock\n`,
            stderr: "",
          };
        }
        if (command === "git" && args.includes("submodule") && args.includes("update")) {
          initialized = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "ok");
    const updateIndex = deps.calls.findIndex(
      (call) => call.args.includes("submodule") && call.args.includes("update"),
    );
    const goIndex = deps.calls.findIndex((call) => call.command.endsWith("go"));
    assert.ok(updateIndex >= 0 && goIndex > updateIndex);
  });

  it("accepts a toolchain above the minimum and keeps the run green", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "version") {
          return { code: 0, stdout: "go version go1.26.0 linux/amd64\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "ok");
    assert.equal(result.failure, undefined);
  });
});

describe("matchlock-setup: US-005 R2 build recipe", () => {
  function effectivePaths(platform: string, arch: string): MatchlockEffectivePaths {
    return resolveMatchlockPaths({
      platform,
      account: "kaladin",
      home: platform === "darwin" ? "/Users/kaladin" : "/home/kaladin",
    });
  }

  function goBuildCalls(
    deps: FakeMatchlockSetupDeps,
  ): { command: string; args: string[]; options?: RunCommandOptions }[] {
    return deps.calls.filter((call) => call.command.endsWith("go") && call.args[0] === "build");
  }

  it("maps Node's x64 to Go's amd64 for guest-init", () => {
    assert.equal(guestInitGoArch("x64"), "amd64");
    assert.equal(guestInitGoArch("amd64"), "amd64");
    assert.equal(guestInitGoArch("arm64"), "arm64");
  });

  it("renders the exact pinned ldflags string", () => {
    assert.equal(MATCHLOCK_VERSION_PACKAGE, "github.com/jingkaihe/matchlock/pkg/version");
    assert.equal(
      matchlockLdflags("1.2.3", "abc123", "2026-09-30T00:00:00.000Z"),
      "-X github.com/jingkaihe/matchlock/pkg/version.Version=1.2.3 " +
        "-X github.com/jingkaihe/matchlock/pkg/version.GitCommit=abc123 " +
        "-X github.com/jingkaihe/matchlock/pkg/version.BuildTime=2026-09-30T00:00:00.000Z",
    );
  });

  it("builds matchlock then guest-init on linux x64 with per-binary argv/env", async () => {
    const deps = createFakeDeps({ platform: "linux", arch: "x64" });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "x64"),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.version, "1.2.3");
    assert.equal(result.commit, GITLINK_SHA);
    assert.match(result.buildTime, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.matchlockOutputPath, "/repo/matchlock/bin/matchlock");
    assert.equal(result.guestInitOutputPath, "/repo/matchlock/bin/guest-init");
    assert.equal(result.signed, false);
    assert.equal(result.cachedGuestInitPath, undefined);

    const builds = goBuildCalls(deps);
    assert.equal(builds.length, 2, "exactly one build per binary");

    const matchlock = builds[0];
    assert.deepEqual(matchlock.args, [
      "build",
      `-ldflags=${matchlockLdflags("1.2.3", GITLINK_SHA, result.buildTime)}`,
      "-o",
      MATCHLOCK_BUILD_OUTPUT,
      MATCHLOCK_BUILD_PACKAGE,
    ]);
    assert.equal(MATCHLOCK_BUILD_OUTPUT, "bin/matchlock");
    assert.equal(MATCHLOCK_BUILD_PACKAGE, "./cmd/matchlock");
    assert.equal(matchlock.options?.cwd, "/repo/matchlock");
    assert.equal(matchlock.options?.timeoutMs, BUILD_TIMEOUT_MS);
    assert.equal(matchlock.options?.env?.[GOTOOLCHAIN_ENV_NAME], GOTOOLCHAIN_LOCAL);
    // The ldflags carry version + submodule commit + build time.
    assert.match(matchlock.args[1], /Version=1\.2\.3/);
    assert.match(matchlock.args[1], new RegExp(`GitCommit=${GITLINK_SHA}`));
    assert.match(matchlock.args[1], /BuildTime=/);

    const guestInit = builds[1];
    assert.deepEqual(guestInit.args, [
      "build",
      "-trimpath",
      "-o",
      GUEST_INIT_BUILD_OUTPUT,
      GUEST_INIT_BUILD_PACKAGE,
    ]);
    assert.equal(GUEST_INIT_BUILD_OUTPUT, "bin/guest-init");
    assert.equal(GUEST_INIT_BUILD_PACKAGE, "./cmd/guest-init");
    assert.equal(guestInit.options?.cwd, "/repo/matchlock");
    assert.equal(guestInit.options?.timeoutMs, BUILD_TIMEOUT_MS);
    assert.equal(guestInit.options?.env?.CGO_ENABLED, "0");
    assert.equal(guestInit.options?.env?.GOOS, "linux");
    assert.equal(guestInit.options?.env?.GOARCH, "amd64");
    assert.equal(guestInit.options?.env?.[GOTOOLCHAIN_ENV_NAME], GOTOOLCHAIN_LOCAL);

    // linux never codesigns or caches guest-init.
    assert.equal(deps.calls.some((call) => call.command === "codesign"), false);
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("copy:")),
      false,
    );
  });

  it("sets GOARCH to the host arch on linux arm64", async () => {
    const deps = createFakeDeps({ platform: "linux", arch: "arm64" });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "arm64"),
    );
    assert.equal(result.ok, true);
    const guestInit = goBuildCalls(deps)[1];
    assert.equal(guestInit.options?.env?.GOARCH, "arm64");
    assert.equal(guestInit.options?.env?.GOOS, "linux");
  });

  it("codesigns and caches guest-init on darwin arm64", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      files: { "/usr/bin/codesign": "" },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("darwin", "arm64"),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.signed, true);
    assert.equal(result.cachedGuestInitPath, "/Users/kaladin/.cache/matchlock/guest-init");

    const guestInit = goBuildCalls(deps)[1];
    assert.equal(guestInit.options?.env?.GOARCH, "arm64");
    assert.equal(guestInit.options?.env?.GOOS, "linux");
    assert.equal(guestInit.options?.env?.CGO_ENABLED, "0");

    const sign = deps.calls.find((call) => call.command === "codesign");
    assert.deepEqual(sign?.args, [
      "--entitlements",
      MATCHLOCK_ENTITLEMENTS_FILE,
      "-f",
      "-s",
      "-",
      MATCHLOCK_BUILD_OUTPUT,
    ]);
    assert.equal(MATCHLOCK_ENTITLEMENTS_FILE, "matchlock.entitlements");
    assert.equal(sign?.options?.cwd, "/repo/matchlock");
    // guest-init cached into the effective ~/.cache/matchlock/guest-init.
    assert.ok(
      deps.fsWrites.includes(
        "copy:/repo/matchlock/bin/guest-init->/Users/kaladin/.cache/matchlock/guest-init",
      ),
    );
  });

  it("codesigns only after both binaries are built", async () => {
    const deps = createFakeDeps({ platform: "darwin", arch: "arm64" });
    await buildMatchlockBinaries(deps, "/usr/bin/go", effectivePaths("darwin", "arm64"));
    const buildIndexes = deps.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.command.endsWith("go") && call.args[0] === "build")
      .map(({ index }) => index);
    const signIndex = deps.calls.findIndex((call) => call.command === "codesign");
    assert.equal(buildIndexes.length, 2);
    assert.ok(signIndex > buildIndexes[1], "codesign runs after both builds");
  });

  it("fails HARD when VERSION.txt is missing, before any build", async () => {
    const deps = createFakeDeps({
      useDefaultHost: false,
      files: { "/usr/bin/git": "", "/usr/bin/go": "" },
      dirs: ["/repo/.git"],
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "x64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "matchlock-version-unreadable");
    assert.equal(result.failure.hard, true);
    assert.equal(result.failure.message.includes(BUILD_FAILED_NOTHING_INSTALLED_TRAILER), true);
    assert.equal(deps.calls.some((call) => call.args[0] === "build"), false);
  });

  it("fails HARD when the submodule commit cannot be resolved", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("rev-parse")) {
          return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        }
        return undefined;
      },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "x64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "submodule-commit-unknown");
    assert.equal(deps.calls.some((call) => call.args[0] === "build"), false);
  });

  it("fails HARD when the matchlock build exits non-zero and never builds guest-init", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (
          command.endsWith("go") &&
          args[0] === "build" &&
          args.includes(MATCHLOCK_BUILD_PACKAGE)
        ) {
          return { code: 1, stdout: "", stderr: "cmd/matchlock: undefined: main" };
        }
        return undefined;
      },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "x64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "matchlock-build-failed");
    assert.equal(result.failure.hard, true);
    assert.match(result.failure.message, /exited 1/);
    assert.match(result.failure.message, /undefined: main/);
    assert.equal(goBuildCalls(deps).length, 1, "guest-init is not built after a failure");
    assert.equal(deps.calls.some((call) => call.command === "codesign"), false);
  });

  it("fails HARD when the guest-init build exits non-zero", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (
          command.endsWith("go") &&
          args[0] === "build" &&
          args.includes(GUEST_INIT_BUILD_PACKAGE)
        ) {
          return { code: 2, stdout: "", stderr: "guest-init: build constraints exclude files" };
        }
        return undefined;
      },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("linux", "x64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "guest-init-build-failed");
    assert.match(result.failure.message, /exited 2/);
    assert.equal(goBuildCalls(deps).length, 2);
  });

  it("fails HARD when codesign exits non-zero on darwin", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      onRun: async (command) => {
        if (command === "codesign") {
          return { code: 1, stdout: "", stderr: "codesign: no identity found" };
        }
        return undefined;
      },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("darwin", "arm64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "codesign-failed");
    assert.match(result.failure.message, /no identity found/);
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("copy:")),
      false,
      "guest-init is not cached when signing fails",
    );
  });

  it("fails HARD when the darwin guest-init cache copy fails", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      fs: {
        copyFile: () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    const result = await buildMatchlockBinaries(
      deps,
      "/usr/bin/go",
      effectivePaths("darwin", "arm64"),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "guest-init-cache-failed");
    assert.match(result.failure.message, /EACCES/);
  });

  it("uses argv arrays (never a shell string) for every build command", async () => {
    const deps = createFakeDeps({ platform: "darwin", arch: "arm64" });
    await buildMatchlockBinaries(deps, "/usr/bin/go", effectivePaths("darwin", "arm64"));
    assert.ok(deps.calls.length > 0);
    for (const call of deps.calls) {
      assert.ok(Array.isArray(call.args), "args must be an array");
      assert.equal(call.command.includes(" "), false, "command must be a bare binary");
      for (const arg of call.args) {
        assert.equal(typeof arg, "string");
      }
    }
  });

  it("runs the build through runMatchlockSetup strictly after the Go-minimum probe", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);
    assert.equal(result.status, "ok");
    const versionIndex = deps.calls.findIndex(
      (call) => call.command.endsWith("go") && call.args[0] === "version",
    );
    const buildIndex = deps.calls.findIndex(
      (call) => call.command.endsWith("go") && call.args[0] === "build",
    );
    assert.ok(versionIndex >= 0, "the Go probe ran");
    assert.ok(buildIndex > versionIndex, "the build follows the Go check");
    assert.equal(deps.logs.some((line) => /built matchlock 1\.2\.3/.test(line)), true);
  });
});

describe("matchlock-setup: US-006 R3 atomic install", () => {
  function effectivePaths(
    platform: string,
    arch: string,
    prefix?: string,
  ): MatchlockEffectivePaths {
    return resolveMatchlockPaths({
      platform,
      account: "kaladin",
      home: platform === "darwin" ? "/Users/kaladin" : "/home/kaladin",
      ...(prefix !== undefined ? { prefix } : {}),
    });
  }

  function fakeBuild(): MatchlockBuildSuccess {
    return {
      ok: true,
      version: "1.2.3",
      commit: GITLINK_SHA,
      buildTime: "2026-09-30T00:00:00.000Z",
      matchlockOutputPath: "/repo/matchlock/bin/matchlock",
      guestInitOutputPath: "/repo/matchlock/bin/guest-init",
      signed: false,
      message: "built",
    };
  }

  const tempFor = (destination: string) => `${destination}.tmp-${process.pid}`;

  it("installs both binaries with a temp write then an atomic rename", async () => {
    const deps = createFakeDeps();
    const result = await installMatchlockBinaries(deps, effectivePaths("linux", "x64"), fakeBuild());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prefix, "/home/kaladin/.local/bin");
    assert.equal(result.matchlockPath, "/home/kaladin/.local/bin/matchlock");
    assert.equal(result.guestInitPath, "/home/kaladin/.local/bin/guest-init");

    assert.deepEqual(deps.fsWrites, [
      `copy:/repo/matchlock/bin/matchlock->${tempFor("/home/kaladin/.local/bin/matchlock")}`,
      `copy:/repo/matchlock/bin/guest-init->${tempFor("/home/kaladin/.local/bin/guest-init")}`,
      `rename:${tempFor("/home/kaladin/.local/bin/matchlock")}->/home/kaladin/.local/bin/matchlock`,
      `rename:${tempFor("/home/kaladin/.local/bin/guest-init")}->/home/kaladin/.local/bin/guest-init`,
    ]);
    assert.equal(await deps.fs.exists("/home/kaladin/.local/bin/matchlock"), true);
    assert.equal(await deps.fs.exists("/home/kaladin/.local/bin/guest-init"), true);
  });

  it("stages every temp file before publishing any destination (no partial overwrite)", async () => {
    const deps = createFakeDeps();
    const result = await installMatchlockBinaries(deps, effectivePaths("linux", "x64"), fakeBuild());
    assert.equal(result.ok, true);

    const kinds = deps.fsWrites.map((entry) => entry.split(":")[0]);
    assert.deepEqual(kinds, ["copy", "copy", "rename", "rename"]);
    assert.ok(
      kinds.lastIndexOf("copy") < kinds.indexOf("rename"),
      "both copies complete before the first rename",
    );

    // Every temp file lives in the prefix (same filesystem as its destination).
    for (const entry of deps.fsWrites) {
      const temp = entry.match(/(?:->|\brename:)(\S+\.tmp-\d+)/)?.[1];
      if (temp !== undefined) assert.equal(dirname(temp), "/home/kaladin/.local/bin");
    }
  });

  it("refuses a non-writable prefix with remedies and no install or sudo", async () => {
    const deps = createFakeDeps({ nonWritableDirs: ["/home/kaladin/.local/bin"] });
    const result = await installMatchlockBinaries(deps, effectivePaths("linux", "x64"), fakeBuild());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal?.code, "prefix-not-writable");
    const message = result.refusal?.message ?? "";
    assert.match(message, /refusing to install into \/home\/kaladin\/\.local\/bin/);
    assert.match(message, /--prefix/);
    assert.match(message, /mkdir -p/);
    assert.match(message, /chown\/chmod/);
    assert.match(message, /No sudo was attempted/);
    assert.deepEqual(deps.fsWrites, [], "prefix refusal must not attempt an install");
    assert.equal(deps.calls.length, 0, "prefix refusal must not spawn anything");
  });

  it("refuses a missing prefix when no ancestor is writable", async () => {
    const deps = createFakeDeps({ useDefaultHost: false, dirs: [] });
    const effective = effectivePaths("linux", "x64", "/install-root/bin");
    const result = await installMatchlockBinaries(deps, effective, fakeBuild());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal?.code, "prefix-not-writable");
    assert.match(result.refusal?.message ?? "", /no writable parent directory/);
    assert.deepEqual(deps.fsWrites, []);
  });

  it("creates a missing prefix only when an existing ancestor is writable", async () => {
    const deps = createFakeDeps({ useDefaultHost: false, dirs: ["/install-root"] });
    const effective = effectivePaths("linux", "x64", "/install-root/bin");
    const result = await installMatchlockBinaries(deps, effective, fakeBuild());

    assert.equal(result.ok, true);
    assert.equal(deps.fsWrites[0], "mkdirp:/install-root/bin");
    assert.equal(deps.fsWrites.filter((entry) => entry.startsWith("copy:")).length, 2);
    assert.equal(deps.fsWrites.filter((entry) => entry.startsWith("rename:")).length, 2);
  });

  it("installs into the platform default prefixes", async () => {
    const linuxDeps = createFakeDeps();
    const linux = await installMatchlockBinaries(linuxDeps, effectivePaths("linux", "x64"), fakeBuild());
    assert.equal(linux.ok, true);
    if (linux.ok) assert.equal(linux.matchlockPath, "/home/kaladin/.local/bin/matchlock");

    const darwinDeps = createFakeDeps({ platform: "darwin", arch: "arm64" });
    const darwin = await installMatchlockBinaries(
      darwinDeps,
      effectivePaths("darwin", "arm64"),
      fakeBuild(),
    );
    assert.equal(darwin.ok, true);
    if (darwin.ok) {
      assert.equal(darwin.prefix, DARWIN_DEFAULT_PREFIX);
      assert.equal(darwin.guestInitPath, "/opt/homebrew/bin/guest-init");
    }
  });

  it("honors a --prefix override", async () => {
    const deps = createFakeDeps({ dirs: ["/custom/install/bin"] });
    const effective = effectivePaths("linux", "x64", "/custom/install/bin");
    const result = await installMatchlockBinaries(deps, effective, fakeBuild());

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.matchlockPath, "/custom/install/bin/matchlock");
    assert.equal(
      deps.fsWrites.includes(
        `rename:${tempFor("/custom/install/bin/matchlock")}->/custom/install/bin/matchlock`,
      ),
      true,
    );
    assert.equal(
      deps.fsWrites.some((entry) =>
        entry.includes("->/home/kaladin/.local/bin"),
      ),
      false,
      "nothing is written outside the override prefix",
    );
  });

  it("leaves previously installed binaries untouched when a copy fails", async () => {
    const deps = createFakeDeps({
      files: {
        "/home/kaladin/.local/bin/matchlock": "OLD-MATCHLOCK",
        "/home/kaladin/.local/bin/guest-init": "OLD-GUEST-INIT",
      },
    });
    const originalCopy = deps.fs.copyFile.bind(deps.fs);
    deps.fs.copyFile = (from, to) => {
      if (to.includes("guest-init")) throw new Error("ENOSPC: no space left on device");
      return originalCopy(from, to);
    };

    const result = await installMatchlockBinaries(deps, effectivePaths("linux", "x64"), fakeBuild());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure?.code, "install-failed");
    assert.equal(result.failure?.hard, true);
    assert.match(result.failure?.message ?? "", /ENOSPC/);
    assert.equal((result.failure?.message ?? "").includes(INSTALL_FAILED_TRAILER), true);
    assert.equal(await deps.fs.readTextFile("/home/kaladin/.local/bin/matchlock"), "OLD-MATCHLOCK");
    assert.equal(await deps.fs.readTextFile("/home/kaladin/.local/bin/guest-init"), "OLD-GUEST-INIT");
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("rename:")),
      false,
      "a failed staging copy must not publish anything",
    );
    assert.equal(
      deps.fsWrites.includes(`remove:${tempFor("/home/kaladin/.local/bin/matchlock")}`),
      true,
      "the staged temp file is removed",
    );
  });

  it("fails HARD and cleans up when the publish rename fails", async () => {
    const deps = createFakeDeps();
    const originalRename = deps.fs.rename.bind(deps.fs);
    let renames = 0;
    deps.fs.rename = (from, to) => {
      renames += 1;
      if (renames === 2) throw new Error("EXDEV: cross-device link");
      return originalRename(from, to);
    };

    const result = await installMatchlockBinaries(deps, effectivePaths("linux", "x64"), fakeBuild());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure?.code, "install-failed");
    assert.match(result.failure?.message ?? "", /EXDEV/);
    assert.equal(await deps.fs.exists(tempFor("/home/kaladin/.local/bin/guest-init")), false);
  });

  it("is exposed as a prefix pre-check helper", async () => {
    assert.equal(
      await ensureMatchlockInstallPrefix(createFakeDeps(), "/home/kaladin/.local/bin"),
      undefined,
    );
    const refused = await ensureMatchlockInstallPrefix(
      createFakeDeps({ nonWritableDirs: ["/home/kaladin/.local/bin"] }),
      "/home/kaladin/.local/bin",
    );
    assert.equal(refused?.code, "prefix-not-writable");
    const missing = await ensureMatchlockInstallPrefix(
      createFakeDeps({ useDefaultHost: false, dirs: [] }),
      "/install-root/bin",
    );
    assert.equal(missing?.code, "prefix-not-writable");
  });

  it("installs both binaries through runMatchlockSetup after the build", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(await deps.fs.exists("/home/kaladin/.local/bin/matchlock"), true);
    assert.equal(await deps.fs.exists("/home/kaladin/.local/bin/guest-init"), true);
    assert.equal(
      deps.logs.some((line) =>
        line.includes("installed matchlock + guest-init to /home/kaladin/.local/bin"),
      ),
      true,
    );
    assert.equal(
      deps.calls.some((call) => call.command.endsWith("go") && call.args[0] === "build"),
      true,
      "the build still runs before the install",
    );
  });

  it("surfaces a non-writable prefix as a refusal from runMatchlockSetup without installing", async () => {
    const deps = createFakeDeps({ nonWritableDirs: ["/home/kaladin/.local/bin"] });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "prefix-not-writable");
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("copy:") || entry.startsWith("rename:")),
      false,
    );
    assert.equal(
      deps.calls.some((call) => call.command.endsWith("go") && call.args[0] === "build"),
      true,
      "phase 1 still builds; only the install is blocked",
    );
  });
});

describe("matchlock-setup: US-007 R7 idempotent no-op detection", () => {
  /** A provisioned host with both binaries already installed at the target. */
  function hostWithInstalledBinaries(overrides: FakeDepsOverrides = {}) {
    return createFakeDeps({
      files: {
        [INSTALLED_MATCHLOCK_PATH]: "INSTALLED-MATCHLOCK",
        [INSTALLED_GUEST_INIT_PATH]: "INSTALLED-GUEST-INIT",
      },
      ...overrides,
    });
  }

  const buildCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.command.endsWith("go") && call.args[0] === "build");
  const versionProbeCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.args[0] === "version" && call.command.endsWith("/matchlock"));

  it("parses the fork's matchlock version line into version and commit", () => {
    const parsed = parseMatchlockVersionOutput(
      "matchlock 0.2.17 (commit: 6cddbd0, built: Wed Sep 23 09:34:18 UTC 2026)\n",
    );
    assert.deepEqual(parsed, {
      version: "0.2.17",
      commit: "6cddbd0",
      built: "Wed Sep 23 09:34:18 UTC 2026",
    });
  });

  it("parses a version line without a built timestamp", () => {
    assert.deepEqual(parseMatchlockVersionOutput("matchlock 1.2.3 (commit: abc1234)\n"), {
      version: "1.2.3",
      commit: "abc1234",
    });
  });

  it("returns undefined for unparseable version output", () => {
    assert.equal(parseMatchlockVersionOutput(""), undefined);
    assert.equal(parseMatchlockVersionOutput("\n  \n"), undefined);
    assert.equal(parseMatchlockVersionOutput("matchlock (no commit here)\n"), undefined);
    assert.equal(parseMatchlockVersionOutput("matchlock 1.2.3 (commit: )\n"), undefined);
    assert.equal(parseMatchlockVersionOutput("go version go1.25.5 linux/amd64\n"), undefined);
  });

  it("matches an abbreviated installed commit against the full target sha", () => {
    assert.equal(matchlockCommitMatches(GITLINK_SHA.slice(0, 7), GITLINK_SHA), true);
    assert.equal(matchlockCommitMatches(GITLINK_SHA.toUpperCase(), GITLINK_SHA), true);
    assert.equal(matchlockCommitMatches(GITLINK_SHA, GITLINK_SHA), true);
    assert.equal(matchlockCommitMatches("b".repeat(7), GITLINK_SHA), false);
    assert.equal(matchlockCommitMatches("a", GITLINK_SHA), false, "too short to prefix-match");
    assert.equal(matchlockCommitMatches("", GITLINK_SHA), false);
    assert.equal(matchlockCommitMatches("not-a-sha", GITLINK_SHA), false);
  });

  it("treats a re-run already at the target commit as a no-op", async () => {
    const deps = hostWithInstalledBinaries();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.idempotent, true);
    assert.match(result.message, /already at /);
    assert.equal(result.message.includes(GITLINK_SHA), true);
    assert.equal(
      deps.logs.some((line) => line.includes(`already at ${GITLINK_SHA}`)),
      true,
      "the no-op is reported",
    );

    // The build and install are skipped entirely.
    assert.deepEqual(buildCalls(deps), []);
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("copy:") || entry.startsWith("rename:")),
      false,
      "no install write happens on a no-op",
    );
    // The installed binaries are probed at their absolute installed path (N7):
    // phase 1's R7 probe plus phase 4's R6 verify re-read.
    const probes = versionProbeCalls(deps);
    assert.equal(probes.length, 2, "the R7 probe and the phase-4 verify probe both run");
    assert.deepEqual(probes.map((call) => call.args), [["version"], ["version"]]);
    assert.ok(
      probes.every((call) => call.command === INSTALLED_MATCHLOCK_PATH),
      "N7: both probes bind the absolute installed path",
    );
    assert.ok(
      probes.every((call) => call.options?.timeoutMs === VERSION_PROBE_TIMEOUT_MS),
      "both probes use the bounded version timeout",
    );
    // The installed pair is left byte-for-byte untouched.
    assert.equal(await deps.fs.readTextFile(INSTALLED_MATCHLOCK_PATH), "INSTALLED-MATCHLOCK");
    assert.equal(await deps.fs.readTextFile(INSTALLED_GUEST_INIT_PATH), "INSTALLED-GUEST-INIT");
  });

  it("still runs phases after phase 1 on a no-op (drift warning reaches the report)", async () => {
    // `--latest` moves content ahead, so the sync reports drift; the installed
    // pair reports the NEW head, so phase 1 is a no-op but the run must not
    // abort before the post-phase-1 reporting.
    const latest = "e".repeat(40);
    let head = GITLINK_SHA;
    const deps = hostWithInstalledBinaries({
      onRun: async (command, args) => {
        if (command === "git" && args.includes("submodule") && args.includes("status")) {
          const marker = head === GITLINK_SHA ? " " : "+";
          return { code: 0, stdout: `${marker}${head} matchlock (heads/main)\n`, stderr: "" };
        }
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("checkout")) {
          head = latest;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          return { code: 0, stdout: `matchlock 9.9.9 (commit: ${latest}, built: now)\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--latest"], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.idempotent, true);
    assert.match(result.message, /already at /);
    assert.equal(result.message.includes(latest), true);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "submodule-drift"),
      true,
      "the run continues past phase 1 and reports drift",
    );
    assert.deepEqual(buildCalls(deps), []);
  });

  it("rebuilds and reinstalls on --force even when already at the target", async () => {
    const deps = hostWithInstalledBinaries();
    const result = await runMatchlockSetup(["--force"], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.idempotent, undefined, "--force is never reported as a no-op");
    assert.equal(buildCalls(deps).length, 2, "both binaries are rebuilt");
    // --force skips the phase-1 R7 probe; phase 4 still verifies the freshly
    // installed pair, and that probe necessarily runs after the rebuild.
    assert.equal(
      versionProbeCalls(deps).length,
      1,
      "--force skips the phase-1 R7 probe; phase 4 still verifies",
    );
    const firstBuild = deps.calls.findIndex(
      (call) => call.command.endsWith("go") && call.args[0] === "build",
    );
    const firstProbe = deps.calls.findIndex(
      (call) => call.args[0] === "version" && call.command.endsWith("/matchlock"),
    );
    assert.ok(firstProbe > firstBuild, "the only probe is phase 4's verify, after the rebuild");
    assert.equal(
      deps.fsWrites.filter(
        (entry) => entry.startsWith("rename:") && entry.includes("/home/kaladin/.local/bin"),
      ).length,
      2,
      "both binaries are reinstalled",
    );
  });

  it("runs the build and install when the installed commit differs from the target", async () => {
    // Simulate a real rebuild: once go build has run, `matchlock version` reports
    // the target commit so phase 4's verify matches the freshly installed pair.
    let rebuilt = false;
    const deps = hostWithInstalledBinaries({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "build") {
          rebuilt = true;
          return undefined;
        }
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          const commit = rebuilt ? GITLINK_SHA.slice(0, 7) : "b".repeat(7);
          const version = rebuilt ? "0.2.17" : "0.1.0";
          return {
            code: 0,
            stdout: `matchlock ${version} (commit: ${commit}, built: old)\n`,
            stderr: "",
          };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.idempotent, undefined);
    assert.equal(
      versionProbeCalls(deps).length,
      2,
      "the R7 probe (stale) plus the phase-4 verify (rebuilt) both run",
    );
    assert.equal(buildCalls(deps).length, 2, "a stale install is rebuilt");
  });

  it("does not probe when only one installed binary is present", async () => {
    const deps = createFakeDeps({
      files: { [INSTALLED_MATCHLOCK_PATH]: "ONLY-MATCHLOCK" },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(
      versionProbeCalls(deps).length,
      1,
      "the pair must be complete for the phase-1 R7 probe; only phase 4 verifies",
    );
    assert.equal(buildCalls(deps).length, 2);
    assert.equal(await deps.fs.exists(INSTALLED_GUEST_INIT_PATH), true, "guest-init is installed");
  });

  it("fails HARD and non-zero on unparseable installed version output", async () => {
    const deps = hostWithInstalledBinaries({
      onRun: async (command, args) => {
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          return { code: 0, stdout: "this is not a matchlock version line\n", stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "matchlock-version-unparseable");
    assert.equal(result.failure?.hard, true);
    assert.equal((result.failure?.message ?? "").includes(INSTALLED_VERSION_UNPARSEABLE_TRAILER), true);
    assert.deepEqual(buildCalls(deps), [], "an unreadable installed pair is never rebuilt blindly");
    assert.equal(await deps.fs.readTextFile(INSTALLED_MATCHLOCK_PATH), "INSTALLED-MATCHLOCK");
  });

  it("fails HARD when the installed version probe exits non-zero or cannot spawn", async () => {
    const nonZero = hostWithInstalledBinaries({
      onRun: async (command, args) => {
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          return { code: 2, stdout: "", stderr: "boom\n" };
        }
        return undefined;
      },
    });
    const failed = await runMatchlockSetup([], nonZero);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "matchlock-version-unparseable");
    assert.match(failed.failure?.message ?? "", /exited 2/);

    const throwing = hostWithInstalledBinaries({
      onRun: (command, args) => {
        if (args[0] === "version" && command.endsWith("/matchlock")) {
          throw new Error("EACCES");
        }
        return undefined;
      },
    });
    const spawned = await runMatchlockSetup([], throwing);
    assert.equal(spawned.status, "failed");
    assert.equal(spawned.failure?.code, "matchlock-version-unparseable");
    assert.match(spawned.failure?.message ?? "", /could not be spawned/);
  });

  it("exposes the installed identity probe as a tested helper", async () => {
    const deps = hostWithInstalledBinaries();
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const probe = await readInstalledMatchlockIdentity(deps, effective);
    assert.equal(probe.ok, true);
    if (!probe.ok) return;
    assert.equal(probe.identity.version, "0.2.17");
    assert.equal(probe.identity.commit, GITLINK_SHA.slice(0, 7));
  });

  it("does not let --force override submodule dirtiness or the root refusal", async () => {
    // R9: a dirty submodule refuses before the idempotency check, --force or not.
    const dirty = createFakeDeps({
      files: {
        [INSTALLED_MATCHLOCK_PATH]: "INSTALLED-MATCHLOCK",
        [INSTALLED_GUEST_INIT_PATH]: "INSTALLED-GUEST-INIT",
      },
      onRun: async (command, args) => {
        if (command === "git" && args.includes("status") && args.includes("--porcelain")) {
          return { code: 0, stdout: " M src/main.go\n", stderr: "" };
        }
        return undefined;
      },
    });
    const dirtyResult = await runMatchlockSetup(["--force"], dirty);
    assert.equal(dirtyResult.status, "refused");
    assert.equal(dirtyResult.refusal?.code, "submodule-dirty");
    assert.deepEqual(buildCalls(dirty), []);

    // R12: a bare --force is not root consent.
    const rootDeps = createFakeDeps({ euid: 0, env: { HOME: "/home/kaladin" } });
    const rootResult = await runMatchlockSetup(["--force"], rootDeps);
    assert.equal(rootResult.status, "refused");
    assert.equal(rootResult.refusal?.code, "root-refused");
    assert.deepEqual(buildCalls(rootDeps), []);
  });
});

describe("matchlock-setup: US-008 R4 phase 2 host setup", () => {
  const diagnoseCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.args[0] === "diagnose");
  const setupCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.args.includes("setup") && call.args.includes("linux"));

  /**
   * A provisioned host whose `diagnose` reports the host is not ready, so phase
   * 2 runs the identity-selected `setup linux` child. `behavior` scripts that
   * child: success (default), a non-zero exit, or a throw (sudo cancelled).
   */
  function hostWithUnreadyDiagnose(
    overrides: FakeDepsOverrides = {},
    behavior: { setupCode?: number; setupThrows?: boolean } = {},
  ): ReturnType<typeof createFakeDeps> {
    const original = overrides.onRun;
    const setupCode = behavior.setupCode ?? 0;
    return createFakeDeps({
      ...overrides,
      onRun: async (command, args, options) => {
        if (args[0] === "diagnose" && (command === "matchlock" || command.endsWith("/matchlock"))) {
          return { code: 1, stdout: "", stderr: "host not ready\n" };
        }
        if (args.includes("setup") && args.includes("linux")) {
          if (behavior.setupThrows) throw new Error("sudo cancelled");
          return { code: setupCode, stdout: "", stderr: "setup output\n" };
        }
        return original ? original(command, args, options) : undefined;
      },
    });
  }

  it("skips phase 2 with a one-line report when diagnose passes", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.equal(phase2?.status, "skipped");
    assert.equal(phase2?.name, "host-setup");
    assert.equal(phase2?.message, HOST_SETUP_ALREADY_READY_MESSAGE);
    assert.equal(deps.logs.includes(HOST_SETUP_ALREADY_READY_MESSAGE), true);
    assert.equal(result.reloginRequired, false);

    // The gate probes the ABSOLUTE installed path with a bounded timeout (N7).
    // Phase 4's R6 re-verification diagnoses the same file a second time.
    const diagnose = diagnoseCalls(deps);
    assert.equal(diagnose.length, 2);
    assert.ok(
      diagnose.every((call) => call.command === INSTALLED_MATCHLOCK_PATH),
      "both diagnoses bind the absolute installed path",
    );
    assert.ok(
      diagnose.every((call) => JSON.stringify(call.args) === JSON.stringify(["diagnose"])),
      "both diagnoses run plain `diagnose`",
    );
    assert.equal(diagnose[0].options?.timeoutMs, HOST_SETUP_DIAGNOSE_TIMEOUT_MS);
    assert.equal(diagnose[1].options?.timeoutMs, VERIFY_DIAGNOSE_TIMEOUT_MS);
    assert.deepEqual(setupCalls(deps), [], "a ready host runs no setup child");
  });

  it("runs sudo with the absolute installed path for an ordinary user even with the R12 override", async () => {
    const deps = hostWithUnreadyDiagnose();
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG], deps);

    assert.equal(result.status, "ok");
    const setup = setupCalls(deps);
    assert.equal(setup.length, 1);
    assert.equal(setup[0].command, "sudo", "the override does not confer root identity");
    assert.deepEqual(setup[0].args, [INSTALLED_MATCHLOCK_PATH, "setup", "linux"]);
    assert.equal(setup[0].options?.stdio, "inherit");
    assert.equal(setup[0].options?.timeoutMs, HOST_SETUP_TIMEOUT_MS);
  });

  it("runs the absolute binary directly for an already-root process with the override", async () => {
    const deps = hostWithUnreadyDiagnose({ euid: 0, env: { HOME: "/home/alice" } });
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG], deps);

    assert.equal(result.status, "ok");
    const setup = setupCalls(deps);
    assert.equal(setup.length, 1);
    assert.equal(setup[0].command, "/root/.local/bin/matchlock", "no sudo wrapper as root");
    assert.deepEqual(setup[0].args, ["setup", "linux"]);
    assert.equal(setup[0].options?.stdio, "inherit");
    assert.equal(result.reloginRequired, true);
  });

  it("prints the exact command and its effects before spawning the child", async () => {
    let deps!: ReturnType<typeof createFakeDeps>;
    const logsAtSpawn: string[] = [];
    deps = createFakeDeps({
      onRun: async (command, args) => {
        if (args[0] === "diagnose" && command.endsWith("/matchlock")) {
          return { code: 1, stdout: "", stderr: "not ready\n" };
        }
        if (args.includes("setup") && args.includes("linux")) {
          logsAtSpawn.push(...deps.logs);
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      },
    });
    await runMatchlockSetup([], deps);

    const commandText = `sudo ${INSTALLED_MATCHLOCK_PATH} setup linux`;
    assert.equal(
      deps.logs.some((line) => line.includes(commandText)),
      true,
      "the exact command is displayed",
    );
    const rendered = deps.logs.join("\n");
    assert.match(rendered, /Firecracker/);
    assert.match(rendered, /cap_net_admin,cap_net_raw\+ep/);
    assert.match(rendered, new RegExp(INSTALLED_MATCHLOCK_PATH.replace(/\./g, "\\.")));
    assert.match(rendered, /\/dev\/net\/tun/);
    assert.match(rendered, /IPv4 forwarding/);
    assert.match(rendered, /nf_tables/);
    assert.match(rendered, /kvm/);
    assert.match(rendered, /netdev/);
    assert.equal(
      logsAtSpawn.some((line) => line.includes(commandText)),
      true,
      "the command is printed before the child is spawned",
    );
  });

  it("prints the prominent re-login caveat and sets reloginRequired after the phase runs", async () => {
    const deps = hostWithUnreadyDiagnose();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.reloginRequired, true);
    assert.equal(deps.logs.some((line) => line.includes(RELOGIN_CAVEAT)), true);
    assert.equal(deps.logs.some((line) => line.includes("RE-LOGIN REQUIRED")), true);
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.equal(phase2?.status, "ok");
    assert.equal(phase2?.message, RELOGIN_CAVEAT_MESSAGE);
  });

  it("always skips phase 2 on darwin with the macOS report", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      files: { "/usr/bin/codesign": "" },
      env: { HOME: "/Users/kaladin", USER: "kaladin" },
      accountHomes: { kaladin: "/Users/kaladin" },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(deps.logs.includes(HOST_SETUP_MACOS_SKIP_MESSAGE), true);
    assert.equal(result.reloginRequired, false);
    // Phase 2 never diagnoses on darwin; only phase 4's R6 re-verification does.
    const diagnose = diagnoseCalls(deps);
    assert.equal(diagnose.length, 1);
    assert.equal(diagnose[0].command, "/opt/homebrew/bin/matchlock");
    assert.deepEqual(setupCalls(deps), []);
  });

  it("skips phase 2 on linux with --no-host-setup without diagnosing", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup(["--no-host-setup"], deps);

    assert.equal(result.status, "ok");
    assert.equal(deps.logs.includes(HOST_SETUP_SKIPPED_MESSAGE), true);
    assert.equal(result.reloginRequired, false);
    // Phase 2 is skipped; phase 4's R6 re-verification still diagnoses.
    const diagnose = diagnoseCalls(deps);
    assert.equal(diagnose.length, 1);
    assert.equal(diagnose[0].command, INSTALLED_MATCHLOCK_PATH);
    assert.deepEqual(setupCalls(deps), []);
  });

  it("marks a failed phase 2 failed but keeps running (no hard abort, non-zero status)", async () => {
    const deps = hostWithUnreadyDiagnose({}, { setupCode: 7 });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed", "a failed phase is reflected in the overall status");
    assert.equal(result.failure, undefined, "a phase failure is not a phase-1 hard abort");
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.equal(phase2?.status, "failed");
    assert.match(phase2?.message ?? "", /host setup failed/);
    assert.match(phase2?.message ?? "", /exited 7/);
    assert.match(
      phase2?.message ?? "",
      /sudo \/home\/kaladin\/\.local\/bin\/matchlock setup linux/,
      "the exact remaining identity-selected command is printed",
    );
    assert.equal(result.reloginRequired, false, "no group change is assumed on failure");
    // US-013/N1: the aggregate result also prints the bound remaining commands.
    assert.deepEqual(result.remainingCommands, [
      "sudo /home/kaladin/.local/bin/matchlock setup linux",
    ]);
    assert.equal(
      result.message,
      `${phase2?.message}\n${renderRemainingCommands(result.remainingCommands ?? [])}`,
    );
  });

  it("treats a cancelled sudo prompt as a failed phase 2 with the remaining command", async () => {
    const deps = hostWithUnreadyDiagnose({}, { setupThrows: true });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.equal(phase2?.status, "failed");
    assert.match(phase2?.message ?? "", /could not be spawned/);
    assert.match(phase2?.message ?? "", /sudo .*matchlock setup linux/);
  });

  it("prints the direct remaining command for an already-root caller", async () => {
    const deps = hostWithUnreadyDiagnose(
      { euid: 0, env: { HOME: "/home/alice" } },
      { setupCode: 3 },
    );
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG], deps);

    assert.equal(result.status, "failed");
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.match(phase2?.message ?? "", /\/root\/\.local\/bin\/matchlock setup linux/);
    assert.equal((phase2?.message ?? "").includes("sudo"), false);
  });

  it("treats an unsplawnable diagnose as not ready and runs host setup", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (args[0] === "diagnose" && command.endsWith("/matchlock")) {
          throw new Error("ENOENT");
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.equal(setupCalls(deps).length, 1);
    assert.equal(result.reloginRequired, true);
  });

  it("refuses --smoke while a re-login is pending (R4/R6)", async () => {
    const deps = hostWithUnreadyDiagnose();
    const result = await runMatchlockSetup(["--smoke"], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.reloginRequired, true);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "smoke-refused-relogin"),
      true,
    );
    assert.equal(deps.warns.some((line) => line.includes(SMOKE_RELOGIN_REFUSAL_MESSAGE)), true);
  });

  it("reports phase 2 in the phases array on a phase-1 no-op", async () => {
    const deps = createFakeDeps({
      files: {
        [INSTALLED_MATCHLOCK_PATH]: "INSTALLED-MATCHLOCK",
        [INSTALLED_GUEST_INIT_PATH]: "INSTALLED-GUEST-INIT",
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.idempotent, true);
    const phase2 = result.phases.find((phase) => phase.phase === 2);
    assert.equal(phase2?.status, "skipped");
    assert.equal(phase2?.message, HOST_SETUP_ALREADY_READY_MESSAGE);
  });

  it("exposes the phase-2 helpers directly", async () => {
    assert.deepEqual(hostSetupCommand(1000, "/p/matchlock"), [
      "sudo",
      "/p/matchlock",
      "setup",
      "linux",
    ]);
    assert.deepEqual(hostSetupCommand(0, "/p/matchlock"), ["/p/matchlock", "setup", "linux"]);
    assert.match(RELOGIN_CAVEAT, /NEW LOGIN SESSION/);
    assert.match(
      hostSetupEffects("/p/matchlock").join("\n"),
      /cap_net_admin,cap_net_raw\+ep on \/p\/matchlock/,
    );
    assert.equal(smokeRefusedByRelogin(parseOptions(["--smoke"]), true), true);
    assert.equal(smokeRefusedByRelogin(parseOptions(["--smoke"]), false), false);
    assert.equal(smokeRefusedByRelogin(parseOptions([]), true), false);

    // The standalone phase entry is usable on its own (later phases call it).
    const deps = hostWithUnreadyDiagnose();
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const phase = await runHostSetupPhase(parseOptions([]), deps, effective);
    assert.equal(phase.outcome.phase, 2);
    assert.equal(phase.outcome.status, "ok");
    assert.equal(phase.reloginRequired, true);
    assert.deepEqual(phase.command, ["sudo", INSTALLED_MATCHLOCK_PATH, "setup", "linux"]);
  });
});

describe("matchlock-setup: US-009 R5 phase 3 image phase", () => {
  const FULL_DIGEST = `sha256:${"a1b2c3d4".repeat(8)}`;
  const LOCAL_DIGEST = `sha256:${"f".repeat(64)}`;

  function pullCalls(
    deps: FakeMatchlockSetupDeps,
  ): { command: string; args: string[]; options?: RunCommandOptions }[] {
    return deps.calls.filter(
      (call) => call.command === INSTALLED_MATCHLOCK_PATH && call.args[0] === "pull",
    );
  }

  it("pulls the standard image cache-aware with the bounded default timeout", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.name, "boot-assets");
    assert.equal(phase3?.status, "ok");

    const pulls = pullCalls(deps);
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].command, INSTALLED_MATCHLOCK_PATH, "binds the absolute installed path");
    assert.deepEqual(pulls[0].args, ["pull", STANDARD_IMAGE_REFERENCE]);
    assert.equal(pulls[0].options?.stdio, "pipe");
    assert.equal(pulls[0].options?.timeoutMs, DEFAULT_PULL_TIMEOUT_MS);
    assert.equal(DEFAULT_PULL_TIMEOUT_MS, 15 * 60_000);
  });

  it("adds --force only with --refresh-image", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup(["--refresh-image"], deps);

    assert.equal(result.status, "ok");
    assert.deepEqual(pullCalls(deps)[0].args, [
      "pull",
      MATCHLOCK_PULL_FORCE_ARG,
      STANDARD_IMAGE_REFERENCE,
    ]);
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal((phase3?.details as { refreshImage?: boolean })?.refreshImage, true);
  });

  it("uses the TAMANDUA_MATCHLOCK_IMAGE override as the effective reference", async () => {
    const deps = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_IMAGE: "my/custom:tag" },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    assert.deepEqual(pullCalls(deps)[0].args, ["pull", "my/custom:tag"]);
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(
      (phase3?.details as { referenceSource?: string })?.referenceSource,
      "env",
    );
  });

  it("honors the literal TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS and falls back on invalid values", async () => {
    const deps = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: "2000" },
    });
    await runMatchlockSetup([], deps);
    assert.equal(
      pullCalls(deps)[0].options?.timeoutMs,
      2000,
      "the literal canonical override reaches the recorded matchlock pull timeout",
    );

    for (const value of ["", "   ", "not-a-number", "0", "-5"]) {
      assert.equal(
        pullTimeoutMs(
          createFakeDeps({ env: { TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: value } }),
        ),
        DEFAULT_PULL_TIMEOUT_MS,
        `invalid literal timeout ${JSON.stringify(value)} keeps the default`,
      );
    }
    assert.equal(
      pullTimeoutMs(createFakeDeps()),
      DEFAULT_PULL_TIMEOUT_MS,
      "an unset timeout keeps the default",
    );

    // The old misspelled key was never a supported alias: it must be ignored.
    assert.equal(
      pullTimeoutMs(
        createFakeDeps({ env: { TANDAMUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS: "2000" } }),
      ),
      DEFAULT_PULL_TIMEOUT_MS,
      "the misspelled legacy key is ignored, not read",
    );
  });

  it("warns and proceeds when a local entry shadows the reference, never mutating it", async () => {
    const deps = createFakeDeps({
      imageEntries: { [STANDARD_IMAGE_REFERENCE]: { digest: LOCAL_DIGEST, source: "local" } },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok", "the shadow is an accepted override, not a failure");
    const warning = result.warnings?.find((entry) => entry.code === "image-shadow");
    assert.ok(warning, "an image-shadow warning is recorded");
    assert.equal(warning?.message.includes(LOCAL_DIGEST), true, "names the local digest");
    assert.match(warning?.message ?? "", /preference to the registry image/);
    assert.match(warning?.message ?? "", /never deleted, renamed or retagged/);

    assert.equal(pullCalls(deps).length, 1, "the pull still runs");
    // Never delete, rename or retag the local entry.
    assert.equal(
      deps.fsWrites.some((entry) => entry.startsWith("remove:")),
      false,
    );
    assert.equal(
      deps.calls.some(
        (call) =>
          call.args.includes("rm") ||
          call.args.includes("remove") ||
          call.args.includes("tag"),
      ),
      false,
    );
  });

  it("reports the effective image unchanged when --refresh-image runs under a shadow", async () => {
    const deps = createFakeDeps({
      imageEntries: { [STANDARD_IMAGE_REFERENCE]: { digest: LOCAL_DIGEST, source: "local" } },
    });
    const result = await runMatchlockSetup(["--refresh-image"], deps);

    assert.equal(result.status, "ok");
    assert.deepEqual(pullCalls(deps)[0].args, [
      "pull",
      MATCHLOCK_PULL_FORCE_ARG,
      STANDARD_IMAGE_REFERENCE,
    ]);
    const warning = result.warnings?.find((entry) => entry.code === "image-shadow");
    assert.match(warning?.message ?? "", /effective image is UNCHANGED/);
  });

  it("refuses phase 3 with the erofs-utils remedy when mkfs.erofs is missing", async () => {
    const deps = createFakeDeps({ nonExecutables: [`/usr/bin/${MKFS_EROFS_BINARY}`] });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "failed");
    assert.match(phase3?.message ?? "", /mkfs\.erofs/);
    assert.match(phase3?.message ?? "", /apt install erofs-utils/);
    assert.match(phase3?.message ?? "", /phase 2\) is unaffected/);
    assert.equal(pullCalls(deps).length, 0, "the pull never starts");
    // Phase 2 is unaffected by the phase-3 gate.
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "skipped");
  });

  it("names the nix environment for the darwin mkfs.erofs remedy", async () => {
    const deps = createFakeDeps({
      platform: "darwin",
      arch: "arm64",
      files: { "/usr/bin/codesign": "" },
      nonExecutables: [`/usr/bin/${MKFS_EROFS_BINARY}`],
      env: { HOME: "/Users/kaladin", USER: "kaladin" },
      accountHomes: { kaladin: "/Users/kaladin" },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.match(phase3?.message ?? "", /nix/);
    assert.match(phase3?.message ?? "", /erofs-utils/);
    assert.equal(pullCalls(deps).length, 0);
  });

  it("refuses below the 16 GB floor naming the measured space and floor", async () => {
    const low = createFakeDeps({ freeSpaceBytes: 10 * 1024 ** 3 });
    const result = await runMatchlockSetup([], low);

    assert.equal(result.status, "failed");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "failed");
    assert.match(phase3?.message ?? "", /10\.0 GB/);
    assert.match(phase3?.message ?? "", new RegExp(IMAGE_STORE_MIN_FREE_LABEL));
    assert.match(phase3?.message ?? "", /--allow-low-disk-space/);
    assert.equal(pullCalls(low).length, 0, "the pull does not start below the floor");
    assert.equal(
      (phase3?.details as { floorBytes?: number })?.floorBytes,
      IMAGE_STORE_MIN_FREE_BYTES,
    );
  });

  it("starts the pull anyway with --allow-low-disk-space", async () => {
    const deps = createFakeDeps({ freeSpaceBytes: 10 * 1024 ** 3 });
    const result = await runMatchlockSetup(["--allow-low-disk-space"], deps);

    assert.equal(result.status, "ok");
    assert.equal(pullCalls(deps).length, 1);
    assert.equal(
      result.warnings?.some((entry) => entry.code === "low-disk-space-override"),
      true,
    );
  });

  it("skips only the pull with --no-image; the kernel warm still runs", async () => {
    const deps = createFakeDeps({ nonExecutables: [`/usr/bin/${MKFS_EROFS_BINARY}`] });
    const result = await runMatchlockSetup(["--no-image"], deps);

    assert.equal(result.status, "ok");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "ok", "the kernel warm keeps phase 3 from being skipped");
    assert.equal((phase3?.message ?? "").includes(IMAGE_SKIPPED_MESSAGE), true);
    assert.equal(pullCalls(deps).length, 0);
    assert.equal(deps.logs.includes(IMAGE_SKIPPED_MESSAGE), true);
    // US-010/R11: `--no-image` skips ONLY the pull.
    assert.equal(kernelWarmCalls(deps).length, 1, "the kernel warm still runs");
  });

  it("records the digest the pull reports and forwards progress to stderr", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return {
            code: 0,
            stdout: `fetching layers\npulled (${FULL_DIGEST})\n`,
            stderr: "progress: 50%\n",
          };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal((phase3?.details as { digest?: string })?.digest, FULL_DIGEST);
    assert.equal(phase3?.message.includes(FULL_DIGEST), true);
    assert.equal(
      deps.warns.some((line) => line.includes("progress: 50%")),
      true,
      "progress is forwarded to stderr",
    );
    assert.equal(deps.warns.some((line) => line.includes("fetching layers")), true);
  });

  it("marks a pull failure failed with a bounded tail, retry guidance and non-zero status", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 1, stdout: "", stderr: `registry timeout ${"x".repeat(1200)}\n` };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "failed");
    assert.match(phase3?.message ?? "", /exited 1/);
    assert.match(phase3?.message ?? "", /Check registry reachability/);
    assert.match(phase3?.message ?? "", /binaries and host setup are unaffected/);
    assert.equal((phase3?.message ?? "").includes("..."), true, "the stderr tail is bounded");
    assert.ok((phase3?.message ?? "").length < 1200);
  });

  it("treats an unsplawnable pull as a phase failure, not a hard abort", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          throw new Error("ENOENT");
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.match(
      result.phases.find((phase) => phase.phase === 3)?.message ?? "",
      /could not be spawned/,
    );
  });

  it("runs phase 3 even when phase 2 failed (phases are independent)", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "diagnose") {
          return { code: 1, stdout: "", stderr: "not ready\n" };
        }
        if (args.includes("setup") && args.includes("linux")) {
          return { code: 7, stdout: "", stderr: "boom\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "failed");
    assert.equal(
      result.phases.find((phase) => phase.phase === 3)?.status,
      "ok",
      "phase 3 still runs",
    );
    assert.equal(pullCalls(deps).length, 1);
  });

  it("exposes the phase-3 helpers directly", async () => {
    assert.equal(MKFS_EROFS_BINARY, "mkfs.erofs");
    assert.equal(IMAGE_STORE_MIN_FREE_LABEL, "16 GB");
    assert.equal(formatFreeSpace(IMAGE_STORE_MIN_FREE_BYTES), "16.0 GB");
    assert.equal(effectiveImageReference(createFakeDeps()).reference, STANDARD_IMAGE_REFERENCE);
    assert.equal(effectiveImageReference(createFakeDeps()).source, "standard");
    assert.deepEqual(matchlockPullCommand("r", false), ["pull", "r"]);
    assert.deepEqual(matchlockPullCommand("r", true), ["pull", MATCHLOCK_PULL_FORCE_ARG, "r"]);
    assert.equal(parsePullDigest(`pulled (${FULL_DIGEST})`), FULL_DIGEST);
    assert.equal(parsePullDigest("sha256:8fdb9da2... 3893 MB"), "sha256:8fdb9da2");
    assert.equal(parsePullDigest("no digest here"), undefined);

    // The standalone phase entry is usable on its own (later steps compose it).
    const deps = createFakeDeps();
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const phase = await runImagePhase(parseOptions(["--no-image"]), deps, effective);
    assert.equal(phase.outcome.phase, 3);
    assert.equal(phase.outcome.status, "skipped");
    assert.equal(phase.skipped, true);
    assert.equal(phase.reference, STANDARD_IMAGE_REFERENCE);
  });
});

describe("matchlock-setup: US-010 R11 phase 3 guest-kernel warm", () => {
  const KERNEL_VERSION = "6.19.8";
  const KERNEL_PATH = `/home/kaladin/.cache/matchlock/kernels/${KERNEL_VERSION}/kernel`;
  const KERNEL_WARMED_OUTPUT = `guest kernel ${KERNEL_VERSION} (x86_64) warmed: ${KERNEL_PATH}\n`;
  const KERNEL_PRESENT_OUTPUT =
    `guest kernel ${KERNEL_VERSION} (x86_64) already present (no-op): ${KERNEL_PATH}\n`;
  const KERNEL_UNKNOWN_COMMAND_OUTPUT =
    'matchlock: unknown command "kernel" for "matchlock"\n';

  function imagePullCalls(
    deps: FakeMatchlockSetupDeps,
  ): { command: string; args: string[]; options?: RunCommandOptions }[] {
    return deps.calls.filter(
      (call) => call.command === INSTALLED_MATCHLOCK_PATH && call.args[0] === "pull",
    );
  }

  function recordedKernel(
    result: Awaited<ReturnType<typeof runMatchlockSetup>>,
  ): { version?: string; path?: string; alreadyPresent?: boolean } | undefined {
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    return (
      phase3?.details as
        | { kernel?: { version?: string; path?: string; alreadyPresent?: boolean } }
        | undefined
    )?.kernel;
  }

  it("invokes the absolute installed matchlock kernel pull with a bounded timeout", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const calls = kernelWarmCalls(deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, INSTALLED_MATCHLOCK_PATH, "binds the absolute installed path");
    assert.deepEqual(calls[0].args, [MATCHLOCK_KERNEL_COMMAND, MATCHLOCK_KERNEL_PULL_ARG]);
    assert.equal(calls[0].options?.stdio, "pipe");
    assert.equal(calls[0].options?.timeoutMs, DEFAULT_KERNEL_PULL_TIMEOUT_MS);
    assert.equal(DEFAULT_KERNEL_PULL_TIMEOUT_MS, 10 * 60_000);
  });

  it("records the warmed kernel version and path for phase 4", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 0, stdout: KERNEL_WARMED_OUTPUT, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const kernel = recordedKernel(result);
    assert.equal(kernel?.version, KERNEL_VERSION);
    assert.equal(kernel?.path, KERNEL_PATH);
    assert.equal(kernel?.alreadyPresent, false);
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal((phase3?.message ?? "").includes(KERNEL_VERSION), true);
    assert.equal((phase3?.message ?? "").includes(KERNEL_PATH), true);
    // The image sub-step is untouched by the warm.
    assert.equal(imagePullCalls(deps).length, 1);
  });

  it("treats a present kernel of the pinned version as a no-op", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 0, stdout: KERNEL_PRESENT_OUTPUT, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok", "a cached kernel is not a failure");
    const kernel = recordedKernel(result);
    assert.equal(kernel?.alreadyPresent, true);
    assert.equal(kernel?.version, KERNEL_VERSION);
    assert.equal(kernel?.path, KERNEL_PATH);
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.match(phase3?.message ?? "", /already present \(no-op\)/);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "kernel-warm") ?? false,
      false,
      "a no-op warm produces no warning",
    );
  });

  it("warms idempotently: a second run against a present kernel reports the same no-op", async () => {
    let present = false;
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          const stdout = present ? KERNEL_PRESENT_OUTPUT : KERNEL_WARMED_OUTPUT;
          present = true;
          return { code: 0, stdout, stderr: "" };
        }
        return undefined;
      },
    });

    const first = await runMatchlockSetup([], deps);
    const second = await runMatchlockSetup([], deps);

    assert.equal(first.status, "ok");
    assert.equal(second.status, "ok");
    assert.equal(recordedKernel(first)?.alreadyPresent, false);
    assert.equal(recordedKernel(second)?.alreadyPresent, true);
    assert.equal(recordedKernel(second)?.version, KERNEL_VERSION);
    assert.equal(recordedKernel(second)?.path, KERNEL_PATH);
    assert.equal(kernelWarmCalls(deps).length, 2);
  });

  it("fails phase 3 with the pin/update remedy when the binary predates kernel pull", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 1, stdout: "", stderr: KERNEL_UNKNOWN_COMMAND_OUTPUT };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed", "an older pin exits non-zero");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "failed");
    assert.equal(phase3?.message, KERNEL_WARM_MISSING_COMMAND_REMEDY);
    assert.match(phase3?.message ?? "", /tamandua update/);
    assert.match(phase3?.message ?? "", /--force/);
    assert.match(phase3?.message ?? "", /pin/i);
    assert.match(phase3?.message ?? "", /image pull and the installed binaries are unaffected/);
    assert.equal((phase3?.details as { reason?: string })?.reason, "kernel-pull-unsupported");
    // The image pull preceded the warm and is unaffected.
    assert.equal(imagePullCalls(deps).length, 1);
  });

  it("prints a bounded stderr tail and retry guidance on a kernel-warm failure", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 1, stdout: "", stderr: `kernel fetch failed ${"x".repeat(1200)}\n` };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase3 = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phase3?.status, "failed");
    assert.match(phase3?.message ?? "", /exited 1/);
    assert.match(phase3?.message ?? "", /Check registry reachability/);
    assert.match(phase3?.message ?? "", /image pull and the installed binaries are unaffected/);
    assert.equal((phase3?.message ?? "").includes("..."), true, "the stderr tail is bounded");
    assert.ok((phase3?.message ?? "").length < 1200);
    assert.equal((phase3?.details as { reason?: string })?.reason, "kernel-warm-failed");
    assert.equal(imagePullCalls(deps).length, 1, "the image pull is unaffected");
  });

  it("treats an unspawnable kernel pull as a phase failure, not a hard abort", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          throw new Error("ENOENT");
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.match(
      result.phases.find((phase) => phase.phase === 3)?.message ?? "",
      /could not be spawned/,
    );
  });

  it("does not warm the kernel when the image sub-step failed", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 1, stdout: "", stderr: "registry down\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(kernelWarmCalls(deps).length, 0, "retry the warm after fixing the image");
  });

  it("exposes the kernel-warm helpers and composes the phase-3 outcome", async () => {
    assert.deepEqual(matchlockKernelPullCommand(), [
      MATCHLOCK_KERNEL_COMMAND,
      MATCHLOCK_KERNEL_PULL_ARG,
    ]);
    assert.equal(kernelPullCommandMissing(KERNEL_UNKNOWN_COMMAND_OUTPUT), true);
    assert.equal(kernelPullCommandMissing("registry timeout"), false);
    assert.equal(parseKernelPullOutput(KERNEL_WARMED_OUTPUT).version, KERNEL_VERSION);
    assert.equal(parseKernelPullOutput(KERNEL_WARMED_OUTPUT).path, KERNEL_PATH);
    assert.equal(parseKernelPullOutput(KERNEL_WARMED_OUTPUT).alreadyPresent, false);
    assert.equal(parseKernelPullOutput(KERNEL_PRESENT_OUTPUT).alreadyPresent, true);
    assert.equal(parseKernelPullOutput("no version here").version, undefined);
    assert.equal(parseKernelPullOutput("no version here").path, undefined);
    assert.equal(MAX_KERNEL_OUTPUT_TAIL_LENGTH, 400);

    const deps = createFakeDeps();
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const warm: KernelWarmResult = await runKernelWarmPhase(deps, effective);
    assert.equal(warm.outcome.phase, 3);
    assert.equal(warm.outcome.status, "ok");
    assert.deepEqual(warm.command, [MATCHLOCK_KERNEL_COMMAND, MATCHLOCK_KERNEL_PULL_ARG]);

    // A `--no-image` skip plus a successful warm is still an `ok` boot-assets phase.
    const image = await runImagePhase(parseOptions(["--no-image"]), deps, effective);
    const combined = combineBootAssetsPhase(image, warm);
    assert.equal(combined.status, "ok");
    assert.equal(combined.name, "boot-assets");
    assert.equal(combined.phase, 3);
    assert.match(combined.message, /image pull skipped/);
    assert.match(combined.message, /kernel/);
  });
});

describe("matchlock-setup: US-011 R6 phase 4 verify + offline readiness", () => {
  const FULL_DIGEST = `sha256:${"a1b2c3d4".repeat(8)}`;
  const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
  const LOCAL_DIGEST = `sha256:${"f".repeat(64)}`;
  const KERNEL_VERSION = "6.19.8";
  const KERNEL_PATH = `/home/kaladin/.cache/matchlock/kernels/${KERNEL_VERSION}/kernel`;
  const KERNEL_WARMED_OUTPUT = `guest kernel ${KERNEL_VERSION} (x86_64) warmed: ${KERNEL_PATH}\n`;
  const KERNEL_EMBEDDED_OUTPUT =
    `guest kernel ${KERNEL_VERSION} embedded (vendored bzImage; offline by construction)\n`;

  type SetupResult = Awaited<ReturnType<typeof runMatchlockSetup>>;

  function verifyPhase(result: SetupResult) {
    return result.phases.find((phase) => phase.phase === 4);
  }

  function verifyDetails(result: SetupResult): Record<string, unknown> | undefined {
    return verifyPhase(result)?.details;
  }

  function smokeCalls(
    deps: FakeMatchlockSetupDeps,
  ): { command: string; args: string[]; options?: RunCommandOptions }[] {
    return deps.calls.filter(
      (call) => call.command === INSTALLED_MATCHLOCK_PATH && call.args[0] === "run",
    );
  }

  it("re-runs diagnose on the installed file and prints version + commit", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const phase4 = verifyPhase(result);
    assert.equal(phase4?.name, "verify");
    assert.equal(phase4?.status, "ok");
    assert.match(phase4?.message ?? "", /diagnose: host is ready/);
    assert.match(phase4?.message ?? "", /matchlock version: 0\.2\.17/);
    assert.equal((phase4?.message ?? "").includes(GITLINK_SHA.slice(0, 7)), true);

    // Phase 2's gate plus phase 4's R6 re-verification, both absolute (N7).
    const diagnose = deps.calls.filter((call) => call.args[0] === "diagnose");
    assert.equal(diagnose.length, 2);
    assert.equal(diagnose[1].command, INSTALLED_MATCHLOCK_PATH);
    assert.equal(diagnose[1].options?.timeoutMs, VERIFY_DIAGNOSE_TIMEOUT_MS);
  });

  it("reports the effective registry image digest and its source", async () => {
    const deps = createFakeDeps({
      imageEntries: {
        [STANDARD_IMAGE_REFERENCE]: { digest: FULL_DIGEST, source: "registry" },
      },
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 0, stdout: `pulled (${FULL_DIGEST})\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(FULL_DIGEST), true);
    assert.match(message, /source: registry cache/);
    const image = (verifyDetails(result)?.image ?? {}) as { source?: string };
    assert.equal(image.source, "registry");
  });

  it("reports a local shadow as the accepted override with its digest", async () => {
    const deps = createFakeDeps({
      imageEntries: {
        [STANDARD_IMAGE_REFERENCE]: { digest: LOCAL_DIGEST, source: "local" },
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(LOCAL_DIGEST), true);
    assert.match(message, /local built\/imported entry/);
    assert.match(message, /accepted shadow override/);
    const image = (verifyDetails(result)?.image ?? {}) as { source?: string };
    assert.equal(image.source, "local");
  });

  it("reports the warmed kernel version and path", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 0, stdout: KERNEL_WARMED_OUTPUT, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes("kernel: warmed"), true);
    assert.equal(message.includes(KERNEL_VERSION), true);
    assert.equal(message.includes(KERNEL_PATH), true);
    const kernel = (verifyDetails(result)?.kernel ?? {}) as { status?: string };
    assert.equal(kernel.status, "warmed");
  });

  it("reports `embedded` for the vendored QEMU/amd64 kernel", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === MATCHLOCK_KERNEL_COMMAND) {
          return { code: 0, stdout: KERNEL_EMBEDDED_OUTPUT, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes("kernel: embedded"), true);
    assert.match(message, /offline by construction/);
    assert.equal((verifyDetails(result)?.kernel as { status?: string })?.status, "embedded");
    assert.equal(message.includes(OFFLINE_ASSETS_READY_LABEL), true);
  });

  it("closes with the offline verdict and `assets: offline-ready` on a full host", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(OFFLINE_READINESS_HEADING), true);
    assert.equal(message.includes(OFFLINE_ASSETS_READY_LABEL), true);
    assert.equal(message.includes(RUNNABILITY_READY_LABEL), true);
    const details = verifyDetails(result);
    assert.equal(details?.assetsReady, true);
    assert.equal(details?.runnability, "ready");
  });

  it("names a missing asset with its remedy and never implies runnability", async () => {
    const deps = createFakeDeps({ imageEntries: {} });
    const result = await runMatchlockSetup(["--no-image"], deps);

    assert.equal(result.status, "ok", "--no-image is an intentional skip");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(OFFLINE_ASSETS_READY_LABEL), false);
    assert.equal(message.includes(OFFLINE_ASSETS_MISSING_LABEL), true);
    assert.match(message, /standard image/);
    assert.equal(message.includes(IMAGE_MISSING_REMEDY), true);
    const details = verifyDetails(result);
    assert.equal(details?.assetsReady, false);
    assert.deepEqual(details?.missingAssets, [
      `the standard image "${STANDARD_IMAGE_REFERENCE}" (${IMAGE_MISSING_REMEDY})`,
    ]);
    // Assets readiness never implies runnability — and vice versa: diagnose is
    // ready, so runnability is ready even though an asset is missing.
    assert.equal(details?.runnability, "ready");
  });

  it("leads with the re-login caveat and refuses --smoke while a session is pending", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (
          args[0] === "diagnose" &&
          (command === "matchlock" || command.endsWith("/matchlock"))
        ) {
          return { code: 1, stdout: "", stderr: "host not ready\n" };
        }
        if (args.includes("setup") && args.includes("linux")) {
          return { code: 0, stdout: "", stderr: "setup ok\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--smoke"], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.reloginRequired, true);
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(
      message.startsWith(RELOGIN_CAVEAT_MESSAGE),
      true,
      "the report leads with the re-login caveat",
    );
    assert.equal(message.includes(OFFLINE_ASSETS_READY_LABEL), true);
    assert.equal(message.includes(RUNNABILITY_RELOGIN_LABEL), true);
    assert.equal(
      result.warnings?.some((warning) => warning.code === "smoke-refused-relogin"),
      true,
    );
    assert.equal(
      deps.warns.some((line) => line.includes(SMOKE_RELOGIN_REFUSAL_MESSAGE)),
      true,
    );
    assert.equal(smokeCalls(deps).length, 0, "no smoke VM is attempted");
    assert.equal(verifyDetails(result)?.smokeRefused, true);
  });

  it("boots the minimal --no-network smoke VM when allowed", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup(["--smoke"], deps);

    assert.equal(result.status, "ok");
    const calls = smokeCalls(deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, INSTALLED_MATCHLOCK_PATH);
    assert.deepEqual(calls[0].args, matchlockSmokeCommand(STANDARD_IMAGE_REFERENCE));
    assert.equal(calls[0].args.includes("--no-network"), true);
    assert.equal(calls[0].options?.stdio, "inherit");
    assert.equal(calls[0].options?.timeoutMs, SMOKE_TIMEOUT_MS);
    assert.equal(verifyDetails(result)?.smokeRan, true);
    assert.equal(verifyDetails(result)?.smokeRefused, false);
  });

  it("records a failed --smoke boot as a warning without masking the verdict", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "run") {
          return { code: 9, stdout: "", stderr: "vm boot failed\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--smoke"], deps);

    assert.equal(
      result.warnings?.some((warning) => warning.code === "smoke-failed"),
      true,
    );
    assert.equal(verifyDetails(result)?.smokeRan, true);
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(OFFLINE_ASSETS_READY_LABEL), true);
  });

  it("reports a shadow-explained digest mismatch as `shadowed` (informational)", async () => {
    const deps = createFakeDeps({
      imageEntries: {
        [STANDARD_IMAGE_REFERENCE]: { digest: LOCAL_DIGEST, source: "local" },
      },
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 0, stdout: `pulled (${FULL_DIGEST})\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok", "an explained mismatch never fails the run");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(VERIFY_SHADOWED_LABEL), true);
    assert.equal(message.includes(FULL_DIGEST), true);
    const image = (verifyDetails(result)?.image ?? {}) as {
      mismatch?: boolean;
      mismatchExplained?: boolean;
    };
    assert.equal(image.mismatch, true);
    assert.equal(image.mismatchExplained, true);
  });

  it("fails verify (non-zero) on an unexplained digest mismatch", async () => {
    const deps = createFakeDeps({
      imageEntries: {
        [STANDARD_IMAGE_REFERENCE]: { digest: OTHER_DIGEST, source: "registry" },
      },
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 0, stdout: `pulled (${FULL_DIGEST})\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase4 = verifyPhase(result);
    assert.equal(phase4?.status, "failed");
    assert.equal(
      (phase4?.details as { reason?: string })?.reason,
      "verify-image-digest-mismatch",
    );
    assert.match(phase4?.message ?? "", /no local/);
  });

  it("fails verify (non-zero) when the installed commit does not match the target", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (
          args[0] === "version" &&
          (command === "matchlock" || command.endsWith("/matchlock"))
        ) {
          return {
            code: 0,
            stdout: `matchlock 0.9.9 (commit: ${"d".repeat(7)}, built: now)\n`,
            stderr: "",
          };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase4 = verifyPhase(result);
    assert.equal(phase4?.status, "failed");
    assert.equal(
      (phase4?.details as { reason?: string })?.reason,
      "verify-version-mismatch",
    );
    assert.match(phase4?.message ?? "", /does not match/);
  });

  it("classifies effective-vs-pulled image resolution", () => {
    const base = { reference: "img", imageStatus: "ok" as const, imageSkipped: false };

    const registry = classifyEffectiveImage({
      ...base,
      resolved: { digest: FULL_DIGEST, source: "registry" },
      pulledDigest: FULL_DIGEST,
    });
    assert.equal(registry.present, true);
    assert.equal(registry.source, "registry");
    assert.equal(registry.digest, FULL_DIGEST);
    assert.equal(registry.mismatch, false);
    assert.equal(registry.mismatchExplained, false);

    const shadow = classifyEffectiveImage({
      ...base,
      resolved: { digest: LOCAL_DIGEST, source: "local" },
      pulledDigest: FULL_DIGEST,
    });
    assert.equal(shadow.shadowed, true);
    assert.equal(shadow.mismatch, true);
    assert.equal(shadow.mismatchExplained, true);

    const unexplained = classifyEffectiveImage({
      ...base,
      resolved: { digest: OTHER_DIGEST, source: "registry" },
      pulledDigest: FULL_DIGEST,
    });
    assert.equal(unexplained.mismatch, true);
    assert.equal(unexplained.mismatchExplained, false);

    const skipped = classifyEffectiveImage({
      reference: "img",
      imageStatus: "skipped",
      imageSkipped: true,
    });
    assert.equal(skipped.present, false);
    assert.equal(skipped.source, undefined);
    assert.equal(skipped.digest, undefined);

    const pulledOnly = classifyEffectiveImage({
      reference: "img",
      imageStatus: "ok",
      imageSkipped: false,
      pulledDigest: FULL_DIGEST,
    });
    assert.equal(pulledOnly.present, true);
    assert.equal(pulledOnly.digest, FULL_DIGEST);
    assert.equal(pulledOnly.source, "registry");
  });

  it("classifies warmed, embedded, and missing kernels", () => {
    const warmed: KernelWarmResult = {
      outcome: { phase: 3, name: "boot-assets", status: "ok", message: "" },
      kernel: { version: KERNEL_VERSION, path: KERNEL_PATH, alreadyPresent: false },
      command: [MATCHLOCK_KERNEL_COMMAND, MATCHLOCK_KERNEL_PULL_ARG],
      arch: "x64",
      warnings: [],
    };
    const warmedReport = classifyWarmedKernel(warmed);
    assert.equal(warmedReport.status, "warmed");
    assert.equal(warmedReport.version, KERNEL_VERSION);
    assert.equal(warmedReport.path, KERNEL_PATH);
    assert.equal(warmedReport.alreadyPresent, false);

    const embedded = classifyWarmedKernel({
      ...warmed,
      kernel: { version: KERNEL_VERSION, alreadyPresent: true, embedded: true },
    });
    assert.equal(embedded.status, "embedded");
    assert.equal(embedded.alreadyPresent, true);

    assert.equal(classifyWarmedKernel(undefined).status, "missing");
    assert.equal(
      classifyWarmedKernel({
        ...warmed,
        outcome: { phase: 3, name: "boot-assets", status: "failed", message: "boom" },
      }).status,
      "missing",
    );
  });

  it("parses `embedded` out of the kernel-warm output", () => {
    const embedded = parseKernelPullOutput(KERNEL_EMBEDDED_OUTPUT);
    assert.equal(embedded.embedded, true);
    assert.equal(embedded.alreadyPresent, true);
    assert.equal(embedded.version, KERNEL_VERSION);
  });

  it("renders the report with the assets/runnability split", () => {
    const report: VerifyReport = {
      diagnoseReady: true,
      version: "0.2.17",
      commit: GITLINK_SHA.slice(0, 7),
      image: classifyEffectiveImage({
        reference: "img",
        imageStatus: "ok",
        imageSkipped: false,
        pulledDigest: FULL_DIGEST,
      }),
      kernel: classifyWarmedKernel(undefined),
      binariesPresent: true,
      assetsReady: false,
      missingAssets: [`the guest kernel (${KERNEL_MISSING_REMEDY})`],
      runnability: "ready",
      capabilities: {
        status: "verified",
        path: INSTALLED_MATCHLOCK_PATH,
        found: ["cap_net_admin", "cap_net_raw"],
        missing: [],
      },
      expectedBinary: {
        path: INSTALLED_MATCHLOCK_PATH,
        fromEnvOverride: false,
        resolvedFromPath: true,
        shadowed: false,
      },
      staleEnvOverrides: [],
    };
    const rendered = renderVerifyReport(report);
    assert.equal(rendered.includes(VERIFY_REPORT_HEADING), true);
    assert.match(rendered, /matchlock version: 0\.2\.17/);
    assert.equal(rendered.includes(OFFLINE_ASSETS_MISSING_LABEL), true);
    assert.equal(rendered.includes(OFFLINE_ASSETS_READY_LABEL), false);
    assert.equal(rendered.includes(KERNEL_MISSING_REMEDY), true);
    assert.equal(rendered.includes(RUNNABILITY_READY_LABEL), true);

    const hostNotReady = renderVerifyReport({ ...report, runnability: "host-not-ready" });
    assert.equal(hostNotReady.includes(RUNNABILITY_HOST_NOT_READY_LABEL), true);
  });

  it("exposes the phase-4 entry and the smoke argv", async () => {
    assert.deepEqual(matchlockSmokeCommand("img"), [
      "run",
      "--image",
      "img",
      "--no-network",
      "--",
      "true",
    ]);
    assert.equal(SMOKE_TIMEOUT_MS, 10 * 60_000);
    assert.equal(VERIFY_DIAGNOSE_TIMEOUT_MS, 60_000);

    const deps = createFakeDeps({
      files: {
        [INSTALLED_MATCHLOCK_PATH]: "INSTALLED-MATCHLOCK",
        [INSTALLED_GUEST_INIT_PATH]: "INSTALLED-GUEST-INIT",
      },
    });
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const image = await runImagePhase(parseOptions([]), deps, effective);
    const kernel = await runKernelWarmPhase(deps, effective);
    const verify: VerifyPhaseResult = await runVerifyPhase(
      parseOptions([]),
      deps,
      effective,
      { image, kernel, reloginRequired: false, targetCommit: GITLINK_SHA },
    );
    assert.equal(verify.outcome.phase, 4);
    assert.equal(verify.outcome.name, "verify");
    assert.equal(verify.outcome.status, "ok");
    assert.equal(verify.report.assetsReady, true);
    assert.equal(verify.report.runnability, "ready");
    assert.equal(verify.smokeRan, false);
    assert.equal(verify.smokeRefused, false);
  });
});

describe("matchlock-setup: US-012 N7 post-install capability/expected-binary/stale-override checks", () => {
  type SetupResult = Awaited<ReturnType<typeof runMatchlockSetup>>;

  function verifyPhase(result: SetupResult) {
    return result.phases.find((phase) => phase.phase === 4);
  }

  function verifyDetails(result: SetupResult): Record<string, unknown> | undefined {
    return verifyPhase(result)?.details;
  }

  function capabilityDetails(result: SetupResult): {
    status?: string;
    path?: string;
    found?: string[];
    missing?: string[];
    fixCommand?: string[];
  } {
    return (verifyDetails(result)?.capabilities ?? {}) as {
      status?: string;
      path?: string;
      found?: string[];
      missing?: string[];
      fixCommand?: string[];
    };
  }

  function expectedBinaryDetails(result: SetupResult): ExpectedBinaryReport | undefined {
    return verifyDetails(result)?.expectedBinary as ExpectedBinaryReport | undefined;
  }

  it("re-verifies capabilities on the installed absolute file even when diagnose passed", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok");
    const probe = deps.calls.find((call) => call.command === CAPABILITY_PROBE_COMMAND);
    assert.ok(probe, "the capability probe runs in phase 4");
    assert.deepEqual(probe?.args, [INSTALLED_MATCHLOCK_PATH], "argv targets the installed file");
    assert.equal(probe?.options?.stdio, "pipe");
    assert.equal(probe?.options?.timeoutMs, CAPABILITY_PROBE_TIMEOUT_MS);
    // The pre-install/phase-2 diagnose passed (default fake), yet the probe ran.
    assert.equal(verifyDetails(result)?.diagnoseReady, true);

    const capabilities = capabilityDetails(result);
    assert.equal(capabilities.status, "verified");
    assert.equal(capabilities.path, INSTALLED_MATCHLOCK_PATH);
    assert.deepEqual(capabilities.missing, []);
    assert.equal(verifyPhase(result)?.status, "ok");
    assert.match(verifyPhase(result)?.message ?? "", /capabilities: verified/);
    assert.match(verifyPhase(result)?.message ?? "", new RegExp(INSTALLED_MATCHLOCK_PATH.replace(/\./g, "\\.")));
  });

  it("fails verify with the bound sudo fix when the newly installed file lacks a capability", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === CAPABILITY_PROBE_COMMAND) {
          return { code: 0, stdout: `${args[0]} cap_net_raw=ep\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    const phase4 = verifyPhase(result);
    assert.equal(phase4?.status, "failed");
    assert.equal(
      (phase4?.details as { reason?: string })?.reason,
      VERIFY_CAPABILITIES_MISSING_CODE,
    );
    assert.match(phase4?.message ?? "", /missing/);
    assert.match(phase4?.message ?? "", /cap_net_admin/);
    assert.equal(
      (phase4?.message ?? "").includes(`Fix: sudo ${INSTALLED_MATCHLOCK_PATH} setup linux`),
      true,
      "the bound fix is the identity-selected sudo command",
    );
    const capabilities = capabilityDetails(result);
    assert.equal(capabilities.status, "missing");
    assert.deepEqual(capabilities.missing, ["cap_net_admin"]);
    assert.deepEqual(capabilities.fixCommand, [
      "sudo",
      INSTALLED_MATCHLOCK_PATH,
      "setup",
      "linux",
    ]);
    assert.equal(
      deps.logs.some((line) => line.includes("capabilities: MISSING")),
      true,
      "the rendered report marks the capabilities missing",
    );
    assert.equal(
      verifyDetails(result)?.runnability,
      "host-not-ready",
      "a missing capability never reports ready",
    );
    assert.match(phase4?.message ?? "", /sudo .*setup linux/);
  });

  it("prints the direct bound fix for an already-root caller permitted by R12", async () => {
    const rootPath = "/root/.local/bin/matchlock";
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice" },
      onRun: async (command, args) => {
        if (command === CAPABILITY_PROBE_COMMAND) {
          return { code: 0, stdout: `${args[0]} cap_net_raw=ep\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG], deps);

    assert.equal(result.status, "failed");
    const message = verifyPhase(result)?.message ?? "";
    assert.equal(message.includes(`Fix: ${rootPath} setup linux`), true);
    assert.equal(message.includes("sudo"), false, "an already-root caller uses the binary directly");
    assert.deepEqual(capabilityDetails(result).fixCommand, [rootPath, "setup", "linux"]);
  });

  it("re-verifies capabilities on an idempotent no-op run (installation skipped)", async () => {
    const deps = createFakeDeps({
      files: {
        [INSTALLED_MATCHLOCK_PATH]: "INSTALLED-MATCHLOCK",
        [INSTALLED_GUEST_INIT_PATH]: "INSTALLED-GUEST-INIT",
      },
      onRun: async (command, args) => {
        if (command === CAPABILITY_PROBE_COMMAND) {
          return { code: 0, stdout: `${args[0]} cap_net_raw=ep\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.idempotent, true, "the installed pair is already at the target commit");
    assert.equal(result.status, "failed");
    assert.equal(
      (verifyPhase(result)?.details as { reason?: string })?.reason,
      VERIFY_CAPABILITIES_MISSING_CODE,
    );
    assert.equal(
      deps.calls.some((call) => call.command === CAPABILITY_PROBE_COMMAND),
      true,
      "the probe still runs when build/install were skipped",
    );
  });

  it("reports capabilities as inapplicable on darwin and never spawns getcap", async () => {
    const deps = createFakeDeps({ platform: "darwin", arch: "arm64" });
    const effective = resolveMatchlockPaths({
      platform: "darwin",
      account: "kaladin",
      home: "/Users/kaladin",
    });
    const image = await runImagePhase(parseOptions(["--no-image"]), deps, effective);
    const verify = await runVerifyPhase(parseOptions([]), deps, effective, {
      image,
      reloginRequired: false,
      targetCommit: GITLINK_SHA,
    });

    assert.equal(verify.report.capabilities.status, "inapplicable");
    assert.equal(
      deps.calls.some((call) => call.command === CAPABILITY_PROBE_COMMAND),
      false,
    );
    assert.match(renderVerifyReport(verify.report), /capabilities: not applicable/);
  });

  it("reports capabilities as unverified (warning, not failure) when getcap cannot be spawned", async () => {
    const deps = createFakeDeps({
      onRun: async (command) => {
        if (command === CAPABILITY_PROBE_COMMAND) throw new Error("ENOENT");
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok", "an unreadable capability is not proof of a missing one");
    assert.equal(capabilityDetails(result).status, "unavailable");
    assert.match(verifyPhase(result)?.message ?? "", /capabilities: NOT VERIFIED/);
    assert.equal(
      deps.warns.some((line) => line.includes("could not re-verify capabilities")),
      true,
    );
  });

  it("predicts the daemon binary from the literal TAMANDUA_MATCHLOCK_RPC_BIN override and warns on shadowing", async () => {
    const shadowPath = "/usr/local/bin/matchlock";
    const deps = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_RPC_BIN: shadowPath },
    });
    const result = await runMatchlockSetup([], deps);

    const expected = expectedBinaryDetails(result);
    assert.equal(expected?.path, shadowPath, "the literal override becomes the prediction");
    assert.equal(expected?.fromEnvOverride, true);
    assert.equal(expected?.shadowed, true);
    const pathShadow = result.warnings?.find(
      (warning) => warning.code === MATCHLOCK_PATH_SHADOW_WARNING_CODE,
    );
    assert.ok(pathShadow, "a path-shadow warning is recorded");
    assert.match(
      pathShadow.message,
      /TAMANDUA_MATCHLOCK_RPC_BIN/,
      "the shadow warning names the canonical override",
    );
    assert.doesNotMatch(pathShadow.message, /TANDAMUA/, "never the misspelled legacy key");

    // The override only predicts the daemon binary; every setup command stays
    // bound to the installed absolute path (N7).
    const pulls = deps.calls.filter((call) => call.args[0] === "pull");
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].command, INSTALLED_MATCHLOCK_PATH);
    assert.equal(
      deps.calls.some((call) => call.command === shadowPath || call.args.includes(shadowPath)),
      false,
      "no setup command is bound to the shadowing prediction",
    );

    const message = verifyPhase(result)?.message ?? "";
    assert.match(message, /expected daemon binary/);
    assert.match(message, new RegExp(shadowPath.replace(/\./g, "\\.")));
    assert.match(message, /TAMANDUA_MATCHLOCK_RPC_BIN/);
    assert.match(message, /PATH shadowing/);
    assert.match(message, /expected, never verified/);
  });

  it("falls back to matchlock on the operator PATH and warns when it shadows the install", async () => {
    const pathMatchlock = "/usr/local/bin/matchlock";
    const deps = createFakeDeps({
      files: { [pathMatchlock]: "" },
      env: { [MATCHLOCK_RPC_BIN_ENV_NAME]: undefined, PATH: "/usr/local/bin:/usr/bin" },
    });
    const result = await runMatchlockSetup([], deps);

    const expected = expectedBinaryDetails(result);
    assert.equal(expected?.path, pathMatchlock, "PATH resolution is the fallback prediction");
    assert.equal(expected?.fromEnvOverride, false);
    assert.equal(expected?.resolvedFromPath, true);
    assert.equal(expected?.shadowed, true);
    assert.equal(
      result.warnings?.some(
        (warning) => warning.code === MATCHLOCK_PATH_SHADOW_WARNING_CODE,
      ),
      true,
    );
  });

  it("does not warn when the expected binary matches the installed absolute path", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    const expected = expectedBinaryDetails(result);
    assert.equal(expected?.path, INSTALLED_MATCHLOCK_PATH);
    assert.equal(expected?.shadowed, false);
    assert.equal(
      result.warnings?.some(
        (warning) => warning.code === MATCHLOCK_PATH_SHADOW_WARNING_CODE,
      ) ?? false,
      false,
    );
    assert.match(verifyPhase(result)?.message ?? "", /matches the installed path/);
  });

  it("reports each stale MATCHLOCK_* override when set", async () => {
    const deps = createFakeDeps({
      env: {
        MATCHLOCK_FIRECRACKER: "/opt/firecracker",
        MATCHLOCK_JAILER: "/opt/jailer",
        MATCHLOCK_GUEST_INIT: "/opt/guest-init",
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "ok", "stale overrides are reported, never fatal");
    for (const name of STALE_MATCHLOCK_ENV_OVERRIDES) {
      assert.equal(
        result.warnings?.some(
          (warning) =>
            warning.code === STALE_MATCHLOCK_ENV_WARNING_CODE &&
            warning.message.includes(name),
        ),
        true,
        `${name} is reported`,
      );
    }
    const stale = verifyDetails(result)?.staleEnvOverrides as StaleEnvOverride[] | undefined;
    assert.deepEqual(stale, [
      { name: "MATCHLOCK_FIRECRACKER", value: "/opt/firecracker" },
      { name: "MATCHLOCK_JAILER", value: "/opt/jailer" },
      { name: "MATCHLOCK_GUEST_INIT", value: "/opt/guest-init" },
    ]);
    for (const entry of stale ?? []) {
      assert.match(verifyPhase(result)?.message ?? "", new RegExp(`${entry.name}=${entry.value}`));
    }
  });

  it("reports no stale overrides when the environment is clean", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup([], deps);

    assert.deepEqual(verifyDetails(result)?.staleEnvOverrides, []);
    assert.equal(
      result.warnings?.some((warning) => warning.code === STALE_MATCHLOCK_ENV_WARNING_CODE) ??
        false,
      false,
    );
    assert.match(verifyPhase(result)?.message ?? "", /stale env overrides: none/);
  });

  it("parses and classifies getcap output", () => {
    assert.deepEqual(parseGetcapCapabilities("/x cap_net_admin,cap_net_raw=ep"), [
      "cap_net_admin",
      "cap_net_raw",
    ]);
    assert.deepEqual(parseGetcapCapabilities("/x = cap_net_raw+ep"), ["cap_net_raw"]);
    assert.deepEqual(parseGetcapCapabilities(""), []);
    assert.deepEqual(missingMatchlockCapabilities(["cap_net_raw"]), ["cap_net_admin"]);
    assert.deepEqual(missingMatchlockCapabilities(["cap_net_admin", "cap_net_raw"]), []);
    assert.deepEqual(
      missingMatchlockCapabilities([...REQUIRED_MATCHLOCK_CAPABILITIES]),
      [],
    );
    assert.deepEqual(
      capabilitiesFixCommand(1000, "/abs/matchlock"),
      ["sudo", "/abs/matchlock", "setup", "linux"],
    );
    assert.deepEqual(capabilitiesFixCommand(0, "/abs/matchlock"), [
      "/abs/matchlock",
      "setup",
      "linux",
    ]);
  });

  it("probes capabilities directly and reports an unavailable tool", async () => {
    const ok = createFakeDeps();
    const verified = await probeInstalledMatchlockCapabilities(ok, "/abs/matchlock");
    assert.equal(verified.verified, true);
    assert.equal(verified.unavailable, false);
    assert.deepEqual(verified.missing, []);

    const missing = createFakeDeps({
      onRun: async (command, args) => {
        if (command === CAPABILITY_PROBE_COMMAND) {
          return { code: 0, stdout: `${args[0]} cap_net_admin=ep\n`, stderr: "" };
        }
        return undefined;
      },
    });
    const partial = await probeInstalledMatchlockCapabilities(missing, "/abs/matchlock");
    assert.equal(partial.verified, false);
    assert.deepEqual(partial.missing, ["cap_net_raw"]);

    const broken = createFakeDeps({
      onRun: async (command) => {
        if (command === CAPABILITY_PROBE_COMMAND) throw new Error("ENOENT");
        return undefined;
      },
    });
    const unavailable = await probeInstalledMatchlockCapabilities(broken, "/abs/matchlock");
    assert.equal(unavailable.unavailable, true);
    assert.equal(unavailable.verified, false);
  });

  it("resolves the expected daemon binary and stale overrides as pure helpers", async () => {
    const overridden = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_RPC_BIN: "  /opt/custom/matchlock  " },
    });
    const fromEnv = await resolveExpectedDaemonBinary(overridden, INSTALLED_MATCHLOCK_PATH);
    assert.equal(fromEnv.path, "/opt/custom/matchlock", "the override is trimmed");
    assert.equal(fromEnv.fromEnvOverride, true);
    assert.equal(fromEnv.shadowed, true);

    const bare = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_RPC_BIN: undefined },
    });
    const fromPath = await resolveExpectedDaemonBinary(bare, INSTALLED_MATCHLOCK_PATH);
    assert.equal(fromPath.path, MATCHLOCK_BINARY_NAME, "no matchlock on PATH -> bare name");
    assert.equal(fromPath.fromEnvOverride, false);
    assert.equal(fromPath.resolvedFromPath, false);
    assert.equal(fromPath.shadowed, true);

    const blank = createFakeDeps({
      env: { TAMANDUA_MATCHLOCK_RPC_BIN: "   " },
    });
    const fromBlank = await resolveExpectedDaemonBinary(blank, INSTALLED_MATCHLOCK_PATH);
    assert.equal(fromBlank.path, MATCHLOCK_BINARY_NAME, "a blank override is not a value");
    assert.equal(fromBlank.fromEnvOverride, false);

    // The old misspelled key was never a supported alias: it must be ignored.
    const misspelled = createFakeDeps({
      env: {
        TAMANDUA_MATCHLOCK_RPC_BIN: undefined,
        TANDAMUA_MATCHLOCK_RPC_BIN: "/opt/typo/matchlock",
      },
    });
    const fromTypo = await resolveExpectedDaemonBinary(misspelled, INSTALLED_MATCHLOCK_PATH);
    assert.equal(fromTypo.fromEnvOverride, false, "the misspelled legacy key is ignored");
    assert.notEqual(fromTypo.path, "/opt/typo/matchlock");

    assert.deepEqual(
      collectStaleMatchlockEnvOverrides({
        MATCHLOCK_JAILER: "  /opt/jailer  ",
        HOME: "/home/kaladin",
      }),
      [{ name: "MATCHLOCK_JAILER", value: "/opt/jailer" }],
    );
    assert.deepEqual(collectStaleMatchlockEnvOverrides({ MATCHLOCK_JAILER: "   " }), []);

    const shadowWarning = pathShadowWarning(fromEnv, INSTALLED_MATCHLOCK_PATH);
    assert.equal(shadowWarning.code, MATCHLOCK_PATH_SHADOW_WARNING_CODE);
    assert.match(shadowWarning.message, /TAMANDUA_MATCHLOCK_RPC_BIN/);
    assert.doesNotMatch(shadowWarning.message, /TANDAMUA/);
    const staleWarning = staleEnvOverrideWarning({
      name: "MATCHLOCK_JAILER",
      value: "/opt/jailer",
    });
    assert.equal(staleWarning.code, STALE_MATCHLOCK_ENV_WARNING_CODE);
  });
});

describe("matchlock-setup: US-013 N1 cross-phase failure semantics", () => {
  const pullCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.args[0] === "pull");
  const setupCalls = (deps: ReturnType<typeof createFakeDeps>) =>
    deps.calls.filter((call) => call.args.includes("setup") && call.args.includes("linux"));

  it("aborts on a phase 1 failure and marks every later phase not-run", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command.endsWith("go") && args[0] === "build") {
          return { code: 1, stdout: "", stderr: "undefined: main\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "matchlock-build-failed");
    assert.equal(result.phases.find((phase) => phase.phase === 1)?.status, "failed");
    assert.deepEqual(
      result.phases.filter((phase) => phase.phase >= 2).map((phase) => phase.status),
      ["not-run", "not-run", "not-run"],
    );
    // Nothing after the aborted phase 1 ran: no host setup, pull, kernel warm,
    // verify diagnose/version, or smoke.
    assert.deepEqual(setupCalls(deps), []);
    assert.equal(pullCalls(deps).length, 0);
    assert.equal(kernelWarmCalls(deps).length, 0);
  });

  it("keeps phases 2 and 3 independent: a phase 3 failure still runs phase 4", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 1, stdout: "", stderr: "registry timeout\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.phases.find((phase) => phase.phase === 3)?.status, "failed");
    // Phase 2 ran (diagnose passed -> skipped) and was not blocked by phase 3.
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "skipped");
    // Phase 4 still runs and reports the combined state.
    assert.equal(result.phases.find((phase) => phase.phase === 4)?.status, "ok");
  });

  it("prints the exact remaining commands bound to the absolute installed path (phase 3)", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 1, stdout: "", stderr: "registry timeout\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([], deps);

    assert.equal(result.status, "failed");
    assert.deepEqual(result.remainingCommands, [
      `${INSTALLED_MATCHLOCK_PATH} pull ${STANDARD_IMAGE_REFERENCE}`,
      `${INSTALLED_MATCHLOCK_PATH} kernel pull`,
    ]);
    assert.equal(result.message.includes(REMAINING_COMMANDS_HEADING), true);
    assert.equal(result.message.includes(`${INSTALLED_MATCHLOCK_PATH} pull`), true);
    assert.equal(result.message.includes(`${INSTALLED_MATCHLOCK_PATH} kernel pull`), true);
    assert.equal(
      deps.warns.some((line) => line.includes(REMAINING_COMMANDS_HEADING)),
      true,
      "the remaining commands are printed on stderr too",
    );
  });

  it("uses --refresh-image in the remaining pull command", async () => {
    const deps = createFakeDeps({
      onRun: async (command, args) => {
        if (command === INSTALLED_MATCHLOCK_PATH && args[0] === "pull") {
          return { code: 1, stdout: "", stderr: "boom\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup(["--refresh-image"], deps);

    assert.equal(result.status, "failed");
    assert.equal(
      (result.remainingCommands ?? []).includes(
        `${INSTALLED_MATCHLOCK_PATH} pull ${MATCHLOCK_PULL_FORCE_ARG} ${STANDARD_IMAGE_REFERENCE}`,
      ),
      true,
    );
  });

  it("emits a phase-1 abort's remaining commands absolute and sudo-free for root", async () => {
    const deps = createFakeDeps({
      euid: 0,
      useDefaultHost: false,
      env: { HOME: "/home/alice" },
      accountHomes: { root: "/root" },
    });
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG], deps);

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "go-missing");
    // The phase-1 abort leaves phases 2-4 not-run, so all three bound commands
    // are the remaining work. The run is root, so the direct binary is used
    // with no sudo (R12/R4) and the effective home is root's.
    assert.deepEqual(result.remainingCommands, [
      "/root/.local/bin/matchlock setup linux",
      `/root/.local/bin/matchlock pull ${STANDARD_IMAGE_REFERENCE}`,
      "/root/.local/bin/matchlock kernel pull",
    ]);
    assert.equal((result.remainingCommands ?? []).some((c) => c.startsWith("sudo")), false);
  });

  it("forces the effective HOME on EVERY phase child under forced-root mode (smoke run)", async () => {
    const prefix = "/opt/matchlock/bin";
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice" },
      accountHomes: { root: "/root" },
    });
    const result = await runMatchlockSetup(
      [ROOT_OVERRIDE_FLAG, "--prefix", prefix, "--smoke"],
      deps,
    );

    assert.equal(result.status, "ok");
    assert.equal(deps.calls.length > 0, true);
    assert.equal(
      deps.calls.every((call) => call.options?.env?.HOME === "/root"),
      true,
      "every child sees root's account-database home",
    );
    assert.equal(
      deps.calls.some((call) => call.options?.env?.HOME === "/home/alice"),
      false,
      "no child ever inherits the other user's HOME",
    );

    // `--prefix` still governs the install location, and every phase child is
    // bound to the absolute installed path under it (N7). The opt-in smoke boot
    // is a phase-4 child and carries the same effective home.
    assert.equal(
      deps.fsWrites.some((write) => write.includes(`${prefix}/matchlock`)),
      true,
    );
    assert.equal(
      pullCalls(deps).every((call) => call.command === `${prefix}/matchlock`),
      true,
    );
    const kernelCalls = deps.calls.filter((call) => call.args[0] === "kernel");
    assert.equal(kernelCalls.length, 1);
    assert.equal(
      kernelCalls.every((call) => call.command === `${prefix}/matchlock`),
      true,
    );
    const smokeCalls = deps.calls.filter((call) => call.args[0] === "run");
    assert.equal(smokeCalls.length, 1);
    assert.equal(smokeCalls[0].command, `${prefix}/matchlock`);
    assert.equal(smokeCalls[0].options?.env?.HOME, "/root");
  });

  it("forces the effective HOME on the direct host-setup child under forced root", async () => {
    const prefix = "/opt/matchlock/bin";
    const deps = createFakeDeps({
      euid: 0,
      env: { HOME: "/home/alice" },
      accountHomes: { root: "/root" },
      onRun: async (command, args) => {
        if (args[0] === "diagnose" && command === `${prefix}/matchlock`) {
          return { code: 1, stdout: "", stderr: "host not ready\n" };
        }
        return undefined;
      },
    });
    const result = await runMatchlockSetup([ROOT_OVERRIDE_FLAG, "--prefix", prefix], deps);

    assert.equal(result.status, "ok");
    assert.equal(result.reloginRequired, true);
    const setup = setupCalls(deps);
    assert.equal(setup.length, 1);
    // Already-root: the absolute binary runs directly with no sudo (R4/R12).
    assert.equal(setup[0].command, `${prefix}/matchlock`);
    assert.deepEqual(setup[0].args, ["setup", "linux"]);
    assert.equal(setup[0].options?.env?.HOME, "/root");
    assert.equal(
      deps.calls.every((call) => call.options?.env?.HOME === "/root"),
      true,
    );
    assert.equal(
      deps.calls.some((call) => call.options?.env?.HOME === "/home/alice"),
      false,
    );
  });

  it("renders the remaining-command block with a heading and indented commands", () => {
    assert.equal(
      renderRemainingCommands([
        "sudo /home/kaladin/.local/bin/matchlock setup linux",
        "/home/kaladin/.local/bin/matchlock pull igorhvr/tamandua",
      ]),
      [
        REMAINING_COMMANDS_HEADING,
        "    sudo /home/kaladin/.local/bin/matchlock setup linux",
        "    /home/kaladin/.local/bin/matchlock pull igorhvr/tamandua",
      ].join("\n"),
    );
  });

  it("selects remaining commands by phase and effective identity (pure helper)", () => {
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    const outcomes = [
      { phase: 1, name: "binaries", status: "ok" as const, message: "" },
      { phase: 2, name: "host-setup", status: "failed" as const, message: "" },
      { phase: 3, name: "boot-assets", status: "not-run" as const, message: "" },
      { phase: 4, name: "verify", status: "ok" as const, message: "" },
    ];

    assert.deepEqual(
      remainingSetupCommands(outcomes, 1000, effective, STANDARD_IMAGE_REFERENCE, false),
      [
        `sudo ${INSTALLED_MATCHLOCK_PATH} setup linux`,
        `${INSTALLED_MATCHLOCK_PATH} pull ${STANDARD_IMAGE_REFERENCE}`,
        `${INSTALLED_MATCHLOCK_PATH} kernel pull`,
      ],
    );

    const capabilitiesFailure = [
      {
        phase: 4,
        name: "verify",
        status: "failed" as const,
        message: "",
        details: { reason: VERIFY_CAPABILITIES_MISSING_CODE },
      },
    ];
    assert.deepEqual(
      remainingSetupCommands(capabilitiesFailure, 0, effective, STANDARD_IMAGE_REFERENCE, false),
      [`${INSTALLED_MATCHLOCK_PATH} setup linux`],
    );

    // An all-ok run has no remaining work.
    assert.deepEqual(
      remainingSetupCommands(
        [{ phase: 2, name: "host-setup", status: "ok" as const, message: "" }],
        1000,
        effective,
        STANDARD_IMAGE_REFERENCE,
        false,
      ),
      [],
    );
  });

  it("forces HOME in the effective child env while preserving other keys (pure helper)", () => {
    const deps = createFakeDeps({ env: { HOME: "/home/alice", PATH: "/usr/bin" } });
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "root",
      home: "/root",
    });
    assert.deepEqual(matchlockChildEnv(deps, effective), {
      HOME: "/root",
      PATH: "/usr/bin",
      USER: "kaladin",
      [MATCHLOCK_RPC_BIN_ENV_NAME]: INSTALLED_MATCHLOCK_PATH,
    });
  });
});

describe("matchlock-setup: N7 absolute-path binding", () => {
  it("defaults to ~/.local/bin on linux", () => {
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
    });
    assert.equal(effective.prefix, "/home/kaladin/.local/bin");
    assert.equal(effective.matchlockPath, "/home/kaladin/.local/bin/matchlock");
    assert.equal(effective.guestInitPath, "/home/kaladin/.local/bin/guest-init");
  });

  it("defaults to /opt/homebrew/bin on darwin", () => {
    const effective = resolveMatchlockPaths({
      platform: "darwin",
      account: "kaladin",
      home: "/Users/kaladin",
    });
    assert.equal(effective.prefix, DARWIN_DEFAULT_PREFIX);
    assert.equal(effective.prefix, "/opt/homebrew/bin");
    assert.equal(effective.matchlockPath, "/opt/homebrew/bin/matchlock");
    assert.equal(effective.guestInitPath, "/opt/homebrew/bin/guest-init");
  });

  it("honors a --prefix override in every absolute path", () => {
    const effective = resolveMatchlockPaths({
      platform: "linux",
      account: "kaladin",
      home: "/home/kaladin",
      prefix: "/custom/bin",
    });
    assert.equal(effective.prefix, "/custom/bin");
    assert.equal(effective.matchlockPath, "/custom/bin/matchlock");
    assert.equal(effective.guestInitPath, "/custom/bin/guest-init");
    // Store/cache stay under the effective home regardless of --prefix.
    assert.equal(effective.cacheDir, "/home/kaladin/.cache/matchlock");
    assert.equal(effective.imageStore, "/home/kaladin/.cache/matchlock/images");
  });

  it("exposes the default helper per platform", () => {
    assert.equal(defaultPrefixForPlatform("linux", "/home/kaladin"), "/home/kaladin/.local/bin");
    assert.equal(defaultPrefixForPlatform("darwin", "/Users/kaladin"), "/opt/homebrew/bin");
  });

  it("binds the ordinary-user run to HOME-derived absolute paths", async () => {
    const deps = createFakeDeps({
      platform: "linux",
      env: { HOME: "/home/kaladin", USER: "kaladin" },
    });
    const result = await runMatchlockSetup(parseOptions([]), deps);
    assert.equal(result.status, "ok");
    const effective = result.effective as MatchlockEffectivePaths;
    assert.equal(effective.account, "kaladin");
    assert.equal(effective.home, "/home/kaladin");
    assert.equal(effective.prefix, "/home/kaladin/.local/bin");
    assert.equal(effective.imageStore, "/home/kaladin/.cache/matchlock/images");
  });

  it("refuses a relative --prefix rather than binding a non-absolute path", async () => {
    const deps = createFakeDeps();
    const result = await runMatchlockSetup(parseOptions(["--prefix", "relative/bin"]), deps);
    assert.equal(result.status, "refused");
    assert.equal(result.refusal?.code, "prefix-not-absolute");
    assert.equal(deps.calls.length, 0);
  });
});

describe("matchlock-setup: N6 warning rendering", () => {
  it("renders a warning as a bounded single line", () => {
    const line = formatSetupWarning({
      code: "shadow",
      message: "first line\nsecond\tline   spaced",
    });
    assert.equal(line.includes("\n"), false);
    assert.match(line, /warning \[shadow\]/);
    assert.match(line, /first line second line spaced/);
  });

  it("bounds long warning messages to the maximum length", () => {
    const line = formatSetupWarning({ code: "long", message: "A".repeat(4000) });
    assert.ok(line.length <= MAX_SETUP_WARNING_LENGTH);
    assert.ok(line.endsWith("..."));
  });

  it("omits the warnings field entirely when there are no warnings", () => {
    assert.deepEqual(warningsField([]), {});
    const warnings = warningsField([{ code: "c", message: "m" }]);
    assert.deepEqual(warnings, { warnings: [{ code: "c", message: "m" }] });
  });

  it("emits warnings to the stderr seam as one bounded line each", () => {
    const deps = createFakeDeps();
    emitSetupWarnings(deps.output, [
      { code: "a", message: "one\ntwo" },
      { code: "b", message: "three" },
    ]);
    assert.equal(deps.warns.length, 2);
    assert.ok(deps.warns.every((line) => !line.includes("\n")));
    assert.match(deps.warns[0], /warning \[a\]/);
  });

  it("omits warnings from a successful preflight result", async () => {
    const result = await runMatchlockSetup([], createFakeDeps());
    assert.equal(result.status, "ok");
    assert.equal(Object.prototype.hasOwnProperty.call(result, "warnings"), false);
  });
});

describe("matchlock-setup: parallel-lane classification", () => {
  it("is not listed in tests/serial-files.txt", () => {
    const serial = readFileSync(resolve(REPO_ROOT, "tests", "serial-files.txt"), "utf-8");
    const entries = serial
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.equal(entries.includes("src/installer/matchlock-setup.test.ts"), false);
  });
});
