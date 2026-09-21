/**
 * matchlock-long-home.ts — pure plumbing for the long-HOME (>= 90 char)
 * zero-provider real-VM gate (MTLK-FIX item 1c / US-005).
 *
 * The real-model qualification (run #70, isolated run ea2b810c) failed before
 * any model call because Matchlock builds its per-VM Firecracker unix socket
 * path from the HOME string it runs with:
 *
 *   <HOME>/.matchlock/vms/vm-<8hex>/vsock.sock_5001
 *
 * (the longest per-VM socket Matchlock produces; the VFS UDS uses the fixed
 * `VsockPortVFS = 5001`).
 *
 * Linux caps `sockaddr_un.sun_path` at 107 usable bytes, so an 83-char private
 * HOME made Firecracker refuse with "path must be shorter than SUN_LEN". The
 * delivery fix (US-001..US-004) hands the Matchlock CONTROL process a verified
 * short HOME alias — a symlink whose target is the real HOME — so the files
 * behind it (image cache, kernel cache, VM registry) stay shared while the
 * socket path stays short.
 *
 * This module owns the reusable, side-effect-light plumbing the real-VM gate
 * and the fast lane share:
 *   - `buildLongHomePath`: a deterministic absolute real-HOME path of at least
 *     `LONG_HOME_MIN_CHARS` characters under a fresh evidence root;
 *   - `probeLongHomeAlias`: resolve the DEFAULT alias for that real HOME and
 *     report both socket paths, so a test can prove the real HOME would exceed
 *     the limit while the resolved alias does not.
 *
 * It is deliberately free of child processes and VMs so it can be unit-tested
 * in the default fast lane. The real-VM gate is
 * `e2e-tests/matchlock-long-home-gate.test.ts` (run on demand via
 * `./run-matchlock-long-home-e2e-test`).
 */

import path from "node:path";
import {
  MATCHLOCK_SUN_PATH_USABLE_LIMIT,
  computeLongestMatchlockSocketPath,
  describeMatchlockHomeAlias,
  matchlockSocketPathRefusal,
  type MatchlockHomeAliasDeps,
  type MatchlockHomeAliasResolution,
  type MatchlockSocketPathRefusal,
} from "../../dist/installer/matchlock/home-alias.js";

/** Minimum real-HOME length the long-HOME gate must prove works. */
export const LONG_HOME_MIN_CHARS = 90;

/** Subdirectory of the evidence root that carries the long real HOME. */
export const LONG_HOME_SUBDIR = "long-home";

/** Leaf directory name of the long real HOME. */
export const LONG_HOME_LEAF = "home";

/** Smallest pad component `path.join` will keep (a single "." would collapse). */
const MIN_PAD_CHARS = 2;

/**
 * Build a deterministic absolute real-HOME path of at least `minChars`
 * characters (UTF-8 bytes; ASCII by construction) under `evidenceDir`.
 *
 * The pad component length is derived from `evidenceDir`'s own length, so an
 * arbitrarily short evidence root still yields a HOME of exactly `minChars`
 * characters and the path always starts with `evidenceDir + path.sep`.
 */
export function buildLongHomePath(
  evidenceDir: string,
  minChars: number = LONG_HOME_MIN_CHARS,
): string {
  if (!path.isAbsolute(evidenceDir)) {
    throw new Error(
      `buildLongHomePath requires an absolute evidence dir, got "${evidenceDir}"`,
    );
  }
  if (!Number.isInteger(minChars) || minChars < 1) {
    throw new Error(
      `buildLongHomePath requires a positive integer minChars, got ${String(minChars)}`,
    );
  }
  const base = path.join(evidenceDir, LONG_HOME_SUBDIR);
  // base + "/" + pad + "/" + leaf must be >= minChars bytes.
  const fixedBytes =
    Buffer.byteLength(base, "utf8") + 1 + 1 + LONG_HOME_LEAF.length;
  const padChars = Math.max(MIN_PAD_CHARS, minChars - fixedBytes);
  const out = path.join(base, "l".repeat(padChars), LONG_HOME_LEAF);
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes < minChars) {
    throw new Error(
      `buildLongHomePath could not reach ${minChars} chars (got ${bytes}): ${out}`,
    );
  }
  return out;
}

/** Both socket paths and the resolved default alias for a long real HOME. */
export interface LongHomeAliasProbe {
  /** Full alias resolution (alias path, real HOME, disabled flag). */
  resolution: MatchlockHomeAliasResolution;
  /** The long real HOME that was probed. */
  realHome: string;
  /** Byte length of the real HOME. */
  realHomeLength: number;
  /** Longest socket path Matchlock would build from the real HOME. */
  realHomeSocketPath: string;
  /** Byte length of that real-HOME socket path. */
  realHomeSocketBytes: number;
  /** Non-null when the real HOME alone would exceed the sun_path limit. */
  realHomeRefusal: MatchlockSocketPathRefusal | null;
  /** HOME the Matchlock control process would receive (the alias). */
  aliasHome: string;
  /** Longest socket path Matchlock would build from the alias. */
  aliasSocketPath: string;
  /** Byte length of the alias socket path. */
  aliasSocketBytes: number;
  /** Non-null when even the alias would exceed the sun_path limit. */
  aliasRefusal: MatchlockSocketPathRefusal | null;
  /** Usable `sun_path` limit (107 bytes). */
  limit: number;
}

/**
 * Resolve and verify the DEFAULT short-HOME alias for `realHome` (subject to
 * the caller's `TAMANDUA_MATCHLOCK_HOME_ALIAS` environment) and report both
 * computed socket paths. Creates/repairs the alias symlink exactly as the
 * production resolver does; callers that must not touch a shared tmpdir pass
 * an explicit `tmpdir`.
 */
export function probeLongHomeAlias(
  realHome: string,
  deps: Omit<MatchlockHomeAliasDeps, "realHome"> = {},
): LongHomeAliasProbe {
  const resolution = describeMatchlockHomeAlias({ ...deps, realHome });
  const realHomeSocketPath = computeLongestMatchlockSocketPath(realHome);
  const aliasSocketPath = computeLongestMatchlockSocketPath(resolution.home);
  return {
    resolution,
    realHome,
    realHomeLength: Buffer.byteLength(realHome, "utf8"),
    realHomeSocketPath,
    realHomeSocketBytes: Buffer.byteLength(realHomeSocketPath, "utf8"),
    realHomeRefusal: matchlockSocketPathRefusal(realHome),
    aliasHome: resolution.home,
    aliasSocketPath,
    aliasSocketBytes: Buffer.byteLength(aliasSocketPath, "utf8"),
    aliasRefusal: matchlockSocketPathRefusal(resolution.home),
    limit: MATCHLOCK_SUN_PATH_USABLE_LIMIT,
  };
}
