/**
 * matchlock-dsh-gate-fixtures.ts — DSH-PROFILE-OVERLAY US-004 / US-005.
 *
 * Shared, Node-core-only fixture and observation helpers for the real-VM
 * Matchlock dsh gate (e2e-tests/matchlock-dsh-gate.test.ts) under the
 * COMPOSED DSH_HOME contract:
 *
 *   - a synthetic `$DSH_HOME` must PRE-CREATE every durable entry the composed
 *     plan mounts per-entry (sessions/, storages/, the profile config files,
 *     credentials/, unknown marker dirs) because the plan never mounts the whole
 *     home — only real, existing entries are placed;
 *   - the install-derived profile module farm (`profiles/node_modules`,
 *     `profiles/<profile>/node_modules`, `profiles/<profile>/.dsh-module-fallback`)
 *     is source-side private: the host copy is only discovered (never mounted),
 *     and the guest sees a per-run private overlay instead.
 *
 * The helper is also the deterministic observation seam for the gate's
 * `guest private farm` characterization: `DshOverlayObserver` polls the
 * host-attested per-run overlay root WHILE the round is live (the controller
 * removes it after the confirmed close) and records every symlink, real
 * directory and regular FILE the guest writes into the private farm — including
 * the transient `withFileLock` sibling `profiles/node_modules.lock` — so the
 * gate can assert the farm carries GUEST-install links, that the private
 * profiles/ tree carries the copied durable config, and that the HOST tree
 * stayed byte-identical.
 *
 * Node-core only (fs/path/os/zlib); no `node:child_process`, no daemon, no VM,
 * no network — safe for the fast parallel lane and for the on-demand real gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** The synthetic headless profile name used by the dsh gate fixtures. */
export const DSH_GATE_PROFILE_NAME = "headless";

/**
 * Deliberately MISMATCHED install links seeded into the synthetic host farm:
 * one points at the guest install layout, one at a nonexistent installation.
 * The composed plan must NEVER mount these host sources — the private overlay
 * replaces them.
 */
export const DSH_GATE_MISMATCHED_FARM_LINKS: Readonly<Record<string, string>> = {
  commander: "/opt/dsh/apps/cli/node_modules/commander",
  undici: "/nonexistent-install/node_modules/undici",
};

/**
 * DSH-PROFILE-OVERLAY US-005 — the contained native-boot / in-VM-round probe.
 *
 * The on-demand regression gate alternates a HOST-side ("native") zero-provider
 * dsh boot with an in-VM dsh round over ONE synthetic `$DSH_HOME`:
 *
 *  - the native boot is the deterministic zero-provider fixture
 *    (`e2e-tests/dsh-fixture/fake-dsh.mjs`) run natively, exactly as the real
 *    `healProfilesModuleFallback` would, and it rewrites the synthetic HOST farm
 *    so the gate can prove the in-VM round never flips it back;
 *  - the in-VM round resolves the request-extension provider's module through
 *    the guest's PRIVATE per-run overlay farm and writes only guest-install
 *    links there.
 *
 * Both markers are plain substrings of the guest/native prompt (the fixture's
 * launch argv is `dsh --profile headless <prompt>`), so no guest env injection
 * is needed. `SYNTHETIC_DSH_INSTALL_ROOT` is the host-side install root the
 * native heal links point at; the guest install root is the fixed constant.
 */
export const DSH_GATE_NATIVE_HEAL_MARKER = "SYNTHETIC-DSH-NATIVE-HEAL";
export const DSH_GATE_FIRST_REQUEST_MARKER = "SYNTHETIC-DSH-FIRST-REQUEST";
/**
 * DSH-PROFILE-OVERLAY US-004 — prompt marker asking the synthetic first-request
 * probe to HOLD the real boot-sibling writer lock (`profiles/node_modules.lock`)
 * for the given number of milliseconds. The real dsh holds that lock across the
 * whole `healProfilesModuleFallback` module heal (seconds of pnpm work), so the
 * on-host `DshOverlayObserver` can capture it. Without the marker the fixture
 * releases the lock immediately (fast US-003 controls); with it the gate gets a
 * deterministic observation window. Format: `<marker>:<ms>`.
 */
export const DSH_GATE_BOOT_LOCK_HOLD_MARKER = "SYNTHETIC-DSH-BOOT-LOCK-HOLD";
export const DSH_GATE_GUEST_INSTALL_ROOT = "/opt/synthetic-guest-install";
/** Fast-test-only override for the guest install root (never set in the gate). */
export const DSH_GATE_GUEST_INSTALL_ROOT_ENV = "SYNTHETIC_DSH_GUEST_INSTALL_ROOT";
export const DSH_GATE_NATIVE_INSTALL_ROOT_ENV = "SYNTHETIC_DSH_INSTALL_ROOT";
export const DSH_GATE_FIRST_REQUEST_PLUGIN = "synthetic-first-request-plugin";
/** The shared-farm packages the native heal fixture links (scope dirs included). */
export const DSH_GATE_NATIVE_FARM_PACKAGES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-headless",
  "commander",
  "undici",
];

export interface ComposedDshHomeLayout {
  /** The synthetic effective DSH_HOME (real directory). */
  readonly homeDir: string;
  /** The headless profile name. */
  readonly profile: string;
  /** Home-relative durable directories the composed plan mounts per entry. */
  readonly durableEntries: string[];
  /** Home-relative install-derived directories (private per run). */
  readonly installDerivedDirs: string[];
  /** The mismatched links seeded into each host farm directory. */
  readonly hostFarmLinks: Record<string, string>;
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function isRealDir(p: string): boolean {
  const st = lstatOrUndefined(p);
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
}

function ensureRealDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!isRealDir(dir)) {
    throw new Error(`composed dsh-home fixture path is not a real directory: ${dir}`);
  }
}

function writeIfAbsent(file: string, text: string): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, "utf-8");
}

/**
 * Write `file` with OWNER-ONLY (0600) permissions. dsh's credentials-local
 * provider refuses a credentials file "readable beyond its owner", so staged
 * placeholder `.credentials.yaml` files must be 0600 like the operator's.
 * `chmodSync` forces the mode even when the destination pre-existed.
 */
function writeOwnerOnlyFile(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Remove an existing entry (file, dir or dangling symlink) if present. */
function removeIfPresent(p: string): void {
  if (lstatOrUndefined(p) === undefined) return;
  fs.rmSync(p, { recursive: true, force: true });
}

/** (Re)create the mismatched install links in a host farm directory. */
function seedMismatchedFarm(linkDir: string): void {
  ensureRealDir(linkDir);
  for (const [name, target] of Object.entries(DSH_GATE_MISMATCHED_FARM_LINKS)) {
    const link = path.join(linkDir, name);
    removeIfPresent(link);
    fs.symlinkSync(target, link);
  }
}

/**
 * Pre-create the synthetic composed `$DSH_HOME` every gate case needs:
 *
 *   - durable per-entry mounts: `sessions/`, `storages/`, `.gate-writes/`,
 *     `credentials/`, `.gate-unknown-entries/` and `.credentials.yaml`;
 *   - the headless profile dir with `package.json`, `cordis.yml`,
 *     `cordis.patch.yml` and `pnpm-workspace.yaml`;
 *   - the install-derived dirs (`profiles/node_modules`,
 *     `profiles/<profile>/node_modules`, `profiles/<profile>/.dsh-module-fallback`)
 *     so the composed planner discovers and privately overlays them.
 *
 * Idempotent: safe to call twice for the same home.
 */
export function prepareComposedDshHome(
  homeDir: string,
  opts: { profile?: string } = {},
): ComposedDshHomeLayout {
  const profile = opts.profile ?? DSH_GATE_PROFILE_NAME;
  ensureRealDir(homeDir);

  const durableEntries = [
    "sessions",
    "storages",
    ".gate-writes",
    "credentials",
    ".gate-unknown-entries",
  ];
  for (const entry of durableEntries) ensureRealDir(path.join(homeDir, entry));
  writeIfAbsent(
    path.join(homeDir, ".credentials.yaml"),
    "# synthetic gate credentials placeholder — NEVER real credentials\n",
  );

  const profileDir = path.join(homeDir, "profiles", profile);
  ensureRealDir(profileDir);
  writeIfAbsent(
    path.join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-headless-synth",
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
            patchReload: "startup",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeIfAbsent(path.join(profileDir, "cordis.yml"), "[]\n");
  writeIfAbsent(path.join(profileDir, "cordis.patch.yml"), "[]\n");
  writeIfAbsent(path.join(profileDir, "pnpm-workspace.yaml"), "packages: []\n");

  const installDerivedDirs = [
    path.join("profiles", "node_modules"),
    path.join("profiles", profile, "node_modules"),
    path.join("profiles", profile, ".dsh-module-fallback"),
  ];
  seedMismatchedFarm(path.join(homeDir, "profiles", "node_modules"));
  seedMismatchedFarm(path.join(profileDir, "node_modules"));
  ensureRealDir(path.join(profileDir, ".dsh-module-fallback"));

  return {
    homeDir,
    profile,
    durableEntries,
    installDerivedDirs,
    hostFarmLinks: { ...DSH_GATE_MISMATCHED_FARM_LINKS },
  };
}

/**
 * Presence-only snapshot of the DIRECT symlink entries in a farm directory:
 * `name -> raw target`, name-sorted. Missing/empty dir yields `{}`; real files
 * and directories are ignored (never followed, never read).
 */
export function snapshotDshFarmLinks(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try {
      out[entry.name] = fs.readlinkSync(path.join(dir, entry.name));
    } catch {
      /* raced removal — skip */
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Presence-only recursive snapshot of every symlink under `root`, keyed by the
 * `root`-relative path. Never follows or reads a symlinked target and never
 * reads file contents; the walk is depth-bounded.
 */
export function snapshotDshTreeLinks(root: string, maxDepth = 8): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : path.join(rel, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          out[childRel] = fs.readlinkSync(full);
        } catch {
          /* raced removal — skip */
        }
        continue;
      }
      if (entry.isDirectory()) {
        const st = lstatOrUndefined(full);
        if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) {
          walk(full, childRel, depth + 1);
        }
      }
    }
  };
  walk(root, "", 0);
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface DshOverlayObservation {
  /** True when the private per-run overlay root was observed as a real dir. */
  readonly rootSeen: boolean;
  /** Merged `root`-relative symlink inventory observed across every sample. */
  readonly links: Record<string, string>;
  /**
   * UNION4 (union-only helper, preserved): UNION of every distinct target
   * observed for each `root`-relative symlink, sorted. Kept alongside the
   * fix's per-sample-last `links` so live observations can still prove the
   * guest healed its private farm even when a later sample sees a different
   * (restored) target for the same link.
   */
  readonly allTargets: Record<string, string[]>;
  /** Merged `root`-relative directory inventory observed across every sample. */
  readonly dirs: string[];
  /**
   * Merged `root`-relative REGULAR FILE inventory observed across every sample.
   * A file that appears transiently and is removed again (the real dsh boot
   * sibling writer lock `profiles/node_modules.lock`, created `wx` and removed
   * in `withFileLock`'s finally) is still retained once a sample saw it.
   */
  readonly files: string[];
  /** Number of samples taken (diagnostic only). */
  readonly ticks: number;
}

/**
 * Presence-only recursive snapshot of every real directory under `root`, keyed
 * by the `root`-relative path (the root itself is `"."`). Never follows a
 * symlinked directory.
 */
export function snapshotDshTreeDirs(root: string, maxDepth = 8): string[] {
  const out = new Set<string>();
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const st = lstatOrUndefined(full);
      if (st === undefined || !st.isDirectory() || st.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : path.join(rel, entry.name);
      out.add(childRel);
      walk(full, childRel, depth + 1);
    }
  };
  walk(root, "", 0);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Presence-only recursive snapshot of every REGULAR FILE under `root`, keyed by
 * the `root`-relative path (sorted). Symlinks are never followed and never
 * reported (even when they resolve to a file), and file contents are never
 * read. The walk is depth-bounded. This is what lets the observer catch the
 * transient `profiles/node_modules.lock` a guest creates and removes during a
 * single dsh boot.
 */
export function snapshotDshTreeFiles(root: string, maxDepth = 8): string[] {
  const out = new Set<string>();
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : path.join(rel, entry.name);
      if (entry.isFile()) {
        out.add(childRel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel, depth + 1);
      }
    }
  };
  walk(root, "", 0);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Polls a host-attested per-run overlay root while a round is live and merges
 * every symlink AND regular file it observes. The controller removes the
 * overlay after the confirmed VM close, so this is the only way to capture the
 * guest's PRIVATE install-derived farm content and the transient boot artifacts
 * (the `withFileLock` sibling `profiles/node_modules.lock`): it proves the
 * guest wrote guest-install links and its boot writer lock into the private
 * overlay (and thus never into the host farm).
 */
export class DshOverlayObserver {
  private readonly root: string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private rootSeen = false;
  private ticks = 0;
  private readonly links = new Map<string, string>();
  private readonly allTargets = new Map<string, Set<string>>();
  private readonly dirs = new Set<string>();
  private readonly files = new Set<string>();

  constructor(root: string, opts: { intervalMs?: number } = {}) {
    this.root = root;
    this.intervalMs = opts.intervalMs ?? 50;
  }

  start(): this {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    // Never keep a finished test process alive on this timer.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
    return this;
  }

  private sample(): void {
    if (this.stopped) return;
    this.ticks += 1;
    const st = lstatOrUndefined(this.root);
    if (st === undefined || !st.isDirectory() || st.isSymbolicLink()) return;
    this.rootSeen = true;
    for (const rel of snapshotDshTreeDirs(this.root)) this.dirs.add(rel);
    for (const rel of snapshotDshTreeFiles(this.root)) this.files.add(rel);
    for (const [rel, target] of Object.entries(snapshotDshTreeLinks(this.root))) {
      this.links.set(rel, target);
      let seen = this.allTargets.get(rel);
      if (seen === undefined) {
        seen = new Set<string>();
        this.allTargets.set(rel, seen);
      }
      seen.add(target);
    }
  }

  stop(): DshOverlayObservation {
    if (!this.stopped) this.sample();
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return {
      rootSeen: this.rootSeen,
      links: Object.fromEntries(
        [...this.links.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      allTargets: Object.fromEntries(
        [...this.allTargets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([rel, targets]) => [rel, [...targets].sort((a, b) => a.localeCompare(b))]),
      ),
      dirs: [...this.dirs].sort((a, b) => a.localeCompare(b)),
      files: [...this.files].sort((a, b) => a.localeCompare(b)),
      ticks: this.ticks,
    };
  }
}

/**
 * Presence-only recursive symlink snapshot of EVERY install-derived farm dir
 * under `homeDir`, keyed by the `<installDerivedRel>/<linkRel>` path (sorted).
 *
 * This is the "host farm snapshot" the US-005 gate compares byte-for-byte
 * across an in-VM round: a guest boot that flipped the host farm to its own
 * install paths would retarget a nested link and change this map. Nested
 * scope-dir links are included (unlike the direct-only `snapshotDshFarmLinks`),
 * so a scoped `@scope/pkg` retarget is caught too.
 */
export function snapshotDshInstallDerivedFarms(
  homeDir: string,
  installDerivedDirs: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of installDerivedDirs) {
    const links = snapshotDshTreeLinks(path.join(homeDir, rel));
    for (const [childRel, target] of Object.entries(links)) {
      out[path.join(rel, childRel)] = target;
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * DSH-PROFILE-OVERLAY US-004 — the full host-side `<homeDir>/profiles` tree
 * invariance snapshot. Beyond the install-derived farm LINKS
 * (`snapshotDshInstallDerivedFarms`), this captures every regular file under
 * `profiles/` and the two boot-sibling artifacts dsh writes next to the farm
 * (`node_modules.lock`, the synthetic fixture's durable marker), so the gate
 * can assert the HOST tree is byte-identical before/after every in-VM round and
 * that the guest's writer lock never leaked to the host.
 */
export interface DshProfilesInvariance {
  /** Regular files under `<homeDir>/profiles` (`profiles`-relative, sorted). */
  readonly files: string[];
  /** Every symlink under `<homeDir>/profiles` (`profiles`-relative, sorted). */
  readonly links: Record<string, string>;
  /** True when the HOST `<homeDir>/profiles/node_modules.lock` exists. */
  readonly lockPresent: boolean;
  /** True when the HOST synthetic boot sibling marker exists. */
  readonly bootMarkerPresent: boolean;
}

export function snapshotDshProfilesInvariance(homeDir: string): DshProfilesInvariance {
  const profiles = path.join(homeDir, "profiles");
  return {
    files: snapshotDshTreeFiles(profiles),
    links: snapshotDshTreeLinks(profiles),
    lockPresent: fs.existsSync(path.join(profiles, "node_modules.lock")),
    bootMarkerPresent: fs.existsSync(path.join(profiles, "node_modules.synthetic-boot-marker")),
  };
}

// ── DSH-OVERLAY-LOCK-FIX US-005: gate-owned real-dsh home ─────────────────
//
// The real-dsh contained boot regression must boot the REAL dsh CLI with the
// REAL headless profile layout while never reading the operator's real
// credentials. `stageGateOwnedDshHome` materializes a fresh, gate-owned
// `$DSH_HOME` from the operator's dsh profile layout:
//
//   - every DURABLE profile config file (package.json, cordis.yml,
//     cordis.patch.yml, pnpm-workspace.yaml, any other regular config file) is
//     copied byte-identically;
//   - the install-derived dirs (`profiles/node_modules`,
//     `profiles/<profile>/node_modules`,
//     `profiles/<profile>/.dsh-module-fallback`) are created EMPTY and their
//     host farm content (symlinks) is NEVER copied — the composed plan stages
//     its own private overlay from exactly this home;
//   - `.credentials.yaml` is a fresh PLACEHOLDER file; the source's real
//     credentials are never read or copied (and neither are `sessions/`);
//   - `sessions/` and `storages/` exist as real durable dirs.
//
// The destination therefore contains NO symlink anywhere under `profiles/`,
// which is exactly what `prepareDshProfileOverlay` requires.

/** The dsh boot writer lock basename dsh's `withFileLock` takes. */
export const DSH_GATE_BOOT_LOCK_BASENAME = "node_modules.lock";

/**
 * The placeholder credentials staged into every gate-owned real-dsh home.
 *
 * dsh's `credentials-local` provider rejects a non-empty credentials document
 * without a `version:` key (the pre-release flat layout) and any unknown
 * top-level key, but it treats a COMMENT-ONLY document as the empty store. So
 * the only valid zero-secret placeholder is a comment: it parses as an empty
 * store (no provider can ever be reached, zero model tokens) while still being
 * a real 0600 file whose mode the provider's owner-only check admits.
 */
export const DSH_GATE_PLACEHOLDER_CREDENTIALS =
  "# gate-owned placeholder credentials — NEVER real credentials\n";

const DSH_GATE_DERIVED_PROFILE_DIR_NAMES = new Set([
  "node_modules",
  ".dsh-module-fallback",
]);

export interface GateOwnedDshHomeLayout {
  /** The fresh gate-owned effective DSH_HOME (real directory). */
  readonly homeDir: string;
  /** The headless profile name. */
  readonly profile: string;
  /** Home-relative durable profile config files copied from the source home. */
  readonly durableProfileFiles: string[];
  /** Home-relative install-derived dirs created EMPTY (never copied). */
  readonly installDerivedDirs: string[];
}

function copyDurableProfileTree(
  srcDir: string,
  dstDir: string,
  copied: string[],
  relDir: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Never copy a symlink: the staged home must contain no link under
    // profiles/ (prepareDshProfileOverlay refuses a symlinked source entry),
    // and the host farm is install-derived anyway.
    if (entry.isSymbolicLink()) continue;
    const childRel = path.join(relDir, entry.name);
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (DSH_GATE_DERIVED_PROFILE_DIR_NAMES.has(entry.name)) {
      ensureRealDir(dst);
      continue;
    }
    if (entry.isDirectory()) {
      ensureRealDir(dst);
      copyDurableProfileTree(src, dst, copied, childRel);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      copied.push(childRel);
      continue;
    }
  }
}

/**
 * Materialize a fresh gate-owned `$DSH_HOME` from `sourceHome` (the operator's
 * real dsh home) carrying the real headless profile layout, with placeholder
 * credentials and empty install-derived dirs. Read-only on `sourceHome`: only
 * durable profile config files are read; the source credentials, sessions and
 * install-derived farm are never touched. Idempotent.
 */
export function stageGateOwnedDshHome(opts: {
  sourceHome: string;
  destinationHome: string;
  profile?: string;
}): GateOwnedDshHomeLayout {
  const profile = opts.profile ?? DSH_GATE_PROFILE_NAME;
  const src = path.resolve(opts.sourceHome);
  const dst = path.resolve(opts.destinationHome);
  ensureRealDir(dst);
  ensureRealDir(path.join(dst, "profiles"));
  const dstProfile = path.join(dst, "profiles", profile);
  ensureRealDir(dstProfile);

  const installDerivedDirs = [
    path.join("profiles", "node_modules"),
    path.join("profiles", profile, "node_modules"),
    path.join("profiles", profile, ".dsh-module-fallback"),
  ];
  for (const rel of installDerivedDirs) ensureRealDir(path.join(dst, rel));

  const durableProfileFiles: string[] = [];
  const srcProfile = path.join(src, "profiles", profile);
  if (isRealDir(srcProfile)) {
    copyDurableProfileTree(
      srcProfile,
      dstProfile,
      durableProfileFiles,
      path.join("profiles", profile),
    );
  }
  durableProfileFiles.sort((a, b) => a.localeCompare(b));

  for (const entry of ["sessions", "storages"]) ensureRealDir(path.join(dst, entry));
  // Placeholder credentials ONLY — never the source's real credential file.
  // dsh's credentials-local provider refuses a credentials file "readable
  // beyond its owner", so stage it 0600 exactly like the operator's own file.
  writeOwnerOnlyFile(path.join(dst, ".credentials.yaml"), DSH_GATE_PLACEHOLDER_CREDENTIALS);

  return {
    homeDir: dst,
    profile,
    durableProfileFiles,
    installDerivedDirs,
  };
}

// ── DSH-OVERLAY-FSYNC-FIX US-001: operator-shaped real-layout DSH_HOME ────
//
// The #34 real-boot gate used a MINIMAL zero-provider fixture home
// (`profiles/<profile>` only) and therefore never exercised the real dsh boot
// path over an operator-shaped store. `stageRealLayoutDshHome` materializes a
// deterministic, gate-owned `$DSH_HOME` that mirrors the REAL operator layout:
//
//   - the durable profile config from `stageGateOwnedDshHome` (byte-identical
//     copy when a source home is supplied; synthesized when it is absent);
//   - at least three DISTINCT `sessions/<cwd-key>/session-<uuid>/` dirs, each
//     holding a REGULAR `session.v3.jsonl.zstd` (and the legacy-named
//     `session.jsonl.zstd`) that is a concatenation of >= 2 valid zstd frames,
//     plus the real `session.lock` sibling;
//   - `storages/session_projcache/sessions/session-<uuid>.json` regular JSON
//     records;
//   - `.anonymous-user-id` and PLACEHOLDER `.credentials.yaml`.
//
// The source home is read-only evidence: ONLY the durable profile config is
// read. Its `.credentials.yaml` and `sessions/` contents are NEVER read or
// copied, and the seeded session/store contents are always synthesized
// deterministically (never the operator's real session data). Names and
// contents are fixed constants, so two builds from the same inputs are
// byte-identical.

/** Env override naming the operator's real dsh home (read-only evidence). */
export const DSH_GATE_REAL_DSH_HOME_ENV = "TAMANDUA_GATE_REAL_DSH_HOME";

/**
 * The deterministic synthetic `.anonymous-user-id` staged into every
 * real-layout home. Never the operator's real anonymous id.
 */
export const DSH_GATE_REAL_LAYOUT_ANONYMOUS_USER_ID =
  "00000000-0000-4000-8000-000000000001";

/**
 * The canonical durable headless profile config files. Copied byte-identically
 * when the source home carries them, synthesized deterministically otherwise.
 */
export const DSH_GATE_DURABLE_PROFILE_FILES: readonly string[] = [
  "package.json",
  "cordis.yml",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
];

/** Deterministic synthetic cwds backing the seeded `sessions/<cwd-key>/` dirs. */
export const DSH_GATE_REAL_LAYOUT_PROJECT_CWDS: readonly string[] = [
  "/workspace/real-layout-project-alpha",
  "/workspace/real-layout-project-beta",
  "/workspace/real-layout-project-gamma",
];

/** Default number of distinct seeded session project dirs (>= 3). */
export const DSH_GATE_REAL_LAYOUT_DEFAULT_PROJECTS = 3;
/** Default zstd frames per seeded session artifact (>= 2). */
export const DSH_GATE_REAL_LAYOUT_DEFAULT_FRAMES = 2;
/** Default number of seeded storages JSON records (>= 1). */
export const DSH_GATE_REAL_LAYOUT_DEFAULT_STORAGE_RECORDS = 3;

/** Deterministic UTF-8 byte base for the `createdAt` fields (no Date.now). */
const DSH_GATE_REAL_LAYOUT_EPOCH_MS = 1_700_000_000_000;

/**
 * dsh's `projectKey` encoding, re-implemented locally (the mirrored bytes must
 * be deterministic and this module stays free of the compiled `dist` tree).
 * Byte-identical to `src/installer/matchlock/dsh-session-store.ts`
 * `matchlockProjectKey` / the installed `session-persistence-jsonl` format.
 */
function syntheticDshProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/** Deterministic RFC-4122-shaped id: `<group>-0000-4000-8000-<index padded>`. */
function deterministicUuid(group: string, index: number): string {
  return `${group}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * Feature-detect node:zlib's synchronous zstd COMPRESSOR (Node >= 23.8). The
 * real-layout fixture MUST fail loudly when unavailable rather than stage a
 * plain-text artifact that would not exercise the zstd path.
 */
function detectNodeZstdCompress(): ((buf: Uint8Array) => Buffer) | undefined {
  const candidate = (zlib as unknown as { zstdCompressSync?: unknown })
    .zstdCompressSync;
  return typeof candidate === "function"
    ? (candidate as (buf: Uint8Array) => Buffer)
    : undefined;
}

/**
 * Encode each JSONL line as its OWN complete zstd frame and concatenate them —
 * the concatenated-frame container dsh's session store appends to (and the
 * production reader's `scanMatchlockZstdFrames` classifies). `frames` must be
 * >= 2 by construction at every call site.
 */
function concatenatedZstdFrames(lines: readonly string[]): Buffer {
  const compress = detectNodeZstdCompress();
  if (compress === undefined) {
    throw new Error(
      "real-layout dsh fixture requires node:zlib zstdCompressSync " +
        "(Node >= 23.8); the installed Node is too old",
    );
  }
  return Buffer.concat(
    lines.map((line) => compress(Buffer.from(`${line}\n`, "utf8"))),
  );
}

/** Deterministic synthetic durable profile config for a missing source file. */
function syntheticProfileConfig(name: string, profile: string): string {
  switch (name) {
    case "package.json":
      return `${JSON.stringify(
        {
          name: `dsh-profile-${profile}-real-layout`,
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
              patchReload: "startup",
            },
          },
        },
        null,
        2,
      )}\n`;
    case "cordis.yml":
      return "[]\n";
    case "cordis.patch.yml":
      return "[]\n";
    case "pnpm-workspace.yaml":
      return "packages: []\n";
    default:
      return "";
  }
}

/** One v3 session header record (the first decoded record of the artifact). */
function syntheticSessionHeader(
  id: string,
  cwd: string,
  createdAt: number,
): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id,
    createdAt,
    isSeeded: false,
    cwd,
  };
}

/** One v3 assistant/message usage record (top-level data.usage). */
function syntheticUsageRecord(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    type: "assistant/message",
    data: {
      message: { role: "assistant" },
      usage: { inputTokens, outputTokens, cacheReadTokens: 0 },
    },
  };
}

export interface RealLayoutDshHomeOptions {
  /** Fresh gate-owned effective DSH_HOME to materialize (real directory). */
  destinationHome: string;
  /**
   * Operator's real dsh home (read-only durable-profile source). `undefined`
   * resolves `TAMANDUA_GATE_REAL_DSH_HOME` then `$HOME/.dsh`; `null` disables
   * the source entirely and synthesizes every durable config file. Only the
   * headless profile config is read — credentials/sessions are never touched.
   */
  sourceHome?: string | null;
  /** Profile name (default `headless`). */
  profile?: string;
  /** Distinct session project dirs to seed (default 3; always >= 3). */
  projectCount?: number;
  /** zstd frames per session artifact (default 2; always >= 2). */
  framesPerSession?: number;
  /** storages records to seed (default 3; always >= 1). */
  storageRecordCount?: number;
}

export interface RealLayoutDshHomeLayout extends GateOwnedDshHomeLayout {
  /** Home-relative `sessions/<cwd-key>` project dirs (sorted). */
  readonly sessionProjectDirs: string[];
  /** Home-relative `sessions/<cwd-key>/session-<uuid>` dirs (sorted). */
  readonly sessionDirs: string[];
  /** Home-relative current v3 `session.v3.jsonl.zstd` artifacts (sorted). */
  readonly currentSessionArtifacts: string[];
  /** Home-relative legacy-named `session.jsonl.zstd` artifacts (sorted). */
  readonly legacySessionArtifacts: string[];
  /** Home-relative real `session.lock` siblings (sorted). */
  readonly sessionLockFiles: string[];
  /** Home-relative `storages/.../session-<uuid>.json` records (sorted). */
  readonly storageRecordFiles: string[];
  /** Home-relative `.anonymous-user-id` file. */
  readonly anonymousUserIdFile: string;
  /** Home-relative placeholder `.credentials.yaml` file. */
  readonly credentialsFile: string;
  /** Home-relative durable config files that were SYNTHESIZED (not copied). */
  readonly synthesizedConfigFiles: string[];
}

/**
 * Materialize a deterministic operator-SHAPED `$DSH_HOME`: real durable
 * profile config (copied read-only from the source when supplied, synthesized
 * otherwise), >= 3 distinct concatenated-zstd session project dirs, storages
 * JSON records, `.anonymous-user-id` and placeholder credentials. Never reads
 * or copies the source credentials or session contents. Idempotent.
 */
export function stageRealLayoutDshHome(
  opts: RealLayoutDshHomeOptions,
): RealLayoutDshHomeLayout {
  const profile = opts.profile ?? DSH_GATE_PROFILE_NAME;
  const dst = path.resolve(opts.destinationHome);
  const envSource = process.env[DSH_GATE_REAL_DSH_HOME_ENV];
  const sourceHome =
    opts.sourceHome === null
      ? // A path that cannot exist: no durable config is read or copied.
        path.join(dst, ".no-source-home")
      : opts.sourceHome ??
        (envSource !== undefined && envSource.length > 0
          ? envSource
          : path.join(os.homedir(), ".dsh"));

  const base = stageGateOwnedDshHome({
    sourceHome,
    destinationHome: dst,
    profile,
  });

  // Guarantee the canonical durable config exists: the copy wins when the
  // source carries the file, otherwise a deterministic synthetic one is staged
  // so an ABSENT source still yields a complete real-shape layout.
  const profileDir = path.join(dst, "profiles", profile);
  const durable = new Set(base.durableProfileFiles);
  const synthesizedConfigFiles: string[] = [];
  for (const name of DSH_GATE_DURABLE_PROFILE_FILES) {
    const file = path.join(profileDir, name);
    const rel = path.join("profiles", profile, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, syntheticProfileConfig(name, profile), "utf-8");
      synthesizedConfigFiles.push(rel);
    }
    durable.add(rel);
  }
  const durableProfileFiles = [...durable].sort((a, b) => a.localeCompare(b));
  synthesizedConfigFiles.sort((a, b) => a.localeCompare(b));

  const projectCount = Math.max(3, opts.projectCount ?? DSH_GATE_REAL_LAYOUT_DEFAULT_PROJECTS);
  const framesPerSession = Math.max(
    2,
    opts.framesPerSession ?? DSH_GATE_REAL_LAYOUT_DEFAULT_FRAMES,
  );
  const storageRecordCount = Math.max(
    1,
    opts.storageRecordCount ?? DSH_GATE_REAL_LAYOUT_DEFAULT_STORAGE_RECORDS,
  );

  const sessionProjectDirs: string[] = [];
  const sessionDirs: string[] = [];
  const currentSessionArtifacts: string[] = [];
  const legacySessionArtifacts: string[] = [];
  const sessionLockFiles: string[] = [];

  for (let i = 0; i < projectCount; i++) {
    const cwd =
      DSH_GATE_REAL_LAYOUT_PROJECT_CWDS[i] ?? `/workspace/real-layout-project-${i + 1}`;
    const projectKey = syntheticDshProjectKey(cwd);
    const sessionId = deterministicUuid("00000000", i + 1);
    const createdAt = DSH_GATE_REAL_LAYOUT_EPOCH_MS + i;
    const projectRel = path.join("sessions", projectKey);
    const sessionRel = path.join(projectRel, `session-${sessionId}`);
    const sessionDir = path.join(dst, sessionRel);
    ensureRealDir(sessionDir);

    // First frame: the v3 session header. Remaining frames: usage messages, so
    // the artifact is a concatenation of >= 2 independently decodable frames.
    const v3Lines = [
      JSON.stringify(syntheticSessionHeader(sessionId, cwd, createdAt)),
    ];
    for (let f = 1; f < framesPerSession; f++) {
      v3Lines.push(JSON.stringify(syntheticUsageRecord(7 + f, 3 + f)));
    }
    const currentRel = path.join(sessionRel, "session.v3.jsonl.zstd");
    fs.writeFileSync(path.join(dst, currentRel), concatenatedZstdFrames(v3Lines));

    // Legacy-named `session.jsonl.zstd` (dsh <= 0.1.0 shape) — also a real
    // concatenation of >= 2 frames, retained so the fixture covers the
    // generation name the qualification contract calls out.
    const legacyLines = [
      JSON.stringify({ type: "session", version: 0, id: sessionId, createdAt, isSeeded: false, cwd }),
    ];
    for (let f = 1; f < framesPerSession; f++) {
      legacyLines.push(
        JSON.stringify({
          type: "assistant/chunk",
          data: { chunk: { type: "usage", usage: { inputTokens: 2 + f, outputTokens: 1 } } },
        }),
      );
    }
    const legacyRel = path.join(sessionRel, "session.jsonl.zstd");
    fs.writeFileSync(path.join(dst, legacyRel), concatenatedZstdFrames(legacyLines));

    const lockRel = path.join(sessionRel, "session.lock");
    fs.writeFileSync(path.join(dst, lockRel), "");

    sessionProjectDirs.push(projectRel);
    sessionDirs.push(sessionRel);
    currentSessionArtifacts.push(currentRel);
    legacySessionArtifacts.push(legacyRel);
    sessionLockFiles.push(lockRel);
  }

  const storageDirRel = path.join("storages", "session_projcache", "sessions");
  const storageDir = path.join(dst, storageDirRel);
  ensureRealDir(storageDir);
  const storageRecordFiles: string[] = [];
  for (let i = 0; i < storageRecordCount; i++) {
    const recordId = deterministicUuid("00000001", i + 1);
    const cwd = DSH_GATE_REAL_LAYOUT_PROJECT_CWDS[i] ?? `/workspace/real-layout-project-${i + 1}`;
    const rel = path.join(storageDirRel, `session-${recordId}.json`);
    fs.writeFileSync(
      path.join(dst, rel),
      `${JSON.stringify({
        version: 7,
        record: {
          identity: {
            formatVersion: 2,
            createdAt: DSH_GATE_REAL_LAYOUT_EPOCH_MS + i,
            cwd,
            isSeeded: false,
            inheritedEventCount: 0,
          },
          rows: {},
        },
      })}\n`,
      "utf-8",
    );
    storageRecordFiles.push(rel);
  }

  const anonymousUserIdFile = ".anonymous-user-id";
  fs.writeFileSync(
    path.join(dst, anonymousUserIdFile),
    `${DSH_GATE_REAL_LAYOUT_ANONYMOUS_USER_ID}\n`,
    "utf-8",
  );

  const credentialsFile = ".credentials.yaml";
  // Placeholder ONLY — stageGateOwnedDshHome already wrote it 0600; rewrite to
  // be explicit and to guarantee BOTH the value and the owner-only mode even if
  // the destination pre-existed.
  writeOwnerOnlyFile(path.join(dst, credentialsFile), DSH_GATE_PLACEHOLDER_CREDENTIALS);

  const sortStrings = (values: string[]): string[] =>
    [...values].sort((a, b) => a.localeCompare(b));

  return {
    homeDir: dst,
    profile,
    durableProfileFiles,
    installDerivedDirs: base.installDerivedDirs,
    sessionProjectDirs: sortStrings(sessionProjectDirs),
    sessionDirs: sortStrings(sessionDirs),
    currentSessionArtifacts: sortStrings(currentSessionArtifacts),
    legacySessionArtifacts: sortStrings(legacySessionArtifacts),
    sessionLockFiles: sortStrings(sessionLockFiles),
    storageRecordFiles: sortStrings(storageRecordFiles),
    anonymousUserIdFile,
    credentialsFile,
    synthesizedConfigFiles,
  };
}

// ── DSH-OVERLAY-LOCK-FIX US-005: transient boot-lock observation ─────────
//
// The REAL dsh holds `withFileLock`'s sibling lock (`profiles/node_modules.lock`)
// only for the duration of the module heal (a small symlink-closure rewrite —
// potentially a handful of milliseconds). A poll of the whole overlay tree can
// miss it, so the gate watches the private `profiles/` DIRECTORY with
// `fs.watch` (inotify) AND a cheap single-path poll. Both are Node-core only.

export interface DshBootLockObservation {
  /** True when the lock was created (or was present at start). */
  readonly seen: boolean;
  /** The lock already existed when the watch started. */
  readonly presentAtStart: boolean;
  /** Raw watch events carrying the exact lock basename. */
  readonly events: string[];
  /** False when `fs.watch` could not be installed (poll-only fallback). */
  readonly watchAvailable: boolean;
}

export interface DshBootLockWatcher {
  stop(): DshBootLockObservation;
}

/**
 * Watch `<profilesDir>/node_modules.lock` for the whole live round. A directory
 * watch event naming the exact lock basename is enough to prove the guest
 * created (and then removed) the boot writer lock, even when the file is gone
 * before the callback runs. A 2ms single-path poll backs up the watcher.
 */
export function watchDshProfilesBootLock(
  profilesDir: string,
  opts: { pollMs?: number } = {},
): DshBootLockWatcher {
  const lockPath = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);
  const events: string[] = [];
  let presentAtStart = false;
  try {
    presentAtStart = fs.existsSync(lockPath);
  } catch {
    presentAtStart = false;
  }
  let seen = presentAtStart;
  let watcher: fs.FSWatcher | null = null;
  if (isRealDir(profilesDir)) {
    try {
      watcher = fs.watch(profilesDir, (event, filename) => {
        const name = filename === null ? "" : String(filename);
        if (name !== DSH_GATE_BOOT_LOCK_BASENAME) return;
        events.push(`${event}:${name}`);
        // An event for the exact lock basename proves a create/delete cycle at
        // that path even if the file no longer exists in this callback.
        seen = true;
      });
      watcher.on("error", () => {
        /* poll fallback stays authoritative */
      });
      if (typeof (watcher as { unref?: () => void }).unref === "function") {
        (watcher as { unref: () => void }).unref();
      }
    } catch {
      watcher = null;
    }
  }
  const timer = setInterval(() => {
    try {
      if (fs.existsSync(lockPath)) seen = true;
    } catch {
      /* raced removal — retried next tick */
    }
  }, opts.pollMs ?? 2);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  let stopped = false;
  return {
    stop(): DshBootLockObservation {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        try {
          if (fs.existsSync(lockPath)) seen = true;
        } catch {
          /* ignore */
        }
        if (watcher !== null) {
          try {
            watcher.close();
          } catch {
            /* best effort */
          }
        }
      }
      return {
        seen,
        presentAtStart,
        events: [...events],
        watchAvailable: watcher !== null,
      };
    },
  };
}

/**
 * True when `stderr` carries the exact run-#32 production failure shape for the
 * boot writer lock:
 * `Error: ENOENT: no such file or directory, open '<profiles>/node_modules.lock'`.
 * `profilesDir` (when supplied) also matches the resolved absolute lock path.
 */
export function stderrCarriesDshBootLockEnoent(
  stderr: string,
  profilesDir?: string,
): boolean {
  const text = String(stderr ?? "");
  if (
    /ENOENT: no such file or directory, open '[^'\n]*[/\\]node_modules\.lock'/.test(text)
  ) {
    return true;
  }
  if (profilesDir && text.includes(path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME))) {
    return true;
  }
  return false;
}

/**
 * DSH-OVERLAY-FSYNC-FIX US-004 — true when `stderr` carries the run-#35
 * production failure shape for the guest `$DSH_HOME` root:
 *
 *   `dsh: ENOENT: no such file or directory, fsync`
 *
 * US-002's in-VM diagnosis pinned this to `fsync(<DSH_HOME>)` failing ENOENT
 * because the whole config root was a SYNTHETIC FUSE router root with no host
 * provider to fsync (the per-entry plan promoted the parent of the two
 * single-FILE destinations). The pattern is deliberately narrow: it requires
 * `ENOENT` and the `fsync` syscall name on the SAME line, so an unrelated
 * `ENOENT` (e.g. a missing provider key file) can never masquerade as the
 * boot-root regression.
 */
export function stderrCarriesDshFsyncEnoent(stderr: string): boolean {
  return /ENOENT[^\n]*\bfsync\b/.test(String(stderr ?? ""));
}

/**
 * US-004 — true for EITHER boot-fatal `$DSH_HOME` ENOENT shape the real dsh
 * boot must never produce again: the run-#35 root `fsync` ENOENT (fixed by the
 * single effective-home mount) or the run-#32 `profiles/node_modules.lock`
 * open ENOENT (fixed by the private profiles overlay).
 */
export function stderrCarriesDshBootEnoent(stderr: string, profilesDir?: string): boolean {
  return (
    stderrCarriesDshFsyncEnoent(stderr) ||
    stderrCarriesDshBootLockEnoent(stderr, profilesDir)
  );
}

// ── DSH-OVERLAY-FSYNC-FIX US-004: host-mapped store observation ───────────
//
// After a round, US-003's `publishDshHomeOverlayToHost` merges the guest-written
// durable entries of the per-run effective home back into the REAL host home.
// These helpers observe that merge: the session store (`sessions/<cwd-key>/
// session-<uuid>/`) and the projection cache (`storages/.../*.json`) are the
// durable entries the host-side attribution reader consumes, so a "first
// request record landed" proof is a NEW regular file under one of them.

export interface DshHostStoreSnapshot {
  /** Home-relative `sessions/<projectKey>/session-<uuid>` dirs (sorted). */
  readonly sessionDirs: string[];
  /** Home-relative REGULAR files under `sessions/` (sorted). */
  readonly sessionFiles: string[];
  /** Home-relative REGULAR files under `storages/` (sorted). */
  readonly storageFiles: string[];
}

/**
 * Presence-only snapshot of the durable session/storage store of a dsh home:
 * the session leaf dirs, every regular file under `sessions/`, and every
 * regular file under `storages/` (all home-relative). Symlinks are never
 * followed and file contents are never read.
 */
export function snapshotDshHostStore(homeDir: string): DshHostStoreSnapshot {
  const home = path.resolve(homeDir);
  const sessionsRoot = path.join(home, "sessions");
  const storagesRoot = path.join(home, "storages");
  const sortStrings = (values: string[]): string[] =>
    [...values].sort((a, b) => a.localeCompare(b));

  const sessionFiles = snapshotDshTreeFiles(sessionsRoot).map((rel) =>
    path.join("sessions", rel),
  );
  const storageFiles = snapshotDshTreeFiles(storagesRoot).map((rel) =>
    path.join("storages", rel),
  );

  const sessionDirs: string[] = [];
  for (const rel of snapshotDshTreeDirs(sessionsRoot)) {
    const parts = rel.split(path.sep);
    // sessions/<projectKey>/session-<uuid>
    if (parts.length === 2 && parts[1].startsWith("session-")) {
      sessionDirs.push(path.join("sessions", rel));
    }
  }

  return {
    sessionDirs: sortStrings(sessionDirs),
    sessionFiles: sortStrings(sessionFiles),
    storageFiles: sortStrings(storageFiles),
  };
}

export interface DshHostStoreDelta {
  /** Session leaf dirs present after but not before the round. */
  readonly addedSessionDirs: string[];
  /** Regular session-store files present after but not before the round. */
  readonly addedSessionFiles: string[];
  /** Regular storage-store files present after but not before the round. */
  readonly addedStorageFiles: string[];
}

/** Set difference of two host-store snapshots (`after` minus `before`). */
export function diffDshHostStore(
  before: DshHostStoreSnapshot,
  after: DshHostStoreSnapshot,
): DshHostStoreDelta {
  const added = (prev: readonly string[], next: readonly string[]): string[] => {
    const seen = new Set(prev);
    return next.filter((value) => !seen.has(value));
  };
  return {
    addedSessionDirs: added(before.sessionDirs, after.sessionDirs),
    addedSessionFiles: added(before.sessionFiles, after.sessionFiles),
    addedStorageFiles: added(before.storageFiles, after.storageFiles),
  };
}

/** The deterministic command/env plan for one HOST-side native dsh boot. */
export interface NativeDshBootPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

/**
 * Build the argv/env for the deterministic HOST-side ("native") zero-provider
 * dsh boot that heals the synthetic host farm. The fixture is executed with
 * node directly (`node fake-dsh.mjs --profile headless <heal prompt>`), with
 * an isolated HOME, the synthetic DSH_HOME, and NO credentials or provider
 * env: the heal is the fixture's stand-in for the real
 * `healProfilesModuleFallback`, and the gate asserts it rewrites the host farm
 * before the in-VM round runs.
 *
 * Pure: validates the two absolute roots and returns the plan; it never
 * touches the filesystem or spawns anything.
 */
export function nativeDshBootPlan(opts: {
  nodePath: string;
  fakeDshPath: string;
  /** Isolated HOME for the native boot (never the operator home). */
  homeDir: string;
  /** Synthetic effective DSH_HOME (never the operator's real home). */
  dshHome: string;
  /** Absolute host-side install root the healed links must point at. */
  hostInstallRoot: string;
  profile?: string;
  timeoutMs?: number;
}): NativeDshBootPlan {
  if (!path.isAbsolute(opts.dshHome)) {
    throw new Error(`native dsh boot requires an absolute synthetic DSH_HOME: ${opts.dshHome}`);
  }
  if (!path.isAbsolute(opts.hostInstallRoot)) {
    throw new Error(
      `native dsh boot requires an absolute ${DSH_GATE_NATIVE_INSTALL_ROOT_ENV}: ${opts.hostInstallRoot}`,
    );
  }
  const profile = opts.profile ?? DSH_GATE_PROFILE_NAME;
  return {
    command: opts.nodePath,
    args: [
      opts.fakeDshPath,
      "--profile",
      profile,
      `${DSH_GATE_NATIVE_HEAL_MARKER}: heal the host farm for ${opts.dshHome}`,
    ],
    env: {
      HOME: opts.homeDir,
      DSH_HOME: opts.dshHome,
      [DSH_GATE_NATIVE_INSTALL_ROOT_ENV]: opts.hostInstallRoot,
      DSH_TELEMETRY_DISABLED: "1",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    timeoutMs: opts.timeoutMs ?? 60_000,
  };
}

/** Parsed outcome of the in-VM first-request resolution probe output. */
export interface FirstRequestOutcome {
  /** True when the fixture resolved the request-extension module through the farm. */
  resolved: boolean;
  /** The resolved plugin package name, or null. */
  plugin: string | null;
  /** True when the output carries a request-extension preparation failure. */
  requestExtensionFailure: boolean;
}

/**
 * Parse the in-VM first-request probe's plain-text output. `resolved` is true
 * ONLY for a line-anchored `FIRST-REQUEST-RESOLVED:<name>` marker (the same
 * `^`-anchored discipline the work-round classifier uses), so a marker echoed
 * inside a diagnostic payload can never masquerade as a success.
 */
export function parseFirstRequestOutput(text: string): FirstRequestOutcome {
  const source = String(text ?? "");
  const match = source.match(/^FIRST-REQUEST-RESOLVED:(\S+)\s*$/m);
  return {
    resolved: match !== null,
    plugin: match ? match[1] : null,
    requestExtensionFailure: /REQUEST_EXTENSION|request extension preparation failed/i.test(source),
  };
}

/**
 * True when every guest-private-farm link target is a GUEST install path (i.e.
 * lives under the fixed guest install root and never under a host-only root).
 * Used by the gate to assert the guest's private overlay carries only
 * guest-install links.
 */
export function guestFarmLinksAreGuestInstall(
  links: Readonly<Record<string, string>>,
  guestInstallRoot: string = DSH_GATE_GUEST_INSTALL_ROOT,
): boolean {
  const names = Object.keys(links);
  if (names.length === 0) return false;
  return names.every((name) => {
    const target = links[name];
    return target === guestInstallRoot || target.startsWith(guestInstallRoot + "/");
  });
}
