/**
 * native-signal-backend.ts — per-host native signal-isolation backend
 * selection and launcher-argv construction (KHYG US-001).
 *
 * This module is intentionally PURE (no child_process, no spawn): it only
 * decides which backend is available for the current host and builds the
 * argv that later launches one harness execution inside its OWN fresh native
 * signal domain. The actual spawn + readiness/release handshake lives in the
 * shared launch mechanism (US-002).
 *
 * Backends
 * --------
 *  - Linux  -> `landlock`: dist/native/landlock-helper (compiled from
 *    native/landlock-helper.c during `npm run build`). The helper applies a
 *    Landlock ruleset to itself (LANDLOCK_SCOPE_SIGNAL, handled FS_REFER
 *    only with one allow rule at '/') and execs the harness after a private
 *    control-fd release handshake.
 *  - macOS  -> `seatbelt`: /usr/bin/sandbox-exec -p <profile> <argv...>
 *    with the bundled Seatbelt profile (native/seatbelt-signal.sb):
 *    `(version 1) (allow default) (deny signal) (allow signal (target
 *    same-sandbox))`. Opportunistic: no compile is needed, but sandbox-exec
 *    must exist on the host.
 *  - otherwise -> `unavailable` with a machine-readable reason.
 *
 * Best effort is NOT a complete security boundary: unprotected senders can
 * still signal protected targets; same-execution self-kills remain possible;
 * filesystem writes and indirect service-control APIs are out of scope.
 *
 * Test seams: every probe takes optional overrides (platform, artifact dir,
 * sandbox-exec path) so tests can exercise any host/backend combination
 * without touching the real environment. These are function parameters, not
 * user-facing CLI knobs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Minimum Landlock ABI supporting LANDLOCK_SCOPE_SIGNAL (do not raise). */
export const LANDLOCK_MIN_ABI = 6;

/**
 * Documented helper exit codes (must stay in sync with native/landlock-helper.c).
 * Pre-exec setup failures use HELPER_EXIT_SETUP_FAILURE and never execute the
 * target; after release the target replaces the helper via exec, so any code
 * observed post-READY belongs to the harness.
 */
export const HELPER_EXIT_USAGE = 124;
export const HELPER_EXIT_SETUP_FAILURE = 125;
export const HELPER_EXIT_EXEC_FAILURE = 126;

/** Default control fd passed to the landlock helper (extra stdio slot). */
export const LANDLOCK_CONTROL_FD = 3;

/** Canonical Seatbelt profile text (single line, exactly the tested policy). */
export const SEATBELT_PROFILE_TEXT =
  "(version 1) (allow default) (deny signal) (allow signal (target same-sandbox))";

/** Conventional macOS sandbox-exec location. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Names of the artifacts under dist/native/. */
export const LANDLOCK_HELPER_BASENAME = "landlock-helper";
export const SEATBELT_PROFILE_BASENAME = "seatbelt-signal.sb";
export const UNAVAILABLE_MARKER_BASENAME = ".unavailable.json";

// ── Discriminated backend result ───────────────────────────────────

export interface LandlockBackend {
  kind: "landlock";
  /** Absolute path to the compiled helper (dist/native/landlock-helper). */
  helperPath: string;
}

export interface SeatbeltBackend {
  kind: "seatbelt";
  /** Absolute path to /usr/bin/sandbox-exec. */
  sandboxExec: string;
  /** Absolute path to the bundled profile asset (dist/native/seatbelt-signal.sb). */
  profilePath: string;
}

export interface UnavailableBackend {
  kind: "unavailable";
  /** Machine-readable reason token (e.g. unsupported-platform,
   *  landlock-helper-not-built, missing-compiler, sandbox-exec-missing). */
  reason: string;
}

export type NativeSignalBackend = LandlockBackend | SeatbeltBackend | UnavailableBackend;

// ── Probe options (test seams) ─────────────────────────────────────

export interface BackendProbeOptions {
  /** Host platform to probe for. Defaults to process.platform. */
  platform?: string;
  /** Directory holding the native artifacts. Defaults to dist/native. */
  artifactDir?: string;
  /** sandbox-exec path (macOS). Defaults to /usr/bin/sandbox-exec. */
  sandboxExecPath?: string;
}

// ── Artifact resolution ────────────────────────────────────────────

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the packaged native-artifact directory.
 * dist/installer/native-signal-backend.js -> <dist>/native
 */
export function nativeArtifactsDir(): string {
  return path.resolve(MODULE_DIR, "..", "native");
}

export function defaultHelperPath(artifactDir: string = nativeArtifactsDir()): string {
  return path.join(artifactDir, LANDLOCK_HELPER_BASENAME);
}

export function defaultProfilePath(artifactDir: string = nativeArtifactsDir()): string {
  return path.join(artifactDir, SEATBELT_PROFILE_BASENAME);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readUnavailableReason(artifactDir: string): string | null {
  try {
    const markerPath = path.join(artifactDir, UNAVAILABLE_MARKER_BASENAME);
    const raw = fs.readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as { reason?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason !== "") return parsed.reason;
    return "unavailable-marker";
  } catch {
    return null;
  }
}

// ── Backend probing ────────────────────────────────────────────────

/**
 * Decide the native signal-isolation backend available for the (possibly
 * overridden) host. Never spawns anything; only inspects artifacts + fs.
 */
export function probeBackend(options?: BackendProbeOptions): NativeSignalBackend {
  const platform = options?.platform ?? process.platform;
  const artifactDir = options?.artifactDir ?? nativeArtifactsDir();

  if (platform === "linux") {
    // An explicit unavailable marker is AUTHORITATIVE: a failed artifact
    // refresh (or an unavailable build) must never select stale executable
    // output left over from an earlier successful build. Freshness wins.
    const buildReason = readUnavailableReason(artifactDir);
    if (buildReason !== null) {
      return { kind: "unavailable", reason: buildReason };
    }
    const helperPath = defaultHelperPath(artifactDir);
    if (isExecutable(helperPath)) {
      return { kind: "landlock", helperPath };
    }
    return { kind: "unavailable", reason: "landlock-helper-not-built" };
  }

  if (platform === "darwin") {
    const sandboxExec = options?.sandboxExecPath ?? SANDBOX_EXEC_PATH;
    const profilePath = defaultProfilePath(artifactDir);
    if (!isExecutable(sandboxExec)) {
      return { kind: "unavailable", reason: "sandbox-exec-missing" };
    }
    if (!fs.existsSync(profilePath)) {
      return { kind: "unavailable", reason: "seatbelt-profile-missing" };
    }
    return { kind: "seatbelt", sandboxExec, profilePath };
  }

  return { kind: "unavailable", reason: "unsupported-platform" };
}

// ── Launcher argv construction ─────────────────────────────────────

export interface LandlockLaunchSpec {
  kind: "landlock";
  argv: string[];
  helperPath: string;
  controlFd: number;
}

export interface SeatbeltLaunchSpec {
  kind: "seatbelt";
  argv: string[];
  sandboxExec: string;
  profilePath: string;
  /** Inline profile text passed to sandbox-exec -p (from the asset). */
  profileText: string;
}

export type ProtectedLaunchSpec = LandlockLaunchSpec | SeatbeltLaunchSpec;

export interface LaunchArgvOptions {
  /** Control fd the helper should use (extra stdio slot). Default 3. */
  controlFd?: number;
  /** Pre-probed backend; when omitted, probeBackend(options) is used. */
  backend?: LandlockBackend | SeatbeltBackend;
  /** Probe overrides (ignored when backend is supplied). */
  probe?: BackendProbeOptions;
}

/**
 * Build the launcher argv that wraps `command` in one fresh native signal
 * domain for the current host:
 *
 *  - landlock: [helper, --control-fd <n>, --, ...command]
 *  - seatbelt: [sandbox-exec, -p, <profile-text>, ...command]
 *
 * Returns null when no backend is available (callers treat that as the
 * unprotected-fallback path with the probe's machine-readable reason).
 */
export function buildProtectedLaunchArgv(
  command: string[],
  options?: LaunchArgvOptions,
): { spec: ProtectedLaunchSpec; backend: LandlockBackend | SeatbeltBackend } | null {
  if (command.length === 0) return null;
  const backend = options?.backend ?? probeBackend(options?.probe);
  if (backend.kind === "unavailable") return null;

  if (backend.kind === "landlock") {
    const controlFd = options?.controlFd ?? LANDLOCK_CONTROL_FD;
    return {
      spec: {
        kind: "landlock",
        helperPath: backend.helperPath,
        controlFd,
        argv: [backend.helperPath, "--control-fd", String(controlFd), "--", ...command],
      },
      backend,
    };
  }

  const profileText = fs.readFileSync(backend.profilePath, "utf8").trim();
  return {
    spec: {
      kind: "seatbelt",
      sandboxExec: backend.sandboxExec,
      profilePath: backend.profilePath,
      profileText,
      argv: [backend.sandboxExec, "-p", profileText, ...command],
    },
    backend,
  };
}
