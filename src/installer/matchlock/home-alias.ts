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
 * Default alias path: `/tmp/tamandua/<uid>/<k>/h`, where `<uid>` is the
 * effective uid and `<k>` is {@link matchlockHomeAliasKey}: the first 8 hex
 * chars of the SHA-256 of the daemon's absolute REAL home. The key makes the
 * alias unique PER DAEMON INSTANCE: two daemons of the same uid with different
 * homes resolve different `<k>` directories and can never re-point each other's
 * symlink (the historical defect). A restart of the same daemon reuses the same
 * `<k>`. The default root is the LITERAL `/tmp` (NOT the platform temp dir):
 * the alias exists precisely so the socket path stays short regardless of a
 * caller's TMPDIR (a gate/daemon may run with TMPDIR pointing at a deep
 * directory; a platform-temp-derived alias would then be longer than the HOME it
 * replaces). Both `/tmp/tamandua/<uid>` and `/tmp/tamandua/<uid>/<k>` are
 * created with mode 0700, must be REAL directories (never symlinks) and must
 * stay owned by the user; the alias symlink target must equal the real HOME
 * byte-for-byte (no trailing slash, no relative spelling).
 *
 * MIGRATION: the historical single-symlink layout `/tmp/tamandua/<uid>/h` is
 * IGNORED by this module — it is never `lstat`ed, read, unlinked or re-pointed,
 * and it remains byte-identical across a resolution. The keyed code only ever
 * touches `<uid>/<k>` (its own key), so another daemon's keyed alias and the
 * legacy symlink are untouchable.
 *
 * OWNERSHIP (US-002): next to the alias lives `<aliasDir>/owner.json`, a
 * 0600 sidecar recording the daemon that claims the keyed alias (`pid`, kernel
 * `startIdentity`, `realHome`, `aliasPath`, `updatedAt`). Before this daemon
 * creates or re-points the alias it consults that sidecar:
 *   - no sidecar           -> repair/re-point (legacy behavior); adopt ownership
 *   - our own record       -> reuse/refresh it, never refuse
 *   - a LIVE holder        -> typed refusal `alias_owned_by_live_daemon`
 *   - a STALE holder       -> take over (re-point + rewrite the sidecar)
 *   - malformed/unreadable -> typed refusal `alias_owner_unreadable` (fail closed)
 * Liveness is NOT decided here: the host-side `home-alias-owner.ts` supplies the
 * predicate (kernel start identity + pid-existence tie-breaker) through
 * {@link MatchlockHomeAliasDeps.owner}, keeping this module tree-shakeable and
 * free of child-process imports.
 *
 * This module is a LEAF: Node-core imports only (`node:crypto`, `node:fs`,
 * `node:path`) and no child-process spawn, so it may sit inside the
 * guest-pack walk closure under `installer/matchlock`. Every side effect is
 * injectable (`fs`, `uid`, `tmpdir`, `env`, `realHome`, `owner`, `now`) for
 * deterministic tests.
 *
 * It also owns the pre-flight SUN_LEN guard (US-004): even with the alias, the
 * effective HOME may still be too long (alias disabled, or an overridden alias
 * directory), so `computeLongestMatchlockSocketPath` / `matchlockSocketPathRefusal`
 * compute the longest socket path Matchlock would produce and refuse BEFORE any
 * RPC/VM effect. See the section comment above those exports for the layout
 * derivation (read-only reference `/opt/matchlock`).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Env var controlling the Matchlock short-HOME alias (see module docs). */
export const MATCHLOCK_HOME_ALIAS_ENV = "TAMANDUA_MATCHLOCK_HOME_ALIAS";

/** Leaf name of the default alias symlink inside the per-daemon key directory. */
export const MATCHLOCK_HOME_ALIAS_LEAF = "h";

/**
 * Hex characters of {@link matchlockHomeAliasKey}. Eight hex chars (32 bits)
 * keep the path short while making the chance of a same-uid collision between
 * two distinct homes negligible; the value must stay within 6-8 (see
 * `MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS`).
 */
export const MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS = 8;

/** Mode of the keyed alias directories (`/tmp/tamandua/<uid>` and `<uid>/<k>`). */
export const MATCHLOCK_HOME_ALIAS_PARENT_MODE = 0o700;

/** Typed code carried by every {@link MatchlockHomeAliasError}. */
export const MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE = "matchlock_home_alias_untrusted";

/** Basename of the per-alias ownership sidecar inside `<aliasDir>`. */
export const MATCHLOCK_HOME_ALIAS_OWNER_FILE = "owner.json";

/** Schema string recorded in every ownership sidecar (forward/backward gate). */
export const MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA = "tamandua.matchlock.home-alias-owner.v1";

/** Mode of the ownership sidecar (`<aliasDir>/owner.json`). */
export const MATCHLOCK_HOME_ALIAS_OWNER_MODE = 0o600;

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
  | "alias_create_failed"
  | "alias_owned_by_live_daemon"
  | "alias_owner_unreadable";

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
  isFile(): boolean;
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
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number }): void;
  renameSync(oldPath: string, newPath: string): void;
}

/**
 * Recorded owner of a keyed alias (the JSON shape of `<aliasDir>/owner.json`).
 * `startIdentity` is the daemon's kernel start identity (`v2:<pid>:<epochMs>`),
 * so a recycled pid can never masquerade as the recorded owner.
 */
export interface MatchlockHomeAliasOwnerRecord {
  schema: string;
  pid: number;
  startIdentity: string;
  realHome: string;
  aliasPath: string;
  updatedAt: string;
}

/** Classification of a recorded owner against the live process table. */
export type MatchlockHomeAliasOwnerLiveness = "same" | "different" | "unknown";

/**
 * Host-supplied ownership inputs. `home-alias.ts` never decides liveness
 * itself: the host module (`home-alias-owner.ts`) supplies the kernel-proven
 * predicate so this leaf never imports a process-spawning module.
 */
export interface MatchlockHomeAliasOwnerDeps {
  /** Kernel-proven identity of the CURRENT daemon process. */
  pid: number;
  /** Kernel start identity (`v2:<pid>:<epochMs>`) of the current daemon. */
  startIdentity: string;
  /**
   * Classify a sidecar record: `same` = the recorded owner is still alive,
   * `different` = the recorded process is gone (stale, safe to take over),
   * `unknown` = liveness cannot be proven (fail closed).
   */
  classifyOwner: (owner: MatchlockHomeAliasOwnerRecord) => MatchlockHomeAliasOwnerLiveness;
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
  /**
   * Ownership identity + liveness predicate. When absent the ownership
   * protocol is skipped entirely (US-001 behavior); production wires it in
   * `home-alias-owner.ts`.
   */
  owner?: MatchlockHomeAliasOwnerDeps;
  /** Injectable clock for the sidecar `updatedAt` (tests). */
  now?: () => Date;
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
  /**
   * Per-daemon key `<k>` for a DEFAULT keyed alias, or `null` when the alias is
   * disabled or an absolute override supplied the alias location.
   */
  aliasKey: string | null;
  /**
   * Directory that owns this daemon's alias (the keyed `<uid>/<k>` directory
   * for a default alias, or `dirname(aliasPath)` for an override), or `null`
   * when the alias is disabled.
   */
  aliasDir: string | null;
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
    readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
    writeFileSync: (p, data, opts) => {
      fs.writeFileSync(p, data, opts);
    },
    renameSync: (oldPath, newPath) => {
      fs.renameSync(oldPath, newPath);
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

/**
 * Stable, pure per-daemon alias key `<k>`: the first
 * {@link MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS} lowercase hex chars of the SHA-256
 * of the daemon's absolute REAL home. The same real HOME always returns the
 * same key (a restart reuses its alias); two distinct homes return different
 * keys (no same-uid collision in practice), which is the whole point: the alias
 * becomes unique per daemon instance instead of one symlink shared by every
 * daemon of the uid.
 *
 * A trailing slash is normalized away so `HOME=/home/a` and `HOME=/home/a/`
 * key identically, matching {@link describeMatchlockHomeAlias}.
 */
export function matchlockHomeAliasKey(realHome: string): string {
  return crypto
    .createHash("sha256")
    .update(stripTrailingSlash(realHome), "utf8")
    .digest("hex")
    .slice(0, MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS);
}

function refusal(
  reason: MatchlockHomeAliasReason,
  message: string,
  aliasPath = "",
): MatchlockHomeAliasError {
  return new MatchlockHomeAliasError(reason, message, aliasPath);
}

/**
 * Ensure the OVERRIDE alias parent directory exists and is a directory.
 *
 * The default keyed layout does NOT use this: its two levels get the stricter
 * real-0700-owned checks in {@link ensureOwnedRealDirectory}. An absolute
 * `TAMANDUA_MATCHLOCK_HOME_ALIAS` override keeps the historical behavior
 * (follow a symlinked parent, no ownership/mode rewrite).
 */
function ensureAliasParent(
  parentDir: string,
  uid: number,
  io: MatchlockHomeAliasFs,
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
}

/**
 * Ensure a directory that must be a REAL directory owned by `uid` with mode
 * 0700: the keyed `/tmp/tamandua/<uid>` and `/tmp/tamandua/<uid>/<k>` levels.
 *
 * Uses `lstat` so a symlink at either level (an attacker-planted link, or a
 * legacy layout) is a typed refusal — never followed and never removed.
 * `mkdir` is recursive so the two levels can be created together, and it never
 * enumerates or removes existing entries: a legacy `<uid>/h` symlink stays
 * byte-identical.
 */
function ensureOwnedRealDirectory(
  dir: string,
  uid: number,
  io: MatchlockHomeAliasFs,
  label: string,
): void {
  let st: MatchlockHomeAliasStats;
  try {
    st = io.lstatSync(dir);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw refusal(
        "parent_unwritable",
        `${label} "${dir}" cannot be inspected (${errorCode(err) ?? "unknown error"}); ` +
          `make it a real writable directory owned by uid ${uid}`,
        dir,
      );
    }
    try {
      io.mkdirSync(dir, { recursive: true, mode: MATCHLOCK_HOME_ALIAS_PARENT_MODE });
    } catch (mkErr) {
      throw refusal(
        "parent_unwritable",
        `${label} "${dir}" cannot be created (${errorCode(mkErr) ?? "unknown error"}); ` +
          `the path must be writable by uid ${uid} (override ${MATCHLOCK_HOME_ALIAS_ENV} at a short directory)`,
        dir,
      );
    }
    try {
      st = io.lstatSync(dir);
    } catch (statErr) {
      throw refusal(
        "parent_unwritable",
        `${label} "${dir}" cannot be inspected after creation (${errorCode(statErr) ?? "unknown error"})`,
        dir,
      );
    }
  }

  if (!st.isDirectory()) {
    throw refusal(
      "parent_untrusted",
      `${label} "${dir}" exists but is not a real directory` +
        (st.isSymbolicLink() ? " (it is a symlink); refusing to follow it" : ""),
      dir,
    );
  }
  if (st.uid !== uid) {
    throw refusal(
      "parent_untrusted",
      `${label} "${dir}" is owned by uid ${st.uid}, not the effective uid ${uid}`,
      dir,
    );
  }
  const mode = st.mode & 0o777;
  if (mode !== MATCHLOCK_HOME_ALIAS_PARENT_MODE) {
    try {
      io.chmodSync(dir, MATCHLOCK_HOME_ALIAS_PARENT_MODE);
    } catch (chmodErr) {
      throw refusal(
        "parent_untrusted",
        `${label} "${dir}" has mode 0${mode.toString(8)} instead of 0700 and cannot be tightened ` +
          `(${errorCode(chmodErr) ?? "unknown error"})`,
        dir,
      );
    }
  }
}

/**
 * Absolute path of the ownership sidecar for a keyed alias directory. Exposed
 * for `tamandua doctor` (US-004) and for tests; the resolver never derives it
 * from any other daemon's key.
 */
export function matchlockHomeAliasOwnerPath(aliasDir: string): string {
  return path.join(aliasDir, MATCHLOCK_HOME_ALIAS_OWNER_FILE);
}

function isValidOwnerRecord(value: unknown): value is MatchlockHomeAliasOwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    o.schema === MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA &&
    typeof o.pid === "number" &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.startIdentity === "string" &&
    /^v2:\d+:\d+$/.test(o.startIdentity) &&
    typeof o.realHome === "string" &&
    o.realHome.length > 0 &&
    typeof o.aliasPath === "string" &&
    o.aliasPath.length > 0 &&
    typeof o.updatedAt === "string" &&
    o.updatedAt.length > 0
  );
}

function ownerUnreadableRefusal(ownerPath: string, detail: string): MatchlockHomeAliasError {
  return refusal(
    "alias_owner_unreadable",
    `short-HOME alias owner sidecar "${ownerPath}" ${detail}; refusing to re-point the alias. ` +
      `Remove "${ownerPath}" to reset alias ownership, then retry.`,
    ownerPath,
  );
}

/**
 * Read and validate `<aliasDir>/owner.json`. Returns `null` when the sidecar
 * does not exist (a fresh alias or a legacy tree with no ownership record).
 * Throws `alias_owner_unreadable` for anything else — a symlinked/non-regular
 * entry, an unreadable file, invalid JSON or a missing/malformed field — so a
 * daemon NEVER re-points an alias whose ownership it cannot prove.
 */
function readAliasOwnerRecord(
  aliasDir: string,
  io: MatchlockHomeAliasFs,
): MatchlockHomeAliasOwnerRecord | null {
  const ownerPath = matchlockHomeAliasOwnerPath(aliasDir);
  let st: MatchlockHomeAliasStats;
  try {
    st = io.lstatSync(ownerPath);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw ownerUnreadableRefusal(
      ownerPath,
      `cannot be inspected (${errorCode(err) ?? "unknown error"})`,
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw ownerUnreadableRefusal(ownerPath, "is not a regular file");
  }
  let raw: string;
  try {
    raw = io.readFileSync(ownerPath, "utf8");
  } catch (err) {
    throw ownerUnreadableRefusal(
      ownerPath,
      `cannot be read (${errorCode(err) ?? "unknown error"})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ownerUnreadableRefusal(ownerPath, "is not valid JSON");
  }
  if (!isValidOwnerRecord(parsed)) {
    throw ownerUnreadableRefusal(ownerPath, "does not match the owner schema");
  }
  return parsed;
}

/**
 * Read `<aliasDir>/owner.json` read-only for `tamandua doctor` (US-004).
 *
 * Returns `null` when the sidecar does not exist. Throws a typed
 * `alias_owner_unreadable` {@link MatchlockHomeAliasError} (naming the sidecar
 * path) for an unreadable/malformed sidecar — the same validation the
 * resolver's ownership gate uses, so doctor reports exactly what a daemon
 * would refuse on. Never writes.
 */
export function readMatchlockHomeAliasOwner(
  aliasDir: string,
  io: MatchlockHomeAliasFs = nodeFs(),
): MatchlockHomeAliasOwnerRecord | null {
  return readAliasOwnerRecord(aliasDir, io);
}

/**
 * Ownership gate for creating/re-pointing a keyed alias.
 *
 *   - no sidecar            -> allow (legacy repair; adoption)
 *   - the current process   -> allow (reuse/refresh our own alias)
 *   - a live other daemon   -> `alias_owned_by_live_daemon`, naming the holder
 *   - a stale (dead) owner  -> allow (take over)
 *   - unprovable liveness   -> `alias_owner_unreadable` (fail closed)
 *
 * The old alias symlink is never unlinked before this returns: on refusal it
 * stays byte-identical (AC #4).
 */
function assertAliasTakeoverAllowed(
  aliasPath: string,
  aliasDir: string,
  owner: MatchlockHomeAliasOwnerDeps,
  io: MatchlockHomeAliasFs,
): void {
  const record = readAliasOwnerRecord(aliasDir, io);
  if (record === null) return;
  if (record.pid === owner.pid && record.startIdentity === owner.startIdentity) return;

  const liveness = owner.classifyOwner(record);
  if (liveness === "different") return;
  if (liveness === "same") {
    throw refusal(
      "alias_owned_by_live_daemon",
      `short-HOME alias "${aliasPath}" is held by a live daemon (pid ${record.pid}, ` +
        `start identity ${record.startIdentity}, real HOME "${record.realHome}"); ` +
        `refusing to re-point it. Stop that daemon or run this one against a different HOME, then retry.`,
      aliasPath,
    );
  }
  throw ownerUnreadableRefusal(
    matchlockHomeAliasOwnerPath(aliasDir),
    `names pid ${record.pid} (start identity ${record.startIdentity}) but its liveness could not be proven`,
  );
}

/**
 * Atomically write (tmp + rename) the ownership sidecar with mode 0600. A
 * failed write is a typed `alias_owner_unreadable` refusal: the alias may have
 * been created but ownership is unrecorded, so the daemon must fail closed
 * rather than run with an alias it cannot later prove.
 */
function writeAliasOwnerRecord(
  aliasPath: string,
  aliasDir: string,
  realHome: string,
  owner: MatchlockHomeAliasOwnerDeps,
  io: MatchlockHomeAliasFs,
  now: () => Date,
): void {
  const ownerPath = matchlockHomeAliasOwnerPath(aliasDir);
  const record: MatchlockHomeAliasOwnerRecord = {
    schema: MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
    pid: owner.pid,
    startIdentity: owner.startIdentity,
    realHome,
    aliasPath,
    updatedAt: now().toISOString(),
  };
  const tempPath = `${ownerPath}.tmp.${owner.pid}`;
  try {
    io.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: MATCHLOCK_HOME_ALIAS_OWNER_MODE,
    });
    io.chmodSync(tempPath, MATCHLOCK_HOME_ALIAS_OWNER_MODE);
    io.renameSync(tempPath, ownerPath);
  } catch (err) {
    throw ownerUnreadableRefusal(
      ownerPath,
      `cannot be written (${errorCode(err) ?? "unknown error"})`,
    );
  }
}

/**
 * Verify (and repair when safely possible) the alias symlink at `aliasPath`.
 * Called on EVERY use; never trusts a pre-existing entry.
 *
 * `beforeWrite` runs immediately before the alias is created or re-pointed
 * (never before a pure verification) so the ownership gate can refuse without
 * leaving a modified symlink behind.
 */
function ensureAliasSymlink(
  aliasPath: string,
  realHome: string,
  uid: number,
  io: MatchlockHomeAliasFs,
  beforeWrite?: () => void,
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
    beforeWrite?.();
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
    // Wrong but live target: the ownership gate must pass BEFORE we unlink.
    beforeWrite?.();
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
    ensureAliasSymlink(aliasPath, realHome, uid, io, beforeWrite, depth + 1);
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
 * Pure path/key/escape-hatch resolution shared by the side-effecting
 * {@link describeMatchlockHomeAlias} and the read-only
 * {@link inspectMatchlockHomeAlias}. It performs NO filesystem access: it only
 * validates HOME, applies the `TAMANDUA_MATCHLOCK_HOME_ALIAS` escape hatch and
 * derives the alias location, throwing the same typed refusals in both paths.
 */
interface MatchlockHomeAliasLocation {
  realHome: string;
  disabled: boolean;
  aliasPath: string | null;
  aliasDir: string | null;
  aliasKey: string | null;
}

function resolveMatchlockHomeAliasLocation(
  deps: MatchlockHomeAliasDeps,
  uid: number,
  tmpdir: string,
): MatchlockHomeAliasLocation {
  const env = deps.env ?? process.env;
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

  if (override.length === 0) {
    // Keyed default: /tmp/tamandua/<uid>/<k>/h. <k> is unique per daemon
    // instance (the real HOME), so this daemon can only ever create/re-point
    // its OWN directory; the legacy <uid>/h and every other <k> are untouched.
    const aliasKey = matchlockHomeAliasKey(realHome);
    const aliasDir = path.resolve(tmpdir, "tamandua", String(uid), aliasKey);
    return {
      realHome,
      disabled: false,
      aliasKey,
      aliasDir,
      aliasPath: path.join(aliasDir, MATCHLOCK_HOME_ALIAS_LEAF),
    };
  }
  if (override === "0" || /^off$/i.test(override)) {
    return { realHome, disabled: true, aliasKey: null, aliasDir: null, aliasPath: null };
  }
  if (path.isAbsolute(override)) {
    const aliasPath = stripTrailingSlash(override);
    return {
      realHome,
      disabled: false,
      aliasKey: null,
      aliasDir: path.dirname(aliasPath),
      aliasPath,
    };
  }
  throw refusal(
    "override_not_absolute",
    `${MATCHLOCK_HOME_ALIAS_ENV}="${overrideRaw}" is neither "off"/"0" nor an absolute path`,
  );
}

/**
 * Resolve and verify the short-HOME alias (see module docs). Throws
 * {@link MatchlockHomeAliasError} when HOME is unusable or the alias cannot be
 * made trustworthy.
 */
export function describeMatchlockHomeAlias(
  deps: MatchlockHomeAliasDeps = {},
): MatchlockHomeAliasResolution {
  const io = deps.fs ?? nodeFs();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  // LITERAL `/tmp`, never the platform temp dir: the alias must stay short even when the
  // caller runs with a deep TMPDIR (the whole point of the alias). Tests inject
  // `deps.tmpdir`; the escape hatch can point the alias elsewhere.
  const tmpdir = deps.tmpdir ?? "/tmp";

  const location = resolveMatchlockHomeAliasLocation(deps, uid, tmpdir);
  const { realHome, aliasKey, disabled } = location;
  if (disabled) {
    return {
      home: realHome,
      aliasPath: null,
      realHome,
      disabled: true,
      parentDir: null,
      aliasKey: null,
      aliasDir: null,
    };
  }
  const aliasPath = location.aliasPath as string;
  const aliasDir = location.aliasDir as string;

  if (aliasKey !== null) {
    // Both keyed levels must be REAL 0700 directories owned by the uid; a
    // symlink at either level is a typed refusal (never followed/removed).
    // Recursive mkdir never enumerates or removes entries, so a legacy
    // <uid>/h symlink is left byte-identical.
    const uidDir = path.resolve(tmpdir, "tamandua", String(uid));
    ensureOwnedRealDirectory(uidDir, uid, io, "short-HOME alias uid directory");
    ensureOwnedRealDirectory(aliasDir, uid, io, "short-HOME alias key directory");
  } else {
    ensureAliasParent(aliasDir, uid, io);
  }

  // Ownership protocol applies ONLY to the keyed per-daemon alias. An absolute
  // override keeps the historical (unowned) behavior: its parent may be shared.
  const owner = aliasKey !== null ? deps.owner : undefined;
  const beforeWrite = owner
    ? () => assertAliasTakeoverAllowed(aliasPath, aliasDir, owner, io)
    : undefined;
  ensureAliasSymlink(aliasPath, realHome, uid, io, beforeWrite);
  if (owner && aliasDir !== null) {
    writeAliasOwnerRecord(
      aliasPath,
      aliasDir,
      realHome,
      owner,
      io,
      deps.now ?? (() => new Date()),
    );
  }

  return {
    home: aliasPath,
    aliasPath,
    realHome,
    disabled: false,
    parentDir: path.dirname(aliasPath),
    aliasKey,
    aliasDir,
  };
}

/**
 * Read-only inspection of the effective short-HOME alias (`tamandua doctor`).
 *
 * Shares the exact path/key/escape-hatch resolution of
 * {@link describeMatchlockHomeAlias} but performs NO writes: it never creates,
 * re-points, unlinks or chmods anything and never signals a pid. It still
 * verifies the trust of everything it can read (keyed parent directories and
 * the alias symlink), so a planted/foreign/dangling alias surfaces as a typed
 * {@link MatchlockHomeAliasError}; a missing alias is reported as
 * `exists: false` instead of being created.
 *
 * The owner sidecar is deliberately NOT read here — `tamandua doctor` reads it
 * through {@link readMatchlockHomeAliasOwner} so an unreadable sidecar can be
 * reported (naming its path) without failing the alias resolution itself.
 */
export interface MatchlockHomeAliasInspection {
  /** The user's real HOME. */
  realHome: string;
  /** True when the escape hatch disabled the alias. */
  disabled: boolean;
  /** Verified alias path, or `null` when disabled. */
  aliasPath: string | null;
  /** Alias directory, or `null` when disabled. */
  aliasDir: string | null;
  /** Per-daemon key, or `null` for an override/disabled alias. */
  aliasKey: string | null;
  /** True when the alias symlink exists (never created by this function). */
  exists: boolean;
  /** True when an existing alias symlink points at a resolvable real HOME. */
  trusted: boolean;
}

/**
 * Read-only trust check for a keyed directory that must be a REAL 0700
 * directory owned by `uid`. A missing directory is fine (the alias has not been
 * created yet); a symlink, wrong owner or wrong mode is a typed
 * `parent_untrusted` refusal. Unlike {@link ensureOwnedRealDirectory} this
 * NEVER repairs the mode.
 */
function inspectOwnedRealDirectoryIfPresent(
  dir: string,
  uid: number,
  io: MatchlockHomeAliasFs,
  label: string,
): void {
  let st: MatchlockHomeAliasStats;
  try {
    st = io.lstatSync(dir);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw refusal(
      "parent_unwritable",
      `${label} "${dir}" cannot be inspected (${errorCode(err) ?? "unknown error"})`,
      dir,
    );
  }
  if (!st.isDirectory()) {
    throw refusal(
      "parent_untrusted",
      `${label} "${dir}" exists but is not a real directory` +
        (st.isSymbolicLink() ? " (it is a symlink); refusing to follow it" : ""),
      dir,
    );
  }
  if (st.uid !== uid) {
    throw refusal(
      "parent_untrusted",
      `${label} "${dir}" is owned by uid ${st.uid}, not the effective uid ${uid}`,
      dir,
    );
  }
  const mode = st.mode & 0o777;
  if (mode !== MATCHLOCK_HOME_ALIAS_PARENT_MODE) {
    throw refusal(
      "parent_untrusted",
      `${label} "${dir}" has mode 0${mode.toString(8)} instead of 0700; tamandua doctor only reports it and never repairs it`,
      dir,
    );
  }
}

/** @see MatchlockHomeAliasInspection */
export function inspectMatchlockHomeAlias(
  deps: MatchlockHomeAliasDeps = {},
): MatchlockHomeAliasInspection {
  const io = deps.fs ?? nodeFs();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const tmpdir = deps.tmpdir ?? "/tmp";

  const location = resolveMatchlockHomeAliasLocation(deps, uid, tmpdir);
  if (location.disabled) {
    return {
      realHome: location.realHome,
      disabled: true,
      aliasPath: null,
      aliasDir: null,
      aliasKey: null,
      exists: false,
      trusted: false,
    };
  }
  const aliasPath = location.aliasPath as string;
  const aliasDir = location.aliasDir as string;

  if (location.aliasKey !== null) {
    // Read-only equivalent of the keyed parent checks. A missing directory is
    // fine (nothing to trust yet); only an EXISTING untrusted dir refuses.
    inspectOwnedRealDirectoryIfPresent(
      path.resolve(tmpdir, "tamandua", String(uid)),
      uid,
      io,
      "short-HOME alias uid directory",
    );
    inspectOwnedRealDirectoryIfPresent(aliasDir, uid, io, "short-HOME alias key directory");
  }

  let st: MatchlockHomeAliasStats;
  try {
    st = io.lstatSync(aliasPath);
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return {
        realHome: location.realHome,
        disabled: false,
        aliasPath,
        aliasDir,
        aliasKey: location.aliasKey,
        exists: false,
        trusted: false,
      };
    }
    throw refusal(
      "alias_create_failed",
      `short-HOME alias "${aliasPath}" cannot be inspected (${errorCode(err) ?? "unknown error"})`,
      aliasPath,
    );
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
  if (target !== location.realHome) {
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
    throw refusal(
      "alias_wrong_target",
      `short-HOME alias "${aliasPath}" points at "${target}" instead of the real HOME "${location.realHome}"; ` +
        `tamandua doctor only reports it and never re-points the alias`,
      aliasPath,
    );
  }
  try {
    io.statSync(location.realHome);
  } catch {
    throw refusal(
      "alias_dangling",
      `short-HOME alias "${aliasPath}" points at the real HOME "${location.realHome}", which does not exist`,
      aliasPath,
    );
  }
  return {
    realHome: location.realHome,
    disabled: false,
    aliasPath,
    aliasDir,
    aliasKey: location.aliasKey,
    exists: true,
    trusted: true,
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

/**
 * Usable macOS/BSD `sun_path` length in bytes. Darwin caps `sun_path` at 104
 * bytes including the trailing NUL (103 usable), so the alias keyed layout must
 * fit the STRICTER 103-byte limit for the Matchlock VM gates to work on a Mac.
 */
export const MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT = 103;

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
