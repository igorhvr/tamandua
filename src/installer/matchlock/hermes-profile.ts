/**
 * Matchlock Hermes profile/configuration resolution.
 *
 * MTLK-HERMES US-001: freezes the effective Hermes profile (default / named /
 * active) at run-creation time from the *submitting* user's HOME/env/cwd and
 * maps it to a stable guest path. The daemon must never re-resolve the profile
 * from its own environment at dispatch — the frozen inputs are the only inputs.
 *
 * Resolution mirrors the ACTUAL installed CLI path (hermes_cli/main.py
 * `_apply_profile_override`, ~line 495) and hermes_cli/profiles.py
 * `resolve_profile_env` (~line 1680), verified against native output:
 *
 *   1. Explicit `--profile <name>` (or `-p`/`--profile=`): that name always
 *      wins; resolve via the profile env helper (missing/deleted/invalid ->
 *      native refusal).
 *   2. No flag, but HERMES_HOME is set to a dir whose IMMEDIATE parent is
 *      `profiles`: that dir is trusted unconditionally as the current named
 *      profile home (NO marker condition on the grandparent — the installed
 *      CLI returns at once here).
 *   3. No flag, HERMES_HOME not a `profiles/<name>` dir (or unset): read the
 *      sticky `active_profile` FILE from the effective root. `config.yaml`
 *      `active_profile` is NOT consulted on this path (source-observed).
 *      Missing/deleted/invalid selected profile -> native refusal.
 *   4. Otherwise: the default profile (the home root itself).
 *
 * Only reads the frozen inputs + on-disk files under the resolved root. Never
 * reads `process.env`, never mutates the live configuration.
 */

import path from "node:path";
import fs from "node:fs";

export const DEFAULT_GUEST_HERMES_ROOT = "/workspace/config/hermes";
export const HERMES_PROFILES_DIR = "profiles";
export const DEFAULT_HERMES_PROFILE = "default";
export const DEFAULT_GUEST_HOME = "/root";

/** Mirrors installed `_PROFILE_ID_RE` used to validate a selected profile id. */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Reserved canonical profile ids — mirrors the installed CLI's
 * `_RESERVED_NAMES` in hermes_cli/profiles.py:117:
 * `frozenset({"hermes", "default", "test", "tmp", "root", "sudo"})`.
 *
 * `default` never reaches this check (normalizeProfileId folds it to the home
 * root before the set is consulted, matching native's early return for
 * "default" in validate_profile_name), so including it is harmless. The former
 * Windows-device set (con/prn/aux/comN/lptN/nul/clock) was NOT what native
 * reserves — native accepts `con` and refuses `root`/`tmp`/`sudo`/`hermes`/`test`.
 */
const RESERVED_PROFILE_IDS = new Set<string>([
  "hermes", "default", "test", "tmp", "root", "sudo",
]);

/** Frozen submission-time inputs. The resolver reads ONLY these. */
export interface FrozenHermesSubmissionInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * An outside-scope entry co-located with the selected profile. `required`
 * distinguishes an actually-required dependency from a mere neighboring entry
 * that must NOT be auto-mounted.
 *
 * As of this delivery NO scenario requires an outside dependency: native
 * skills/auth resolve from the effective HERMES_HOME itself (`<home>/skills`,
 * `<home>/.env`), and the selected profile dir IS that home, so siblings/root
 * markers are neighbors only. `required` is therefore always `false` today; it
 * is retained so a controller with concrete cross-profile reference evidence
 * can mark a genuinely required external fallback, but the adapter never emits
 * `required: true` without such proof.
 */
export interface HermesExternalDependency {
  kind: "sibling-profile" | "root-store" | "root-skill" | "unknown-root-entry";
  name: string;
  hostPath: string;
  /** true = genuinely required (must be mounted / admitted by the controller). */
  required: boolean;
}

/** Resolved profile plan: host identity + guest mapping. */
export interface HermesProfilePlan {
  /** Host base home root (HERMES_HOME or ~/.hermes) the resolver started from. */
  hostHomeRoot: string;
  /** Host `<root>/profiles` directory, or null when no profile dir exists. */
  hostProfilesRoot: string | null;
  /** Exact host directory to mount full-RW (the effective selected profile). */
  hostEffectiveDir: string;
  /** Selected profile id: `default`, or a named profile id. */
  profile: string;
  isNamedProfile: boolean;
  /** Guest home root that `profiles` lives under. */
  guestHomeRoot: string;
  /** Exact guest `HERMES_HOME` value. */
  guestHermesHome: string;
  /** Guest `<root>/profiles` directory. */
  guestProfilesRoot: string;
  /** Detected outside-scope entries (required vs neighboring), never auto-mounted. */
  externalDependencies: HermesExternalDependency[];
  /** True when the captured selection would escape the admitted home root. */
  outsideScope: boolean;
  outsideScopeReason: string | null;
  /** True when the native CLI would REFUSE this selection (invalid/deleted/missing). */
  refused: boolean;
  /** Why the native selection was refused, or null. Controller must not launch. */
  refusedReason: string | null;
}

/** Resolve the host base home root from frozen inputs (never process.env). */
function resolveHermesHomeRoot(input: FrozenHermesSubmissionInput): string {
  const raw = input.env.HERMES_HOME?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(input.cwd, raw);
  }
  return path.join(input.homeDir, ".hermes");
}

/** Canonicalize a profile-id string (native normalize_profile_name). */
function normalizeProfileId(name: string): string {
  const stripped = name.trim();
  if (!stripped) return "";
  if (stripped.toLowerCase() === DEFAULT_HERMES_PROFILE) return DEFAULT_HERMES_PROFILE;
  return stripped.toLowerCase();
}

/** True when `dir` is a tombstoned (deleted) named profile home. */
function isProfileDeleted(profileHome: string): boolean {
  const tombstone = path.join(path.dirname(profileHome), ".deleted", path.basename(profileHome));
  return fs.existsSync(tombstone);
}

/**
 * True when `base` itself is `<root>/profiles/<name>` (a named-profile home).
 * Mirrors the installed CLI: ONLY the immediate parent's name matters — NO
 * marker condition on the grandparent (the source-observed fix: previously the
 * adapter wrongly required the grandparent to carry home markers).
 */
function detectNamedProfileHome(base: string): { name: string; root: string; profilesRoot: string } | null {
  const parent = path.dirname(base); // <root>/profiles
  if (path.basename(parent) !== HERMES_PROFILES_DIR) return null;
  const name = path.basename(base);
  if (name.startsWith(".")) return null; // tombstone / hidden — not a live named profile
  return { name, root: path.dirname(parent), profilesRoot: parent };
}

/**
 * Read the sticky `active_profile` FILE (never `config.yaml.active_profile`,
 * which the installed CLI does not consult on the selection path). Returns the
 * canonical non-default id, or `{ invalid, kind }` when native would refuse
 * (kind is `reserved` for a natively-reserved id, `pattern` for a regex-invalid
 * id), or null when no non-default selection is present.
 */
function readStickyActiveProfile(hostHomeRoot: string): { name: string } | { invalid: string; kind: "reserved" | "pattern" } | null {
  const stickyFile = path.join(hostHomeRoot, "active_profile");
  let val: string;
  try {
    val = fs.readFileSync(stickyFile, "utf8").trim();
  } catch {
    return null; // no sticky file — rely on default
  }
  if (!val) return null;
  const canon = normalizeProfileId(val);
  if (canon === DEFAULT_HERMES_PROFILE) return null; // "default" is the home root
  if (!PROFILE_ID_RE.test(canon)) {
    return { invalid: val, kind: "pattern" };
  }
  if (RESERVED_PROFILE_IDS.has(canon)) {
    return { invalid: val, kind: "reserved" };
  }
  return { name: canon };
}

/** Finish a named-profile plan. */
function namedProfilePlan(
  hostHomeRoot: string,
  name: string,
  profilesRoot: string,
  effectiveDir: string,
  input: FrozenHermesSubmissionInput,
): HermesProfilePlan {
  // The captured selection must stay under the admitted home root (lexical;
  // realpath admission is a controller/VFS integration gate, not assumed here).
  const rel = path.relative(hostHomeRoot, effectiveDir);
  const outsideScope =
    rel === "" ? false : rel.startsWith("..") || path.isAbsolute(rel);

  return {
    hostHomeRoot,
    hostProfilesRoot: profilesRoot,
    hostEffectiveDir: effectiveDir,
    profile: name,
    isNamedProfile: true,
    guestHomeRoot: DEFAULT_GUEST_HERMES_ROOT,
    guestHermesHome: path.join(DEFAULT_GUEST_HERMES_ROOT, HERMES_PROFILES_DIR, name),
    guestProfilesRoot: path.join(DEFAULT_GUEST_HERMES_ROOT, HERMES_PROFILES_DIR),
    externalDependencies: outsideScope
      ? []
      : detectExternalEntries(path.dirname(profilesRoot), profilesRoot, effectiveDir),
    outsideScope,
    outsideScopeReason: outsideScope
      ? `Named profile "${name}" resolves outside the admitted home root ${hostHomeRoot}.`
      : null,
    refused: false,
    refusedReason: null,
  };
}

/** Finish a default-profile plan. */
function defaultProfilePlan(
  hostHomeRoot: string,
  input: FrozenHermesSubmissionInput,
): HermesProfilePlan {
  const profilesRoot = path.join(hostHomeRoot, HERMES_PROFILES_DIR);
  return {
    hostHomeRoot,
    hostProfilesRoot: profilesRoot,
    hostEffectiveDir: hostHomeRoot,
    profile: DEFAULT_HERMES_PROFILE,
    isNamedProfile: false,
    guestHomeRoot: DEFAULT_GUEST_HERMES_ROOT,
    guestHermesHome: DEFAULT_GUEST_HERMES_ROOT,
    guestProfilesRoot: path.join(DEFAULT_GUEST_HERMES_ROOT, HERMES_PROFILES_DIR),
    externalDependencies: [],
    outsideScope: false,
    outsideScopeReason: null,
    refused: false,
    refusedReason: null,
  };
}

/**
 * Detect outside-scope entries co-located with a named profile. Native skills
 * and auth resolve from the effective HERMES_HOME (`<home>/skills`,
 * `<home>/.env`), NOT from the root, so siblings/root markers are neighboring
 * presence only (required=false) — they must never be auto-mounted. No scenario
 * is provably referenced by the selected profile's own config, so
 * `required=true` is never emitted here (see `HermesExternalDependency`).
 */
function detectExternalEntries(
  root: string,
  profilesRoot: string,
  effectiveDir: string,
): HermesExternalDependency[] {
  const deps: HermesExternalDependency[] = [];
  // Sibling profiles under the profiles dir: neighboring presence, not deps.
  for (const entry of readDirNames(profilesRoot)) {
    const p = path.join(profilesRoot, entry);
    if (entry.startsWith(".")) continue;
    if (p === effectiveDir) continue;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      deps.push({ kind: "sibling-profile", name: entry, hostPath: p, required: false });
    }
  }
  // Root stores/config/skills are neighbors for a named profile (the profile
  // carries its own .env/config.yaml/skills/state.db). Not required by default.
  for (const marker of ["config.yaml", ".env", "state.db"]) {
    const p = path.join(root, marker);
    if (fs.existsSync(p)) {
      deps.push({ kind: "root-store", name: marker, hostPath: p, required: false });
    }
  }
  const rootSkills = path.join(root, "skills");
  if (fs.existsSync(rootSkills) && fs.statSync(rootSkills).isDirectory()) {
    deps.push({ kind: "root-skill", name: "skills", hostPath: rootSkills, required: false });
  }
  return deps;
}

/** Read directory entry names safely (empty array when unreadable/absent). */
function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve the effective Hermes profile from frozen submission-time inputs.
 * Pure with respect to `process.env`: a later daemon env change cannot
 * retarget the selection.
 */
export function resolveHermesProfile(
  input: FrozenHermesSubmissionInput,
): HermesProfilePlan {
  const hostHomeRoot = resolveHermesHomeRoot(input);

  // Case A: an explicit HERMES_HOME whose immediate parent is `profiles` is
  // trusted as a named-profile home (no marker condition on the grandparent).
  const namedHome = detectNamedProfileHome(hostHomeRoot);
  if (namedHome) {
    return namedProfilePlan(
      hostHomeRoot,
      namedHome.name,
      namedHome.profilesRoot,
      hostHomeRoot,
      input,
    );
  }

  // Case B: a default/custom home root — honour the sticky active_profile FILE.
  // (config.yaml `active_profile` is intentionally NOT consulted here; the
  // installed CLI only reads the file on this path.)
  const sticky = readStickyActiveProfile(hostHomeRoot);
  if (sticky) {
    if ("invalid" in sticky) {
      return {
        ...defaultProfilePlan(hostHomeRoot, input),
        refused: true,
        refusedReason:
          sticky.kind === "reserved"
            ? `active_profile selects profile id "${sticky.invalid}", a reserved profile id; native CLI refuses this selection.`
            : `active_profile contains an invalid profile id "${sticky.invalid}"; native CLI refuses this selection.`,
      };
    }
    const profilesRoot = path.join(hostHomeRoot, HERMES_PROFILES_DIR);
    const effectiveDir = path.join(profilesRoot, sticky.name);
    // Native refusal: the selected profile must exist and not be deleted.
    if (!fs.existsSync(effectiveDir) || !fs.statSync(effectiveDir).isDirectory()) {
      return {
        ...namedProfilePlan(hostHomeRoot, sticky.name, profilesRoot, effectiveDir, input),
        refused: true,
        refusedReason: `Selected profile "${sticky.name}" does not exist; native CLI refuses this selection.`,
      };
    }
    if (isProfileDeleted(effectiveDir)) {
      return {
        ...namedProfilePlan(hostHomeRoot, sticky.name, profilesRoot, effectiveDir, input),
        refused: true,
        refusedReason: `Selected profile "${sticky.name}" is deleted (tombstoned); native CLI refuses this selection.`,
      };
    }
    return namedProfilePlan(hostHomeRoot, sticky.name, profilesRoot, effectiveDir, input);
  }

  // Case C: no selection — the default profile (the home root itself).
  return defaultProfilePlan(hostHomeRoot, input);
}
