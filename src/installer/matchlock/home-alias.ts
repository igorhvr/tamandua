/**
 * home-alias.ts — short-HOME alias for the Matchlock CONTROL process.
 *
 * Matchlock builds its per-VM unix socket path from the HOME string it runs
 * with (`<HOME>/.matchlock/vms/vm-<8hex>/vsock.sock_5001` is the longest; see
 * the pre-flight section below). Linux caps `sun_path`
 * at 108 bytes including the NUL, so a long HOME makes Firecracker refuse
 * before any model call ("path must be shorter than SUN_LEN"). To keep any
 * user HOME working, every Matchlock control process Tamandua spawns is given
 * a short HOME alias: a symlink to the real HOME at a short path.
 *
 * Because the alias is a symlink, the files behind it are the SAME
 * `~/.matchlock` and `~/.cache/matchlock`: image cache, kernel cache and VM
 * registry stay shared and `matchlock list/rm/gc` keep seeing the same VMs.
 * ONLY the Matchlock control process gets the alias; the daemon, harness
 * rounds and the guest keep the real HOME.
 *
 * Escape hatch (`TAMANDUA_MATCHLOCK_HOME_ALIAS`):
 *   - unset/empty          -> default short alias (see below)
 *   - `off` (any case) / `0` -> alias disabled; the caller keeps the real HOME
 *   - absolute path        -> that path IS the alias location (still verified)
 *   - anything else        -> typed refusal (`override_not_absolute`)
 *
 * Default alias path: `/tmp/tamandua/<uid>/h`, where `<uid>` is the effective
 * uid. The default root is the LITERAL `/tmp` (NOT the platform temp dir): the
 * alias exists precisely so the socket path stays short regardless of a caller's
 * TMPDIR (a gate/daemon may run with TMPDIR pointing at a deep directory; a
 * platform-temp-derived alias would then be longer than the HOME it replaces).
 * `/tmp/tamandua/<uid>` is created with mode 0700 and must stay owned by the
 * user; the alias symlink target must equal the real HOME byte-for-byte (no
 * trailing slash, no relative spelling).
 *
 * This module is a LEAF: Node-core imports only (`node:fs`, `node:os`,
 * `node:path`) and no child-process spawn, so it may sit inside the guest-pack
 * walk closure under `installer/matchlock`. Every side effect is injectable
 * (`fs`, `uid`, `tmpdir`, `env`, `realHome`) for deterministic tests.
 *
 * It also owns the pre-flight SUN_LEN guard (US-004): even with the alias, the
 * effective HOME may still be too long (alias disabled, or an overridden alias
 * directory), so `computeLongestMatchlockSocketPath` / `matchlockSocketPathRefusal`
 * compute the longest socket path Matchlock would produce and refuse BEFORE any
 * RPC/VM effect. See the section comment above those exports for the layout
 * derivation (read-only reference `/opt/matchlock`).
 */

import fs from "node:fs";
import path from "node:path";

/** Env var controlling the Matchlock short-HOME alias (see module docs). */
export const MATCHLOCK_HOME_ALIAS_ENV = "TAMANDUA_MATCHLOCK_HOME_ALIAS";

/** Leaf name of the default alias symlink inside the per-uid directory. */
export const MATCHLOCK_HOME_ALIAS_LEAF = "h";

/** Mode of the per-uid alias parent directory (`/tmp/tamandua/<uid>`). */
export const MATCHLOCK_HOME_ALIAS_PARENT_MODE = 0o700;

/** Typed code carried by every {@link MatchlockHomeAliasError}. */
export const MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE = "matchlock_home_alias_untrusted";

/**
 * Why the alias could not be trusted. Every refusal names the concrete
 * problem so the caller can render a clear, actionable message.
 */
export type MatchlockHomeAliasReason =
  | "home_unset"
  | "home_not_absolute"
  | "override_not_absolute"
  | "parent_untrusted"
  | "parent_unwritable"
  | "alias_not_symlink"
  | "alias_wrong_owner"
  | "alias_wrong_target"
  | "alias_dangling"
  | "alias_create_failed";

/** Typed fail-closed error for an untrustworthy short-HOME alias. */
export class MatchlockHomeAliasError extends Error {
  readonly code: string = MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE;
  readonly reason: MatchlockHomeAliasReason;
  readonly aliasPath: string;

  constructor(reason: MatchlockHomeAliasReason, message: string, aliasPath = "") {
    super(message);
    this.name = "MatchlockHomeAliasError";
    this.reason = reason;
    this.aliasPath = aliasPath;
  }
}

/** Minimal stat shape used for the alias symlink and its parent directory. */
export interface MatchlockHomeAliasStats {
  uid: number;
  mode: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

/** Injectable filesystem surface (a subset of `node:fs`). */
export interface MatchlockHomeAliasFs {
  lstatSync(path: string): MatchlockHomeAliasStats;
  readlinkSync(path: string): string;
  symlinkSync(target: string, linkPath: string): void;
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
  statSync(path: string): MatchlockHomeAliasStats;
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
}

/** Injectable inputs for the resolver. */
export interface MatchlockHomeAliasDeps {
  /** Environment to read HOME + TAMANDUA_MATCHLOCK_HOME_ALIAS from. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Explicit real HOME (overrides `env.HOME`; tests). */
  realHome?: string;
  /** Effective uid used for ownership checks + the default path (tests). */
  uid?: number;
  /** Directory used as the default alias root (tests). */
  tmpdir?: string;
  /** Filesystem surface (tests). */
  fs?: MatchlockHomeAliasFs;
}

/** Result of resolving the short-HOME alias. */
export interface MatchlockHomeAliasResolution {
  /** HOME value the Matchlock control process must receive. */
  home: string;
  /** Verified alias path, or `null` when the alias is disabled. */
  aliasPath: string | null;
  /** The user's real HOME (never sent to Matchlock when the alias is active). */
  realHome: string;
  /** True when the escape hatch disabled the alias. */
  disabled: boolean;
  /** Alias parent directory, or `null` when the alias is disabled. */
  parentDir: string | null;
}

function nodeFs(): MatchlockHomeAliasFs {
  return {
    lstatSync: (p) => fs.lstatSync(p),
    readlinkSync: (p) => fs.readlinkSync(p),
    symlinkSync: (target, linkPath) => {
      fs.symlinkSync(target, linkPath);
    },
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    statSync: (p) => fs.statSync(p),
    chmodSync: (p, mode) => {
      fs.chmodSync(p, mode);
    },
    unlinkSync: (p) => {
      fs.unlinkSync(p);
    },
  };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code as string | undefined
    : undefined;
}

function stripTrailingSlash(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function refusal(
  reason: MatchlockHomeAliasReason,
  message: string,
  aliasPath = "",
): MatchlockHomeAliasError {
  return new MatchlockHomeAliasError(reason, message, aliasPath);
}

/**
 * Ensure the alias parent directory exists, is a directory, and (for the
 * default `/tmp/tamandua/<uid>` parent) is mode 0700 owned by the user.
 */
function ensureAliasParent(
  parentDir: string,
  uid: number,
  io: MatchlockHomeAliasFs,
  strict: boolean,
): void {
  let st: MatchlockHomeAliasStats;
  try {
    st = io.statSync(parentDir);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw refusal(
        "parent_unwritable",
        `short-HOME alias parent "${parentDir}" cannot be inspected (${errorCode(err) ?? "unknown error"}); ` +
          `make it a writable directory owned by uid ${uid}`,
        parentDir,
      );
    }
    try {
      io.mkdirSync(parentDir, { recursive: true, mode: MATCHLOCK_HOME_ALIAS_PARENT_MODE });
    } catch (mkErr) {
      throw refusal(
        "parent_unwritable",
        `short-HOME alias parent "${parentDir}" cannot be created (${errorCode(mkErr) ?? "unknown error"}); ` +
          `the parent must be writable by uid ${uid} (override TAMANDUA_MATCHLOCK_HOME_ALIAS at a short directory)`,
        parentDir,
      );
    }
    try {
      st = io.statSync(parentDir);
    } catch (statErr) {
      throw refusal(
        "parent_unwritable",
        `short-HOME alias parent "${parentDir}" cannot be inspected after creation (${errorCode(statErr) ?? "unknown error"})`,
        parentDir,
      );
    }
  }

  if (!st.isDirectory()) {
    throw refusal(
      "parent_untrusted",
      `short-HOME alias parent "${parentDir}" exists but is not a directory`,
      parentDir,
    );
  }
  if (!strict) return;

  if (st.uid !== uid) {
    throw refusal(
      "parent_untrusted",
      `short-HOME alias parent "${parentDir}" is owned by uid ${st.uid}, not the effective uid ${uid}`,
      parentDir,
    );
  }
  const mode = st.mode & 0o777;
  if (mode !== MATCHLOCK_HOME_ALIAS_PARENT_MODE) {
    try {
      io.chmodSync(parentDir, MATCHLOCK_HOME_ALIAS_PARENT_MODE);
    } catch (chmodErr) {
      throw refusal(
        "parent_untrusted",
        `short-HOME alias parent "${parentDir}" has mode 0${mode.toString(8)} instead of 0700 and cannot be tightened ` +
          `(${errorCode(chmodErr) ?? "unknown error"})`,
        parentDir,
      );
    }
  }
}

/**
 * Verify (and repair when safely possible) the alias symlink at `aliasPath`.
 * Called on EVERY use; never trusts a pre-existing entry.
 */
function ensureAliasSymlink(
  aliasPath: string,
  realHome: string,
  uid: number,
  io: MatchlockHomeAliasFs,
  depth = 0,
): void {
  let st: MatchlockHomeAliasStats;
  try {
    st = io.lstatSync(aliasPath);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw refusal(
        "alias_create_failed",
        `short-HOME alias "${aliasPath}" cannot be inspected (${errorCode(err) ?? "unknown error"})`,
        aliasPath,
      );
    }
    createAliasSymlink(aliasPath, realHome, io);
    assertRealHomeResolves(aliasPath, realHome, io);
    return;
  }

  if (!st.isSymbolicLink()) {
    throw refusal(
      "alias_not_symlink",
      `short-HOME alias "${aliasPath}" exists but is not a symlink; refusing to use or remove it`,
      aliasPath,
    );
  }
  if (st.uid !== uid) {
    throw refusal(
      "alias_wrong_owner",
      `short-HOME alias "${aliasPath}" is owned by uid ${st.uid}, not the effective uid ${uid}`,
      aliasPath,
    );
  }

  let target: string;
  try {
    target = io.readlinkSync(aliasPath);
  } catch (err) {
    throw refusal(
      "alias_create_failed",
      `short-HOME alias "${aliasPath}" target cannot be read (${errorCode(err) ?? "unknown error"})`,
      aliasPath,
    );
  }

  if (target !== realHome) {
    // A symlink that resolves nowhere is a dangling entry we will not
    // silently rewrite; a wrong-but-live target is a stale alias we repair.
    const resolvedTarget = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(aliasPath), target);
    let resolves = true;
    try {
      io.statSync(resolvedTarget);
    } catch {
      resolves = false;
    }
    if (!resolves) {
      throw refusal(
        "alias_dangling",
        `short-HOME alias "${aliasPath}" is a dangling symlink to "${target}"; refusing to use it`,
        aliasPath,
      );
    }
    if (depth > 0) {
      throw refusal(
        "alias_wrong_target",
        `short-HOME alias "${aliasPath}" points at "${target}" instead of the real HOME "${realHome}" and could not be replaced`,
        aliasPath,
      );
    }
    // Wrong but live target: replace with the correct symlink.
    try {
      io.unlinkSync(aliasPath);
      io.symlinkSync(realHome, aliasPath);
    } catch (err) {
      throw refusal(
        "alias_wrong_target",
        `short-HOME alias "${aliasPath}" points at "${target}", not the real HOME "${realHome}", and cannot be replaced ` +
          `(${errorCode(err) ?? "unknown error"})`,
        aliasPath,
      );
    }
    ensureAliasSymlink(aliasPath, realHome, uid, io, depth + 1);
    return;
  }

  // Target matches byte-for-byte; the link must not dangle.
  assertRealHomeResolves(aliasPath, realHome, io);
}

function assertRealHomeResolves(
  aliasPath: string,
  realHome: string,
  io: MatchlockHomeAliasFs,
): void {
  try {
    io.statSync(realHome);
  } catch {
    throw refusal(
      "alias_dangling",
      `short-HOME alias "${aliasPath}" points at the real HOME "${realHome}", which does not exist`,
      aliasPath,
    );
  }
}

function createAliasSymlink(
  aliasPath: string,
  realHome: string,
  io: MatchlockHomeAliasFs,
): void {
  try {
    io.symlinkSync(realHome, aliasPath);
  } catch (err) {
    const code = errorCode(err);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOSPC") {
      throw refusal(
        "parent_unwritable",
        `short-HOME alias "${aliasPath}" cannot be created (${code}); the parent directory is not writable`,
        aliasPath,
      );
    }
    throw refusal(
      "alias_create_failed",
      `short-HOME alias "${aliasPath}" cannot be created (${code ?? "unknown error"})`,
      aliasPath,
    );
  }
}

/**
 * Resolve and verify the short-HOME alias (see module docs). Throws
 * {@link MatchlockHomeAliasError} when HOME is unusable or the alias cannot be
 * made trustworthy.
 */
export function describeMatchlockHomeAlias(
  deps: MatchlockHomeAliasDeps = {},
): MatchlockHomeAliasResolution {
  const env = deps.env ?? process.env;
  const io = deps.fs ?? nodeFs();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  // LITERAL `/tmp`, never the platform temp dir: the alias must stay short even when the
  // caller runs with a deep TMPDIR (the whole point of the alias). Tests inject
  // `deps.tmpdir`; the escape hatch can point the alias elsewhere.
  const tmpdir = deps.tmpdir ?? "/tmp";

  const rawHome = deps.realHome ?? env.HOME ?? "";
  if (rawHome.length === 0 || rawHome.trim().length === 0) {
    throw refusal("home_unset", "HOME is unset or empty; cannot create the Matchlock short-HOME alias");
  }
  if (!path.isAbsolute(rawHome)) {
    throw refusal(
      "home_not_absolute",
      `HOME "${rawHome}" is not an absolute path; cannot create the Matchlock short-HOME alias`,
    );
  }
  const realHome = stripTrailingSlash(rawHome);

  const overrideRaw = env[MATCHLOCK_HOME_ALIAS_ENV];
  const override = overrideRaw === undefined ? "" : overrideRaw.trim();

  let aliasPath: string;
  let strictParent = false;
  if (override.length === 0) {
    aliasPath = path.resolve(tmpdir, "tamandua", String(uid), MATCHLOCK_HOME_ALIAS_LEAF);
    strictParent = true;
  } else if (override === "0" || /^off$/i.test(override)) {
    return {
      home: realHome,
      aliasPath: null,
      realHome,
      disabled: true,
      parentDir: null,
    };
  } else if (path.isAbsolute(override)) {
    aliasPath = stripTrailingSlash(override);
  } else {
    throw refusal(
      "override_not_absolute",
      `${MATCHLOCK_HOME_ALIAS_ENV}="${overrideRaw}" is neither "off"/"0" nor an absolute path`,
    );
  }

  const parentDir = path.dirname(aliasPath);
  ensureAliasParent(parentDir, uid, io, strictParent);
  ensureAliasSymlink(aliasPath, realHome, uid, io);

  return {
    home: aliasPath,
    aliasPath,
    realHome,
    disabled: false,
    parentDir,
  };
}

/**
 * Resolve the HOME value the Matchlock control process must run with: the
 * verified short alias, or the real HOME when the escape hatch disables it.
 */
export function resolveMatchlockHomeAlias(deps: MatchlockHomeAliasDeps = {}): string {
  return describeMatchlockHomeAlias(deps).home;
}

/**
 * Copy `baseEnv` with ONLY `HOME` replaced by the verified alias (or the real
 * HOME when disabled). Every other entry is preserved unchanged.
 */
export function buildMatchlockProcessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  aliasHome: string,
): Record<string, string | undefined> {
  if (aliasHome.length === 0 || aliasHome.trim().length === 0) {
    throw refusal("home_unset", "cannot build the Matchlock process env with an empty HOME");
  }
  return { ...baseEnv, HOME: aliasHome };
}

// ── Pre-flight SUN_LEN socket-path guard (US-004 / item 1b) ──────────
//
// Matchlock builds every per-VM unix socket path from the HOME string it runs
// with. The layout below is derived from the read-only Matchlock reference at
// `/opt/matchlock` (this module never imports from it):
//
//   - `pkg/state/state.go` `NewManager()`:
//       baseDir = filepath.Join(home, ".matchlock", "vms")
//   - `pkg/api/config.go` `Config.GetID()`:
//       ID = "vm-" + uuid.New().String()[:8]   (8 lowercase hex chars)
//   - `pkg/state/state.go` `SocketPath(id)` = filepath.Join(baseDir, id, "socket")
//   - `pkg/sandbox/sandbox_linux.go`:
//       SocketPath = stateMgr.SocketPath(id) + ".sock"      -> "<id>/socket.sock"
//       also ExecSocketPath -> "<id>/exec.sock"; Dir(id)+"/vsock.sock"
//   - `pkg/sandbox/sandbox_linux.go` (VFS server, Firecracker/Darwin UDS path):
//       vfsSocketPath = fmt.Sprintf("%s_%d", vmConfig.VsockPath, linux.VsockPortVFS)
//       with VsockPortVFS = 5001 (`pkg/vm/linux/backend.go`) ->
//       "<id>/vsock.sock_5001"
//
// The longest produced path is therefore:
//   `<HOME>/.matchlock/vms/vm-XXXXXXXX/vsock.sock_5001`
// (`vsock.sock_5001` is 15 chars, longer than `socket.sock` 11, `vsock.sock`
// 10 and `exec.sock` 9; the observed real bind failure was
// `<vmDir>/vsock.sock_5001`).
//
// Linux `struct sockaddr_un.sun_path` is 108 bytes and must be NUL-terminated,
// so the usable path length is 107 bytes (~ 108 - 1). A path of 108 bytes or
// more makes Firecracker/the kernel refuse with "path must be shorter than
// SUN_LEN" BEFORE any model call. This guard fires before any RPC/VM effect.

/** Matchlock's VM state subdirectory under HOME (`pkg/state/state.go`). */
export const MATCHLOCK_VM_DIR_RELATIVE = path.join(".matchlock", "vms");

/** Fixed VM-id prefix (`pkg/api/config.go` `Config.GetID`). */
export const MATCHLOCK_VM_ID_PREFIX = "vm-";

/** Fixed VM-id hex length (`uuid.New().String()[:8]`, `pkg/api/config.go`). */
export const MATCHLOCK_VM_ID_HEX_CHARS = 8;

/**
 * Longest socket file name Matchlock produces. The Firecracker/Darwin VFS
 * listener is a UDS at `<id>/vsock.sock_<VsockPortVFS>` with the fixed
 * `VsockPortVFS = 5001` (`pkg/sandbox/sandbox_linux.go` +
 * `pkg/vm/linux/backend.go`), so `vsock.sock_5001` (15) beats
 * `socket.sock` (11), `vsock.sock` (10) and `exec.sock` (9).
 */
export const MATCHLOCK_LONGEST_SOCKET_FILE_NAME = "vsock.sock_5001";

/** Size of Linux `sun_path` including the required trailing NUL. */
export const MATCHLOCK_SUN_PATH_BYTES = 108;

/** Usable Linux `sun_path` length in bytes (108 - 1 for the NUL terminator). */
export const MATCHLOCK_SUN_PATH_USABLE_LIMIT = MATCHLOCK_SUN_PATH_BYTES - 1;

/** Typed code for the pre-flight SUN_LEN refusal. */
export const MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE = "matchlock_home_socket_path_too_long";

/**
 * Bytes appended to HOME by the longest Matchlock socket path layout:
 * `/.matchlock/vms` (15) + `/` (1) + `vm-XXXXXXXX` (11) + `/vsock.sock_5001`
 * (16, including the separating slash).
 */
export const MATCHLOCK_SOCKET_PATH_ADDED_BYTES = 43;

/** Actionable pre-flight refusal returned by {@link matchlockSocketPathRefusal}. */
export interface MatchlockSocketPathRefusal {
  /** Byte length of the longest socket path Matchlock will produce. */
  length: number;
  /** Usable `sun_path` limit (107 bytes, i.e. 108 including the NUL). */
  limit: number;
  /** The HOME the refusal applies to (the exact value about to be passed). */
  home: string;
  /** The longest socket path that was computed. */
  path: string;
  /** Message naming the limit, the computed length, the HOME and the remedy. */
  message: string;
}

/**
 * The longest unix socket path Matchlock will produce from `home`, using the
 * fixed layout documented above. `path.join` mirrors Go's `filepath.Join`
 * cleaning, so a trailing slash on HOME does not inflate the result.
 */
export function computeLongestMatchlockSocketPath(home: string): string {
  const vmId = `${MATCHLOCK_VM_ID_PREFIX}${"0".repeat(MATCHLOCK_VM_ID_HEX_CHARS)}`;
  return path.join(home, MATCHLOCK_VM_DIR_RELATIVE, vmId, MATCHLOCK_LONGEST_SOCKET_FILE_NAME);
}

/**
 * Pre-flight check for the Linux `sun_path` limit. Returns `null` when the
 * longest path Matchlock would produce from `home` fits, otherwise an
 * actionable refusal naming the 107-byte limit, the computed byte length, the
 * HOME in use and the remedy. Never has side effects: the caller refuses
 * BEFORE any RPC/VM effect.
 */
export function matchlockSocketPathRefusal(
  home: string,
  limit: number = MATCHLOCK_SUN_PATH_USABLE_LIMIT,
): MatchlockSocketPathRefusal | null {
  const longest = computeLongestMatchlockSocketPath(home);
  const length = Buffer.byteLength(longest, "utf8");
  if (length <= limit) return null;
  return {
    length,
    limit,
    home,
    path: longest,
    message:
      `matchlock cannot create a VM with HOME "${home}": the longest unix socket path it produces ` +
      `("${longest}") is ${length} bytes, over the Linux ${limit}-byte sun_path limit ` +
      `(${MATCHLOCK_SUN_PATH_BYTES} including the NUL terminator). Shorten HOME, keep the ` +
      `${MATCHLOCK_HOME_ALIAS_ENV} short-HOME alias enabled, or point ${MATCHLOCK_HOME_ALIAS_ENV} ` +
      `at a short directory.`,
  };
}
