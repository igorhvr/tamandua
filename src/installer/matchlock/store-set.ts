/**
 * Matchlock host-side runtime store inventory resolver (metadata only).
 *
 * G2 STORE-SET-RESOLVER (bead tamandua-7p5.1.2). A launch gate must know which
 * database stores exist for the selected runtime profile, which of them the
 * runtime will actually open, and whether that inventory is complete enough to
 * decide anything at all. This module answers those questions from filesystem
 * metadata only.
 *
 * Hard properties — they are the whole point of the module:
 *
 *  - Metadata only: `realpath`, `stat`, `statfs` and ONE non-recursive
 *    `readdir` of the profile home. Store CONTENT is never read, no database
 *    driver is imported, and no driver call is ever made
 *    (no pragma, no integrity check, no journal-mode read, no open). A fixture
 *    of garbage bytes resolves exactly like a real store.
 *  - Nothing is ever created, initialised, written, truncated, repaired or
 *    deleted. A missing store stays missing: this module records it and the
 *    gate decides.
 *  - No clock reads, no randomness, no environment reads. The only inputs are
 *    the function arguments, so unchanged filesystem state always produces a
 *    deeply equal result.
 *  - Identity is never invented. When a store's identity cannot be
 *    established, `canonicalPath`, `dev`, `ino`, `fstype` and `size` are all
 *    null — never zero, never an empty string, never a guessed spelling. The
 *    caller's requested spelling survives in `pathAliases` so a downstream
 *    refusal can say "could not resolve <spelling>" rather than naming a
 *    location the gate never observed.
 *
 * Three-state resolution, where the difference is deliberate:
 *
 *  - `resolved`   the path was observed; the identity fields describe it.
 *  - `absent`     the path does not exist. This is KNOWLEDGE: a required store
 *                 being absent is a decision the gate can make for itself.
 *  - `unresolved` we tried to look and failed (a symlink loop, a permission
 *                 error, a path that vanished mid-walk). This is IGNORANCE: it
 *                 must never be read as "absent", and it always leaves a doubt
 *                 behind in `incompleteReasons`.
 *
 * Classification comes from the caller's runtime store contract (derived from
 * observed runtime behaviour); there is deliberately NO hardcoded filename
 * list here. `inactive` means "the feature is not enabled, so this store need
 * not EXIST" — it is never an exemption: an inactive store that exists anyway
 * is still returned in `stores` and still inspected by the gate.
 *
 * One store, one identity. Observations are deduped by filesystem identity —
 * `dev` and `ino` read as bigints and compared as decimal STRINGS, never as JS
 * numbers (a 64-bit inode would be lossy and could collide with a different
 * file). Two hardlink spellings, or a symlink and its target, therefore
 * collapse into a single {@link StoreIdentity}; two paths to one file can
 * never masquerade as two stores.
 *
 * `StoreIdentity.pathAliases` keeps every spelling at which one store was
 * observed, deduped and sorted in UTF-8 byte order. Sidecar evidence is
 * path-based, so aliases are never collapsed away. When aliased contract
 * entries disagree about classification the MOST DEMANDING one wins
 * (`required` > `optional-present` > `inactive`): an alias may never downgrade
 * a required store. `canonicalPath` is the byte-order smallest observed
 * canonical spelling, so the choice never depends on contract entry order.
 *
 * Ordering is deterministic and locale-independent: stores sort by
 * `canonicalPath` (falling back to their first alias for identities that were
 * never resolved), compared as UTF-8 bytes, with the full alias list and then
 * the classification as tie-breaks. Permuting `storeContract.entries`
 * therefore cannot change the result, so receipts diff cleanly.
 *
 * `mountPlan` decides which SPELLINGS of the profile home the runtime will
 * actually use. The caller's `profileHome` is always one. Every mount whose
 * `host_path` is an absolute ancestor-or-equal of the resolved profile home
 * adds the same home spelled through that mount source. Because that spelling
 * is built from `realpath(profileHome)` it is the resolved home itself, never
 * a new location — so a store observed through two spellings still collapses
 * into ONE identity (dedupe is by inode) and `pathAliases` keeps both
 * spellings. An absent, empty, unrelated or malformed mount plan changes no
 * identity and never throws.
 *
 * Mount COVERAGE is a separate, stricter question: whether the plan proves the
 * runtime can see this profile home AT ALL. It holds only when some mount's
 * normalized absolute `host_path` is equal to or an ancestor of
 * `realpath(profileHome)`. Empty, relative, unrelated and too-deep host paths
 * never cover, and a profile home whose real path cannot be read cannot be
 * proven covered — with no resolved home there is nothing honest to compare
 * against, so the doubt is recorded rather than assumed away. Coverage is
 * never inferred from a shallow directory scan: a listing only observes what
 * this inventory could already reach.
 *
 * The profile home is also LISTED, once and without recursion, so a store the
 * supplied contract does not name cannot stay invisible. A top-level `*.db`
 * regular file (or a symlink to one) that no contract entry accounts for
 * becomes a `directory-scan` identity with classification `optional-present`:
 * a CANDIDATE to report, never a mandatory store. Promoting a candidate to
 * `required` would manufacture permanent false refusals, so the contract stays
 * the only source of obligation. A name already accounted for merges into that
 * identity — by inode, or by spelling when no inode could be established — so
 * one store is never reported twice. `discoveredUnexpected` is exactly the
 * `directory-scan` subset of `stores`, in `stores` order.
 *
 * A home that cannot be listed (missing, unreadable, not a directory) never
 * aborts the walk: every contract-named identity survives and a
 * `profile-home-unlistable:<errno>` reason records the doubt, so the evaluator
 * sees partial information instead of nothing.
 *
 * COMPLETENESS is one derivation, not a heuristic: `inventoryComplete` is
 * exactly `incompleteReasons.length === 0`, so every doubt is a reason and no
 * second flag can disagree with them. The vocabulary is stable and
 * colon-delimited: `contract-incomplete` (the supplied contract is not
 * attested whole), `mount-plan-does-not-cover-profile-home` (the plan cannot
 * prove the runtime sees this home), `profile-home-unlistable:<errno|unknown>`
 * and `store-unresolved:<requestedPath>:<errno|unknown>`. Reasons are deduped
 * and sorted in UTF-8 byte order, so receipts diff cleanly.
 *
 * Absence is KNOWLEDGE, not ignorance. A contract-named path whose stat fails
 * with ENOENT is `absent` and adds NO reason at all: a required-but-absent
 * store is a decision the gate makes for itself, and calling the whole
 * inventory incomplete for it would conflate "it is not there" with "I could
 * not look". Every failure other than ENOENT — and every listed candidate
 * whose identity cannot be established — is ignorance and always leaves a
 * `store-unresolved:` reason.
 */

import fs from "node:fs";
import path from "node:path";

/** How the runtime treats a store under the selected profile. */
export type StoreClassification = "required" | "optional-present" | "inactive";

/** One store named by the runtime store contract. */
export interface StoreContractEntry {
  /** Path of the store relative to the profile home. */
  relativePath: string;
  classification: StoreClassification;
  /** What opens the store. Advisory receipt text; never parsed here. */
  trigger?: string;
}

/**
 * The runtime store contract supplied by the caller, derived from observed
 * runtime behaviour. `complete` is an ATTESTATION: only `true` claims the
 * named set is the whole set. Absent or false means "provisional seed".
 */
export interface RuntimeStoreContract {
  entries: readonly StoreContractEntry[];
  complete?: boolean;
}

/**
 * The subset of a launch's vfs mount plan this resolver needs: guest
 * destination -> mount configuration.
 */
export interface StoreMountPlan {
  mounts?: Readonly<Record<string, { host_path?: string }>>;
}

/** Three-state resolution; `absent` is knowledge and `unresolved` is ignorance. */
export type StoreResolution = "resolved" | "absent" | "unresolved";

/** Where an identity came from: the contract, or a profile-home listing. */
export type StoreOrigin = "contract" | "directory-scan";

/** One store, deduped by inode. Pure data; safe to deep-compare. */
export interface StoreIdentity {
  /** Filesystem identity spelling, or null when no identity was established. */
  canonicalPath: string | null;
  /** Every spelling this store was observed at, deduped, UTF-8 byte sorted. */
  pathAliases: string[];
  /** Device number from the bigint stat, as a decimal string. */
  dev: string | null;
  /** Inode number from the bigint stat, as a decimal string. */
  ino: string | null;
  /** Filesystem type identifier, `0x` + lowercase hex. */
  fstype: string | null;
  /** Size in bytes, or null when no identity was established. */
  size: number | null;
  /** The contract's classification, echoed unchanged. */
  classification: StoreClassification;
  /** Whether this identity came from the contract or a directory scan. */
  origin: StoreOrigin;
  /** Whether the store was observed, known absent, or could not be resolved. */
  resolution: StoreResolution;
}

/** The whole inventory plus every doubt about its completeness. */
export interface StoreSet {
  stores: StoreIdentity[];
  /** Exactly the identities with origin `directory-scan`, in `stores` order. */
  discoveredUnexpected: StoreIdentity[];
  /** Exactly `incompleteReasons.length === 0`; there is no second heuristic. */
  inventoryComplete: boolean;
  /** Stable colon-delimited reason vocabulary, deduped, UTF-8 byte sorted. */
  incompleteReasons: string[];
}

/** Inputs to {@link resolveStoreSet}. */
export interface ResolveStoreSetInput {
  /** Absolute path of the selected profile's runtime home. */
  profileHome: string;
  /** Mount plan of the launch, when one is known. */
  mountPlan: StoreMountPlan;
  /** Runtime store contract derived from observed runtime behaviour. */
  storeContract: RuntimeStoreContract;
}

/**
 * A caller input that cannot be honoured. Input errors are the only thing this
 * module throws; filesystem errors are always classified into the inventory.
 */
export class StoreSetInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreSetInputError";
    this.code = code;
  }
}

/** Stable reason prefixes; receipts and tests match on these. */
const REASON_CONTRACT_INCOMPLETE = "contract-incomplete";
const REASON_STORE_UNRESOLVED = "store-unresolved";
const REASON_PROFILE_HOME_UNLISTABLE = "profile-home-unlistable";
/** The mount plan cannot prove the runtime sees the profile home at all. */
const REASON_MOUNT_PLAN_DOES_NOT_COVER = "mount-plan-does-not-cover-profile-home";

/** Suffix a top-level profile-home entry must carry to be a store candidate. */
const DB_SUFFIX = ".db";

/**
 * A store the contract does not name is only ever a candidate to REPORT: the
 * listing cannot know which feature would open it, so it may neither demand
 * the store nor exempt it. The gate inspects it like any other identity.
 */
const SCANNED_CLASSIFICATION: StoreClassification = "optional-present";

/** Extract a filesystem error code without ever throwing. */
function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Compare two strings as UTF-8 bytes, never by locale. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Dedupe and sort a reason/alias list in UTF-8 byte order. */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byteCompare);
}

/** How demanding a classification is; a more demanding one always wins a merge. */
function classificationDemand(classification: StoreClassification): number {
  switch (classification) {
    case "required":
      return 2;
    case "optional-present":
      return 1;
    default:
      return 0;
  }
}

/** A stable reason for a store whose identity could not be established. */
function unresolvedReason(requestedPath: string, code: string | null): string {
  return `${REASON_STORE_UNRESOLVED}:${requestedPath}:${code ?? "unknown"}`;
}

/**
 * A stable reason for a profile home that could not be listed. The errno code
 * (never an errno NUMBER, which differs per platform) is the whole diagnostic:
 * `ENOENT` means the home is missing, `EACCES` means we were not allowed to
 * look, and either way the inventory is incomplete rather than empty.
 */
function profileHomeUnlistableReason(code: string | null): string {
  return `${REASON_PROFILE_HOME_UNLISTABLE}:${code ?? "unknown"}`;
}

/**
 * True only for a path strictly below `home`. Used to refuse a contract entry
 * that escapes the profile home (or names the home itself).
 */
function isStrictlyInside(home: string, candidate: string): boolean {
  const relative = path.relative(home, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * True when `ancestor` is `candidate` itself or a directory that contains it.
 * Lexical only, and deliberately not a string-prefix test: sibling directories
 * that merely share a name prefix (`a-bc` vs `a-b`) are not ancestors.
 */
function isAncestorOrEqual(ancestor: string, candidate: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Every normalized absolute `host_path` named by a mount plan, in plan order.
 * Anything else — an absent or non-object plan, a non-object mount, a missing,
 * empty or relative host path — is ignored rather than guessed at: a spelling
 * built from a relative or empty source would name a directory the launch
 * never mounts. Normalizing (`a/./b`, `a/../b`, repeating separators) makes
 * the coverage comparison and the derived spelling agree on one spelling per
 * source; it never turns a relative path into an absolute one, because that
 * would invent a mount source the launch never declared.
 */
function readMountHostPaths(mountPlan: unknown): string[] {
  if (typeof mountPlan !== "object" || mountPlan === null) return [];
  const mounts = (mountPlan as { mounts?: unknown }).mounts;
  if (typeof mounts !== "object" || mounts === null) return [];

  const hostPaths: string[] = [];
  for (const mount of Object.values(mounts as Record<string, unknown>)) {
    if (typeof mount !== "object" || mount === null) continue;
    const hostPath = (mount as { host_path?: unknown }).host_path;
    if (typeof hostPath !== "string" || hostPath.length === 0) continue;
    if (!path.isAbsolute(hostPath)) continue;
    hostPaths.push(path.normalize(hostPath));
  }
  return hostPaths;
}

/**
 * The physical profile home, or null when it cannot be read. Mount coverage
 * needs a RESOLVED home: comparing against the caller's spelling would let a
 * symlink make an unrelated mount look like an ancestor, and inventing a
 * realpath is exactly what this module refuses to do.
 */
function resolveProfileRealHome(profileHome: string): string | null {
  try {
    return fs.realpathSync(profileHome);
  } catch {
    return null;
  }
}

/**
 * True only when some normalized absolute mount source is the resolved profile
 * home itself or an ancestor of it — i.e. the plan genuinely exposes this home
 * to the runtime. With no resolved home nothing can be proven, so the answer is
 * false (fail closed) rather than assumed true.
 */
function mountCoversProfileHome(
  profileRealHome: string | null,
  hostPaths: readonly string[],
): boolean {
  if (profileRealHome === null) return false;
  return hostPaths.some((hostPath) => isAncestorOrEqual(hostPath, profileRealHome));
}

/**
 * Every spelling of the profile home the runtime will use: the caller's
 * spelling, plus the same home spelled through each mount source that covers
 * it. Both are the SAME directory — the mount spelling is derived from
 * `realpath(profileHome)`, so it can never point at a location the launch did
 * not mount.
 *
 * A profile home whose real path cannot be read contributes no mount spelling:
 * with no resolved home there is no honest prefix to derive one from, and a
 * guessed spelling would be exactly the invented identity this module refuses
 * to produce. The caller's spelling is still resolved, so the ignorance (or
 * absence) surfaces per store, where the gate can see it.
 */
function rootSpellings(
  profileHome: string,
  hostPaths: readonly string[],
  profileRealHome: string | null,
): string[] {
  const spellings = new Set<string>([profileHome]);
  if (hostPaths.length === 0 || profileRealHome === null) return [...spellings];

  for (const hostPath of hostPaths) {
    if (!isAncestorOrEqual(hostPath, profileRealHome)) continue;
    spellings.add(
      path.join(hostPath, path.relative(hostPath, profileRealHome)),
    );
  }
  return [...spellings];
}

/** Validate the profile home, failing closed on anything but an absolute path. */
function validateProfileHome(profileHome: unknown): string {
  if (typeof profileHome !== "string" || profileHome.length === 0 || !path.isAbsolute(profileHome)) {
    throw new StoreSetInputError(
      "profile-home-not-absolute",
      `profileHome must be an absolute path, got ${JSON.stringify(profileHome)}`,
    );
  }
  return path.resolve(profileHome);
}

/** Validate the contract shape; a malformed contract is never guessed at. */
function validateContract(storeContract: unknown): readonly StoreContractEntry[] {
  if (typeof storeContract !== "object" || storeContract === null) {
    throw new StoreSetInputError(
      "contract-invalid",
      "storeContract must be an object with an entries array",
    );
  }
  const entries = (storeContract as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new StoreSetInputError(
      "contract-invalid",
      "storeContract.entries must be an array",
    );
  }
  return entries as readonly StoreContractEntry[];
}

/**
 * Validate one contract entry and return its requested absolute spelling.
 * Rejects anything that is not a relative path strictly inside the home.
 */
function resolveRequestedPath(profileHome: string, entry: unknown): string {
  if (typeof entry !== "object" || entry === null) {
    throw new StoreSetInputError(
      "contract-relative-path",
      "every storeContract entry must be an object with a relativePath",
    );
  }
  const relativePath = (entry as { relativePath?: unknown }).relativePath;
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new StoreSetInputError(
      "contract-relative-path",
      "relativePath must be a non-empty string",
    );
  }
  if (path.isAbsolute(relativePath)) {
    throw new StoreSetInputError(
      "contract-relative-path",
      `relativePath must be relative to the profile home, got ${JSON.stringify(relativePath)}`,
    );
  }
  const requestedPath = path.join(profileHome, relativePath);
  if (!isStrictlyInside(profileHome, requestedPath)) {
    throw new StoreSetInputError(
      "contract-relative-path",
      `relativePath escapes the profile home, got ${JSON.stringify(relativePath)}`,
    );
  }
  return requestedPath;
}

/**
 * One store's view of ONE spelling, before any dedupe. Keeping the observation
 * separate from the rolled-up identity is what lets two spellings of one inode
 * merge without losing either spelling, and lets the contract walk and the
 * profile-home listing feed the same inventory.
 */
interface StoreObservation {
  /** The spelling that was actually observed. Never replaced by a resolved one. */
  requestedPath: string;
  classification: StoreClassification;
  /** Whether this observation came from the contract or the profile listing. */
  origin: StoreOrigin;
  resolution: StoreResolution;
  canonicalPath: string | null;
  dev: string | null;
  ino: string | null;
  fstype: string | null;
  size: number | null;
  /**
   * Errno code of a failed observation (null when the spelling was read, or
   * was simply absent). The caller decides whether the failure leaves a doubt:
   * a spelling that failed while another spelling of the same store resolved
   * establishes the identity anyway.
   */
  errorCode: string | null;
}

/** Identity for a store that does not exist: knowledge, with nothing invented. */
function absentObservation(
  requestedPath: string,
  classification: StoreClassification,
  origin: StoreOrigin,
): StoreObservation {
  return {
    requestedPath,
    classification,
    origin,
    resolution: "absent",
    canonicalPath: null,
    dev: null,
    ino: null,
    fstype: null,
    size: null,
    errorCode: null,
  };
}

/** Identity for a store we failed to observe: ignorance, with nothing invented. */
function unresolvedObservation(
  requestedPath: string,
  classification: StoreClassification,
  errorCode: string | null,
  origin: StoreOrigin,
): StoreObservation {
  return {
    requestedPath,
    classification,
    origin,
    resolution: "unresolved",
    canonicalPath: null,
    dev: null,
    ino: null,
    fstype: null,
    size: null,
    errorCode,
  };
}

/** Every identity field of one observed spelling, read from metadata only. */
interface PathMetadata {
  canonicalPath: string;
  dev: string;
  ino: string;
  fstype: string;
  size: number;
  /** True only for a regular file: a directory, fifo or socket is not a store. */
  isFile: boolean;
}

/** One spelling read from filesystem metadata, or why it could not be read. */
type PathObservation =
  | { kind: "absent" }
  | { kind: "error"; code: string | null }
  | { kind: "metadata"; metadata: PathMetadata };

/**
 * Read one spelling's filesystem metadata. Never throws for a filesystem
 * condition: ENOENT is `absent`, everything else is `error`. The bigint stat is
 * mandatory — dev and ino are 64-bit and must never pass through a JS number
 * (a rounded inode would collide with a different file).
 */
function readPathMetadata(requestedPath: string): PathObservation {
  let stats: fs.BigIntStats;
  try {
    stats = fs.statSync(requestedPath, { bigint: true });
  } catch (err) {
    const code = errorCode(err);
    return code === "ENOENT" ? { kind: "absent" } : { kind: "error", code };
  }

  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(requestedPath);
  } catch (err) {
    return { kind: "error", code: errorCode(err) };
  }

  let fstype: string;
  try {
    fstype = `0x${fs.statfsSync(requestedPath).type.toString(16)}`;
  } catch (err) {
    return { kind: "error", code: errorCode(err) };
  }

  return {
    kind: "metadata",
    metadata: {
      canonicalPath,
      // Decimal strings from bigint stats; never JS numbers.
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      fstype,
      size: Number(stats.size),
      isFile: stats.isFile(),
    },
  };
}

/** Identity for an observed spelling; the only place metadata becomes one. */
function resolvedObservation(
  requestedPath: string,
  classification: StoreClassification,
  origin: StoreOrigin,
  metadata: PathMetadata,
): StoreObservation {
  return {
    requestedPath,
    classification,
    origin,
    resolution: "resolved",
    canonicalPath: metadata.canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
    fstype: metadata.fstype,
    size: metadata.size,
    errorCode: null,
  };
}

/**
 * Resolve one contract-named store at ONE spelling from filesystem metadata.
 * Never throws for a filesystem condition: ENOENT is `absent`, everything else
 * is `unresolved`. Never creates the store it was asked about. The reason for a
 * failure is carried to the caller rather than recorded here, because only the
 * caller knows whether another spelling established the same store's identity.
 */
function observeContractStore(
  requestedPath: string,
  classification: StoreClassification,
): StoreObservation {
  const observed = readPathMetadata(requestedPath);
  if (observed.kind === "absent") {
    return absentObservation(requestedPath, classification, "contract");
  }
  if (observed.kind === "error") {
    return unresolvedObservation(requestedPath, classification, observed.code, "contract");
  }
  return resolvedObservation(requestedPath, classification, "contract", observed.metadata);
}

/**
 * True only for a top-level NAME that could be a store: it ends in `.db` and is
 * longer than the suffix alone (a file literally named `.db` is not a name). A
 * SQLite sidecar is `<store>.db-wal`, `<store>.db-shm` or `<store>.db-journal`,
 * so it never carries the suffix and is excluded by construction — there is no
 * sidecar list here that could drift from the runtime.
 */
function isStoreCandidateName(name: string): boolean {
  return name.length > DB_SUFFIX.length && name.endsWith(DB_SUFFIX);
}

/** The result of listing the profile home once; a failure is data, not a throw. */
type ProfileHomeListing =
  | { kind: "listed"; entries: fs.Dirent[] }
  | { kind: "error"; code: string | null };

/**
 * List the profile home ONCE, without recursion. A missing, unreadable or
 * non-directory home yields an errno code (or null for a non-Error throw)
 * instead of aborting the walk.
 */
function listProfileHome(profileHome: string): ProfileHomeListing {
  try {
    return {
      kind: "listed",
      entries: fs.readdirSync(profileHome, { withFileTypes: true }),
    };
  } catch (err) {
    return { kind: "error", code: errorCode(err) };
  }
}

/**
 * Observe one `*.db` name from the profile-home listing.
 *
 * Returns `null` when the entry is not a store at all — a directory (even one
 * named `*.db`), a fifo, a socket, or a symlink resolving to one of those.
 * Only regular files are stores.
 *
 * Apart from the reliable directory skip, the decision comes from METADATA,
 * never from the directory entry's type predicates: a filesystem that reports
 * `DT_UNKNOWN` makes every predicate false, while `stat` is authoritative.
 *
 * A candidate whose identity cannot be established is never dropped: the name
 * exists in the profile home, so it is reported as unresolved. A dangling
 * symlink is ENOENT on its target; a file that vanished between the listing and
 * the stat is a race. Both are ignorance about a candidate, which the inventory
 * records rather than hides.
 */
function observeScannedCandidate(
  entry: fs.Dirent,
  requestedPath: string,
): StoreObservation | null {
  if (entry.isDirectory()) return null;

  const observed = readPathMetadata(requestedPath);
  if (observed.kind === "metadata") {
    if (!observed.metadata.isFile) return null;
    return resolvedObservation(
      requestedPath,
      SCANNED_CLASSIFICATION,
      "directory-scan",
      observed.metadata,
    );
  }

  const code = observed.kind === "absent" ? "ENOENT" : observed.code;
  return unresolvedObservation(requestedPath, SCANNED_CLASSIFICATION, code, "directory-scan");
}

/**
 * Group observations that describe the SAME store.
 *
 * One entry in `perEntry` is every spelling of ONE contract entry's store, and
 * they all name the same store by construction (same relative path, spellings
 * of one directory), so an entry that resolved anywhere contributes all of its
 * spellings to that identity. Entries that resolved are then deduped ACROSS
 * entries by inode (`dev:ino` built from the bigint-derived decimal strings) so
 * a hardlink or a symlinked home can never masquerade as a second store. An
 * entry that never resolved has no inode to share and keeps its own group, so
 * distinct absent stores are never collapsed and two spellings of one absent
 * store are never counted twice.
 */
function groupObservations(
  perEntry: readonly (readonly StoreObservation[])[],
): StoreObservation[][] {
  const byInode = new Map<string, StoreObservation[]>();
  const groups: StoreObservation[][] = [];

  for (const observations of perEntry) {
    const resolved = observations.find(
      (observation) => observation.resolution === "resolved",
    );
    if (
      resolved === undefined ||
      resolved.dev === null ||
      resolved.ino === null
    ) {
      groups.push([...observations]);
      continue;
    }
    const key = `inode\0${resolved.dev}\0${resolved.ino}`;
    const existing = byInode.get(key);
    if (existing === undefined) byInode.set(key, [...observations]);
    else existing.push(...observations);
  }

  groups.push(...byInode.values());
  return groups;
}

/** The most demanding classification among aliases of one inode. */
function mostDemanding(observations: readonly StoreObservation[]): StoreClassification {
  let winner = observations[0].classification;
  for (const observation of observations) {
    if (
      classificationDemand(observation.classification) >
      classificationDemand(winner)
    ) {
      winner = observation.classification;
    }
  }
  return winner;
}

/**
 * Roll a group of observations of one store into a single identity. Every
 * spelling survives in `pathAliases` (sorted, deduped, UTF-8 byte order); the
 * most demanding classification wins; the byte-order smallest canonical
 * spelling is chosen so contract entry order can never change the output. A
 * group is homogeneous by construction (one contract entry's spellings, or one
 * listed candidate), so its first observation carries the origin.
 */
function mergeObservations(observations: readonly StoreObservation[]): StoreIdentity {
  const classification = mostDemanding(observations);
  const origin = observations[0].origin;
  const pathAliases = uniqueSorted(
    observations.flatMap((observation) =>
      observation.canonicalPath === null
        ? [observation.requestedPath]
        : [observation.requestedPath, observation.canonicalPath],
    ),
  );

  const resolved = observations.filter(
    (observation): observation is StoreObservation & { canonicalPath: string } =>
      observation.resolution === "resolved" && observation.canonicalPath !== null,
  );

  if (resolved.length === 0) {
    // Nothing was observed. An unresolved observation is IGNORANCE and must
    // never be reported as absence, so it wins if both somehow mix.
    const resolution: StoreResolution = observations.some(
      (observation) => observation.resolution === "unresolved",
    )
      ? "unresolved"
      : "absent";
    return {
      canonicalPath: null,
      pathAliases,
      dev: null,
      ino: null,
      fstype: null,
      size: null,
      classification,
      origin,
      resolution,
    };
  }

  const canonicalPath = resolved
    .map((observation) => observation.canonicalPath)
    .sort(byteCompare)[0];
  const chosen =
    resolved.find((observation) => observation.canonicalPath === canonicalPath) ??
    resolved[0];

  return {
    canonicalPath,
    pathAliases,
    dev: chosen.dev,
    ino: chosen.ino,
    fstype: chosen.fstype,
    size: chosen.size,
    classification,
    origin,
    resolution: "resolved",
  };
}

/** The dedupe key of a resolved identity: 64-bit values as decimal strings. */
function inodeKey(identity: { dev: string | null; ino: string | null }): string | null {
  if (identity.dev === null || identity.ino === null) return null;
  return `${identity.dev}\u0000${identity.ino}`;
}

/**
 * Where every already-known store sits in `stores`, by inode and by spelling.
 * The spelling index is what stops a name the contract already accounts for
 * from appearing twice when no inode could be established for it (an
 * unresolved contract store, a dangling symlink listed twice): one spelling is
 * a name for exactly one store.
 */
interface InventoryIndex {
  byInode: Map<string, number>;
  bySpelling: Map<string, number>;
}

function indexInventory(stores: readonly StoreIdentity[]): InventoryIndex {
  const index: InventoryIndex = { byInode: new Map(), bySpelling: new Map() };
  stores.forEach((identity, position) => indexIdentity(index, identity, position));
  return index;
}

/** Record one identity in the index so a later candidate can match it. */
function indexIdentity(
  index: InventoryIndex,
  identity: StoreIdentity,
  position: number,
): void {
  if (identity.resolution === "resolved") {
    const key = inodeKey(identity);
    if (key !== null) index.byInode.set(key, position);
  }
  for (const alias of identity.pathAliases) index.bySpelling.set(alias, position);
}

/**
 * Merge one profile-home observation into an identity that already accounts
 * for that store. Aliases are the union (nothing is ever collapsed away) and
 * the identity keeps its classification and origin, so a name found by the
 * listing can never upgrade a contract entry to `required` or downgrade it.
 * Metadata is adopted only when the existing identity never established any
 * (a contract entry recorded absent or unresolved that the listing then
 * observed): an observed store is never left reported as unknown.
 */
function mergeScannedObservation(
  identity: StoreIdentity,
  observation: StoreObservation,
): StoreIdentity {
  const pathAliases = uniqueSorted([
    ...identity.pathAliases,
    observation.requestedPath,
    ...(observation.canonicalPath === null ? [] : [observation.canonicalPath]),
  ]);

  if (identity.resolution === "resolved" || observation.resolution !== "resolved") {
    return { ...identity, pathAliases };
  }

  return {
    ...identity,
    pathAliases,
    canonicalPath: observation.canonicalPath,
    dev: observation.dev,
    ino: observation.ino,
    fstype: observation.fstype,
    size: observation.size,
    resolution: "resolved",
  };
}

/** Deterministic primary sort key: canonical spelling, else the first alias. */
function primarySortKey(identity: StoreIdentity): string {
  return identity.canonicalPath ?? identity.pathAliases[0] ?? "";
}

/**
 * Order identities deterministically: canonical path (byte order), then the
 * full alias list, then classification. Contract entry order can never change
 * the output.
 */
function compareStoreIdentities(a: StoreIdentity, b: StoreIdentity): number {
  const byPath = byteCompare(primarySortKey(a), primarySortKey(b));
  if (byPath !== 0) return byPath;
  const byAliases = byteCompare(a.pathAliases.join("\u0000"), b.pathAliases.join("\u0000"));
  if (byAliases !== 0) return byAliases;
  return classificationDemand(a.classification) - classificationDemand(b.classification);
}

/**
 * Resolve the runtime store inventory for a profile from filesystem metadata
 * only. Never throws for a filesystem error; input errors are
 * {@link StoreSetInputError}. See the module comment for the full contract.
 */
export function resolveStoreSet(input: ResolveStoreSetInput): StoreSet {
  const raw = input as
    | { profileHome?: unknown; mountPlan?: unknown; storeContract?: unknown }
    | undefined;
  const profileHome = validateProfileHome(raw?.profileHome);
  const entries = validateContract(raw?.storeContract);
  const contractComplete =
    (raw?.storeContract as { complete?: unknown }).complete === true;

  // Validate every entry before touching the filesystem, so an invalid
  // contract never depends on what happens to exist on disk.
  const seenRelativePaths = new Set<string>();
  const plans: Array<{ relativePath: string; classification: StoreClassification }> = [];
  for (const entry of entries) {
    // Validation only: the caller's spelling must stay inside the home.
    resolveRequestedPath(profileHome, entry);
    const relativePath = (entry as StoreContractEntry).relativePath;
    if (seenRelativePaths.has(relativePath)) {
      throw new StoreSetInputError(
        "contract-duplicate-entry",
        `storeContract names ${JSON.stringify(relativePath)} more than once`,
      );
    }
    seenRelativePaths.add(relativePath);
    plans.push({
      relativePath,
      classification: (entry as StoreContractEntry).classification,
    });
  }

  const reasons = new Set<string>();
  if (!contractComplete) reasons.add(REASON_CONTRACT_INCOMPLETE);

  // Mount coverage and mount spellings both need the SAME physical home, so it
  // is resolved once. An unreadable home contributes no spelling and cannot be
  // proven covered: both are recorded doubts, never guessed knowledge.
  const profileRealHome = resolveProfileRealHome(profileHome);
  const hostPaths = readMountHostPaths(raw?.mountPlan);
  if (!mountCoversProfileHome(profileRealHome, hostPaths)) {
    reasons.add(REASON_MOUNT_PLAN_DOES_NOT_COVER);
  }

  // Every spelling of the home the runtime will actually use. An absent or
  // unrelated mount plan leaves exactly the caller's spelling.
  const spellings = rootSpellings(profileHome, hostPaths, profileRealHome);

  const perEntryObservations = plans.map((plan) => {
    const observations = spellings.map((spelling) =>
      observeContractStore(path.join(spelling, plan.relativePath), plan.classification),
    );
    // A spelling we could not read is a doubt only when it is the last word on
    // that store: if another spelling established the identity, the failed
    // alias does not make the inventory less complete.
    if (!observations.some((observation) => observation.resolution === "resolved")) {
      for (const observation of observations) {
        if (observation.errorCode !== null) {
          reasons.add(unresolvedReason(observation.requestedPath, observation.errorCode));
        }
      }
    }
    return observations;
  });

  const stores = groupObservations(perEntryObservations).map(mergeObservations);

  // ---- profile-home discovery (US-004) -----------------------------------
  // The listing is the only chance to see a store the contract does not name,
  // so a home we cannot list is a recorded doubt — never an abort, and never a
  // silently empty inventory: every contract-named identity above survives.
  const index = indexInventory(stores);
  const listing = listProfileHome(profileHome);
  if (listing.kind === "error") {
    reasons.add(profileHomeUnlistableReason(listing.code));
  } else {
    // A directory listing's order is filesystem-dependent; walking it by name
    // (UTF-8 bytes) makes the walk itself deterministic.
    const entries = [...listing.entries].sort((a, b) => byteCompare(a.name, b.name));
    for (const entry of entries) {
      if (!isStoreCandidateName(entry.name)) continue;
      const observation = observeScannedCandidate(
        entry,
        path.join(profileHome, entry.name),
      );
      if (observation === null) continue;

      if (observation.resolution === "unresolved" && observation.errorCode !== null) {
        reasons.add(unresolvedReason(observation.requestedPath, observation.errorCode));
      }

      // One store may be reachable through several names. Match by inode
      // (identity, not spelling) first, then by the exact spelling, so a name
      // the contract already accounts for is never reported twice — even when
      // its identity could not be established at all.
      const key = inodeKey(observation);
      const position =
        (key === null ? undefined : index.byInode.get(key)) ??
        index.bySpelling.get(observation.requestedPath);

      if (position !== undefined) {
        const merged = mergeScannedObservation(stores[position], observation);
        stores[position] = merged;
        indexIdentity(index, merged, position);
        continue;
      }

      // A store the contract does not name is a CANDIDATE: reported, never
      // required, so it can never create a permanent false refusal.
      const identity = mergeObservations([observation]);
      stores.push(identity);
      indexIdentity(index, identity, stores.length - 1);
    }
  }

  stores.sort(compareStoreIdentities);

  const incompleteReasons = uniqueSorted([...reasons]);

  return {
    stores,
    // Exactly the directory-scan subset, in `stores` order.
    discoveredUnexpected: stores.filter((identity) => identity.origin === "directory-scan"),
    inventoryComplete: incompleteReasons.length === 0,
    incompleteReasons,
  };
}
