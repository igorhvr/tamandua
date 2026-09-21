/**
 * Matchlock dsh home resolution + full-home preservation inspection.
 *
 * Resolution mirrors the installed dsh `home-paths` contract but takes ONLY
 * explicit captured inputs (submitting env/cwd/home): precedence is an
 * explicit configured override, then `$DSH_HOME` (empty/whitespace-only is
 * treated as unset), then `<homeDir>/.dsh`. A relative `$DSH_HOME` is resolved
 * against the submitting command's cwd (dsh resolves it against the invoking
 * process cwd). `~` prefixes expand against the captured home.
 *
 * Preservation inspection is presence-only: it enumerates top-level entries
 * and profile module-fallback link targets and NEVER reads file contents, so
 * credentials (`.credentials.yaml`, `.anonymous-user-id`) are reported as
 * presence markers with no values.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DSH_HOME_DIR_NAME,
  type DshHomeEntry,
  type DshHomeEntryKind,
  type DshHomeSource,
  type DshProfileModuleLink,
  type DshResolvedHostHome,
  type DshSubmissionContext,
} from "./dsh-adapter-contract.js";

// ── Explicit home resolution ───────────────────────────────────────

/**
 * Expand a supported `~` / `~/` prefix against an explicit home directory.
 * Anything else is returned unchanged (dsh native `expandHomePath` parity).
 */
export function expandDshTilde(raw: string, homeDir: string): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(homeDir, raw.slice(2));
  }
  return raw;
}

/**
 * Resolve the canonical host dsh home from a frozen submission context.
 *
 * @param options Optional explicit configured home (highest precedence, dsh
 *   native `configured` slot). Rarely used; the standard contract is
 *   `$DSH_HOME` then `<homeDir>/.dsh`.
 * @returns canonical absolute host home + selection source.
 */
export function resolveDshHostHome(
  ctx: DshSubmissionContext,
  options: { configured?: string } = {},
): DshResolvedHostHome {
  const selectedRaw =
    options.configured ??
    (ctx.env.DSH_HOME !== undefined && ctx.env.DSH_HOME.trim().length > 0
      ? ctx.env.DSH_HOME
      : undefined);
  if (selectedRaw === undefined) {
    const hostHome = path.resolve(expandDshTilde(path.join(ctx.homeDir, DSH_HOME_DIR_NAME), ctx.homeDir));
    return { hostHome: path.normalize(hostHome), source: "default" };
  }
  const expanded = expandDshTilde(selectedRaw.trim(), ctx.homeDir);
  const hostHome = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(ctx.cwd, expanded);
  return { hostHome, source: "env" };
}

// ── Presence-only preservation inspection ──────────────────────────

const SENSITIVE_NAME_FRAGMENTS = ["credential", "secret", "auth", "token", "key", "passwd", "password"];

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_NAME_FRAGMENTS.some((f) => lower.includes(f));
}

/**
 * Presence-only inventory of one directory: entry name + kind (+ symlink
 * target). Never opens/reads file contents.
 */
export function listDirectoryPresence(dirPath: string): DshHomeEntry[] {
  const entries: DshHomeEntry[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirent of dirents) {
    let kind: DshHomeEntryKind = "file";
    let symlinkTarget: string | undefined;
    if (dirent.isDirectory()) kind = "dir";
    else if (dirent.isSymbolicLink()) {
      kind = "symlink";
      try {
        symlinkTarget = fs.readlinkSync(path.join(dirPath, dirent.name));
      } catch {
        symlinkTarget = undefined;
      }
    }
    entries.push({
      name: dirent.name,
      kind,
      sensitive: isSensitiveName(dirent.name),
      ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Inspect the dsh-managed profile module-fallback links under
 * `profiles/node_modules` (one level deep, direct entries only). On boot the
 * installed profile code replaces mismatched links with the RUNNING
 * installation's dependency closure; the inspected host home currently links
 * into the host installation (`/opt/dsh/...`). With direct RW mounting,
 * guest-created links would persist on the host, so this inspection reports
 * link targets read-only for portability diagnostics.
 */
export function inspectDshProfileModuleLinks(dshHome: string): DshProfileModuleLink[] {
  const linksDir = path.join(dshHome, "profiles", "node_modules");
  const links: DshProfileModuleLink[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(linksDir, { withFileTypes: true });
  } catch {
    return links;
  }
  for (const entry of entries) {
    const linkPath = path.join(linksDir, entry.name);
    let target: string;
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) continue;
      target = fs.readlinkSync(linkPath);
    } catch {
      continue;
    }
    const firstSegment = target.split("/").filter((s) => s.length > 0)[0] ?? target;
    links.push({
      packageName: entry.name,
      linkPath,
      target,
      targetRoot: firstSegment,
    });
  }
  return links.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/**
 * Describe the canonical preserved dsh home layout from a real or synthetic
 * home: the top-level entries that MUST all be mounted RW in full. Returns
 * presence metadata only (never content). `expectedDirs` documents the native
 * structural layout the adapter has qualified.
 */
export function describeDshHomeLayout(
  dshHome: string,
): { entries: DshHomeEntry[]; profileModuleLinks: DshProfileModuleLink[] } {
  return {
    entries: listDirectoryPresence(dshHome),
    profileModuleLinks: inspectDshProfileModuleLinks(dshHome),
  };
}

// ── Install-derived profile module farm snapshot/diff ─────────────
//
// DSH-PROFILE-OVERLAY US-003. `composeProfile` ->
// `healProfilesModuleFallback` re-points `<dshHome>/profiles/node_modules` at
// the RUNNING install's dependency closure on every dsh boot. The Matchlock
// dsh mapping gives the guest a PRIVATE per-run overlay for that directory, so
// an in-VM round must never touch the operator's farm. Recording a
// presence-only snapshot of the farm before/after an in-VM round is bounded
// evidence for that guarantee; a concurrent NATIVE dsh boot legitimately heals
// the host farm, so a difference is evidence (never a round failure) and the
// controlled gate (US-005) asserts byte-equality instead.

/** Added / removed / retargeted link names between two farm snapshots. */
export interface DshProfileModuleLinkDiff {
  /** Names present after but absent before. */
  added: string[];
  /** Names present before but absent after. */
  removed: string[];
  /** Names present in both whose raw symlink target changed. */
  retargeted: string[];
}

/**
 * Presence-only snapshot of the dsh install-derived farm at
 * `<dshHome>/profiles/node_modules`: a stable, name-sorted map of link name ->
 * RAW symlink target. Only DIRECT symlink entries are included (a non-symlink
 * entry such as a real scope directory is ignored); file contents are never
 * read (`lstat` + `readlink` only). A missing or empty farm returns an empty
 * map — never an error.
 */
export function snapshotDshProfileModuleLinks(dshHome: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const linksDir = path.join(dshHome, "profiles", "node_modules");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(linksDir, { withFileTypes: true });
  } catch {
    return snapshot;
  }
  const names = entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const linkPath = path.join(linksDir, name);
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) continue;
      snapshot.set(name, fs.readlinkSync(linkPath));
    } catch {
      // A vanished/racing entry is omitted; evidence is best-effort presence.
      continue;
    }
  }
  return snapshot;
}

/**
 * Compare two {@link snapshotDshProfileModuleLinks} snapshots and report the
 * added, removed and retargeted link names (each list sorted). Never throws;
 * accepts missing snapshots defensively.
 */
export function dshProfileModuleLinksDiffer(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): DshProfileModuleLinkDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const retargeted: string[] = [];
  for (const [name, target] of before) {
    if (!after.has(name)) removed.push(name);
    else if (after.get(name) !== target) retargeted.push(name);
  }
  for (const name of after.keys()) {
    if (!before.has(name)) added.push(name);
  }
  const byName = (a: string, b: string): number => a.localeCompare(b);
  added.sort(byName);
  removed.sort(byName);
  retargeted.sort(byName);
  return { added, removed, retargeted };
}
