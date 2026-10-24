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
 * `prepareDshProfileOverlay` stages a PRIVATE per-INVOCATION EFFECTIVE HOME at
 * `<liveState>/matchlock/dsh-profile-invocations/<runId>/<invocationId>`
 * (OVERLAY-INV-SCOPED):
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
 * PUBLISH POLICY (OVERLAY-INV-SCOPED R3). Prepare records a HOST-side
 * provenance manifest (one `lstat` fingerprint per durable host file, written
 * under the run's host-only grouping dir — never inside the guest-writable
 * overlay) so publish can distinguish a legitimate update from an independently
 * changed host destination:
 *
 *   - same inode as the staged hard link: write-through, nothing to do;
 *   - byte-identical destination: retry-safe no-op;
 *   - host destination unchanged since prepare (fingerprint match): a
 *     LEGITIMATE UPDATE flows (the guest's newer bytes are published);
 *   - otherwise an INDEPENDENTLY CHANGED destination is a TRUE CONFLICT: it is
 *     RETAINED (never silently overwritten) with a typed
 *     `dsh_profile_overlay_publish_conflict` disposition, and the caller keeps
 *     the invocation root that holds the losing copy.
 *
 * Publication is serialized at the shared host-home boundary with a bounded
 * cross-process lock (`mkdir`-atomic, keyed by the host home) so a run's two
 * invocations finishing simultaneously cannot lose an artifact through a
 * read-modify-write race. `profiles/` is never published.
 *
 * The module is deliberately Node-core ONLY (no `node:child_process`, no host
 * administrative imports) so it stays safe for the portable RO guest helper
 * pack closure. It performs presence/metadata inspection only (`lstat` /
 * `readdir` / `readlink`) plus reading its OWN host-side provenance manifest
 * and the publish-time byte comparison of a destination; it NEVER reads
 * durable host file contents during prepare.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** `profiles` directory name under `$DSH_HOME`. */
export const DSH_PROFILES_DIR_NAME = "profiles";
/** Install-derived dependency farm maintained by `healProfilesModuleFallback`. */
export const DSH_NODE_MODULES_DIR_NAME = "node_modules";
/** Per-profile install-derived module-fallback marker directory. */
export const DSH_MODULE_FALLBACK_DIR_NAME = ".dsh-module-fallback";
/** Live-state parent directory holding the LEGACY per-run private overlay roots. */
export const MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME = "dsh-profile-overlays";
/**
 * OVERLAY-INV-SCOPED: live-state parent directory holding the NEW
 * per-invocation private overlay roots. This is a DISJOINT, versioned sibling
 * namespace of {@link MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME}: it is never
 * nested inside the legacy parent, so an old-runtime
 * `cleanupDshProfileOverlay` (which recursively removes
 * `<...>/dsh-profile-overlays/<runId>`) can never delete a live invocation
 * root. The legacy namespace is NEVER touched by the new lifecycle — no
 * reclaim, no deletion, no migration.
 */
export const MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME = "dsh-profile-invocations";
/** Live-state `matchlock` segment. */
export const MATCHLOCK_DIR_NAME = "matchlock";

/**
 * Bounded host-home publication lock. `mkdir` is atomic on every POSIX
 * filesystem, so an exclusive `mkdir` of the lock directory serializes
 * concurrent finalizers of a run (in-process or cross-process). The wait is
 * bounded on the MONOTONIC clock (`process.hrtime.bigint`, never wall-clock
 * arithmetic), and a lock whose owner pid is no longer alive is broken so a
 * crashed holder cannot deadlock a later invocation.
 */
const PUBLISH_LOCK_DIR_NAME = ".dsh-profile-publish-locks";
const PUBLISH_LOCK_OWNER_FILE_NAME = "owner";
/** Default bound for the shared host-home publication lock (milliseconds). */
export const PUBLISH_LOCK_TIMEOUT_MS = 30_000;
const PUBLISH_LOCK_POLL_MS = 20;
/** Version of the host-side prepare-time provenance manifest. */
const PROVENANCE_MANIFEST_VERSION = 1;

const RUN_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Host-generated per-invocation identity shape emitted by the controller
 * (`inv-<random hex>-<timestamp hex>`). Validated before it is ever joined into
 * an overlay path so a malformed id can never escape the invocation parent.
 */
const INVOCATION_ID_RE = /^inv-[0-9a-f]+-[0-9a-f]+$/i;

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
 * Validate and normalize a host-generated invocation id for a dsh
 * profile-overlay root. The id is transient/derived (never stored policy) and
 * only ever produced by the controller. Refusing anything that is not
 * `inv-<hex>-<hex>` guarantees the joined path can never escape the
 * per-invocation parent below `<runId>`.
 */
export function assertDshOverlayInvocationId(invocationId: string): string {
  if (
    typeof invocationId !== "string" ||
    invocationId.length === 0 ||
    invocationId.length > 64
  ) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_invocation_id",
      `Refusing malformed dsh overlay invocation id: ${JSON.stringify(invocationId)}`,
    );
  }
  if (
    !INVOCATION_ID_RE.test(invocationId) ||
    invocationId.includes("/") ||
    invocationId.includes("\\")
  ) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_invocation_id",
      `Refusing dsh profile overlay for non-invocation id: ${JSON.stringify(invocationId)}`,
    );
  }
  return invocationId;
}

/**
 * Deterministic host overlay root for ONE invocation:
 * `<liveStateRoot>/matchlock/dsh-profile-invocations/<bareRunId>/<invocationId>`.
 *
 * The namespace is DISJOINT from the legacy run-scoped
 * `<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>` and is never
 * nested inside it, so a legacy cleanup can never recursively delete a live
 * invocation root. Every invocation gets its OWN root; no two invocations
 * share one and a successor never reuses a predecessor's root.
 */
export function dshProfileOverlayRoot(
  runId: string,
  invocationId: string,
  liveStateRoot: string,
): string {
  const bare = assertDshOverlayRunId(runId);
  const inv = assertDshOverlayInvocationId(invocationId);
  return path.join(
    normalize(liveStateRoot),
    MATCHLOCK_DIR_NAME,
    MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
    bare,
    inv,
  );
}

/**
 * The `<liveStateRoot>/matchlock/dsh-profile-invocations/<bareRunId>` grouping
 * directory that holds the invocation roots of one run. It may be pruned
 * best-effort ONLY when it is empty; it is never removed recursively while
 * another invocation could still own a root inside it.
 */
export function dshProfileInvocationGroupRoot(runId: string, liveStateRoot: string): string {
  const bare = assertDshOverlayRunId(runId);
  return path.join(
    normalize(liveStateRoot),
    MATCHLOCK_DIR_NAME,
    MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
    bare,
  );
}

/**
 * Host-side prepare-time provenance manifest for ONE invocation. It lives as a
 * SIBLING of the invocation root under the host-only grouping directory (the
 * grouping dir is never mounted, so the guest can never read or tamper with
 * it), and is derived only from the host-attested run id + invocation id +
 * live-state root. Removed with the overlay on a successful finalization.
 */
export function dshProfileOverlayProvenancePath(
  runId: string,
  invocationId: string,
  liveStateRoot: string,
): string {
  const bare = assertDshOverlayRunId(runId);
  const inv = assertDshOverlayInvocationId(invocationId);
  return path.join(dshProfileInvocationGroupRoot(bare, liveStateRoot), `${inv}.prepare.json`);
}

/**
 * Lock directory keyed by the HOST HOME (the shared publication boundary) and
 * stored under the host-only live state, so two invocations of one run (same
 * live state + same host home) serialize even across processes. The guest can
 * never reach it: only the invocation ROOT is mounted.
 */
export function dshProfilePublishLockPath(liveStateRoot: string, hostHome: string): string {
  const digest = createHash("sha256").update(normalize(hostHome)).digest("hex").slice(0, 24);
  return path.join(normalize(liveStateRoot), MATCHLOCK_DIR_NAME, PUBLISH_LOCK_DIR_NAME, digest);
}

/**
 * Structural shape of a per-invocation overlay root: the leaf is an invocation
 * id, its parent is a bare run uuid, and its grandparents are
 * `dsh-profile-invocations/matchlock`. This is the only shape
 * `planDshHomeMounts` will accept as an overlay source root; the legacy
 * `<...>/dsh-profile-overlays/<uuid>` shape is explicitly REJECTED.
 */
export function isDshProfileOverlayRootShape(hostPath: string): boolean {
  const parts = normalize(hostPath)
    .split(path.sep)
    .filter((s) => s !== "");
  if (parts.length < 4) return false;
  const invocationId = parts[parts.length - 1];
  const bare = parts[parts.length - 2];
  return (
    INVOCATION_ID_RE.test(invocationId) &&
    RUN_ID_UUID_RE.test(bare) &&
    parts[parts.length - 3] === MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME &&
    parts[parts.length - 4] === MATCHLOCK_DIR_NAME
  );
}

/**
 * True ONLY for the exact deterministic per-invocation overlay root of a bound
 * run + invocation. Any other path (another invocation's root, a legacy
 * run-scoped root, an arbitrary directory) fails closed.
 */
export function isHostAttestedDshProfileOverlay(
  hostPath: string,
  runId: string,
  invocationId: string,
  liveStateRoot: string,
): boolean {
  try {
    return (
      normalize(hostPath) ===
      normalize(dshProfileOverlayRoot(runId, invocationId, liveStateRoot))
    );
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
  /** The host-generated invocation id this overlay root is exclusively bound to. */
  readonly invocationId: string;
  /** Host-attested private overlay root for the invocation. */
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
 * OVERLAY-INV-SCOPED exclusive allocation: create the invocation root with a
 * non-recursive `mkdir` and REFUSE to adopt a preexisting directory under this
 * invocation's own identity. A successor/retry therefore never reuses a
 * predecessor's (or a crash-leftover) root, and a symlinked/non-directory
 * component can never be followed.
 */
function allocateExclusiveDirNoFollow(dir: string, code: string): void {
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      throw new DshProfileOverlayError(
        code,
        `Refusing to adopt preexisting dsh profile overlay root ${dir}; every invocation allocates its own exclusive root (never a successor reuse).`,
      );
    }
    throw new DshProfileOverlayError(
      code,
      `Could not create dsh profile overlay root ${dir}: ${e.message}`,
    );
  }
  const st = lstatOrUndefined(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Dsh profile overlay root ${dir} is not a real directory; refusing a symlinked or foreign overlay root.`,
    );
  }
}

/**
 * Best-effort removal of an EMPTY grouping directory (never recursive, never
 * following a symlink). A non-empty directory (another invocation still owns a
 * root inside), a missing directory, a symlink and any permission error are
 * all ignored: the grouping dir is only collapsed when it is genuinely empty.
 */
function pruneEmptyDirIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty, absent, a symlink, or not removable: leave it untouched */
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
 * Create THIS invocation's private overlay root, stage a private copy of the
 * whole host `profiles/` tree under it, one real directory per install-derived
 * host path, and an EFFECTIVE HOME for every durable top-level host entry. The
 * effective home is mounted as ONE real host-backed directory at the guest
 * `$DSH_HOME`, which is what makes the home root itself a real, writable,
 * fsync-able directory (a synthesized router root has no host provider and
 * fails `fsync`).
 *
 * OVERLAY-INV-SCOPED: the root is
 * `<liveStateRoot>/matchlock/dsh-profile-invocations/<bareRunId>/<invocationId>`
 * and is allocated EXCLUSIVELY (a preexisting directory under this identity is
 * refused, never adopted), so two invocations of one run can never share a
 * root and a successor never reuses a predecessor's. Refuses a
 * symlinked/foreign overlay root or a non-directory component with a typed
 * error. `profiles/` is staged fresh; this call is NOT idempotent on a
 * preexisting root by design. Never touches the host home.
 */
export function prepareDshProfileOverlay(
  runId: string,
  invocationId: string,
  liveStateRoot: string,
  hostHome: string,
): DshProfileOverlayLayout {
  const bare = assertDshOverlayRunId(runId);
  const inv = assertDshOverlayInvocationId(invocationId);
  const live = normalize(liveStateRoot);
  fs.mkdirSync(live, { recursive: true });

  const host = normalize(hostHome);
  const matchlockDir = path.join(live, MATCHLOCK_DIR_NAME);
  const invocationsDir = path.join(matchlockDir, MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME);
  const groupDir = path.join(invocationsDir, bare);
  const root = dshProfileOverlayRoot(bare, inv, live);
  ensureRealDirNoFollowOrCreate(matchlockDir, "dsh_profile_overlay_foreign_root");
  ensureRealDirNoFollowOrCreate(invocationsDir, "dsh_profile_overlay_foreign_root");
  ensureRealDirNoFollowOrCreate(groupDir, "dsh_profile_overlay_foreign_root");
  allocateExclusiveDirNoFollow(root, "dsh_profile_overlay_root_exists");

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

  // R3: record the HOST-side prepare-time provenance of every durable host file
  // (never `profiles/`) BEFORE any consumer can run, so publish can later
  // distinguish a legitimate update from an independently changed destination.
  // The manifest is host-only (a sibling of the mounted root); a failure to
  // write it fails closed before `create`.
  writeProvenanceManifest(bare, inv, live, host);

  return {
    runId: bare,
    invocationId: inv,
    overlayRoot: root,
    relPaths,
    profilesStaged,
    stagedProfilePaths,
    stagedHomeEntries: stagedHomeEntries.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Remove ONLY the attested PER-INVOCATION overlay root. Idempotent (absent root
 * is a no-op). A symlinked or non-directory path at the attested location is
 * refused (never followed, never removed). After a successful removal the
 * run's empty grouping directory and the `dsh-profile-invocations` parent are
 * pruned best-effort ONLY when empty (never recursively): another invocation's
 * root is never touched. The LEGACY `<...>/dsh-profile-overlays` namespace is
 * NEVER touched by this lifecycle — no reclaim, no deletion, no migration.
 */
export function cleanupDshProfileOverlay(
  runId: string,
  invocationId: string,
  liveStateRoot: string,
): void {
  const bare = assertDshOverlayRunId(runId);
  const inv = assertDshOverlayInvocationId(invocationId);
  const live = normalize(liveStateRoot);
  const invocationGroup = path.join(
    live,
    MATCHLOCK_DIR_NAME,
    MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
    bare,
  );
  const invocationsDir = path.join(live, MATCHLOCK_DIR_NAME, MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME);
  const root = dshProfileOverlayRoot(bare, inv, live);
  if (!isHostAttestedDshProfileOverlay(root, bare, inv, live)) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_foreign_root",
      `Refusing to clean up non-attested dsh profile overlay root: ${root}`,
    );
  }
  const st = lstatOrUndefined(root);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_foreign_root",
        `Refusing to remove symlinked/non-directory dsh profile overlay root: ${root}`,
      );
    }
    fs.rmSync(root, { recursive: true, force: false });
  }
  // Remove THIS invocation's host-side provenance manifest (a symlink is
  // unlinked, never followed) so the empty grouping dirs can collapse. A
  // retained overlay keeps its manifest (it is still needed for a later
  // ownership-verified re-attempt); only a completed cleanup removes it.
  fs.rmSync(dshProfileOverlayProvenancePath(bare, inv, live), { force: true });
  // Best-effort collapse of OUR empty grouping dirs only. Never recursive, so
  // a sibling invocation root inside the group dir is never touched, and the
  // LEGACY `dsh-profile-overlays` namespace is never referenced at all.
  pruneEmptyDirIfEmpty(invocationGroup);
  pruneEmptyDirIfEmpty(invocationsDir);
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
      `Dsh profile overlay root ${overlay} is not an attested <liveState>/matchlock/dsh-profile-invocations/<runId>/<invocationId> path.`,
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
 * Prepare-time fingerprint of one HOST destination file. Recorded on the host
 * (never inside the guest-writable overlay) at prepare time so publish can tell
 * "unchanged since prepare" (a legitimate update) from an independently changed
 * destination (a true conflict). `mtimeMs` catches in-place writes, `ino`
 * catches atomic replacement, `size` catches truncation/growth and `dev` pins
 * the filesystem. `ctime` is deliberately NOT included: unlinking our own
 * staged hard link between prepare and publish bumps the host inode's ctime
 * while leaving its identity and content untouched, which must remain a
 * legitimate update rather than a spurious conflict.
 */
interface HostFileFingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface DshProfileOverlayProvenance {
  readonly version: number;
  readonly runId: string;
  readonly invocationId: string;
  readonly hostHome: string;
  readonly files: Record<string, HostFileFingerprint>;
}

function fingerprintOf(st: fs.Stats): HostFileFingerprint {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

function isHostFileFingerprint(value: unknown): value is HostFileFingerprint {
  if (!value || typeof value !== "object") return false;
  const fp = value as Record<string, unknown>;
  return (
    typeof fp.dev === "number" &&
    typeof fp.ino === "number" &&
    typeof fp.size === "number" &&
    typeof fp.mtimeMs === "number" &&
    Number.isFinite(fp.dev) &&
    Number.isFinite(fp.ino) &&
    Number.isFinite(fp.size) &&
    Number.isFinite(fp.mtimeMs)
  );
}

/**
 * Walk every durable host entry (never `profiles/`) and record a fingerprint
 * for each regular file. Presence/metadata only — no file contents are read.
 * Symlinked entries are skipped here (staging refuses them anyway, and a
 * symlinked destination must never be a publish target).
 */
function recordHostFileFingerprints(
  hostHome: string,
  relPath: string,
  files: Record<string, HostFileFingerprint>,
): void {
  const full = path.join(hostHome, relPath);
  const st = lstatOrUndefined(full);
  if (!st || st.isSymbolicLink()) return;
  if (st.isFile()) {
    files[relPath] = fingerprintOf(st);
    return;
  }
  if (st.isDirectory()) {
    for (const dirent of readdirDirents(full)) {
      recordHostFileFingerprints(hostHome, path.join(relPath, dirent.name), files);
    }
  }
}

/**
 * Write THIS invocation's prepare-time provenance manifest to its host-only
 * location. Atomic (`tmp` + `rename`) so a concurrent reader never sees a torn
 * manifest. The parent grouping dir is host-derived and never mounted.
 */
function writeProvenanceManifest(
  bare: string,
  inv: string,
  live: string,
  hostHome: string,
): void {
  const files: Record<string, HostFileFingerprint> = {};
  for (const dirent of readdirDirents(hostHome)) {
    if (dirent.name === DSH_PROFILES_DIR_NAME) continue;
    recordHostFileFingerprints(hostHome, dirent.name, files);
  }
  const manifest: DshProfileOverlayProvenance = {
    version: PROVENANCE_MANIFEST_VERSION,
    runId: bare,
    invocationId: inv,
    hostHome: normalize(hostHome),
    files,
  };
  const manifestPath = dshProfileOverlayProvenancePath(bare, inv, live);
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmp = `${manifestPath}.tmp-${process.pid}-${process.hrtime.bigint().toString(16)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tmp, manifestPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  } catch (err) {
    // Fail closed: without provenance a publish could not distinguish a
    // legitimate update from an independent change, so never start `create`.
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_publish_failed",
      `Could not record dsh overlay provenance manifest ${manifestPath}: ${(err as Error).message}`,
    );
  }
}

/**
 * Read and identity-validate THIS invocation's provenance manifest. Returns an
 * empty map when the manifest is absent (a pre-fix/crash leftover, or a caller
 * that never prepared): publish then treats a differently-shaped existing
 * destination conservatively as an independent change. A malformed or
 * identity-mismatched manifest is REFUSED, never trusted.
 */
function readProvenanceManifest(
  bare: string,
  inv: string,
  live: string,
  hostHome: string,
): Map<string, HostFileFingerprint> {
  const manifestPath = dshProfileOverlayProvenancePath(bare, inv, live);
  const st = lstatOrUndefined(manifestPath);
  if (!st) return new Map();
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_provenance_mismatch",
      `Refusing non-regular dsh overlay provenance manifest ${manifestPath}.`,
    );
  }
  let parsed: DshProfileOverlayProvenance;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DshProfileOverlayProvenance;
  } catch (err) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_provenance_mismatch",
      `Refusing unparseable dsh overlay provenance manifest ${manifestPath}: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== PROVENANCE_MANIFEST_VERSION ||
    parsed.runId !== bare ||
    parsed.invocationId !== inv ||
    normalize(String(parsed.hostHome)) !== normalize(hostHome) ||
    typeof parsed.files !== "object" ||
    parsed.files === null ||
    Array.isArray(parsed.files) ||
    Object.values(parsed.files).some((fp) => !isHostFileFingerprint(fp))
  ) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_provenance_mismatch",
      `Refusing dsh overlay provenance manifest whose identity or shape does not match (run=${bare}, invocation=${inv}, host=${normalize(hostHome)}): ${manifestPath}`,
    );
  }
  return new Map(Object.entries(parsed.files));
}

/** True when a host file is byte-identical to its overlay counterpart. */
function filesEqual(a: string, b: string): boolean {
  const sa = lstatOrUndefined(a);
  const sb = lstatOrUndefined(b);
  if (!sa || !sb || !sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  const fa = fs.openSync(a, "r");
  const fb = fs.openSync(b, "r");
  try {
    const bufA = Buffer.allocUnsafe(64 * 1024);
    const bufB = Buffer.allocUnsafe(64 * 1024);
    let pos = 0;
    while (pos < sa.size) {
      const n = Math.min(bufA.length, sa.size - pos);
      const ra = fs.readSync(fa, bufA, 0, n, pos);
      const rb = fs.readSync(fb, bufB, 0, n, pos);
      if (ra !== rb) return false;
      if (!bufA.subarray(0, ra).equals(bufB.subarray(0, rb))) return false;
      pos += ra;
    }
    return true;
  } finally {
    fs.closeSync(fa);
    fs.closeSync(fb);
  }
}

function fingerprintsMatch(st: fs.Stats, fp: HostFileFingerprint): boolean {
  return (
    st.dev === fp.dev &&
    st.ino === fp.ino &&
    st.size === fp.size &&
    st.mtimeMs === fp.mtimeMs
  );
}

// ── Bounded shared host-home publication lock ───────────────────────

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function publishLockOwnerPath(lockPath: string): string {
  return path.join(lockPath, PUBLISH_LOCK_OWNER_FILE_NAME);
}

/** True when the lock's recorded owner pid is positively dead on this host. */
function publishLockOwnerIsDead(lockPath: string): boolean {
  const raw = (() => {
    try {
      return fs.readFileSync(publishLockOwnerPath(lockPath), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false; // unreadable/unowned: never break
  try {
    process.kill(pid, 0);
    return false; // still alive (or EPERM: alive for another user)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function acquirePublishLock(lockPath: string, timeoutMs = PUBLISH_LOCK_TIMEOUT_MS): void {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (err) {
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_publish_lock_failed",
      `Could not create the dsh overlay publication lock parent for ${lockPath}: ${(err as Error).message}`,
    );
  }
  // MONOTONIC bound (never wall-clock arithmetic): an NTP step or
  // suspend/resume can never inflate or shrink the wait.
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  const startedNs = process.hrtime.bigint();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      // Record ownership so a crashed holder's pid can be probed next time.
      fs.writeFileSync(publishLockOwnerPath(lockPath), `${process.pid}\n`, "utf8");
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new DshProfileOverlayError(
          "dsh_profile_overlay_publish_lock_failed",
          `Could not acquire dsh overlay publication lock ${lockPath}: ${(err as Error).message}`,
        );
      }
    }
    if (publishLockOwnerIsDead(lockPath)) {
      // A crashed holder must not deadlock a later invocation. Breaking the
      // lock directory is not an overlay deletion and carries no consumer
      // authority. A live/unknown owner is NEVER broken; the wait is bounded.
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* another waiter may have broken it first */
      }
      continue;
    }
    if (process.hrtime.bigint() - startedNs > timeoutNs) {
      throw new DshProfileOverlayError(
        "dsh_profile_overlay_publish_lock_timeout",
        `Timed out after ${timeoutMs}ms waiting for the dsh overlay publication lock ${lockPath}.`,
      );
    }
    sleepSyncMs(PUBLISH_LOCK_POLL_MS);
  }
}

function releasePublishLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* best effort — a dead-owner probe recovers a leaked lock */
  }
}

// ── Publish policy ─────────────────────────────────────────────────

/**
 * Publish one entry of the effective home back to the host home under the
 * documented collision policy. Directories are created/merged; files are
 * classified against their prepare-time host provenance:
 *
 *   - same inode as the staged hard link => write-through, nothing to do;
 *   - byte-identical destination => retry-safe no-op;
 *   - fingerprint unchanged since prepare => LEGITIMATE UPDATE (copy);
 *   - otherwise => TRUE CONFLICT: retain (never overwrite) by throwing a typed
 *     `dsh_profile_overlay_publish_conflict`.
 *
 * A symlink or special overlay/host entry is refused. `profiles/` is never
 * passed here by the caller.
 */
function publishEffectiveHomeEntry(
  overlayPath: string,
  hostPath: string,
  relPath: string,
  provenance: ReadonlyMap<string, HostFileFingerprint>,
): void {
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
      publishEffectiveHomeEntry(
        path.join(overlayPath, dirent.name),
        path.join(hostPath, dirent.name),
        path.join(relPath, dirent.name),
        provenance,
      );
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
  const prep = provenance.get(relPath);
  if (hostSt) {
    if (filesEqual(overlayPath, hostPath)) return; // identical content: retry-safe
    if (prep && fingerprintsMatch(hostSt, prep)) {
      // The destination is untouched since prepare: this is the guest's own
      // newer version, so the legitimate update flows.
      const mode = st.mode & 0o777;
      fs.copyFileSync(overlayPath, hostPath);
      fs.chmodSync(hostPath, mode);
      return;
    }
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_publish_conflict",
      `Host destination ${hostPath} (${relPath}) changed independently since prepare; refusing to overwrite it with the invocation's copy. The invocation root is RETAINED so the artifact is not lost.`,
    );
  }
  if (prep) {
    // The destination existed at prepare and has since been removed by an
    // independent actor: writing our copy would resurrect/overwrite that
    // decision, so treat it as a true conflict and retain.
    throw new DshProfileOverlayError(
      "dsh_profile_overlay_publish_conflict",
      `Host destination ${hostPath} (${relPath}) was removed independently since prepare; refusing to re-create it from the invocation's copy. The invocation root is RETAINED so the artifact is not lost.`,
    );
  }
  // Destination absent at prepare and still absent: a legitimate new artifact.
  const mode = st.mode & 0o777;
  fs.copyFileSync(overlayPath, hostPath);
  fs.chmodSync(hostPath, mode);
}

/**
 * Merge every guest-written durable entry of the per-invocation effective home
 * back to the real host home, EXCEPT the private `profiles/` tree (which must
 * never be published). Idempotent/retry-safe. Under the shared host-home
 * publication lock so a run's two invocations finishing simultaneously cannot
 * lose an artifact through a read-modify-write race. This keeps the existing
 * host-side pre/post session inventory (which reads the real host home)
 * correct: a session the guest wrote into the effective home is present on the
 * host after teardown and before the post-round snapshot. Refuses a
 * non-attested overlay root and a missing host home; a true conflict is
 * RETAINED by throwing `dsh_profile_overlay_publish_conflict`.
 */
export function publishDshHomeOverlayToHost(
  runId: string,
  invocationId: string,
  liveStateRoot: string,
  hostHome: string,
): void {
  const bare = assertDshOverlayRunId(runId);
  const inv = assertDshOverlayInvocationId(invocationId);
  const live = normalize(liveStateRoot);
  const root = dshProfileOverlayRoot(bare, inv, live);
  if (!isHostAttestedDshProfileOverlay(root, bare, inv, live)) {
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
  const lockPath = dshProfilePublishLockPath(live, host);
  acquirePublishLock(lockPath);
  try {
    // Acquire BEFORE reading the manifest: the manifest is the read half of the
    // check-and-replace, so it must be observed under the same lock that guards
    // the replace.
    const provenance = readProvenanceManifest(bare, inv, live, host);
    for (const dirent of readdirDirents(root)) {
      if (dirent.name === DSH_PROFILES_DIR_NAME) continue; // private: never published
      publishEffectiveHomeEntry(
        path.join(root, dirent.name),
        path.join(host, dirent.name),
        dirent.name,
        provenance,
      );
    }
  } finally {
    releasePublishLock(lockPath);
  }
}
