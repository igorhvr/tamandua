/**
 * mount-plan.ts — US-002.
 *
 * Builds the `create` RPC params (the api.Config machine shape + pinned
 * image_identity) from a persisted `ExecutionIsolation` policy. This is the
 * exact-destination mount plan: every work/original/Git-metadata directory
 * is mounted at its identical absolute host/guest path in a persistent
 * write-through `host_fs` mode, the ENTIRE selected configuration directory
 * is mounted RW at the guest override (pi/hermes), and the versioned Tamandua
 * helper pack is mounted RO.
 *
 * dsh is the one harness whose config root is NOT mounted as the raw host home
 * (DSH-PROFILE-OVERLAY / DSH-OVERLAY-FSYNC-FIX): dsh re-points an
 * install-derived symlink farm under `$DSH_HOME/profiles/**` at the RUNNING
 * install's dependency closure on every boot, so a shared RW whole-home mount
 * ping-pongs that farm between host and guest. For `harness:"dsh"` the plan
 * instead mounts the EFFECTIVE HOME from `planDshHomeMounts`: ONE host_fs
 * destination at `guestConfigurationRoot` sourced from a private, host-attested
 * per-run effective home under `<liveState>/matchlock/dsh-profile-overlays/
 * <runId>`. The effective home carries the private `profiles/` copy (durable
 * config staged, install-derived dirs empty) plus one real entry per durable
 * top-level host entry — credentials/`.anonymous-user-id` hard links, empty
 * `sessions/`/`storages/` whose new artifacts merge back after the round, and
 * any other durable entry. Mounting the real root is REQUIRED: a per-entry plan
 * whose file entries sit directly under `$DSH_HOME` makes the runtime promote
 * that parent to a synthetic FUSE router root with no host provider to `fsync`
 * (the run-#35 `ENOENT ... fsync` failure); the single real root can be
 * fsync-ed. The dsh overlay option is REQUIRED (fail closed) — a dsh plan can
 * never fall back to the whole-home host mapping.
 *
 * Exact-path admission rules (mirror the design doc section 5):
 *   - NARROW work/original/Git paths are admitted at their exact absolute
 *     host path — including repos under an operator home (e.g.
 *     `/home/nietzsche/my-sample-repo`) and managed worktrees under the live
 *     Tamandua state dir (e.g. `/root/.tamandua/worktrees/<wt>`), plus Mac
 *     `/Users/<user>/...` repos. A prefix rejection of `/home/...` is WRONG
 *     and would reject Igor's exact-path example; only WHOLESALE homes
 *     (`/`, `/home`, `/home/<user>`, `/Users`, `/Users/<user>`, `/root`) are
 *     broad sources.
 *   - LIVE administrative state is never mounted wholesale; underneath the
 *     live state dir only NARROW managed worktrees (`<live>/worktrees/<wt>`)
 *     are admitted — logs/db/agents/run state and sibling worktree listings
 *     are not.
 *   - No host process filesystem (`/proc`, `/sys`), device tree (`/dev`),
 *     `/run` sockets, sensitive credential stores (`~/.ssh` etc.) or
 *     Matchlock state segments are exposed; canonical real paths are checked
 *     alongside the requested spelling.
 *   - The host pi EXECUTABLE may be absent (the image supplies it) — that is
 *     NOT checked here.
 *   - The host CONFIGURATION DIRECTORY being absent (or a file) IS a hard
 *     failure: the ENTIRE selected directory must be mounted RW, never an
 *     image default substituted.
 *   - The versioned helper pack stays RO even when its host path overlaps a
 *     work/config root; overlapping guest DESTINATIONS with a different host
 *     source are rejected (no silent override).
 *   - No guest destination may shadow the guest OS (`/`, `/etc`, `/usr`, ...),
 *     guest home roots wholesale, `/proc`/`/sys`/`/dev`, `/tmp`, or the
 *     Matchlock runtime assets (`/opt/matchlock`). Narrow guest subpaths under
 *     `/home`, `/root` or `/Users` (e.g. a mounted repo) are supported and do
 *     not count as wholesale shadowing. The runtime itself refuses to attach
 *     over a NON-EMPTY guest destination — the plan respects that refusal and
 *     never tries to shadow or pre-clear guest content.
 *   - The plan mirrors the runtime's exact-destination SET validation
 *     (pkg/api/mount.go ValidateExactDestinationMounts) BEFORE create: a
 *     destination nested inside another is a collision the runtime rejects.
 *     A nested mount whose HOST source lies under an already-mounted ancestor
 *     (e.g. a repo's `.git` metadata root under the repo itself) is REDUNDANT
 *     — the write-through ancestor mount already exposes it — so it is dropped.
 *     Nesting under a DIFFERENT host source fails closed. An EXISTING host_fs
 *     source that is a symlink is likewise rejected (validateNoSourceSymlink);
 *     sources must name a real path (resolve first).
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type {
  ExecutionIsolation,
  ExecutionIsolationWorkMount,
} from "./policy.js";
import type { MatchlockCreateParams, MatchlockMountConfig } from "./types.js";
// Portable procfs path-shape check (keeps the Linux-only literal inside the
// allow-listed process-introspection module — see portability-lint).
import { isProcfsPath } from "../../lib/proc-info.js";
// DSH-PROFILE-OVERLAY US-002: the composed dsh home planner (node-core only, so
// it is also safe for the portable RO guest helper pack closure).
import {
  DshProfileOverlayError,
  type DshProfileOverlayMountPlan,
  dshProfileOverlayRoot,
  planDshHomeMounts,
} from "./dsh-profile-overlay.js";

/** Guest path where the versioned RO Tamandua helper/bridge pack is mounted. */
export const MATCHLOCK_GUEST_RUNTIME_ROOT = "/workspace/runtime";
/** Guest path prefix for run-scoped progress/artifacts (single-file narrow mounts in later stages). */
export const MATCHLOCK_GUEST_RUNS_ROOT = "/workspace/runs";
/** Per-run progress resource directory name (progress-only; contains progress.txt). */
export const MATCHLOCK_PROGRESS_RESOURCE_DIR = "progress-resource";

/**
 * Wholesale home roots (host side). A WHOLE home (or one whole user home) is
 * never a mountable host source; NARROW descendants (a repo inside the home)
 * are fine.
 */
const HOME_LIKE_ROOTS = ["/home", "/Users"];

/** Credential/state stores that must never be mounted, at any depth. */
const SENSITIVE_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".matchlock"]);

/**
 * Guest OS/runtime roots that must never be shadowed by an exact-destination
 * mount (whole subtree). `/home`, `/root` and `/Users` are NOT in this list:
 * narrow repos/worktrees beneath them are supported; only the wholesale guest
 * home roots themselves are rejected (see below).
 */
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
const PROTECTED_GUEST_EXACT_ROOTS = ["/", "/opt", "/workspace", "/home", "/Users", "/root"];

/** Resolve the live Tamandua state root (honours TAMANDUA_STATE_DIR). */
export function resolveLiveStateRoot(): string {
  const env = process.env.TAMANDUA_STATE_DIR?.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), ".tamandua");
}

/** The host path where the live Tamandua daemon state lives (admin state). */
export const TAMANDUA_LIVE_STATE_ROOT: string = resolveLiveStateRoot();

/** Admission context overrides (tests inject a deterministic home/state). */
export interface MountAdmissionContext {
  /** The operator home to protect (default os.homedir()). */
  home?: string;
  /** The live Tamandua state dir to protect (default resolveLiveStateRoot()). */
  liveStateRoot?: string;
}

export interface MountPlanDiagnostics {
  workMounts: number;
  gitMetadataMounts: number;
  configurationMounted: boolean;
  helperPackMounted: boolean;
  protectedGuestRootsRejected: number;
}

export class MatchlockMountPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockMountPlanError";
    this.code = code;
  }
}

function normalize(p: string): string {
  return path.resolve(p);
}

/** Return the bare run id after stripping a run- prefix; throws when unsafe. */
function assertSafeRunIdLike(runId: string): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare)) {
    throw new MatchlockMountPlanError(
      "mount_policy_rejected",
      `Progress resource run id is not a safe uuid: ${JSON.stringify(runId)}`,
    );
  }
  return bare;
}

function segments(p: string): string[] {
  return normalize(p).split(path.sep).filter((s) => s !== "" && s !== ".");
}

/** True when a resolved candidate sits under a managed worktree of the live
 *  state dir: `<liveState>/worktrees/<worktreeName>[/...]`. */
function isManagedWorktreePath(candidate: string, liveState: string): boolean {
  if (!candidate.startsWith(liveState + path.sep)) return false;
  const parts = candidate.slice(liveState.length + 1).split(path.sep).filter((s) => s !== "");
  return parts.length >= 2 && parts[0] === "worktrees";
}

/** True when a resolved candidate is a versioned TAMANDUA-BUILT RO guest
 *  helper pack under the live state dir: `<liveState>/matchlock/guest-packs/
 *  <buildVersion>[/...]`. The guest pack is host-attested (built atomically
 *  by ensureGuestPackForState from this checkout's dist and mounted RO at
 *  /workspace/runtime), so — exactly like managed worktrees — the narrow
 *  versioned subtree is an allowed mount source while the rest of the live
 *  administrative state stays unmountable. */
function isManagedGuestPackPath(candidate: string, liveState: string): boolean {
  if (!candidate.startsWith(liveState + path.sep)) return false;
  const parts = candidate.slice(liveState.length + 1).split(path.sep).filter((s) => s !== "");
  return parts.length >= 3 && parts[0] === "matchlock" && parts[1] === "guest-packs";
}

function isWholeHomeRoot(candidate: string): boolean {
  if (HOME_LIKE_ROOTS.includes(candidate)) return true; // /home, /Users wholesale
  if (/^\/home\/[^/]+$/.test(candidate)) return true; // /home/<user> wholesale
  if (/^\/Users\/[^/]+$/.test(candidate)) return true; // /Users/<user> wholesale
  if (candidate === "/root") return true; // Linux operator home wholesale
  return false;
}

function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  }
}

/**
 * True when mounting `hostPath` would expose a broad/dangerous host source.
 * Checks BOTH the requested spelling and its canonical real path (when the
 * path exists and differs), so a symlinked alias of a broad source is still
 * rejected. `opts` lets tests pin the operator home / live state deterministically.
 */
export function isBroadHostSource(hostPath: string, opts?: MountAdmissionContext): boolean {
  const resolved = normalize(hostPath);
  const home = opts?.home !== undefined ? normalize(opts.home) : path.resolve(os.homedir());
  const liveState = opts?.liveStateRoot !== undefined ? normalize(opts.liveStateRoot) : normalize(resolveLiveStateRoot());
  // Protect BOTH the resolved state root (TAMANDUA_STATE_DIR-aware) and the
  // legacy default at <home>/.tamandua (an old run's state must not become
  // mountable merely because the current state root moved).
  const liveStateRoots = [liveState];
  if (home !== "/") {
    const legacy = path.join(home, ".tamandua");
    if (!liveStateRoots.includes(legacy)) liveStateRoots.push(legacy);
  }

  const candidates = [resolved];
  const real = tryRealpath(resolved);
  if (real && real !== resolved) candidates.push(real);

  for (const c of candidates) {
    if (c === "/") return true;
    // Host process filesystem / device tree / socket root — never mountable.
    if (isProcfsPath(c)) return true;
    if (c === "/sys" || c.startsWith("/sys/")) return true;
    if (c === "/dev" || c.startsWith("/dev/")) return true;
    if (c === "/run" || c.startsWith("/run/")) return true;
    // Wholesale homes (whole tree or one whole user home).
    if (isWholeHomeRoot(c)) return true;
    // The operator's own home and its pi agent store. The WHOLE home and the
    // WHOLE ~/.pi tree are never a source. This is the deliberate ~/.pi
    // boundary, not an accident: the ENTIRE selected pi configuration
    // DIRECTORY must be mounted RW (see the configuration-root checks below)
    // and that directory canonically defaults to ~/.pi/agent, so narrow
    // ~/.pi descendants ARE mountable as that whole directory. They can only
    // reach the plan as (a) the configuration root — which must exist and be
    // a DIRECTORY, mounted whole — or (b) an operator-named work/repo root;
    // credential/state descendants are still blocked by SENSITIVE_SEGMENTS.
    if (home !== "/" && (c === home || c === path.join(home, ".pi"))) return true;
    // Live Tamandua administrative state: wholesale, and every descendant
    // EXCEPT narrow managed worktrees, is refused.
    for (const live of liveStateRoots) {
      if (c === live) return true;
      if (c.startsWith(live + path.sep) && !isManagedWorktreePath(c, live)) return true;
    }
    // Credential/state stores must never be mounted at any depth.
    if (segments(c).some((s) => SENSITIVE_SEGMENTS.has(s))) return true;
  }
  return false;
}

/**
 * True when a guest destination would shadow a protected guest OS/runtime
 * root, a wholesale guest home, or the guest staging root. NARROW guest
 * subpaths under `/home`, `/root` or `/Users` (mounted repos/worktrees) are
 * allowed.
 */
export function shadowsProtectedGuestRoot(guestPath: string): boolean {
  const g = normalize(guestPath);
  if (PROTECTED_GUEST_EXACT_ROOTS.includes(g)) return true;
  if (PROTECTED_GUEST_SUBTREE_ROOTS.some((root) => g === root || g.startsWith(root + "/"))) return true;
  if (isWholeHomeRoot(g)) return true; // /home/<user>, /Users/<user> wholesale
  return false;
}

function workMountToConfig(m: ExecutionIsolationWorkMount): MatchlockMountConfig {
  if (m.guestPath !== m.hostPath) {
    throw new MatchlockMountPlanError(
      "mount_policy_rejected",
      `Work mount requires identical host/guest path; host=${m.hostPath} guest=${m.guestPath}`,
    );
  }
  return { type: "host_fs", host_path: m.hostPath, readonly: false };
}

export interface BuildMatchlockCreateConfigOptions {
  /** Host path to the versioned RO helper pack (required). */
  helperPackHostPath?: string;
  /** Admission context (tests inject a deterministic home/state root). */
  admission?: MountAdmissionContext;
  /**
   * HOST-ATTESTED scoped progress resource (MTLK-PROGRESS).
   *
   * When supplied, the plan mounts exactly the per-run progress-only host
   * resource directory (`<liveState>/runs/<runId>/progress-resource/`) at the
   * special guest destination `/workspace/runs/<runId>` — persistent RW — so
   * the guest's `/workspace/runs/<runId>/progress.txt` is the run's progress
   * document and NO sibling host run-state file is exported.
   *
   * The host directory is DERIVED DETERMINISTICALLY from the bound runId and
   * the live state root; the option carries only the runId. It can never be
   * admitted by guest policy/path and never bypasses broad-state protection
   * for work/config roots: `isHostAttestedProgressResource` fails closed for
   * any other host path. There is no generic arbitrary extra mount option
   * exposed to the CLI or guest.
   */
  progressResource?: { runId: string };
  /**
   * HOST-ATTESTED dsh private profile-overlay (DSH-PROFILE-OVERLAY US-002).
   *
   * REQUIRED for `harness:"dsh"` (refused with a typed mount-plan error when
   * absent). The effective-home plan mounts ONE host_fs directory at
   * `guestConfigurationRoot` sourced from `<liveStateRoot>/matchlock/
   * dsh-profile-overlays/<runId>`: the private staged `profiles/` copy plus one
   * real entry per durable top-level host entry (credentials/identity hard
   * links, empty `sessions/`/`storages/`, other durable entries). The guest
   * `$DSH_HOME` root is therefore a real, fsync-able host-backed directory, and
   * an in-VM dsh boot can create sibling boot artifacts
   * (`profiles/node_modules.lock`) and re-point its private farm without ever
   * touching the host farm or the host lock.
   *
   * The overlay root is derived deterministically from the bound run id and
   * the live state root; the option can never name an arbitrary path. Durable
   * `sessions/`/`storages/` artifacts written during the round are merged back
   * to the real host home after the VM close.
   */
  dshProfileOverlay?: { runId: string; liveStateRoot: string };
}

function assertBroadHostSource(hostPath: string, ctx?: MountAdmissionContext): void {
  if (isBroadHostSource(hostPath, ctx)) {
    throw new MatchlockMountPlanError(
      "mount_policy_rejected",
      `Refusing to mount broad host source: ${hostPath}`,
    );
  }
}

function assertGuestPathSafe(hostPath: string, guestPath: string): void {
  if (shadowsProtectedGuestRoot(guestPath)) {
    throw new MatchlockMountPlanError(
      "mount_policy_rejected",
      `Guest mount destination shadows a protected guest OS root: ${guestPath} (host ${hostPath})`,
    );
  }
}

/** Reject guest-destination collisions/overrides between planned mounts. */
function placeMount(
  mounts: Record<string, MatchlockMountConfig>,
  guestPath: string,
  config: MatchlockMountConfig,
): void {
  const existing = mounts[guestPath];
  if (existing) {
    const sameHost = existing.host_path === config.host_path;
    if (!sameHost) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Mount destination collision: ${guestPath} requested from ${existing.host_path} and ${config.host_path}`,
      );
    }
    if (existing.readonly === true && config.readonly === false) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Mount destination ${guestPath} must stay read-only (helper pack) but a read-write mount also targets it`,
      );
    }
    // Same host source re-added (e.g. work mount == original repo): idempotent.
    return;
  }
  mounts[guestPath] = config;
}

/** True when `candidate` equals `root` or sits strictly inside it (path-wise). */
function isWithinPath(candidate: string, root: string): boolean {
  const c = normalize(candidate);
  const r = normalize(root);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Mirror the runtime's exact-destination SET validation
 * (pkg/api/mount.go ValidateExactDestinationMounts) that a real `create`
 * applies at the boundary. A guest destination nested inside another
 * destination is a collision the runtime REJECTS (ErrCodeInvalidParams →
 * `mount destination %q collides with (is nested inside) %q`), so the plan
 * must never ship one. Exact-path host_fs mounts are write-through: a nested
 * mount whose HOST source lies under an already-mounted ancestor's host
 * source (a repo's `.git` metadata root under the repo itself) is REDUNDANT
 * — the ancestor mount already exposes that content — and is dropped BEFORE
 * create so the planner's own canonical policies are never self-rejected. A
 * nested destination backed by a DIFFERENT host source is a genuine
 * override/collision and fails closed here exactly as the runtime would.
 *
 * Also mirrors validateNoSourceSymlink: an EXISTING host_fs source that is a
 * symlink is ambiguous/redirectable and is rejected (name the real path).
 * Absent sources are not checked — like the runtime, existence is enforced
 * elsewhere (the config directory check; the provider at create time).
 */
function normalizeExactDestinationSet(mounts: Record<string, MatchlockMountConfig>): void {
  // Drop redundant same-source nesting to a fixpoint.
  let dropped = true;
  while (dropped) {
    dropped = false;
    const entries = Object.entries(mounts);
    for (const [guest, cfg] of entries) {
      if (!cfg.host_path) continue;
      for (const [ancGuest, ancCfg] of entries) {
        if (guest === ancGuest) continue;
        if (!isWithinPath(guest, ancGuest)) continue; // not nested inside
        if (ancCfg.host_path && isWithinPath(cfg.host_path, ancCfg.host_path)) {
          // Same-source nesting: the ancestor mount already exposes this path.
          delete mounts[guest];
          dropped = true;
          break;
        }
      }
      if (dropped) break;
    }
  }
  // Any remaining nesting is a different-source collision → fail closed
  // (the runtime's ValidateExactDestinationMounts would reject it too).
  const remaining = Object.keys(mounts);
  for (const guest of remaining) {
    for (const ancGuest of remaining) {
      if (guest !== ancGuest && isWithinPath(guest, ancGuest)) {
        throw new MatchlockMountPlanError(
          "mount_policy_rejected",
          `Mount destination ${guest} collides with (is nested inside) ${ancGuest} from a different host source; the runtime rejects nested destinations.`,
        );
      }
    }
  }
  // Existing host_fs sources must name a REAL directory/file (no symlinks).
  for (const [guest, cfg] of Object.entries(mounts)) {
    if (cfg.type !== "host_fs" || !cfg.host_path) continue;
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cfg.host_path);
    } catch {
      continue; // absent source cannot be a symlink (runtime behavior)
    }
    if (st.isSymbolicLink()) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `host_fs source ${cfg.host_path} (mounted at guest ${guest}) is a symlink; the runtime requires a real directory/file source — mount its resolved real path instead.`,
      );
    }
  }
}

/**
 * Host progress resource directory for a bound run under the live state root.
 * Host-attested: never derived from guest input; the runId must be a safe uuid.
 */
export function hostProgressResourceDir(runId: string, liveStateRoot: string): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare)) {
    throw new MatchlockMountPlanError(
      "mount_policy_rejected",
      `Refusing progress resource for non-uuid run id: ${JSON.stringify(runId)}`,
    );
  }
  return path.join(liveStateRoot, "runs", bare, MATCHLOCK_PROGRESS_RESOURCE_DIR);
}

/**
 * True ONLY for the exact deterministic per-run progress resource directory of
 * a bound run under the live state root. Everything else (wholesale state,
 * sibling runs, arbitrary paths) fails closed.
 */
export function isHostAttestedProgressResource(
  hostPath: string,
  runId: string,
  liveStateRoot: string,
): boolean {
  try {
    const expected = hostProgressResourceDir(runId, liveStateRoot);
    return normalize(hostPath) === normalize(expected);
  } catch {
    return false;
  }
}

/** Live state root used by the planner for a given admission context. */
function liveStateRootFor(ctx?: MountAdmissionContext): string {
  return ctx?.liveStateRoot !== undefined
    ? normalize(ctx.liveStateRoot)
    : normalize(TAMANDUA_LIVE_STATE_ROOT);
}

/**
 * Compose the dsh `$DSH_HOME` mount set (DSH-OVERLAY-FSYNC-FIX US-003): ONE
 * host_fs RW destination at `guestConfigurationRoot`, sourced from the private,
 * host-attested per-run EFFECTIVE HOME (`<liveState>/matchlock/
 * dsh-profile-overlays/<runId>`). The effective home carries the private
 * `profiles/` copy plus one real entry for every durable top-level host entry
 * (credentials/identity hard links, empty `sessions/`/`storages/` whose new
 * artifacts merge back after the round, and any other durable entry), so the
 * guest `$DSH_HOME` root itself is a REAL host-backed directory that can be
 * `fsync`-ed (a per-entry plan whose file entries sit directly under the home
 * root makes the runtime promote that parent to a synthetic FUSE router root
 * with no provider to fsync — the run-#35 failure).
 *
 * `opts.dshProfileOverlay` is REQUIRED for a dsh policy: without it this fails
 * closed with `dsh_profile_overlay_required` rather than mounting farms the
 * guest could heal in place. The overlay root is derived from the supplied run
 * id + live state root, so no caller can name an arbitrary overlay source.
 */
function placeDshComposedConfigurationMounts(
  mounts: Record<string, MatchlockMountConfig>,
  policy: ExecutionIsolation,
  opts: BuildMatchlockCreateConfigOptions | undefined,
  ctx: MountAdmissionContext | undefined,
): void {
  const overlay = opts?.dshProfileOverlay;
  if (!overlay) {
    throw new MatchlockMountPlanError(
      "dsh_profile_overlay_required",
      `harness "dsh" requires the host-attested dshProfileOverlay option (runId + liveStateRoot) so install-derived profile module dirs are mounted from a private per-run overlay; refusing to mount the whole DSH_HOME (${policy.configurationRoot}) read-write.`,
    );
  }
  let overlayRoot: string;
  let plan: DshProfileOverlayMountPlan;
  try {
    overlayRoot = dshProfileOverlayRoot(overlay.runId, overlay.liveStateRoot);
    plan = planDshHomeMounts(policy.configurationRoot, overlayRoot, policy.guestConfigurationRoot);
  } catch (err) {
    if (err instanceof DshProfileOverlayError) {
      // Surface the dsh planner's typed refusal through the mount-plan error
      // surface so admission/runner error handling sees one consistent class.
      throw new MatchlockMountPlanError(err.code, err.message);
    }
    throw err;
  }
  for (const [guest, m] of Object.entries(plan)) {
    assertGuestPathSafe(m.host_path, guest);
    // Mirror isManagedGuestPackPath / hostProgressResourceDir: the attested
    // per-run overlay root is host-owned, so its narrow subtree is a managed
    // mount source even though the live state dir is otherwise unmountable.
    // Every other composed source still goes through broad-source admission.
    if (!isWithinPath(m.host_path, overlayRoot)) {
      assertBroadHostSource(m.host_path, ctx);
    }
    placeMount(mounts, guest, {
      type: "host_fs",
      host_path: m.host_path,
      readonly: false,
    });
  }
}

/**
 * Build the `create` params (image identity pin + exact-destination mount
 * plan). Throws a {@link MatchlockMountPlanError} on any fail-closed rule.
 */
export function buildMatchlockCreateConfig(
  policy: ExecutionIsolation,
  identity: { digest: string; config_digest: string; tag?: string },
  opts?: BuildMatchlockCreateConfigOptions,
): MatchlockCreateParams {
  const ctx = opts?.admission;
  const mounts: Record<string, MatchlockMountConfig> = {};

  // Work mounts (exact host/guest identical, persistent RW).
  for (const m of policy.workMounts) {
    assertBroadHostSource(m.hostPath, ctx);
    assertGuestPathSafe(m.hostPath, m.guestPath);
    placeMount(mounts, m.guestPath, workMountToConfig(m));
  }

  // Original repository + Git metadata roots (persistent RW).
  if (policy.originalRepositoryRoot) {
    assertBroadHostSource(policy.originalRepositoryRoot, ctx);
    assertGuestPathSafe(policy.originalRepositoryRoot, policy.originalRepositoryRoot);
    placeMount(mounts, policy.originalRepositoryRoot, {
      type: "host_fs",
      host_path: policy.originalRepositoryRoot,
      readonly: false,
    });
  }
  for (const gitRoot of policy.gitMetadataRoots) {
    assertBroadHostSource(gitRoot, ctx);
    assertGuestPathSafe(gitRoot, gitRoot);
    placeMount(mounts, gitRoot, { type: "host_fs", host_path: gitRoot, readonly: false });
  }

  // Selected configuration DIRECTORY, RW, at the guest override. A MISSING or
  // NON-DIRECTORY host config source is a hard failure (never an image-default
  // substitution). The HOST PI EXECUTABLE is NOT required (the image supplies
  // it) — nothing here checks for it. pi/hermes mount the whole directory;
  // dsh mounts the composed home (durable entries host-mapped, install-derived
  // dirs from the private per-run overlay) — see placeDshComposedConfigurationMounts.
  let configStat: fs.Stats | undefined;
  try {
    configStat = fs.statSync(policy.configurationRoot);
  } catch {
    configStat = undefined;
  }
  if (!configStat || !configStat.isDirectory()) {
    throw new MatchlockMountPlanError(
      "guest_configuration_incompatible",
      `Selected host configuration source is not an existing DIRECTORY: ${policy.configurationRoot}. ` +
        `Mounting the ENTIRE selected directory RW is required; refusing to substitute an image default.`,
    );
  }
  assertBroadHostSource(policy.configurationRoot, ctx);
  assertGuestPathSafe(policy.configurationRoot, policy.guestConfigurationRoot);
  if (policy.harness === "dsh") {
    // dsh NEVER mounts the whole home: the whole profiles/ tree (including the
    // install-derived farm and the sibling boot lock) is sourced from the
    // private per-run overlay (DSH-PROFILE-OVERLAY US-002).
    placeDshComposedConfigurationMounts(mounts, policy, opts, ctx);
  } else {
    placeMount(mounts, policy.guestConfigurationRoot, {
      type: "host_fs",
      host_path: policy.configurationRoot,
      readonly: false,
    });
  }

  // Versioned RO helper/skill pack (never RW, even when its host path
  // overlaps a work/config root). Absent a built guest pack the controller
  // must supply its host path; otherwise fail closed (a helper-less VM cannot
  // run the scoped bridge, so admission is refused, not guessed).
  if (!opts?.helperPackHostPath) {
    throw new MatchlockMountPlanError(
      "guest_bridge_unavailable",
      "A versioned RO guest helper pack host path is required to mount the bridge; none was supplied.",
    );
  }
  // The RO helper pack is host-attested and may live under the live state dir
  // (`<live>/matchlock/guest-packs/<buildVersion>`, built by
  // ensureGuestPackForState): the narrow versioned subtree is a managed mount
  // source exactly like a managed worktree. Any OTHER live-state location (or
  // any broad host source) is still refused.
  if (!isManagedGuestPackPath(path.resolve(opts.helperPackHostPath), liveStateRootFor(ctx))) {
    assertBroadHostSource(opts.helperPackHostPath, ctx);
  }
  assertGuestPathSafe(opts.helperPackHostPath, MATCHLOCK_GUEST_RUNTIME_ROOT);
  placeMount(mounts, MATCHLOCK_GUEST_RUNTIME_ROOT, {
    type: "host_fs",
    host_path: opts.helperPackHostPath,
    readonly: true,
  });

  // HOST-ATTESTED scoped progress resource (MTLK-PROGRESS). Only the exact
  // deterministic per-run progress-only directory is admitted, at the special
  // guest destination `/workspace/runs/<runId>` (persistent RW host_fs).
  if (opts?.progressResource) {
    const liveState = ctx?.liveStateRoot !== undefined ? normalize(ctx.liveStateRoot) : normalize(TAMANDUA_LIVE_STATE_ROOT);
    const runId = opts.progressResource.runId;
    const hostDir = hostProgressResourceDir(runId, liveState);
    if (!isHostAttestedProgressResource(hostDir, runId, liveState)) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Progress resource host dir ${hostDir} is not the attested per-run progress directory for run ${runId}.`,
      );
    }
    // Reject a live-state source that does not exist as a real dir (the host
    // must create the progress-only dir before create; never a guest path).
    // lstatSync (not statSync): a following stat would resolve a symlinked
    // resource dir to its TARGET, so the isSymbolicLink() guard below would be
    // dead code. Mirrors ProgressResourceAccess.assertRealResourceDir.
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(hostDir);
    } catch {
      st = undefined;
    }
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Progress resource host dir ${hostDir} must exist as a real directory before create.`,
      );
    }
    const guestDir = `${MATCHLOCK_GUEST_RUNS_ROOT}/${assertSafeRunIdLike(runId)}`;
    assertGuestPathSafe(hostDir, guestDir);
    placeMount(mounts, guestDir, {
      type: "host_fs",
      host_path: hostDir,
      readonly: false,
    });
  }

  // Set-level normalization BEFORE create (mirrors the runtime's
  // ValidateExactDestinationMounts + validateNoSourceSymlink): drop redundant
  // same-source nesting (e.g. a repo's .git under the repo mount) and fail
  // closed on different-source nesting or symlinked host_fs sources.
  normalizeExactDestinationSet(mounts);

  const guestEnv = policy.harness === "dsh" ? dshGuestEnv(policy) : { PI_CODING_AGENT_DIR: policy.guestConfigurationRoot };

  return {
    image: policy.requestedImage,
    image_identity: {
      digest: identity.digest,
      config_digest: identity.config_digest,
      ...(identity.tag ? { tag: identity.tag } : {}),
    },
    resources: {
      cpus: policy.resourceLimits.cpus,
      memory_mb: policy.resourceLimits.memoryMB,
      disk_size_mb: policy.resourceLimits.diskSizeMB,
    },
    // Network boundary: public destinations are allowed; private, loopback,
    // link-local, CGNAT and Yggdrasil destinations (including IPv6) stay
    // blocked for everything not explicitly listed. The current matchlock
    // fork intercepts IPv6 too, so the old IPv6 caveat is gone. The per-run
    // allow-private exceptions (MTLK-ALLOW-PRIVATE) are emitted as
    // `network.allow_private` ONLY when the admitted policy carries entries;
    // with none admitted the key is omitted entirely and the block stays on.
    network: {
      block_private_ips: true,
      intercept: true,
      ...(policy.networkAllowPrivate && policy.networkAllowPrivate.length > 0
        ? { allow_private: [...policy.networkAllowPrivate] }
        : {}),
    },
    // Guest harness directory override: pin the image's harness into its real
    // config mount rather than the image default HOME. pi pins
    // PI_CODING_AGENT_DIR; dsh pins DSH_HOME (= the RW mount at
    // /workspace/config/dsh) and, when the image declares a PATH, prepends
    // ONLY the helper-pack bin to that image PATH (never a conservative
    // default substitution while the image declares one).
    env: guestEnv,
    vfs: {
      exact_destinations: true,
      mounts,
    },
  };
}

/** Guest bin directory inside the RO helper pack (env PATH prepend). */
export const MATCHLOCK_GUEST_HELPER_BIN = `${MATCHLOCK_GUEST_RUNTIME_ROOT}/bin`;

/**
 * dsh-mode create env (MTLK-DSH-EXEC US-002). DSH_HOME is unconditional (the
 * guest must resolve its config at the RW mount /workspace/config/dsh). When
 * the policy carries the image's declared OCI-config PATH (captured at
 * admission), PATH is the helper-pack bin prepended to that image PATH — a
 * nonstandard image PATH is preserved. When the image declares no PATH, PATH
 * is left to the image default (the invocation runner supplies the bounded
 * conservative default at launch).
 */
function dshGuestEnv(policy: ExecutionIsolation): Record<string, string> {
  const env: Record<string, string> = {
    DSH_HOME: policy.guestConfigurationRoot,
  };
  const imagePath = policy.imagePath?.trim();
  if (imagePath) {
    env.PATH = `${MATCHLOCK_GUEST_HELPER_BIN}:${imagePath}`;
  }
  return env;
}

/**
 * Constrain a work-mount list to exact host/guest identical paths and reject
 * any that would be a broad host source or shadow a protected guest root.
 * Returns a new validated list. `opts` lets tests pin the home/state context.
 */
export function validateWorkMounts(
  mounts: ExecutionIsolationWorkMount[],
  admission?: MountAdmissionContext,
): ExecutionIsolationWorkMount[] {
  for (const m of mounts) {
    if (m.guestPath !== m.hostPath) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Work mount requires identical host/guest path; host=${m.hostPath} guest=${m.guestPath}`,
      );
    }
    assertBroadHostSource(m.hostPath, admission);
    if (shadowsProtectedGuestRoot(m.guestPath)) {
      throw new MatchlockMountPlanError(
        "mount_policy_rejected",
        `Guest mount destination shadows a protected guest OS root: ${m.guestPath} (host ${m.hostPath})`,
      );
    }
  }
  return mounts;
}
