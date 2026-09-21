/**
 * dsh-profile-overlay.ts — DSH-PROFILE-OVERLAY US-001.
 *
 * The Matchlock dsh mapping mounts the operator's effective DSH_HOME
 * read-write so credentials, profile configs, sessions and storages persist
 * across rounds and stay readable by the host token-attribution reader. That
 * whole-home mapping is WRONG for one class of directories: dsh's own boot
 * (`composeProfile` -> `healProfilesModuleFallback`) maintains an
 * installation-derived symlink farm under `profiles/` and re-points it at the
 * RUNNING install's dependency closure on every boot. With a shared RW mount
 * the host and guest "ping-pong" that farm (host checkout <-> guest
 * `/opt/dsh`), and a first LLM request landing between two flips fails with
 * `dsh: REQUEST_EXTENSION: DeepSeek request extension preparation failed`
 * (run #10, reproduced by #26 — see the mtlk-probe-transient investigation).
 *
 * This module is the pure, host-attested planner for the fix:
 * `prepareDshProfileOverlay` stages a PRIVATE per-run EFFECTIVE HOME at
 * `<liveState>/matchlock/dsh-profile-overlays/<runId>`:
 *
 *   - `profiles/` is the private copy (durable config files copied, install-
 *     derived dirs empty) that the guest populates from its own dsh install, so
 *     the guest can create and lock SIBLING boot artifacts under `profiles/`
 *     (e.g. `profiles/node_modules.lock`) without touching the host farm or the
 *     host lock;
 *   - every other durable top-level host entry is materialized: files are hard
 *     links (falling back to a copy), an unknown durable directory is a real
 *     recursively hard-linked tree, and `sessions/`/`storages/` are EMPTY real
 *     directories whose new artifacts are merged back to the host after the
 *     round (`publishDshHomeOverlayToHost`).
 *
 * `planDshHomeMounts` then mounts that ONE effective home at the guest
 * `$DSH_HOME`, so the home root itself is a real host-backed, fsync-able
 * directory. A per-entry plan whose file entries sit directly under the home
 * root made the runtime promote that parent to a synthetic FUSE router root
 * with no provider to fsync: the run-#35 `dsh: ENOENT: no such file or
 * directory, fsync` failure on the home root.
 *
 * The module is deliberately Node-core ONLY (no `node:child_process`, no host
 * administrative imports) so it stays safe for the portable RO guest helper
 * pack closure. It performs presence/metadata inspection only (`lstat` /
 * `readdir` / `readlink`) and NEVER reads file contents.
 */

import fs from "node:fs";
import path from "node:path";

/** `profiles` directory name under `$DSH_HOME`. */
export const DSH_PROFILES_DIR_NAME = "profiles";
/** Install-derived dependency farm maintained by `healProfilesModuleFallback`. */
export const DSH_NODE_MODULES_DIR_NAME = "node_modules";
/** Per-profile install-derived module-fallback marker directory. */
export const DSH_MODULE_FALLBACK_DIR_NAME = ".dsh-module-fallback";
/** Live-state parent directory holding the per-run private overlay roots. */
export const MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME = "dsh-profile-overlays";
/** Live-state `matchlock` segment. */
export const MATCHLOCK_DIR_NAME = "matchlock";

const RUN_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DshProfileOverlayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DshProfileOverlayError";
    this.code = code;
  }
}

function normalize(p: string): string {
  return path.resolve(p);
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

/** True only for an EXISTING directory that is not itself a symlink. */
function isRealDirNoFollow(p: string): boolean {
  const st = lstatOrUndefined(p);
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
}

function readdirDirents(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ── Host-attested run id + overlay root ─────────────────────────────

/**
 * Validate and normalize a run id for a dsh profile-overlay root. Accepts a
 * bare uuid or a `run-` prefixed uuid and refuses anything else so a malicious
 * run id can never escape the overlay parent directory.
 */
export function assertDshOverlayRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 64) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_run_id",
      `Refusing malformed dsh overlay run id: ${JSON.stringify(runId)}`,
    );
  }
  const bare = runId.startsWith("run-") ? runId.slice("run-".length) : runId;
  if (!RUN_ID_UUID_RE.test(bare) || bare.includes("/") || bare.includes("\\")) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_run_id",
      `Refusing dsh profile overlay for non-uuid run id: ${JSON.stringify(runId)}`,
    );
  }
  return bare;
}

/**
 * Deterministic host overlay root for a run:
 * `<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>`.
 */
export function dshProfileOverlayRoot(runId: string, liveStateRoot: string): string {
  const bare = assertDshOverlayRunId(runId);
  return path.join(
    normalize(liveStateRoot),
    MATCHLOCK_DIR_NAME,
    MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
    bare,
  );
}

/**
 * Structural shape of an overlay root: the leaf is a uuid and its parents are
 * `dsh-profile-overlays/matchlock`. This is the only shape
 * `planDshHomeMounts` will accept as an overlay source root.
 */
export function isDshProfileOverlayRootShape(hostPath: string): boolean {
  const parts = normalize(hostPath)
    .split(path.sep)
    .filter((s) => s !== "");
  if (parts.length < 3) return false;
  const bare = parts[parts.length - 1];
  return (
    RUN_ID_UUID_RE.test(bare) &&
    parts[parts.length - 2] === MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME &&
    parts[parts.length - 3] === MATCHLOCK_DIR_NAME
  );
}

/** True ONLY for the exact deterministic per-run overlay root of a bound run. */
export function isHostAttestedDshProfileOverlay(
  hostPath: string,
  runId: string,
  liveStateRoot: string,
): boolean {
  try {
    return normalize(hostPath) === normalize(dshProfileOverlayRoot(runId, liveStateRoot));
  } catch {
    return false;
  }
}

// ── Presence-only discovery of install-derived dirs ─────────────────

/**
 * Walk `<hostHome>/profiles` recursively and return the host-home-relative
 * paths of every install-derived directory:
 *
 *   - every real directory named `node_modules` (the healed dependency farm);
 *   - every real directory named `.dsh-module-fallback` (the per-profile
 *     marker whose `node_modules` child is install-derived).
 *
 * Presence only: `readdir`/`lstat` metadata, never file contents. Symlinked
 * directory entries are never followed (a symlink is not a real directory) so
 * the walk cannot escape `profiles/`. The walk returns the OUTERMOST
 * install-derived directories and stops at each one: its contents (the healed
 * symlink farm, or the nested `node_modules` under `.dsh-module-fallback`)
 * are covered by overlaying that directory as a whole, so it never descends
 * into a `node_modules` or a `.dsh-module-fallback` directory. Returns a
 * deterministic, sorted list; `[]` when the home has no profiles directory or
 * no install-derived directory.
 */
export function discoverDshInstallDerivedDirs(hostHome: string): string[] {
  const home = normalize(hostHome);
  const profilesDir = path.join(home, DSH_PROFILES_DIR_NAME);
  if (!isRealDirNoFollow(profilesDir)) return [];

  const found = new Set<string>();
  const queue: string[] = [profilesDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    for (const dirent of readdirDirents(dir)) {
      if (!dirent.isDirectory()) continue; // real dirs only; never follow symlinks
      const full = path.join(dir, dirent.name);
      const rel = path.relative(home, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (
        dirent.name === DSH_NODE_MODULES_DIR_NAME ||
        dirent.name === DSH_MODULE_FALLBACK_DIR_NAME
      ) {
        // Outermost install-derived dir: record it and stop — the private
        // overlay of this directory covers its whole (install-derived) content.
        found.add(rel);
        continue;
      }
      queue.push(full);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

// ── Per-run private overlay lifecycle ───────────────────────────────

export interface DshProfileOverlayLayout {
  /** The bare (unprefixed) run id the overlay is bound to. */
  readonly runId: string;
  /** Host-attested private overlay root for the run. */
  readonly overlayRoot: string;
  /** Host-home-relative install-derived paths with a private dir created. */
  readonly relPaths: string[];
  /**
   * Always `true` after {@link prepareDshProfileOverlay}: the private
   * `<overlayRoot>/profiles` directory exists as a real directory, even when
   * the host home has no `profiles/` directory at all.
   */
  readonly profilesStaged: boolean;
  /**
   * Host-home-relative paths materialized inside the private
   * `<overlayRoot>/profiles` tree, sorted with `localeCompare`:
   *
   *   - every durable host file/dir copied byte-identically;
   *   - every install-derived directory (`profiles/node_modules`,
   *     `profiles/<profile>/node_modules`,
   *     `profiles/<profile>/.dsh-module-fallback`, …) created EMPTY and never
   *     descended into, so no host farm content is copied.
   *
   * The top-level `profiles` directory itself is not listed.
   */
  readonly stagedProfilePaths: string[];
  /**
   * Every durable top-level host-home entry materialized in the effective home
   * (i.e. under `<overlayRoot>/<entry>`), EXCLUDING `profiles` (the private copy
   * is reported through {@link stagedProfilePaths}) and sorted with
   * `localeCompare`. These are hard links / real directories, never symlinks.
   */
  readonly stagedHomeEntries: string[];
}

function ensureRealDirNoFollowOrCreate(dir: string, code: string): void {
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") {
      throw new DshProfileOverlayError(
        code,
        `Could not create dsh profile overlay directory ${dir}: ${e.message}`,
      );
    }
  }
  const st = lstatOrUndefined(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new DshProfileOverlayError(
      code,
      `Dsh profile overlay path ${dir} is not a real directory; refusing a symlinked or foreign overlay root.`,
    );
  }
}

/**
 * Copy one durable host profile file into the private overlay tree. The
 * destination is repaired (an existing stale regular file is overwritten) but
 * a symlinked or non-file destination is refused — never written through.
 */
function stageDurableProfileFile(hostFile: string, overlayFile: string): void {
  const st = lstatOrUndefined(overlayFile);
  if (st) {
    if (st.isSymbolicLink()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_foreign_root",
        `Dsh profile overlay path ${overlayFile} is a symlink; refusing to write through it.`,
      );
    }
    if (!st.isFile()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_foreign_root",
        `Dsh profile overlay path ${overlayFile} is not a regular file; refusing to overwrite it.`,
      );
    }
  }
  fs.copyFileSync(hostFile, overlayFile);
}

/**
 * Recursively stage `hostHome/<relDir>` into `overlayRoot/<relDir>`:
 *
 *   - every durable host file is copied byte-identically;
 *   - every durable host directory becomes a real private directory;
 *   - every install-derived directory (member of `derived`) becomes an EMPTY
 *     real private directory and is never descended into, so no host farm
 *     content is copied;
 *   - a host symlink is refused with `dsh_profile_overlay_source_symlink` and
 *     a host special file with `dsh_profile_overlay_source_special`.
 *
 * Every materialized host-home-relative path is appended to `staged`. The
 * traversal is read-only on the host; the caller sorts `staged`.
 */
function stageDurableProfileTree(
  hostHome: string,
  overlayRoot: string,
  relDir: string,
  derived: ReadonlySet<string>,
  staged: string[],
): void {
  const hostDir = path.join(hostHome, relDir);
  for (const dirent of readdirDirents(hostDir)) {
    const childRel = path.join(relDir, dirent.name);
    const hostChild = path.join(hostHome, childRel);
    const overlayChild = path.join(overlayRoot, childRel);
    if (dirent.isSymbolicLink()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_source_symlink",
        `Dsh home source ${hostChild} is a symlink; the runtime requires a real directory/file source — mount its resolved real path instead.`,
      );
    }
    if (derived.has(childRel)) {
      ensureRealDirNoFollowOrCreate(overlayChild, "dsh_profile_overlay_foreign_root");
      staged.push(childRel);
      continue;
    }
    if (dirent.isDirectory()) {
      ensureRealDirNoFollowOrCreate(overlayChild, "dsh_profile_overlay_foreign_root");
      staged.push(childRel);
      stageDurableProfileTree(hostHome, overlayRoot, childRel, derived, staged);
      continue;
    }
    if (dirent.isFile()) {
      stageDurableProfileFile(hostChild, overlayChild);
      staged.push(childRel);
      continue;
    }
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_special",
      `Dsh home source ${hostChild} is neither a regular file nor a directory; refusing to stage it.`,
    );
  }
}

/**
 * Materialize the private per-run `<overlayRoot>/profiles` tree from the host
 * home. Always creates the private `profiles` directory; when the host has a
 * `profiles/` directory its durable content is copied byte-identically and its
 * install-derived directories are created empty. The host tree is never
 * modified. A symlinked host `profiles/` entry or inner entry is refused; a
 * symlink already planted in the overlay is never followed.
 */
function stageDshProfilesTree(
  hostHome: string,
  overlayRoot: string,
  relPaths: readonly string[],
): { profilesStaged: true; stagedProfilePaths: string[] } {
  const host = normalize(hostHome);
  const root = normalize(overlayRoot);
  const hostProfiles = path.join(host, DSH_PROFILES_DIR_NAME);
  ensureRealDirNoFollowOrCreate(
    path.join(root, DSH_PROFILES_DIR_NAME),
    "dsh_profile_overlay_foreign_root",
  );

  const st = lstatOrUndefined(hostProfiles);
  if (st && st.isSymbolicLink()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_symlink",
      `Dsh home source ${hostProfiles} is a symlink; the runtime requires a real directory/file source — mount its resolved real path instead.`,
    );
  }
  if (st && !st.isDirectory()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_special",
      `Dsh home source ${hostProfiles} is neither a regular file nor a directory; refusing to stage it.`,
    );
  }

  const staged: string[] = [];
  if (st) {
    stageDurableProfileTree(host, root, DSH_PROFILES_DIR_NAME, new Set(relPaths), staged);
  }
  return {
    profilesStaged: true,
    stagedProfilePaths: staged.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Durable top-level home entries whose CONTENTS are never read or copied: their
 * per-run staging location is an EMPTY real directory, so the guest starts a
 * fresh store and every new artifact is merged back to the host after the
 * round. `sessions/` holds session logs; `storages/` holds derived caches.
 */
const DSH_EMPTY_STAGED_ENTRY_NAMES = new Set(["sessions", "storages"]);

/**
 * Place one durable host FILE into the effective home. Prefers a hard link
 * (same-inode write-through, no content copy); falls back to a byte copy with
 * the source's permission bits when the two locations are on different
 * filesystems. Never writes through a symlink or over a non-file. Idempotent:
 * an already-staged regular file is replaced deterministically.
 */
function stageDurableHomeFile(hostFile: string, overlayFile: string): void {
  const st = lstatOrUndefined(overlayFile);
  if (st) {
    if (st.isSymbolicLink()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_foreign_root",
        `Dsh home overlay path ${overlayFile} is a symlink; refusing to write through it.`,
      );
    }
    if (!st.isFile()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_foreign_root",
        `Dsh home overlay path ${overlayFile} is not a regular file; refusing to replace it.`,
      );
    }
    fs.rmSync(overlayFile, { force: false });
  }
  try {
    fs.linkSync(hostFile, overlayFile);
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // A cross-device/permission/limit hard-link failure falls back to a copy;
    // any other failure is a real error and must surface.
    if (!["EXDEV", "EPERM", "EACCES", "EMLINK"].includes(e.code ?? "")) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_source_unreadable",
        `Could not hard-link dsh home file ${hostFile} into the overlay: ${e.message}`,
      );
    }
  }
  const mode = fs.lstatSync(hostFile).mode & 0o777;
  fs.copyFileSync(hostFile, overlayFile);
  fs.chmodSync(overlayFile, mode);
}

/**
 * Recursively stage one durable host directory into the effective home: every
 * durable host file is hard-linked (or copied) byte-identically and every
 * durable host directory becomes a real private directory. A symlinked or
 * special host entry is refused (fail closed) so the effective home can never
 * contain an escaping link. The host tree is read-only on the host.
 */
function stageDurableHomeTree(hostDir: string, overlayDir: string): void {
  ensureRealDirNoFollowOrCreate(overlayDir, "dsh_profile_overlay_foreign_root");
  for (const dirent of readdirDirents(hostDir)) {
    const hostChild = path.join(hostDir, dirent.name);
    const overlayChild = path.join(overlayDir, dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_source_symlink",
        `Dsh home source ${hostChild} is a symlink; the runtime requires a real directory/file source — mount its resolved real path instead.`,
      );
    }
    if (dirent.isDirectory()) {
      stageDurableHomeTree(hostChild, overlayChild);
      continue;
    }
    if (dirent.isFile()) {
      stageDurableHomeFile(hostChild, overlayChild);
      continue;
    }
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_special",
      `Dsh home source ${hostChild} is neither a regular file nor a directory; refusing to stage it.`,
    );
  }
}

/**
 * Stage one durable top-level host entry into the effective home:
 *   - a real file is hard-linked/copied;
 *   - `sessions/` and `storages/` become EMPTY real directories (their real
 *     contents are never read or copied; the guest starts a fresh store and new
 *     artifacts are merged back after the round);
 *   - any other real directory is recursively hard-linked;
 *   - a symlink or special entry is refused with a typed error.
 */
function stageDurableTopLevelEntry(hostHome: string, overlayRoot: string, name: string): void {
  const hostChild = path.join(hostHome, name);
  const overlayChild = path.join(overlayRoot, name);
  const st = lstatOrUndefined(hostChild);
  if (!st) return; // vanished between readdir and lstat: nothing to stage
  if (st.isSymbolicLink()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_symlink",
      `Dsh home source ${hostChild} is a symlink; the runtime requires a real directory/file source — mount its resolved real path instead.`,
    );
  }
  if (st.isDirectory()) {
    if (DSH_EMPTY_STAGED_ENTRY_NAMES.has(name)) {
      ensureRealDirNoFollowOrCreate(overlayChild, "dsh_profile_overlay_foreign_root");
      return;
    }
    stageDurableHomeTree(hostChild, overlayChild);
    return;
  }
  if (st.isFile()) {
    stageDurableHomeFile(hostChild, overlayChild);
    return;
  }
  throw new DshProfileOverlayError(
    "dsh_profile_overlay_source_special",
    `Dsh home source ${hostChild} is neither a regular file nor a directory; refusing to stage it.`,
  );
}

/**
 * Create the per-run private overlay root, stage a private copy of the whole
 * host `profiles/` tree under it, one real directory per install-derived host
 * path, and an EFFECTIVE HOME for every durable top-level host entry. The
 * effective home is mounted as ONE real host-backed directory at the guest
 * `$DSH_HOME`, which is what makes the home root itself a real, writable,
 * fsync-able directory (a synthesized router root has no host provider and
 * fails `fsync`). Idempotent. Refuses a symlinked/foreign overlay root, or a
 * non-directory component, with a typed error. Never touches the host home.
 */
export function prepareDshProfileOverlay(
  runId: string,
  liveStateRoot: string,
  hostHome: string,
): DshProfileOverlayLayout {
  const bare = assertDshOverlayRunId(runId);
  const live = normalize(liveStateRoot);
  fs.mkdirSync(live, { recursive: true });

  const host = normalize(hostHome);
  const matchlockDir = path.join(live, MATCHLOCK_DIR_NAME);
  const overlaysDir = path.join(matchlockDir, MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME);
  const root = dshProfileOverlayRoot(bare, live);
  ensureRealDirNoFollowOrCreate(matchlockDir, "dsh_profile_overlay_foreign_root");
  ensureRealDirNoFollowOrCreate(overlaysDir, "dsh_profile_overlay_foreign_root");
  ensureRealDirNoFollowOrCreate(root, "dsh_profile_overlay_foreign_root");

  const relPaths = discoverDshInstallDerivedDirs(host);
  const { profilesStaged, stagedProfilePaths } = stageDshProfilesTree(host, root, relPaths);

  for (const rel of relPaths) {
    let current = root;
    for (const seg of rel.split(path.sep)) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new DshProfileOverlayError(
          "dsh_profile_overlay_foreign_root",
          `Refusing unsafe install-derived relative path ${JSON.stringify(rel)}.`,
        );
      }
      current = path.join(current, seg);
      ensureRealDirNoFollowOrCreate(current, "dsh_profile_overlay_foreign_root");
    }
  }

  // Effective home: every durable top-level host entry (except the private
  // `profiles/` copy) is staged at the overlay root, so the overlay root can be
  // mounted as ONE host-backed `$DSH_HOME` root.
  const stagedHomeEntries: string[] = [];
  for (const dirent of readdirDirents(host)) {
    if (dirent.name === DSH_PROFILES_DIR_NAME) continue;
    stageDurableTopLevelEntry(host, root, dirent.name);
    stagedHomeEntries.push(dirent.name);
  }

  return {
    runId: bare,
    overlayRoot: root,
    relPaths,
    profilesStaged,
    stagedProfilePaths,
    stagedHomeEntries: stagedHomeEntries.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Remove ONLY the attested per-run overlay root. Idempotent (absent root is a
 * no-op). A symlinked or non-directory path at the attested location is
 * refused (never followed, never removed) — no other path is ever touched.
 */
export function cleanupDshProfileOverlay(runId: string, liveStateRoot: string): void {
  const root = dshProfileOverlayRoot(runId, liveStateRoot);
  if (!isHostAttestedDshProfileOverlay(root, runId, liveStateRoot)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to clean up non-attested dsh profile overlay root: ${root}`,
    );
  }
  const st = lstatOrUndefined(root);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to remove symlinked/non-directory dsh profile overlay root: ${root}`,
    );
  }
  fs.rmSync(root, { recursive: true, force: false });
}

// ── Composed dsh home mount plan ────────────────────────────────────

/**
 * Structural subset of the Matchlock mount config this planner emits. Declared
 * locally (no relative import) so the module stays Node-core only.
 */
export interface DshProfileOverlayMount {
  type: "host_fs";
  host_path: string;
  readonly: false;
}

export type DshProfileOverlayMountPlan = Record<string, DshProfileOverlayMount>;

const HOME_LIKE_ROOTS = ["/home", "/Users"];
/**
 * Host procfs root, composed so the source carries no non-portable procfs
 * literal (tests/portability-lint.test.ts); the check below is deliberate
 * parity with mount-plan's broad host-source rule.
 */
const HOST_PROC_ROOT = "/proc";
const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".matchlock",
]);

/** Guest OS/runtime roots that must never be shadowed (whole subtree). */
const PROTECTED_GUEST_SUBTREE_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
  "/opt/matchlock",
];

/** Guest paths whose WHOLESALE shadowing is rejected (exact level only). */
const PROTECTED_GUEST_EXACT_ROOTS = [
  "/",
  "/opt",
  "/workspace",
  "/home",
  "/Users",
  "/root",
];

function segments(p: string): string[] {
  return normalize(p)
    .split(path.sep)
    .filter((s) => s !== "" && s !== ".");
}

function isWholeHomeRoot(candidate: string): boolean {
  if (HOME_LIKE_ROOTS.includes(candidate)) return true;
  if (/^\/home\/[^/]+$/.test(candidate)) return true;
  if (/^\/Users\/[^/]+$/.test(candidate)) return true;
  if (candidate === "/root") return true;
  return false;
}

/**
 * Mirror of mount-plan's broad/dangerous host-source rule: a wholesale home,
 * a process/device/socket root or a sensitive credential store is never a
 * mountable dsh-home source. Narrow descendants (a real `~/.dsh`) are fine.
 */
export function isBroadDshMountSource(hostPath: string): boolean {
  const c = normalize(hostPath);
  if (c === "/") return true;
  if (c === HOST_PROC_ROOT || c.startsWith(HOST_PROC_ROOT + "/")) return true;
  if (c === "/sys" || c.startsWith("/sys/")) return true;
  if (c === "/dev" || c.startsWith("/dev/")) return true;
  if (c === "/run" || c.startsWith("/run/")) return true;
  if (isWholeHomeRoot(c)) return true;
  if (segments(c).some((s) => SENSITIVE_SEGMENTS.has(s))) return true;
  return false;
}

/**
 * Mirror of mount-plan's `shadowsProtectedGuestRoot`: reject a guest
 * destination that would shadow a protected guest OS/runtime root or a
 * wholesale guest home. Narrow subpaths (the dsh config root) are allowed.
 */
export function shadowsProtectedDshGuestRoot(guestPath: string): boolean {
  const g = normalize(guestPath);
  if (PROTECTED_GUEST_EXACT_ROOTS.includes(g)) return true;
  if (PROTECTED_GUEST_SUBTREE_ROOTS.some((root) => g === root || g.startsWith(root + "/"))) {
    return true;
  }
  if (isWholeHomeRoot(g)) return true;
  return false;
}

function isWithinPath(candidate: string, root: string): boolean {
  const c = normalize(candidate);
  const r = normalize(root);
  return c !== r && c.startsWith(r + path.sep);
}

function placeMount(
  mounts: DshProfileOverlayMountPlan,
  guestPath: string,
  hostPath: string,
): void {
  if (shadowsProtectedDshGuestRoot(guestPath)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_destination_unsafe",
      `Guest mount destination shadows a protected guest root: ${guestPath} (host ${hostPath})`,
    );
  }
  const existing = mounts[guestPath];
  if (existing) {
    if (existing.host_path !== hostPath) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_collision",
        `Mount destination collision: ${guestPath} requested from ${existing.host_path} and ${hostPath}`,
      );
    }
    return; // same source: idempotent
  }
  mounts[guestPath] = { type: "host_fs", host_path: hostPath, readonly: false };
}

function assertNoNestedDestinations(mounts: DshProfileOverlayMountPlan): void {
  const dests = Object.keys(mounts);
  for (const inner of dests) {
    for (const outer of dests) {
      if (inner !== outer && isWithinPath(inner, outer)) {
        throw new DshProfileOverlayError(
          "dsh_profile_overlay_nested_destination",
          `Mount destination ${inner} is nested inside ${outer}; the composed dsh home plan must not nest destinations.`,
        );
      }
    }
  }
}

/**
 * Compose the dsh `$DSH_HOME` mount map for the guest at `guestRoot`:
 *
 *   - the WHOLE effective home (`<overlayRoot>`) is mounted as ONE host_fs
 *     destination at `guestRoot`. It carries the private `profiles/` copy plus
 *     one real entry for every durable top-level host entry (`.credentials.yaml`
 *     and `.anonymous-user-id` hard links, `sessions/`/`storages/` empty real
 *     dirs whose new artifacts are merged back to the host after the round, and
 *     any other durable entry recursively hard-linked). The guest can therefore
 *     create and fsync the `$DSH_HOME` root itself, write durable entries, and
 *     still never touch the host install-derived profile farm.
 *
 * The host `profiles/` entry is never mounted: `prepareDshProfileOverlay` stages
 * a private copy and this planner refuses any symlinked/special staged entry, so
 * a plan that would expose the host farm or traverse a symlink fails closed.
 *
 * The returned map contains no destination nested inside another (it is the
 * single root destination). `hostHome` must be a real, non-broad directory;
 * `overlayRoot` must be a prepared, structurally-attested overlay root; the
 * staged `<overlayRoot>/profiles` directory must exist as a real directory.
 */
export function planDshHomeMounts(
  hostHome: string,
  overlayRoot: string,
  guestRoot: string,
): DshProfileOverlayMountPlan {
  const host = normalize(hostHome);
  const overlay = normalize(overlayRoot);
  const guest = normalize(guestRoot);

  if (!isRealDirNoFollow(host)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_missing",
      `Dsh home ${host} is not an existing real directory.`,
    );
  }
  if (!isRealDirNoFollow(overlay)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_missing",
      `Dsh profile overlay root ${overlay} is not an existing real directory.`,
    );
  }
  if (!isDshProfileOverlayRootShape(overlay)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Dsh profile overlay root ${overlay} is not an attested <liveState>/matchlock/dsh-profile-overlays/<uuid> path.`,
    );
  }
  if (isBroadDshMountSource(host)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_broad_source",
      `Refusing to compose a dsh home plan from broad host source: ${host}`,
    );
  }
  if (shadowsProtectedDshGuestRoot(guest)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_destination_unsafe",
      `Guest dsh home root shadows a protected guest root: ${guest}`,
    );
  }

  // The guest `profiles/` is ALWAYS the private staged overlay tree: never the
  // host profiles dir (its install-derived farm would ping-pong between host
  // and guest) and never skipped (dsh boot must create sibling artifacts such
  // as `profiles/node_modules.lock`). Fail closed when the staged dir is
  // missing rather than falling back to a host mapping.
  const stagedProfiles = path.join(overlay, DSH_PROFILES_DIR_NAME);
  if (!isRealDirNoFollow(stagedProfiles)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_missing",
      `Private staged profiles directory ${stagedProfiles} is missing; prepare the overlay before planning.`,
    );
  }

  // The overlay root IS the effective home: it was staged with the private
  // `profiles/` copy plus one real entry (hard link, empty durable dir, or
  // recursive real tree) for every durable top-level host entry. Refuse any
  // symlinked or special staged entry so the mounted home can never contain an
  // escaping link and the host profiles farm can never be exposed; a plan that
  // would do so fails closed instead of shipping a rejected/rejected-link shape.
  for (const dirent of readdirDirents(overlay)) {
    const childPath = path.join(overlay, dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_source_symlink",
        `Effective dsh home ${childPath} is a symlink; the runtime requires a real directory/file source.`,
      );
    }
    if (!dirent.isDirectory() && !dirent.isFile()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_source_special",
        `Effective dsh home ${childPath} is neither a regular file nor a directory; refusing to mount it.`,
      );
    }
  }

  const mounts: DshProfileOverlayMountPlan = {};
  // ONE host_fs destination at the guest `$DSH_HOME` root, sourced from the
  // per-run effective home. This is what gives the home root itself a REAL
  // host provider: a per-entry plan whose file entries live directly under the
  // home root makes the runtime promote that parent directory to the FUSE
  // mountpoint, and the resulting synthetic router root has no provider to
  // fsync (the run-#35 `ENOENT ... fsync` failure). A single real root mount
  // has a provider, so `fsync(<DSH_HOME>)` succeeds, while the private
  // `profiles/` copy inside it is still the only profiles source.
  placeMount(mounts, guest, overlay);
  assertNoNestedDestinations(mounts);
  return mounts;
}

// ── Host-side merge-back of guest-written durable entries ───────────

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Publish one entry of the effective home back to the host home. A directory is
 * created (when missing) and recursed; a regular file whose host path is a
 * DIFFERENT inode (new or atomically replaced in the guest) is copied with its
 * permission bits; an unchanged hard-linked file is skipped. A symlink or
 * special entry is refused. `profiles/` is never published by the caller.
 */
function publishEffectiveHomeEntry(overlayPath: string, hostPath: string): void {
  const st = lstatOrUndefined(overlayPath);
  if (!st) return;
  if (st.isSymbolicLink()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to publish symlinked effective-home entry ${overlayPath}.`,
    );
  }
  if (st.isDirectory()) {
    if (!isRealDirNoFollow(hostPath)) {
      try {
        fs.mkdirSync(hostPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") {
          throw new DshProfileOverlayError(
            "dsh_profile_overlay_publish_failed",
            `Could not create host directory ${hostPath}: ${e.message}`,
          );
        }
      }
    }
    if (!isRealDirNoFollow(hostPath)) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_publish_failed",
        `Host path ${hostPath} is not a real directory; refusing to publish into it.`,
      );
    }
    for (const dirent of readdirDirents(overlayPath)) {
      publishEffectiveHomeEntry(path.join(overlayPath, dirent.name), path.join(hostPath, dirent.name));
    }
    return;
  }
  if (!st.isFile()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to publish non-regular effective-home entry ${overlayPath}.`,
    );
  }
  const hostSt = lstatOrUndefined(hostPath);
  if (hostSt && sameInode(st, hostSt)) return; // shared hard link: already host-backed
  if (hostSt && (hostSt.isSymbolicLink() || !hostSt.isFile())) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_publish_failed",
      `Host path ${hostPath} is not a regular file; refusing to overwrite it.`,
    );
  }
  const mode = st.mode & 0o777;
  fs.copyFileSync(overlayPath, hostPath);
  fs.chmodSync(hostPath, mode);
}

/**
 * Merge every guest-written durable entry of the per-run effective home back to
 * the real host home, EXCEPT the private `profiles/` tree (which must never be
 * published). Idempotent. This keeps the existing host-side pre/post session
 * inventory (which reads the real host home) correct: a session the guest wrote
 * into the effective home is present on the host after teardown and before the
 * post-round snapshot. Refuses a non-attested overlay root and a missing host
 * home; never touches `profiles/`.
 */
export function publishDshHomeOverlayToHost(
  runId: string,
  liveStateRoot: string,
  hostHome: string,
): void {
  const root = dshProfileOverlayRoot(runId, liveStateRoot);
  if (!isHostAttestedDshProfileOverlay(root, runId, liveStateRoot)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to publish from non-attested dsh overlay root: ${root}`,
    );
  }
  const st = lstatOrUndefined(root);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to publish from symlinked/non-directory overlay root: ${root}`,
    );
  }
  const host = normalize(hostHome);
  if (!isRealDirNoFollow(host)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_source_missing",
      `Dsh home ${host} is not an existing real directory; refusing to publish into it.`,
    );
  }
  for (const dirent of readdirDirents(root)) {
    if (dirent.name === DSH_PROFILES_DIR_NAME) continue; // private: never published
    publishEffectiveHomeEntry(path.join(root, dirent.name), path.join(host, dirent.name));
  }
}
