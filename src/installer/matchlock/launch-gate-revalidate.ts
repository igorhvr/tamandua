/**
 * Matchlock launch-gate REVALIDATION (G8 ADMISSION-INTEGRATION US-002, bead
 * tamandua-7p5.1.8).
 *
 * The gate observes a store set, evaluates it, and only then allows a VM to be
 * created. Between the observation and the create there is a window in which
 * the world can move: a store can be replaced by a WAL copy at the SAME path, a
 * store can appear or disappear, or `config.yaml` can be edited from `delete`
 * to `wal`. A verdict that was true when it was computed is not a verdict that
 * is true when it is acted on, so the launch re-proves the two things the
 * verdict rests on just before the VM is created:
 *
 *   1. MEMBERSHIP — the same set of store paths (an added path and a removed
 *      path are both changes);
 *   2. IDENTITY — the same inode at each path; and
 *   3. CONFIG — the same effective journal mode, observed-ness and provenance.
 *
 * IDENTITY, NOT SPELLING. Every store is re-stat'ed with a bigint stat and its
 * `(dev, ino)` pair compared as DECIMAL STRINGS. Two paths that spell the same
 * thing but resolve to different inodes are different stores; a swapped file at
 * the same path is caught precisely because the inode changed. Numeric `===` is
 * deliberately never used for this comparison: the values are decimal strings
 * end to end, which is the same representation `store-set.ts` binds and the
 * store-set key digests.
 *
 * WHAT IS NOT RE-READ. The store's header is NOT observed again. This module
 * imports neither the byte reader nor the evaluator (a source-scan test pins
 * that), so "the bytes changed but the inode did not" is an accepted and
 * disclosed window: the contract is membership + config, nothing more. Nor does
 * this module decide that a launch may proceed; it only proves (or fails to
 * prove) that the snapshot handed to it is still true. The caller maps
 * `unchanged: false` to an operational refusal — never to one of the ten closed
 * reason codes, because a changed world is not a store condition.
 *
 * FAIL CLOSED. Anything the module cannot prove is a change, never an
 * `unchanged`: an absent path is a removed store, a stat failure is an
 * unprovable membership, a throwing config reader is a changed config, and a
 * missing reader is a changed config even when both sides read `unreadable`.
 * "Could not check" must never be indistinguishable from "checked and fine".
 *
 * MODULE BOUNDARY. `node:fs` (the bigint stat) and `node:path` (the config file
 * name) are the only ambient imports. Nothing here spawns a process, so this
 * module and its test stay in the PARALLEL test lane.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// snapshot shape
// ---------------------------------------------------------------------------

/** One store the gate bound: its canonical spelling and its inode identity. */
export interface LaunchGateStoreIdentity {
  canonicalPath: string;
  /** Decimal string of the bigint `stat.dev`. Never a number. */
  dev: string;
  /** Decimal string of the bigint `stat.ino`. Never a number. */
  ino: string;
}

/**
 * The effective journal-mode observation the gate made.
 *
 * Structurally identical to the evaluator's `StoreConfigObservation`; declared
 * here so this module imports no evaluator module (it must not be able to
 * re-run header observation through one).
 */
export interface LaunchGateConfigSnapshot {
  journalMode: "delete" | "wal" | "other" | "unreadable";
  source: string;
  observed: boolean;
}

/** What revalidation is asked to prove unchanged: the identities and the config. */
export interface LaunchGateSnapshot {
  stores: LaunchGateStoreIdentity[];
  config: LaunchGateConfigSnapshot;
}

/** The three change classes revalidation may report. Closed by design. */
export type LaunchGateChangeCode =
  | "store-set-changed"
  | "store-identity-changed"
  | "config-changed";

/**
 * One detected change.
 *
 * `field` names the changed field (`membership`, `dev/ino`, `journalMode`,
 * `observed`, `source`) so a refusal detail can say what moved rather than only
 * that something did. `before`/`after` are human-readable renderings of the
 * compared values; `detail` explains what the comparison proved.
 */
export interface LaunchGateChange {
  code: LaunchGateChangeCode;
  /** The store (or, for a config change, the config file) that changed. */
  storePath: string | null;
  before: string | null;
  after: string | null;
  field?: string | null;
  detail?: string | null;
}

/**
 * A revalidation verdict. `unchanged: false` refuses the launch; an empty
 * change list is still a refusal (the caller treats "not proven" as "changed").
 */
export type LaunchGateRevalidation =
  | { unchanged: true }
  | { unchanged: false; changes: LaunchGateChange[] };

// ---------------------------------------------------------------------------
// injection seams
// ---------------------------------------------------------------------------

/** The inode identity a re-stat reports, as decimal strings. */
export interface LaunchGateStatIdentity {
  dev: string;
  ino: string;
}

/**
 * The stat seam. Returning `null` means the path does not exist; THROWING means
 * the identity could not be established (which is a change, never an absence).
 */
export type LaunchGateStat = (storePath: string) => LaunchGateStatIdentity | null;

/**
 * Options accepted by the effective journal-mode reader. Mirrors
 * `doctor-gate.ts`'s `EffectiveJournalModeOptions` structurally, so the
 * production reader is injectable without this module importing it.
 */
export interface LaunchGateRevalidateConfigOptions {
  managedDir?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Re-reads the effective journal mode; the production reader is injected. */
export type LaunchGateEffectiveJournalModeReader = (
  profileHome: string,
  options?: LaunchGateRevalidateConfigOptions,
) => LaunchGateConfigSnapshot;

/** Injectable seams. Every field is optional; absence fails closed. */
export interface LaunchGateRevalidateDeps {
  /** bigint-stat seam; default {@link defaultStatIdentity}. */
  stat?: LaunchGateStat;
  /**
   * The CURRENT store membership, when the caller can enumerate it.
   *
   * Without it the module can prove that no observed store disappeared, but it
   * cannot see a store that appeared after the observation. The production
   * caller (the wiring) supplies a fresh store-set resolution, which makes the
   * comparison two-way. Values that are not non-empty strings are ignored.
   */
  currentStorePaths?: () => readonly string[];
  /** Effective journal-mode reader; the production wiring supplies the real one. */
  resolveEffectiveJournalMode?: LaunchGateEffectiveJournalModeReader;
  /** Profile home the effective config is re-read from. */
  profileHome?: string;
  /** Options the original observation used, so the comparison is like-for-like. */
  configOptions?: LaunchGateRevalidateConfigOptions;
  /** Config file named in a config change; default `<profileHome>/config.yaml`. */
  configPath?: string;
}

const GATE_UNREADABLE = "unreadable";

/** Longest `before`/`after` rendering kept in a change. */
const MAX_RENDERED_LENGTH = 200;

/** Longest `detail` kept in a change. */
const MAX_DETAIL_LENGTH = 400;

const JOURNAL_MODES: readonly LaunchGateConfigSnapshot["journalMode"][] = [
  "delete",
  "wal",
  "other",
  "unreadable",
];

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Bound one diagnostic to a single line and a fixed length. */
function bounded(text: string, limit = MAX_DETAIL_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}\u2026`;
}

/** Describe a thrown value without ever throwing again. */
function describeError(error: unknown): string {
  try {
    if (error instanceof Error && isNonEmptyString(error.message)) return error.message;
    const text = String(error);
    return text === "" ? "unknown failure" : text;
  } catch {
    return "unknown failure";
  }
}

/** A decimal identity string, or `""` when the value is unusable. */
function identityString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Normalize a config observation; an unknown mode is `unreadable`, never `wal`. */
function normalizeConfig(raw: unknown): LaunchGateConfigSnapshot {
  const source =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const mode = source.journalMode;
  return {
    journalMode: JOURNAL_MODES.includes(mode as LaunchGateConfigSnapshot["journalMode"])
      ? (mode as LaunchGateConfigSnapshot["journalMode"])
      : "unreadable",
    source: isNonEmptyString(source.source) ? source.source : GATE_UNREADABLE,
    observed: source.observed === true,
  };
}

/** The `unreadable`/unobserved config, used when the config cannot be re-read. */
const UNREADABLE_CONFIG: LaunchGateConfigSnapshot = {
  journalMode: "unreadable",
  source: GATE_UNREADABLE,
  observed: false,
};

/**
 * Normalize a snapshot defensively: only entries with a canonical spelling can
 * be re-stat'ed, and every identity comparison is string-to-string.
 */
function normalizeSnapshot(snapshot: LaunchGateSnapshot): LaunchGateSnapshot {
  const raw = (typeof snapshot === "object" && snapshot !== null ? snapshot : {}) as {
    stores?: unknown;
    config?: unknown;
  };
  const stores: LaunchGateStoreIdentity[] = [];
  for (const entry of Array.isArray(raw.stores) ? raw.stores : []) {
    const store = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const canonicalPath = isNonEmptyString(store.canonicalPath) ? store.canonicalPath : "";
    // A store with no canonical spelling was never identity-bound by the gate;
    // it cannot be re-stat'ed and cannot silently widen the snapshot.
    if (canonicalPath === "") continue;
    stores.push({
      canonicalPath,
      dev: identityString(store.dev),
      ino: identityString(store.ino),
    });
  }
  return { stores, config: normalizeConfig(raw.config) };
}

/** Render one config observation for a change's `before`/`after`. */
function renderConfig(config: LaunchGateConfigSnapshot): string {
  const mode = isNonEmptyString(config.journalMode) ? config.journalMode : GATE_UNREADABLE;
  return bounded(`${mode} (observed=${config.observed}, source=${config.source})`, MAX_RENDERED_LENGTH);
}

/** The config file a config change is attributed to. */
function resolveConfigPath(deps: LaunchGateRevalidateDeps): string | null {
  if (isNonEmptyString(deps.configPath)) return deps.configPath;
  if (isNonEmptyString(deps.profileHome)) return path.join(deps.profileHome, "config.yaml");
  return null;
}

/** True when a stat error proves the path is gone (as opposed to unreadable). */
function isAbsentPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The production stat: `stat(2)` with bigint numbers, so the identity is exact
 * and never rounded through a double. `ENOENT`/`ENOTDIR` is absence; anything
 * else is thrown for the caller to treat as an unprovable membership.
 */
function defaultStatIdentity(storePath: string): LaunchGateStatIdentity | null {
  let stats: fs.BigIntStats;
  try {
    stats = fs.statSync(storePath, { bigint: true });
  } catch (error) {
    if (isAbsentPathError(error)) return null;
    throw error;
  }
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Capture the snapshot a later revalidation proves unchanged.
 *
 * A pure copy: it never reads the filesystem (the identities were established
 * by the observation the caller already made), so capturing is free of I/O and
 * cannot fail. Stores without a canonical spelling are omitted — they could not
 * have been identity-bound, and re-stat'ing nothing must never look like proof.
 */
export function captureLaunchGateSnapshot(
  stores: readonly LaunchGateStoreIdentity[],
  config: LaunchGateConfigSnapshot,
): LaunchGateSnapshot {
  const captured: LaunchGateStoreIdentity[] = [];
  for (const entry of Array.isArray(stores) ? stores : []) {
    const store = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    if (!isNonEmptyString(store.canonicalPath)) continue;
    captured.push({
      canonicalPath: store.canonicalPath,
      dev: identityString(store.dev),
      ino: identityString(store.ino),
    });
  }
  return { stores: captured, config: normalizeConfig(config) };
}

// ---------------------------------------------------------------------------
// revalidation
// ---------------------------------------------------------------------------

/** Compare the effective config; anything unprovable is a change. */
function compareConfig(
  before: LaunchGateConfigSnapshot,
  deps: LaunchGateRevalidateDeps,
): LaunchGateChange[] {
  const configPath = resolveConfigPath(deps);
  const changes: LaunchGateChange[] = [];

  const reader = deps.resolveEffectiveJournalMode;
  let after: LaunchGateConfigSnapshot;
  let failure: string | null = null;

  if (typeof reader !== "function") {
    after = UNREADABLE_CONFIG;
    failure =
      "no effective journal-mode reader was supplied, so the effective config could not be re-read";
  } else if (!isNonEmptyString(deps.profileHome)) {
    after = UNREADABLE_CONFIG;
    failure = "no profile home was supplied, so the effective config could not be re-read";
  } else {
    try {
      after = normalizeConfig(reader(deps.profileHome, deps.configOptions));
    } catch (error) {
      after = UNREADABLE_CONFIG;
      failure = `the effective config could not be re-read: ${describeError(error)}`;
    }
  }

  const push = (field: string, from: string, to: string, detail: string): void => {
    changes.push({
      code: "config-changed",
      storePath: configPath,
      field,
      before: bounded(from, MAX_RENDERED_LENGTH),
      after: bounded(to, MAX_RENDERED_LENGTH),
      detail: bounded(detail),
    });
  };

  if (before.journalMode !== after.journalMode) {
    push(
      "journalMode",
      before.journalMode,
      after.journalMode,
      failure ??
        "the effective journal mode changed after the gate observed it; the verdict was computed against a different config",
    );
  }
  if (before.observed !== after.observed) {
    push(
      "observed",
      String(before.observed),
      String(after.observed),
      failure ??
        "the effective config became (un)observable after the gate observed it",
    );
  }
  if (before.source !== after.source) {
    push(
      "source",
      renderConfig(before),
      renderConfig(after),
      failure ??
        "the provenance of the effective config changed after the gate observed it",
    );
  }

  // Fail closed: a config that could not be re-read is a change even when the
  // snapshot itself already said `unreadable` (both sides unreadable is not
  // proof that the config is unchanged).
  if (failure !== null && changes.length === 0) {
    push("observation", renderConfig(before), renderConfig(after), failure);
  }

  return changes;
}

/**
 * Prove (or refuse to prove) that a captured snapshot is still true.
 *
 * Order of comparison: membership (added, then removed/replaced per store),
 * then the effective config. Anything that cannot be compared is a change.
 * Returns `{unchanged: true}` only when every comparison succeeded and found
 * nothing different.
 */
export function revalidateLaunchGateSnapshot(
  snapshot: LaunchGateSnapshot,
  deps: LaunchGateRevalidateDeps = {},
): LaunchGateRevalidation {
  const safeDeps = typeof deps === "object" && deps !== null ? deps : {};
  const expected = normalizeSnapshot(snapshot);
  const changes: LaunchGateChange[] = [];
  const stat = typeof safeDeps.stat === "function" ? safeDeps.stat : defaultStatIdentity;

  // --- membership: a store that APPEARED after the observation -------------
  // Only provable when the caller can enumerate the current set; the
  // production wiring supplies a fresh store-set resolution for exactly this.
  if (typeof safeDeps.currentStorePaths === "function") {
    const known = new Set(expected.stores.map((store) => store.canonicalPath));
    let current: readonly string[] = [];
    try {
      const enumerated = safeDeps.currentStorePaths();
      current = Array.isArray(enumerated) ? enumerated : [];
    } catch (error) {
      changes.push({
        code: "store-set-changed",
        storePath: null,
        field: "membership",
        before: null,
        after: GATE_UNREADABLE,
        detail: bounded(
          `the current store set could not be re-resolved (${describeError(error)}), so membership could not be proven unchanged`,
        ),
      });
    }
    for (const candidate of current) {
      if (!isNonEmptyString(candidate)) continue;
      if (known.has(candidate)) continue;
      changes.push({
        code: "store-set-changed",
        storePath: candidate,
        field: "membership",
        before: "absent",
        after: "present",
        detail: bounded(
          "a store appeared after the gate observed the store set; it was never evaluated by the verdict",
        ),
      });
    }
  }

  // --- membership (removed) + identity (replaced) -------------------------
  for (const store of expected.stores) {
    let now: LaunchGateStatIdentity | null;
    try {
      now = stat(store.canonicalPath);
    } catch (error) {
      changes.push({
        code: "store-set-changed",
        storePath: store.canonicalPath,
        field: "membership",
        before: "present",
        after: GATE_UNREADABLE,
        detail: bounded(
          `the store could not be re-stat'ed (${describeError(error)}), so its membership and identity could not be proven`,
        ),
      });
      continue;
    }

    if (now === null) {
      changes.push({
        code: "store-set-changed",
        storePath: store.canonicalPath,
        field: "membership",
        before: "present",
        after: "absent",
        detail: bounded(
          "the store the gate observed no longer exists at its canonical path",
        ),
      });
      continue;
    }

    const dev = identityString(now.dev);
    const ino = identityString(now.ino);
    if (dev === "" || ino === "") {
      changes.push({
        code: "store-identity-changed",
        storePath: store.canonicalPath,
        field: "dev/ino",
        before: `dev=${store.dev} ino=${store.ino}`,
        after: GATE_UNREADABLE,
        detail: bounded(
          "the re-stat returned no usable (dev, ino) identity, so the store's identity could not be proven",
        ),
      });
      continue;
    }

    // Decimal STRINGS, never numbers: the identity the gate bound is a string
    // and the comparison must not round through a double.
    if (dev !== store.dev || ino !== store.ino) {
      changes.push({
        code: "store-identity-changed",
        storePath: store.canonicalPath,
        field: "dev/ino",
        before: `dev=${store.dev} ino=${store.ino}`,
        after: `dev=${dev} ino=${ino}`,
        detail: bounded(
          "the store at this canonical path was replaced by a different inode after the gate observed it",
        ),
      });
    }
  }

  // --- config -------------------------------------------------------------
  changes.push(...compareConfig(expected.config, safeDeps));

  return changes.length === 0 ? { unchanged: true } : { unchanged: false, changes };
}
